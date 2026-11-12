import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from '../../core/result.js';
import { probeMedia, runFfmpeg } from './ffmpeg.js';
import { loadEditDoc } from './project.js';

const OPENING_SAMPLE_S = 1.0;
const CLOSING_MARGIN_S = 1.0;
const DEDUPE_TOLERANCE_S = 0.2;
const MAX_AUTO_FRAMES = 12;
// ffmpeg's `-ss <exact end timestamp>` seeks past the last decodable frame and
// exits 0 without writing a file — pull every requested time back from the edge.
const END_SEEK_MARGIN_S = 0.05;

interface ExtractedFrame {
  readonly timeS: number;
  readonly relPath: string;
}

export interface ExtractFramesOptions {
  readonly times?: readonly number[];
  readonly source?: 'preview' | 'final';
}

export interface ExtractFramesResult {
  readonly frames: readonly ExtractedFrame[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function maxSafeTimeS(durationS: number): number {
  return Math.max(0, durationS - END_SEEK_MARGIN_S);
}

function frameFileName(timeS: number): string {
  return `frame-${timeS.toFixed(2).replace('.', 'p')}.png`;
}

async function isNonEmptyFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.size > 0;
  } catch {
    return false;
  }
}

/** Ascending, unique by exact value — preserves whatever the caller asked for. */
function dedupeExact(times: readonly number[]): number[] {
  return [...new Set(times)].sort((a, b) => a - b);
}

/** Ascending, merging any point within DEDUPE_TOLERANCE_S of the previous kept one. */
function dedupeByTolerance(times: readonly number[]): number[] {
  const sorted = [...times].sort((a, b) => a - b);
  const kept: number[] = [];
  for (const t of sorted) {
    const last = kept.at(-1);
    if (last === undefined || t - last >= DEDUPE_TOLERANCE_S) kept.push(t);
  }
  return kept;
}

/** Evenly spaced picks across a sorted array — spreads a forced cut across the
 * whole timeline instead of always truncating the tail. */
function uniformSample(values: readonly number[], count: number): number[] {
  if (count <= 0 || values.length === 0) return [];
  if (values.length <= count) return [...values];

  const indices = new Set<number>();
  if (count === 1) {
    indices.add(Math.floor((values.length - 1) / 2));
  } else {
    const step = (values.length - 1) / (count - 1);
    for (let i = 0; i < count; i++) indices.add(Math.round(i * step));
  }

  const sampled: number[] = [];
  for (const index of [...indices].sort((a, b) => a - b)) {
    const value = values[index];
    if (value !== undefined) sampled.push(value);
  }
  return sampled;
}

/**
 * Key-moment heuristic: the midpoint of every overlay/effect block (where the
 * agent most needs to check composition) plus one opening and one closing
 * sample so trims at the edges are covered too. Opening and closing are
 * reserved outside the MAX_AUTO_FRAMES cap — only the block midpoints are
 * thinned when there are too many.
 */
async function autoTimes(projectDir: string, durationS: number): Promise<number[]> {
  const safeMax = maxSafeTimeS(durationS);
  const opening = clamp(OPENING_SAMPLE_S, 0, safeMax);
  const closing = clamp(durationS - CLOSING_MARGIN_S, 0, safeMax);

  const midpointCandidates: number[] = [];
  const loaded = await loadEditDoc(projectDir);
  if (loaded.ok) {
    for (const track of loaded.value.doc.tracks) {
      if (track.kind === 'overlay') {
        for (const block of track.blocks) {
          midpointCandidates.push(block.at + (block.duration ?? 0) / 2);
        }
      } else if (track.kind === 'effect') {
        for (const block of track.blocks) {
          midpointCandidates.push(block.at + block.duration / 2);
        }
      }
    }
  }
  const midpoints = dedupeByTolerance(midpointCandidates.map((t) => clamp(t, 0, safeMax)));

  const maxMidpoints = Math.max(0, MAX_AUTO_FRAMES - 2);
  const sampledMidpoints =
    midpoints.length <= maxMidpoints ? midpoints : uniformSample(midpoints, maxMidpoints);

  if (sampledMidpoints.length < midpoints.length) {
    const kept = new Set(sampledMidpoints);
    const discarded = midpoints.filter((t) => !kept.has(t));
    console.warn(
      `studio frames: ${String(discarded.length)} frame(s) discarded (cap of ${String(MAX_AUTO_FRAMES)}, opening/closing reserved): ` +
        `${discarded.map((t) => t.toFixed(2)).join(', ')}s`,
    );
  }

  return dedupeByTolerance([opening, closing, ...sampledMidpoints]);
}

/**
 * Extracts PNG frames from the rendered preview (or final) so an agent can
 * visually confirm positioning — overlay over a face, title outside the safe
 * zone, an element sitting on top of the subtitle — without a human watching.
 */
export async function extractFrames(
  projectDir: string,
  options: ExtractFramesOptions = {},
): Promise<Result<ExtractFramesResult>> {
  const source = options.source ?? 'preview';
  const fileName = source === 'final' ? 'final.mp4' : 'preview.mp4';
  const videoRel = `edit/${fileName}`;
  const probed = await probeMedia(join(projectDir, 'edit', fileName));
  if (!probed.ok) {
    return err(
      'not-found',
      `${videoRel} does not exist — render first: pnpm studio render <folder> --preview`,
    );
  }
  const durationS = probed.value.durationS;

  const times =
    options.times && options.times.length > 0
      ? dedupeExact(options.times.map((t) => clamp(t, 0, maxSafeTimeS(durationS))))
      : await autoTimes(projectDir, durationS);

  const framesDir = join(projectDir, 'edit', 'qa', 'frames');
  try {
    await rm(framesDir, { recursive: true, force: true });
    await mkdir(framesDir, { recursive: true });
  } catch (cause) {
    return err('io-failed', `cannot recreate "${framesDir}"`, cause);
  }

  const frames: ExtractedFrame[] = [];
  const usedFrameNames = new Set<string>();
  for (const timeS of times) {
    const frameName = frameFileName(timeS);
    // Two explicit times close enough to round to the same 2-decimal name
    // would otherwise silently overwrite each other's PNG.
    if (usedFrameNames.has(frameName)) {
      console.warn(
        `studio frames: ${timeS.toFixed(3)}s rounds to "${frameName}", already used — skipping`,
      );
      continue;
    }
    usedFrameNames.add(frameName);
    const relPath = `edit/qa/frames/${frameName}`;
    const run = await runFfmpeg(
      ['-y', '-ss', timeS.toFixed(3), '-i', videoRel, '-frames:v', '1', relPath],
      { cwd: projectDir },
    );
    if (!run.ok) return run;

    // ffmpeg can exit 0 without writing a frame (seek landed past the last
    // decodable one) — never report a path the agent can't actually read.
    if (!(await isNonEmptyFile(join(projectDir, relPath)))) {
      console.warn(
        `studio frames: ffmpeg did not write "${relPath}" (${timeS.toFixed(3)}s) — skipping`,
      );
      continue;
    }
    frames.push({ timeS, relPath });
  }

  return ok({ frames });
}
