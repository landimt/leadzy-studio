import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ffmpegBinary } from '../server/services/ffmpeg.js';
import { keytermsFingerprint, transcriptMediaFingerprint } from '../server/services/transcribe.js';
import { StudioDb } from '../db/index.js';
import { pendingSummary, transcribeProject } from './transcribeProject.js';

const cache = (sourceHash: string, keytermsHash: string): string =>
  JSON.stringify({
    engine: 'scribe',
    model: 'scribe_v2',
    sourceHash,
    keytermsHash,
    transcribedAt: '2026-08-27T15:00:00.000Z',
    transcript: { text: 'olá', words: [{ text: 'olá', start: 0, end: 0.4, type: 'word' }] },
  });

async function clip(target: string, audible: boolean): Promise<boolean> {
  const inputs = audible
    ? [
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=64x64:r=25',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=16000',
      ]
    : ['-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=25'];
  try {
    await execa(ffmpegBinary(), [
      '-hide_banner',
      '-v',
      'error',
      '-y',
      ...inputs,
      '-t',
      '1',
      '-pix_fmt',
      'yuv420p',
      target,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function hashOf(path: string): Promise<string> {
  const hash = await transcriptMediaFingerprint(path);
  if (!hash.ok) throw new Error(hash.error.message);
  return hash.value;
}

let previousDb: string | undefined;
let dbDir: string;

beforeAll(async () => {
  dbDir = await mkdtemp(join(tmpdir(), 'leadzy-transcribe-db-'));
  previousDb = process.env.LEADZY_STUDIO_DB;
  process.env.LEADZY_STUDIO_DB = join(dbDir, 'studio.sqlite');
});

afterAll(async () => {
  if (previousDb === undefined) delete process.env.LEADZY_STUDIO_DB;
  else process.env.LEADZY_STUDIO_DB = previousDb;
  await rm(dbDir, { recursive: true, force: true });
});

describe('transcribeProject', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'leadzy-transcribe-project-'));
    await mkdir(join(dir, 'edit', 'transcripts'), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const cacheOf = (name: string): string => join(dir, 'edit', 'transcripts', `${name}.json`);

  it.each([
    ['fails the schema', JSON.stringify({ version: 2, broken: true })],
    ['is not JSON', '{ "version": 2, '],
    ['is empty', ''],
  ])(
    'refuses to run when edit.json exists but %s — its keyterms would be lost',
    async (_label, content) => {
      await writeFile(join(dir, 'take.mp4'), 'fake media bytes');
      const primed = cache('h', 'with-keyterms');
      await writeFile(cacheOf('take.mp4'), primed);
      await writeFile(join(dir, 'edit', 'edit.json'), content);

      const result = await transcribeProject(dir, { apiKey: 'sk-test', assumeYes: true });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid-edit-json');
        expect(result.error.message).toContain('cannot be read');
        expect(result.error.message).not.toContain('run studio open');
      }
      expect(await readFile(cacheOf('take.mp4'), 'utf8')).toBe(primed);
    },
  );

  it('proceeds without keyterms when there is no document, keeping a current cache', async () => {
    if (!(await clip(join(dir, 'take.mp4'), true))) return;
    await writeFile(
      cacheOf('take.mp4'),
      cache(await hashOf(join(dir, 'take.mp4')), keytermsFingerprint([])),
    );

    const result = await transcribeProject(dir, { assumeYes: true });

    expect(result).toEqual({
      ok: true,
      value: { transcribed: [], skippedCached: ['take.mp4'], retired: [] },
    });
  });

  it('tries to transcribe a media whose file changed since its cache (and needs a key for that)', async () => {
    if (!(await clip(join(dir, 'take.mp4'), true))) return;
    await writeFile(
      cacheOf('take.mp4'),
      cache('hash-of-the-previous-file', keytermsFingerprint([])),
    );

    const result = await transcribeProject(dir, { assumeYes: true });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing-api-key');
  });

  it('tries to transcribe a media whose keyterms changed since its cache', async () => {
    if (!(await clip(join(dir, 'take.mp4'), true))) return;
    await writeFile(
      join(dir, 'edit', 'edit.json'),
      JSON.stringify({
        version: 2,
        fps: 25,
        output: { width: 1080, height: 1920, loudnormLufs: -14 },
        sources: { a: { path: 'take.mp4' } },
        tracks: [{ id: 'base', kind: 'video', blocks: [] }],
        subtitles: { enabled: false, preset: 'pill' },
        transcription: { keyterms: ['Leadzy'] },
      }),
    );
    await writeFile(
      cacheOf('take.mp4'),
      cache(await hashOf(join(dir, 'take.mp4')), keytermsFingerprint([])),
    );

    const result = await transcribeProject(dir, { assumeYes: true });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing-api-key');
  });

  it('skips a silent media that never had a cache without touching the file system', async () => {
    if (!(await clip(join(dir, 'take.mp4'), false))) return;

    const result = await transcribeProject(dir, { assumeYes: true });

    expect(result).toEqual({
      ok: true,
      value: { transcribed: [], skippedCached: [], retired: [] },
    });
    expect(existsSync(join(dir, 'edit', 'history'))).toBe(false);
  });

  it('retires the transcript of a media that no longer has audio instead of serving it', async () => {
    if (!(await clip(join(dir, 'take.mp4'), false))) return;
    await writeFile(
      cacheOf('take.mp4'),
      cache('hash-of-the-take-that-had-audio', keytermsFingerprint([])),
    );
    const seed = new StudioDb();
    try {
      const project = seed.upsertProject(dir);
      seed.upsertMedia(project.id, {
        relPath: 'take.mp4',
        hash: 'h',
        durationS: 1,
        transcriptStatus: 'scribe',
        transcriptText: 'olá do take antigo',
      });
      expect(seed.search('antigo')).toHaveLength(1);
    } finally {
      seed.close();
    }

    const result = await transcribeProject(dir, { assumeYes: true });

    const index = new StudioDb();
    try {
      expect(index.search('antigo')).toEqual([]);
    } finally {
      index.close();
    }

    expect(result).toEqual({
      ok: true,
      value: { transcribed: [], skippedCached: [], retired: ['take.mp4'] },
    });
    expect(await readdir(join(dir, 'edit', 'transcripts'))).toEqual([]);
    expect((await readdir(join(dir, 'edit', 'history', 'transcripts')))[0]).toMatch(
      /^take\.mp4\..*\.json$/,
    );
  });
});

describe('pendingSummary', () => {
  it('lists only the reasons that apply, in a fixed order', () => {
    expect(
      pendingSummary(
        [{ state: 'stale-keyterms' }, { state: 'missing' }, { state: 'stale-keyterms' }],
        false,
      ),
    ).toBe('1 without transcript, 2 with changed keyterms');
    expect(pendingSummary([{ state: 'stale-media' }], false)).toBe('1 with changed media');
    expect(pendingSummary([{ state: 'fresh' }], true)).toBe('forced');
  });
});
