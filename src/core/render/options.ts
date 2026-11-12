import { type EditDoc } from '../schema.js';

export const AUDIO_FADE_S = 0.03;

/**
 * Below this much usable overlap, a crossfade degrades to the fade-black dip
 * path instead — a blend this short reads as a single flickered frame, not a
 * transition, so it isn't worth the extra re-encode.
 */
export const MIN_CROSSFADE_OVERLAP_S = 0.1;

/**
 * Noise-floor bounds shared with `noiseFloor.ts`'s measurement — re-clamped
 * here too because this is the last gate before the value is interpolated
 * into an ffmpeg filtergraph string; an out-of-range or non-finite `nf`
 * would be a hard mid-render ffmpeg failure, not a caught validation error.
 */
export const NOISE_FLOOR_FALLBACK_DB = -50;

export const NOISE_FLOOR_MIN_DB = -80;

export const NOISE_FLOOR_MAX_DB = -20;

/**
 * H.264 encoders the planner can emit. VideoToolbox (Apple) and NVENC (NVIDIA)
 * are the hardware encoders: several times faster than libx264, which is what
 * background program/preview renders need; libx264 stays the DEFAULT delivery
 * encoder because its rate control is deterministic across machines. A final
 * can still ask for a hardware encoder explicitly: the picture holds up at
 * delivery rates, only byte-for-byte reproducibility is given away.
 */
export type VideoEncoder = 'libx264' | 'h264_videotoolbox' | 'h264_nvenc';

/**
 * What the browser composes live stays out of the program render: overlay
 * tracks, subtitles and layer video. Their audio stays in, so the program's
 * sound is the final's sound.
 */
export type RenderLayers = 'burn' | 'omit';

/** Final-encode quality: the recommended CRF, or two steps up for masters. */
export type RenderQuality = 'recommended' | 'high' | 'max';

/** Hardware decoders ffmpeg can be asked for; the source is decoded on the GPU, filters and encode stay unchanged. */
export type VideoDecoder = 'videotoolbox' | 'cuda';

export interface RenderOptions {
  readonly preview: boolean;
  /**
   * Decode source video on the hardware decoder instead of the CPU. Frames
   * are bit-identical for H.264/HEVC 4:2:0 and 4:2:2 (normative decoders);
   * ProRes and 4:4:4 sources differ below ~70 dB PSNR — invisible, but not
   * byte-equal. On a 4K60 HEVC take the software decode alone is slower than
   * real time and dominates every render. ffmpeg falls back to software by
   * itself when the codec is not supported, so this is safe to set whenever
   * the capability exists.
   */
  readonly hwaccel?: VideoDecoder;
  /** Defaults to `burn`; `omit` produces the player's engine-mode program. */
  readonly layers?: RenderLayers;
  /** Defaults to libx264; the server picks the hardware encoder for fast-path renders. */
  readonly videoEncoder?: VideoEncoder;
  /** Defaults to `recommended`; only the final encode reads it. */
  readonly quality?: RenderQuality;
  readonly subtitles: boolean;
  /**
   * Emergency override, not the primary switch: `false` forces the loudnorm
   * chain off regardless of the doc (e.g. `--no-loudnorm` on the CLI);
   * `true` means "don't override" — the doc's `output.loudnormLufs` decides
   * (`null` = off, a number = on at that target). Callers default to `true`.
   */
  readonly loudnorm: boolean;
}

/**
 * Single source of truth for whether the loudnorm chain runs: the
 * doc decides ON/OFF (`output.loudnormLufs: null` = off, a number = on at
 * that target); `options.loudnorm` is only the emergency override above,
 * which can force it off but never force it on. Exported so `render.ts`'s
 * noise-floor measurement — a PCM decode that exists solely to feed this
 * same chain — gates on this exact decision instead of a hand-duplicated
 * condition in a different file that could silently drift from it.
 */
export function loudnormActive(doc: EditDoc, options: Pick<RenderOptions, 'loudnorm'>): boolean {
  return doc.output.loudnormLufs !== null && options.loudnorm;
}

/** Noise reduction is a document-level choice and does not depend on loudness normalization. */
export function denoiseActive(doc: EditDoc): boolean {
  return (doc.output.denoise ?? 0) > 0;
}

export const LOUDNORM_PLACEHOLDERS = {
  i: '{{MEASURED_I}}',
  tp: '{{MEASURED_TP}}',
  lra: '{{MEASURED_LRA}}',
  thresh: '{{MEASURED_THRESH}}',
  offset: '{{MEASURED_OFFSET}}',
} as const;

/**
 * Codec/container contract for every published MP4. `videoCodec` is the
 * delivery encoder of the final file; preview and program renders may swap
 * it for the hardware encoder (`RenderOptions.videoEncoder`) — same H.264
 * stream, faster, not bit-reproducible. Keep these values untagged:
 * declaring BT.709 metadata without converting source pixels would make the
 * tag a lie for non-BT.709 inputs.
 */
export const MP4_DELIVERY_PROFILE = {
  videoCodec: 'libx264',
  pixelFormat: 'yuv420p',
  audioCodec: 'aac',
  audioBitrate: '192k',
  audioSampleRate: '48000',
  audioChannels: '2',
  movflags: '+faststart',
} as const;

export type RenderArtifactKind = 'program' | 'preview' | 'final';

/** The artifact a render produces; the program is always a preview-resolution render without the composed layers. */
export function renderArtifactKind(options: RenderOptions): RenderArtifactKind {
  if (options.layers === 'omit') return 'program';
  return options.preview ? 'preview' : 'final';
}

/** Where a render lands — one name per artifact kind, shared with the publication paths. */
export function renderOutputPath(options: RenderOptions): string {
  return `edit/${renderArtifactKind(options)}.mp4`;
}

export const AUDIO_ENCODE_ARGS = [
  '-c:a',
  MP4_DELIVERY_PROFILE.audioCodec,
  '-b:a',
  MP4_DELIVERY_PROFILE.audioBitrate,
  '-ar',
  MP4_DELIVERY_PROFILE.audioSampleRate,
  '-ac',
  MP4_DELIVERY_PROFILE.audioChannels,
] as const;

/** MP4-only muxing args. Never attach these to cache/intermediate `.mov` outputs. */
export const MP4_FASTSTART_ARGS = ['-movflags', MP4_DELIVERY_PROFILE.movflags] as const;
