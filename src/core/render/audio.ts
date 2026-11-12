import { type BlockTransition, type EditDoc, type VideoBlock } from '../schema.js';
import { type OutputSegment } from '../timeline.js';
import type { MediaProbe } from '../media.js';
import type { RenderOptions } from './options.js';
import {
  AUDIO_FADE_S,
  MIN_CROSSFADE_OVERLAP_S,
  NOISE_FLOOR_FALLBACK_DB,
  NOISE_FLOOR_MIN_DB,
  NOISE_FLOOR_MAX_DB,
} from './options.js';
import type { RenderStep } from './steps.js';
import {
  CACHE_DIR,
  encodeArgs,
  SEGMENT_AUDIO_ARGS,
  SEGMENT_AUDIO_SAMPLE_RATE,
  SEGMENT_AUDIO_TIMING_FILTER,
  fmt,
  cacheableFfmpegStep,
  cacheableExtractStep,
} from './steps.js';
import type { Dimensions } from './canvas.js';
import { cellFilter } from './canvas.js';

/**
 * Same idea as `MIN_CROSSFADE_OVERLAP_S` for `doc.output.joinAudioCrossfadeMs`
 * joins — lower ceiling (200ms max, 100ms per side) than the video
 * transition's, so the floor is scaled down too.
 */
const MIN_AUDIO_CROSSFADE_OVERLAP_S = 0.02;

/** Resolves the base-track joint fade from the doc, in seconds. 0 disables it. */
export function resolveJoinAudioFadeS(doc: EditDoc): number {
  const ms = doc.output.joinAudioFadeMs ?? AUDIO_FADE_S * 1000;
  return ms / 1000;
}

export interface ResolvedAudioBlockFades {
  readonly fadeInS: number;
  readonly fadeOutS: number;
}

/**
 * Resolves user-authored audio-block ramps together with the fixed edge
 * de-click. A user ramp replaces (rather than stacks with) the de-click on
 * that edge. If frame-grid quantization makes the clip slightly shorter than
 * the schema-validated source window, requested ramps keep priority and only
 * the remaining time is shared between de-click extensions.
 */
export function resolveAudioBlockFades(
  durationS: number,
  requestedFadeInS = 0,
  requestedFadeOutS = 0,
): ResolvedAudioBlockFades {
  const duration = Math.max(0, durationS);
  if (duration === 0) return { fadeInS: 0, fadeOutS: 0 };

  let fadeInS = Math.min(duration, Math.max(0, requestedFadeInS));
  let fadeOutS = Math.min(duration, Math.max(0, requestedFadeOutS));
  const requestedTotal = fadeInS + fadeOutS;
  if (requestedTotal > duration) {
    const scale = duration / requestedTotal;
    fadeInS *= scale;
    fadeOutS *= scale;
  }

  const desiredInS = Math.max(fadeInS, AUDIO_FADE_S);
  const desiredOutS = Math.max(fadeOutS, AUDIO_FADE_S);
  const extraNeededInS = desiredInS - fadeInS;
  const extraNeededOutS = desiredOutS - fadeOutS;
  const totalExtraNeededS = extraNeededInS + extraNeededOutS;
  const availableExtraS = Math.max(0, duration - fadeInS - fadeOutS);
  if (totalExtraNeededS <= availableExtraS) {
    return { fadeInS: desiredInS, fadeOutS: desiredOutS };
  }
  if (totalExtraNeededS === 0 || availableExtraS === 0) {
    return { fadeInS, fadeOutS };
  }
  return {
    fadeInS: fadeInS + availableExtraS * (extraNeededInS / totalExtraNeededS),
    fadeOutS: fadeOutS + availableExtraS * (extraNeededOutS / totalExtraNeededS),
  };
}

/**
 * Half the configured transition duration, clamped to half of the segment it
 * paints on — same clamp shape as the audio de-click fade above, so a short
 * segment never gets a video dip longer than the segment itself.
 */
function transitionFadeS(transitionDurationS: number, segmentDurationS: number): number {
  return Math.min(transitionDurationS / 2, segmentDurationS / 2);
}

function transitionFadeColor(type: 'fade-black' | 'fade-white'): 'black' | 'white' {
  return type === 'fade-white' ? 'white' : 'black';
}

/**
 * What a base-track boundary actually does, resolved once up front so the
 * extraction/merge code never has to re-derive it: 'none' (no transition),
 * 'dip' (fade-black/fade-white, or a crossfade degraded to it — see below),
 * or 'crossfade' (a real blend, with the clamped per-side extension already
 * computed).
 */
