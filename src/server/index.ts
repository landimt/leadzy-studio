import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import {
  frameworkErrorHandler,
  registerErrorHandler,
  type UnhandledErrorReporter,
} from './errorHandler.js';
import { revealInFileManager } from './services/reveal.js';
import { getOrBuildPeaks } from './services/waveform.js';
import { sendApiError } from './routes/apiError.js';
import { installationRoot } from '../core/installation.js';
import { unwrap } from '../core/result.js';
import { StudioDb } from '../db/index.js';
import { EditHistory } from './services/editHistory.js';
import { EditWriter } from './services/editWriter.js';
import { registerEditRoutes } from './routes/edit.js';
import { registerEventsRoutes } from './routes/events.js';
import { registerLibraryRoutes } from './routes/library.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerTranscriptRoutes } from './routes/transcript.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerRenderRoutes } from './routes/render.js';
import { registerProjectRoutes } from './routes/project.js';
import {
  fastVideoEncoder,
  ffmpegCapabilities,
  probeMedia,
  probeStillImage,
} from './services/ffmpeg.js';
import { checkHyperframes } from './services/hyperframes.js';
import { OverlayLibrary } from './services/library.js';
import {
  importMedia as importProjectMedia,
  MAX_MEDIA_IMPORT_BYTES,
} from './services/mediaImport.js';
import { UserConfig } from './services/userConfig.js';
import { loadEditDoc } from './services/project.js';
import { renderProject } from './services/render.js';
import { recoverRenderPublications } from './services/renderPublication.js';
import { JobManager } from './jobs.js';
import { findExecutable } from '../application/executable.js';

const REPO_ROOT = installationRoot(import.meta.url, 2);
interface LocalHttpAuthority {
  readonly hostname: string;
  readonly port: string;
}

function localHttpAuthority(value: string): LocalHttpAuthority | null {
  if (value.length === 0 || value !== value.trim()) return null;
  try {
    const parsed = new URL(`http://${value}`);
    if (
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      return null;
    }
    const bracketless = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const hostname = bracketless.endsWith('.') ? bracketless.slice(0, -1) : bracketless;
    const ipv4Loopback = isIP(hostname) === 4 && hostname.startsWith('127.');
    if (hostname !== 'localhost' && hostname !== '::1' && !ipv4Loopback) {
      return null;
    }
    return { hostname, port: parsed.port };
  } catch {
    return null;
  }
}

/**
 * Browser requests to a loopback service still need DNS-rebinding/CSRF
 * protection. Non-browser clients omit Origin, while browsers must send the
 * exact origin named by Host (including its port).
 */
export function isAllowedLocalApiRequest(
  host: string | undefined,
  origin: string | undefined,
  fetchSite?: string,
): boolean {
  if (fetchSite === 'cross-site') return false;
  if (host === undefined) return false;
  const authority = localHttpAuthority(host);
  if (authority === null) return false;
  if (origin === undefined) return true;
  if (origin.length === 0 || origin !== origin.trim()) return false;
  try {
    const parsed = new URL(origin);
    if (
      parsed.protocol !== 'http:' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      return false;
    }
    const originAuthority = localHttpAuthority(parsed.host);
    return (
      originAuthority !== null &&
      originAuthority.hostname === authority.hostname &&
      originAuthority.port === authority.port
    );
  } catch {
    return false;
  }
}

export interface StartedServer {
  readonly address: string;
  readonly close: () => Promise<void>;
}

export interface StartServerOptions {
  /** Keep a local editor's origin stable across a development restart; default is ephemeral. */
  readonly port?: number;
  /** Test seam; production uses the streaming media importer. */
  readonly mediaImporter?: typeof importProjectMedia;
  /** Test seam; production validates image inventory through ffprobe. */
  readonly imageProbe?: typeof probeStillImage;
  /** Test seam; production measures a duration-parametric overlay through ffprobe. */
  readonly libraryOverlayProbe?: typeof probeMedia;
  /** Test seam; production uses the real ffmpeg render service. */
  readonly renderer?: typeof renderProject;
  /** Where the cause of a content-free 500 goes: stderr by default, the app log on desktop. */
  readonly reportUnhandledError?: UnhandledErrorReporter;
}

