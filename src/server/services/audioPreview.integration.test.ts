import { execa } from 'execa';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEditDoc, type EditDoc } from '../../core/schema.js';
import { audioPreviewSemanticKey } from '../../core/audioPreviewFreshness.js';
import { renderAudioPreview } from './audioPreview.js';
import { probeDuration } from './ffmpeg.js';
import { editDocHash } from './project.js';
import { renderSnapshotHash } from './renderReceipt.js';
import { renderProject } from './render.js';

let ffmpegAvailable = false;
let projectDir = '';

const doc: EditDoc = {
  version: 2,
  fps: 25,
  output: {
    width: 360,
    height: 640,
    loudnormLufs: -14,
    denoise: 0.2,
    joinAudioFadeMs: 20,
    joinAudioCrossfadeMs: 80,
    speed: 1.25,
  },
  sources: { take: { path: 'take.mp4' } },
  tracks: [
    {
      id: 'base',
      kind: 'video',
      blocks: [
        { source: 'take', in: 0.5, out: 1.5 },
        { source: 'take', in: 2, out: 3.5 },
      ],
    },
  ],
  subtitles: { enabled: false, preset: '2p-caps' },
};

beforeAll(async () => {
  try {
    await execa('ffmpeg', ['-version']);
    ffmpegAvailable = true;
  } catch {
    return;
  }
  projectDir = mkdtempSync(join(tmpdir(), 'leadzy-audio-preview-'));
  await mkdir(join(projectDir, 'edit'), { recursive: true });
  await execa('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=duration=4:size=320x180:rate=25',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=4',
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    join(projectDir, 'take.mp4'),
  ]);
}, 30_000);

