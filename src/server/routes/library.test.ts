import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { EditDoc } from '../../core/schema.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerErrorHandler, type UnhandledErrorReporter } from '../errorHandler.js';
import { type LibraryRouteDeps, registerLibraryRoutes } from './library.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

function stubLibrary(
  overrides: Partial<LibraryRouteDeps['library']> = {},
): LibraryRouteDeps['library'] {
  return {
    list: () => Promise.resolve([]),
    resolveFile: () => Promise.resolve(null),
    remove: () => Promise.resolve(false),
    saveFrom: () => Promise.reject(new Error('saveFrom not expected in this test')),
    ...overrides,
  };
}

async function appWith(overrides: Partial<LibraryRouteDeps>, report?: UnhandledErrorReporter) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app, report);
  registerLibraryRoutes(app, {
    projectDir: '/nonexistent/project',
    jobs: { start: () => 1 },
    library: stubLibrary(),
    editWriter: { update: () => Promise.resolve('hash-1') },
    libraryOverlayProbe: () => Promise.reject(new Error('probe not expected in this test')),
    ...overrides,
  });
  await app.ready();
  return app;
}

describe('library routes', () => {
  let app: Awaited<ReturnType<typeof appWith>> | undefined;
  let projectDir: string | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (projectDir !== undefined) await rm(projectDir, { recursive: true, force: true });
    projectDir = undefined;
  });

  describe('POST /api/jobs/title', () => {
    it('rejects an unknown style with 400 invalid_body before starting the job', async () => {
      const start = vi.fn(() => 1);
      app = await appWith({ jobs: { start } });

      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs/title',
        headers: JSON_HEADERS,
        payload: { text: 'Oi', style: 'neon' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('invalid_body');
      expect(start).not.toHaveBeenCalled();
    });

    it.each([
      ['a zero duration', { durationS: 0 }],
      ['a negative start', { at: -1 }],
      ['a negative block index', { blockIndex: -1 }],
      ['a fractional block index', { blockIndex: 1.5 }],
      ['an empty track id', { trackId: '' }],
    ])('rejects %s with 400 invalid_body', async (_label, payload) => {
      const start = vi.fn(() => 1);
      app = await appWith({ jobs: { start } });

      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs/title',
        headers: JSON_HEADERS,
        payload,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('invalid_body');
      expect(start).not.toHaveBeenCalled();
    });

    it('starts the job on an empty body and answers 409 title_in_progress while one runs', async () => {
      app = await appWith({});
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/jobs/title',
            headers: JSON_HEADERS,
            payload: {},
          })
        ).json(),
      ).toEqual({ id: 1 });
      await app.close();

      app = await appWith({ jobs: { start: () => null } });
      const busy = await app.inject({
        method: 'POST',
        url: '/api/jobs/title',
        headers: JSON_HEADERS,
        payload: {},
      });
      expect(busy.statusCode).toBe(409);
      expect(busy.json()).toEqual({
        error: 'title_in_progress',
        message: 'a title card is already being generated',
      });
    });
  });

  describe('POST /api/jobs/library-overlay', () => {
    it('rejects a body without the block identity with 400 invalid_body', async () => {
      app = await appWith({});

      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs/library-overlay',
        headers: JSON_HEADERS,
        payload: { trackId: 'overlays' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('invalid_body');
    });

    it('answers 404 edit_document_missing without the project path when there is no edit.json', async () => {
      app = await appWith({});

      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs/library-overlay',
        headers: JSON_HEADERS,
        payload: { trackId: 'overlays', blockIndex: 0, file: 'edit/assets/x.mp4', variables: {} },
      });

      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('/nonexistent');
      expect(res.json<{ error: string }>().error).toBe('edit_document_missing');
    });
  });

  describe('POST /api/jobs/library-overlay on a project with a library block', () => {
    const libraryDoc: EditDoc = {
      version: 2,
      fps: 25,
      output: { width: 1080, height: 1920, loudnormLufs: -14 },
      sources: { cam: { path: 'camera.mp4' } },
      tracks: [
        { id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 4 }] },
        {
          id: 'overlays',
          kind: 'overlay',
          blocks: [
            {
              file: 'edit/assets/library/piece.mp4',
              at: 1,
              duration: 2,
              library: { item: 'item-0000', variables: { TEXT: 'hello', DURATION_SECONDS: '2' } },
            },
          ],
        },
      ],
      subtitles: { enabled: false, preset: '2p-caps' },
      totalDurationS: 4,
    };
    const block = {
      trackId: 'overlays',
      blockIndex: 0,
      file: 'edit/assets/library/piece.mp4',
      at: 1,
    };

    async function projectWithLibraryBlock(doc = libraryDoc): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), 'leadzy-library-overlay-'));
      await mkdir(join(dir, 'edit'), { recursive: true });
      await writeFile(join(dir, 'edit', 'edit.json'), JSON.stringify(doc));
      return dir;
    }

    it('answers 409 regeneration_in_progress while a re-bake is running', async () => {
      projectDir = await projectWithLibraryBlock();
      app = await appWith({ projectDir, jobs: { start: () => null } });

      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs/library-overlay',
        headers: JSON_HEADERS,
        payload: { ...block, variables: { TEXT: 'bye', DURATION_SECONDS: '3' } },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'regeneration_in_progress',
        message: 'a piece is already being regenerated',
      });
    });

    it('answers 404 library_block_not_found when no block carries the posted file identity', async () => {
      projectDir = await projectWithLibraryBlock();
      app = await appWith({ projectDir });

      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs/library-overlay',
        headers: JSON_HEADERS,
        payload: {
          ...block,
          file: 'edit/assets/library/other.mp4',
          variables: { TEXT: 'bye', DURATION_SECONDS: '3' },
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json<{ error: string }>().error).toBe('library_block_not_found');
    });

    it("answers 400 variables_mismatch naming the block's own variables", async () => {
      projectDir = await projectWithLibraryBlock();
      app = await appWith({ projectDir });

      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs/library-overlay',
        headers: JSON_HEADERS,
        payload: { ...block, variables: { OTHER: 'x' } },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'variables_mismatch',
        message: 'variables must be exactly: DURATION_SECONDS, TEXT',
      });
    });

    it('answers 400 timing_variable_conflict when the block declares two timing variables', async () => {
      const twoTimings: EditDoc = JSON.parse(JSON.stringify(libraryDoc)) as EditDoc;
      const overlay = twoTimings.tracks[1];
      if (overlay?.kind === 'overlay' && overlay.blocks[0]?.library) {
        overlay.blocks[0].library.variables = { DURATION_SECONDS: '2', HOLD_SECONDS: '1' };
      }
      projectDir = await projectWithLibraryBlock(twoTimings);
      app = await appWith({ projectDir });

      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs/library-overlay',
        headers: JSON_HEADERS,
        payload: { ...block, variables: { DURATION_SECONDS: '3', HOLD_SECONDS: '2' } },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'timing_variable_conflict',
        message: 'the piece must use a single timing variable: DURATION_SECONDS, HOLD_SECONDS',
      });
    });
  });

  describe('library items', () => {
    it.each([
      ['an invalid escape sequence', '50%off.png', '/api/library/file/item-0000/50%25off.png'],
      ['a valid escape sequence', '50%25off.png', '/api/library/file/item-0000/50%2525off.png'],
    ])(
      'serves a library file whose name contains %s, decoded once by the router',
      async (_label, name, url) => {
        projectDir = await mkdtemp(join(tmpdir(), 'leadzy-library-file-'));
        const asset = join(projectDir, name);
        await writeFile(asset, 'png bytes');
        const resolveFile = vi.fn((id: string, filename: string) =>
          Promise.resolve(id === 'item-0000' && filename === name ? asset : null),
        );
        app = await appWith({ library: stubLibrary({ resolveFile }) });

        const res = await app.inject({ method: 'GET', url });

        expect(res.statusCode).toBe(200);
        expect(res.body).toBe('png bytes');
        expect(resolveFile).toHaveBeenCalledWith('item-0000', name);
      },
    );

    it('GET file and DELETE answer 404 library_item_not_found for an unknown id', async () => {
      app = await appWith({});

      const file = await app.inject({ method: 'GET', url: '/api/library/file/nope-0000/logo.png' });
      expect(file.statusCode).toBe(404);
      expect(file.json()).toEqual({
        error: 'library_item_not_found',
        message: 'no library item with this id',
      });

      const removed = await app.inject({ method: 'DELETE', url: '/api/library/nope-0000' });
      expect(removed.statusCode).toBe(404);
      expect(removed.json<{ error: string }>().error).toBe('library_item_not_found');
    });

    it('DELETE turns a removal failure into the content-free 500 and reports it', async () => {
      const report = vi.fn<UnhandledErrorReporter>();
      app = await appWith(
        {
          library: stubLibrary({
            remove: () =>
              Promise.reject(new Error("EACCES: permission denied, rmdir '/Users/x/library/item'")),
          }),
        },
        report,
      );

      const res = await app.inject({ method: 'DELETE', url: '/api/library/item-0000' });

      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('/Users/x');
      expect(res.json()).toEqual({ error: 'internal_error', message: 'internal error' });
      expect(report).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['a negative at', { id: 'item-0000', at: -1 }],
      ['a string at', { id: 'item-0000', at: '2' }],
      ['no id', { at: 0 }],
    ])('import rejects %s with 400 invalid_body', async (_label, payload) => {
      app = await appWith({});

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import',
        headers: JSON_HEADERS,
        payload,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('invalid_body');
    });

    it('import removes the copied asset and answers the content-free 500 when the commit fails', async () => {
      projectDir = await mkdtemp(join(tmpdir(), 'leadzy-library-import-'));
      const sourceFile = join(projectDir, 'logo.png');
      await writeFile(sourceFile, 'png bytes');
      const report = vi.fn<UnhandledErrorReporter>();
      app = await appWith(
        {
          projectDir,
          library: stubLibrary({
            list: () =>
              Promise.resolve([
                {
                  id: 'item-0000',
                  name: 'Logo',
                  kind: 'sticker',
                  file: 'logo.png',
                  createdAt: '2026-01-01T00:00:00.000Z',
                  hasPreview: false,
                  preview: null,
                },
              ]),
            resolveFile: () => Promise.resolve(sourceFile),
          }),
          editWriter: {
            update: () =>
              Promise.reject(new Error("EBUSY: resource busy, open '/Users/x/edit/.lock'")),
          },
        },
        report,
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import',
        headers: JSON_HEADERS,
        payload: { id: 'item-0000', at: 0 },
      });

      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('/Users/x');
      expect(res.json()).toEqual({ error: 'internal_error', message: 'internal error' });
      expect(
        existsSync(join(projectDir, 'edit', 'assets', 'library', 'item-0000', 'logo.png')),
      ).toBe(false);
      expect(report).toHaveBeenCalledTimes(1);
    });

    it('import answers 404 library_item_not_found for an unknown id', async () => {
      app = await appWith({});

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import',
        headers: JSON_HEADERS,
        payload: { id: 'nope-0000', at: 0 },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json<{ error: string }>().error).toBe('library_item_not_found');
    });
  });

  describe('POST /api/library/save', () => {
    async function projectWithAsset(): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), 'leadzy-library-route-'));
      await mkdir(join(dir, 'edit', 'assets'), { recursive: true });
      await writeFile(join(dir, 'edit', 'assets', 'logo.png'), 'png');
      return dir;
    }

    it.each([
      ['a numeric file', { file: 123, name: 'Logo', kind: 'image' }],
      ['no name', { file: 'edit/assets/logo.png', kind: 'image' }],
    ])('rejects %s with 400 invalid_body', async (_label, payload) => {
      app = await appWith({});

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/save',
        headers: JSON_HEADERS,
        payload,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('invalid_body');
    });

    it.each([
      ['a file outside edit/', 'media/logo.png', 'file_outside_edit_dir'],
      ['a traversal that leaves edit/', 'edit/../../etc/passwd', 'file_outside_edit_dir'],
      // safePath resolves through realpath, so a missing file collapses into the containment refusal
      ['a contained file that does not exist', 'edit/assets/missing.png', 'path_outside_project'],
    ])('rejects %s with 400 %s', async (_label, file, code) => {
      projectDir = await projectWithAsset();
      app = await appWith({ projectDir });

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/save',
        headers: JSON_HEADERS,
        payload: { file, name: 'Logo', kind: 'image' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe(code);
    });

    it('answers 400 invalid_library_item with the detail when the library rejects the item', async () => {
      projectDir = await projectWithAsset();
      app = await appWith({
        projectDir,
        library: stubLibrary({
          saveFrom: () => Promise.reject(new Error('invalid library item: name: too short')),
        }),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/save',
        headers: JSON_HEADERS,
        payload: { file: 'edit/assets/logo.png', name: '', kind: 'image' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'invalid_library_item',
        message: 'invalid library item: name: too short',
      });
    });

    it('turns any other save failure into the content-free 500', async () => {
      projectDir = await projectWithAsset();
      const report = vi.fn<UnhandledErrorReporter>();
      app = await appWith(
        {
          projectDir,
          library: stubLibrary({
            saveFrom: () =>
              Promise.reject(new Error("EACCES: copyfile '/Users/x/library/logo.png'")),
          }),
        },
        report,
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/save',
        headers: JSON_HEADERS,
        payload: { file: 'edit/assets/logo.png', name: 'Logo', kind: 'image' },
      });

      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('/Users/x');
      expect(report).toHaveBeenCalledTimes(1);
    });
  });
});
