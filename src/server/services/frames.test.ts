import { execa } from 'execa';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EditDoc } from '../../core/schema.js';
import { probeMedia } from './ffmpeg.js';
import { extractFrames } from './frames.js';
import { saveEditDoc } from './project.js';

let ffmpegAvailable = false;
let projectDir = '';
let previewDurationS = 0;

async function generateSyntheticClip(target: string, durationS = 6): Promise<void> {
  await execa('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=duration=${String(durationS)}:size=640x360:rate=25`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    target,
  ]);
}

function buildManyOverlaysDoc(spanStartS: number, spanEndS: number, count: number): EditDoc {
  const step = (spanEndS - spanStartS) / (count - 1);
  return {
    version: 2,
    fps: 25,
    output: { width: 360, height: 640, loudnormLufs: null },
    sources: { take: { path: 'take.mp4' } },
    tracks: [
      { id: 'base', kind: 'video', blocks: [{ source: 'take', in: 0, out: 6 }] },
      {
        id: 'overlays',
        kind: 'overlay',
        blocks: Array.from({ length: count }, (_, i) => ({
          file: 'edit/assets/mark.png',
          at: spanStartS + i * step,
          duration: 0.02,
        })),
      },
    ],
    subtitles: { enabled: false, preset: '2p-caps' },
  };
}

// overlay midpoint 1 + 2/2 = 2.0s; effect midpoint 0.5 + 1/2 = 1.0s, which
// collides with the opening sample (1.0s) — proves dedupe merges them.
const doc: EditDoc = {
  version: 2,
  fps: 25,
  output: { width: 360, height: 640, loudnormLufs: null },
  sources: { take: { path: 'take.mp4' } },
  tracks: [
    { id: 'base', kind: 'video', blocks: [{ source: 'take', in: 0, out: 6 }] },
    {
      id: 'overlays',
      kind: 'overlay',
      blocks: [{ file: 'edit/assets/mark.png', at: 1, duration: 2 }],
    },
    {
      id: 'effects',
      kind: 'effect',
      blocks: [{ type: 'zoom', at: 0.5, duration: 1, scale: 1.1 }],
    },
  ],
  subtitles: { enabled: false, preset: '2p-caps' },
};

beforeAll(async () => {
  try {
    await execa('ffmpeg', ['-version']);
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
    return;
  }
  projectDir = mkdtempSync(join(tmpdir(), 'leadzy-frames-'));
  await mkdir(join(projectDir, 'edit'), { recursive: true });
  await generateSyntheticClip(join(projectDir, 'edit', 'preview.mp4'));
  const probed = await probeMedia(join(projectDir, 'edit', 'preview.mp4'));
  expect(probed.ok).toBe(true);
  if (probed.ok) previewDurationS = probed.value.durationS;
  const saved = await saveEditDoc(projectDir, doc);
  expect(saved.ok).toBe(true);
}, 60_000);

