import Fastify from 'fastify';
import { Readable } from 'node:stream';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { err, ok } from '../../core/result.js';
import type { MediaSummary } from '../../core/media.js';
import { registerErrorHandler, type UnhandledErrorReporter } from '../errorHandler.js';
import {
  MAX_MEDIA_IMPORT_BYTES,
  MediaImportError,
  type MediaImportErrorCode,
} from '../services/mediaImport.js';
import { type MediaRouteDeps, registerMediaRoutes } from './media.js';

const imported: MediaSummary = {
  kind: 'video',
  relPath: 'clip.mp4',
  durationS: 4,
  fps: 25,
  width: 1080,
  height: 1920,
  hasAudio: true,
  transcriptEngine: null,
  proxyRelPath: null,
};

async function appWith(overrides: Partial<MediaRouteDeps>, report?: UnhandledErrorReporter) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app, report);
  app.addContentTypeParser(
    'application/octet-stream',
    { bodyLimit: MAX_MEDIA_IMPORT_BYTES },
    (_request, payload, done) => {
      done(null, payload);
    },
  );
  registerMediaRoutes(app, {
    projectDir: '/nonexistent/project',
    mediaImporter: () => Promise.resolve(imported),
    peaks: () => Promise.reject(new Error('peaks not expected in this test')),
    ...overrides,
  });
  await app.ready();
  return app;
}

const OCTET = { 'content-type': 'application/octet-stream' };

