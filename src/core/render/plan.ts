import { resolvedVideoColor, videoColorFilter } from '../videoColor.js';
import { createHash } from 'node:crypto';
import { OVERLAY_MARGIN_FRACTION, overlayAnchor, PIP_DEFAULT_SCALE } from '../overlayPlacement.js';
import { err, ok, type Result } from '../result.js';
import {
  baseTrackOf,
  isLayerBlock,
  type AudioBlock,
  type AudioTrack,
  type CanvasBackground,
  type EditDoc,
  type EffectBlock,
  type LayerBlock,
  type OverlayBlock,
  type Position,
} from '../schema.js';
import { outputSegments } from '../timeline.js';
import {
  buildSubtitleCues,
  cuesToSrt,
  forceStyleFor,
  subtitleSettingsFor,
  subtitleThemeFor,
  type ResolvedSubtitleSettings,
  type ResolvedSubtitleTheme,
  type SubtitleCue,
} from '../srt.js';
import type { Transcript } from '../transcript.js';
import type { MediaProbe } from '../media.js';
import type { RenderOptions } from './options.js';
import {
  AUDIO_FADE_S,
  loudnormActive,
  denoiseActive,
  LOUDNORM_PLACEHOLDERS,
  AUDIO_ENCODE_ARGS,
  MP4_FASTSTART_ARGS,
  renderOutputPath,
} from './options.js';
import type { ResolvedJoin } from './audio.js';
import {
  resolveJoinAudioFadeS,
  resolveAudioBlockFades,
  resolveJoin,
  segmentDipFilters,
  speedVideoFilter,
  crossfadeRunEnd,
  buildCrossfadeMergeStep,
  buildAudioCrossfadeBase,
  denoiseFilter,
} from './audio.js';
import type { RenderStep, RenderPlan } from './steps.js';
import {
  CACHE_DIR,
  encodeArgs,
  SEGMENT_AUDIO_ARGS,
  quantizeAudioDuration,
  fmt,
  extractClipStep,
  cacheableExtractStep,
  decodeArgs,
} from './steps.js';
import type { Dimensions } from './canvas.js';
import {
  previewDimensions,
  cellDimension,
  ffmpegColor,
  backgroundMediaFitFilter,
  cellFilter,
} from './canvas.js';
import { zoomEffectFilters, flashEffectFilters, shakeEffectFilters } from './effects.js';
import { visibleRenderDoc, validateCanvasBackground, validateVideoTrackMedia } from './document.js';

export type { MediaProbe } from '../media.js';
/**
 * Default de-click fade in seconds — used for base-track joints when
 * `doc.output.joinAudioFadeMs` is unset, and for layer/audio-block edges (not
 * user-configurable; inserts are windowed clips, not base-track joints, so
 * they keep a fixed fade regardless of the doc setting).
 */

const SRT_PATH = 'edit/subtitles/master.srt';

const SUBTITLE_GRAPHICS_RENDERER_VERSION = 'satori-0.33.5-resvg-2.6-fontsource-5.3-v2';

function subtitleGraphicsManifestPath(input: {
  readonly cues: readonly SubtitleCue[];
  readonly dimensions: Dimensions;
  readonly fps: number;
  readonly durationS: number;
  readonly settings: ResolvedSubtitleSettings;
  readonly theme: ResolvedSubtitleTheme;
}): string {
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        renderer: SUBTITLE_GRAPHICS_RENDERER_VERSION,
        cues: input.cues.map(({ start, end, text }) => ({ start, end, text })),
        dimensions: input.dimensions,
        fps: input.fps,
        durationS: input.durationS,
        settings: input.settings,
        theme: input.theme,
      }),
    )
    .digest('hex')
    .slice(0, 24);
  return `${CACHE_DIR}/subtitles/vector-${hash}/overlay.ffconcat`;
}

/**
 * Mirrors the live player's CSS placement EXACTLY (Player.tsx overlay wrap
 * and pip layerWrapperStyle) — that is where the drag persisted these values:
 * `{x,y}` are fractions of the FULL frame (`left: x*100%`), and corner
 * margins are 3% of each axis, because CSS resolves `top`/`bottom`
 * percentages against the height. Anchoring `{x,y}` on the leftover space
 * (`(main_w-overlay_w)*x`) shifted every dragged overlay toward the
 * top-left in the export — the larger the piece, the further.
 */
function overlayPosition(position: Position | undefined): {
  x: string;
  y: string;
} {
  const anchor = overlayAnchor(position);
  if (anchor.kind === 'fraction') {
    return { x: `main_w*${String(anchor.x)}`, y: `main_h*${String(anchor.y)}` };
  }
  const mx = `main_w*${String(OVERLAY_MARGIN_FRACTION)}`;
  const my = `main_h*${String(OVERLAY_MARGIN_FRACTION)}`;
  return {
    x: anchor.horizontal === 'left' ? mx : `main_w-overlay_w-${mx}`,
    y: anchor.vertical === 'top' ? my : `main_h-overlay_h-${my}`,
  };
}

/** libass needs ':' and quotes escaped inside the subtitles filter argument. */
function escapeSubtitlesPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function escapeForceStyle(style: string): string {
  return style.replace(/,/g, '\\,');
}

interface LayerClip {
  readonly block: LayerBlock;
  readonly inputIndex: number;
}

