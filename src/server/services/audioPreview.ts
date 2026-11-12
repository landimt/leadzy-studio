import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AUDIO_PREVIEW_BEFORE_OUTPUT_PATH,
  AUDIO_PREVIEW_OUTPUT_PATH,
  planAudioPreview,
} from '../../core/audioPreviewPlan.js';
import { audioPreviewSemanticKey } from '../../core/audioPreviewFreshness.js';
import { err, ok, type Result } from '../../core/result.js';
import { visibleDoc } from '../../core/render/document.js';
import type { EditDoc } from '../../core/schema.js';
import { probeDuration, runFfmpeg } from './ffmpeg.js';
import { editDocHash } from './project.js';
import { renderInputFingerprints, writeRenderReceipt } from './renderReceipt.js';
import { acquireProjectLock, ProjectLockBusyError } from './projectLock.js';
import {
  acquireResolvedProjectMedia,
  probeResolvedProjectMedia,
  type ResolvedProjectMediaLease,
} from './resolvedMedia.js';
import type { RenderProgress } from './render.js';
import {
  measureNoiseProfile,
  parseLoudnormJson,
  substitutePlaceholders,
  type LoudnormMeasurement,
} from './renderMeasure.js';

export interface AudioPreviewOutcome {
  readonly outputRel: string;
  readonly outputAbs: string;
  readonly beforeOutputRel: string;
  readonly beforeOutputAbs: string;
  readonly durationS: number;
  readonly expectedDurationS: number;
  readonly editHash: string;
  /** Audio-only dependency key; unlike editHash it ignores visual-only edits. */
  readonly semanticKey: string;
}

async function renameIfPresent(source: string, destination: string): Promise<boolean> {
  try {
    await rename(source, destination);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw cause;
  }
}

interface AudioComparisonArtifact {
  readonly temporary: string;
  readonly public: string;
  readonly backup: string;
}

/** Promotes validated outputs and their receipt together, retaining the previous set for rollback. */
async function promoteAudioComparison(input: {
  readonly artifacts: readonly AudioComparisonArtifact[];
}): Promise<Result<void>> {
  const backedUp: AudioComparisonArtifact[] = [];
  const promoted: AudioComparisonArtifact[] = [];

  const rollback = async (): Promise<void> => {
    const failures: unknown[] = [];
    for (const artifact of promoted.toReversed()) {
      try {
        await rm(artifact.public, { force: true });
      } catch (cause) {
        failures.push(cause);
      }
    }
    for (const artifact of backedUp.toReversed()) {
      try {
        await rename(artifact.backup, artifact.public);
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'audio comparison rollback failed');
    }
  };

  try {
    for (const artifact of input.artifacts) {
      if (await renameIfPresent(artifact.public, artifact.backup)) backedUp.push(artifact);
    }
    for (const artifact of input.artifacts) {
      await rename(artifact.temporary, artifact.public);
      promoted.push(artifact);
    }
    return ok(undefined);
  } catch (cause) {
    try {
      await rollback();
    } catch (rollbackCause) {
      return err('io-failed', 'could not restore the previous audio comparison', {
        cause,
        rollbackCause,
      });
    }
    return err('io-failed', 'could not publish the new audio comparison', cause);
  }
}

/**
 * Produces a lightweight, audio-only proof using the same document snapshot
 * and post-processing decisions as preview/final. No video stream is decoded
 * or encoded, so turning a LUFS/denoise knob remains practical.
 */