export type ResolvedJoin =
  | { readonly kind: 'none' }
  | { readonly kind: 'dip'; readonly color: 'black' | 'white'; readonly durationS: number }
  | { readonly kind: 'crossfade'; readonly extendAS: number; readonly extendBS: number };

/**
 * Resolves one base-track boundary's transition. A crossfade extends segment
 * A past its own `out` and segment B before its own `in`, each by up to
 * durationS/2, clamped to what the SOURCE actually has past/before that
 * point (never to the neighbouring segment's own length — reading a bit
 * further into the same source file is always safe). If the clamped total is
 * too short to read as a blend, it degrades to the same fade-black dip a
 * plain `fade-black` transition would produce, at the ORIGINAL requested
 * duration (fade-black doesn't need extra source material, so there's
 * nothing to clamp there).
 */
export function resolveJoin(
  transition: BlockTransition | undefined,
  segmentA: OutputSegment,
  segmentB: OutputSegment,
  probes: ReadonlyMap<string, MediaProbe>,
): ResolvedJoin {
  if (!transition) return { kind: 'none' };
  if (transition.type !== 'crossfade') {
    return {
      kind: 'dip',
      color: transitionFadeColor(transition.type),
      durationS: transition.durationS,
    };
  }
  // Each side's extension is clamped against ITS OWN available source
  // material, in that side's own source-time units; converting either to
  // output time means dividing by that side's own speed. A blend needs one
  // shared overlap window on both of xfade's input streams, so unequal
  // speeds would force re-deriving the whole offset chain across mixed time
  // bases. Degrade to the same dip a plain fade-black would produce instead.
  if (segmentA.speed !== 1 || segmentB.speed !== 1) {
    return { kind: 'dip', color: 'black', durationS: transition.durationS };
  }
  const probeA = probes.get(segmentA.source);
  const probeB = probes.get(segmentB.source);
  if (probeA?.kind !== 'video' || probeB?.kind !== 'video') {
    return { kind: 'dip', color: 'black', durationS: transition.durationS };
  }
  const half = transition.durationS / 2;
  const extendAS = Math.min(half, Math.max(0, probeA.durationS - segmentA.out));
  const extendBS = Math.min(half, segmentB.in);
  if (extendAS + extendBS < MIN_CROSSFADE_OVERLAP_S) {
    return { kind: 'dip', color: 'black', durationS: transition.durationS };
  }
  return { kind: 'crossfade', extendAS, extendBS };
}

function transitionFadeExpr(
  kind: 'in' | 'out',
  startS: number,
  durationS: number,
  color: 'black' | 'white',
): string {
  const colorArg = color === 'white' ? ':color=white' : '';
  return `fade=t=${kind}:st=${fmt(startS)}:d=${fmt(durationS)}${colorArg}`;
}

/**
 * Video-level dip filters for one base segment: a fade-in when THIS
 * boundary resolved to a dip (never on segment 0 — nothing precedes it to
 * dip from), and a fade-out when the NEXT boundary resolved to a dip on
 * this segment's tail. A boundary resolved to 'crossfade' contributes no dip
 * here — the blend is painted by the crossfade merge step instead. Both
 * fades are baked inside the segment's own extracted window, so total
 * output duration is unaffected — the concat below stays a straight -c
 * copy, same reasoning as the audio fades.
 */
export function segmentDipFilters(
  index: number,
  resolvedJoins: readonly ResolvedJoin[],
  segmentDurationS: number,
): string[] {
  const filters: string[] = [];

  const own = resolvedJoins[index];
  if (own?.kind === 'dip') {
    const fadeInS = transitionFadeS(own.durationS, segmentDurationS);
    // A segment quantized to ~0 frames (degenerate but schema-legal: only
    // out>in is required) would otherwise emit a zero-duration fade filter.
    if (fadeInS > 0) {
      filters.push(transitionFadeExpr('in', 0, fadeInS, own.color));
    }
  }

  const next = resolvedJoins[index + 1];
  if (next?.kind === 'dip') {
    const fadeOutS = transitionFadeS(next.durationS, segmentDurationS);
    if (fadeOutS > 0) {
      filters.push(transitionFadeExpr('out', segmentDurationS - fadeOutS, fadeOutS, next.color));
    }
  }

  return filters;
}

/**
 * Same dip fades as segmentDipFilters, rebased onto a crossfade-extended
 * clip's timeline. The extended clip starts extendBeforeS before the plain
 * segment's own start, so any time position inside the plain segment shifts
 * right by extendBeforeS. A run segment has at most one dip neighbour: the
 * boundary consumed by the crossfade (own or next, whichever is 'crossfade')
 * never coincides with a dip on the same side — see resolveJoin/crossfadeRunEnd.
 */
