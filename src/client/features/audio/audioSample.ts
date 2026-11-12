import type { SilenceInterval } from '../../../core/silence.js';

export interface DenoiseSampleInput {
  readonly source: string;
  readonly start: number;
  readonly end: number;
}

export interface SourceSilences {
  readonly source: string;
  readonly intervals: readonly SilenceInterval[];
}

const MIN_SAMPLE_S = 0.5;
const MAX_SAMPLE_S = 2;
const SUGGESTED_SAMPLE_S = 1.25;
const EDGE_GUARD_S = 0.04;

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** Keeps a manually chosen room-tone interval useful and inside its source. */
export function clampDenoiseSample(
  sample: DenoiseSampleInput,
  sourceDuration?: number,
): DenoiseSampleInput | null {
  if (
    sample.source.length === 0 ||
    !Number.isFinite(sample.start) ||
    !Number.isFinite(sample.end)
  ) {
    return null;
  }
  const upper =
    sourceDuration !== undefined && Number.isFinite(sourceDuration)
      ? Math.max(0, sourceDuration)
      : Number.POSITIVE_INFINITY;
  if (upper < MIN_SAMPLE_S) return null;

  const requestedDuration = sample.end - sample.start;
  if (requestedDuration <= 0) return null;
  const duration = Math.min(MAX_SAMPLE_S, Math.max(MIN_SAMPLE_S, requestedDuration));
  let start = Math.max(0, sample.start);
  if (Number.isFinite(upper)) start = Math.min(start, upper - duration);
  const end = Math.min(upper, start + duration);
  if (end - start < MIN_SAMPLE_S) return null;
  return { source: sample.source, start: round3(start), end: round3(end) };
}

/** Best detected pauses per source; each suggestion stays clear of speech edges. */
export function roomToneSuggestions(
  sources: readonly SourceSilences[],
  limitPerSource = 6,
): readonly DenoiseSampleInput[] {
  return sources.flatMap(({ source, intervals }) =>
    intervals
      .flatMap((interval) => {
        const safeStart = interval.start + EDGE_GUARD_S;
        const safeEnd = interval.end - EDGE_GUARD_S;
        const safeDuration = safeEnd - safeStart;
        if (safeDuration < MIN_SAMPLE_S) return [];
        const duration = Math.min(MAX_SAMPLE_S, SUGGESTED_SAMPLE_S, safeDuration);
        const center = (safeStart + safeEnd) / 2;
        return [
          {
            source,
            start: round3(center - duration / 2),
            end: round3(center + duration / 2),
          },
        ];
      })
      .sort((a, b) => b.end - b.start - (a.end - a.start))
      .slice(0, Math.max(0, limitPerSource)),
  );
}

export function sampleDuration(sample: DenoiseSampleInput): number {
  return Math.max(0, sample.end - sample.start);
}

export function waveformTimeAtFraction(fraction: number, sourceDuration: number): number {
  if (!Number.isFinite(fraction) || !Number.isFinite(sourceDuration) || sourceDuration <= 0)
    return 0;
  return round3(Math.min(1, Math.max(0, fraction)) * sourceDuration);
}

export function moveDenoiseSample(
  sample: DenoiseSampleInput,
  deltaS: number,
  sourceDuration: number,
): DenoiseSampleInput {
  const duration = sampleDuration(sample);
  const maxStart = Math.max(0, sourceDuration - duration);
  const start = Math.min(maxStart, Math.max(0, sample.start + deltaS));
  return { source: sample.source, start: round3(start), end: round3(start + duration) };
}

export function resizeDenoiseSample(
  sample: DenoiseSampleInput,
  edge: 'start' | 'end',
  time: number,
  sourceDuration: number,
): DenoiseSampleInput {
  if (edge === 'start') {
    const start = Math.min(sample.end - MIN_SAMPLE_S, Math.max(0, sample.end - MAX_SAMPLE_S, time));
    return { ...sample, start: round3(start) };
  }
  const end = Math.max(
    sample.start + MIN_SAMPLE_S,
    Math.min(sourceDuration, sample.start + MAX_SAMPLE_S, time),
  );
  return { ...sample, end: round3(end) };
}

/** Actual afftdn `nr` mapping used by renderPlan — a setting readout, not analysis. */
export function denoiseReductionDb(intensity: number): number {
  if (!Number.isFinite(intensity) || intensity <= 0) return 0;
  return Math.round((6 + Math.min(1, Math.max(0, intensity)) * 18) * 10) / 10;
}
