import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { unwrap } from '../../core/result.js';
import { formatTranscriptWords, transcriptWords } from './transcriptWords.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const WORDS = [
  { text: 'Olha', start: 1.1, end: 1.28 },
  { text: 'pessoal,', start: 1.3, end: 1.78 },
  { text: 'a', start: 2.24, end: 2.34 },
  { text: 'gente', start: 2.42, end: 2.86 },
  { text: 'tá', start: 3.26, end: 3.4 },
];

async function project(withCache = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'leadzy-transcript-words-'));
  roots.push(root);
  await mkdir(join(root, 'edit', 'transcripts'), { recursive: true });
  await writeFile(join(root, 'camera.mp4'), 'fake media bytes');
  const doc = {
    version: 2,
    fps: 25,
    output: { width: 1080, height: 1920, loudnormLufs: -14 },
    sources: { cam: { path: 'camera.mp4' } },
    tracks: [{ id: 'base', kind: 'video', blocks: [] }],
    subtitles: { enabled: false, preset: 'pill' },
  };
  await writeFile(join(root, 'edit', 'edit.json'), JSON.stringify(doc));
  if (withCache) {
    await writeFile(
      join(root, 'edit', 'transcripts', 'camera.mp4.json'),
      JSON.stringify({
        engine: 'scribe',
        model: 'scribe_v2',
        sourceHash: 'h',
        keytermsHash: 'k',
        transcribedAt: '2026-08-27T15:00:00.000Z',
        transcript: {
          language_code: 'por',
          text: WORDS.map((w) => w.text).join(' '),
          words: WORDS.map((w) => ({ ...w, type: 'word' as const })),
          audio_duration_secs: 3.4,
        },
      }),
    );
  }
  return root;
}

describe('transcript words command', () => {
  it('prints one line per spoken word inside the window and the covering block', async () => {
    const root = await project();

    const result = unwrap(
      await transcriptWords(root, { source: 'cam', from: 2.24, to: 2.86, block: true }),
    );

    expect(result.words.map((w) => w.text)).toEqual(['a', 'gente']);
    expect(result.block).toStrictEqual({
      source: 'cam',
      in: 2.19,
      out: 2.94,
      firstWord: 'a',
      lastWord: 'gente',
    });
    expect(formatTranscriptWords(result)).toBe(
      [
        '2.24-2.34 a',
        '2.42-2.86 gente',
        'block: {"source":"cam","in":2.19,"out":2.94}  # "a" … "gente"',
      ].join('\n'),
    );
  });

  it('greps words without a window', async () => {
    const root = await project();
    const result = unwrap(await transcriptWords(root, { source: 'cam', grep: 'PESSOAL' }));
    expect(result.words.map((w) => w.text)).toEqual(['pessoal,']);
    expect(result.block).toBeNull();
  });

  it('refuses --block without a full window, an unknown source, and a source without a cache', async () => {
    const root = await project();
    const partial = await transcriptWords(root, { source: 'cam', from: 1, block: true });
    expect(partial.ok).toBe(false);
    if (!partial.ok) expect(partial.error.code).toBe('invalid-input');

    const unknown = await transcriptWords(root, { source: 'nope' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('not-found');

    const uncached = await transcriptWords(await project(false), { source: 'cam' });
    expect(uncached.ok).toBe(false);
    if (!uncached.ok) expect(uncached.error.message).toContain('run "transcribe" first');
  });
});
