import Fastify from 'fastify';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ok } from '../../core/result.js';
import type { EditDoc } from '../../core/schema.js';
import { StudioDb } from '../../db/index.js';
import type { JobType } from '../jobs.js';
import { registerErrorHandler } from '../errorHandler.js';
import type { RenderOutcome, renderProject } from '../services/render.js';
import { registerRenderRoutes, type RenderRouteDeps } from './render.js';

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

async function appWith(overrides: Partial<RenderRouteDeps>) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerRenderRoutes(app, {
    projectDir: '/nonexistent/project',
    jobs: { start: () => 1 },
    renderer: () => Promise.reject(new Error('renderer not expected in this test')),
    reveal: () => Promise.resolve(),
    userConfig: {
      preferences: () =>
        Promise.resolve({
          locale: 'pt-BR',
          defaultProjectDir: null,
          exportMode: 'project',
          exportDirectory: null,
          exportFilenamePattern: '{project}',
          revealAfterExport: false,
        }),
    },
    openDb: () => {
      throw new Error('db not expected in this test');
    },
    fastVideoEncoder: 'libx264',
    ...overrides,
  });
  await app.ready();
  return app;
}

describe('render routes', () => {
  let app: Awaited<ReturnType<typeof appWith>> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('answers 404 edit_document_missing without the project path when there is no edit.json', async () => {
    app = await appWith({});

    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs/render',
      headers: JSON_HEADERS,
      payload: { preview: true },
    });

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('/nonexistent');
    expect(res.json<{ error: string }>().error).toBe('edit_document_missing');
  });

  it('runs a program render without recording it in the index', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'leadzy-render-route-'));
    await mkdir(join(projectDir, 'edit'), { recursive: true });
    await writeFile(join(projectDir, 'edit', 'edit.json'), JSON.stringify(doc));
    try {
      const renderer = vi.fn<typeof renderProject>();
      renderer.mockResolvedValue(
        ok<RenderOutcome>({
          kind: 'program',
          outputRel: 'edit/program.mp4',
          outputAbs: join(projectDir, 'edit', 'program.mp4'),
          durationS: 4,
          expectedDurationS: 4,
          editHash: 'hash-1',
          canonical: true,
          programKey: 'program-key-1',
        }),
      );
      const openDb = vi.fn(() => {
        throw new Error('the index must not see a program render');
      });
      const reveal = vi.fn(() => Promise.resolve());
      let jobPromise: Promise<unknown> | undefined;
      app = await appWith({
        projectDir,
        jobs: {
          start: (_type, work) => {
            jobPromise = work(() => undefined);
            return 1;
          },
        },
        renderer,
        openDb,
        reveal,
        // a program is the player's cache: delivery preferences must never be consulted
        userConfig: {
          preferences: () => {
            throw new Error('preferences must not be read for a program render');
          },
        },
        fastVideoEncoder: 'h264_videotoolbox',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs/render',
        headers: JSON_HEADERS,
        payload: { preview: true, layers: 'omit' },
      });
      await jobPromise;

      expect(res.statusCode).toBe(200);
      expect(renderer.mock.calls[0]?.[2]).toMatchObject({ preview: true, layers: 'omit' });
      const program = await app.inject({
        method: 'POST',
        url: '/api/jobs/render',
        headers: JSON_HEADERS,
        payload: { layers: 'omit' },
      });
      const programResult = await jobPromise;
      expect(program.statusCode).toBe(200);
      expect(programResult).not.toHaveProperty('deliveryPath');
      expect(reveal).not.toHaveBeenCalled();
      // a program is a preview-resolution artifact even when the body omits `preview`
      expect(renderer.mock.calls[1]?.[2]).toMatchObject({
        preview: true,
        layers: 'omit',
        videoEncoder: 'h264_videotoolbox',
      });
      expect(openDb).not.toHaveBeenCalled();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('forwards quality and a clean (no subtitles) delivery to the renderer, and lets the body override reveal', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'leadzy-render-route-'));
    await mkdir(join(projectDir, 'edit'), { recursive: true });
    await writeFile(join(projectDir, 'edit', 'edit.json'), JSON.stringify(doc));
    try {
      const renderer = vi.fn<typeof renderProject>();
      renderer.mockResolvedValue(
        ok<RenderOutcome>({
          kind: 'final',
          outputRel: 'edit/final.mp4',
          outputAbs: join(projectDir, 'edit', 'final.mp4'),
          durationS: 4,
          expectedDurationS: 4,
          editHash: 'hash-1',
          canonical: false,
          programKey: 'program-key-1',
        }),
      );
      const reveal = vi.fn(() => Promise.resolve());
      let jobPromise: Promise<unknown> | undefined;
      app = await appWith({
        projectDir,
        jobs: {
          start: (_type, work) => {
            jobPromise = work(() => undefined);
            return 1;
          },
        },
        renderer,
        reveal,
        openDb: () =>
          ({
            upsertProject: () => ({ id: 1 }),
            recordRender: () => undefined,
            close: () => undefined,
          }) as unknown as StudioDb,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs/render',
        headers: JSON_HEADERS,
        payload: { preview: false, quality: 'max', subtitles: false, reveal: true },
      });
      await jobPromise;

      expect(res.statusCode).toBe(200);
      expect(renderer.mock.calls[0]?.[2]).toMatchObject({
        preview: false,
        quality: 'max',
        subtitles: false,
        loudnorm: true,
      });
      expect(reveal).toHaveBeenCalledWith(join(projectDir, 'edit', 'final.mp4'));
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  async function deliveryHarness(
    preferences: { exportMode: 'project' | 'folder'; revealAfterExport: boolean },
    body: Record<string, unknown>,
  ) {
    const root = await mkdtemp(join(tmpdir(), 'leadzy-render-delivery-'));
    const projectDir = join(root, 'Campanha');
    const destination = join(root, 'exports');
    await mkdir(join(projectDir, 'edit'), { recursive: true });
    await mkdir(destination);
    await writeFile(join(projectDir, 'edit', 'edit.json'), JSON.stringify(doc));
    let work: ((progress: (message: string) => void) => Promise<unknown>) | undefined;
    const reveal = vi.fn(() => Promise.resolve());
    app = await appWith({
      projectDir,
      jobs: {
        start: (_type: JobType, nextWork) => {
          work = nextWork;
          return 7;
        },
      },
      renderer: async () => {
        await writeFile(join(projectDir, 'edit', 'final.mp4'), 'rendered-video');
        return ok<RenderOutcome>({
          kind: 'final',
          outputRel: 'edit/final.mp4',
          outputAbs: join(projectDir, 'edit', 'final.mp4'),
          durationS: 4,
          expectedDurationS: 4,
          editHash: 'edit-hash',
          canonical: true,
          programKey: 'program-key-1',
        });
      },
      reveal,
      userConfig: {
        preferences: () =>
          Promise.resolve({
            defaultProjectDir: null,
            exportMode: preferences.exportMode,
            exportDirectory: destination,
            exportFilenamePattern: '{project}',
            revealAfterExport: preferences.revealAfterExport,
            locale: 'pt-BR',
          }),
      },
      openDb: () =>
        ({
          upsertProject: () => ({ id: 1 }),
          recordRender: () => undefined,
          close: () => undefined,
        }) as unknown as StudioDb,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs/render',
      headers: JSON_HEADERS,
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    const result = (await work?.(() => undefined)) as {
      deliveryPath?: string;
      deliveryName?: string;
    };
    return { result, reveal, destination, root };
  }

  it.each([
    ['inside the project', 'project' as const],
    ['to the delivery folder', 'folder' as const],
  ])(
    'reveal:false keeps the Finder closed even when the preference says otherwise (%s)',
    async (_label, exportMode) => {
      const { reveal, root } = await deliveryHarness(
        { exportMode, revealAfterExport: true },
        { preview: false, reveal: false },
      );
      try {
        expect(reveal).not.toHaveBeenCalled();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('deliveryDirectory: null keeps the final in the project even with a folder preference', async () => {
    const { result, reveal, root } = await deliveryHarness(
      { exportMode: 'folder', revealAfterExport: true },
      { preview: false, deliveryDirectory: null },
    );
    try {
      expect(result).not.toHaveProperty('deliveryPath');
      expect(reveal).toHaveBeenCalledWith(join(root, 'Campanha', 'edit', 'final.mp4'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('filenamePattern names this delivery without touching the preference', async () => {
    const { result, destination, root } = await deliveryHarness(
      { exportMode: 'folder', revealAfterExport: false },
      { preview: false, filenamePattern: 'entrega-{project}' },
    );
    try {
      expect(result.deliveryName).toBe('entrega-Campanha.mp4');
      expect(await realpath(result.deliveryPath ?? '')).toBe(
        await realpath(join(destination, 'entrega-Campanha.mp4')),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['an unknown quality', { preview: false, quality: 'ultra' }],
    ['a string subtitles flag', { preview: false, subtitles: 'no' }],
    [
      'a filename pattern with a control character',
      { preview: false, filenamePattern: 'a\u0007b' },
    ],
    [
      'a filename pattern over the preference limit',
      { preview: false, filenamePattern: 'x'.repeat(121) },
    ],
    ['a blank filename pattern', { preview: false, filenamePattern: '   ' }],
  ])('rejects %s with 400 invalid_render_options', async (_label, payload) => {
    app = await appWith({});

    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs/render',
      headers: JSON_HEADERS,
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_render_options');
  });

  it('rejects an unknown layers value with 400 invalid_render_options', async () => {
    app = await appWith({});

    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs/render',
      headers: JSON_HEADERS,
      payload: { preview: true, layers: 'x' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'invalid_render_options',
      message:
        'preview must be a boolean, deliveryDirectory must be an absolute path or null, layers must be "burn" or "omit", quality must be "recommended", "high" or "max", subtitles and reveal must be booleans, filenamePattern must be a valid filename pattern, and no other option is accepted',
    });
  });

  it.each([
    ['/api/jobs/render', 'render_in_progress', 'a render is already running'],
    ['/api/jobs/audio-preview', 'audio_preview_in_progress', 'an audio preview is already running'],
  ])('%s answers 409 %s while the same job type is running', async (url, code, message) => {
    const projectDir = await mkdtemp(join(tmpdir(), 'leadzy-render-route-'));
    await mkdir(join(projectDir, 'edit'), { recursive: true });
    await writeFile(join(projectDir, 'edit', 'edit.json'), JSON.stringify(doc));
    try {
      app = await appWith({ projectDir, jobs: { start: () => null } });

      const res = await app.inject({ method: 'POST', url, headers: JSON_HEADERS, payload: {} });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: code, message });
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('delivers a final render to a one-off folder without overwriting the canonical file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leadzy-render-delivery-'));
    const projectDir = join(root, 'Campanha Agosto');
    const destination = join(root, 'exports');
    await mkdir(join(projectDir, 'edit'), { recursive: true });
    await mkdir(destination);
    await writeFile(join(projectDir, 'edit', 'edit.json'), JSON.stringify(doc));

    let work: ((progress: (message: string) => void) => Promise<unknown>) | undefined;
    const reveal = vi.fn(() => Promise.resolve());
    const database = {
      upsertProject: vi.fn(() => ({ id: 1 })),
      recordRender: vi.fn(),
      close: vi.fn(),
    } as unknown as StudioDb;

    try {
      app = await appWith({
        projectDir,
        jobs: {
          start: (_type: JobType, nextWork) => {
            work = nextWork;
            return 7;
          },
        },
        renderer: async () => {
          await writeFile(join(projectDir, 'edit', 'final.mp4'), 'rendered-video');
          return ok({
            outputRel: 'edit/final.mp4',
            outputAbs: join(projectDir, 'edit', 'final.mp4'),
            durationS: 4,
            expectedDurationS: 4,
            editHash: 'edit-hash',
            canonical: true,
            kind: 'final',
            programKey: 'program-key-1',
          });
        },
        reveal,
        userConfig: {
          preferences: () =>
            Promise.resolve({
              locale: 'pt-BR',
              defaultProjectDir: null,
              exportMode: 'ask',
              exportDirectory: null,
              exportFilenamePattern: '{project}',
              revealAfterExport: true,
            }),
        },
        openDb: () => database,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/jobs/render',
        headers: JSON_HEADERS,
        payload: { deliveryDirectory: destination },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ id: 7 });
      expect(work).toBeDefined();

      const result = (await work?.(() => undefined)) as {
        deliveryPath: string;
        deliveryName: string;
      };
      expect(result.deliveryName).toBe('Campanha Agosto.mp4');
      expect(await realpath(result.deliveryPath)).toBe(
        await realpath(join(destination, 'Campanha Agosto.mp4')),
      );
      expect(reveal).toHaveBeenCalledWith(result.deliveryPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['h264_videotoolbox', true],
    ['libx264', false],
  ] as const)(
    'passes videoEncoder %s to the renderer when the request body is { preview: %s }',
    async (expectedEncoder, preview) => {
      const scratchDir = await mkdtemp(join(tmpdir(), 'leadzy-render-route-'));
      const projectDir = join(scratchDir, 'project');
      await mkdir(join(projectDir, 'edit'), { recursive: true });
      await writeFile(join(projectDir, 'edit', 'edit.json'), JSON.stringify(doc));
      try {
        const renderer = vi.fn<typeof renderProject>();
        renderer.mockResolvedValue(
          ok<RenderOutcome>({
            outputRel: 'edit/render/out.mp4',
            outputAbs: join(projectDir, 'edit', 'render', 'out.mp4'),
            durationS: 4,
            expectedDurationS: 4,
            editHash: 'hash-1',
            canonical: true,
            kind: 'preview',
            programKey: 'program-key-1',
          }),
        );
        let jobPromise: Promise<unknown> | undefined;
        app = await appWith({
          projectDir,
          jobs: {
            start: (_type, work) => {
              jobPromise = work(() => undefined);
              return 1;
            },
          },
          renderer,
          openDb: () => new StudioDb(join(scratchDir, 'index.db')),
          fastVideoEncoder: 'h264_videotoolbox',
        });

        const res = await app.inject({
          method: 'POST',
          url: '/api/jobs/render',
          headers: JSON_HEADERS,
          payload: { preview },
        });
        await jobPromise;

        expect(res.statusCode).toBe(200);
        expect(renderer).toHaveBeenCalledTimes(1);
        expect(renderer.mock.calls[0]?.[2]).toEqual({
          preview,
          videoEncoder: expectedEncoder,
          subtitles: true,
          loudnorm: true,
          layers: 'burn',
        });
      } finally {
        await rm(scratchDir, { recursive: true, force: true });
      }
    },
  );
});
