import Fastify from 'fastify';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ffmpegBinary } from '../services/ffmpeg.js';
import { keytermsFingerprint, transcriptMediaFingerprint } from '../services/transcribe.js';
import { registerErrorHandler } from '../errorHandler.js';
import { type ProjectRouteDeps, registerProjectRoutes } from './project.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

async function appWith(projectDir: string, reveal: ProjectRouteDeps['reveal']) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerProjectRoutes(app, {
    projectDir,
    imageProbe: () => Promise.reject(new Error('image probe not expected in this test')),
    agents: { claude: false, codex: false },
    reveal,
  });
  await app.ready();
  return app;
}

describe('POST /api/reveal', () => {
  let app: Awaited<ReturnType<typeof appWith>> | undefined;
  let projectDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    app = undefined;
    if (projectDir !== undefined) await rm(projectDir, { recursive: true, force: true });
    projectDir = undefined;
  });

  async function projectWithFinal(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'leadzy-reveal-'));
    await mkdir(join(dir, 'edit'), { recursive: true });
    await writeFile(join(dir, 'edit', 'final.mp4'), 'not really a video');
    return dir;
  }

  it('hands the resolved absolute path — never the request string — to the file manager', async () => {
    projectDir = await projectWithFinal();
    const reveal = vi.fn(() => Promise.resolve());
    app = await appWith(projectDir, reveal);

    const res = await app.inject({
      method: 'POST',
      url: '/api/reveal',
      headers: JSON_HEADERS,
      payload: { path: 'edit/./final.mp4' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(reveal).toHaveBeenCalledWith(await realpath(join(projectDir, 'edit', 'final.mp4')));
  });

  it('answers 500 reveal_failed when the file manager cannot be opened', async () => {
    projectDir = await projectWithFinal();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    app = await appWith(projectDir, () => Promise.reject(new Error('open: command not found')));

    const res = await app.inject({
      method: 'POST',
      url: '/api/reveal',
      headers: JSON_HEADERS,
      payload: { path: 'edit/final.mp4' },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: 'reveal_failed',
      message: 'could not open the file manager',
    });
  });

  it('answers 400 path_outside_project for a contained path that does not exist', async () => {
    projectDir = await projectWithFinal();
    const reveal = vi.fn(() => Promise.resolve());
    app = await appWith(projectDir, reveal);

    const res = await app.inject({
      method: 'POST',
      url: '/api/reveal',
      headers: JSON_HEADERS,
      payload: { path: 'edit/missing.mp4' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('path_outside_project');
    expect(reveal).not.toHaveBeenCalled();
  });
});

describe('GET /api/project transcript staleness', () => {
  let app: Awaited<ReturnType<typeof appWith>> | undefined;
  let projectDir: string | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (projectDir !== undefined) await rm(projectDir, { recursive: true, force: true });
    projectDir = undefined;
  });

  async function silentClip(target: string): Promise<boolean> {
    try {
      await execa(ffmpegBinary(), [
        '-hide_banner',
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=16000:cl=mono',
        '-t',
        '1',
        target,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  const cache = (sourceHash: string, keytermsHash: string): string =>
    JSON.stringify({
      engine: 'scribe',
      model: 'scribe_v2',
      sourceHash,
      keytermsHash,
      transcribedAt: '2026-08-27T15:00:00.000Z',
      transcript: { text: 'olá', words: [{ text: 'olá', start: 0, end: 0.4, type: 'word' }] },
    });

  async function projectWithClips(): Promise<{ hashOf: (name: string) => Promise<string> } | null> {
    projectDir = await mkdtemp(join(tmpdir(), 'leadzy-project-stale-'));
    if (!(await silentClip(join(projectDir, 'fresh.m4a')))) return null;
    await silentClip(join(projectDir, 'stale.m4a'));
    await silentClip(join(projectDir, 'replaced.m4a'));
    await mkdir(join(projectDir, 'edit', 'transcripts'), { recursive: true });
    const dir = projectDir;
    return {
      hashOf: async (name: string): Promise<string> => {
        const hash = await transcriptMediaFingerprint(join(dir, name));
        return hash.ok ? hash.value : '';
      },
    };
  }

  const doc = (transcription: unknown): string =>
    JSON.stringify({
      version: 2,
      fps: 25,
      output: { width: 1080, height: 1920, loudnormLufs: -14 },
      sources: { a: { path: 'fresh.m4a' } },
      tracks: [{ id: 'base', kind: 'video', blocks: [] }],
      subtitles: { enabled: false, preset: 'pill' },
      ...(transcription !== undefined ? { transcription } : {}),
    });

  async function writeCaches(hashOf: (name: string) => Promise<string>): Promise<void> {
    if (projectDir === undefined) throw new Error('project not created');
    await writeFile(
      join(projectDir, 'edit', 'transcripts', 'fresh.m4a.json'),
      cache(await hashOf('fresh.m4a'), keytermsFingerprint(['Leadzy'])),
    );
    await writeFile(
      join(projectDir, 'edit', 'transcripts', 'stale.m4a.json'),
      cache(await hashOf('stale.m4a'), keytermsFingerprint([])),
    );
    await writeFile(
      join(projectDir, 'edit', 'transcripts', 'replaced.m4a.json'),
      cache('hash-from-before-the-file-was-replaced', keytermsFingerprint(['Leadzy'])),
    );
  }

  function statesOf(body: {
    media: { relPath: string; transcriptState?: string }[];
  }): [string, string | undefined][] {
    return body.media.map((m) => [m.relPath, m.transcriptState]);
  }

  it('reports why each transcript would be redone: fresh, keyterms changed, media replaced', async () => {
    const clips = await projectWithClips();
    if (clips === null || projectDir === undefined) return;
    await writeFile(join(projectDir, 'edit', 'edit.json'), doc({ keyterms: ['Leadzy'] }));
    await writeCaches(clips.hashOf);
    app = await appWith(projectDir, () => Promise.resolve());

    const res = await app.inject({ method: 'GET', url: '/api/project' });

    expect(res.statusCode).toBe(200);
    expect(statesOf(res.json())).toEqual([
      ['fresh.m4a', 'fresh'],
      ['replaced.m4a', 'stale-media'],
      ['stale.m4a', 'stale-keyterms'],
    ]);
  });

  it.each([
    ['fails the schema', JSON.stringify({ version: 2, broken: true })],
    ['is not JSON', '{ "version": 2, '],
  ])(
    'claims no staleness when the document exists but %s — a claim would invite a re-bill',
    async (_label, content) => {
      const clips = await projectWithClips();
      if (clips === null || projectDir === undefined) return;
      await writeFile(join(projectDir, 'edit', 'edit.json'), content);
      await writeCaches(clips.hashOf);
      app = await appWith(projectDir, () => Promise.resolve());

      const res = await app.inject({ method: 'GET', url: '/api/project' });

      expect(res.statusCode).toBe(200);
      expect(statesOf(res.json())).toEqual([
        ['fresh.m4a', undefined],
        ['replaced.m4a', undefined],
        ['stale.m4a', undefined],
      ]);
    },
  );

  it('still detects a replaced media when there is no document at all', async () => {
    const clips = await projectWithClips();
    if (clips === null || projectDir === undefined) return;
    await writeCaches(clips.hashOf);
    app = await appWith(projectDir, () => Promise.resolve());

    const res = await app.inject({ method: 'GET', url: '/api/project' });

    expect(statesOf(res.json())).toEqual([
      ['fresh.m4a', 'stale-keyterms'],
      ['replaced.m4a', 'stale-media'],
      ['stale.m4a', 'fresh'],
    ]);
  });
});