describe('media routes', () => {
  let app: Awaited<ReturnType<typeof appWith>> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it.each([
    ['a JSON body', { 'content-type': 'application/json' }, JSON.stringify({})],
    ['no body at all', {}, undefined],
  ])(
    'rejects %s with 415 unsupported_media_type before touching the importer',
    async (_label, headers, payload) => {
      const report = vi.fn<UnhandledErrorReporter>();
      const mediaImporter = vi.fn(() => Promise.resolve(imported));
      app = await appWith({ mediaImporter }, report);

      const res = await app.inject({
        method: 'POST',
        url: '/api/media/import?filename=clip.mp4',
        headers,
        ...(payload === undefined ? {} : { payload }),
      });

      expect(res.statusCode).toBe(415);
      expect(res.json<{ error: string }>().error).toBe('unsupported_media_type');
      expect(mediaImporter).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
    },
  );

  it('rejects a filename that disagrees between query and header with 400 ambiguous_filename', async () => {
    const mediaImporter = vi.fn(() => Promise.resolve(imported));
    app = await appWith({ mediaImporter });

    const res = await app.inject({
      method: 'POST',
      url: '/api/media/import?filename=a.mp4',
      headers: { ...OCTET, 'x-file-name': 'b.mp4' },
      payload: Buffer.from('xx'),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('ambiguous_filename');
    expect(mediaImporter).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing filename', '/api/media/import', 'invalid_filename', 400],
    [
      'an unsupported extension',
      '/api/media/import?filename=notes.exe',
      'unsupported_extension',
      415,
    ],
  ])('rejects %s before reading the upload', async (_label, url, code, status) => {
    app = await appWith({});

    const res = await app.inject({
      method: 'POST',
      url,
      headers: OCTET,
      payload: Buffer.from('xx'),
    });

    expect(res.statusCode).toBe(status);
    expect(res.json<{ error: string }>().error).toBe(code);
  });

  it('rejects a content-length above the limit for the file type with 413 upload_too_large', async () => {
    app = await appWith({});

    const res = await app.inject({
      method: 'POST',
      url: '/api/media/import?filename=big.png',
      headers: { ...OCTET, 'content-length': String(60 * 1024 * 1024) },
      payload: Buffer.from('xx'),
    });

    expect(res.statusCode).toBe(413);
    expect(res.json<{ error: string }>().error).toBe('upload_too_large');
  });

  it.each<[MediaImportErrorCode, 400 | 413 | 415 | 422, string]>([
    ['invalid-filename', 400, 'invalid_filename'],
    ['unsupported-extension', 415, 'unsupported_extension'],
    ['empty-upload', 400, 'empty_upload'],
    ['incomplete-upload', 400, 'incomplete_upload'],
    ['payload-too-large', 413, 'upload_too_large'],
    ['invalid-media', 422, 'invalid_media'],
  ])('maps an importer %s refusal to %s %s', async (code, status, apiCode) => {
    app = await appWith({
      mediaImporter: () => Promise.reject(new MediaImportError(code, status, `refused: ${code}`)),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/media/import?filename=clip.mp4',
      headers: OCTET,
      payload: Buffer.from('xx'),
    });

    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: apiCode, message: `refused: ${code}` });
  });

  it.each([
    [
      'an io-failed import',
      new MediaImportError(
        'io-failed',
        500,
        'could not import the media',
        new Error('EACCES /Users/x/edit'),
      ),
    ],
    ['an unexpected importer error', new Error('ENOSPC: /Users/x/edit/clip.mp4.tmp')],
  ])('turns %s into the content-free 500 and reports it', async (_label, failure) => {
    const report = vi.fn<UnhandledErrorReporter>();
    app = await appWith({ mediaImporter: () => Promise.reject(failure) }, report);

    const res = await app.inject({
      method: 'POST',
      url: '/api/media/import?filename=clip.mp4',
      headers: OCTET,
      payload: Buffer.from('xx'),
    });

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('/Users/x');
    expect(res.json()).toEqual({ error: 'internal_error', message: 'internal error' });
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('returns 201 with the imported item and hands the importer the stream and the byte limit', async () => {
    const mediaImporter = vi.fn(() => Promise.resolve(imported));
    app = await appWith({ mediaImporter });

    const res = await app.inject({
      method: 'POST',
      url: '/api/media/import?filename=clip.mp4',
      headers: OCTET,
      payload: Readable.from([Buffer.from('xx')]),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ item: imported });
    expect(mediaImporter).toHaveBeenCalledWith(
      '/nonexistent/project',
      'clip.mp4',
      expect.any(Readable),
      {
        maxBytes: MAX_MEDIA_IMPORT_BYTES,
      },
    );
  });

  describe('wildcard routes on a real project', () => {
    let projectDir: string | undefined;

    afterEach(async () => {
      if (projectDir !== undefined) await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    });

    async function projectWithClip(): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), 'leadzy-media-route-'));
      await mkdir(join(dir, 'media'), { recursive: true });
      await writeFile(join(dir, 'media', '50%desconto.mp4'), 'not really a video');
      return dir;
    }

    it('streams a media whose name contains a literal %, decoded once by the router', async () => {
      projectDir = await projectWithClip();
      app = await appWith({ projectDir });

      const res = await app.inject({ method: 'GET', url: '/api/media/media/50%25desconto.mp4' });

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('not really a video');
    });

    it('builds peaks for the once-decoded name and answers them', async () => {
      projectDir = await projectWithClip();
      const peaksStub = vi.fn(() =>
        Promise.resolve(
          ok({ version: 1 as const, sampleRate: 48_000, windowMs: 100, min: [-0.5], max: [0.5] }),
        ),
      );
      app = await appWith({ projectDir, peaks: peaksStub });

      const res = await app.inject({ method: 'GET', url: '/api/peaks/media/50%25desconto.mp4' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ windowMs: 100 });
      expect(peaksStub).toHaveBeenCalledWith(projectDir, 'media/50%desconto.mp4');
    });

    it('turns a waveform build failure into the content-free 500 instead of shipping ffmpeg output', async () => {
      projectDir = await projectWithClip();
      const report = vi.fn<UnhandledErrorReporter>();
      app = await appWith(
        {
          projectDir,
          peaks: () =>
            Promise.resolve(
              err('ffmpeg-failed', "ffmpeg: could not open '/Users/x/media/50%desconto.mp4'"),
            ),
        },
        report,
      );

      const res = await app.inject({ method: 'GET', url: '/api/peaks/media/50%25desconto.mp4' });

      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('/Users/x');
      expect(res.json()).toEqual({ error: 'internal_error', message: 'internal error' });
      expect(report).toHaveBeenCalledTimes(1);
    });
  });

  it.each(['/api/media/..%2F..%2Fetc%2Fpasswd', '/api/peaks/%2Fetc%2Fpasswd'])(
    '%s answers 403 path_outside_project',
    async (url) => {
      app = await appWith({});

      const res = await app.inject({ method: 'GET', url });

      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: string }>().error).toBe('path_outside_project');
    },
  );
});
