import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { err, ok } from '../../core/result.js';
import type { EditDoc } from '../../core/schema.js';
import { registerErrorHandler, type UnhandledErrorReporter } from '../errorHandler.js';
import { EditConflictError } from '../services/editWriter.js';
import { ProjectLockBusyError } from '../services/projectLock.js';
import { type EditRouteDeps, registerEditRoutes } from './edit.js';
import { EDIT_DOC_MISSING_MESSAGE } from './editDocError.js';

const doc: EditDoc = {
  version: 2,
  fps: 25,
  output: { width: 1080, height: 1920, loudnormLufs: -14 },
  sources: { cam: { path: 'camera.mp4' } },
  tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 4 }] }],
  subtitles: { enabled: false, preset: '2p-caps' },
  totalDurationS: 4,
};

const JSON_HEADERS = { 'content-type': 'application/json' };

async function appWith(overrides: Partial<EditRouteDeps>, report?: UnhandledErrorReporter) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app, report);
  registerEditRoutes(app, {
    projectDir: '/nonexistent/project',
    history: {
      list: () => Promise.resolve([]),
      read: () => Promise.resolve(ok(doc)),
      record: () => Promise.resolve(),
    },
    editWriter: { commit: () => Promise.resolve('hash-1') },
    ...overrides,
  });
  await app.ready();
  return app;
}

describe('edit routes with a refusing project', () => {
  let app: Awaited<ReturnType<typeof appWith>> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('GET answers 404 edit_document_missing without the project path when edit.json is absent', async () => {
    app = await appWith({});

    const res = await app.inject({ method: 'GET', url: '/api/edit' });

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('/nonexistent');
    expect(res.json()).toEqual({
      error: 'edit_document_missing',
      message: EDIT_DOC_MISSING_MESSAGE,
    });
  });

  it.each([
    [
      'PUT /api/edit',
      {
        method: 'PUT' as const,
        url: '/api/edit',
        headers: { ...JSON_HEADERS, 'if-match': 'h0' },
        payload: doc,
      },
    ],
    [
      'POST /api/history/restore',
      {
        method: 'POST' as const,
        url: '/api/history/restore',
        headers: JSON_HEADERS,
        payload: { id: 'entry-1' },
      },
    ],
  ])(
    '%s answers 409 project_busy when another process holds the project lock',
    async (_label, request) => {
      app = await appWith({
        editWriter: { commit: () => Promise.reject(new ProjectLockBusyError('edit-write')) },
      });

      const res = await app.inject(request);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'project_busy',
        message: 'the project is busy with another operation (edit-write)',
      });
    },
  );

  it('PUT answers 409 edit_conflict with the hash on disk when the expected hash is stale', async () => {
    app = await appWith({
      editWriter: { commit: () => Promise.reject(new EditConflictError('hash-on-disk')) },
    });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/edit',
      headers: { ...JSON_HEADERS, 'if-match': 'stale' },
      payload: doc,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'edit_conflict',
      message:
        'edit.json changed on disk (current hash hash-on-disk); reload the project, or confirm you want to keep your version',
      currentHash: 'hash-on-disk',
    });
  });

  it('restore answers 422 invalid_history_entry without the snapshot path when the snapshot is corrupt', async () => {
    app = await appWith({
      history: {
        list: () => Promise.resolve([]),
        read: () =>
          Promise.resolve(
            err(
              'invalid-edit-json',
              'history snapshot at "/Users/x/edit/history/e.json" is not valid JSON',
            ),
          ),
        record: () => Promise.resolve(),
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/history/restore',
      headers: JSON_HEADERS,
      payload: { id: 'entry-1' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.body).not.toContain('/Users/x');
    expect(res.json()).toEqual({
      error: 'invalid_history_entry',
      message: 'the history snapshot is not a valid edit document',
    });
  });

  it('delegates restore preservation to the writer holding the project lock', async () => {
    const record = vi.fn(() => Promise.resolve());
    const commit = vi.fn(() => Promise.resolve('hash-restored'));
    app = await appWith({
      history: { list: () => Promise.resolve([]), read: () => Promise.resolve(ok(doc)), record },
      editWriter: { commit },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/history/restore',
      headers: JSON_HEADERS,
      payload: { id: 'entry-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hash: 'hash-restored' });
    expect(commit).toHaveBeenCalledWith(doc, 'restore');
    expect(record).not.toHaveBeenCalled();
  });

  it('any other commit failure becomes the content-free 500 and reaches the reporter', async () => {
    const report = vi.fn<UnhandledErrorReporter>();
    app = await appWith(
      {
        editWriter: {
          commit: () => Promise.reject(new Error('ENOSPC: /Users/x/edit/edit.json.tmp')),
        },
      },
      report,
    );

    const res = await app.inject({
      method: 'PUT',
      url: '/api/edit',
      headers: { ...JSON_HEADERS, 'if-match': 'h0' },
      payload: doc,
    });

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('/Users/x');
    expect(report).toHaveBeenCalledTimes(1);
  });
});