function extendedSegmentDipFilters(
  index: number,
  resolvedJoins: readonly ResolvedJoin[],
  segmentDurationS: number,
  extendBeforeS: number,
  extendAfterS: number,
  extendedLengthS: number,
): string[] {
  const filters: string[] = [];

  const own = resolvedJoins[index];
  if (own?.kind === 'dip') {
    const fadeInS = transitionFadeS(own.durationS, segmentDurationS);
    if (fadeInS > 0) {
      filters.push(transitionFadeExpr('in', extendBeforeS, fadeInS, own.color));
    }
  }

  const next = resolvedJoins[index + 1];
  if (next?.kind === 'dip') {
    const fadeOutS = transitionFadeS(next.durationS, segmentDurationS);
    if (fadeOutS > 0) {
      filters.push(
        transitionFadeExpr('out', extendedLengthS - extendAfterS - fadeOutS, fadeOutS, next.color),
      );
    }
  }

  return filters;
}

/** `setpts=PTS/speed` for the video chain, or '' when speed is natural (1) — keeps args byte-identical when unused. */
export function speedVideoFilter(speed: number): string {
  return speed === 1 ? '' : `setpts=PTS/${fmt(speed)}`;
}

/** Last index at or after `start` such that every boundary in [start+1..end] resolved to a real crossfade. */
export function crossfadeRunEnd(start: number, resolvedJoins: readonly ResolvedJoin[]): number {
  let end = start;
  while (resolvedJoins[end + 1]?.kind === 'crossfade') end += 1;
  return end;
}

/**
 * Merges base segments [runStart..runEnd] — chained by real crossfade
 * boundaries — into ONE ffmpeg-cacheable step. Video comes from a left-to-
 * right chain of `xfade` filters over each block's own window, extended by
 * the clamped amount resolved for its crossfade boundaries; audio is the
 * plain `concat` of each block's UNEXTENDED, already-declicked track (the
 * same file the normal per-segment extraction produces). Because each
 * xfade's `duration` exactly equals the two extensions it consumes, the
 * merged clip's total length is exactly the sum of the run's plain segment
 * durations — same invariant as the fade-black dip, just via a filter
 * instead of a baked-in fade. Returns undefined if a segment in the run is
 * missing its plain step (defensive; the pre-render probe check should
 * already rule this out).
 */