afterAll(() => {
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

describe('audio-only processed preview', { concurrent: false }, () => {
  it('renders the montage and loudnorm without creating a video stream', async () => {
    if (!ffmpegAvailable) return;
    const normalized = parseEditDoc(doc);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const progress: string[] = [];
    const result = await renderAudioPreview(projectDir, normalized.value, (event) => {
      progress.push(event.step);
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outputRel).toBe('edit/audio-preview.m4a');
    expect(result.value.beforeOutputRel).toBe('edit/audio-preview-before.m4a');
    expect(result.value.durationS).toBeCloseTo(2, 1);
    const beforeDuration = await probeDuration(result.value.beforeOutputAbs);
    expect(beforeDuration.ok).toBe(true);
    if (!beforeDuration.ok) return;
    expect(beforeDuration.value).toBeCloseTo(result.value.durationS, 2);
    expect(result.value.editHash).toBe(editDocHash(normalized.value));
    expect(result.value.semanticKey).toBe(audioPreviewSemanticKey(normalized.value));
    expect(await renderSnapshotHash(projectDir, 'audio-preview')).toBe(
      editDocHash(normalized.value),
    );
    expect(progress).toEqual([
      'assemble untreated audio',
      'encode untreated audio',
      'assemble audio preview',
      'measure loudness',
      'normalize audio',
      'encode audio preview',
    ]);

    for (const output of [result.value.beforeOutputAbs, result.value.outputAbs]) {
      const streams = await execa('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v',
        '-show_entries',
        'stream=index',
        '-of',
        'csv=p=0',
        output,
      ]);
      expect(streams.stdout.trim()).toBe('');
    }

    const videoPreview = await renderProject(projectDir, normalized.value, {
      preview: true,
      subtitles: false,
      loudnorm: true,
    });
    expect(videoPreview.ok).toBe(true);
    if (!videoPreview.ok) return;
    expect(result.value.durationS).toBeCloseTo(videoPreview.value.durationS, 1);

    const volumeOf = async (path: string): Promise<number> => {
      const measured = await execa('ffmpeg', [
        '-hide_banner',
        '-i',
        path,
        '-af',
        'volumedetect',
        '-f',
        'null',
        '-',
      ]);
      const match = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(measured.stderr);
      if (!match?.[1]) throw new Error(`no mean volume reported for ${path}`);
      return Number(match[1]);
    };
    const [audioDb, videoDb] = await Promise.all([
      volumeOf(result.value.outputAbs),
      volumeOf(videoPreview.value.outputAbs),
    ]);
    expect(Math.abs(audioDb - videoDb)).toBeLessThanOrEqual(0.2);
  }, 30_000);

  it('pins long loudnorm/denoise A/B variants to the same 48 kHz sample count', async () => {
    if (!ffmpegAvailable) return;
    const longDoc: EditDoc = {
      ...doc,
      output: {
        ...doc.output,
        speed: 1,
        denoise: 0.7,
        denoiseSample: { source: 'take', start: 0, end: 0.5 },
        loudnormLufs: -14,
        joinAudioCrossfadeMs: 20,
      },
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: Array.from({ length: 33 }, () => ({ source: 'take', in: 0.04, out: 3.96 })),
        },
      ],
      totalDurationS: 129.36,
    };
    const normalized = parseEditDoc(longDoc);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;

    const result = await renderAudioPreview(projectDir, normalized.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [before, after] = await Promise.all([
      probeDuration(result.value.beforeOutputAbs),
      probeDuration(result.value.outputAbs),
    ]);
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(before.value).toBeCloseTo(result.value.expectedDurationS, 3);
    expect(after.value).toBeCloseTo(result.value.expectedDurationS, 3);
    expect(Math.abs(before.value - after.value)).toBeLessThanOrEqual(1 / 48_000);
  }, 60_000);

  it('rejects immediate success when authoring media is replaced during the job', async () => {
    if (!ffmpegAvailable) return;
    const publicBefore = join(projectDir, 'edit', 'audio-preview-before.m4a');
    const publicAfter = join(projectDir, 'edit', 'audio-preview.m4a');
    await writeFile(publicBefore, 'previous before bytes');
    await writeFile(publicAfter, 'previous after bytes');
    const [previousBefore, previousAfter] = await Promise.all([
      readFile(publicBefore),
      readFile(publicAfter),
    ]);
    const sourcePath = join(projectDir, 'take.mp4');
    const originalPath = join(projectDir, 'take-before-audio-race.mp4');
    const replacementPath = join(projectDir, 'take-audio-replacement.mp4');
    copyFileSync(sourcePath, replacementPath);
    let replaced = false;

    try {
      const result = await renderAudioPreview(projectDir, doc, () => {
        if (replaced) return;
        renameSync(sourcePath, originalPath);
        renameSync(replacementPath, sourcePath);
        replaced = true;
      });

      expect(replaced).toBe(true);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('io-failed');
        expect(result.error.message).toContain('changed during the audio preview');
      }
      expect(await renderSnapshotHash(projectDir, 'audio-preview')).toBeNull();
      expect(existsSync(publicBefore)).toBe(true);
      expect(existsSync(publicAfter)).toBe(true);
      expect(await readFile(publicBefore)).toEqual(previousBefore);
      expect(await readFile(publicAfter)).toEqual(previousAfter);
    } finally {
      if (existsSync(originalPath)) {
        rmSync(sourcePath, { force: true });
        renameSync(originalPath, sourcePath);
      }
      rmSync(replacementPath, { force: true });
      rmSync(originalPath, { force: true });
    }
  }, 30_000);

  it('keeps the previous comparison and receipt byte-for-byte when staging the receipt fails', async () => {
    if (!ffmpegAvailable) return;
    const normalized = parseEditDoc(doc);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const baseline = await renderAudioPreview(projectDir, normalized.value);
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    const publicPaths = [
      baseline.value.beforeOutputAbs,
      baseline.value.outputAbs,
      join(projectDir, 'edit', 'cache', 'audio-preview.edit.json'),
      join(projectDir, 'edit', 'cache', 'audio-preview.inputs.json'),
    ];
    const previous = await Promise.all(publicPaths.map((path) => readFile(path)));
    let blockedReceipt = false;

    const result = await renderAudioPreview(projectDir, normalized.value, (event) => {
      if (blockedReceipt || event.index !== event.total) return;
      const jobsRoot = join(projectDir, 'edit', 'cache', 'audio-preview-jobs');
      const currentJob = readdirSync(jobsRoot, { withFileTypes: true }).find((entry) =>
        entry.isDirectory(),
      );
      if (currentJob === undefined) return;
      writeFileSync(join(jobsRoot, currentJob.name, 'receipt-project'), 'block receipt staging');
      blockedReceipt = true;
    });

    expect(blockedReceipt).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('io-failed');
      expect(result.error.message).toContain('prepare the audio comparison receipt');
    }
    const current = await Promise.all(publicPaths.map((path) => readFile(path)));
    expect(current).toEqual(previous);
    expect(await renderSnapshotHash(projectDir, 'audio-preview')).toBe(
      editDocHash(normalized.value),
    );
  }, 30_000);

  it('restores outputs and both receipt files when receipt promotion fails', async () => {
    if (!ffmpegAvailable) return;
    const normalized = parseEditDoc(doc);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const baseline = await renderAudioPreview(projectDir, normalized.value);
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    const publicPaths = [
      baseline.value.beforeOutputAbs,
      baseline.value.outputAbs,
      join(projectDir, 'edit', 'cache', 'audio-preview.edit.json'),
      join(projectDir, 'edit', 'cache', 'audio-preview.inputs.json'),
    ];
    const previous = await Promise.all(publicPaths.map((path) => readFile(path)));
    let blockedPromotion = false;

    const result = await renderAudioPreview(projectDir, normalized.value, (event) => {
      if (blockedPromotion || event.index !== event.total) return;
      const jobsRoot = join(projectDir, 'edit', 'cache', 'audio-preview-jobs');
      const currentJob = readdirSync(jobsRoot, { withFileTypes: true }).find((entry) =>
        entry.isDirectory(),
      );
      if (currentJob === undefined) return;
      const blocker = join(jobsRoot, currentJob.name, 'previous-receipt-inputs.json');
      mkdirSync(blocker);
      writeFileSync(join(blocker, 'keep'), 'prevent receipt backup');
      blockedPromotion = true;
    });

    expect(blockedPromotion).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('io-failed');
      expect(result.error.message).toContain('publish the new audio comparison');
    }
    const current = await Promise.all(publicPaths.map((path) => readFile(path)));
    expect(current).toEqual(previous);
    expect(await renderSnapshotHash(projectDir, 'audio-preview')).toBe(
      editDocHash(normalized.value),
    );
  }, 30_000);
});
