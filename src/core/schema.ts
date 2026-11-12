import { z } from 'zod';
import { libraryVariablesSchema, LIBRARY_ITEM_ID_PATTERN } from './libraryItem.js';
import { containedPath } from './paths.js';
import { err, ok, type Result } from './result.js';

// Relies on zod >= 4 rejecting Infinity/NaN in z.number() by default (v4
// deprecated .finite() as a no-op). These values are interpolated into ffmpeg
// filtergraphs — a zod downgrade below 4 would silently reopen that hole, so
// schema.test.ts pins the guarantee with an explicit Infinity/NaN case.
const timeSeconds = z.number().nonnegative();

/**
 * Conservative H.264 delivery envelope. 8K UHD stays below the H.264 level
 * 6.x frame-size ceiling, while the per-side cap prevents pathological aspect
 * ratios from turning a short-side preset into an enormous allocation.
 */
export const H264_OUTPUT_LIMITS = {
  maxSide: 8192,
  maxFramePixels: 7680 * 4320,
} as const;

export interface OutputDimensions {
  readonly width: number;
  readonly height: number;
}

export function isValidH264OutputDimensions(dimensions: OutputDimensions): boolean {
  const { width, height } = dimensions;
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= 2 &&
    height >= 2 &&
    width % 2 === 0 &&
    height % 2 === 0 &&
    width <= H264_OUTPUT_LIMITS.maxSide &&
    height <= H264_OUTPUT_LIMITS.maxSide &&
    width * height <= H264_OUTPUT_LIMITS.maxFramePixels
  );
}

const h264Dimension = z
  .number()
  .int()
  .min(2)
  .max(H264_OUTPUT_LIMITS.maxSide)
  .refine((value) => value % 2 === 0, 'must be even for H.264');

const positionSchema = z.union([
  z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']),
  z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict(),
]);

const splitSchema = z
  .object({
    ratio: z.number().gt(0).lt(1),
    arrangement: z.enum(['top', 'bottom', 'left', 'right']),
  })
  .strict();

const cellSchema = z
  .object({
    /** Fractions of the output frame — the window this clip covers. */
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0.05).max(1),
    h: z.number().min(0.05).max(1),
  })
  .strict()
  .refine((c) => c.x + c.w <= 1 && c.y + c.h <= 1, {
    message: 'cell must stay inside the frame (x + w <= 1 and y + h <= 1)',
  });

const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected color as #RRGGBB');

/**
 * Background images are project assets, never arbitrary filesystem paths.
 * `containedPath` owns the cross-platform absolute/escape checks; rejecting
 * every explicit `..` segment additionally keeps authored JSON canonical
 * instead of accepting paths that only become safe after normalization.
 */
const projectRelativeFileSchema = z
  .string()
  .min(1)
  .refine(
    (file) =>
      !file.startsWith('\\') &&
      !file.split(/[\\/]+/).includes('..') &&
      containedPath('__project__', file).ok,
    'expected a safe project-relative file path without traversal',
  );

const canvasBackgroundSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('color'), color: hexColorSchema }).strict(),
  z
    .object({
      kind: z.literal('image'),
      file: projectRelativeFileSchema,
      fit: z.enum(['cover', 'contain']),
      color: hexColorSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('video'),
      source: z.string().min(1),
      fit: z.enum(['cover', 'contain']),
      color: hexColorSchema.optional(),
    })
    .strict(),
]);

const canvasBaseSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('fill') }).strict(),
  z.object({ mode: z.literal('cell'), cell: cellSchema }).strict(),
]);

const canvasSchema = z
  .object({
    background: canvasBackgroundSchema,
    base: canvasBaseSchema,
  })
  .strict();

const sourceSchema = z
  .object({
    path: z.string().min(1),
    role: z.enum(['camera', 'screen', 'broll', 'other']).optional(),
    durationS: timeSeconds.optional(),
  })
  .strict();

const transformSchema = z
  .object({
    /** Free clip transform, editor-style: >1 punches in, <1 shrinks over background. */
    scale: z.number().min(0.2).max(4),
    /** Offset as a fraction of the cell size; positive x → right, y → down. */
    x: z.number().min(-1).max(1),
    y: z.number().min(-1).max(1),
  })
  .strict();

const transitionSchema = z
  .object({
    type: z.enum(['crossfade', 'fade-black', 'fade-white']),
    durationS: z.number().min(0.1).max(1.0),
  })
  .strict();