export function buildCrossfadeMergeStep(input: {
  readonly runStart: number;
  readonly runEnd: number;
  readonly doc: EditDoc;
  readonly segments: readonly OutputSegment[];
  readonly baseBlocks: readonly VideoBlock[];
  readonly resolvedJoins: readonly ResolvedJoin[];
  readonly plainSteps: readonly (Extract<RenderStep, { kind: 'ffmpeg-cacheable' }> | undefined)[];
  readonly outputDims: Dimensions;
  readonly probes: ReadonlyMap<string, MediaProbe>;
  readonly sourceFingerprints: ReadonlyMap<string, string>;
  readonly options: RenderOptions;
  readonly totalSegments: number;
  readonly baseMuted: boolean;
}):
  | {
      readonly mergeStep: Extract<RenderStep, { kind: 'ffmpeg-cacheable' }>;
      readonly extraSteps: readonly RenderStep[];
    }
  | undefined {
  const {
    runStart,
    runEnd,
    doc,
    segments,
    baseBlocks,
    resolvedJoins,
    plainSteps,
    outputDims,
    probes,
    sourceFingerprints,
    options,
    totalSegments,
    baseMuted,
  } = input;
  const indices = Array.from({ length: runEnd - runStart + 1 }, (_, k) => runStart + k);

  const extendBeforeOf = (index: number): number => {
    if (index === runStart) return 0;
    const join = resolvedJoins[index];
    return join?.kind === 'crossfade' ? join.extendBS : 0;
  };
  const extendAfterOf = (index: number): number => {
    if (index === runEnd) return 0;
    const join = resolvedJoins[index + 1];
    return join?.kind === 'crossfade' ? join.extendAS : 0;
  };

  const extraSteps: RenderStep[] = [];
  const videoPaths: string[] = [];
  const audioPaths: string[] = [];
  const extendedLengthsS: number[] = [];
  const fingerprintKeyParts: string[] = [];

  for (const index of indices) {
    const segment = segments[index];
    const plain = plainSteps[index];
    const block = segment ? baseBlocks[segment.blockIndex] : undefined;
    if (!segment || !plain || !block) return undefined;
    const probe = probes.get(segment.source);
    const source = doc.sources[segment.source];
    const fingerprint = sourceFingerprints.get(segment.source);
    if (!probe || !source || fingerprint === undefined) return undefined;

    const extendBeforeS = extendBeforeOf(index);
    const extendAfterS = extendAfterOf(index);
    const extendedInS = segment.in - extendBeforeS;
    const extendedOutS = segment.out + extendAfterS;
    const extendedLengthS = Math.round((extendedOutS - extendedInS) * doc.fps) / doc.fps;
    extendedLengthsS.push(extendedLengthS);
    fingerprintKeyParts.push(fingerprint);

    if (extendBeforeS === 0 && extendAfterS === 0) {
      videoPaths.push(plain.output);
    } else {
      const segmentDurationS = segment.outputEnd - segment.outputStart;
      // A crossfade join only reaches this branch when both sides resolved
      // to speed 1 (see resolveJoin) — block.speed here is always natural,
      // kept explicit rather than assumed so the filter stays correct if
      // that invariant ever loosens.
      const videoFilter = [
        cellFilter(outputDims, block.transform),
        speedVideoFilter(block.speed ?? 1),
        ...extendedSegmentDipFilters(
          index,
          resolvedJoins,
          segmentDurationS,
          extendBeforeS,
          extendAfterS,
          extendedLengthS,
        ),
      ]
        .filter((part) => part !== '')
        .join(',');
      const extended = cacheableExtractStep({
        label: `crossfade extend segment ${String(index + 1)}/${String(totalSegments)}`,
        sourcePath: source.path,
        inS: extendedInS,
        outS: extendedOutS,
        fps: doc.fps,
        videoFilter,
        // Only the video is consumed from this clip — audio comes from the
        // plain (unextended) segment below, which already applies baseMuted
        // — matching it here avoids decoding+encoding real audio into a
        // cache file whose audio stream nothing ever reads.
        hasAudio: probe.hasAudio && !baseMuted,
        options,
        audioFadeS: 0,
        speed: block.speed ?? 1,
        sourceFingerprint: fingerprint,
      });
      extraSteps.push(extended);
      videoPaths.push(extended.output);
    }
    audioPaths.push(plain.output);
  }

  const trackCount = indices.length;
  const filterParts: string[] = [];
  let previousLabel = '0:v';
  let cumulativeS = extendedLengthsS[0] ?? 0;
  for (let p = 1; p < trackCount; p += 1) {
    const join = resolvedJoins[runStart + p];
    if (join?.kind !== 'crossfade') return undefined;
    const durationS = join.extendAS + join.extendBS;
    const offsetS = cumulativeS - durationS;
    const outLabel = `xf${String(p)}`;
    filterParts.push(
      `[${previousLabel}][${String(p)}:v]xfade=transition=fade:duration=${fmt(durationS)}:offset=${fmt(offsetS)}[${outLabel}]`,
    );
    cumulativeS = cumulativeS + (extendedLengthsS[p] ?? 0) - durationS;
    previousLabel = outLabel;
  }
  const audioLabels = Array.from({ length: trackCount }, (_, p) => `${String(trackCount + p)}:a`);
  filterParts.push(
    `${audioLabels.map((l) => `[${l}]`).join('')}concat=n=${String(trackCount)}:v=0:a=1[a]`,
  );

  const plainDurationS = indices.reduce((sum, index) => {
    const segment = segments[index];
    return sum + (segment ? segment.outputEnd - segment.outputStart : 0);
  }, 0);

  const argsWithoutOutput = [
    '-y',
    ...videoPaths.flatMap((p) => ['-i', p]),
    ...audioPaths.flatMap((p) => ['-i', p]),
    '-filter_complex',
    filterParts.join(';'),
    '-map',
    `[${previousLabel}]`,
    '-map',
    '[a]',
    '-t',
    fmt(plainDurationS),
    ...encodeArgs(options),
    ...SEGMENT_AUDIO_ARGS,
  ];

  const mergeStep = cacheableFfmpegStep({
    label: `crossfade join segments ${String(runStart + 1)}-${String(runEnd + 1)}/${String(totalSegments)}`,
    argsWithoutOutput,
    cacheInput: fingerprintKeyParts.join('|'),
  });
  return { mergeStep, extraSteps };
}

// --- Feature C: doc.output.joinAudioCrossfadeMs — audio-only crossfade at
// every base joint. Runs as a PARALLEL pipeline: the video steps above never
// change ("Vídeo NÃO muda"); this builds an independent audio track and
// remuxes it onto the video concat's own output at the very end.

/**
 * What one base-track boundary's AUDIO does, resolved independently of that
 * boundary's VIDEO transition: 'declick' (today's per-segment edge fades,
 * `doc.output.joinAudioFadeMs`) or 'crossfade' with the clamped per-side
 * extension — same shape as `ResolvedJoin`, without a 'none' case because
 * every boundary gets SOME audio treatment.
 */
