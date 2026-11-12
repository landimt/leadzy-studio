import {
  baseTrackOf,
  isLayerBlock,
  type EditDoc,
  type Suggestion,
  type VideoBlock,
  type VideoTrack,
} from './schema.js';
import type { TranscriptWord } from './transcript.js';
import type { SilenceInterval } from './silence.js';

/** Never cut inside a word: kept content keeps this much air around it. */
const DEFAULT_PAD_BEFORE_S = 0.05;
const DEFAULT_PAD_AFTER_S = 0.08;

export interface CutPadding {
  readonly beforeS: number;
  readonly afterS: number;
}

export const DEFAULT_PADDING: CutPadding = {
  beforeS: DEFAULT_PAD_BEFORE_S,
  afterS: DEFAULT_PAD_AFTER_S,
};

/** Shortest allowed overlay/effect block: below this it is impossible to grab. */
export const MIN_TIMED_BLOCK_S = 0.2;

const round2 = (t: number): number => Math.round(t * 100) / 100;

// --- Output timeline mapping -------------------------------------------------

export interface OutputSegment {
  readonly blockIndex: number;
  readonly source: string;
  readonly in: number;
  readonly out: number;
  readonly outputStart: number;
  readonly outputEnd: number;
  /** Block playback speed (1 = natural) — output plays this source window `speed`× faster. */
  readonly speed: number;
}

export interface SourceOutputRange {
  readonly at: number;
  readonly durationS: number;
}

/**
 * Suggestions below this output-time duration are editing residue: they are
 * shorter than the silence review's own edge floor and barely span a few
 * frames at normal project rates.
 */
export const MIN_ACTIONABLE_CUT_DURATION_S = 0.1;

/**
 * The base track's blocks concatenated: they define the output timeline.
 * Durations are quantized to the frame grid — the render can only emit whole
 * frames, and SRT offsets/QA must match what actually ships, not the float.
 * A block's `speed` compresses (>1) or stretches (<1) its source window into
 * a shorter/longer span of output time.
 */
export function outputSegments(doc: EditDoc): OutputSegment[] {
  const base = baseTrackOf(doc);
  const segments: OutputSegment[] = [];
  let cursor = 0;
  base.blocks.forEach((block, blockIndex) => {
    const speed = block.speed ?? 1;
    const duration = Math.round(((block.out - block.in) / speed) * doc.fps) / doc.fps;
    segments.push({
      blockIndex,
      source: block.source,
      in: block.in,
      out: block.out,
      outputStart: cursor,
      outputEnd: cursor + duration,
      speed,
    });
    cursor += duration;
  });
  return segments;
}

/** Maps a SOURCE time inside this segment's window to the OUTPUT clock, honoring its speed. */
export function segmentOutputTime(segment: OutputSegment, sourceTime: number): number {
  return segment.outputStart + (sourceTime - segment.in) / segment.speed;
}

/** Every visible fragment of one source-time interval in the current montage. */
export function sourceIntervalOutputRanges(
  doc: EditDoc,
  source: string,
  start: number,
  end: number,
): SourceOutputRange[] {
  const ranges: SourceOutputRange[] = [];
  for (const segment of outputSegments(doc)) {
    if (segment.source !== source || end <= segment.in || start >= segment.out) continue;
    const sourceStart = Math.max(start, segment.in);
    const sourceEnd = Math.min(end, segment.out);
    const at = Math.max(segment.outputStart, segmentOutputTime(segment, sourceStart));
    const outputEnd = Math.min(segment.outputEnd, segmentOutputTime(segment, sourceEnd));
    const durationS = Math.max(0, outputEnd - at);
    if (durationS > 0) ranges.push({ at, durationS });
  }
  return ranges;
}

/** Visible fragments only when their combined edit would be meaningful. */
export function actionableSourceIntervalOutputRanges(
  doc: EditDoc,
  source: string,
  start: number,
  end: number,
  minDurationS = MIN_ACTIONABLE_CUT_DURATION_S,
): SourceOutputRange[] {
  const ranges = sourceIntervalOutputRanges(doc, source, start, end);
  const totalDurationS = ranges.reduce((sum, range) => sum + range.durationS, 0);
  return totalDurationS + 1e-9 >= minDurationS ? ranges : [];
}

export function outputDuration(doc: EditDoc): number {
  const segments = outputSegments(doc);
  const last = segments[segments.length - 1];
  return last === undefined ? 0 : last.outputEnd;
}

export interface SourcePoint {
  readonly source: string;
  readonly time: number;
  readonly blockIndex: number;
}

export function sourceTimeAt(doc: EditDoc, outputTime: number): SourcePoint | null {
  for (const segment of outputSegments(doc)) {
    if (outputTime >= segment.outputStart && outputTime < segment.outputEnd) {
      return {
        source: segment.source,
        time: segment.in + (outputTime - segment.outputStart) * segment.speed,
        blockIndex: segment.blockIndex,
      };
    }
  }
  return null;
}