export const videoColorSchema = z
  .object({
    enabled: z.boolean().optional(),
    /** Explicit source transfer; conversion happens before compositing. */
    input: z.enum(['sdr', 'hlg', 'pq']).optional(),
    brightness: z.number().min(-0.3).max(0.3).optional(),
    contrast: z.number().min(0.5).max(1.5).optional(),
    saturation: z.number().min(0).max(2).optional(),
    gamma: z.number().min(0.5).max(2).optional(),
    hue: z.number().min(-180).max(180).optional(),
    warmth: z.number().min(-1).max(1).optional(),
  })
  .strict();
export type VideoColor = z.infer<typeof videoColorSchema>;

const baseBlockFields = {
  source: z.string().min(1),
  color: videoColorSchema.optional(),
  in: timeSeconds,
  out: timeSeconds,
  beat: z.string().optional(),
  reason: z.string().optional(),
  /**
   * Playback speed of this clip in the output (1 = natural). Honored on
   * base-track blocks only — the renderer ignores it on layer blocks, same
   * rule as `transition`.
   */
  speed: z.number().min(0.5).max(2).optional(),
  /** Reframe/reposition within the cell (base frame, split half, fullscreen). */
  transform: transformSchema.optional(),
  /**
   * Transition into this block's entry — the emenda with the PREVIOUS base
   * block. Ignored on the first base block (nothing precedes it). The
   * renderer only honors this on base-track blocks; it is inherited here for
   * layer blocks by schema shape only.
   */
  transition: transitionSchema.optional(),
};

const baseBlockSchema = z
  .object(baseBlockFields)
  .strict()
  .refine((b) => b.out > b.in, { message: 'block "out" must be greater than "in"' });

const layerBlockSchema = z
  .object({
    ...baseBlockFields,
    at: timeSeconds,
    mode: z.enum(['fullscreen', 'split', 'pip', 'cell']),
    position: positionSchema.optional(),
    scale: z.number().gt(0).max(1).optional(),
    /**
     * PiP only — the layer fills the frame while the base montage shrinks
     * into the PiP window (`position`/`scale` then place the BASE, not the
     * layer). Ignored by the renderer in every other mode, like `position`.
     */
    swapped: z.boolean().optional(),
    split: splitSchema.optional(),
    /** Free editor-style rect for mode "cell" — the clip fills exactly this window. */
    cell: cellSchema.optional(),
    audio: z.enum(['mute', 'duck', 'solo']).default('mute'),
  })
  .strict()
  .refine((b) => b.out > b.in, { message: 'block "out" must be greater than "in"' })
  .refine((b) => b.mode !== 'split' || b.split !== undefined, {
    message: 'split mode requires the "split" field',
  })
  .refine((b) => b.mode !== 'cell' || b.cell !== undefined, {
    message: 'cell mode requires the "cell" field',
  });

const overlayBlockSchema = z
  .object({
    file: z.string().min(1),
    at: timeSeconds,
    /** Source-time start for a trimmed animated/video overlay; omitted starts at zero. */
    sourceIn: timeSeconds.optional(),
    duration: z.number().positive().optional(),
    position: positionSchema.optional(),
    scale: z.number().gt(0).max(1).optional(),
    /** Present when generated by `studio title` — makes the card re-editable. */
    title: z
      .object({
        text: z.string().min(1),
        style: z.enum(['dark', 'paper', 'plain']),
        pos: z.enum(['top', 'center']),
      })
      .strict()
      .optional(),
    /**
     * Present when imported from a parametric library item — makes the piece
     * re-bakeable with new values. Metadata for the editor only: the render
     * planner reads `file`, exactly as it does for `title`.
     */
    library: z
      .object({
        item: z.string().regex(LIBRARY_ITEM_ID_PATTERN, 'invalid library item id'),
        variables: libraryVariablesSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const videoTrackSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('video'),
    label: z.string().optional(),
    color: videoColorSchema.optional(),
    /** Layer tracks only — the base track (tracks[0]) rejects it via superRefine. */
    hidden: z.boolean().optional(),
    muted: z.boolean().optional(),
    blocks: z.array(z.union([layerBlockSchema, baseBlockSchema])),
  })
  .strict();

const audioBlockSchema = z
  .object({
    source: z.string().min(1),
    in: timeSeconds,
    out: timeSeconds,
    /** Output-timeline position where this source-time slice begins. */
    at: timeSeconds,
    /** Per-clip gain envelope; omitted means unity (0 dB). */
    gainDb: z.number().min(-60).max(12).optional(),
    /** User-authored fades; omitted means no user fade at that edge. */
    fadeInS: timeSeconds.optional(),
    fadeOutS: timeSeconds.optional(),
  })
  .strict()
  .refine((b) => b.out > b.in, {
    message: 'audio block "out" must be greater than "in"',
  })
  .refine((b) => (b.fadeInS ?? 0) + (b.fadeOutS ?? 0) <= b.out - b.in + 1e-9, {
    message: 'audio block fades must fit within the block duration',
  });

const audioTrackSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('audio'),
    label: z.string().optional(),
    muted: z.boolean().optional(),
    blocks: z.array(audioBlockSchema),
  })
  .strict();

