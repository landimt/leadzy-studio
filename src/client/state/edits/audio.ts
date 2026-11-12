import type { MediaSummary } from '../../api.js';
import type { AudioTrack, DenoiseSample, EditDoc } from '../../../core/schema.js';
import { SPEED_BOUNDS } from '../../../core/schema.js';
import { mapAudioTrack } from './mapTrack.js';

// Pure audio edits: per-clip gain and fades, and the output's denoise,
// loudness, speed and crossfade settings. Every function returns the next
// document, or `null` when the edit is a no-op; the store owns history,
// validation, saving and the "last loudnorm target" it restores on re-enable.

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

function audioBlockAt(doc: EditDoc, trackId: string, blockIndex: number) {
  const track = doc.tracks.find(
    (candidate): candidate is AudioTrack => candidate.kind === 'audio' && candidate.id === trackId,
  );
  return track?.blocks[blockIndex];
}

/** Per-clip gain in dB clamped to [-60, 12]; zero is canonicalized to the omitted field. */
export function setAudioBlockGain(
  doc: EditDoc,
  trackId: string,
  blockIndex: number,
  gainDb: number,
): EditDoc | null {
  if (!Number.isFinite(gainDb)) return null;
  const block = audioBlockAt(doc, trackId, blockIndex);
  if (!block) return null;
  const gain = round2(Math.min(12, Math.max(-60, gainDb)));
  if ((block.gainDb ?? 0) === gain && (gain !== 0 || block.gainDb === undefined)) return null;
  return mapAudioTrack(doc, trackId, (current) => ({
    ...current,
    blocks: current.blocks.map((candidate, i) => {
      if (i !== blockIndex) return candidate;
      const { gainDb: _removed, ...rest } = candidate;
      return gain === 0 ? rest : { ...rest, gainDb: gain };
    }),
  }));
}

export interface AudioFadePatch {
  readonly fadeInS?: number;
  readonly fadeOutS?: number;
}

/** Patches the fade envelope; zero clears a side, omitted sides keep their value, both fit inside the clip. */
export function setAudioBlockFades(
  doc: EditDoc,
  trackId: string,
  blockIndex: number,
  fades: AudioFadePatch,
): EditDoc | null {
  if (
    (fades.fadeInS !== undefined && !Number.isFinite(fades.fadeInS)) ||
    (fades.fadeOutS !== undefined && !Number.isFinite(fades.fadeOutS))
  ) {
    return null;
  }
  const block = audioBlockAt(doc, trackId, blockIndex);
  if (!block) return null;
  const duration = block.out - block.in;
  const fadeInS = Math.min(
    duration,
    round3(Math.min(duration, Math.max(0, fades.fadeInS ?? block.fadeInS ?? 0))),
  );
  let fadeOutS = Math.min(
    Math.max(0, duration - fadeInS),
    round3(
      Math.min(Math.max(0, duration - fadeInS), Math.max(0, fades.fadeOutS ?? block.fadeOutS ?? 0)),
    ),
  );
  if (fadeInS + fadeOutS > duration) fadeOutS = Math.max(0, duration - fadeInS);
  if ((block.fadeInS ?? 0) === fadeInS && (block.fadeOutS ?? 0) === fadeOutS) return null;
  return mapAudioTrack(doc, trackId, (current) => ({
    ...current,
    blocks: current.blocks.map((candidate, i) => {
      if (i !== blockIndex) return candidate;
      const { fadeInS: _oldIn, fadeOutS: _oldOut, ...rest } = candidate;
      return {
        ...rest,
        ...(fadeInS > 0 ? { fadeInS } : {}),
        ...(fadeOutS > 0 ? { fadeOutS } : {}),
      };
    }),
  }));
}

/** Noise-reduction intensity ahead of loudnorm, clamped to [0, 1]; 0 removes the field. */
export function setDenoise(doc: EditDoc, value: number): EditDoc | null {
  if (!Number.isFinite(value)) return null;
  const denoise = round2(Math.min(1, Math.max(0, value)));
  const { denoise: _removed, ...outputRest } = doc.output;
  const output = denoise > 0 ? { ...outputRest, denoise } : outputRest;
  return { ...doc, output };
}

/**
 * Explicit room tone in SOURCE time. The picker deliberately keeps manual
 * samples between 0.5–2s; `null` returns the renderer to its automatic
 * silence analysis. Invalid/unknown sources are a no-op instead of briefly
 * writing a document the schema has to discard.
 */
export function setDenoiseSample(
  doc: EditDoc,
  sourceMedia: MediaSummary | undefined,
  sample: DenoiseSample | null,
): EditDoc | null {
  const { denoiseSample: _removed, ...outputRest } = doc.output;
  if (sample === null) return { ...doc, output: outputRest };
  const source = doc.sources[sample.source];
  if (
    !source ||
    !Number.isFinite(sample.start) ||
    !Number.isFinite(sample.end) ||
    sample.end <= sample.start
  ) {
    return null;
  }
  if (sourceMedia?.kind === 'image') return null;
  const mediaDuration = sourceMedia?.durationS;
  const upper = source.durationS ?? mediaDuration;
  if (upper !== undefined && upper < 0.5) return null;
  const duration = Math.min(2, Math.max(0.5, sample.end - sample.start));
  let start = Math.max(0, sample.start);
  if (upper !== undefined) start = Math.min(start, upper - duration);
  const end = upper === undefined ? start + duration : Math.min(upper, start + duration);
  if (end - start < 0.5) return null;
  const denoiseSample: DenoiseSample = {
    source: sample.source,
    start: round3(start),
    end: round3(end),
  };
  return { ...doc, output: { ...outputRest, denoiseSample } };
}

/** Loudnorm target LUFS clamped to [-24, -9]; `null` disables normalization outright. */
export function setLoudnormLufs(doc: EditDoc, value: number | null): EditDoc | null {
  if (value !== null && !Number.isFinite(value)) return null;
  const loudnormLufs = value === null ? null : round2(Math.min(-9, Math.max(-24, value)));
  return { ...doc, output: { ...doc.output, loudnormLufs } };
}

/**
 * Global export speed — SPEED_BOUNDS clamp, 2-decimal round; 1 removes the
 * field. `<= 0` is never an intended speed (`Number('') === 0` from a cleared
 * input), so it is a no-op instead of silently clamping to the minimum.
 */
export function setOutputSpeed(doc: EditDoc, value: number): EditDoc | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const speed = round2(Math.min(SPEED_BOUNDS.max, Math.max(SPEED_BOUNDS.min, value)));
  const { speed: _removed, ...outputRest } = doc.output;
  const output = speed !== 1 ? { ...outputRest, speed } : outputRest;
  return { ...doc, output };
}

/** Audio crossfade at every base joint in ms — integer clamp into [0, 200]; 0 removes the field. */
export function setJoinAudioCrossfadeMs(doc: EditDoc, value: number): EditDoc | null {
  if (!Number.isFinite(value)) return null;
  const joinAudioCrossfadeMs = Math.round(Math.min(200, Math.max(0, value)));
  const { joinAudioCrossfadeMs: _removed, ...outputRest } = doc.output;
  const output = joinAudioCrossfadeMs > 0 ? { ...outputRest, joinAudioCrossfadeMs } : outputRest;
  return { ...doc, output };
}
