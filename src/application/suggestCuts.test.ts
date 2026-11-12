import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { unwrap } from '../core/result.js';
import { ffmpegBinary } from '../server/services/ffmpeg.js';
import { editDocHash, loadEditDoc } from '../server/services/project.js';
import { reviewSuggestions, suggestCuts } from './suggestCuts.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(withSuggestions = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'leadzy-suggest-review-'));
  roots.push(root);
  await mkdir(join(root, 'edit'), { recursive: true });
  await writeFile(join(root, 'camera.mp4'), 'media');
  const doc = {
    version: 2,
    fps: 25,
    output: { width: 1080, height: 1920, loudnormLufs: -14 },
    sources: { cam: { path: 'camera.mp4', durationS: 10 } },
    tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 10 }] }],
    subtitles: { enabled: false, preset: 'pill' },
    ...(withSuggestions
      ? {
          suggestions: [
            {
              id: 'sil-cam-2',
              type: 'silence',
              source: 'cam',
              start: 2,
              end: 3,
              reason: '1.0s pause',
            },
            {
              id: 'rep-cam-5',
              type: 'repetition',
              source: 'cam',
              start: 5,
              end: 6,
              reason: 'said again',
            },
            {
              id: 'fil-cam-8',
              type: 'filler',
              source: 'cam',
              start: 8,
              end: 8.5,
              reason: 'isolated "é"',
            },
          ],
        }
      : {}),
    totalDurationS: 10,
  };
  await writeFile(join(root, 'edit', 'edit.json'), JSON.stringify(doc));
  return root;
}

interface PersistedDoc {
  readonly tracks: readonly { readonly blocks: readonly { in: number; out: number }[] }[];
  readonly suggestions?: readonly { readonly id: string }[];
  readonly totalDurationS: number;
}

async function persisted(root: string): Promise<PersistedDoc> {
  return JSON.parse(await readFile(join(root, 'edit', 'edit.json'), 'utf8')) as PersistedDoc;
}

describe('reviewSuggestions', () => {
  it('cuts accepted intervals, drops rejected ones and leaves the rest pending', async () => {
    const root = await project();

    const summary = unwrap(
      await reviewSuggestions(root, { accept: ['sil-cam-2'], reject: ['rep-cam-5'] }),
    );

    expect(summary).toMatchObject({
      accepted: ['sil-cam-2'],
      rejected: ['rep-cam-5'],
      remaining: 1,
      totalDurationS: 9,
    });
    expect(summary.editHash).toMatch(/^[0-9a-f]{40}$/);
    const doc = await persisted(root);
    expect(doc.tracks[0]?.blocks).toEqual([
      { source: 'cam', in: 0, out: 2 },
      { source: 'cam', in: 3, out: 10 },
    ]);
    expect(doc.suggestions?.map((s) => s.id)).toEqual(['fil-cam-8']);
    expect(doc.totalDurationS).toBe(9);
  });

  it('accepts everything at once with acceptAll', async () => {
    const root = await project();
    const summary = unwrap(await reviewSuggestions(root, { acceptAll: true }));
    expect(summary.accepted).toEqual(['sil-cam-2', 'rep-cam-5', 'fil-cam-8']);
    expect(summary.remaining).toBe(0);
    const doc = await persisted(root);
    expect(doc.totalDurationS).toBe(summary.totalDurationS);
    expect(doc.totalDurationS).toBeCloseTo(7.5, 1);
  });

  it('refuses unknown ids and contradictory verdicts without touching the document', async () => {
    const root = await project();
    const before = await readFile(join(root, 'edit', 'edit.json'), 'utf8');

    const unknown = await reviewSuggestions(root, { accept: ['sil-cam-2', 'typo'] });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe('not-found');
      expect(unknown.error.message).toContain('typo');
    }
    const both = await reviewSuggestions(root, { accept: ['sil-cam-2'], reject: ['sil-cam-2'] });
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.error.code).toBe('invalid-input');

    expect(await readFile(join(root, 'edit', 'edit.json'), 'utf8')).toBe(before);
  });
});

async function clip(target: string): Promise<boolean> {
  try {
    await execa(ffmpegBinary(), [
      '-hide_banner',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=64x64:r=25',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=16000',
      '-t',
      '2',
      '-pix_fmt',
      'yuv420p',
      target,
    ]);
    return true;
  } catch {
    return false;
  }
}

describe('suggestCuts', () => {
  it('analyzes the base without trying to extract audio from silent demo layers', async () => {
    const root = await project(false);
    expect(await clip(join(root, 'camera.mp4'))).toBe(true);
    await execa(ffmpegBinary(), [
      '-v',
      'error',
      '-y',
      '-i',
      join(root, 'camera.mp4'),
      '-an',
      '-c:v',
      'copy',
      join(root, 'demo.mp4'),
    ]);
    const doc = unwrap(await loadEditDoc(root)).doc;
    await writeFile(
      join(root, 'edit', 'edit.json'),
      JSON.stringify({
        ...doc,
        sources: { ...doc.sources, demo: { path: 'demo.mp4', durationS: 2 } },
        tracks: [
          ...doc.tracks,
          {
            id: 'demo',
            kind: 'video',
            blocks: [{ source: 'demo', in: 0, out: 2, at: 0, mode: 'fullscreen', audio: 'mute' }],
          },
        ],
      }),
    );
    const result = unwrap(await suggestCuts(root));
    expect(result.suggestions.every((suggestion) => suggestion.source === 'cam')).toBe(true);
    expect(result.editHash).toBe(editDocHash(unwrap(await loadEditDoc(root)).doc));
  });

  it('does not turn a base clip without an audio stream into an extraction failure', async () => {
    const root = await project(false);
    await execa(ffmpegBinary(), [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=64x64:r=25',
      '-t',
      '2',
      '-an',
      join(root, 'camera.mp4'),
    ]);
    expect(unwrap(await suggestCuts(root)).suggestions).toEqual([]);
  });

  it('reports whether any transcript was available and the hash the document has ON DISK, even when the key order changed on write', async () => {
    const root = await project(false);
    await rm(join(root, 'camera.mp4'));
    if (!(await clip(join(root, 'camera.mp4')))) return;

    const withoutTranscript = unwrap(await suggestCuts(root));

    expect(withoutTranscript.hadTranscripts).toBe(false);
    const persistedDoc = unwrap(await loadEditDoc(root)).doc;
    expect(withoutTranscript.editHash).toBe(editDocHash(persistedDoc));

    await mkdir(join(root, 'edit', 'transcripts'), { recursive: true });
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
          text: 'olá',
          words: [{ text: 'olá', start: 0.1, end: 0.4, type: 'word' }],
          audio_duration_secs: 2,
        },
      }),
    );

    expect(unwrap(await suggestCuts(root)).hadTranscripts).toBe(true);
  });
});
