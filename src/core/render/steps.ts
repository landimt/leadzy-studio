import { createHash } from 'node:crypto';
import {
  type ResolvedSubtitleSettings,
  type ResolvedSubtitleTheme,
  type SubtitleCue,
} from '../srt.js';
import type { RenderOptions } from './options.js';
import { MP4_DELIVERY_PROFILE } from './options.js';

export type RenderStep =
  | { readonly kind: 'write-file'; readonly path: string; readonly content: string }
  | {
      /**
       * Builds a content-addressed transparent PNG timeline from the same
       * path-based SVG used by Player. The following ffmpeg compose consumes
       * `manifestPath` as one concat input; no second text engine is involved.
       */
      readonly kind: 'subtitle-graphics';
      readonly label: string;
      readonly manifestPath: string;
      readonly cues: readonly SubtitleCue[];
      readonly width: number;
      readonly height: number;
      readonly fps: number;
      readonly durationS: number;
      readonly settings: ResolvedSubtitleSettings;
      readonly theme: ResolvedSubtitleTheme;
    }
  | {
      readonly kind: 'ffmpeg';
      readonly label: string;
      readonly args: readonly string[];
      readonly output?: string;
    }
  | {
      /**
       * A content-addressed extraction: `output`'s filename IS the hash of
       * `argsWithoutOutput` + the source fingerprint, so the executor can
       * skip re-running ffmpeg when that exact file already exists on disk.
       */
      readonly kind: 'ffmpeg-cacheable';
      readonly label: string;
      readonly args: readonly string[];
      readonly argsWithoutOutput: readonly string[];
      readonly output: string;
    }
  | { readonly kind: 'loudnorm-measure'; readonly args: readonly string[] }
  | {
      readonly kind: 'loudnorm-apply';
      readonly argsTemplate: readonly string[];
      readonly output: string;
    };

export interface RenderPlan {
  readonly steps: readonly RenderStep[];
  readonly outputPath: string;
  readonly expectedDurationS: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
}

export const CACHE_DIR = 'edit/cache';

/**
 * libx264 CRF (lower is better), VideoToolbox `-q:v` (1–100, higher is better)
 * and NVENC `-cq` (lower is better, but a step tighter than the CRF that reads
 * the same, because NVENC spends its bits less evenly) per final quality.
 */
const FINAL_QUALITY = {
  recommended: { crf: '20', vt: '70', cq: '21' },
  high: { crf: '18', vt: '78', cq: '19' },
  max: { crf: '16', vt: '86', cq: '17' },
} as const;

/** Input-side decoder flags; they must precede the `-i` of the source they apply to. */
export function decodeArgs(options: Pick<RenderOptions, 'hwaccel'>): string[] {
  return options.hwaccel === undefined ? [] : ['-hwaccel', options.hwaccel];
}

export function encodeArgs(options: RenderOptions): string[] {
  const final = FINAL_QUALITY[options.quality ?? 'recommended'];
  const quality =
    options.videoEncoder === 'h264_videotoolbox'
      ? // VideoToolbox has no CRF: -q:v is 1–100, higher is better
        ['-q:v', options.preview ? '50' : final.vt]
      : options.videoEncoder === 'h264_nvenc'
        ? // NVENC's constant quality is -cq, and it only takes effect under
          // `-rc vbr` with the bitrate target left open at 0. Presets are p1
          // (fastest) to p7 (slowest).
          [
            '-preset',
            options.preview ? 'p1' : 'p5',
            '-rc',
            'vbr',
            '-cq',
            options.preview ? '30' : final.cq,
            '-b:v',
            '0',
          ]
        : [
            '-preset',
            options.preview ? 'ultrafast' : 'fast',
            '-crf',
            options.preview ? '28' : final.crf,
          ];
  return [
    '-c:v',
    options.videoEncoder ?? MP4_DELIVERY_PROFILE.videoCodec,
    ...quality,
    '-pix_fmt',
    MP4_DELIVERY_PROFILE.pixelFormat,
  ];
}

