import Fastify from 'fastify';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { StudioDb } from '../../db/index.js';
import { registerErrorHandler } from '../errorHandler.js';
import type { JobType } from '../jobs.js';
import { registerTranscriptRoutes, type TranscriptRouteDeps } from './transcript.js';

const transcribeProjectMock = vi.hoisted(() =>
  vi.fn(() =>
    Promise.resolve({ ok: true as const, value: { transcribed: [], skippedCached: [] } }),
  ),
);
vi.mock('../../application/transcribeProject.js', () => ({
  transcribeProject: transcribeProjectMock,
}));

const JSON_HEADERS = { 'content-type': 'application/json' };

let scratchDir: string;
let previousConfigDir: string | undefined;

beforeAll(async () => {
  scratchDir = await mkdtemp(join(tmpdir(), 'leadzy-transcript-route-'));
  previousConfigDir = process.env.LEADZY_CONFIG_DIR;
  process.env.LEADZY_CONFIG_DIR = join(scratchDir, 'config');
});

afterAll(async () => {
  if (previousConfigDir === undefined) delete process.env.LEADZY_CONFIG_DIR;
  else process.env.LEADZY_CONFIG_DIR = previousConfigDir;
  await rm(scratchDir, { recursive: true, force: true });
});

async function appWith(overrides: Partial<TranscriptRouteDeps>) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerTranscriptRoutes(app, {
    projectDir: join(scratchDir, 'project'),
    jobs: { start: () => 1 },
    editWriter: { commit: () => Promise.resolve('hash-1') },
    openDb: () => new StudioDb(join(scratchDir, 'index.db')),
    ...overrides,
  });
  await app.ready();
  return app;
}

