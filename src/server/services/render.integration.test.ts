import { execa } from 'execa';
import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EditDoc } from '../../core/schema.js';
import { detectSilences } from '../../core/silence.js';
import { buildSuggestions } from '../../core/suggest.js';
import * as audioModule from './audio.js';
import { loadPcm, PCM_SAMPLE_RATE } from './audio.js';
import * as ffmpegModule from './ffmpeg.js';
import { probeMedia } from './ffmpeg.js';
import { intersectIntervals, noiseFloorDbFromSamples } from './noiseFloor.js';
import * as renderReceiptModule from './renderReceipt.js';
import { getOrBuildProxy } from './proxy.js';
import { renderProject } from './render.js';
import { recoverRenderPublications } from './renderPublication.js';
import { editDocHash, loadEditDoc, saveEditDoc } from './project.js';
import { renderSnapshotHash } from './renderReceipt.js';

let ffmpegAvailable = false;
let projectDir = '';

const SOURCE = 'take.mp4';

// Synthetic 6s clip: tone → 1.2s silence (2.0–3.2) → tone. Every assertion
// below derives from these numbers.
async function generateSyntheticClip(target: string): Promise<void> {
  await execa('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=duration=6:size=640x360:rate=25',
    '-f',
    'lavfi',
    '-i',
    "sine=frequency=440:duration=6,volume=volume='if(between(t,2,3.2),0.0001,0.5)':eval=frame",
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
    target,
  ]);
}

const doc: EditDoc = {
  version: 2,
  fps: 25,
  output: { width: 360, height: 640, loudnormLufs: -14 },
  sources: { take: { path: SOURCE } },
  tracks: [
    {
      id: 'base',
      kind: 'video',
      blocks: [
        { source: 'take', in: 0.5, out: 2 },
        { source: 'take', in: 3.5, out: 5.5 },
      ],
    },
  ],
  subtitles: { enabled: false, preset: '2p-caps' },
  totalDurationS: 3.5,
};

/** Average luma (0–255) of the frame at `atS`, via ffmpeg's signalstats filter. */
async function frameLuma(filePath: string, atS: number): Promise<number> {
  const result = await execa('ffmpeg', [
    '-hide_banner',
    '-y',
    '-ss',
    String(atS),
    '-i',
    filePath,
    '-vframes',
    '1',
    '-vf',
    'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
    '-f',
    'null',
    '-',
  ]);
  const match = /YAVG=([\d.]+)/.exec(result.stdout);
  if (!match?.[1]) throw new Error(`no YAVG reported for ${filePath}@${String(atS)}s`);
  return Number(match[1]);
}

/** Mean audio volume (dBFS) of `filePath` inside [startS, endS), via ffmpeg's volumedetect filter. */
async function meanVolumeDb(filePath: string, startS: number, endS: number): Promise<number> {
  const result = await execa('ffmpeg', [
    '-hide_banner',
    '-y',
    '-i',
    filePath,
    '-af',
    `atrim=start=${String(startS)}:end=${String(endS)},volumedetect`,
    '-f',
    'null',
    '-',
  ]);
  const match = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(result.stderr);
  if (!match?.[1]) {
    throw new Error(`no mean_volume reported for ${filePath}@${String(startS)}-${String(endS)}s`);
  }
  return Number(match[1]);
}

/** Raw RGB24 pixel bytes of the frame at `atS`, for exact frame-content comparison. */
async function rawFrame(filePath: string, atS: number): Promise<Buffer> {
  const result = await execa(
    'ffmpeg',
    [
      '-hide_banner',
      '-y',
      '-ss',
      String(atS),
      '-i',
      filePath,
      '-vframes',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ],
    { encoding: 'buffer' },
  );
  return Buffer.from(result.stdout);
}

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** rgb24 pixel at (x,y) in a `rawFrame` buffer of the given frame width. */
function pixelAt(frame: Buffer, x: number, y: number, width: number): Rgb {
  const offset = (y * width + x) * 3;
  return { r: frame[offset] ?? 0, g: frame[offset + 1] ?? 0, b: frame[offset + 2] ?? 0 };
}

const isWhitish = (p: Rgb): boolean => p.r > 200 && p.g > 200 && p.b > 200;

async function generateWhiteClip(target: string): Promise<void> {
  await execa('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=white:s=640x360:r=25:d=2',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    target,
  ]);
}

/** Snapshot of cached base segments: filename → mtime, keyed for delta comparisons. */
async function statSegments(dir: string): Promise<Map<string, number>> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const stats = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mov')) continue;
    const info = await stat(join(dir, entry.name));
    stats.set(entry.name, info.mtimeMs);
  }
  return stats;
}

interface PublishedRenderState {
  readonly video: Buffer;
  readonly editReceipt: Buffer;
  readonly inputsReceipt: Buffer;
}

async function publishedRenderState(kind: 'preview' | 'final'): Promise<PublishedRenderState> {
  const [video, editReceipt, inputsReceipt] = await Promise.all([
    readFile(join(projectDir, 'edit', `${kind}.mp4`)),
    readFile(join(projectDir, 'edit', 'cache', `${kind}.edit.json`)),
    readFile(join(projectDir, 'edit', 'cache', `${kind}.inputs.json`)),
  ]);
  return { video, editReceipt, inputsReceipt };
}

async function renderJobEntries(): Promise<string[]> {
  return readdir(join(projectDir, 'edit', 'cache', 'render-jobs')).catch(() => []);
}

beforeAll(async () => {
  try {
    await execa('ffmpeg', ['-version']);
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
    return;
  }
  projectDir = mkdtempSync(join(tmpdir(), 'leadzy-render-'));
  await generateSyntheticClip(join(projectDir, SOURCE));
  await mkdir(join(projectDir, 'edit'), { recursive: true });
  await mkdir(join(projectDir, 'edit', 'transcripts'), { recursive: true });
  await writeFile(
    join(projectDir, 'edit', 'transcripts', `${SOURCE}.json`),
    JSON.stringify({
      engine: 'scribe',
      model: 'scribe_v2',
      sourceHash: 'synthetic',
      keytermsHash: 'k',
      transcribedAt: '2026-08-27T15:00:00.000Z',
      transcript: {
        language_code: 'pt',
        text: 'cores livres outra estrutura',
        words: [
          { text: 'cores', start: 0.65, end: 0.95, type: 'word' },
          { text: 'livres', start: 1.05, end: 1.4, type: 'word' },
          { text: 'outra', start: 3.7, end: 4.05, type: 'word' },
          { text: 'estrutura', start: 4.15, end: 4.65, type: 'word' },
        ],
      },
    }),
  );
}, 60_000);