/**
 * Intermediate segments carry PCM audio in .mov: AAC adds ~21ms of encoder
 * priming per segment, and `-c copy` concat turns that into audio drift that
 * ACCUMULATES block by block (measured ~35ms/block on a representative test). PCM
 * concats gaplessly; AAC is encoded exactly once, at composition.
 */
export const SEGMENT_AUDIO_SAMPLE_RATE = 48_000;
export const SEGMENT_AUDIO_ARGS = [
  '-c:a',
  'pcm_s16le',
  '-ar',
  String(SEGMENT_AUDIO_SAMPLE_RATE),
  '-ac',
  '2',
];

/**
 * Rebase the PCM sample grid to the segment's video origin. first_pts pads
 * a real source delay with silence and trims negative decoder priming; it
 * must precede atempo so intentional delays scale with playback speed too.
 * Without it, AAC inputs can leave positive initial PTS on PCM segments,
 * extending each MOV beyond -t and accumulating drift through -c copy concat.
 */
export const SEGMENT_AUDIO_TIMING_FILTER = 'aresample=48000:first_pts=0';

/** Exact duration emitted for an audio window on the document frame grid. */
export function quantizeAudioDuration(durationS: number, fps: number, speed = 1): number {
  return Math.round((durationS / speed) * fps) / fps;
}

/**
 * A segment shorter than 2×fade would have its in/out fades overlap and
 * invert the gain curve, so the fade is clamped to half the segment.
 */
function fadeFilter(durationS: number, fadeS: number): string | undefined {
  if (fadeS <= 0 || durationS <= 0) return undefined;
  const clamped = Math.min(fadeS, durationS / 2);
  const outStart = Math.max(0, durationS - clamped);
  return `afade=t=in:st=0:d=${clamped.toFixed(3)},afade=t=out:st=${outStart.toFixed(3)}:d=${clamped.toFixed(3)}`;
}

export const fmt = (t: number): string => t.toFixed(3);

interface ExtractionInput {
  readonly sourcePath: string;
  /**
   * Where the VIDEO is read from when it is not `sourcePath` — the 540p proxy
   * for previews. Audio always comes from `sourcePath`, so the preview hears
   * the same PCM the final will; ffmpeg does not decode video it never maps.
   */
  readonly videoSourcePath?: string;
  readonly inS: number;
  readonly outS: number;
  readonly fps: number;
  /**
   * Full video filter chain, already including any `setpts=PTS/speed` at the
   * right spot (between the cell/crop filter and any time-dependent dip
   * fades — dip `st` values are expressed in post-speed output time, so
   * retiming must happen before them). `fps=` is appended here, after the
   * caller's chain.
   */
  readonly videoFilter: string;
  readonly hasAudio: boolean;
  readonly options: RenderOptions;
  readonly audioFadeS: number;
  /** Block playback speed (1 = natural) — scales the OUTPUT duration and, when audio is present, the audio tempo. */
  readonly speed?: number;
}

/**
 * ffmpeg args for one extraction, everything except the output path — this
 * is exactly the set of decisions that determine the output bytes (in/out,
 * fps, filter chain, encode preset, fades), so it doubles as the cache-key
 * material for `cacheableExtractStep` below.
 */
