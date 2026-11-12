import type { SilenceInterval } from './silence.js';

export interface WaveformPeaks {
  readonly version: 1;
  readonly sampleRate: number;
  readonly windowMs: number;
  readonly min: readonly number[];
  readonly max: readonly number[];
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Mono PCM → min/max peaks per window. Cached to disk once, redrawn forever. */
export function buildPeaks(
  samples: Float32Array,
  sampleRate: number,
  windowMs = 10,
): WaveformPeaks {
  const windowSize = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  const windowCount = Math.ceil(samples.length / windowSize);
  const min: number[] = new Array<number>(windowCount);
  const max: number[] = new Array<number>(windowCount);

  for (let w = 0; w < windowCount; w += 1) {
    const begin = w * windowSize;
    const end = Math.min(begin + windowSize, samples.length);
    let lo = 0;
    let hi = 0;
    for (let i = begin; i < end; i += 1) {
      const sample = samples[i] ?? 0;
      if (sample < lo) lo = sample;
      if (sample > hi) hi = sample;
    }
    min[w] = round3(lo);
    max[w] = round3(hi);
  }
  return { version: 1, sampleRate, windowMs, min, max };
}

/**
 * Resample cached peaks to `targetBuckets` for the current zoom level —
 * cheap enough to run on every redraw, so the PCM is never touched again.
 */
export function resamplePeaks(
  peaks: WaveformPeaks,
  startS: number,
  endS: number,
  targetBuckets: number,
): { min: number[]; max: number[] } {
  const windowsPerSecond = 1000 / peaks.windowMs;
  const firstWindow = Math.max(0, Math.floor(startS * windowsPerSecond));
  const lastWindow = Math.min(peaks.min.length, Math.ceil(endS * windowsPerSecond));
  const span = Math.max(1, lastWindow - firstWindow);

  const min = new Array<number>(targetBuckets).fill(0);
  const max = new Array<number>(targetBuckets).fill(0);
  for (let b = 0; b < targetBuckets; b += 1) {
    const from = firstWindow + Math.floor((b * span) / targetBuckets);
    const to = Math.max(from + 1, firstWindow + Math.floor(((b + 1) * span) / targetBuckets));
    let lo = 0;
    let hi = 0;
    for (let w = from; w < to; w += 1) {
      lo = Math.min(lo, peaks.min[w] ?? 0);
      hi = Math.max(hi, peaks.max[w] ?? 0);
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { min, max };
}

/**
 * Silence detection from cached peaks (10ms windows). The threshold ADAPTS to
 * the recording: a fixed dB floor misses pauses on real-world audio whose room
 * noise sits above it — we measure the noise floor (10th percentile of window
 * amplitude) and cut anything close to it.
 */
export function silencesFromPeaks(
  peaks: WaveformPeaks,
  thresholdAmplitude: number | 'auto' = 'auto',
  minSilenceS = 0.4,
): SilenceInterval[] {
  const windowS = peaks.windowMs / 1000;
  const amplitudes = peaks.min.map((lo, i) => Math.max(Math.abs(lo), Math.abs(peaks.max[i] ?? 0)));
  let threshold: number;
  if (thresholdAmplitude === 'auto') {
    const sorted = [...amplitudes].sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
    const speech = sorted[Math.floor(sorted.length * 0.9)] ?? 1;
    // between the noise floor and speech level, biased toward the floor
    threshold = Math.min(0.18, Math.max(0.02, floor * 2.5, speech * 0.12));
  } else {
    threshold = thresholdAmplitude;
  }
  const result: SilenceInterval[] = [];
  let start: number | null = null;
  for (let i = 0; i <= amplitudes.length; i += 1) {
    const amplitude = i < amplitudes.length ? (amplitudes[i] ?? 0) : 1;
    const time = i * windowS;
    if (amplitude < threshold) {
      start ??= time;
    } else if (start !== null) {
      if (time - start >= minSilenceS) result.push({ start, end: time });
      start = null;
    }
  }
  return result;
}