export async function renderAudioPreview(
  projectDir: string,
  doc: EditDoc,
  onProgress?: (progress: RenderProgress) => void,
): Promise<Result<AudioPreviewOutcome>> {
  const renderDoc = structuredClone(doc);
  const renderEditHash = editDocHash(renderDoc);
  const renderSemanticKey = audioPreviewSemanticKey(renderDoc);
  const beforeOutputAbs = join(projectDir, AUDIO_PREVIEW_BEFORE_OUTPUT_PATH);
  const outputAbs = join(projectDir, AUDIO_PREVIEW_OUTPUT_PATH);
  const jobDirRel = `edit/cache/audio-preview-jobs/${randomUUID()}`;
  const jobDirAbs = join(projectDir, jobDirRel);
  const temporaryBeforeRel = `${jobDirRel}/before.m4a`;
  const temporaryAfterRel = `${jobDirRel}/after.m4a`;
  const temporaryBeforeAbs = join(projectDir, temporaryBeforeRel);
  const temporaryAfterAbs = join(projectDir, temporaryAfterRel);
  const stagedReceiptProjectDir = join(jobDirAbs, 'receipt-project');
  const stagedReceiptCacheDir = join(stagedReceiptProjectDir, 'edit', 'cache');
  let lock;
  let mediaLease: ResolvedProjectMediaLease | undefined;
  try {
    lock = await acquireProjectLock(projectDir, 'audio-preview');
  } catch (cause) {
    return cause instanceof ProjectLockBusyError
      ? err('io-failed', 'an audio preview for this project is already in progress', cause)
      : err('io-failed', 'could not reserve the audio preview', cause);
  }

  const snapshotPath = join(projectDir, 'edit', 'cache', 'audio-preview.edit.json');
  try {
    const visible = visibleDoc(renderDoc);
    const leased = await acquireResolvedProjectMedia(projectDir, visible);
    if (!leased.ok) return leased;
    mediaLease = leased.value;
    const executionDoc = mediaLease.doc;
    const probes = await probeResolvedProjectMedia(executionDoc);
    if (!probes.ok) return probes;
    const authoringInputs = await renderInputFingerprints(
      projectDir,
      visible,
      'audio-preview',
      undefined,
      mediaLease.authoringMediaHashes,
    );
    if (!authoringInputs.ok) return authoringInputs;
    const pinnedInputs = await renderInputFingerprints(
      projectDir,
      visible,
      'audio-preview',
      executionDoc,
    );
    if (!pinnedInputs.ok) return pinnedInputs;
    const noise = await measureNoiseProfile(projectDir, executionDoc, probes.value);
    if (!noise.ok) return noise;
    const planned = planAudioPreview({
      doc: executionDoc,
      probes: probes.value,
      ...(noise.value.floorDb !== undefined ? { noiseFloorDb: noise.value.floorDb } : {}),
      ...(noise.value.bands !== undefined ? { noiseProfileBands: noise.value.bands } : {}),
      artifactPaths: {
        beforeOutputPath: temporaryBeforeRel,
        outputPath: temporaryAfterRel,
        beforeComposedPath: `${jobDirRel}/before-composed.wav`,
        composedPath: `${jobDirRel}/after-composed.wav`,
      },
    });
    if (!planned.ok) return planned;

    let measurement: LoudnormMeasurement | null = null;
    const { steps } = planned.value;
    try {
      for (const [index, step] of steps.entries()) {
        const label =
          step.kind === 'ffmpeg'
            ? step.label
            : step.kind === 'loudnorm-measure'
              ? 'measure loudness'
              : step.kind === 'loudnorm-apply'
                ? 'normalize audio'
                : step.kind;
        onProgress?.({ step: label, index: index + 1, total: steps.length });

        if (step.kind === 'ffmpeg') {
          if (step.output !== undefined) {
            await mkdir(dirname(join(projectDir, step.output)), { recursive: true });
          }
          const run = await runFfmpeg(step.args, { cwd: projectDir });
          if (!run.ok) return run;
          continue;
        }
        if (step.kind === 'loudnorm-measure') {
          const run = await runFfmpeg(step.args, { cwd: projectDir });
          if (!run.ok) return run;
          const parsed = parseLoudnormJson(run.value.stderr);
          if (!parsed.ok) return parsed;
          measurement = parsed.value;
          continue;
        }
        if (step.kind !== 'loudnorm-apply') {
          return err('ffmpeg-failed', `unsupported audio preview step: ${step.kind}`);
        }
        if (measurement === null) {
          return err('ffmpeg-failed', 'normalization reached without loudness measurement');
        }
        await mkdir(dirname(join(projectDir, step.output)), { recursive: true });
        const args = Number.isFinite(Number(measurement.input_i))
          ? substitutePlaceholders(step.argsTemplate, measurement)
          : [
              '-y',
              '-i',
              planned.value.composedPath,
              '-vn',
              '-c:a',
              'pcm_f32le',
              '-ar',
              '48000',
              '-ac',
              '2',
              step.output,
            ];
        const run = await runFfmpeg(args, { cwd: projectDir });
        if (!run.ok) return run;
      }
    } finally {
      await Promise.all([
        rm(join(projectDir, planned.value.beforeComposedPath), { force: true }),
        rm(join(projectDir, planned.value.composedPath), { force: true }),
      ]);
    }

    const beforeDuration = await probeDuration(temporaryBeforeAbs);
    if (!beforeDuration.ok) return beforeDuration;
    const duration = await probeDuration(temporaryAfterAbs);
    if (!duration.ok) return duration;
    const durationToleranceS = 1 / 48_000 + 1e-6;
    if (
      Math.abs(beforeDuration.value - duration.value) > durationToleranceS ||
      Math.abs(beforeDuration.value - planned.value.expectedDurationS) > durationToleranceS ||
      Math.abs(duration.value - planned.value.expectedDurationS) > durationToleranceS
    ) {
      return err(
        'ffmpeg-failed',
        `the before/after audio versions ended up with different durations (before ${beforeDuration.value.toFixed(3)}s, after ${duration.value.toFixed(3)}s, expected ${planned.value.expectedDurationS.toFixed(3)}s)`,
      );
    }

    const completedAuthoringInputs = await renderInputFingerprints(
      projectDir,
      visible,
      'audio-preview',
    );
    if (!completedAuthoringInputs.ok) return completedAuthoringInputs;
    const completedPinnedInputs = await renderInputFingerprints(
      projectDir,
      visible,
      'audio-preview',
      executionDoc,
    );
    if (!completedPinnedInputs.ok) return completedPinnedInputs;
    if (
      JSON.stringify(completedAuthoringInputs.value) !== JSON.stringify(authoringInputs.value) ||
      JSON.stringify(completedPinnedInputs.value) !== JSON.stringify(pinnedInputs.value)
    ) {
      return err(
        'io-failed',
        'project media changed during the audio preview; generate the preview again',
      );
    }
    try {
      await writeRenderReceipt(
        stagedReceiptProjectDir,
        'audio-preview',
        renderDoc,
        authoringInputs.value,
      );
    } catch (cause) {
      return err('io-failed', 'could not prepare the audio comparison receipt', cause);
    }
    const inputsPath = join(projectDir, 'edit', 'cache', 'audio-preview.inputs.json');
    const promoted = await promoteAudioComparison({
      artifacts: [
        {
          temporary: temporaryBeforeAbs,
          public: beforeOutputAbs,
          backup: join(jobDirAbs, 'previous-before.m4a'),
        },
        {
          temporary: temporaryAfterAbs,
          public: outputAbs,
          backup: join(jobDirAbs, 'previous-after.m4a'),
        },
        {
          temporary: join(stagedReceiptCacheDir, 'audio-preview.edit.json'),
          public: snapshotPath,
          backup: join(jobDirAbs, 'previous-receipt-edit.json'),
        },
        {
          temporary: join(stagedReceiptCacheDir, 'audio-preview.inputs.json'),
          public: inputsPath,
          backup: join(jobDirAbs, 'previous-receipt-inputs.json'),
        },
      ],
    });
    if (!promoted.ok) return promoted;

    return ok({
      outputRel: AUDIO_PREVIEW_OUTPUT_PATH,
      outputAbs,
      beforeOutputRel: AUDIO_PREVIEW_BEFORE_OUTPUT_PATH,
      beforeOutputAbs,
      durationS: duration.value,
      expectedDurationS: planned.value.expectedDurationS,
      editHash: renderEditHash,
      semanticKey: renderSemanticKey,
    });
  } finally {
    await rm(jobDirAbs, { recursive: true, force: true }).catch(() => undefined);
    await mediaLease?.release();
    await lock.release();
  }
}