function buildExtractionArgs(input: ExtractionInput): string[] {
  const speed = input.speed ?? 1;
  // Whole frames only: -t must sit on the frame grid or concat accumulates
  // audio/video length mismatches across segments. `-t` here is an OUTPUT
  // option (it follows -i), so it bounds the POST-speed duration — the
  // caller's `setpts` inside videoFilter already retimed the stream to match.
  const duration = quantizeAudioDuration(input.outS - input.inS, input.fps, speed);
  const videoSource = input.videoSourcePath ?? input.sourcePath;
  const separateAudioInput = input.hasAudio && videoSource !== input.sourcePath;
  const args = ['-y', ...decodeArgs(input.options), '-ss', fmt(input.inS), '-i', videoSource];
  if (separateAudioInput) {
    args.push('-ss', fmt(input.inS), '-i', input.sourcePath);
  } else if (!input.hasAudio) {
    args.push(
      '-f',
      'lavfi',
      '-t',
      fmt(duration),
      '-i',
      'anullsrc=channel_layout=stereo:sample_rate=48000',
    );
  }
  const fade = fadeFilter(duration, input.audioFadeS);
  // atempo covers exactly 0.5–2, matching SPEED_BOUNDS, so a single filter
  // instance always suffices — never chained. Silence (no real audio) is
  // generated straight at `duration` above; time-stretching it would be inert.
  const audioFilters = [
    SEGMENT_AUDIO_TIMING_FILTER,
    ...(speed !== 1 && input.hasAudio ? [`atempo=${fmt(speed)}`] : []),
    ...(fade ? [fade] : []),
  ];
  args.push(
    '-t',
    fmt(duration),
    '-vf',
    `${input.videoFilter},fps=${String(input.fps)}`,
    ...(audioFilters.length > 0 ? ['-af', audioFilters.join(',')] : []),
    ...(input.hasAudio && !separateAudioInput ? [] : ['-map', '0:v:0', '-map', '1:a:0']),
    ...encodeArgs(input.options),
    ...SEGMENT_AUDIO_ARGS,
  );
  return args;
}

export function extractClipStep(
  input: ExtractionInput & { readonly label: string; readonly outputPath: string },
): Extract<RenderStep, { kind: 'ffmpeg' }> {
  const args = buildExtractionArgs(input);
  return {
    kind: 'ffmpeg',
    label: input.label,
    args: [...args, input.outputPath],
    output: input.outputPath,
  };
}

/**
 * Content-addresses an arbitrary ffmpeg invocation: `output`'s filename IS
 * the hash of `argsWithoutOutput` + `cacheInput`, so the executor can skip
 * re-running ffmpeg when that exact file already exists on disk. Shared by
 * every cacheable step (segment extraction, crossfade extension, crossfade
 * merge) so `args = [...argsWithoutOutput, output]` can never drift between
 * the two fields — see the `ffmpeg-cacheable` step doc for why that matters.
 */
export function cacheableFfmpegStep(input: {
  readonly label: string;
  readonly argsWithoutOutput: readonly string[];
  /** Stable semantic args when execution uses a job-scoped pinned pathname. */
  readonly cacheArgsWithoutOutput?: readonly string[];
  readonly cacheInput: string;
}): Extract<RenderStep, { kind: 'ffmpeg-cacheable' }> {
  const hash = createHash('sha1')
    .update(
      JSON.stringify([
        ...(input.cacheArgsWithoutOutput ?? input.argsWithoutOutput),
        input.cacheInput,
      ]),
    )
    .digest('hex');
  const output = `${CACHE_DIR}/segments/seg-${hash}.mov`;
  return {
    kind: 'ffmpeg-cacheable',
    label: input.label,
    args: [...input.argsWithoutOutput, output],
    argsWithoutOutput: input.argsWithoutOutput,
    output,
  };
}

/**
 * Base-track segments are re-extracted on every render today, even when the
 * source block didn't change — this is what makes them content-addressed
 * instead: same block ⇒ same args ⇒ same file name, so the executor can
 * reuse the file on disk instead of shelling out to ffmpeg again.
 */
export function cacheableExtractStep(
  input: ExtractionInput & { readonly label: string; readonly sourceFingerprint: string },
): Extract<RenderStep, { kind: 'ffmpeg-cacheable' }> {
  const args = buildExtractionArgs(input);
  return cacheableFfmpegStep({
    label: input.label,
    argsWithoutOutput: args,
    cacheArgsWithoutOutput: args.map((arg, index) =>
      args[index - 1] === '-i' && arg === input.sourcePath ? '<source-media>' : arg,
    ),
    cacheInput: input.sourceFingerprint,
  });
}