export const ZOOM_SCALE_BOUNDS = { min: 1.01, max: 2 } as const;
export const FLASH_DURATION_BOUNDS = { min: 0.08, max: 0.6 } as const;
export const SHAKE_DURATION_BOUNDS = { min: 0.15, max: 1.5 } as const;
export const SHAKE_INTENSITY_BOUNDS = { min: 1, max: 10 } as const;
/** Applied when a shake block omits `intensity` — the schema keeps it optional so hand-authored JSON can skip it. */
export const SHAKE_DEFAULT_INTENSITY = 5;

const zoomEffectSchema = z
  .object({
    type: z.literal('zoom'),
    at: timeSeconds,
    duration: z.number().positive(),
    /** 1 = none; 1.1–1.3 = typical reels punch-in. */
    scale: z.number().min(ZOOM_SCALE_BOUNDS.min).max(ZOOM_SCALE_BOUNDS.max),
  })
  .strict();

/** Impact flash — a fixed white clarão, no configurable color or intensity (simplicity over options). */
const flashEffectSchema = z
  .object({
    type: z.literal('flash'),
    at: timeSeconds,
    duration: z.number().min(FLASH_DURATION_BOUNDS.min).max(FLASH_DURATION_BOUNDS.max),
  })
  .strict();

/** Camera-shake punch: light zoom-in plus deterministic jitter, scaled by intensity. */
const shakeEffectSchema = z
  .object({
    type: z.literal('shake'),
    at: timeSeconds,
    duration: z.number().min(SHAKE_DURATION_BOUNDS.min).max(SHAKE_DURATION_BOUNDS.max),
    intensity: z
      .number()
      .int()
      .min(SHAKE_INTENSITY_BOUNDS.min)
      .max(SHAKE_INTENSITY_BOUNDS.max)
      .optional(),
  })
  .strict();

const effectBlockSchema = z.discriminatedUnion('type', [
  zoomEffectSchema,
  flashEffectSchema,
  shakeEffectSchema,
]);

const effectTrackSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('effect'),
    label: z.string().optional(),
    hidden: z.boolean().optional(),
    blocks: z.array(effectBlockSchema),
  })
  .strict();

const overlayTrackSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('overlay'),
    label: z.string().optional(),
    hidden: z.boolean().optional(),
    blocks: z.array(overlayBlockSchema),
  })
  .strict();

const suggestionSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(['silence', 'repetition', 'false-start', 'filler']),
    source: z.string().min(1),
    start: timeSeconds,
    end: timeSeconds,
    reason: z.string(),
  })
  .strict()
  .refine((s) => s.end > s.start, { message: 'suggestion "end" must be greater than "start"' });

const SUBTITLE_PRESETS = ['2p-caps', '3p-natural', 'pill'] as const;

const subtitleColorSchema = hexColorSchema;

const subtitleFillSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('solid'), color: subtitleColorSchema }).strict(),
  z
    .object({
      kind: z.literal('gradient'),
      from: subtitleColorSchema,
      to: subtitleColorSchema,
    })
    .strict(),
]);

const subtitleThemeSchema = z
  .object({
    fontFamily: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[^,=]+$/, 'fontFamily cannot contain commas or equals signs')
      .optional(),
    fontWeight: z.number().int().min(400).max(900).optional(),
    fill: subtitleFillSchema.optional(),
    highlightFill: subtitleFillSchema.optional(),
    backgroundStyle: z.enum(['pill', 'outline', 'none']).optional(),
    backgroundColor: subtitleColorSchema.optional(),
    backgroundOpacity: z.number().min(0).max(1).optional(),
    outlineColor: subtitleColorSchema.optional(),
    outlineWidth: z.number().min(0).max(8).optional(),
  })
  .strict();