export type ResolvedAudioJoin =
  | { readonly kind: 'declick' }
  | { readonly kind: 'crossfade'; readonly extendAS: number; readonly extendBS: number };

/**
 * Resolves one boundary's audio crossfade. Degrades to 'declick' — the
 * existing edge-fade behavior — when either side has non-1 speed (extending
 * each side's clamp to output time would divide by that side's own speed,
 * and the two sides' overlap windows would stop matching, same reasoning as
 * `resolveJoin`'s video crossfade), or when there isn't enough source
 * material on both sides to read as a blend.
 */
export function resolveAudioJoin(
  crossfadeMs: number,
  segmentA: OutputSegment,
  segmentB: OutputSegment,
  probes: ReadonlyMap<string, MediaProbe>,
): ResolvedAudioJoin {
  if (segmentA.speed !== 1 || segmentB.speed !== 1) return { kind: 'declick' };
  const probeA = probes.get(segmentA.source);
  const probeB = probes.get(segmentB.source);
  if (probeA?.kind !== 'video' || probeB?.kind !== 'video') return { kind: 'declick' };
  const half = crossfadeMs / 2000;
  const extendAS = Math.min(half, Math.max(0, probeA.durationS - segmentA.out));
  const extendBS = Math.min(half, segmentB.in);
  if (extendAS + extendBS < MIN_AUDIO_CROSSFADE_OVERLAP_S) return { kind: 'declick' };
  return { kind: 'crossfade', extendAS, extendBS };
}

/** Last index at or after `start` such that every boundary in [start+1..end] resolved to a real audio crossfade. */
function crossfadeAudioRunEnd(
  start: number,
  resolvedAudioJoins: readonly ResolvedAudioJoin[],
): number {
  let end = start;
  while (resolvedAudioJoins[end + 1]?.kind === 'crossfade') end += 1;
  return end;
}

interface AudioExtractionInput {
  readonly sourcePath: string;
  readonly inS: number;
  readonly outS: number;
  readonly fps: number;
  readonly fadeInS: number;
  readonly fadeOutS: number;
  /** Playback rate of this base segment; standalone declick clips may be retimed. */
  readonly speed: number;
}

/** Audio-only extraction args — no video decode, so declick sections stay cheap. */
/** Output length of an extracted audio clip: its source span at its speed, snapped to the frame grid. */
function extractedAudioDurationS(inS: number, outS: number, speed: number, fps: number): number {
  return Math.round(((outS - inS) / speed) * fps) / fps;
}

function buildAudioExtractionArgs(input: AudioExtractionInput): string[] {
  const duration = extractedAudioDurationS(input.inS, input.outS, input.speed, input.fps);
  const clampedIn = Math.min(input.fadeInS, duration / 2);
  const clampedOut = Math.min(input.fadeOutS, duration / 2);
  const audioFilters: string[] = [SEGMENT_AUDIO_TIMING_FILTER];
  if (input.speed !== 1) audioFilters.push(`atempo=${fmt(input.speed)}`);
  if (clampedIn > 0) audioFilters.push(`afade=t=in:st=0:d=${fmt(clampedIn)}`);
  if (clampedOut > 0) {
    audioFilters.push(
      `afade=t=out:st=${fmt(Math.max(0, duration - clampedOut))}:d=${fmt(clampedOut)}`,
    );
  }
  return [
    '-y',
    '-ss',
    fmt(input.inS),
    '-i',
    input.sourcePath,
    '-t',
    fmt(duration),
    '-vn',
    ...(audioFilters.length > 0 ? ['-af', audioFilters.join(',')] : []),
    ...SEGMENT_AUDIO_ARGS,
  ];
}

function cacheableAudioExtractStep(
  input: AudioExtractionInput & { readonly label: string; readonly sourceFingerprint: string },
): Extract<RenderStep, { kind: 'ffmpeg-cacheable' }> {
  const args = buildAudioExtractionArgs(input);
  return cacheableFfmpegStep({
    label: input.label,
    argsWithoutOutput: args,
    cacheArgsWithoutOutput: args.map((arg, index) =>
      args[index - 1] === '-i' && arg === input.sourcePath ? '<source-media>' : arg,
    ),
    cacheInput: input.sourceFingerprint,
  });
}