/** First output time at which the given source moment is shown by the base track. */
export function outputTimeOf(doc: EditDoc, source: string, sourceTime: number): number | null {
  for (const segment of outputSegments(doc)) {
    if (segment.source === source && sourceTime >= segment.in && sourceTime < segment.out) {
      return segmentOutputTime(segment, sourceTime);
    }
  }
  return null;
}

// --- Word state (transcript panel) -------------------------------------------

export type WordState = 'kept' | 'cut';

export function wordStates(
  blocks: readonly VideoBlock[],
  source: string,
  words: readonly TranscriptWord[],
): WordState[] {
  const intervals = blocks.filter((b) => b.source === source).map((b) => [b.in, b.out] as const);
  return words.map((word) => {
    const mid = (word.start + word.end) / 2;
    return intervals.some(([start, end]) => mid >= start && mid < end) ? 'kept' : 'cut';
  });
}

// --- Interval cut / restore (the editing primitives) --------------------------

function shiftedLayerStart(block: VideoBlock, newIn: number): Partial<VideoBlock> {
  if (!isLayerBlock(block)) return {};
  return { at: round2(block.at + (newIn - block.in)) };
}

/**
 * Remove [cutStart, cutEnd] (source time) from every block of `source`.
 * Boundaries are taken as-is — callers apply word padding before calling.
 */
export function cutInterval(
  blocks: readonly VideoBlock[],
  source: string,
  cutStart: number,
  cutEnd: number,
): VideoBlock[] {
  const result: VideoBlock[] = [];
  for (const block of blocks) {
    if (block.source !== source || cutEnd <= block.in || cutStart >= block.out) {
      result.push(block);
      continue;
    }
    // slivers shorter than 50ms are editing noise and break validation
    const keepsLeft = cutStart - block.in >= 0.05;
    const keepsRight = block.out - cutEnd >= 0.05;
    if (keepsLeft) {
      result.push({ ...block, out: round2(cutStart) });
    }
    if (keepsRight) {
      result.push({
        ...block,
        in: round2(cutEnd),
        ...(keepsLeft ? shiftedLayerStart(block, cutStart) : {}),
      });
    }
  }
  return result;
}

/**
 * Bring [start, end] (source time) back into the block list. Overlapping or
 * touching intervals merge; silence that was never part of the restored range
 * stays cut.
 */
export function restoreInterval(
  blocks: readonly VideoBlock[],
  source: string,
  start: number,
  end: number,
): VideoBlock[] {
  const others = blocks.filter((b) => b.source !== source || isLayerBlock(b));
  const own = blocks.filter((b) => b.source === source && !isLayerBlock(b));
  interface Interval {
    in: number;
    out: number;
    block: VideoBlock | null;
  }
  const intervals: Interval[] = own
    .map((b): Interval => ({ in: b.in, out: b.out, block: b }))
    .concat([{ in: round2(start), out: round2(end), block: null }])
    .sort((a, b) => a.in - b.in);

  const merged: { in: number; out: number; block: VideoBlock | null }[] = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval.in <= last.out + 0.001) {
      last.out = Math.max(last.out, interval.out);
      last.block ??= interval.block;
    } else {
      merged.push({ ...interval });
    }
  }

  const restored: VideoBlock[] = merged.map((interval) => {
    const template = interval.block ?? { source, in: interval.in, out: interval.out };
    return { ...template, source, in: round2(interval.in), out: round2(interval.out) };
  });
  return [...others, ...restored].sort((a, b) => a.in - b.in);
}

// --- Word-level strike / restore ----------------------------------------------

export interface WordRange {
  readonly startIndex: number;
  readonly endIndex: number;
}

function strikeBoundaries(
  words: readonly TranscriptWord[],
  range: WordRange,
  padding: CutPadding,
): { cutStart: number; cutEnd: number } | null {
  const first = words[range.startIndex];
  const last = words[range.endIndex];
  if (!first || !last) return null;
  const previous = words[range.startIndex - 1];
  const next = words[range.endIndex + 1];
  const cutStart = previous ? Math.min(previous.end + padding.afterS, first.start) : 0;
  const cutEnd = next ? Math.max(next.start - padding.beforeS, last.end) : Number.POSITIVE_INFINITY;
  return { cutStart, cutEnd };
}

/**
 * Strike words [startIndex..endIndex] of `source` (indexes into the spoken-word
 * list): the cut lands between neighbouring kept words, never inside a word.
 */
export function strikeWordRange(
  blocks: readonly VideoBlock[],
  source: string,
  words: readonly TranscriptWord[],
  range: WordRange,
  padding: CutPadding = DEFAULT_PADDING,
): VideoBlock[] {
  const boundaries = strikeBoundaries(words, range, padding);
  if (!boundaries) return [...blocks];
  return cutInterval(blocks, source, boundaries.cutStart, boundaries.cutEnd);
}

/**
 * Restore is the exact inverse of strike: it brings back the same interval a
 * strike of this range would have cut (up to the neighbouring words), so
 * strike → restore always reassembles the original block.
 */