const subtitleHiddenRangeSchema = z
  .object({
    source: z.string().min(1),
    /** Source time (not output) — cuts/reordering of the base track remap the output. */
    start: timeSeconds,
    end: timeSeconds,
  })
  .strict()
  .refine((r) => r.end > r.start, { message: 'hidden range "end" must be greater than "start"' });

const subtitleCorrectionSchema = z
  .object({
    source: z.string().min(1),
    /** A source time inside the word being corrected — stable across re-transcriptions. */
    at: timeSeconds,
    // no control chars: a newline here would break the SRT record framing
    text: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[^\u0000-\u001f\u007f]+$/u, 'correction text cannot contain control characters'),
  })
  .strict();

const subtitlesSchema = z
  .object({
    enabled: z.boolean(),
    preset: z.enum(SUBTITLE_PRESETS).default('2p-caps'),
    forceStyle: z.string().optional(),
    /** Preferred minimum number of spoken words kept together in one caption. */
    minWordsPerCue: z.number().int().min(1).max(6).optional(),
    /** Hard maximum number of spoken words shown at once. */
    maxWordsPerCue: z.number().int().min(1).max(6).optional(),
    /** Agent-defined visual identity. Omitted fields inherit from the preset. */
    theme: subtitleThemeSchema.optional(),
    /** Vertical margin in libass PlayResY units (288 = full height). */
    marginV: z.number().int().min(10).max(240).optional(),
    /** How long a cue may survive past its last word's end, in seconds (default 0.4). */
    maxTailS: z.number().min(0).max(2).optional(),
    /** Font size in libass PlayResY units. */
    fontSize: z.number().int().min(10).max(28).optional(),
    /** Source-time windows where subtitles are suppressed, persisted here — never in the transcript. */
    hiddenRanges: z.array(subtitleHiddenRangeSchema).optional(),
    /** Manual text fixes for mistranscribed words, persisted here — never in the transcript. */
    corrections: z.array(subtitleCorrectionSchema).optional(),
    /** Set by the human editor: agents must NOT touch the subtitle config while true. */
    locked: z.boolean().optional(),
  })
  .strict()
  .refine(
    (subtitles) =>
      subtitles.minWordsPerCue === undefined ||
      subtitles.maxWordsPerCue === undefined ||
      subtitles.minWordsPerCue <= subtitles.maxWordsPerCue,
    { message: 'subtitle minWordsPerCue must be less than or equal to maxWordsPerCue' },
  );

/**
 * A short source-time room-tone window explicitly chosen by the editor.
 * afftdn uses it to learn a spectral noise profile before processing the
 * montage. When omitted, the renderer keeps its automatic silence-based
 * floor measurement for backwards compatibility.
 */
const denoiseSampleSchema = z
  .object({
    source: z.string().min(1),
    start: timeSeconds,
    end: timeSeconds,
  })
  .strict()
  .refine((sample) => sample.end > sample.start, {
    message: 'denoise sample "end" must be greater than "start"',
  })
  .refine((sample) => sample.end - sample.start >= 0.2, {
    message: 'denoise sample must be at least 0.2 seconds long',
  })
  .refine((sample) => sample.end - sample.start <= 3, {
    message: 'denoise sample must be at most 3 seconds long',
  });

const MAX_KEYTERM_WORDS = 5;
/** Scribe's own limits: < 50 characters and at most 5 words per term. */
const keytermSchema = z
  .string()
  .trim()
  .min(1)
  .max(49)
  .refine((term) => term.split(/\s+/).length <= MAX_KEYTERM_WORDS, {
    message: `a keyterm has at most ${String(MAX_KEYTERM_WORDS)} words`,
  });

/** What the transcription engine is told about this creative before it listens. */
const transcriptionSchema = z
  .object({
    /** Brand, product and people names the transcript must spell right (billed as a surcharge). */
    keyterms: z.array(keytermSchema).max(100),
  })
  .strict();

