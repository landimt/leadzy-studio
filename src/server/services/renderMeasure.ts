import { isAbsolute, join } from 'node:path';
import { err, ok, type Result } from '../../core/result.js';
import { denoiseActive, LOUDNORM_PLACEHOLDERS } from '../../core/render/options.js';
import { type MediaProbe } from '../../core/render/plan.js';
import { baseTrackOf, type DenoiseSample, type EditDoc } from '../../core/schema.js';
import { detectSilences, type SilenceInterval } from '../../core/silence.js';
import { loadPcm, PCM_SAMPLE_RATE } from './audio.js';
import { runFfmpeg } from './ffmpeg.js';
import {
  intersectIntervals,
  noiseFloorDbFromSamples,
  parseAfftdnBandProfile,
} from './noiseFloor.js';

export interface LoudnormMeasurement {
  readonly input_i: string;
  readonly input_tp: string;
  readonly input_lra: string;
  readonly input_thresh: string;
  readonly target_offset: string;
}

/** loudnorm prints its measurement JSON as the tail of stderr. */
export function parseLoudnormJson(stderr: string): Result<LoudnormMeasurement> {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return err('ffmpeg-failed', 'loudnorm measurement JSON not found in ffmpeg output');
  }
  try {
    return ok(JSON.parse(stderr.slice(start, end + 1)) as LoudnormMeasurement);
  } catch (cause) {
    return err('ffmpeg-failed', 'loudnorm measurement JSON is unparseable', cause);
  }
}

export function substitutePlaceholders(
  template: readonly string[],
  measured: LoudnormMeasurement,
): string[] {
  return template.map((arg) =>
    arg
      .replaceAll(LOUDNORM_PLACEHOLDERS.i, measured.input_i)
      .replaceAll(LOUDNORM_PLACEHOLDERS.tp, measured.input_tp)
      .replaceAll(LOUDNORM_PLACEHOLDERS.lra, measured.input_lra)
      .replaceAll(LOUDNORM_PLACEHOLDERS.thresh, measured.input_thresh)
      .replaceAll(LOUDNORM_PLACEHOLDERS.offset, measured.target_offset),
  );
}

export interface MeasuredNoiseProfile {
  readonly floorDb?: number;
  readonly bands?: readonly number[];
}

const sampleTime = (seconds: number): string => seconds.toFixed(6);

/**
 * Learns afftdn's 15 custom frequency bands from exactly the selected
 * source-time window. `apad` supplies one short frame after the sample so
 * the stop command is delivered even when the window ends at media EOF; it
 * runs after `atrim`, therefore padded silence is never part of the sample.
 */
async function measureManualNoiseBands(
  projectDir: string,
  sourcePath: string,
  sample: DenoiseSample,
): Promise<Result<readonly number[]>> {
  const durationS = sample.end - sample.start;
  const paddingS = 0.05;
  const stopAt = sampleTime(durationS);
  const run = await runFfmpeg(
    [
      '-ss',
      sampleTime(sample.start),
      '-i',
      sourcePath,
      '-vn',
      '-af',
      `atrim=duration=${stopAt},asetpts=PTS-STARTPTS,apad=pad_dur=${sampleTime(paddingS)},asendcmd=c='0 afftdn sn start;${stopAt} afftdn sn stop',afftdn`,
      '-t',
      sampleTime(durationS + paddingS),
      '-f',
      'null',
      '-',
    ],
    { cwd: projectDir },
  );
  if (!run.ok) return run;
  const bands = parseAfftdnBandProfile(run.value.stderr);
  return bands === undefined
    ? err('ffmpeg-failed', 'afftdn did not return a 15-band profile for the selected noise sample')
    : ok(bands);
}

/**
 * Measures the noise model used by both preview and final render.
 *
 * Manual mode analyzes exactly `output.denoiseSample`: its RMS becomes
 * afftdn's scalar floor and ffmpeg's `sample_noise` command learns the
 * 15-band spectral shape. Automatic mode deliberately preserves the older
 * floor-only behavior: it detects silences in the first base source and
 * intersects them with the source windows actually used by the montage.
 */
export async function measureNoiseProfile(
  projectDir: string,
  doc: EditDoc,
  probes: ReadonlyMap<string, MediaProbe>,
): Promise<Result<MeasuredNoiseProfile>> {
  if (!denoiseActive(doc)) return ok({});

  const manual = doc.output.denoiseSample;
  if (manual !== undefined) {
    const source = doc.sources[manual.source];
    if (source === undefined) {
      return err(
        'invalid-edit-json',
        `denoise sample references unavailable source "${manual.source}"`,
      );
    }
    if (probes.get(manual.source)?.hasAudio !== true) {
      return err(
        'invalid-edit-json',
        `denoise sample source "${manual.source}" has no audio stream`,
      );
    }
    const sourceAbs = isAbsolute(source.path) ? source.path : join(projectDir, source.path);
    const pcm = await loadPcm(sourceAbs);
    if (!pcm.ok) return pcm;
    const floorDb = noiseFloorDbFromSamples(pcm.value, PCM_SAMPLE_RATE, [manual]);
    const bands = await measureManualNoiseBands(projectDir, source.path, manual);
    if (!bands.ok) return bands;
    return ok({ floorDb, bands: bands.value });
  }

  // Automatic fallback: floor only, learned from silence in the first base
  // take. This remains intentionally byte-compatible for existing docs.
  const base = baseTrackOf(doc);
  if (base.muted === true) return ok({});
  const firstBlock = base.blocks[0];
  const source = firstBlock ? doc.sources[firstBlock.source] : undefined;
  if (!firstBlock || !source) return ok({});
  const probe = probes.get(firstBlock.source);
  if (!probe?.hasAudio) return ok({});
  const sourceAbs = isAbsolute(source.path) ? source.path : join(projectDir, source.path);
  const pcm = await loadPcm(sourceAbs);
  if (!pcm.ok) return pcm;
  const silences = detectSilences(pcm.value, PCM_SAMPLE_RATE);
  const usedWindows: SilenceInterval[] = base.blocks
    .filter((block) => block.source === firstBlock.source)
    .map((block) => ({ start: block.in, end: block.out }));
  const scopedSilences = intersectIntervals(silences, usedWindows);
  return ok({ floorDb: noiseFloorDbFromSamples(pcm.value, PCM_SAMPLE_RATE, scopedSilences) });
}