afterAll(() => {
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

async function pngFileSize(relPath: string): Promise<number> {
  const info = await stat(join(projectDir, relPath));
  return info.size;
}

describe('extractFrames', { concurrent: false }, () => {
  it('auto mode derives midpoints + edge samples and dedupes the collision', async () => {
    if (!ffmpegAvailable) return;
    const result = await extractFrames(projectDir, {});
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;

    const times = result.value.frames.map((f) => f.timeS);
    expect(times).toHaveLength(3);
    expect(times[0]).toBeCloseTo(1.0, 1); // opening sample merged with effect midpoint
    expect(times[1]).toBeCloseTo(2.0, 1); // overlay midpoint
    expect(times[2]).toBeCloseTo(previewDurationS - 1.0, 1); // closing sample

    for (const frame of result.value.frames) {
      expect(frame.relPath).toMatch(/^edit\/qa\/frames\/frame-\d+p\d{2}\.png$/);
      const size = await pngFileSize(frame.relPath);
      expect(size).toBeGreaterThan(0);
    }
  }, 30_000);

  it('respects explicit times without deriving from edit.json', async () => {
    if (!ffmpegAvailable) return;
    const result = await extractFrames(projectDir, { times: [0.5, 3.3] });
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;

    const times = result.value.frames.map((f) => f.timeS).sort((a, b) => a - b);
    expect(times).toHaveLength(2);
    expect(times[0]).toBeCloseTo(0.5, 5);
    expect(times[1]).toBeCloseTo(3.3, 5);

    for (const frame of result.value.frames) {
      const size = await pngFileSize(frame.relPath);
      expect(size).toBeGreaterThan(0);
    }
  }, 30_000);

  it('recreates edit/qa/frames clean on every run (no leftovers from a previous call)', async () => {
    if (!ffmpegAvailable) return;
    const first = await extractFrames(projectDir, { times: [0.5, 3.3] });
    expect(first.ok).toBe(true);
    const second = await extractFrames(projectDir, { times: [4.0] });
    expect(second.ok).toBe(true);

    const entries = await readdir(join(projectDir, 'edit', 'qa', 'frames'));
    expect(entries).toEqual(['frame-4p00.png']);
  }, 30_000);

  it('skips an explicit time that rounds to an already-used filename instead of overwriting it', async () => {
    if (!ffmpegAvailable) return;
    const result = await extractFrames(projectDir, { times: [1.301, 1.304] });
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;

    expect(result.value.frames).toHaveLength(1);
    expect(result.value.frames[0]?.timeS).toBeCloseTo(1.301, 5);
    expect(result.value.frames[0]?.relPath).toBe('edit/qa/frames/frame-1p30.png');
  }, 15_000);

  it('extracts a real, non-empty frame when the requested time lands exactly on the clip duration', async () => {
    if (!ffmpegAvailable) return;
    const result = await extractFrames(projectDir, { times: [previewDurationS] });
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;

    expect(result.value.frames).toHaveLength(1);
    const frame = result.value.frames[0];
    expect(frame).toBeDefined();
    if (!frame) return;
    expect(frame.timeS).toBeLessThan(previewDurationS);
    const size = await pngFileSize(frame.relPath);
    expect(size).toBeGreaterThan(0);
  }, 15_000);

  it('does not report a phantom frame path for a sub-1s clip in auto mode', async () => {
    if (!ffmpegAvailable) return;
    const shortDir = mkdtempSync(join(tmpdir(), 'leadzy-frames-short-'));
    try {
      await mkdir(join(shortDir, 'edit'), { recursive: true });
      await generateSyntheticClip(join(shortDir, 'edit', 'preview.mp4'), 0.5);

      const result = await extractFrames(shortDir, {});
      expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
      if (!result.ok) return;

      expect(result.value.frames.length).toBeGreaterThan(0);
      for (const frame of result.value.frames) {
        const info = await stat(join(shortDir, frame.relPath));
        expect(info.size).toBeGreaterThan(0);
      }
    } finally {
      rmSync(shortDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('caps auto-mode at MAX_AUTO_FRAMES while keeping the opening and closing samples', async () => {
    if (!ffmpegAvailable) return;
    const openingS = 1.0;
    const closingS = previewDurationS - 1.0;
    const manyOverlaysDoc = buildManyOverlaysDoc(openingS + 0.3, closingS - 0.3, 15);
    const saved = await saveEditDoc(projectDir, manyOverlaysDoc);
    expect(saved.ok).toBe(true);

    try {
      const result = await extractFrames(projectDir, {});
      expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
      if (!result.ok) return;

      const times = result.value.frames.map((f) => f.timeS).sort((a, b) => a - b);
      expect(times).toHaveLength(12);
      expect(times[0]).toBeCloseTo(openingS, 1);
      expect(times[times.length - 1]).toBeCloseTo(closingS, 1);

      for (const frame of result.value.frames) {
        const size = await pngFileSize(frame.relPath);
        expect(size).toBeGreaterThan(0);
      }
    } finally {
      const restored = await saveEditDoc(projectDir, doc);
      expect(restored.ok).toBe(true);
    }
  }, 30_000);

  it('fails clearly when preview.mp4 does not exist', async () => {
    if (!ffmpegAvailable) return;
    const emptyDir = mkdtempSync(join(tmpdir(), 'leadzy-frames-empty-'));
    try {
      await mkdir(join(emptyDir, 'edit'), { recursive: true });
      await writeFile(join(emptyDir, 'edit', 'edit.json'), JSON.stringify(doc));
      const result = await extractFrames(emptyDir, {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('render first');
      expect(result.error.message).toContain('studio render');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  }, 15_000);
});