const editDocSchema = z
  .object({
    version: z.literal(2),
    fps: z.number().positive(),
    output: z
      .object({
        width: h264Dimension,
        height: h264Dimension,
        loudnormLufs: z.number().negative().nullable(),
        /** De-click fade at every base-track joint, in ms (0 disables; default 30). */
        joinAudioFadeMs: z.number().int().min(0).max(200).optional(),
        /** Noise-reduction intensity 0–1 (omitted/0 = off); independent of normalization and ordered before loudnorm when both run. */
        denoise: z.number().min(0).max(1).optional(),
        /** Explicit source-time room-tone sample; omitted means automatic silence-based measurement. */
        denoiseSample: denoiseSampleSchema.optional(),
        /** Global export speed applied AFTER montage and subtitle burn (0.5–2, 1/omitted = natural) — burned subs stay in sync by construction. */
        speed: z.number().min(0.5).max(2).optional(),
        /** Overlap audio crossfade at every base joint, in ms (0/omitted = the joinAudioFadeMs declick only). */
        joinAudioCrossfadeMs: z.number().int().min(0).max(200).optional(),
      })
      .strict()
      .superRefine((output, ctx) => {
        if (output.width * output.height > H264_OUTPUT_LIMITS.maxFramePixels) {
          ctx.addIssue({
            code: 'custom',
            message: `H.264 output must not exceed ${String(H264_OUTPUT_LIMITS.maxFramePixels)} pixels per frame`,
            path: ['width'],
          });
        }
      }),
    sources: z.record(z.string().min(1), sourceSchema),
    /** Optional canvas composition; omitted documents preserve the legacy full-frame base. */
    canvas: canvasSchema.optional(),
    tracks: z
      .array(z.union([videoTrackSchema, audioTrackSchema, overlayTrackSchema, effectTrackSchema]))
      .min(1),
    subtitles: subtitlesSchema,
    transcription: transcriptionSchema.optional(),
    suggestions: z.array(suggestionSchema).optional(),
    totalDurationS: timeSeconds.optional(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const [baseTrack] = doc.tracks;
    if (baseTrack?.kind !== 'video') {
      ctx.addIssue({
        code: 'custom',
        message: 'tracks[0] must be a video track (the base line that defines the output timeline)',
        path: ['tracks', 0],
      });
      return;
    }
    if (baseTrack.hidden === true) {
      ctx.addIssue({
        code: 'custom',
        message: 'the base track cannot be hidden — it IS the output timeline',
        path: ['tracks', 0, 'hidden'],
      });
    }
    baseTrack.blocks.forEach((block, i) => {
      if ('at' in block) {
        ctx.addIssue({
          code: 'custom',
          message: 'base track blocks concatenate; they must not carry "at" or "mode"',
          path: ['tracks', 0, 'blocks', i],
        });
      }
    });
    doc.tracks.slice(1).forEach((track, t) => {
      if (track.kind !== 'video') return;
      track.blocks.forEach((block, i) => {
        if (!('at' in block)) {
          ctx.addIssue({
            code: 'custom',
            message: 'layer track blocks must carry "at" and "mode"',
            path: ['tracks', t + 1, 'blocks', i],
          });
        }
      });
    });
    for (const track of doc.tracks) {
      if (track.kind !== 'video' && track.kind !== 'audio') continue;
      for (const [i, block] of track.blocks.entries()) {
        const source = doc.sources[block.source];
        if (source === undefined) {
          ctx.addIssue({
            code: 'custom',
            message: `block references unknown source "${block.source}"`,
            path: ['tracks', doc.tracks.indexOf(track), 'blocks', i],
          });
        } else if (
          track.kind === 'audio' &&
          source.durationS !== undefined &&
          block.out > source.durationS
        ) {
          ctx.addIssue({
            code: 'custom',
            message: `audio block ends after source "${block.source}" (${String(source.durationS)}s)`,
            path: ['tracks', doc.tracks.indexOf(track), 'blocks', i, 'out'],
          });
        }
      }
    }
    if (doc.canvas?.background.kind === 'video') {
      const source = doc.canvas.background.source;
      if (doc.sources[source] === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `canvas background references unknown source "${source}"`,
          path: ['canvas', 'background', 'source'],
        });
      }
    }
    const denoiseSample = doc.output.denoiseSample;
    if (denoiseSample !== undefined) {
      const source = doc.sources[denoiseSample.source];
      if (source === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `denoise sample references unknown source "${denoiseSample.source}"`,
          path: ['output', 'denoiseSample', 'source'],
        });
      } else if (source.durationS !== undefined && denoiseSample.end > source.durationS) {
        ctx.addIssue({
          code: 'custom',
          message: `denoise sample ends after source "${denoiseSample.source}" (${String(source.durationS)}s)`,
          path: ['output', 'denoiseSample', 'end'],
        });
      }
    }
  });

