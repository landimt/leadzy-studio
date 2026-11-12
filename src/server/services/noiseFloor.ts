import {
  NOISE_FLOOR_FALLBACK_DB,
  NOISE_FLOOR_MAX_DB,
  NOISE_FLOOR_MIN_DB,
} from '../../core/render/options.js';
import type { SilenceInterval } from '../../core/silence.js';

/** Below this much total silence, the measurement is too thin to trust. */
const MIN_SILENCE_TOTAL_S = 0.2;
export const AFFTDN_PROFILE_BAND_COUNT = 15;

function dbfsFromRms(rms: number): number {
  return rms <= 0 ? NOISE_FLOOR_MIN_DB : 20 * Math.log10(rms);
}

/**
 * Parses the last 15-band profile printed by afftdn after a `sample_noise`
 * stop command. ffmpeg prefixes the line with build/version-specific logger
 * text, so only the stable `bn=` payload is considered. Malformed/non-finite
 * output returns undefined and lets the renderer keep the measured scalar
 * floor rather than injecting unsafe text into a filtergraph.
 */
export function parseAfftdnBandProfile(stderr: string): readonly number[] | undefined {
  let parsed: readonly number[] | undefined;
  for (const match of stderr.matchAll(/\bbn\s*=\s*([^\r\n]+)/g)) {
    const values = (match[1] ?? '').trim().split(/\s+/).map(Number);
    if (values.length === AFFTDN_PROFILE_BAND_COUNT && values.every(Number.isFinite)) {
      parsed = values;
    }
  }
  return parsed;
}

/**
 * Pairwise (cartesian) intersection of two interval lists — restricts a
 * whole-file silence scan to the windows a caller actually cares about (e.g.
 * the base track's [in,out) cuts of a source), so silence OUTSIDE those
 * windows (a digitally-silent head/tail past the cut, room tone from an
 * unused take) can't skew the measured floor. Input needs no ordering and the
 * output is neither sorted nor coalesced: overlapping input windows yield
 * overlapping output intervals, so a stretch cut into the base twice weighs
 * twice in the RMS — deliberate, it plays twice in the output. A
 * touching-but-not-overlapping boundary (`end === start`) produces no
 * interval — zero-length silence isn't silence.
 */
export function intersectIntervals(
  a: readonly SilenceInterval[],
  b: readonly SilenceInterval[],
): SilenceInterval[] {
  const result: SilenceInterval[] = [];
  for (const x of a) {
    for (const y of b) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (end > start) result.push({ start, end });
    }
  }
  return result;
}

/**
 * RMS-in-dBFS of `samples` restricted to `silences` — the room-tone floor
 * afftdn's `nf` gets tuned to. Pure and synchronous so it's testable with
 * hand-built PCM.
 */
export function noiseFloorDbFromSamples(
  samples: Float32Array,
  sampleRate: number,
  silences: readonly SilenceInterval[],
): number {
  let sumSquares = 0;
  let sampleCount = 0;
  for (const silence of silences) {
    const startIndex = Math.max(0, Math.floor(silence.start * sampleRate));
    const endIndex = Math.min(samples.length, Math.ceil(silence.end * sampleRate));
    for (let i = startIndex; i < endIndex; i += 1) {
      const sample = samples[i] ?? 0;
      sumSquares += sample * sample;
      sampleCount += 1;
    }
  }
  if (sampleCount < MIN_SILENCE_TOTAL_S * sampleRate) return NOISE_FLOOR_FALLBACK_DB;
  const rms = Math.sqrt(sumSquares / sampleCount);
  const db = dbfsFromRms(rms);
  return Math.min(NOISE_FLOOR_MAX_DB, Math.max(NOISE_FLOOR_MIN_DB, db));
}
