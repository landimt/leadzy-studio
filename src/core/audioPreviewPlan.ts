import { err, ok, type Result } from './result.js';
import {
  denoiseFilter,
  resolveAudioBlockFades,
  resolveAudioJoin,
  resolveJoinAudioFadeS,
  type ResolvedAudioJoin,
} from './render/audio.js';
import { validateVideoTrackMedia, visibleDoc } from './render/document.js';
import {
  AUDIO_ENCODE_ARGS,
  AUDIO_FADE_S,
  LOUDNORM_PLACEHOLDERS,
  loudnormActive,
} from './render/options.js';
import { type MediaProbe } from './render/plan.js';
import { quantizeAudioDuration, type RenderStep } from './render/steps.js';
import {
  baseTrackOf,
  isLayerBlock,
  type AudioBlock,
  type AudioTrack,
  type EditDoc,
  type LayerBlock,
} from './schema.js';
import { outputSegments } from './timeline.js';

export const AUDIO_PREVIEW_OUTPUT_PATH = 'edit/audio-preview.m4a';
export const AUDIO_PREVIEW_BEFORE_OUTPUT_PATH = 'edit/audio-preview-before.m4a';
const COMPOSED_PATH = 'edit/cache/audio-preview-composed.wav';
const BEFORE_COMPOSED_PATH = 'edit/cache/audio-preview-before-composed.wav';
const SAMPLE_RATE = 48_000;

const fmt = (seconds: number): string => seconds.toFixed(6);

function fadeFilters(durationS: number, fadeS: number): string[] {
  if (fadeS <= 0 || durationS <= 0) return [];
  const duration = Math.min(fadeS, durationS / 2);
  return [
    `afade=t=in:st=0:d=${fmt(duration)}`,
    `afade=t=out:st=${fmt(Math.max(0, durationS - duration))}:d=${fmt(duration)}`,
  ];
}

interface AudioInput {
  readonly inputIndex: number;
  readonly args: readonly string[];
}

function sourceInput(
  inputIndex: number,
  sourcePath: string | undefined,
  startS: number,
  durationS: number,
): AudioInput {
  if (sourcePath === undefined) {
    return {
      inputIndex,
      args: [
        '-f',
        'lavfi',
        '-t',
        fmt(durationS),
        '-i',
        `anullsrc=channel_layout=stereo:sample_rate=${String(SAMPLE_RATE)}`,
      ],
    };
  }
  return {
    inputIndex,
    // Input-side seek means ffmpeg only decodes the requested audio window;
    // this is the speed win over rendering even one video frame.
    args: ['-ss', fmt(startS), '-t', fmt(durationS), '-i', sourcePath],
  };
}

function segmentChain(input: {
  readonly inputIndex: number;
  readonly sourceDurationS: number;
  readonly outputDurationS: number;
  readonly speed: number;
  readonly fadeInS: number;
  readonly fadeOutS: number;
  readonly label: string;
}): string {
  const filters = [
    `atrim=duration=${fmt(input.sourceDurationS)}`,
    'asetpts=PTS-STARTPTS',
    `aformat=sample_rates=${String(SAMPLE_RATE)}:channel_layouts=stereo`,
    ...(input.speed === 1 ? [] : [`atempo=${fmt(input.speed)}`]),
    // Bound every stream exactly. Camera audio can finish a few samples
    // early after atempo; padding before the final trim keeps concat stable.
    'apad',
    `atrim=duration=${fmt(input.outputDurationS)}`,
    ...(input.fadeInS > 0
      ? [`afade=t=in:st=0:d=${fmt(Math.min(input.fadeInS, input.outputDurationS / 2))}`]
      : []),
    ...(input.fadeOutS > 0
      ? [
          `afade=t=out:st=${fmt(Math.max(0, input.outputDurationS - Math.min(input.fadeOutS, input.outputDurationS / 2)))}:d=${fmt(Math.min(input.fadeOutS, input.outputDurationS / 2))}`,
        ]
      : []),
  ];
  return `[${String(input.inputIndex)}:a]${filters.join(',')}[${input.label}]`;
}

function audioRunEnd(start: number, joins: readonly ResolvedAudioJoin[]): number {
  let end = start;
  while (joins[end + 1]?.kind === 'crossfade') end += 1;
  return end;
}

export interface AudioPreviewPlan {
  readonly steps: readonly RenderStep[];
  readonly outputPath: string;
  readonly beforeOutputPath: string;
  readonly composedPath: string;
  readonly beforeComposedPath: string;
  readonly expectedDurationS: number;
}