export type EditDoc = z.infer<typeof editDocSchema>;
export type CanvasConfig = z.infer<typeof canvasSchema>;
export type CanvasBackground = z.infer<typeof canvasBackgroundSchema>;
export type CanvasBase = z.infer<typeof canvasBaseSchema>;
export type DenoiseSample = z.infer<typeof denoiseSampleSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type BaseBlock = z.infer<typeof baseBlockSchema>;
export type LayerBlock = z.infer<typeof layerBlockSchema>;
export type VideoBlock = BaseBlock | LayerBlock;
export type AudioBlock = z.infer<typeof audioBlockSchema>;
export type OverlayBlock = z.infer<typeof overlayBlockSchema>;
export type OverlayLibraryRef = NonNullable<OverlayBlock['library']>;
export type VideoTrack = z.infer<typeof videoTrackSchema>;
export type AudioTrack = z.infer<typeof audioTrackSchema>;
export type OverlayTrack = z.infer<typeof overlayTrackSchema>;
export type ZoomEffectBlock = z.infer<typeof zoomEffectSchema>;
export type FlashEffectBlock = z.infer<typeof flashEffectSchema>;
export type ShakeEffectBlock = z.infer<typeof shakeEffectSchema>;
export type EffectBlock = z.infer<typeof effectBlockSchema>;
export type EffectTrack = z.infer<typeof effectTrackSchema>;
export type Track = VideoTrack | AudioTrack | OverlayTrack | EffectTrack;
export type Suggestion = z.infer<typeof suggestionSchema>;
export type SubtitlePreset = (typeof SUBTITLE_PRESETS)[number];
export type SubtitleFill = z.infer<typeof subtitleFillSchema>;
export type SubtitleTheme = z.infer<typeof subtitleThemeSchema>;
export type SubtitleHiddenRange = z.infer<typeof subtitleHiddenRangeSchema>;
export type SubtitleCorrection = z.infer<typeof subtitleCorrectionSchema>;
export type Position = z.infer<typeof positionSchema>;
export type ClipTransform = z.infer<typeof transformSchema>;
export type BlockTransition = z.infer<typeof transitionSchema>;
export type LayerCell = z.infer<typeof cellSchema>;
export type LayerSplit = z.infer<typeof splitSchema>;

export const SPEED_BOUNDS = { min: 0.5, max: 2 } as const;

export function isLayerBlock(block: VideoBlock): block is LayerBlock {
  return 'at' in block;
}

export function baseTrackOf(doc: EditDoc): VideoTrack {
  const [base] = doc.tracks;
  if (base?.kind !== 'video') {
    throw new Error('edit doc has no base video track — schema validation should have caught this');
  }
  return base;
}

const RETIRED_CORRECTION_HINT =
  'subtitles.corrections[] no longer use wordIndex — rewrite each entry as { source, at, text } where at is any source time inside the word (studio transcript pack shows the times)';

function retiredFieldHints(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly keys?: readonly string[] }[],
): string[] {
  const usesWordIndex = issues.some(
    (issue) =>
      issue.path[0] === 'subtitles' &&
      issue.path[1] === 'corrections' &&
      (issue.keys?.includes('wordIndex') ?? false),
  );
  return usesWordIndex ? [RETIRED_CORRECTION_HINT] : [];
}

/** Union branches report relative paths; retain their actionable validation details. */
function validationIssues(
  issues: readonly z.core.$ZodIssue[],
  parentPath: readonly PropertyKey[] = [],
): z.core.$ZodIssue[] {
  return issues.flatMap((issue) => {
    const path = [...parentPath, ...issue.path];
    if (issue.code === 'invalid_union' && issue.errors.length > 0) {
      return issue.errors.flatMap((branch) => validationIssues(branch, path));
    }
    return [{ ...issue, path }];
  });
}

export function parseEditDoc(data: unknown): Result<EditDoc> {
  const parsed = editDocSchema.safeParse(data);
  if (!parsed.success) {
    const issues = validationIssues(parsed.error.issues);
    const detail = [
      ...issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      ...retiredFieldHints(issues),
    ].join('; ');
    return err('invalid-edit-json', `edit.json failed validation: ${detail}`, parsed.error);
  }
  return ok(parsed.data);
}

/** The keyterms a transcription of this document is prompted with; none when the document has none. */
export function transcriptionKeyterms(doc: Pick<EditDoc, 'transcription'>): readonly string[] {
  return doc.transcription?.keyterms ?? [];
}