/**
 * Merges audio segments [runStart..runEnd] — chained by real audio-crossfade
 * boundaries — into ONE ffmpeg-cacheable step. Each clip gets a triangular
 * fade-in over the overlap it shares with the previous clip and a fade-out
 * over the one it shares with the next, is delayed to its place on the
 * output line, and `amix` (normalize=0) sums them. Two triangular ramps that
 * cross sum to unity, so this is exactly a left-to-right `acrossfade=c1=tri:
 * c2=tri` chain, mirroring `buildCrossfadeMergeStep`'s video `xfade` chain.
 *
 * It is not written AS that chain because a chained `acrossfade` is unsafe
 * on FFmpeg 7.1: with clips under ~0.4s its output length changes from run
 * to run, truncating the audio or leaving no stream at all. Fades and
 * delays are placed in samples, from the same frame-snapped clip length the
 * extraction writes, so nothing here depends on how ffmpeg schedules frames.
 *
 * Each overlap is still clamped against the accumulated line and the
 * incoming clip, as the chain needed (the schema only guarantees
 * `out > in`, so a short block could otherwise overrun it). The explicit
 * `-t` (sum of the run's plain, unextended output durations) is what
 * guarantees the exact total duration, same as the video merge's own
 * `-t plainDurationS`.
 */
function buildAudioCrossfadeMergeStep(input: {
  readonly runStart: number;
  readonly runEnd: number;
  readonly doc: EditDoc;
  readonly segments: readonly OutputSegment[];
  readonly baseBlocks: readonly VideoBlock[];
  readonly resolvedAudioJoins: readonly ResolvedAudioJoin[];
  readonly sourceFingerprints: ReadonlyMap<string, string>;
  readonly joinAudioFadeS: number;
  readonly totalSegments: number;
}):
  | {
      readonly mergeStep: Extract<RenderStep, { kind: 'ffmpeg-cacheable' }>;
      readonly extraSteps: readonly RenderStep[];
    }
  | undefined {
  const {
    runStart,
    runEnd,
    doc,
    segments,
    baseBlocks,
    resolvedAudioJoins,
    sourceFingerprints,
    joinAudioFadeS,
    totalSegments,
  } = input;
  const indices = Array.from({ length: runEnd - runStart + 1 }, (_, k) => runStart + k);

  const extendBeforeOf = (index: number): number => {
    if (index === runStart) return 0;
    const join = resolvedAudioJoins[index];
    return join?.kind === 'crossfade' ? join.extendBS : 0;
  };
  const extendAfterOf = (index: number): number => {
    if (index === runEnd) return 0;
    const join = resolvedAudioJoins[index + 1];
    return join?.kind === 'crossfade' ? join.extendAS : 0;
  };

  const extraSteps: RenderStep[] = [];
  const audioPaths: string[] = [];
  const extendedLengthsS: number[] = [];
  let plainTotalS = 0;
  const fingerprintKeyParts: string[] = [];

  for (const index of indices) {
    const segment = segments[index];
    const block = segment ? baseBlocks[segment.blockIndex] : undefined;
    if (!segment || !block) return undefined;
    const source = doc.sources[segment.source];
    const fingerprint = sourceFingerprints.get(segment.source);
    if (!source || fingerprint === undefined) return undefined;

    const extendBeforeS = extendBeforeOf(index);
    const extendAfterS = extendAfterOf(index);
    const extendedInS = segment.in - extendBeforeS;
    const extendedOutS = segment.out + extendAfterS;
    extendedLengthsS.push(
      extractedAudioDurationS(extendedInS, extendedOutS, segment.speed, doc.fps),
    );
    plainTotalS += segment.outputEnd - segment.outputStart;
    fingerprintKeyParts.push(fingerprint);

    const clip = cacheableAudioExtractStep({
      label: `audio crossfade extend segment ${String(index + 1)}/${String(totalSegments)}`,
      sourcePath: source.path,
      inS: extendedInS,
      outS: extendedOutS,
      fps: doc.fps,
      // Only the RUN's outer edges keep the declick fade — every boundary
      // inside the run is a crossfade by construction (see crossfadeAudioRunEnd).
      fadeInS: index === runStart ? joinAudioFadeS : 0,
      fadeOutS: index === runEnd ? joinAudioFadeS : 0,
      speed: segment.speed,
      sourceFingerprint: fingerprint,
    });
    extraSteps.push(clip);
    audioPaths.push(clip.output);
  }

  const trackCount = indices.length;
  const samples = (seconds: number): number => Math.round(seconds * SEGMENT_AUDIO_SAMPLE_RATE);
  // overlapsS[p]: the crossfade between clip p-1 and clip p; startsS[p]: where clip p begins
  const overlapsS: number[] = [0];
  const startsS: number[] = [0];
  let cumulativeS = extendedLengthsS[0] ?? 0;
  for (let p = 1; p < trackCount; p += 1) {
    const join = resolvedAudioJoins[runStart + p];
    if (join?.kind !== 'crossfade') return undefined;
    const rawDurationS = join.extendAS + join.extendBS;
    const durationS = Math.min(rawDurationS, cumulativeS, extendedLengthsS[p] ?? rawDurationS);
    overlapsS.push(durationS);
    startsS.push(cumulativeS - durationS);
    cumulativeS = cumulativeS + (extendedLengthsS[p] ?? 0) - durationS;
  }

  const filterParts: string[] = [];
  for (let p = 0; p < trackCount; p += 1) {
    const chain: string[] = [];
    const fadeIn = samples(overlapsS[p] ?? 0);
    if (fadeIn > 0) chain.push(`afade=t=in:curve=tri:ss=0:ns=${String(fadeIn)}`);
    const fadeOut = samples(overlapsS[p + 1] ?? 0);
    if (fadeOut > 0) {
      const lengthSamples = samples(extendedLengthsS[p] ?? 0);
      chain.push(
        `afade=t=out:curve=tri:ss=${String(lengthSamples - fadeOut)}:ns=${String(fadeOut)}`,
      );
    }
    const delay = samples(startsS[p] ?? 0);
    if (delay > 0) chain.push(`adelay=delays=${String(delay)}S:all=1`);
    filterParts.push(
      `[${String(p)}:a]${chain.length > 0 ? chain.join(',') : 'anull'}[xf${String(p)}]`,
    );
  }
  const mixInputs = Array.from({ length: trackCount }, (_, p) => `[xf${String(p)}]`).join('');
  filterParts.push(
    `${mixInputs}amix=inputs=${String(trackCount)}:normalize=0:duration=longest[xfmix]`,
  );

  const argsWithoutOutput = [
    '-y',
    ...audioPaths.flatMap((p) => ['-i', p]),
    '-filter_complex',
    filterParts.join(';'),
    '-map',
    '[xfmix]',
    '-t',
    fmt(plainTotalS),
    ...SEGMENT_AUDIO_ARGS,
  ];

  const mergeStep = cacheableFfmpegStep({
    label: `audio crossfade join segments ${String(runStart + 1)}-${String(runEnd + 1)}/${String(totalSegments)}`,
    argsWithoutOutput,
    cacheInput: fingerprintKeyParts.join('|'),
  });
  return { mergeStep, extraSteps };
}