interface SingleAudioPreviewPlan {
  readonly steps: readonly RenderStep[];
  readonly outputPath: string;
  readonly composedPath: string;
  readonly expectedDurationS: number;
}

interface AudioPreviewPlanInput {
  readonly doc: EditDoc;
  readonly probes: ReadonlyMap<string, MediaProbe>;
  readonly noiseFloorDb?: number;
  readonly noiseProfileBands?: readonly number[];
  readonly artifactPaths?: {
    readonly outputPath: string;
    readonly beforeOutputPath: string;
    readonly composedPath: string;
    readonly beforeComposedPath: string;
  };
}

interface AudioPreviewVariantPaths {
  readonly outputPath: string;
  readonly composedPath: string;
  readonly montageLabel: string;
  readonly encodeLabel: string;
}

/**
 * Plans the exact audible program without a video stream. It intentionally
 * mirrors renderPlan's audio order: base montage/de-click/crossfade → layer
 * duck/solo mix → global speed → denoise → optional two-pass loudnorm.
 */
function planAudioPreviewVariant(
  input: AudioPreviewPlanInput,
  paths: AudioPreviewVariantPaths,
): Result<SingleAudioPreviewPlan> {
  const doc = visibleDoc(input.doc);
  const base = baseTrackOf(doc);
  const segments = outputSegments(doc);
  if (segments.length === 0) {
    return err('invalid-edit-json', 'base track has no blocks — nothing to preview');
  }

  const videoMediaValidation = validateVideoTrackMedia(doc, input.probes);
  if (!videoMediaValidation.ok) return videoMediaValidation;

  for (const segment of segments) {
    if (!doc.sources[segment.source] || !input.probes.has(segment.source)) {
      return err('not-found', `no media information for source "${segment.source}"`);
    }
  }

  const baseMuted = base.muted === true;
  const crossfadeMs = doc.output.joinAudioCrossfadeMs ?? 0;
  const canCrossfade =
    !baseMuted &&
    crossfadeMs > 0 &&
    segments.every((segment) => input.probes.get(segment.source)?.hasAudio === true);
  const joins: ResolvedAudioJoin[] = segments.map((segment, index) => {
    const previous = index > 0 ? segments[index - 1] : undefined;
    return previous && canCrossfade
      ? resolveAudioJoin(crossfadeMs, previous, segment, input.probes)
      : { kind: 'declick' };
  });
  const joinFadeS = resolveJoinAudioFadeS(doc);

  const inputArgs: string[] = [];
  const filters: string[] = [];
  let nextInputIndex = 0;
  const addInput = (
    sourcePath: string | undefined,
    startS: number,
    sourceDurationS: number,
  ): number => {
    const added = sourceInput(nextInputIndex, sourcePath, startS, sourceDurationS);
    inputArgs.push(...added.args);
    nextInputIndex += 1;
    return added.inputIndex;
  };

  const groupLabels: string[] = [];
  for (let cursor = 0; cursor < segments.length;) {
    const runEnd = audioRunEnd(cursor, joins);
    const inRun = runEnd > cursor;
    const labels: string[] = [];
    const durations: number[] = [];
    let plainDurationS = 0;

    for (let index = cursor; index <= runEnd; index += 1) {
      const segment = segments[index];
      if (segment === undefined) {
        return err('invalid-edit-json', 'internal audio segment index is inconsistent');
      }
      const before = index > cursor ? joins[index] : undefined;
      const after = index < runEnd ? joins[index + 1] : undefined;
      const extendBeforeS = before?.kind === 'crossfade' ? before.extendBS : 0;
      const extendAfterS = after?.kind === 'crossfade' ? after.extendAS : 0;
      // Match the video render's extraction grid exactly. Crossfade handles
      // can end between frames (for example 1.01s + 40ms at 25fps); ffmpeg's
      // final-render path quantizes that extended window before extracting it.
      const sourceDurationS = quantizeAudioDuration(
        segment.out - segment.in + extendBeforeS + extendAfterS,
        doc.fps,
      );
      const outputDurationS = inRun ? sourceDurationS : segment.outputEnd - segment.outputStart;
      const probe = input.probes.get(segment.source);
      const sourcePath =
        !baseMuted && probe?.hasAudio === true ? doc.sources[segment.source]?.path : undefined;
      const inputIndex = addInput(sourcePath, segment.in - extendBeforeS, sourceDurationS);
      const label = `base_${String(index)}`;
      const fadeInS = index === cursor ? joinFadeS : 0;
      const fadeOutS = index === runEnd ? joinFadeS : 0;
      filters.push(
        segmentChain({
          inputIndex,
          sourceDurationS,
          outputDurationS,
          speed: segment.speed,
          fadeInS,
          fadeOutS,
          label,
        }),
      );
      labels.push(label);
      durations.push(outputDurationS);
      plainDurationS += segment.outputEnd - segment.outputStart;
    }

    const groupLabel = `group_${String(groupLabels.length)}`;
    if (labels.length === 1) {
      const onlyLabel = labels[0];
      if (onlyLabel === undefined) {
        return err('invalid-edit-json', 'internal audio group is empty');
      }
      filters.push(`[${onlyLabel}]anull[${groupLabel}]`);
    } else {
      const firstLabel = labels[0];
      if (firstLabel === undefined) {
        return err('invalid-edit-json', 'internal audio crossfade group is empty');
      }
      let previousLabel = firstLabel;
      let cumulativeS = durations[0] ?? 0;
      for (let position = 1; position < labels.length; position += 1) {
        const join = joins[cursor + position];
        if (join?.kind !== 'crossfade') {
          return err('invalid-edit-json', 'internal audio-crossfade run is inconsistent');
        }
        const rawDurationS = join.extendAS + join.extendBS;
        const durationS = Math.min(rawDurationS, cumulativeS, durations[position] ?? rawDurationS);
        const mergedLabel = `cross_${String(cursor)}_${String(position)}`;
        const rightLabel = labels[position];
        if (rightLabel === undefined) {
          return err('invalid-edit-json', 'internal audio crossfade input is missing');
        }
        filters.push(
          `[${previousLabel}][${rightLabel}]acrossfade=d=${fmt(durationS)}:c1=tri:c2=tri[${mergedLabel}]`,
        );
        cumulativeS += (durations[position] ?? 0) - durationS;
        previousLabel = mergedLabel;
      }
      filters.push(`[${previousLabel}]apad,atrim=duration=${fmt(plainDurationS)}[${groupLabel}]`);
    }
    groupLabels.push(groupLabel);
    cursor = runEnd + 1;
  }

  const baseLabel = 'base_program';
  if (groupLabels.length === 1) {
    const onlyGroup = groupLabels[0];
    if (onlyGroup === undefined) {
      return err('invalid-edit-json', 'internal base audio group is missing');
    }
    filters.push(`[${onlyGroup}]anull[${baseLabel}]`);
  } else {
    filters.push(
      `${groupLabels.map((label) => `[${label}]`).join('')}concat=n=${String(groupLabels.length)}:v=0:a=1[${baseLabel}]`,
    );
  }

  const layerBlocks: LayerBlock[] = doc.tracks
    .slice(1)
    .filter((track) => track.kind === 'video')
    .flatMap((track) =>
      track.blocks
        .filter(isLayerBlock)
        .map((block): LayerBlock => (track.muted === true ? { ...block, audio: 'mute' } : block)),
    );
  const audibleLayers = layerBlocks.filter((block) => block.audio !== 'mute');
  const audioBlocks: AudioBlock[] = doc.tracks
    .filter((track): track is AudioTrack => track.kind === 'audio' && track.muted !== true)
    .flatMap((track) => track.blocks);
  const baseVolumeFilters = [
    ...audibleLayers
      .filter((block) => block.audio === 'solo')
      .map(
        (block) =>
          `volume=enable='between(t,${fmt(block.at)},${fmt(block.at + (block.out - block.in))})':volume=0`,
      ),
    ...audibleLayers
      .filter((block) => block.audio === 'duck')
      .map(
        (block) =>
          `volume=enable='between(t,${fmt(block.at)},${fmt(block.at + (block.out - block.in))})':volume=0.25`,
      ),
  ];

  let currentAudio = baseLabel;
  const addedLabels: string[] = [];
  if (audibleLayers.length > 0 || audioBlocks.length > 0) {
    const volumeLabel = 'base_volume';
    filters.push(
      `[${baseLabel}]${baseVolumeFilters.length > 0 ? baseVolumeFilters.join(',') : 'anull'}[${volumeLabel}]`,
    );
    for (const [index, block] of audibleLayers.entries()) {
      const durationS = quantizeAudioDuration(block.out - block.in, doc.fps);
      const probe = input.probes.get(block.source);
      const sourcePath = probe?.hasAudio === true ? doc.sources[block.source]?.path : undefined;
      if (!doc.sources[block.source] || !probe) {
        return err('not-found', `no media information for layer source "${block.source}"`);
      }
      const inputIndex = addInput(sourcePath, block.in, durationS);
      const label = `layer_${String(index)}`;
      const chain = [
        `atrim=duration=${fmt(durationS)}`,
        'asetpts=PTS-STARTPTS',
        `aformat=sample_rates=${String(SAMPLE_RATE)}:channel_layouts=stereo`,
        'apad',
        `atrim=duration=${fmt(durationS)}`,
        ...fadeFilters(durationS, AUDIO_FADE_S),
        `adelay=${String(Math.round(block.at * 1000))}:all=1`,
      ];
      filters.push(`[${String(inputIndex)}:a]${chain.join(',')}[${label}]`);
      addedLabels.push(label);
    }
    for (const [index, block] of audioBlocks.entries()) {
      const durationS = quantizeAudioDuration(block.out - block.in, doc.fps);
      const probe = input.probes.get(block.source);
      const source = doc.sources[block.source];
      if (!source || !probe) {
        return err('not-found', `no media information for audio source "${block.source}"`);
      }
      if (!probe.hasAudio) {
        return err('invalid-edit-json', `audio block source "${block.source}" has no audio stream`);
      }
      const inputIndex = addInput(source.path, block.in, durationS);
      const label = `audio_${String(index)}`;
      const { fadeInS, fadeOutS } = resolveAudioBlockFades(
        durationS,
        block.fadeInS,
        block.fadeOutS,
      );
      const chain = [
        `atrim=duration=${fmt(durationS)}`,
        'asetpts=PTS-STARTPTS',
        `aformat=sample_rates=${String(SAMPLE_RATE)}:channel_layouts=stereo`,
        'apad',
        `atrim=duration=${fmt(durationS)}`,
        ...(block.gainDb !== undefined ? [`volume=${String(block.gainDb)}dB`] : []),
        ...(fadeInS > 0 ? [`afade=t=in:st=0:d=${fmt(fadeInS)}`] : []),
        ...(fadeOutS > 0 ? [`afade=t=out:st=${fmt(durationS - fadeOutS)}:d=${fmt(fadeOutS)}`] : []),
        `adelay=${String(Math.round(block.at * 1000))}:all=1`,
      ];
      filters.push(`[${String(inputIndex)}:a]${chain.join(',')}[${label}]`);
      addedLabels.push(label);
    }
    filters.push(
      `${[volumeLabel, ...addedLabels].map((label) => `[${label}]`).join('')}amix=inputs=${String(addedLabels.length + 1)}:duration=longest:normalize=0[mixed]`,
    );
    currentAudio = 'mixed';
  }

  const montageDurationS = segments[segments.length - 1]?.outputEnd ?? 0;
  const globalSpeed = doc.output.speed ?? 1;
  const expectedDurationS = Math.round((montageDurationS / globalSpeed) * doc.fps) / doc.fps;
  const expectedSamples = Math.round(expectedDurationS * SAMPLE_RATE);
  // loudnorm upsamples internally and can otherwise flush a short filter tail
  // (observed +60ms on a 129.24s program). Normalize both A/B variants back
  // to 48 kHz and feed AAC exactly the same number of PCM samples.
  const outputDurationGuard = `aresample=${String(SAMPLE_RATE)},apad,atrim=end_sample=${String(expectedSamples)},asetpts=PTS-STARTPTS`;
  if (globalSpeed !== 1) {
    filters.push(`[${currentAudio}]atempo=${fmt(globalSpeed)}[sped]`);
    currentAudio = 'sped';
  }
  filters.push(`[${currentAudio}]apad,atrim=duration=${fmt(expectedDurationS)}[program]`);

  const steps: RenderStep[] = [
    {
      kind: 'ffmpeg',
      label: paths.montageLabel,
      args: [
        '-y',
        ...inputArgs,
        '-filter_complex',
        filters.join(';'),
        '-map',
        '[program]',
        '-vn',
        '-c:a',
        'pcm_s16le',
        '-ar',
        String(SAMPLE_RATE),
        '-ac',
        '2',
        paths.composedPath,
      ],
      output: paths.composedPath,
    },
  ];

  const denoise = denoiseFilter(doc.output.denoise, input.noiseFloorDb, input.noiseProfileBands);
  const treatedPath = `${paths.composedPath}.treated.wav`;
  let encodeInput = paths.composedPath;
  if (loudnormActive(doc, { loudnorm: true }) && doc.output.loudnormLufs !== null) {
    const spec = `I=${String(doc.output.loudnormLufs)}:TP=-1:LRA=11`;
    const prefix = denoise === '' ? '' : `${denoise},`;
    steps.push(
      {
        kind: 'loudnorm-measure',
        args: [
          '-i',
          paths.composedPath,
          '-af',
          `${prefix}loudnorm=${spec}:print_format=json`,
          '-f',
          'null',
          '-',
        ],
      },
      {
        kind: 'loudnorm-apply',
        argsTemplate: [
          '-y',
          '-i',
          paths.composedPath,
          '-vn',
          '-af',
          `${prefix}loudnorm=${spec}:measured_I=${LOUDNORM_PLACEHOLDERS.i}:measured_TP=${LOUDNORM_PLACEHOLDERS.tp}:measured_LRA=${LOUDNORM_PLACEHOLDERS.lra}:measured_thresh=${LOUDNORM_PLACEHOLDERS.thresh}:offset=${LOUDNORM_PLACEHOLDERS.offset}:linear=true`,
          '-c:a',
          'pcm_f32le',
          '-ar',
          String(SAMPLE_RATE),
          '-ac',
          '2',
          treatedPath,
        ],
        output: treatedPath,
      },
    );
    encodeInput = treatedPath;
  } else if (denoise !== '') {
    steps.push({
      kind: 'ffmpeg',
      label: 'apply noise reduction',
      args: [
        '-y',
        '-i',
        paths.composedPath,
        '-vn',
        '-af',
        denoise,
        '-c:a',
        'pcm_f32le',
        '-ar',
        String(SAMPLE_RATE),
        '-ac',
        '2',
        treatedPath,
      ],
      output: treatedPath,
    });
    encodeInput = treatedPath;
  }
  // The DSP stage above is lossless PCM. Both variants now pass through this
  // identical finalizer, which removes filter latency and performs AAC's only
  // lossy encode from the exact same 48 kHz sample-count contract.
  steps.push({
    kind: 'ffmpeg',
    label: paths.encodeLabel,
    args: [
      '-y',
      '-i',
      encodeInput,
      '-vn',
      '-af',
      outputDurationGuard,
      ...AUDIO_ENCODE_ARGS,
      paths.outputPath,
    ],
    output: paths.outputPath,
  });

  return ok({
    steps,
    outputPath: paths.outputPath,
    composedPath: paths.composedPath,
    expectedDurationS,
  });
}