export async function startServer(
  projectDir: string,
  serverOptions: StartServerOptions = {},
): Promise<StartedServer> {
  unwrap(await recoverRenderPublications(projectDir));
  const app = Fastify({
    logger: false,
    // The editor holds an SSE request open. Closing a project must not wait
    // for that same editor to disconnect before navigating back to Home.
    forceCloseConnections: true,
    frameworkErrors: frameworkErrorHandler(serverOptions.reportUnhandledError),
  });
  registerErrorHandler(app, serverOptions.reportUnhandledError);
  app.addHook('onRequest', async (request, reply) => {
    reply.raw.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    reply.raw.setHeader('X-Frame-Options', 'DENY');
    reply.raw.setHeader('X-Content-Type-Options', 'nosniff');
    reply.raw.setHeader('Referrer-Policy', 'no-referrer');
    if (request.url !== '/api' && !request.url.startsWith('/api/')) return;
    const fetchSite = request.headers['sec-fetch-site'];
    if (
      isAllowedLocalApiRequest(
        request.headers.host,
        request.headers.origin,
        typeof fetchSite === 'string' ? fetchSite : undefined,
      )
    ) {
      return;
    }
    await sendApiError(
      reply,
      403,
      'forbidden',
      'cross-origin requests to the local API are not allowed',
    );
  });
  // Passing the raw stream through is what keeps multi-gigabyte videos out of
  // memory. The service independently enforces this declared 4 GiB ceiling
  // while streaming because Fastify cannot do so for a raw custom parser.
  app.addContentTypeParser(
    'application/octet-stream',
    { bodyLimit: MAX_MEDIA_IMPORT_BYTES },
    (_request, payload, done) => {
      done(null, payload);
    },
  );
  const mediaImporter = serverOptions.mediaImporter ?? importProjectMedia;
  const imageProbe = serverOptions.imageProbe ?? probeStillImage;
  const libraryOverlayProbe = serverOptions.libraryOverlayProbe ?? probeMedia;
  const renderer = serverOptions.renderer ?? renderProject;
  const ffmpeg = await ffmpegCapabilities();
  const previewEncoder = ffmpeg.ok ? fastVideoEncoder(ffmpeg.value) : 'libx264';
  const agents = {
    claude: (await findExecutable('claude')) !== null,
    codex: (await findExecutable('codex')) !== null,
  };
  const jobs = new JobManager();
  const library = new OverlayLibrary();
  const userConfig = new UserConfig();
  const history = new EditHistory(projectDir);
  const editWriter = new EditWriter(projectDir, history);
  const openDb = (): StudioDb => new StudioDb();

  const initialDoc = await loadEditDoc(projectDir);
  if (initialDoc.ok) {
    await history.record(initialDoc.value.doc, 'startup');
  }

  // --- routes ----------------------------------------------------------------

  registerProjectRoutes(app, { projectDir, imageProbe, agents, reveal: revealInFileManager });
  registerEditRoutes(app, { projectDir, history, editWriter });

  registerMediaRoutes(app, { projectDir, mediaImporter, peaks: getOrBuildPeaks });

  registerRenderRoutes(app, {
    projectDir,
    jobs,
    renderer,
    openDb,
    userConfig,
    reveal: revealInFileManager,
    fastVideoEncoder: previewEncoder,
  });
  registerTranscriptRoutes(app, { projectDir, jobs, editWriter, openDb });
  registerLibraryRoutes(app, { projectDir, jobs, library, editWriter, libraryOverlayProbe });
  registerSettingsRoutes(app, {
    userConfig,
    inspectTools: async () => {
      return { hyperframes: await checkHyperframes() };
    },
  });
  registerEventsRoutes(app, { projectDir, jobs, history, editWriter });

  // --- client (built bundle if present, Vite middleware in dev) --------------

  // Vite middleware first: it always reflects the current source. The static
  // dist/ bundle is only for installs without devDependencies — a stale dist
  // must never shadow live code.
  let viteAvailable = false;
  try {
    if (process.env.LEADZY_STUDIO_DESKTOP === '1') throw new Error('desktop-static-client');
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      // Vite resolves its config relative to `root`, and root is src/client —
      // without this the repo-root config (react plugin, tailwind, aliases) was
      // silently skipped in dev while `vite build` still applied it.
      configFile: join(REPO_ROOT, 'vite.config.ts'),
      root: join(REPO_ROOT, 'src', 'client'),
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.addHook('onRequest', (request, reply, done) => {
      if (request.url.startsWith('/api/')) {
        done();
        return;
      }
      vite.middlewares(request.raw, reply.raw, done);
      reply.hijack();
    });
    app.addHook('onClose', async () => {
      await vite.close();
    });
    viteAvailable = true;
  } catch {
    viteAvailable = false;
  }
  if (!viteAvailable) {
    const distDir = join(REPO_ROOT, 'dist', 'client');
    if (existsSync(join(distDir, 'index.html'))) {
      const { default: fastifyStatic } = await import('@fastify/static');
      await app.register(fastifyStatic, { root: distDir, prefix: '/' });
    }
  }

  const address = await app.listen({ host: '127.0.0.1', port: serverOptions.port ?? 0 });
  return { address, close: () => app.close() };
}