afterAll(() => {
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('render pipeline on a synthetic clip', { concurrent: false }, () => {
  it('detects the engineered silence offline', async () => {
    if (!ffmpegAvailable) return;
    const pcm = await loadPcm(join(projectDir, SOURCE));
    expect(pcm.ok).toBe(true);
    if (!pcm.ok) return;
    const silences = detectSilences(pcm.value, PCM_SAMPLE_RATE);
    const engineered = silences.find((s) => Math.abs(s.start - 2) < 0.2);
    expect(engineered).toBeDefined();
    expect(engineered!.end).toBeCloseTo(3.2, 0);

    const suggestions = buildSuggestions({ source: 'take', silences });
    expect(suggestions.some((s) => s.type === 'silence')).toBe(true);
  }, 30_000);

  it('round-trips the edit doc through save and load', async () => {
    if (!ffmpegAvailable) return;
    const saved = await saveEditDoc(projectDir, doc);
    expect(saved.ok).toBe(true);
    const loaded = await loadEditDoc(projectDir);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.doc).toEqual(doc);
  });

  it('renders the final cut with loudnorm and hits the expected duration/fps', async () => {
    if (!ffmpegAvailable) return;
    const runFfmpegSpy = vi.spyOn(ffmpegModule, 'runFfmpeg');
    const outcome = await renderProject(projectDir, doc, {
      preview: false,
      subtitles: true,
      loudnorm: true,
    });
    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
    if (!outcome.ok) return;

    // block 1 (1.5s) quantizes to 38 frames = 1.52s on the 25fps grid
    expect(outcome.value.editHash).toBe(editDocHash(doc));
    const finalSnapshot = JSON.parse(
      await readFile(join(projectDir, 'edit', 'cache', 'final.edit.json'), 'utf8'),
    ) as unknown;
    expect(finalSnapshot).toEqual(doc);
    expect(outcome.value.expectedDurationS).toBeCloseTo(3.52, 5);
    const probe = await probeMedia(outcome.value.outputAbs);
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(Math.abs(probe.value.durationS - 3.52)).toBeLessThan(0.15);
    expect(probe.value.fps).toBe(25);
    expect(probe.value.width).toBe(360);
    expect(probe.value.height).toBe(640);
    expect(probe.value.hasAudio).toBe(true);

    const loudnormApplyCall = runFfmpegSpy.mock.calls.find(([args]) =>
      args.some((arg) => arg.includes('measured_I=')),
    );
    expect(loudnormApplyCall).toBeDefined();
    expect(loudnormApplyCall![0].at(-1)).toMatch(/^edit\/cache\/render-jobs\/[^/]+\/final\.mp4$/u);
    expect(loudnormApplyCall![0].at(-1)).not.toBe('edit/final.mp4');
  }, 120_000);

  it('preview applies the doc-level loudnorm decision — a numeric loudnormLufs measurably changes preview volume vs null', async () => {
    if (!ffmpegAvailable) return;
    const renderOptions = { preview: true, subtitles: false, loudnorm: true };

    const normalized = await renderProject(projectDir, doc, renderOptions);
    expect(normalized.ok, normalized.ok ? '' : normalized.error.message).toBe(true);
    if (!normalized.ok) return;
    const normalizedPath = join(projectDir, 'edit', 'preview-loudnorm-on.mp4');
    await copyFile(normalized.value.outputAbs, normalizedPath);

    const offDoc: EditDoc = { ...doc, output: { ...doc.output, loudnormLufs: null } };
    const unnormalized = await renderProject(projectDir, offDoc, renderOptions);
    expect(unnormalized.ok, unnormalized.ok ? '' : unnormalized.error.message).toBe(true);
    if (!unnormalized.ok) return;
    const unnormalizedPath = join(projectDir, 'edit', 'preview-loudnorm-off.mp4');
    await copyFile(unnormalized.value.outputAbs, unnormalizedPath);

    // Same window inside the first block, clear of the 30ms edge declick
    // fades and the emenda — any volume difference can only come from the
    // loudnorm chain running (or not) in preview.
    const normalizedDb = await meanVolumeDb(normalizedPath, 0.3, 1.0);
    const unnormalizedDb = await meanVolumeDb(unnormalizedPath, 0.3, 1.0);
    expect(Math.abs(normalizedDb - unnormalizedDb)).toBeGreaterThan(0.5);
  }, 120_000);

  it('renders successfully with an explicit joinAudioFadeMs de-click fade', async () => {
    if (!ffmpegAvailable) return;
    const withFade: EditDoc = { ...doc, output: { ...doc.output, joinAudioFadeMs: 15 } };
    const outcome = await renderProject(projectDir, withFade, {
      preview: true,
      subtitles: false,
      loudnorm: false,
    });
    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
  }, 120_000);

  it('renders a two-block cut with a fade-black transition at the emenda', async () => {
    if (!ffmpegAvailable) return;
    const withTransition: EditDoc = {
      ...doc,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'take', in: 0.5, out: 2 },
            {
              source: 'take',
              in: 3.5,
              out: 5.5,
              transition: { type: 'fade-black', durationS: 0.3 },
            },
          ],
        },
      ],
    };
    const outcome = await renderProject(projectDir, withTransition, {
      preview: true,
      subtitles: false,
      loudnorm: false,
    });
    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
  }, 120_000);

  it('renders a preview at reduced resolution', async () => {
    if (!ffmpegAvailable) return;
    const outcome = await renderProject(projectDir, doc, {
      preview: true,
      subtitles: true,
      loudnorm: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.outputRel).toBe('edit/preview.mp4');
    expect(outcome.value.canonical).toBe(true);
    const probe = await probeMedia(outcome.value.outputAbs);
    if (probe.ok) {
      // output is already ≤720 on the short side — preview keeps it unchanged
      expect(probe.value.width).toBe(360);
    }
    expect(outcome.value.editHash).toBe(editDocHash(doc));
    const previewSnapshot = JSON.parse(
      await readFile(join(projectDir, 'edit', 'cache', 'preview.edit.json'), 'utf8'),
    ) as unknown;
    expect(previewSnapshot).toEqual(doc);
  }, 120_000);

  it('decodes sources on the hardware decoder when ffmpeg has it, and on the CPU when the env flag forces it', async () => {
    if (!ffmpegAvailable) return;
    const capabilities = await ffmpegModule.ffmpegCapabilities();
    if (!capabilities.ok || !capabilities.value.hasVideotoolboxDecode) return;
    // A block edge no other test uses, so the segment is extracted (not served from cache) here.
    const base = doc.tracks[0];
    if (base?.kind !== 'video') throw new Error('fixture has no base video track');
    const hwDoc: EditDoc = {
      ...doc,
      tracks: [
        {
          ...base,
          blocks: base.blocks.map((block, index) =>
            index === 0 && 'in' in block ? { ...block, out: block.out - 0.04 } : block,
          ),
        },
        ...doc.tracks.slice(1),
      ],
    };
    const renderOptions = { preview: true, subtitles: true, loudnorm: true } as const;
    const segmentArgs = (calls: readonly (readonly unknown[])[]): readonly string[] | undefined =>
      calls
        .map((call) => call[0])
        .find((args): args is readonly string[] => Array.isArray(args) && args.includes('-ss'));

    const hwSpy = vi.spyOn(ffmpegModule, 'runFfmpeg');
    const hardware = await renderProject(projectDir, hwDoc, renderOptions);
    expect(hardware.ok, hardware.ok ? '' : hardware.error.message).toBe(true);
    const hwArgs = segmentArgs(hwSpy.mock.calls);
    expect(hwArgs).toBeDefined();
    if (!hwArgs) return;
    const hwIndex = hwArgs.indexOf('-hwaccel');
    expect(hwIndex).toBeGreaterThanOrEqual(0);
    expect(hwArgs[hwIndex + 1]).toBe('videotoolbox');
    expect(hwIndex).toBeLessThan(hwArgs.indexOf('-ss'));
    if (capabilities.value.hasVideotoolbox) expect(hwArgs).toContain('h264_videotoolbox');
    hwSpy.mockRestore();

    vi.stubEnv('LEADZY_STUDIO_SOFTWARE_DECODE', '1');
    try {
      const swSpy = vi.spyOn(ffmpegModule, 'runFfmpeg');
      const software = await renderProject(projectDir, hwDoc, renderOptions);
      expect(software.ok, software.ok ? '' : software.error.message).toBe(true);
      const swArgs = segmentArgs(swSpy.mock.calls);
      expect(swArgs).toBeDefined();
      expect(swArgs).not.toContain('-hwaccel');
      swSpy.mockRestore();
    } finally {
      vi.unstubAllEnvs();
    }
  }, 180_000);

  it('previews read video from a fresh proxy and audio from the original; finals never touch the proxy', async () => {
    if (!ffmpegAvailable) return;
    const proxy = await getOrBuildProxy(projectDir, SOURCE);
    expect(proxy.ok, proxy.ok ? '' : proxy.error.message).toBe(true);
    if (!proxy.ok) return;
    const base = doc.tracks[0];
    if (base?.kind !== 'video') throw new Error('fixture has no base video track');
    const proxyDoc: EditDoc = {
      ...doc,
      tracks: [
        {
          ...base,
          blocks: base.blocks.map((block, index) =>
            index === 0 && 'in' in block ? { ...block, out: block.out - 0.08 } : block,
          ),
        },
        ...doc.tracks.slice(1),
      ],
    };
    const inputsOf = (args: readonly string[]): string[] =>
      args.filter((_, index) => args[index - 1] === '-i');
    const segmentArgs = (calls: readonly (readonly unknown[])[]): readonly string[] | undefined =>
      calls
        .map((call) => call[0])
        .find((args): args is readonly string[] => Array.isArray(args) && args.includes('-ss'));

    const previewSpy = vi.spyOn(ffmpegModule, 'runFfmpeg');
    const preview = await renderProject(projectDir, proxyDoc, {
      preview: true,
      subtitles: true,
      loudnorm: true,
    });
    expect(preview.ok, preview.ok ? '' : preview.error.message).toBe(true);
    const previewSegment = segmentArgs(previewSpy.mock.calls);
    expect(previewSegment).toBeDefined();
    if (!previewSegment) return;
    const previewInputs = inputsOf(previewSegment);
    expect(previewInputs[0]).toBe(proxy.value);
    expect(previewInputs).toHaveLength(2);
    expect(previewInputs[1]).not.toBe(proxy.value);
    expect(previewSegment).toContain('0:v:0');
    previewSpy.mockRestore();

    const finalSpy = vi.spyOn(ffmpegModule, 'runFfmpeg');
    const final = await renderProject(projectDir, proxyDoc, {
      preview: false,
      subtitles: true,
      loudnorm: true,
    });
    expect(final.ok, final.ok ? '' : final.error.message).toBe(true);
    const finalSegment = segmentArgs(finalSpy.mock.calls);
    expect(finalSegment).toBeDefined();
    if (!finalSegment) return;
    expect(inputsOf(finalSegment)).toHaveLength(1);
    expect(finalSegment).not.toContain(proxy.value);
    finalSpy.mockRestore();
  }, 180_000);

  it('rolls back the MP4 and both receipts when publication fails after staging', async () => {
    if (!ffmpegAvailable) return;
    const baseline = await renderProject(projectDir, doc, {
      preview: true,
      subtitles: true,
      loudnorm: true,
    });
    expect(baseline.ok, baseline.ok ? '' : baseline.error.message).toBe(true);
    if (!baseline.ok) return;
    const before = await publishedRenderState('preview');
    const beforeHash = await renderSnapshotHash(projectDir, 'preview');
    expect(beforeHash).not.toBeNull();

    // Simulate a receipt staging implementation that reports success without
    // producing its two files. Promotion moves the staged MP4 first, then
    // fails on the missing receipt and must restore the complete old set.
    vi.spyOn(renderReceiptModule, 'writeRenderReceipt').mockResolvedValue(undefined);
    const changed: EditDoc = {
      ...doc,
      output: { ...doc.output, speed: 1.1 },
    };
    const outcome = await renderProject(projectDir, changed, {
      preview: true,
      subtitles: true,
      loudnorm: true,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe('io-failed');
      expect(outcome.error.message).toContain('publicar');
    }
    expect(await publishedRenderState('preview')).toEqual(before);
    expect(await renderSnapshotHash(projectDir, 'preview')).toBe(beforeHash);
    expect(await renderJobEntries()).toEqual([]);
  }, 120_000);

  it('restores the canonical MP4 and receipts when non-canonical publication fails', async () => {
    if (!ffmpegAvailable) return;
    const baseline = await renderProject(projectDir, doc, {
      preview: true,
      subtitles: true,
      loudnorm: true,
    });
    expect(baseline.ok, baseline.ok ? '' : baseline.error.message).toBe(true);
    if (!baseline.ok) return;
    const before = await publishedRenderState('preview');
    const beforeHash = await renderSnapshotHash(projectDir, 'preview');
    expect(beforeHash).not.toBeNull();

    // Delete the already-probed staged artifact just before promotion. This
    // exercises the non-canonical transaction, where receipt temporaries are
    // intentionally absent and successful publication would remove them.
    const realProbeMedia = ffmpegModule.probeMedia;
    vi.spyOn(ffmpegModule, 'probeMedia').mockImplementation(async (absolutePath) => {
      const result = await realProbeMedia(absolutePath);
      if (/[\\/]edit[\\/]cache[\\/]render-jobs[\\/][^\\/]+[\\/]preview\.mp4$/u.test(absolutePath)) {
        await rm(absolutePath, { force: true });
      }
      return result;
    });
    const changed: EditDoc = {
      ...doc,
      output: { ...doc.output, speed: 1.05 },
    };
    const outcome = await renderProject(projectDir, changed, {
      preview: true,
      subtitles: false,
      loudnorm: true,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe('io-failed');
      expect(outcome.error.message).toContain('publicar');
    }
    expect(await publishedRenderState('preview')).toEqual(before);
    expect(await renderSnapshotHash(projectDir, 'preview')).toBe(beforeHash);
    expect(await renderJobEntries()).toEqual([]);
  }, 120_000);

  it('recovers a process crash between the atomic MP4 swap and receipt commit', async () => {
    if (!ffmpegAvailable) return;
    const baseline = await renderProject(projectDir, doc, {
      preview: true,
      subtitles: true,
      loudnorm: true,
    });
    expect(baseline.ok, baseline.ok ? '' : baseline.error.message).toBe(true);
    if (!baseline.ok) return;
    const before = await publishedRenderState('preview');

    const jobDir = join(projectDir, 'edit', 'cache', 'render-jobs', 'crashed-publication');
    await mkdir(jobDir, { recursive: true });
    await Promise.all([
      copyFile(join(projectDir, 'edit', 'preview.mp4'), join(jobDir, 'previous-preview.mp4')),
      copyFile(
        join(projectDir, 'edit', 'cache', 'preview.edit.json'),
        join(jobDir, 'previous-receipt-edit.json'),
      ),
      copyFile(
        join(projectDir, 'edit', 'cache', 'preview.inputs.json'),
        join(jobDir, 'previous-receipt-inputs.json'),
      ),
    ]);
    await writeFile(
      join(jobDir, 'publication.json'),
      `${JSON.stringify({
        version: 1,
        artifactKind: 'preview',
        canonical: true,
        phase: 'prepared',
        previous: [true, true, true],
      })}\n`,
    );

    // State left by a hard kill after the new MP4/edit snapshot landed but
    // before the inputs receipt (the freshness commit marker) was published.
    await rm(join(projectDir, 'edit', 'cache', 'preview.inputs.json'));
    await writeFile(join(projectDir, 'edit', 'preview.mp4'), 'interrupted-new-video');
    await writeFile(join(projectDir, 'edit', 'cache', 'preview.edit.json'), '{}\n');

    const recovered = await recoverRenderPublications(projectDir);
    expect(recovered.ok, recovered.ok ? '' : recovered.error.message).toBe(true);
    expect(await publishedRenderState('preview')).toEqual(before);
    expect(await renderJobEntries()).toEqual([]);
  }, 120_000);

  it('sweeps a committed job left behind by a cleanup failure', async () => {
    if (!ffmpegAvailable) return;
    const baseline = await renderProject(projectDir, doc, {
      preview: true,
      subtitles: true,
      loudnorm: true,
    });
    expect(baseline.ok, baseline.ok ? '' : baseline.error.message).toBe(true);
    if (!baseline.ok) return;
    const before = await publishedRenderState('preview');
    const jobDir = join(projectDir, 'edit', 'cache', 'render-jobs', 'committed-publication');
    await mkdir(jobDir, { recursive: true });
    await writeFile(
      join(jobDir, 'publication.json'),
      `${JSON.stringify({
        version: 1,
        artifactKind: 'preview',
        canonical: true,
        phase: 'committed',
        previous: [true, true, true],
      })}\n`,
    );

    const recovered = await recoverRenderPublications(projectDir);
    expect(recovered.ok, recovered.ok ? '' : recovered.error.message).toBe(true);
    expect(await publishedRenderState('preview')).toEqual(before);
    expect(await renderJobEntries()).toEqual([]);
  }, 120_000);

  it('never lets a rolled-back journal reappear and revert a newer publication', async () => {
    if (!ffmpegAvailable) return;
    const baseline = await renderProject(projectDir, doc, {
      preview: true,
      subtitles: true,
      loudnorm: true,
    });
    expect(baseline.ok, baseline.ok ? '' : baseline.error.message).toBe(true);
    if (!baseline.ok) return;
    const newer = await publishedRenderState('preview');
    const jobDir = join(projectDir, 'edit', 'cache', 'render-jobs', 'rolled-back-publication');
    await mkdir(jobDir, { recursive: true });
    await Promise.all([
      writeFile(join(jobDir, 'previous-preview.mp4'), 'older-video'),
      writeFile(join(jobDir, 'previous-receipt-edit.json'), '{}\n'),
      writeFile(join(jobDir, 'previous-receipt-inputs.json'), '{}\n'),
    ]);
    await writeFile(
      join(jobDir, 'publication.json'),
      `${JSON.stringify({
        version: 1,
        artifactKind: 'preview',
        canonical: true,
        phase: 'rolled-back',
        previous: [true, true, true],
      })}\n`,
    );

    const recovered = await recoverRenderPublications(projectDir);
    expect(recovered.ok, recovered.ok ? '' : recovered.error.message).toBe(true);
    expect(await publishedRenderState('preview')).toEqual(newer);
    expect(await renderJobEntries()).toEqual([]);
  }, 120_000);

  it('quarantines backups when a durable publication journal is missing', async () => {
    if (!ffmpegAvailable) return;
    const jobDir = join(projectDir, 'edit', 'cache', 'render-jobs', 'ambiguous-publication');
    await mkdir(jobDir, { recursive: true });
    const backup = join(jobDir, 'previous-preview.mp4');
    await writeFile(backup, 'recoverable-old-video');

    const recovered = await recoverRenderPublications(projectDir);
    expect(recovered.ok).toBe(false);
    if (!recovered.ok) expect(recovered.error.message).toContain('recuperação manual');
    expect(await readFile(backup, 'utf8')).toBe('recoverable-old-video');

    await rm(jobDir, { recursive: true, force: true });
    expect(await renderJobEntries()).toEqual([]);
  });

  it.each([
    { flag: '--no-subtitles', subtitles: false, loudnorm: true },
    { flag: '--no-loudnorm', subtitles: true, loudnorm: false },
  ])(
    'renders with $flag but does not publish canonical preview freshness',
    async (options) => {
      if (!ffmpegAvailable) return;
      const withSubtitles: EditDoc = {
        ...doc,
        subtitles: { ...doc.subtitles, enabled: true },
      };
      const outcome = await renderProject(projectDir, withSubtitles, {
        preview: true,
        subtitles: options.subtitles,
        loudnorm: options.loudnorm,
      });
      expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.value.canonical).toBe(false);

      expect(await renderSnapshotHash(projectDir, 'preview')).toBeNull();
      await expect(
        readFile(join(projectDir, 'edit', 'cache', 'preview.edit.json'), 'utf8'),
      ).rejects.toHaveProperty('code', 'ENOENT');
      await expect(
        readFile(join(projectDir, 'edit', 'cache', 'preview.inputs.json'), 'utf8'),
      ).rejects.toHaveProperty('code', 'ENOENT');
    },
    120_000,
  );

  it('freezes preview freshness before the first await even if the caller mutates its object', async () => {
    if (!ffmpegAvailable) return;
    const mutable = structuredClone(doc);
    const captured = structuredClone(mutable);
    const pending = renderProject(projectDir, mutable, {
      preview: true,
      subtitles: true,
      loudnorm: true,
    });
    mutable.output.loudnormLufs = null;

    const outcome = await pending;
    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.editHash).toBe(editDocHash(captured));
    expect(outcome.value.editHash).not.toBe(editDocHash(mutable));
    const snapshot = JSON.parse(
      await readFile(join(projectDir, 'edit', 'cache', 'preview.edit.json'), 'utf8'),
    ) as unknown;
    expect(snapshot).toEqual(captured);
  }, 120_000);

  it('rejects immediate success when the authoring media is replaced during render', async () => {
    if (!ffmpegAvailable) return;
    const baseline = await renderProject(projectDir, doc, {
      preview: true,
      subtitles: true,
      loudnorm: true,
    });
    expect(baseline.ok, baseline.ok ? '' : baseline.error.message).toBe(true);
    if (!baseline.ok) return;
    const before = await publishedRenderState('preview');
    const beforeHash = await renderSnapshotHash(projectDir, 'preview');
    expect(beforeHash).not.toBeNull();

    const sourcePath = join(projectDir, SOURCE);
    const originalPath = join(projectDir, 'take-before-render-race.mp4');
    const replacementPath = join(projectDir, 'take-render-replacement.mp4');
    copyFileSync(sourcePath, replacementPath);
    let replaced = false;

    try {
      const outcome = await renderProject(
        projectDir,
        doc,
        { preview: true, subtitles: true, loudnorm: true },
        () => {
          if (replaced) return;
          renameSync(sourcePath, originalPath);
          renameSync(replacementPath, sourcePath);
          replaced = true;
        },
      );

      expect(replaced).toBe(true);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.code).toBe('io-failed');
        expect(outcome.error.message).toContain('mudou durante o render');
      }
      expect(await publishedRenderState('preview')).toEqual(before);
      expect(await renderJobEntries()).toEqual([]);
    } finally {
      if (existsSync(originalPath)) {
        rmSync(sourcePath, { force: true });
        renameSync(originalPath, sourcePath);
      }
      rmSync(replacementPath, { force: true });
      rmSync(originalPath, { force: true });
    }
    expect(await renderSnapshotHash(projectDir, 'preview')).toBe(beforeHash);
  }, 120_000);

  it('renders a PiP layer composed over the base line', async () => {
    if (!ffmpegAvailable) return;
    const runFfmpegSpy = vi.spyOn(ffmpegModule, 'runFfmpeg');
    const withLayer: EditDoc = {
      ...doc,
      tracks: [
        doc.tracks[0]!,
        {
          id: 'pip',
          kind: 'video',
          blocks: [
            {
              source: 'take',
              in: 0,
              out: 1,
              at: 1,
              mode: 'pip',
              position: 'top-right',
              scale: 0.4,
              audio: 'mute',
            },
          ],
        },
      ],
    };
    const outcome = await renderProject(projectDir, withLayer, {
      preview: true,
      subtitles: false,
      loudnorm: false,
    });
    expect(outcome.ok).toBe(true);
    const publishedCall = runFfmpegSpy.mock.calls.find(([args]) =>
      /^edit\/cache\/render-jobs\/[^/]+\/preview\.mp4$/u.test(args.at(-1) ?? ''),
    );
    expect(publishedCall).toBeDefined();
    expect(publishedCall![0].at(-1)).not.toBe('edit/preview.mp4');
  }, 120_000);

  it('burns an agent-defined gradient subtitle theme through the shared vector renderer', async () => {
    if (!ffmpegAvailable) return;
    const runFfmpegSpy = vi.spyOn(ffmpegModule, 'runFfmpeg');
    const themed: EditDoc = {
      ...doc,
      subtitles: {
        enabled: true,
        preset: 'pill',
        theme: {
          fontFamily: 'Helvetica',
          fill: { kind: 'solid', color: '#F4F1EC' },
          highlightFill: { kind: 'gradient', from: '#FF7A00', to: '#7C5CFF' },
          backgroundStyle: 'pill',
          backgroundColor: '#101010',
        },
      },
    };
    const outcome = await renderProject(projectDir, themed, {
      preview: true,
      subtitles: true,
      loudnorm: false,
    });
    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
    const composeCall = runFfmpegSpy.mock.calls.find(
      ([args]) => args.includes('-filter_complex') && args.some((arg) => arg.endsWith('.ffconcat')),
    );
    expect(composeCall).toBeDefined();
    const args = composeCall?.[0] ?? [];
    const manifestRel = args.find((arg) => arg.endsWith('/overlay.ffconcat'));
    expect(manifestRel).toBeDefined();
    const graph = args[args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).not.toContain('subtitles=');
    if (manifestRel === undefined) return;

    const manifest = await readFile(join(projectDir, manifestRel), 'utf8');
    const firstCueFile = /file '(cue-[a-f0-9]{20}\.png)'/u.exec(manifest)?.[1];
    expect(firstCueFile).toBeDefined();
    if (firstCueFile === undefined) return;
    const decoded = await execa(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        join(dirname(join(projectDir, manifestRel)), firstCueFile),
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        'pipe:1',
      ],
      { encoding: 'buffer' },
    );
    const rgba = Buffer.from(decoded.stdout);
    const contains = (red: number, green: number, blue: number): boolean => {
      for (let index = 0; index < rgba.length; index += 4) {
        if (
          Math.abs((rgba[index] ?? 0) - red) <= 2 &&
          Math.abs((rgba[index + 1] ?? 0) - green) <= 2 &&
          Math.abs((rgba[index + 2] ?? 0) - blue) <= 2 &&
          (rgba[index + 3] ?? 0) > 0
        ) {
          return true;
        }
      }
      return false;
    };
    expect(contains(0xff, 0x7a, 0x00)).toBe(true);
    expect(contains(0x7c, 0x5c, 0xff)).toBe(true);
  }, 120_000);

  it('reuses cached base segments across an unchanged re-render (no extraction re-run)', async () => {
    if (!ffmpegAvailable) return;
    const cacheOptions = { preview: false, subtitles: false, loudnorm: false };
    const segmentsDir = join(projectDir, 'edit', 'cache', 'segments');

    const t0 = Date.now();
    const first = await renderProject(projectDir, doc, cacheOptions);
    const firstMs = Date.now() - t0;
    expect(first.ok, first.ok ? '' : first.error.message).toBe(true);
    if (!first.ok) return;

    const before = await statSegments(segmentsDir);
    expect(before.size).toBeGreaterThanOrEqual(2); // doc has two base blocks

    const t1 = Date.now();
    const second = await renderProject(projectDir, doc, cacheOptions);
    const secondMs = Date.now() - t1;
    expect(second.ok, second.ok ? '' : second.error.message).toBe(true);
    if (!second.ok) return;

    // Same file set, same mtimes — proof the second render skipped extraction
    // entirely and only re-ran concat/remux against the cached segments.
    const after = await statSegments(segmentsDir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [name, mtimeMs] of before) {
      expect(after.get(name)).toBe(mtimeMs);
    }
    expect(second.value.expectedDurationS).toBeCloseTo(first.value.expectedDurationS, 5);

    // The cache hit must still ship a correct, playable output — not just a
    // plan that matches on paper.
    const probe = await probeMedia(second.value.outputAbs);
    expect(probe.ok).toBe(true);
    if (probe.ok) {
      expect(Math.abs(probe.value.durationS - second.value.expectedDurationS)).toBeLessThan(0.15);
      expect(probe.value.width).toBe(360);
      expect(probe.value.height).toBe(640);
      expect(probe.value.hasAudio).toBe(true);
    }

    console.log(
      `[render-cache] cold render ${String(firstMs)}ms, cached re-render ${String(secondMs)}ms ` +
        `(${String(before.size)} segments reused)`,
    );
  }, 120_000);

  it('re-extracts only the segment whose block changed', async () => {
    if (!ffmpegAvailable) return;
    const cacheOptions = { preview: false, subtitles: false, loudnorm: false };
    const segmentsDir = join(projectDir, 'edit', 'cache', 'segments');
    const before = await statSegments(segmentsDir);

    // Only block 0's window moves; block 1 is byte-for-byte the same request
    // as the previous test's render, so its segment must be reused.
    const changed: EditDoc = {
      ...doc,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'take', in: 0.6, out: 2.1 },
            { source: 'take', in: 3.5, out: 5.5 },
          ],
        },
      ],
    };

    const outcome = await renderProject(projectDir, changed, cacheOptions);
    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
    if (!outcome.ok) return;

    const after = await statSegments(segmentsDir);
    const newNames = [...after.keys()].filter((name) => !before.has(name));
    expect(newNames).toHaveLength(1);
    for (const [name, mtimeMs] of before) {
      expect(after.get(name)).toBe(mtimeMs);
    }

    // block 0 now 0.6–2.1 (38 frames = 1.52s) + block 1 unchanged (50 frames
    // = 2.00s) — same total as the original doc, but produced via one fresh
    // extraction plus one cache hit rather than two fresh extractions.
    const probe = await probeMedia(outcome.value.outputAbs);
    expect(probe.ok).toBe(true);
    if (probe.ok) {
      expect(Math.abs(probe.value.durationS - outcome.value.expectedDurationS)).toBeLessThan(0.15);
      expect(probe.value.width).toBe(360);
      expect(probe.value.height).toBe(640);
      expect(probe.value.hasAudio).toBe(true);
    }
  }, 120_000);

  // Appended last (preview render, no cache assertions) so it can't perturb the
  // segment-cache snapshots the two tests above depend on.
  it('renders flash and shake effects and proves both actually composited (not just plausible-looking filter strings)', async () => {
    if (!ffmpegAvailable) return;
    const withEffects: EditDoc = {
      ...doc,
      tracks: [
        ...doc.tracks,
        {
          id: 'effects',
          kind: 'effect',
          blocks: [
            { type: 'flash', at: 0.3, duration: 0.25 },
            { type: 'shake', at: 2.0, duration: 0.6, intensity: 10 },
          ],
        },
      ],
    };
    const renderOptions = { preview: true, subtitles: false, loudnorm: false };
    const withEffectsOutcome = await renderProject(projectDir, withEffects, renderOptions);
    expect(
      withEffectsOutcome.ok,
      withEffectsOutcome.ok ? '' : withEffectsOutcome.error.message,
    ).toBe(true);
    if (!withEffectsOutcome.ok) return;

    // Preview always writes to the same fixed path (edit/preview.mp4) — copy
    // this render's output aside BEFORE the second render overwrites it.
    const withEffectsPath = join(projectDir, 'edit', 'preview-with-effects.mp4');
    await copyFile(withEffectsOutcome.value.outputAbs, withEffectsPath);

    const plainOutcome = await renderProject(projectDir, doc, renderOptions);
    expect(plainOutcome.ok, plainOutcome.ok ? '' : plainOutcome.error.message).toBe(true);
    if (!plainOutcome.ok) return;

    const probe = await probeMedia(withEffectsPath);
    expect(probe.ok).toBe(true);
    if (probe.ok) {
      expect(probe.value.width).toBe(360);
      expect(probe.value.height).toBe(640);
    }

    // Flash: brightness at the window midpoint, compared at the SAME instant
    // between the effects render and the plain render (same source content,
    // same segments — the only difference is the flash overlay).
    const midFlashWith = await frameLuma(withEffectsPath, 0.425);
    const midFlashPlain = await frameLuma(plainOutcome.value.outputAbs, 0.425);
    expect(midFlashWith).toBeGreaterThan(midFlashPlain + 30);

    // Shake: a frame inside the window must differ between the two renders —
    // proof the jittered crop actually composited into the real pipeline,
    // not just a filter string that looks right in isolation.
    const shakeWith = await rawFrame(withEffectsPath, 2.2);
    const shakePlain = await rawFrame(plainOutcome.value.outputAbs, 2.2);
    expect(Buffer.compare(shakeWith, shakePlain)).not.toBe(0);
  }, 120_000);

  it('renders a real crossfade blend at the emenda and proves it actually blended (not a hard cut)', async () => {
    if (!ffmpegAvailable) return;
    // Dedicated two-tone source: 0–3s pure black (luma 16), 3–6s pure white
    // (luma 235). Constant lumas per side make the blend assertion below
    // discriminating — a hard cut can only ever produce one of the two pure
    // values at the boundary, never a value in between.
    const twoToneName = 'twotone.mp4';
    await execa('ffmpeg', [
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=black:s=640x360:r=25:d=3',
      '-f',
      'lavfi',
      '-i',
      'color=white:s=640x360:r=25:d=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=6',
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map',
      '[v]',
      '-map',
      '2:a',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      join(projectDir, twoToneName),
    ]);
    const withCrossfade: EditDoc = {
      ...doc,
      sources: { ...doc.sources, twotone: { path: twoToneName } },
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            // Block A ends at 2.0 (black; the 0.2s extension to 2.2 stays
            // black), block B starts at 3.5 (white; the extension back to 3.3
            // stays white) — each side keeps its pure luma through the blend.
            { source: 'twotone', in: 0.5, out: 2 },
            {
              source: 'twotone',
              in: 3.5,
              out: 5.5,
              transition: { type: 'crossfade', durationS: 0.4 },
            },
          ],
        },
      ],
    };
    const renderOptions = { preview: true, subtitles: false, loudnorm: false };
    const crossfadeOutcome = await renderProject(projectDir, withCrossfade, renderOptions);
    expect(crossfadeOutcome.ok, crossfadeOutcome.ok ? '' : crossfadeOutcome.error.message).toBe(
      true,
    );
    if (!crossfadeOutcome.ok) return;

    const crossfadePath = join(projectDir, 'edit', 'preview-crossfade.mp4');
    await copyFile(crossfadeOutcome.value.outputAbs, crossfadePath);

    // Duration invariant measured on the actual container, not compared
    // against a second render (which would be equal by construction).
    const probe = await probeMedia(crossfadePath);
    expect(probe.ok).toBe(true);
    if (probe.ok) {
      expect(
        Math.abs(probe.value.durationS - crossfadeOutcome.value.expectedDurationS),
      ).toBeLessThan(0.15);
    }

    // Block A quantizes to 1.52s of output; the 0.4s blend window is
    // [1.32, 1.72]. At its midpoint the luma must sit strictly between the
    // two pure tones — a hard cut yields ~16 or ~235 there, never mid-gray.
    const boundaryS = 1.52;
    const midLuma = await frameLuma(crossfadePath, boundaryS);
    expect(midLuma).toBeGreaterThan(60);
    expect(midLuma).toBeLessThan(200);
    // Just outside the window each side is still pure — the blend is local,
    // not a global wash.
    expect(await frameLuma(crossfadePath, boundaryS - 0.3)).toBeLessThan(60);
    expect(await frameLuma(crossfadePath, boundaryS + 0.3)).toBeGreaterThan(200);
  }, 120_000);

  it('confines a cell-mode layer to exactly its {x,y,w,h} window — proof by pixel, not average luma', async () => {
    if (!ffmpegAvailable) return;
    const whiteName = 'whitelayer.mp4';
    await generateWhiteClip(join(projectDir, whiteName));
    const withCell: EditDoc = {
      ...doc,
      sources: { ...doc.sources, whitelayer: { path: whiteName } },
      tracks: [
        doc.tracks[0]!,
        {
          id: 'cell-layer',
          kind: 'video',
          blocks: [
            {
              source: 'whitelayer',
              in: 0,
              out: 1,
              at: 1,
              mode: 'cell',
              cell: { x: 0.5, y: 0, w: 0.5, h: 0.5 },
              audio: 'mute',
            },
          ],
        },
      ],
    };
    const outcome = await renderProject(projectDir, withCell, {
      preview: true,
      subtitles: false,
      loudnorm: false,
    });
    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
    if (!outcome.ok) return;

    // output is 360x640; cell {x:0.5,y:0,w:0.5,h:0.5} -> window x∈[180,360), y∈[0,320)
    const frame = await rawFrame(outcome.value.outputAbs, 1.5);
    const inside = pixelAt(frame, 270, 160, 360);
    const outside = pixelAt(frame, 90, 480, 360);
    expect(isWhitish(inside)).toBe(true);
    expect(isWhitish(outside)).toBe(false);
  }, 120_000);

  it('renders with denoise enabled (afftdn ahead of loudnorm) and preserves exact duration', async () => {
    if (!ffmpegAvailable) return;
    const withDenoise: EditDoc = { ...doc, output: { ...doc.output, denoise: 0.6 } };
    const outcome = await renderProject(projectDir, withDenoise, {
      preview: true,
      subtitles: false,
      loudnorm: true,
    });
    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.expectedDurationS).toBeCloseTo(3.52, 5);
    const probe = await probeMedia(outcome.value.outputAbs);
    expect(probe.ok).toBe(true);
    if (probe.ok) {
      expect(Math.abs(probe.value.durationS - outcome.value.expectedDurationS)).toBeLessThan(0.15);
      expect(probe.value.hasAudio).toBe(true);
    }
  }, 120_000);

  it('denoise + a numeric loudnormLufs actually measures the real noise floor — the afftdn nf is not the −50dBFS fallback', async () => {
    if (!ffmpegAvailable) return;
    // This block's [1.5, 3.5) window covers the clip's engineered silence
    // (2.0-3.2s), so render.ts's measurement — when it actually runs — must
    // land on the clip's real measured floor, independently recomputed
    // below via the exact same primitives render.ts uses, never at the
    // shared -50dBFS fallback. If render.ts's gate ever stops calling the
    // measurement (e.g. reverts to a hand-duplicated condition that drifts
    // from planRender's), noiseFloorDb silently becomes undefined and nf
    // falls back to -50.0 — this assertion is what catches that.
    const usedWindows = [{ start: 1.5, end: 3.5 }];
    const denoiseDoc: EditDoc = {
      ...doc,
      tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'take', in: 1.5, out: 3.5 }] }],
      output: { ...doc.output, denoise: 0.6 },
    };

    const pcm = await loadPcm(join(projectDir, SOURCE));
    expect(pcm.ok).toBe(true);
    if (!pcm.ok) return;
    const scopedSilences = intersectIntervals(
      detectSilences(pcm.value, PCM_SAMPLE_RATE),
      usedWindows,
    );
    const expectedFloorDb = noiseFloorDbFromSamples(pcm.value, PCM_SAMPLE_RATE, scopedSilences);
    expect(expectedFloorDb).not.toBeCloseTo(-50, 0); // sanity: this fixture actually has usable silence

    const runFfmpegSpy = vi.spyOn(ffmpegModule, 'runFfmpeg');
    const outcome = await renderProject(projectDir, denoiseDoc, {
      preview: true,
      subtitles: false,
      loudnorm: true,
    });
    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);

    const measureCall = runFfmpegSpy.mock.calls.find(([args]) =>
      args.some((a) => a.includes('afftdn')),
    );
    expect(measureCall).toBeDefined();
    const af = measureCall![0][measureCall![0].indexOf('-af') + 1] ?? '';
    const nfMatch = /afftdn=nf=(-?[\d.]+):/.exec(af);
    expect(nfMatch).toBeDefined();
    const nf = Number(nfMatch![1]);
    expect(nf).not.toBeCloseTo(-50, 0);
    expect(nf).toBeCloseTo(expectedFloorDb, 1);
  }, 120_000);

  it('learns and applies a 15-band spectral profile from exactly the selected room-tone sample', async () => {
    if (!ffmpegAvailable) return;
    const manualDoc: EditDoc = {
      ...doc,
      output: {
        ...doc.output,
        loudnormLufs: null,
        denoise: 0.6,
        denoiseSample: { source: 'take', start: 2.1, end: 2.9 },
      },
    };
    const runFfmpegSpy = vi.spyOn(ffmpegModule, 'runFfmpeg');
    const outcome = await renderProject(projectDir, manualDoc, {
      preview: true,
      subtitles: false,
      loudnorm: true,
    });
    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
    if (!outcome.ok) return;

    const samplingCall = runFfmpegSpy.mock.calls.find(([args]) =>
      args.some((arg) => arg.includes('asendcmd') && arg.includes('afftdn sn start')),
    );
    expect(samplingCall).toBeDefined();
    expect(samplingCall![0]).toContain('2.100000');
    expect(samplingCall![0].some((arg) => arg.includes('0.800000'))).toBe(true);

    const applyCall = runFfmpegSpy.mock.calls.find(([args]) =>
      args.some((arg) => arg.startsWith('afftdn=') && arg.includes(':nt=c:bn=')),
    );
    expect(applyCall).toBeDefined();
    const filter = applyCall![0][applyCall![0].indexOf('-af') + 1] ?? '';
    const profile = /:bn='([^']+)'/.exec(filter)?.[1]?.trim().split(/\s+/).map(Number);
    expect(profile).toHaveLength(15);
    expect(profile?.every(Number.isFinite)).toBe(true);

    const probe = await probeMedia(outcome.value.outputAbs);
    expect(probe.ok).toBe(true);
    if (probe.ok) expect(probe.value.hasAudio).toBe(true);
  }, 120_000);

  it('doc with loudnormLufs: null still measures and applies denoise without a loudnorm pass', async () => {
    if (!ffmpegAvailable) return;
    const offDoc: EditDoc = {
      ...doc,
      tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'take', in: 1.5, out: 3.5 }] }],
      output: { ...doc.output, denoise: 0.6, loudnormLufs: null },
    };
    const loadPcmSpy = vi.spyOn(audioModule, 'loadPcm');
    const runFfmpegSpy = vi.spyOn(ffmpegModule, 'runFfmpeg');
    const outcome = await renderProject(projectDir, offDoc, {
      preview: true,
      subtitles: false,
      loudnorm: true,
    });
    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
    expect(loadPcmSpy).toHaveBeenCalledTimes(1);
    const denoiseCall = runFfmpegSpy.mock.calls.find(([args]) =>
      args.some((arg) => arg.startsWith('afftdn=')),
    );
    expect(denoiseCall).toBeDefined();
    expect(denoiseCall![0].some((arg) => arg.includes('loudnorm='))).toBe(false);
    expect(denoiseCall![0].at(-1)).toMatch(/^edit\/cache\/render-jobs\/[^/]+\/preview\.mp4$/u);
    expect(denoiseCall![0].at(-1)).not.toBe('edit/preview.mp4');
  }, 120_000);

  it('renders with denoise enabled on an audio-less base source instead of hard-failing the measurement', async () => {
    if (!ffmpegAvailable) return;
    const runFfmpegSpy = vi.spyOn(ffmpegModule, 'runFfmpeg');
    const silentName = 'no-audio-take.mp4';
    await execa('ffmpeg', [
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=duration=6:size=640x360:rate=25',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      join(projectDir, silentName),
    ]);
    const noAudioDoc: EditDoc = {
      ...doc,
      sources: { take: { path: silentName } },
      output: { ...doc.output, denoise: 0.5 },
    };
    const outcome = await renderProject(projectDir, noAudioDoc, {
      preview: true,
      subtitles: false,
      loudnorm: true,
    });
    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
    const silentFallbackCall = runFfmpegSpy.mock.calls.find(
      ([args]) =>
        args.includes('edit/cache/composed.mov') &&
        /^edit\/cache\/render-jobs\/[^/]+\/preview\.mp4$/u.test(args.at(-1) ?? '') &&
        !args.includes('-af'),
    );
    expect(silentFallbackCall).toBeDefined();
    const fallbackArgs = silentFallbackCall?.[0] ?? [];
    const stagedOutput = fallbackArgs.at(-1) ?? '';
    expect(stagedOutput).toMatch(/^edit\/cache\/render-jobs\/[^/]+\/preview\.mp4$/u);
    expect(stagedOutput).not.toBe('edit/preview.mp4');
    expect(fallbackArgs.slice(-13)).toEqual([
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      stagedOutput,
    ]);
  }, 120_000);

  it('renders successfully with a hidden overlay track pointing at a file that does not exist', async () => {
    if (!ffmpegAvailable) return;
    // No explicit `duration` and not an image extension — probeProjectMedia
    // would try to ffprobe this file if the hidden track weren't filtered
    // out before probing runs, and ffprobe on a missing file fails hard.
    const withHiddenOverlay: EditDoc = {
      ...doc,
      tracks: [
        doc.tracks[0]!,
        {
          id: 'ghost-overlay',
          kind: 'overlay',
          hidden: true,
          blocks: [{ file: 'edit/assets/does-not-exist.webm', at: 1 }],
        },
      ],
    };
    const outcome = await renderProject(projectDir, withHiddenOverlay, {
      preview: true,
      subtitles: false,
      loudnorm: false,
    });
    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
  }, 120_000);

  it("renders a 2x block at roughly half the trecho's duration", async () => {
    if (!ffmpegAvailable) return;
    // 2.0s of source (0.5-2.5, entirely inside the pre-silence tone) at 2x -> ~1.0s of output.
    const sped: EditDoc = {
      ...doc,
      tracks: [
        { id: 'base', kind: 'video', blocks: [{ source: 'take', in: 0.5, out: 2.5, speed: 2 }] },
      ],
    };
    const outcome = await renderProject(projectDir, sped, {
      preview: true,
      subtitles: false,
      loudnorm: false,
    });
    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.expectedDurationS).toBeCloseTo(1.0, 5);
    const probe = await probeMedia(outcome.value.outputAbs);
    expect(probe.ok).toBe(true);
    if (probe.ok) {
      expect(Math.abs(probe.value.durationS - 1.0)).toBeLessThan(0.15);
    }
  }, 120_000);

  it('renders with a global output.speed of 1.25, shrinking duration by that factor with subtitles still burned', async () => {
    if (!ffmpegAvailable) return;
    const sped: EditDoc = {
      ...doc,
      output: { ...doc.output, speed: 1.25 },
      subtitles: { enabled: true, preset: '2p-caps' },
    };
    const outcome = await renderProject(projectDir, sped, {
      preview: true,
      subtitles: true,
      loudnorm: false,
    });
    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
    if (!outcome.ok) return;

    // natural duration is 3.52s (see the earlier "final cut" test) -> /1.25 =
    // 2.816s, requantized to the 25fps grid (0.04s steps): 70.4 frames rounds
    // down to 70 = 2.80s.
    expect(outcome.value.expectedDurationS).toBeCloseTo(2.8, 5);
    const probe = await probeMedia(outcome.value.outputAbs);
    expect(probe.ok).toBe(true);
    if (probe.ok) {
      expect(Math.abs(probe.value.durationS - outcome.value.expectedDurationS)).toBeLessThan(0.15);
      expect(probe.value.hasAudio).toBe(true);
    }
    const srt = await readFile(join(projectDir, 'edit', 'subtitles', 'master.srt'), 'utf8');
    expect(srt.trim().length).toBeGreaterThan(0);
  }, 120_000);

  it('crossfades audio at the join (joinAudioCrossfadeMs 60) — exact duration, and no silence dip at the emenda unlike the declick-only render', async () => {
    if (!ffmpegAvailable) return;
    // Both blocks sit entirely inside the SECOND tone region (3.2-6s) of the
    // synthetic clip, well clear of the engineered 2.0-3.2s silence — so any
    // dip measured at the emenda can only come from the join treatment
    // itself, not from source content that happens to be quiet there.
    const twoBlocks: EditDoc = {
      ...doc,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'take', in: 3.3, out: 4.3 }, // 1.0s, exact frame count — emenda lands at output 1.0s
            { source: 'take', in: 4.5, out: 5.5 },
          ],
        },
      ],
    };
    const renderOptions = { preview: true, subtitles: false, loudnorm: false };

    const declick = await renderProject(projectDir, twoBlocks, renderOptions);
    expect(declick.ok, declick.ok ? '' : declick.error.message).toBe(true);
    if (!declick.ok) return;
    const declickPath = join(projectDir, 'edit', 'preview-declick.mp4');
    await copyFile(declick.value.outputAbs, declickPath);

    const crossfadeDoc: EditDoc = {
      ...twoBlocks,
      output: { ...twoBlocks.output, joinAudioCrossfadeMs: 60 },
    };
    const crossfade = await renderProject(projectDir, crossfadeDoc, renderOptions);
    expect(crossfade.ok, crossfade.ok ? '' : crossfade.error.message).toBe(true);
    if (!crossfade.ok) return;
    const crossfadePath = join(projectDir, 'edit', 'preview-crossfade-audio.mp4');
    await copyFile(crossfade.value.outputAbs, crossfadePath);

    // Duration is unaffected by the audio-only feature.
    expect(crossfade.value.expectedDurationS).toBeCloseTo(declick.value.expectedDurationS, 5);
    const probe = await probeMedia(crossfadePath);
    expect(probe.ok).toBe(true);
    if (probe.ok) {
      expect(Math.abs(probe.value.durationS - crossfade.value.expectedDurationS)).toBeLessThan(
        0.15,
      );
    }

    // A 20ms window straddling the emenda (output 1.0s): the declick render
    // has two independent 30ms fades meeting back-to-back with nothing to
    // fill the gap, so it measurably dips; the crossfade overlaps the two
    // sides' audio instead, so the window stays close to full tone volume.
    const declickWindowDb = await meanVolumeDb(declickPath, 0.99, 1.01);
    const crossfadeWindowDb = await meanVolumeDb(crossfadePath, 0.99, 1.01);
    expect(crossfadeWindowDb).toBeGreaterThan(declickWindowDb + 6);
  }, 120_000);
});