export function restoreWordRange(
  blocks: readonly VideoBlock[],
  source: string,
  words: readonly TranscriptWord[],
  range: WordRange,
  padding: CutPadding = DEFAULT_PADDING,
): VideoBlock[] {
  const first = words[range.startIndex];
  const last = words[range.endIndex];
  if (!first || !last) return [...blocks];
  const boundaries = strikeBoundaries(words, range, padding);
  if (!boundaries) return [...blocks];
  const hasPrevious = range.startIndex > 0;
  const hasNext = range.endIndex < words.length - 1;
  const start = hasPrevious ? boundaries.cutStart : first.start - padding.beforeS;
  const end = hasNext ? boundaries.cutEnd : last.end + padding.afterS;
  return restoreInterval(blocks, source, start, end);
}

// --- Split --------------------------------------------------------------------

export function splitBlockAt(
  blocks: readonly VideoBlock[],
  blockIndex: number,
  sourceTime: number,
): VideoBlock[] {
  const block = blocks[blockIndex];
  if (!block || sourceTime <= block.in || sourceTime >= block.out) return [...blocks];
  const left: VideoBlock = { ...block, out: round2(sourceTime) };
  const right: VideoBlock = {
    ...block,
    in: round2(sourceTime),
    ...shiftedLayerStart(block, sourceTime),
  };
  return [...blocks.slice(0, blockIndex), left, right, ...blocks.slice(blockIndex + 1)];
}

// --- Reorder ------------------------------------------------------------------

/**
 * Drop a base block at a new output position. The neighbours do not move while
 * dragging, so the hop rule follows the static picture: moving right, the
 * block's trailing edge must cross a neighbour's midpoint; moving left, its
 * leading edge must.
 */
export function reorderBlockByDrop(
  blocks: readonly VideoBlock[],
  fromIndex: number,
  dropOutputStart: number,
): VideoBlock[] {
  const moved = blocks[fromIndex];
  if (!moved) return [...blocks];
  let cursor = 0;
  const midpoints = blocks.map((block) => {
    const length = (block.out - block.in) / (block.speed ?? 1);
    const start = cursor;
    cursor += length;
    return start + length / 2;
  });
  const movedLength = (moved.out - moved.in) / (moved.speed ?? 1);
  const origin = (midpoints[fromIndex] ?? 0) - movedLength / 2;
  const drop = Math.max(0, dropOutputStart);
  if (drop === origin) return [...blocks];
  const others = blocks.filter((_, i) => i !== fromIndex);
  const otherMidpoints = midpoints.filter((_, i) => i !== fromIndex);
  const insertIndex =
    drop > origin
      ? otherMidpoints.filter((midpoint) => midpoint <= drop + movedLength).length
      : otherMidpoints.filter((midpoint) => midpoint < drop).length;
  return [...others.slice(0, insertIndex), moved, ...others.slice(insertIndex)];
}

// --- Snap ---------------------------------------------------------------------

export type BlockEdge = 'in' | 'out';

export interface SnapResult {
  readonly time: number;
  readonly snapped: boolean;
  readonly word?: TranscriptWord;
}

/**
 * Snap a block edge to the nearest word boundary (padded so the cut lands in
 * the air around the word, not inside it). Falls back to silence boundaries
 * when no transcript exists.
 */
export function snapEdge(
  time: number,
  edge: BlockEdge,
  words: readonly TranscriptWord[],
  silences: readonly SilenceInterval[],
  thresholdS = 0.25,
  padding: CutPadding = DEFAULT_PADDING,
): SnapResult {
  let best: SnapResult = { time, snapped: false };
  let bestDistance = thresholdS;

  for (const word of words) {
    const candidate = edge === 'in' ? word.start - padding.beforeS : word.end + padding.afterS;
    const distance = Math.abs(candidate - time);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { time: round2(candidate), snapped: true, word };
    }
  }
  if (!best.snapped) {
    for (const silence of silences) {
      const candidate =
        edge === 'in' ? silence.end - padding.beforeS : silence.start + padding.afterS;
      const distance = Math.abs(candidate - time);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { time: round2(candidate), snapped: true };
      }
    }
  }
  return best;
}

// --- Suggestions --------------------------------------------------------------

export function applySuggestion(doc: EditDoc, suggestionId: string): EditDoc {
  const suggestion = doc.suggestions?.find((s) => s.id === suggestionId);
  if (!suggestion) return doc;
  const base = baseTrackOf(doc);
  const newBase: VideoTrack = {
    ...base,
    blocks: cutInterval(base.blocks, suggestion.source, suggestion.start, suggestion.end),
  };
  return {
    ...doc,
    tracks: [newBase, ...doc.tracks.slice(1)],
    suggestions: (doc.suggestions ?? []).filter((s) => s.id !== suggestionId),
  };
}

export function rejectSuggestion(doc: EditDoc, suggestionId: string): EditDoc {
  return {
    ...doc,
    suggestions: (doc.suggestions ?? []).filter((s) => s.id !== suggestionId),
  };
}

export function withSuggestions(doc: EditDoc, suggestions: readonly Suggestion[]): EditDoc {
  return { ...doc, suggestions: [...suggestions] };
}

/** Recompute totalDurationS from the base track (call after any edit). */
export function withRecomputedDuration(doc: EditDoc): EditDoc {
  return { ...doc, totalDurationS: round2(outputDuration(doc)) };
}