/**
 * When `doc.output.joinAudioCrossfadeMs` is active, builds the parallel
 * audio-only pipeline described above and remuxes its output onto
 * `basePath`'s own video (`-c copy` both streams — no re-encode). Returns
 * undefined — caller keeps using `basePath` unchanged — when: the setting is
 * off/0, the base is muted (the anullsrc path is moot for silence), any base
 * source lacks an audio stream (the audio-only extraction here has no
 * anullsrc branch to fall back on), or every boundary degraded to 'declick'
 * (nothing to build).
 */
export function buildAudioCrossfadeBase(input: {
  readonly doc: EditDoc;
  readonly segments: readonly OutputSegment[];
  readonly baseBlocks: readonly VideoBlock[];
  readonly probes: ReadonlyMap<string, MediaProbe>;
  readonly sourceFingerprints: ReadonlyMap<string, string>;
  readonly joinAudioFadeS: number;
  readonly baseMuted: boolean;
  readonly basePath: string;
}): { readonly steps: readonly RenderStep[]; readonly basePath: string } | undefined {
  const {
    doc,
    segments,
    baseBlocks,
    probes,
    sourceFingerprints,
    joinAudioFadeS,
    baseMuted,
    basePath,
  } = input;
  const crossfadeMs = doc.output.joinAudioCrossfadeMs ?? 0;
  if (crossfadeMs <= 0 || baseMuted) return undefined;
  if (!segments.every((s) => probes.get(s.source)?.hasAudio === true)) return undefined;
  const resolvedAudioJoins: ResolvedAudioJoin[] = segments.map((segment, i) => {
    const previous = i > 0 ? segments[i - 1] : undefined;
    if (!previous) return { kind: 'declick' };
    return resolveAudioJoin(crossfadeMs, previous, segment, probes);
  });
  if (resolvedAudioJoins.every((join) => join.kind === 'declick')) return undefined;

  // Built lazily, only for segments that actually end up on the declick path
  // (the normal case: neither neighbouring boundary crossfades) or as the
  // defensive fallback below — a segment fully covered by a crossfade run
  // gets its audio exclusively from `buildAudioCrossfadeMergeStep`'s own
  // extended extraction, so pre-building an unused declick step here would
  // be pure waste (an extra ffmpeg call whose output nothing ever reads).
  function buildDeclickStep(
    i: number,
  ): Extract<RenderStep, { kind: 'ffmpeg-cacheable' }> | undefined {
    const segment = segments[i];
    const source = segment ? doc.sources[segment.source] : undefined;
    const fingerprint = segment ? sourceFingerprints.get(segment.source) : undefined;
    if (!segment || !source || fingerprint === undefined) return undefined;
    const boundaryBefore = resolvedAudioJoins[i];
    const boundaryAfter = resolvedAudioJoins[i + 1];
    return cacheableAudioExtractStep({
      label: `audio segment ${String(i + 1)}/${String(segments.length)}`,
      sourcePath: source.path,
      inS: segment.in,
      outS: segment.out,
      fps: doc.fps,
      // Suppressed on whichever side an active crossfade already covers —
      // stacking both would double the gain ramp at that boundary.
      fadeInS: boundaryBefore?.kind === 'crossfade' ? 0 : joinAudioFadeS,
      fadeOutS: boundaryAfter?.kind === 'crossfade' ? 0 : joinAudioFadeS,
      speed: segment.speed,
      sourceFingerprint: fingerprint,
    });
  }

  const steps: RenderStep[] = [];
  const audioPaths: string[] = [];
  for (let cursor = 0; cursor < segments.length;) {
    const runEnd = crossfadeAudioRunEnd(cursor, resolvedAudioJoins);
    if (runEnd === cursor) {
      const step = buildDeclickStep(cursor);
      if (step) {
        steps.push(step);
        audioPaths.push(step.output);
      }
      cursor += 1;
      continue;
    }
    const built = buildAudioCrossfadeMergeStep({
      runStart: cursor,
      runEnd,
      doc,
      segments,
      baseBlocks,
      resolvedAudioJoins,
      sourceFingerprints,
      joinAudioFadeS,
      totalSegments: segments.length,
    });
    if (built) {
      steps.push(...built.extraSteps, built.mergeStep);
      audioPaths.push(built.mergeStep.output);
    } else {
      for (let k = cursor; k <= runEnd; k += 1) {
        const step = buildDeclickStep(k);
        if (step) {
          steps.push(step);
          audioPaths.push(step.output);
        }
      }
    }
    cursor = runEnd + 1;
  }

  const concatListPath = `${CACHE_DIR}/segments/concat-audio.txt`;
  steps.push({
    kind: 'write-file',
    path: concatListPath,
    content: audioPaths.map((p) => `file '${p.split('/').pop() ?? p}'`).join('\n') + '\n',
  });
  const audioBasePath = `${CACHE_DIR}/base-audio.mov`;
  steps.push({
    kind: 'ffmpeg',
    label: 'concat crossfaded audio line',
    args: ['-y', '-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', audioBasePath],
    output: audioBasePath,
  });

  const remuxedPath = `${CACHE_DIR}/base-crossfade-audio.mov`;
  steps.push({
    kind: 'ffmpeg',
    label: 'remux base with crossfaded audio',
    args: [
      '-y',
      '-i',
      basePath,
      '-i',
      audioBasePath,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c',
      'copy',
      remuxedPath,
    ],
    output: remuxedPath,
  });

  return { steps, basePath: remuxedPath };
}