/**
 * Builds an A/B proof in one deterministic job. "Before" preserves the
 * montage, audible layers, global/block speed and de-click fades, while
 * disabling only crossfade, denoise and loudness normalization. "After" is
 * the exact audio chain used by the current export path.
 */
export function planAudioPreview(input: AudioPreviewPlanInput): Result<AudioPreviewPlan> {
  const artifactPaths = input.artifactPaths ?? {
    outputPath: AUDIO_PREVIEW_OUTPUT_PATH,
    beforeOutputPath: AUDIO_PREVIEW_BEFORE_OUTPUT_PATH,
    composedPath: COMPOSED_PATH,
    beforeComposedPath: BEFORE_COMPOSED_PATH,
  };
  const beforeDoc: EditDoc = {
    ...input.doc,
    output: {
      ...input.doc.output,
      denoise: 0,
      loudnormLufs: null,
      joinAudioCrossfadeMs: 0,
    },
  };
  const before = planAudioPreviewVariant(
    { ...input, doc: beforeDoc },
    {
      outputPath: artifactPaths.beforeOutputPath,
      composedPath: artifactPaths.beforeComposedPath,
      montageLabel: 'assemble untreated audio',
      encodeLabel: 'encode untreated audio',
    },
  );
  if (!before.ok) return before;

  const after = planAudioPreviewVariant(input, {
    outputPath: artifactPaths.outputPath,
    composedPath: artifactPaths.composedPath,
    montageLabel: 'assemble audio preview',
    encodeLabel: 'encode audio preview',
  });
  if (!after.ok) return after;
  if (before.value.expectedDurationS !== after.value.expectedDurationS) {
    return err('invalid-edit-json', 'audio comparison variants have inconsistent durations');
  }

  return ok({
    steps: [...before.value.steps, ...after.value.steps],
    beforeOutputPath: before.value.outputPath,
    outputPath: after.value.outputPath,
    beforeComposedPath: before.value.composedPath,
    composedPath: after.value.composedPath,
    expectedDurationS: after.value.expectedDurationS,
  });
}