describe('transcript routes', () => {
  let app: Awaited<ReturnType<typeof appWith>> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it.each([
    ['a plain name', '/api/transcript/clips/take%201.mp4'],
    [
      'a name with a literal %, which the router already decoded once',
      '/api/transcript/100%25%20done.mp4',
    ],
  ])(
    'answers 404 transcript_not_found for media without a cached transcript (%s)',
    async (_label, url) => {
      app = await appWith({});

      const res = await app.inject({ method: 'GET', url });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: 'transcript_not_found',
        message: 'no transcript for this media',
      });
    },
  );

  it.each(['/api/jobs/transcribe', '/api/jobs/qa', '/api/jobs/suggest'])(
    '%s starts its job on a request without a body',
    async (url) => {
      const start = vi.fn(() => 1);
      app = await appWith({ jobs: { start } });

      const res = await app.inject({ method: 'POST', url });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id: 1 });
      expect(start).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['/api/jobs/transcribe', '/api/jobs/qa', '/api/jobs/suggest'])(
    '%s rejects a null body with 400 invalid_body',
    async (url) => {
      const start = vi.fn(() => 1);
      app = await appWith({ jobs: { start } });

      const res = await app.inject({ method: 'POST', url, headers: JSON_HEADERS, payload: 'null' });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('invalid_body');
      expect(start).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['/api/jobs/transcribe', 'transcribe'],
    ['/api/jobs/qa', 'qa'],
  ])('%s starts its job on an empty body', async (url, type) => {
    const started: JobType[] = [];
    app = await appWith({
      jobs: {
        start: (jobType) => {
          started.push(jobType);
          return 7;
        },
      },
    });

    const res = await app.inject({ method: 'POST', url, headers: JSON_HEADERS, payload: {} });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 7 });
    expect(started).toEqual([type]);
  });

  it.each([
    ['an invalid escape sequence', '50%desconto', '/api/transcript/50%25desconto.mp4'],
    ['a valid escape sequence', 'take%20one', '/api/transcript/take%2520one.mp4'],
  ])(
    'serves the cached transcript of a media whose name contains %s, decoded once by the router',
    async (_label, name, url) => {
      const projectDir = join(scratchDir, 'project');
      await mkdir(join(projectDir, 'edit', 'transcripts'), { recursive: true });
      await writeFile(
        join(projectDir, 'edit', 'transcripts', `${name}.mp4.json`),
        JSON.stringify({
          engine: 'scribe',
          model: 'scribe_v2',
          sourceHash: `hash-${name}`,
          keytermsHash: 'k',
          transcribedAt: '2026-08-27T15:00:00.000Z',
          transcript: { text: name, words: [{ text: name, start: 0, end: 1, type: 'word' }] },
        }),
      );
      app = await appWith({ projectDir });

      const res = await app.inject({ method: 'GET', url });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ engine: string; text: string }>()).toMatchObject({
        engine: 'scribe',
        text: name,
      });
    },
  );

  it.each([
    ['/api/jobs/transcribe', 'a string body', '"scribe"'],
    ['/api/jobs/transcribe', 'an engine from a previous client', { engine: 'whisper' }],
    ['/api/jobs/qa', 'a string body', '"scribe"'],
    ['/api/jobs/qa', 'an engine from a previous client', { engine: 'deepgram' }],
  ])(
    '%s rejects %s with 400 invalid_body before starting anything',
    async (url, _label, payload) => {
      const start = vi.fn(() => 1);
      app = await appWith({ jobs: { start } });

      const res = await app.inject({
        method: 'POST',
        url,
        headers: JSON_HEADERS,
        payload,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('invalid_body');
      expect(start).not.toHaveBeenCalled();
    },
  );

  it('answers 404 transcript_not_found for a cache written by the removed Whisper engine', async () => {
    const projectDir = join(scratchDir, 'project-whisper');
    await mkdir(join(projectDir, 'edit', 'transcripts'), { recursive: true });
    await writeFile(
      join(projectDir, 'edit', 'transcripts', 'take.mp4.json'),
      JSON.stringify({
        engine: 'whisper',
        sourceHash: 'hash-take',
        transcript: { text: 'take', words: [{ word: 'take', start: 0, end: 1 }] },
      }),
    );
    app = await appWith({ projectDir });

    const res = await app.inject({ method: 'GET', url: '/api/transcript/take.mp4' });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('transcript_not_found');
  });

  it('starts a forced transcription from an explicit boolean and refuses anything else', async () => {
    let run: ((progress: (message: string) => void) => Promise<unknown>) | undefined;
    const start = vi.fn((_type: JobType, job: typeof run) => {
      run = job;
      return 1;
    });
    app = await appWith({ jobs: { start } });

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/jobs/transcribe',
      headers: JSON_HEADERS,
      payload: { force: true },
    });
    await run?.(() => undefined);
    expect(transcribeProjectMock).toHaveBeenCalledWith(
      join(scratchDir, 'project'),
      expect.objectContaining({ force: true, assumeYes: true }),
    );
    const refused = await app.inject({
      method: 'POST',
      url: '/api/jobs/transcribe',
      headers: JSON_HEADERS,
      payload: { force: 'yes' },
    });

    expect(accepted.statusCode).toBe(200);
    expect(start).toHaveBeenCalledTimes(1);
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: string }>().error).toBe('invalid_body');
  });

  it.each([
    ['a string thresholdDb', { thresholdDb: '-30' }],
    ['a zero minSilenceS', { minSilenceS: 0 }],
    ['a string body', 'analyse'],
  ])('suggest rejects %s with 400 invalid_body', async (_label, payload) => {
    const start = vi.fn(() => 1);
    app = await appWith({ jobs: { start } });

    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs/suggest',
      headers: JSON_HEADERS,
      payload: JSON.stringify(payload),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_body');
    expect(start).not.toHaveBeenCalled();
  });

  it('suggest accepts a numeric body and ignores unknown fields', async () => {
    app = await appWith({});

    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs/suggest',
      headers: JSON_HEADERS,
      payload: { thresholdDb: -30, minSilenceS: 0.4, unknown: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 1 });
  });

  it.each([
    ['/api/jobs/transcribe', 'transcription_in_progress', 'a transcription is already running'],
    ['/api/jobs/qa', 'qa_in_progress', 'a QA pass is already running'],
    ['/api/jobs/suggest', 'analysis_in_progress', 'a cut analysis is already running'],
  ])('%s answers 409 %s while the same job type is running', async (url, code, message) => {
    app = await appWith({ jobs: { start: () => null } });

    const res = await app.inject({ method: 'POST', url, headers: JSON_HEADERS, payload: {} });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: code, message });
  });

  describe('GET /api/search', () => {
    async function seededApp() {
      const projectDir = join(scratchDir, 'project');
      const seed = new StudioDb(join(scratchDir, 'index.db'));
      try {
        const project = seed.upsertProject(projectDir);
        seed.upsertMedia(project.id, {
          relPath: 'clips/take 1.mp4',
          hash: 'hash-take-1',
          durationS: 4,
          transcriptStatus: 'scribe',
          transcriptText: 'first take of the intro',
        });
      } finally {
        seed.close();
      }
      return appWith({ projectDir });
    }

    it('answers the media whose transcript matches q', async () => {
      app = await seededApp();

      const hits = (await app.inject({ method: 'GET', url: '/api/search?q=intro' })).json<{
        hits: { mediaRelPath: string }[];
      }>().hits;

      expect(hits.map((hit) => hit.mediaRelPath)).toEqual(['clips/take 1.mp4']);
      expect((await app.inject({ method: 'GET', url: '/api/search?q=outro' })).json()).toEqual({
        hits: [],
      });
    });

    it('answers no hits without a query or with an empty q', async () => {
      app = await seededApp();

      expect((await app.inject({ method: 'GET', url: '/api/search' })).json()).toEqual({
        hits: [],
      });
      expect((await app.inject({ method: 'GET', url: '/api/search?q=' })).json()).toEqual({
        hits: [],
      });
    });

    it('rejects a repeated q with 400 invalid_query', async () => {
      app = await seededApp();

      const repeated = await app.inject({ method: 'GET', url: '/api/search?q=a&q=b' });

      expect(repeated.statusCode).toBe(400);
      expect(repeated.json<{ error: string }>().error).toBe('invalid_query');
    });
  });
});