interface AudioClip {
  readonly block: AudioBlock;
  readonly inputIndex: number;
  readonly durationS: number;
}

interface OverlayClip {
  readonly block: OverlayBlock;
  readonly inputIndex: number;
  readonly durationS: number;
  readonly isImage: boolean;
}

interface BackgroundClip {
  readonly background: CanvasBackground;
  readonly inputIndex?: number;
}

/**
 * Turns an edit doc into an executable list of ffmpeg invocations following
 * the hard rules: accurate per-segment extraction with de-click audio fades
 * (doc.output.joinAudioFadeMs, default 30ms) → lossless concat → ONE
 * composition pass (base effects → optional canvas background/base cell →
 * layers via setpts=PTS-STARTPTS+at/TB → overlays → subtitles ALWAYS last)
 * → denoise → optional two-pass loudnorm.
 */
export function planRender(input: {
  doc: EditDoc;
  transcripts: ReadonlyMap<string, Transcript>;
  probes: ReadonlyMap<string, MediaProbe>;
  /** Cheap per-source identity (e.g. path+mtime+size hash) for cache keying — see `cacheableExtractStep`. */
  sourceFingerprints: ReadonlyMap<string, string>;
  options: RenderOptions;
  /**
   * Measured from the explicit room-tone sample, or from the base track's
   * own silences in automatic mode (see `noiseFloor.ts`) — only read when
   * `doc.output.denoise` is set; falls back to
   * `NOISE_FLOOR_FALLBACK_DB` when the caller omits it (e.g. denoise was
   * just turned on and no measurement ran yet).
   */
  noiseFloorDb?: number;
  /** Fifteen afftdn custom-band values learned from an explicit room-tone sample. */
  noiseProfileBands?: readonly number[];
  /**
   * Source id → lighter file to read VIDEO from (the 540p proxy) for base
   * segments and layer clips; audio still comes from the source. The server
   * fills this for previews only — a final never reads a proxy.
   */
  previewVideoSources?: ReadonlyMap<string, string>;
}): Result<RenderPlan> {
  const { transcripts, probes, sourceFingerprints, options } = input;
  const previewVideoSources = input.previewVideoSources ?? new Map<string, string>();
  const doc: EditDoc = visibleRenderDoc(input.doc);
  const base = baseTrackOf(doc);
  const baseMuted = base.muted === true;
  if (base.blocks.length === 0) {
    return err('invalid-edit-json', 'base track has no blocks — nothing to render');
  }
  for (const key of Object.keys(doc.sources)) {
    if (!probes.has(key)) {
      return err('not-found', `no probe information for source "${key}" — was the media probed?`);
    }
    if (!sourceFingerprints.has(key)) {
      return err('not-found', `no fingerprint for source "${key}" — was the media hashed?`);
    }
  }
  const videoMediaValidation = validateVideoTrackMedia(doc, probes);
  if (!videoMediaValidation.ok) return videoMediaValidation;
  const canvasBackgroundValidation = validateCanvasBackground(doc, probes);
  if (!canvasBackgroundValidation.ok) return canvasBackgroundValidation;
  const outputDims: Dimensions = options.preview
    ? previewDimensions(doc.output)
    : { width: doc.output.width, height: doc.output.height };
  // A cell-based presenter is decoded/reframed directly into the cell's
  // aspect ratio. Scaling the base to outputDims first and then cover-cropping
  // it again during canvas composition discards source pixels twice and does
  // not match Player's single object-fit window.
  const baseVideoDims: Dimensions =
    doc.canvas?.base.mode === 'cell'
      ? {
          width: cellDimension(outputDims.width, doc.canvas.base.cell.w),
          height: cellDimension(outputDims.height, doc.canvas.base.cell.h),
        }
      : outputDims;
  const outputPath = renderOutputPath(options);
  const omitLayers = options.layers === 'omit';
  const steps: RenderStep[] = [];
  const segments = outputSegments(doc);
  const expectedDurationS = segments[segments.length - 1]?.outputEnd ?? 0;
  const joinAudioFadeS = resolveJoinAudioFadeS(doc);
  const subtitlesRequested = options.subtitles && doc.subtitles.enabled && !omitLayers;
  let subtitleCues: ReturnType<typeof buildSubtitleCues> | undefined;
  if (subtitlesRequested) {
    // Captions deliberately describe the concatenated BASE track only;
    // layer/audio-track speech does not feed the caption track. Every base
    // source must still have a loaded transcript, otherwise cues from another
    // source would mask a partial-caption export. Individual windows may have
    // no words (intentional silence or hidden ranges), so coverage is not
    // required per block.
    for (const source of new Set(segments.map((segment) => segment.source))) {
      if (!transcripts.has(source)) {
        return err(
          'invalid-transcript',
          `subtitles are enabled but base source "${source}" has no transcript`,
        );
      }
    }
    subtitleCues = buildSubtitleCues(doc, transcripts);
    if (subtitleCues.length === 0) {
      return err(
        'invalid-transcript',
        'subtitles are enabled but no subtitle cues could be generated for the visible base timeline',
      );
    }
  }

  // Resolve every base-track boundary once: 'none', a fade-black/fade-white
  // dip, or a real crossfade (with its clamped extension) — see resolveJoin.
  // Transitions on the first block are ignored (nothing precedes it).
  const resolvedJoins: ResolvedJoin[] = segments.map((segment, i) => {
    const previous = i > 0 ? segments[i - 1] : undefined;
    if (!previous) return { kind: 'none' };
    return resolveJoin(base.blocks[segment.blockIndex]?.transition, previous, segment, probes);
  });

  // 1. Base segments: accurate cut (-ss before -i), scale to output, edge fades.
  //    Fades are baked in per segment (not a crossfade at concat time) so the
  //    lossless concat below stays a straight -c copy and total duration is
  //    unaffected — a crossfade would shorten the timeline and desync
  //    subtitles/QA against the transcript. The first segment's fade-in and
  //    the last segment's fade-out land on the video's outer edges; that is
  //    harmless (no audio plays before/after them) so segments don't need
  //    special-casing for position.
  const plainSteps: (Extract<RenderStep, { kind: 'ffmpeg-cacheable' }> | undefined)[] = [];
  segments.forEach((segment, i) => {
    const probe = probes.get(segment.source);
    const source = doc.sources[segment.source];
    const fingerprint = sourceFingerprints.get(segment.source);
    if (!probe || !source || fingerprint === undefined) {
      plainSteps.push(undefined);
      return;
    }
    const segmentDurationS = segment.outputEnd - segment.outputStart;
    const block = base.blocks[segment.blockIndex];
    const videoFilter = [
      videoColorFilter(resolvedVideoColor(base.color, block?.color)),
      cellFilter(baseVideoDims, block?.transform),
      speedVideoFilter(segment.speed),
      ...segmentDipFilters(i, resolvedJoins, segmentDurationS),
    ]
      .filter((part) => part !== '')
      .join(',');
    const color = resolvedVideoColor(base.color, block?.color);
    const previewVideo =
      color?.input === 'hlg' || color?.input === 'pq'
        ? undefined
        : previewVideoSources.get(segment.source);
    const step = cacheableExtractStep({
      label: `segment ${String(i + 1)}/${String(segments.length)}`,
      sourcePath: source.path,
      ...(previewVideo !== undefined ? { videoSourcePath: previewVideo } : {}),
      inS: segment.in,
      outS: segment.out,
      fps: doc.fps,
      videoFilter,
      // A muted base reuses the existing no-audio-source path (anullsrc,
      // -t-bounded) instead of a post-hoc volume=0 — that keeps duration
      // exactness the same guarantee the video-only-source case already relies on.
      hasAudio: probe.hasAudio && !baseMuted,
      options,
      speed: segment.speed,
      audioFadeS: joinAudioFadeS,
      sourceFingerprint: fingerprint,
    });
    steps.push(step);
    plainSteps.push(step);
  });

  // 1b. Collapse each run of real-crossfade boundaries into ONE merged step —
  //     only these joins re-encode; every other boundary stays a plain entry
  //     in the concat below (as if nothing changed).
  const segmentPaths: string[] = [];
  for (let cursor = 0; cursor < segments.length;) {
    const runEnd = crossfadeRunEnd(cursor, resolvedJoins);
    if (runEnd === cursor) {
      const step = plainSteps[cursor];
      if (step) segmentPaths.push(step.output);
      cursor += 1;
      continue;
    }
    const built = buildCrossfadeMergeStep({
      runStart: cursor,
      runEnd,
      doc,
      segments,
      baseBlocks: base.blocks,
      resolvedJoins,
      plainSteps,
      outputDims: baseVideoDims,
      probes,
      sourceFingerprints,
      options,
      totalSegments: segments.length,
      baseMuted,
    });
    if (built) {
      steps.push(...built.extraSteps, built.mergeStep);
      segmentPaths.push(built.mergeStep.output);
    } else {
      for (let k = cursor; k <= runEnd; k += 1) {
        const step = plainSteps[k];
        if (step) segmentPaths.push(step.output);
      }
    }
    cursor = runEnd + 1;
  }

  // 2. Lossless concat — segments share codecs, so -c copy never re-encodes.
  const concatListPath = `${CACHE_DIR}/segments/concat.txt`;
  steps.push({
    kind: 'write-file',
    path: concatListPath,
    content: segmentPaths.map((p) => `file '${p.split('/').pop() ?? p}'`).join('\n') + '\n',
  });
  const basePath = `${CACHE_DIR}/base.mov`;
  steps.push({
    kind: 'ffmpeg',
    label: 'concat base line',
    args: ['-y', '-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', basePath],
    output: basePath,
  });

  // 2c. doc.output.joinAudioCrossfadeMs: swap basePath's audio for a
  //     crossfaded track built by a parallel pipeline — the video above is
  //     untouched either way.
  const audioCrossfade = buildAudioCrossfadeBase({
    doc,
    segments,
    baseBlocks: base.blocks,
    probes,
    sourceFingerprints,
    joinAudioFadeS,
    baseMuted,
    basePath,
  });
  if (audioCrossfade) steps.push(...audioCrossfade.steps);
  const composeBasePath = audioCrossfade?.basePath ?? basePath;

  // 3. Layer clips (each extracted with its own fades, native size).
  const layerBlocks: LayerBlock[] = doc.tracks
    .slice(1)
    .filter((t) => t.kind === 'video')
    .flatMap((t) =>
      // A muted layer track forces every one of its blocks to audio:'mute',
      // regardless of the block's own field — the track setting wins.
      t.blocks.filter(isLayerBlock).map((block): LayerBlock => ({
        ...block,
        color: resolvedVideoColor(t.color, block.color),
        ...(t.muted === true ? { audio: 'mute' as const } : {}),
      })),
    )
    // the program keeps a layer only for its audio; a silent one has nothing to contribute
    .filter((block) => !omitLayers || block.audio !== 'mute');
  const overlayBlocks: OverlayBlock[] = omitLayers
    ? []
    : doc.tracks.filter((t) => t.kind === 'overlay').flatMap((t) => t.blocks);
  const audioBlocks: AudioBlock[] = doc.tracks
    .filter((track): track is AudioTrack => track.kind === 'audio' && track.muted !== true)
    .flatMap((track) => track.blocks);

  const composeInputs: string[] = ['-y', '-i', composeBasePath];
  let inputIndex = 1;

  let backgroundClip: BackgroundClip | undefined;
  const canvasBackground = doc.canvas?.background;
  if (canvasBackground?.kind === 'image') {
    composeInputs.push('-loop', '1', '-t', fmt(expectedDurationS), '-i', canvasBackground.file);
    backgroundClip = { background: canvasBackground, inputIndex };
    inputIndex += 1;
  } else if (canvasBackground?.kind === 'video') {
    const source = doc.sources[canvasBackground.source];
    if (source === undefined) {
      return err(
        'not-found',
        `no media information for canvas background "${canvasBackground.source}"`,
      );
    }
    composeInputs.push(
      ...decodeArgs(options),
      '-stream_loop',
      '-1',
      '-t',
      fmt(expectedDurationS),
      '-i',
      source.path,
    );
    backgroundClip = { background: canvasBackground, inputIndex };
    inputIndex += 1;
  } else if (canvasBackground?.kind === 'color') {
    backgroundClip = { background: canvasBackground };
  }

  const layerClips: LayerClip[] = [];
  layerBlocks.forEach((block, i) => {
    const probe = probes.get(block.source);
    const source = doc.sources[block.source];
    if (!probe || !source) return;
    const clipPath = `${CACHE_DIR}/layers/layer-${String(i).padStart(3, '0')}.mov`;
    const layerPreviewVideo =
      block.color?.input === 'hlg' || block.color?.input === 'pq'
        ? undefined
        : previewVideoSources.get(block.source);
    steps.push(
      extractClipStep({
        label: `layer clip ${String(i + 1)}/${String(layerBlocks.length)}`,
        sourcePath: source.path,
        ...(layerPreviewVideo !== undefined ? { videoSourcePath: layerPreviewVideo } : {}),
        inS: block.in,
        outS: block.out,
        fps: doc.fps,
        videoFilter: 'scale=iw:ih',
        hasAudio: probe.hasAudio,
        options,
        outputPath: clipPath,
        audioFadeS: AUDIO_FADE_S,
      }),
    );
    composeInputs.push('-i', clipPath);
    layerClips.push({ block, inputIndex });
    inputIndex += 1;
  });

  const overlayClips: OverlayClip[] = [];
  for (const block of overlayBlocks) {
    const isImage = /\.(png|jpg|jpeg|webp)$/i.test(block.file);
    const probe = probes.get(block.file);
    const durationS =
      block.duration ?? (!isImage && probe ? probe.durationS - (block.sourceIn ?? 0) : undefined);
    if (durationS === undefined) {
      return err(
        'not-found',
        `overlay "${block.file}" has no duration and was not probed — images need an explicit duration`,
      );
    }
    if (durationS <= 0 || (!isImage && probe && (block.sourceIn ?? 0) >= probe.durationS)) {
      return err('invalid-input', `overlay "${block.file}" starts outside its source duration`);
    }
    if (isImage) {
      composeInputs.push('-loop', '1', '-t', fmt(durationS), '-i', block.file);
    } else {
      composeInputs.push(
        ...(/\.webm$/i.test(block.file) ? ['-c:v', 'libvpx-vp9'] : []),
        ...(block.sourceIn ? ['-ss', fmt(block.sourceIn)] : []),
        '-i',
        block.file,
      );
    }
    overlayClips.push({ block, inputIndex, durationS, isImage });
    inputIndex += 1;
  }

  // Audio blocks reuse the audio stream of an already-probed project source.
  // Seek and duration are input options, so ffmpeg decodes only the requested
  // window. Only `:a` is referenced below, so audio-only probes need no
  // fps/dimensions and video sources never enter the visual graph.
  const audioClips: AudioClip[] = [];
  for (const block of audioBlocks) {
    const probe = probes.get(block.source);
    const source = doc.sources[block.source];
    if (!probe || !source) {
      return err('not-found', `no media information for audio source "${block.source}"`);
    }
    if (!probe.hasAudio) {
      return err('invalid-edit-json', `audio block source "${block.source}" has no audio stream`);
    }
    const durationS = quantizeAudioDuration(block.out - block.in, doc.fps);
    composeInputs.push('-ss', fmt(block.in), '-t', fmt(durationS), '-i', source.path);
    audioClips.push({ block, inputIndex, durationS });
    inputIndex += 1;
  }

  // 4. ONE composition pass, in the professional order: EFFECTS on the locked
  //    cut → optional canvas (background then base cell/fill) → layers (track
  //    order) → overlays → subtitles LAST. Audio: base with per-window volume,
  //    plus layer audio per policy, mixed without renormalizing.
  const filters: string[] = [];
  let currentVideo = '0:v';
  const nextLabel = ((): (() => string) => {
    let n = 0;
    return () => {
      n += 1;
      return `v${String(n)}`;
    };
  })();

  const effectBlocks: EffectBlock[] = doc.tracks
    .filter((track) => track.kind === 'effect')
    .flatMap((track) => track.blocks);
  effectBlocks.forEach((effect, i) => {
    const src = `[${currentVideo}]`;
    const outLabel = nextLabel();
    switch (effect.type) {
      case 'zoom':
        filters.push(...zoomEffectFilters(effect, baseVideoDims, i, src, outLabel));
        break;
      case 'flash':
        filters.push(...flashEffectFilters(effect, baseVideoDims, doc.fps, i, src, outLabel));
        break;
      case 'shake':
        filters.push(...shakeEffectFilters(effect, baseVideoDims, i, src, outLabel));
        break;
      default: {
        const exhaustive: never = effect;
        throw new Error(`unhandled effect type: ${JSON.stringify(exhaustive)}`);
      }
    }
    currentVideo = outLabel;
  });

  // Canvas composition sits behind the effected base montage but before
  // authored video layers. This keeps punch/flash/shake attached to the base
  // camera while later layers retain their normal z-order. Background inputs
  // are visual-only: no `:a` stream from an image/video background is ever
  // referenced by the audio graph.
  if (backgroundClip !== undefined && doc.canvas !== undefined) {
    const backgroundLabel = 'canvasbg';
    if (backgroundClip.background.kind === 'color') {
      filters.push(
        `color=c=${ffmpegColor(backgroundClip.background.color)}:s=${String(outputDims.width)}x${String(outputDims.height)}:r=${String(doc.fps)}:d=${fmt(expectedDurationS)}[${backgroundLabel}]`,
      );
    } else {
      const index = backgroundClip.inputIndex;
      if (index === undefined) throw new Error('canvas media background has no input index');
      const matteLabel = 'canvasmatte';
      const mediaLabel = 'canvasmedia';
      // Player always paints a solid matte below background media. Keep that
      // same order for both fits: it supplies contain letterboxing and also
      // resolves transparent pixels in PNG/WebM backgrounds deterministically.
      filters.push(
        `color=c=${ffmpegColor(backgroundClip.background.color ?? '#000000')}:s=${String(outputDims.width)}x${String(outputDims.height)}:r=${String(doc.fps)}:d=${fmt(expectedDurationS)}[${matteLabel}]`,
      );
      filters.push(
        `[${String(index)}:v]${backgroundMediaFitFilter(outputDims, backgroundClip.background.fit)},fps=${String(doc.fps)},setpts=PTS-STARTPTS[${mediaLabel}]`,
      );
      filters.push(
        `[${matteLabel}][${mediaLabel}]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2:shortest=1[${backgroundLabel}]`,
      );
    }

    const baseLabel = 'canvasbase';
    let x = 0;
    let y = 0;
    if (doc.canvas.base.mode === 'cell') {
      const { cell } = doc.canvas.base;
      x = Math.min(
        Math.max(0, Math.round(cell.x * outputDims.width)),
        outputDims.width - baseVideoDims.width,
      );
      y = Math.min(
        Math.max(0, Math.round(cell.y * outputDims.height)),
        outputDims.height - baseVideoDims.height,
      );
      filters.push(`[${currentVideo}]setpts=PTS-STARTPTS[${baseLabel}]`);
    } else {
      filters.push(`[${currentVideo}]setpts=PTS-STARTPTS[${baseLabel}]`);
    }
    const outLabel = nextLabel();
    filters.push(
      `[${backgroundLabel}][${baseLabel}]overlay=${String(x)}:${String(y)}:shortest=1[${outLabel}]`,
    );
    currentVideo = outLabel;
  }

  const composedLayerClips = omitLayers ? [] : layerClips;
  composedLayerClips.forEach((clip, i) => {
    const { block } = clip;
    const start = block.at;
    const end = block.at + (block.out - block.in);
    const enable = `enable='between(t,${fmt(start)},${fmt(end)})'`;
    const grade = videoColorFilter(block.color);
    const shifted = `${grade ? `${grade},` : ''}setpts=PTS-STARTPTS+${fmt(start)}/TB`;
    const scaledLabel = `l${String(i)}`;

    if (block.mode === 'fullscreen') {
      filters.push(
        `[${String(clip.inputIndex)}:v]${cellFilter(outputDims, block.transform)},${shifted}[${scaledLabel}]`,
      );
      const outLabel = nextLabel();
      filters.push(`[${currentVideo}][${scaledLabel}]overlay=0:0:${enable}[${outLabel}]`);
      currentVideo = outLabel;
    } else if (block.mode === 'split') {
      const ratio = block.split?.ratio ?? 0.5;
      const arrangement = block.split?.arrangement ?? 'top';
      const horizontal = arrangement === 'left' || arrangement === 'right';
      const sliceLength = horizontal
        ? 2 * Math.round((outputDims.width * ratio) / 2)
        : 2 * Math.round((outputDims.height * ratio) / 2);
      const slice: Dimensions = horizontal
        ? { width: sliceLength, height: outputDims.height }
        : { width: outputDims.width, height: sliceLength };
      filters.push(
        `[${String(clip.inputIndex)}:v]${cellFilter(slice, block.transform)},${shifted}[${scaledLabel}]`,
      );
      const x = arrangement === 'right' ? String(outputDims.width - sliceLength) : '0';
      const y = arrangement === 'bottom' ? String(outputDims.height - sliceLength) : '0';
      const outLabel = nextLabel();
      filters.push(`[${currentVideo}][${scaledLabel}]overlay=${x}:${y}:${enable}[${outLabel}]`);
      currentVideo = outLabel;
    } else if (block.mode === 'cell') {
      const cell = block.cell ?? { x: 0, y: 0, w: 1, h: 1 };
      const dims: Dimensions = {
        width: cellDimension(outputDims.width, cell.w),
        height: cellDimension(outputDims.height, cell.h),
      };
      filters.push(
        `[${String(clip.inputIndex)}:v]${cellFilter(dims, block.transform)},${shifted}[${scaledLabel}]`,
      );
      // x and width (same for y/height) round independently off different
      // schema fields — the schema only guarantees x+w<=1 in fraction space,
      // so rounding can still push x+width 1px past the frame edge. Clamp the
      // position so the overlay never spills outside outputDims.
      const x = String(
        Math.min(Math.max(0, Math.round(cell.x * outputDims.width)), outputDims.width - dims.width),
      );
      const y = String(
        Math.min(
          Math.max(0, Math.round(cell.y * outputDims.height)),
          outputDims.height - dims.height,
        ),
      );
      const outLabel = nextLabel();
      filters.push(`[${currentVideo}][${scaledLabel}]overlay=${x}:${y}:${enable}[${outLabel}]`);
      currentVideo = outLabel;
    } else if (block.swapped === true) {
      // Swapped PiP: the layer fills the frame and the composed base (canvas
      // and effects included) shrinks into the PiP window. Both overlays are
      // enable-gated, so outside the window the untouched base passes through.
      const baseFull = `ls${String(i)}a`;
      const basePipRaw = `ls${String(i)}b`;
      const basePip = `ls${String(i)}c`;
      const scale = block.scale ?? PIP_DEFAULT_SCALE;
      const pipWidth = 2 * Math.round((outputDims.width * scale) / 2);
      filters.push(`[${currentVideo}]split=2[${baseFull}][${basePipRaw}]`);
      filters.push(`[${basePipRaw}]scale=${String(pipWidth)}:-2[${basePip}]`);
      filters.push(
        `[${String(clip.inputIndex)}:v]${cellFilter(outputDims, block.transform)},${shifted}[${scaledLabel}]`,
      );
      const midLabel = nextLabel();
      filters.push(`[${baseFull}][${scaledLabel}]overlay=0:0:${enable}[${midLabel}]`);
      const { x, y } = overlayPosition(block.position);
      const outLabel = nextLabel();
      filters.push(`[${midLabel}][${basePip}]overlay=${x}:${y}:${enable}[${outLabel}]`);
      currentVideo = outLabel;
    } else {
      const scale = block.scale ?? PIP_DEFAULT_SCALE;
      const pipWidth = 2 * Math.round((outputDims.width * scale) / 2);
      filters.push(
        `[${String(clip.inputIndex)}:v]scale=${String(pipWidth)}:-2,${shifted}[${scaledLabel}]`,
      );
      const { x, y } = overlayPosition(block.position);
      const outLabel = nextLabel();
      filters.push(`[${currentVideo}][${scaledLabel}]overlay=${x}:${y}:${enable}[${outLabel}]`);
      currentVideo = outLabel;
    }
  });

  overlayClips.forEach((clip, i) => {
    const start = clip.block.at;
    const end = start + clip.durationS;
    const enable = `enable='between(t,${fmt(start)},${fmt(end)})'`;
    const label = `o${String(i)}`;
    const chain: string[] = [];
    if (clip.block.scale !== undefined) {
      const w = 2 * Math.round((outputDims.width * clip.block.scale) / 2);
      chain.push(`scale=${String(w)}:-2`);
    } else {
      // The player stretches every scale-less overlay to the full frame and
      // ignores its position (`inset: 0` in Player.tsx) — mirror both halves,
      // or an agent-authored position-without-scale block lands at its native
      // size somewhere the preview never showed.
      chain.push(`scale=${String(outputDims.width)}:${String(outputDims.height)}`);
    }
    chain.push(`setpts=PTS-STARTPTS+${fmt(start)}/TB`);
    filters.push(`[${String(clip.inputIndex)}:v]${chain.join(',')}[${label}]`);
    const position =
      clip.block.scale !== undefined ? overlayPosition(clip.block.position) : { x: '0', y: '0' };
    const outLabel = nextLabel();
    filters.push(
      `[${currentVideo}][${label}]overlay=${position.x}:${position.y}:${enable}[${outLabel}]`,
    );
    currentVideo = outLabel;
  });

  // Subtitles are the LAST filter — an overlay drawn after them would hide them.
  if (subtitleCues !== undefined) {
    const theme = subtitleThemeFor(doc);
    const useSharedGraphic =
      theme.backgroundStyle === 'pill' && doc.subtitles.forceStyle === undefined;
    if (useSharedGraphic) {
      const settings = subtitleSettingsFor(doc);
      // Typography is laid out once in the authored output coordinate space.
      // A fast 720p preview scales those same pixels; it must never reflow the
      // text at a smaller width and choose different line breaks than final.
      const authoredSubtitleDimensions = {
        width: doc.output.width,
        height: doc.output.height,
      } as const;
      const manifestPath = subtitleGraphicsManifestPath({
        cues: subtitleCues,
        dimensions: authoredSubtitleDimensions,
        fps: doc.fps,
        durationS: expectedDurationS,
        settings,
        theme,
      });
      steps.push({
        kind: 'subtitle-graphics',
        label: 'render subtitle graphics',
        manifestPath,
        cues: subtitleCues,
        width: authoredSubtitleDimensions.width,
        height: authoredSubtitleDimensions.height,
        fps: doc.fps,
        durationS: expectedDurationS,
        settings,
        theme,
      });
      composeInputs.push('-f', 'concat', '-safe', '0', '-i', manifestPath);
      const graphicInputIndex = inputIndex;
      inputIndex += 1;
      const graphicLabel = nextLabel();
      const outLabel = nextLabel();
      filters.push(
        `[${String(graphicInputIndex)}:v]fps=${String(doc.fps)},scale=${String(outputDims.width)}:${String(outputDims.height)},format=rgba,setpts=PTS-STARTPTS[${graphicLabel}]`,
      );
      filters.push(
        `[${currentVideo}][${graphicLabel}]overlay=eof_action=pass:repeatlast=0:shortest=0[${outLabel}]`,
      );
      currentVideo = outLabel;
    } else {
      steps.splice(0, 0, {
        kind: 'write-file',
        path: SRT_PATH,
        content: cuesToSrt(subtitleCues),
      });
      const outLabel = nextLabel();
      filters.push(
        `[${currentVideo}]subtitles=filename=${escapeSubtitlesPath(SRT_PATH)}:force_style='${escapeForceStyle(forceStyleFor(doc))}'[${outLabel}]`,
      );
      currentVideo = outLabel;
    }
  }

  // Audio graph.
  const soloWindows = layerClips.filter((c) => c.block.audio === 'solo');
  const duckWindows = layerClips.filter((c) => c.block.audio === 'duck');
  const audibleLayers = [...soloWindows, ...duckWindows];
  const baseVolumeFilters = [
    ...soloWindows.map(
      (c) =>
        `volume=enable='between(t,${fmt(c.block.at)},${fmt(c.block.at + (c.block.out - c.block.in))})':volume=0`,
    ),
    ...duckWindows.map(
      (c) =>
        `volume=enable='between(t,${fmt(c.block.at)},${fmt(c.block.at + (c.block.out - c.block.in))})':volume=0.25`,
    ),
  ];

  let currentAudio = '0:a';
  if (audibleLayers.length > 0 || audioClips.length > 0) {
    filters.push(
      `[0:a]${baseVolumeFilters.length > 0 ? baseVolumeFilters.join(',') : 'anull'}[abase]`,
    );
    const mixLabels = ['abase'];
    audibleLayers.forEach((clip, i) => {
      const delayMs = Math.round(clip.block.at * 1000);
      const label = `al${String(i)}`;
      filters.push(
        `[${String(clip.inputIndex)}:a]adelay=${String(delayMs)}|${String(delayMs)}[${label}]`,
      );
      mixLabels.push(label);
    });
    audioClips.forEach((clip, i) => {
      const delayMs = Math.round(clip.block.at * 1000);
      const label = `aa${String(i)}`;
      const { fadeInS, fadeOutS } = resolveAudioBlockFades(
        clip.durationS,
        clip.block.fadeInS,
        clip.block.fadeOutS,
      );
      const chain = [
        `atrim=duration=${fmt(clip.durationS)}`,
        'asetpts=PTS-STARTPTS',
        'aformat=sample_rates=48000:channel_layouts=stereo',
        'apad',
        `atrim=duration=${fmt(clip.durationS)}`,
        ...(clip.block.gainDb !== undefined ? [`volume=${String(clip.block.gainDb)}dB`] : []),
        ...(fadeInS > 0 ? [`afade=t=in:st=0:d=${fmt(fadeInS)}`] : []),
        ...(fadeOutS > 0
          ? [`afade=t=out:st=${fmt(clip.durationS - fadeOutS)}:d=${fmt(fadeOutS)}`]
          : []),
        `adelay=${String(delayMs)}|${String(delayMs)}`,
      ];
      filters.push(`[${String(clip.inputIndex)}:a]${chain.join(',')}[${label}]`);
      mixLabels.push(label);
    });
    filters.push(
      `${mixLabels.map((l) => `[${l}]`).join('')}amix=inputs=${String(mixLabels.length)}:normalize=0[aout]`,
    );
    currentAudio = 'aout';
  }

  // Global export speed — applied LAST, after subtitles are already burned
  // into pixels: retiming both the (already-subtitled) video and the audio
  // by the same factor keeps caption-to-speech sync by construction, with no
  // separate SRT-time scaling needed. atempo covers 0.5–2 in one filter,
  // matching SPEED_BOUNDS.
  const globalSpeed = doc.output.speed ?? 1;
  if (globalSpeed !== 1) {
    const videoOutLabel = nextLabel();
    filters.push(`[${currentVideo}]setpts=PTS/${fmt(globalSpeed)}[${videoOutLabel}]`);
    currentVideo = videoOutLabel;
    const audioOutLabel = 'gspeeda';
    filters.push(`[${currentAudio}]atempo=${fmt(globalSpeed)}[${audioOutLabel}]`);
    currentAudio = audioOutLabel;
  }
  const finalExpectedDurationS = Math.round((expectedDurationS / globalSpeed) * doc.fps) / doc.fps;

  // Computed ONCE and reused below for both the composedPath routing and the
  // two-pass steps — the two must never see a different answer, or the
  // compose step writes to cache/composed.mov while nothing copies it to
  // outputPath, "succeeding" with no file at the end.
  const isLoudnormActive = loudnormActive(doc, options);
  const isDenoiseActive = denoiseActive(doc);
  const hasVideoFilters = filters.length > 0;
  const hasAudioPostProcessing = isLoudnormActive || isDenoiseActive;
  // Preserve PCM until denoise/loudnorm. Encoding AAC here and again in the
  // apply pass adds needless generation loss and would make the lightweight
  // .m4a proof measure a different intermediate than preview/final.
  const composedPath = hasAudioPostProcessing ? `${CACHE_DIR}/composed.mov` : outputPath;

  if (hasVideoFilters) {
    const videoMap = currentVideo.includes(':') ? currentVideo : `[${currentVideo}]`;
    const audioMap = currentAudio.includes(':') ? currentAudio : `[${currentAudio}]`;
    steps.push({
      kind: 'ffmpeg',
      label: 'compose',
      args: [
        ...composeInputs,
        '-filter_complex',
        filters.join(';'),
        '-map',
        videoMap,
        '-map',
        audioMap,
        '-t',
        fmt(finalExpectedDurationS),
        ...encodeArgs(options),
        ...(hasAudioPostProcessing ? SEGMENT_AUDIO_ARGS : AUDIO_ENCODE_ARGS),
        ...(composedPath === outputPath ? MP4_FASTSTART_ARGS : []),
        composedPath,
      ],
      output: composedPath,
    });
  } else {
    // Video copies straight through. With post-processing, audio remains PCM
    // in a MOV intermediate and is encoded to AAC exactly once afterwards.
    steps.push({
      kind: 'ffmpeg',
      label: 'remux',
      args: [
        '-y',
        '-i',
        composeBasePath,
        '-c:v',
        'copy',
        ...(hasAudioPostProcessing ? SEGMENT_AUDIO_ARGS : AUDIO_ENCODE_ARGS),
        ...(composedPath === outputPath ? MP4_FASTSTART_ARGS : []),
        composedPath,
      ],
      output: composedPath,
    });
  }

  // 5. Audio post-processing. Denoise is a first-class operation even when
  //    normalization is off. When loudnorm is on, afftdn prefixes BOTH the
  //    measurement and apply graphs so the measurement describes the same
  //    denoised signal that the final pass emits. Preview and final call this
  //    exact code path; only video dimensions/codec differ earlier.
  const denoise = denoiseFilter(doc.output.denoise, input.noiseFloorDb, input.noiseProfileBands);
  if (isLoudnormActive && doc.output.loudnormLufs !== null) {
    const loudnormTarget = doc.output.loudnormLufs;
    const loudnormSpec = `I=${String(loudnormTarget)}:TP=-1:LRA=11`;
    const denoisePrefix = denoise === '' ? '' : `${denoise},`;
    steps.push({
      kind: 'loudnorm-measure',
      args: [
        '-i',
        composedPath,
        '-af',
        `${denoisePrefix}loudnorm=${loudnormSpec}:print_format=json`,
        '-f',
        'null',
        '-',
      ],
    });
    steps.push({
      kind: 'loudnorm-apply',
      argsTemplate: [
        '-y',
        '-i',
        composedPath,
        '-c:v',
        'copy',
        '-af',
        `${denoisePrefix}loudnorm=${loudnormSpec}:measured_I=${LOUDNORM_PLACEHOLDERS.i}:measured_TP=${LOUDNORM_PLACEHOLDERS.tp}:measured_LRA=${LOUDNORM_PLACEHOLDERS.lra}:measured_thresh=${LOUDNORM_PLACEHOLDERS.thresh}:offset=${LOUDNORM_PLACEHOLDERS.offset}:linear=true`,
        ...AUDIO_ENCODE_ARGS,
        ...MP4_FASTSTART_ARGS,
        outputPath,
      ],
      output: outputPath,
    });
  } else if (denoise !== '') {
    steps.push({
      kind: 'ffmpeg',
      label: 'apply denoise',
      args: [
        '-y',
        '-i',
        composedPath,
        '-c:v',
        'copy',
        '-af',
        denoise,
        ...AUDIO_ENCODE_ARGS,
        ...MP4_FASTSTART_ARGS,
        outputPath,
      ],
      output: outputPath,
    });
  }

  return ok({
    steps,
    outputPath,
    expectedDurationS: finalExpectedDurationS,
    width: outputDims.width,
    height: outputDims.height,
    fps: doc.fps,
  });
}