function clampNoiseFloorDb(value: number): number {
  if (!Number.isFinite(value)) return NOISE_FLOOR_FALLBACK_DB;
  return Math.min(NOISE_FLOOR_MAX_DB, Math.max(NOISE_FLOOR_MIN_DB, value));
}

/**
 * `afftdn` filter for the final audio chain, or '' when denoise is off.
 * `nr` (dB of reduction) maps the 0–1 UI knob onto afftdn's 6–24 dB usable
 * range. A valid 15-band profile learned from an explicit room-tone sample
 * switches afftdn to its custom spectral model; malformed caller input is
 * ignored so it can never produce an unsafe/invalid filtergraph.
 */
export function denoiseFilter(
  denoise: number | undefined,
  noiseFloorDb: number | undefined,
  noiseProfileBands: readonly number[] | undefined,
): string {
  if (!denoise || denoise <= 0) return '';
  const nf = clampNoiseFloorDb(noiseFloorDb ?? NOISE_FLOOR_FALLBACK_DB);
  const nr = 6 + Math.min(1, Math.max(0, denoise)) * 18;
  const validBands =
    noiseProfileBands?.length === 15 &&
    noiseProfileBands.every((band) => Number.isFinite(band) && band >= -120 && band <= 120)
      ? noiseProfileBands
      : undefined;
  const profile = validBands
    ? `:nt=c:bn='${validBands.map((band) => band.toFixed(6)).join(' ')}'`
    : '';
  return `afftdn=nf=${nf.toFixed(1)}:nr=${nr.toFixed(1)}${profile}`;
}
