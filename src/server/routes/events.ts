import type { FastifyInstance } from 'fastify';
import { watch } from 'chokidar';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { parseEditDoc } from '../../core/schema.js';
import type { JobManager, ServerEvent } from '../jobs.js';
import type { EditHistory } from '../services/editHistory.js';
import type { EditWriter } from '../services/editWriter.js';
import { editDocHash, editJsonPath } from '../services/project.js';

export interface EventsRouteDeps {
  readonly projectDir: string;
  readonly jobs: Pick<JobManager, 'onEvent' | 'runningJobs' | 'broadcast'>;
  readonly history: Pick<EditHistory, 'record'>;
  readonly editWriter: Pick<EditWriter, 'lastSavedHash'>;
}

/**
 * Server-sent events for job progress plus the edit.json/assets watcher that
 * feeds them. The watcher is owned here and closed through the root
 * instance's `onClose`, so `startServer().close()` still tears it down.
 */
export function registerEventsRoutes(app: FastifyInstance, deps: EventsRouteDeps): void {
  const { projectDir, jobs, history, editWriter } = deps;

  app.get('/api/events', (request, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write(':connected\n\n');
    const send = (event: ServerEvent): void => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    // Subscribe first, then synchronously send the authoritative snapshot.
    // No job transition can fall into the connection/reconnection gap.
    const unsubscribe = jobs.onEvent(send);
    send({ kind: 'jobs-snapshot', jobs: jobs.runningJobs() });
    const keepAlive = setInterval(() => {
      reply.raw.write(':keep-alive\n\n');
    }, 15_000);
    request.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  // CLI renders bypass the in-process JobManager. Receipt commit markers
  // tell every open client when an agent's artifact is actually available.
  const receipts = new Set(
    ['audio-preview', 'program', 'preview', 'final'].map((kind) =>
      join(projectDir, 'edit', 'cache', `${kind}.inputs.json`),
    ),
  );
  const receiptDir = join(projectDir, 'edit', 'cache');
  mkdirSync(receiptDir, { recursive: true });
  let artifactTimer: ReturnType<typeof setTimeout> | null = null;
  const watcher = watch(
    [editJsonPath(projectDir), join(projectDir, 'edit', 'assets'), receiptDir],
    {
      ignoreInitial: true,
      // Chokidar passes slash-normalized paths to ignored(), including on
      // Windows; its emitted events use native separators instead.
      ignored: (path) => {
        const nativePath = normalize(path);
        return nativePath.startsWith(receiptDir + sep) && !receipts.has(nativePath);
      },
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
    },
  );
  watcher.on('all', (_event, path) => {
    void (async () => {
      if (path === editJsonPath(projectDir)) {
        try {
          const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
          const parsed = parseEditDoc(raw);
          const hash = parsed.ok ? editDocHash(parsed.value) : '';
          // A write we made ourselves comes back with the hash we recorded —
          // only genuinely external edits (an agent, a manual save) reload the UI.
          const external = hash !== editWriter.lastSavedHash;
          jobs.broadcast({ kind: 'edit-changed', hash, external });
          if (external && parsed.ok) {
            void history.record(parsed.value, 'agent');
          }
        } catch {
          jobs.broadcast({ kind: 'edit-changed', hash: '', external: true });
        }
      } else if (receipts.has(path)) {
        if (artifactTimer !== null) clearTimeout(artifactTimer);
        artifactTimer = setTimeout(() => {
          artifactTimer = null;
          jobs.broadcast({ kind: 'artifacts-changed' });
        }, 120);
      } else {
        jobs.broadcast({ kind: 'assets-changed' });
      }
    })();
  });
  app.addHook('onClose', async () => {
    if (artifactTimer !== null) clearTimeout(artifactTimer);
    await watcher.close();
  });
}
