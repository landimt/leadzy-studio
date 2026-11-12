import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { err, ok, type Result } from '../../core/result.js';
import { visibleRenderDoc } from '../../core/render/document.js';
import { programKey } from '../../core/render/freshness.js';
import {
  AUDIO_ENCODE_ARGS,
  MP4_FASTSTART_ARGS,
  type RenderArtifactKind,
  type RenderOptions,
  renderArtifactKind,
} from '../../core/render/options.js';
import { planRender } from '../../core/render/plan.js';
import { type EditDoc } from '../../core/schema.js';
import { ffmpegCapabilities, probeMedia, runFfmpeg, withRenderDefaults } from './ffmpeg.js';
import { hasFreshProxy, proxyRelPath } from './proxy.js';
import { mediaHash } from './mediaHash.js';
import { editDocHash } from './project.js';
import { renderInputFingerprints, writeRenderReceipt } from './renderReceipt.js';
import { loadProjectTranscripts } from './projectTranscripts.js';
import { acquireProjectLock, ProjectLockBusyError } from './projectLock.js';
import {
  acquireResolvedProjectMedia,
  probeResolvedProjectMedia,
  type ResolvedProjectMediaLease,
} from './resolvedMedia.js';
import { pruneSubtitleGraphicsCache, renderSubtitleGraphics } from './subtitleGraphics.js';
import {
  measureNoiseProfile,
  parseLoudnormJson,
  substitutePlaceholders,
  type LoudnormMeasurement,
} from './renderMeasure.js';
import {
  promoteRenderPublication,
  publicationArtifacts,
  recoverRenderPublicationsUnderLock,
  removePublicationJob,
} from './renderPublication.js';

const CACHE_DIR_COMPOSED = 'edit/cache/composed.mov';
const SEGMENT_CACHE_DIR = 'edit/cache/segments';
const MAX_CACHED_SEGMENTS = 200;
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const SEGMENT_EXT = '.mov';
const TMP_MARKER = '.tmp-';
/**
 * Only tmp files older than this are swept as "abandoned" (crashed render).
 * A younger one may belong to a DIFFERENT process extracting the same
 * project concurrently (e.g. the CLI rendering while the dev server also
 * renders) — deleting its tmp path out from under an open write descriptor
 * would fail that process's rename() with ENOENT.
 */
const STALE_TMP_MS = 10 * 60 * 1000;

/**
 * ffmpeg picks its muxer from the output filename's extension, so the tmp
 * path used for an in-progress extraction must still end in `.mov` — the
 * marker goes in the middle, not appended after it.
 */
function tmpSegmentPath(finalRelPath: string, index: number): string {
  const stem = finalRelPath.endsWith(SEGMENT_EXT)
    ? finalRelPath.slice(0, -SEGMENT_EXT.length)
    : finalRelPath;
  return `${stem}${TMP_MARKER}${String(process.pid)}-${String(index)}${SEGMENT_EXT}`;
}

export interface RenderProgress {
  readonly step: string;
  readonly index: number;
  readonly total: number;
}

export interface RenderOutcome {
  readonly kind: RenderArtifactKind;
  readonly outputRel: string;
  readonly outputAbs: string;
  readonly durationS: number;
  readonly expectedDurationS: number;
  /** Hash of the immutable edit snapshot that produced this exact artifact. */
  readonly editHash: string;
  /** Whether this artifact was produced with the canonical Studio render profile. */
  readonly canonical: boolean;
  /** Program projection of the rendered snapshot — what the player compares the live document against. */
  readonly programKey: string;
}

async function buildSourceFingerprints(
  projectDir: string,
  doc: EditDoc,
): Promise<Result<Map<string, string>>> {
  const fingerprints = new Map<string, string>();
  for (const [key, source] of Object.entries(doc.sources)) {
    const sourceAbs = isAbsolute(source.path) ? source.path : join(projectDir, source.path);
    const hash = await mediaHash(sourceAbs);
    if (!hash.ok) return hash;
    fingerprints.set(key, hash.value);
  }
  return ok(fingerprints);
}

async function isNonEmptyFile(absolutePath: string): Promise<boolean> {
  try {
    const info = await stat(absolutePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

async function listDirEntries(absoluteDir: string): Promise<Dirent[]> {
  try {
    return await readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Content-addressed segments are kept across renders on purpose — that's
 * the cache. This bounds them instead of wiping them: drop stray partial
 * writes from an interrupted render, then evict whole segments oldest
 * mtime first once the cache exceeds the count or size cap. mtime is set at
 * extraction time and deliberately NOT refreshed on a cache hit — a segment
 * still referenced by the current doc ages out no differently than one that
 * isn't, but that keeps "was this file touched by ffmpeg" unambiguous for
 * callers (and tests) that need to tell a cache hit from a re-extraction.
 */
async function pruneSegmentCache(projectDir: string): Promise<void> {
  const dir = join(projectDir, SEGMENT_CACHE_DIR);
  const entries = await listDirEntries(dir);

  const tmpEntries = entries.filter((e) => e.isFile() && e.name.includes(TMP_MARKER));
  const now = Date.now();
  await Promise.all(
    tmpEntries.map(async (e) => {
      const path = join(dir, e.name);
      const info = await stat(path).catch(() => null);
      if (info && now - info.mtimeMs > STALE_TMP_MS) await rm(path, { force: true });
    }),
  );

  const segmentFiles = entries.filter(
    (e) => e.isFile() && e.name.endsWith(SEGMENT_EXT) && !e.name.includes(TMP_MARKER),
  );
  const statOrNull = async (
    e: Dirent,
  ): Promise<{ path: string; size: number; mtimeMs: number } | null> => {
    const path = join(dir, e.name);
    // A concurrent process may have pruned or replaced this file between the
    // readdir above and this stat — treat a vanished entry as already gone.
    const info = await stat(path).catch(() => null);
    return info ? { path, size: info.size, mtimeMs: info.mtimeMs } : null;
  };
  const withStats = (await Promise.all(segmentFiles.map(statOrNull))).filter(
    (f): f is { path: string; size: number; mtimeMs: number } => f !== null,
  );
  withStats.sort((a, b) => a.mtimeMs - b.mtimeMs);

  let totalBytes = withStats.reduce((sum, f) => sum + f.size, 0);
  let count = withStats.length;
  for (const file of withStats) {
    if (count <= MAX_CACHED_SEGMENTS && totalBytes <= MAX_CACHE_BYTES) break;
    await rm(file.path, { force: true });
    totalBytes -= file.size;
    count -= 1;
  }
}

/**
 * Renders a project: plan (pure) → execute step by step with cwd at the
 * project folder, so every relative path in the plan stays contained.
 */
export async function renderProject(
  projectDir: string,
  doc: EditDoc,
  requestedOptions: RenderOptions,
  onProgress?: (progress: RenderProgress) => void,
): Promise<Result<RenderOutcome>> {
  // Capture before the first await: the caller/UI may continue editing while
  // ffmpeg is busy. Every probe, plan, snapshot and returned hash below must
  // describe the same immutable document that actually produced the file.
  const renderDoc = structuredClone(doc);
  const renderEditHash = editDocHash(renderDoc);
  const capabilities = await ffmpegCapabilities();
  const options = withRenderDefaults(requestedOptions, capabilities.ok ? capabilities.value : null);

  let lock;
  let mediaLease: ResolvedProjectMediaLease | undefined;
  try {
    // UI and CLI publish the same fixed artifacts/cache paths. Only one
    // process may render a project at a time, otherwise an output can be
    // paired with another render's snapshot.
    lock = await acquireProjectLock(projectDir, 'render');
  } catch (cause) {
    return cause instanceof ProjectLockBusyError
      ? err('io-failed', 'já existe um render deste projeto em andamento', cause)
      : err('io-failed', 'não foi possível reservar o projeto para renderização', cause);
  }

  try {
    const recovered = await recoverRenderPublicationsUnderLock(projectDir);
    if (!recovered.ok) return recovered;
    const visible = visibleRenderDoc(renderDoc);
    const leased = await acquireResolvedProjectMedia(projectDir, visible);
    if (!leased.ok) return leased;
    mediaLease = leased.value;
    return await renderProjectLocked(
      projectDir,
      renderDoc,
      visible,
      mediaLease.doc,
      mediaLease.authoringMediaHashes,
      renderEditHash,
      options,
      onProgress,
    );
  } finally {
    await mediaLease?.release();
    await lock.release();
  }
}

/**
 * Previews read video from the 540p proxy the player already uses whenever
 * it is fresh for that source — decoding a 4K original is what makes a
 * preview slow, and the preview exists to check the cut, not the pixels.
 * Audio still comes from the original (see `ExtractionInput.videoSourcePath`).
 */
export async function previewVideoSourcesFor(
  projectDir: string,
  doc: EditDoc,
): Promise<Map<string, string>> {
  const proxies = new Map<string, string>();
  for (const [key, source] of Object.entries(doc.sources)) {
    if (await hasFreshProxy(projectDir, source.path)) proxies.set(key, proxyRelPath(source.path));
  }
  return proxies;
}

interface RenderStaging {
  readonly jobDirAbs: string;
  readonly outputRel: string;
  readonly outputAbs: string;
  readonly receiptProjectDir: string;
  preserveJobOnCleanup: boolean;
}

async function renderProjectLocked(
  projectDir: string,
  renderDoc: EditDoc,
  visible: EditDoc,
  executionDoc: EditDoc,
  capturedMediaHashes: ReadonlyMap<string, string>,
  renderEditHash: string,
  options: RenderOptions,
  onProgress?: (progress: RenderProgress) => void,
): Promise<Result<RenderOutcome>> {
  const artifactKind = renderArtifactKind(options);
  const jobDirRel = `edit/cache/render-jobs/${randomUUID()}`;
  const jobDirAbs = join(projectDir, jobDirRel);
  const receiptProjectDir = join(jobDirAbs, 'receipt-project');
  const staging: RenderStaging = {
    jobDirAbs,
    outputRel: `${jobDirRel}/${artifactKind}.mp4`,
    outputAbs: join(jobDirAbs, `${artifactKind}.mp4`),
    receiptProjectDir,
    preserveJobOnCleanup: false,
  };
  try {
    return await executeRenderProjectLocked(
      projectDir,
      renderDoc,
      visible,
      executionDoc,
      capturedMediaHashes,
      renderEditHash,
      options,
      staging,
      onProgress,
    );
  } finally {
    await Promise.allSettled([
      ...(staging.preserveJobOnCleanup ? [] : [removePublicationJob(jobDirAbs)]),
      rm(join(projectDir, 'edit', 'cache', 'layers'), { recursive: true, force: true }),
      rm(join(projectDir, CACHE_DIR_COMPOSED), { force: true }),
    ]);
  }
}

async function executeRenderProjectLocked(
  projectDir: string,
  renderDoc: EditDoc,
  visible: EditDoc,
  executionDoc: EditDoc,
  capturedMediaHashes: ReadonlyMap<string, string>,
  renderEditHash: string,
  options: RenderOptions,
  staging: RenderStaging,
  onProgress?: (progress: RenderProgress) => void,
): Promise<Result<RenderOutcome>> {
  const artifactKind = renderArtifactKind(options);
  // Receipts represent the canonical artifact consumed by Studio/QA. The
  // CLI's emergency overrides intentionally produce an ad-hoc render: even
  // when an override is a no-op for the current document, advertising that
  // file as canonical would make a later default render look fresh when it
  // has never run with the default profile.
  const publishesCanonicalReceipt = options.subtitles && options.loudnorm;
  // Filtered BEFORE probing/hashing, not just before planning — a hidden
  // overlay/layer may reference a file that doesn't exist (mid-authoring),
  // and probing it would fail the whole render for content that was never
  // going to render anyway. `doc` (unfiltered) is kept for the
  // final.edit.json write below, which records the full authoring state.
  const probes = await probeResolvedProjectMedia(executionDoc);
  if (!probes.ok) return probes;
  // Keep distinct baselines. A hardlink and its authoring path share an
  // inode, but the safe fallback copy does not; conflating the two would
  // either miss authoring-path replacement or reject every copied lease.
  const authoringInputs = await renderInputFingerprints(
    projectDir,
    visible,
    artifactKind,
    undefined,
    capturedMediaHashes,
  );
  if (!authoringInputs.ok) return authoringInputs;
  const pinnedInputs = await renderInputFingerprints(
    projectDir,
    visible,
    artifactKind,
    executionDoc,
  );
  if (!pinnedInputs.ok) return pinnedInputs;
  const sourceFingerprints = await buildSourceFingerprints(projectDir, executionDoc);
  if (!sourceFingerprints.ok) return sourceFingerprints;
  const transcripts = await loadProjectTranscripts(projectDir, visible);
  // Denoise is independent of loudnorm. The same measured model is handed
  // to the single pure plan used by preview and final, preventing a UI-only
  // approximation from drifting from export semantics.
  const noiseProfile = await measureNoiseProfile(projectDir, executionDoc, probes.value);
  if (!noiseProfile.ok) return noiseProfile;

  const previewVideoSources = options.preview
    ? await previewVideoSourcesFor(projectDir, visible)
    : new Map<string, string>();
  const plan = planRender({
    doc: executionDoc,
    transcripts,
    probes: probes.value,
    sourceFingerprints: sourceFingerprints.value,
    options,
    previewVideoSources,
    ...(noiseProfile.value.floorDb !== undefined
      ? { noiseFloorDb: noiseProfile.value.floorDb }
      : {}),
    ...(noiseProfile.value.bands !== undefined
      ? { noiseProfileBands: noiseProfile.value.bands }
      : {}),
  });
  if (!plan.ok) return plan;

  const { steps } = plan.value;
  const executionOutput = (declaredOutput: string): string =>
    declaredOutput === plan.value.outputPath ? staging.outputRel : declaredOutput;
  const redirectPublishedOutput = (
    args: readonly string[],
    declaredOutput: string,
  ): readonly string[] =>
    declaredOutput === plan.value.outputPath
      ? args.map((arg) => (arg === plan.value.outputPath ? staging.outputRel : arg))
      : args;
  let measurement: LoudnormMeasurement | null = null;

  for (const [index, step] of steps.entries()) {
    if (step.kind === 'ffmpeg-cacheable') {
      const target = join(projectDir, step.output);
      const cached = await isNonEmptyFile(target);
      onProgress?.({
        step: cached ? `${step.label} (cache hit)` : step.label,
        index: index + 1,
        total: steps.length,
      });
      if (cached) continue;
      await mkdir(dirname(target), { recursive: true });
      const tmpRel = tmpSegmentPath(step.output, index);
      const run = await runFfmpeg([...step.argsWithoutOutput, tmpRel], { cwd: projectDir });
      if (!run.ok) {
        await rm(join(projectDir, tmpRel), { force: true });
        return run;
      }
      try {
        await rename(join(projectDir, tmpRel), target);
      } catch (cause) {
        return err('io-failed', `cannot finalize cached segment "${step.output}"`, cause);
      }
      continue;
    }

    const label =
      step.kind === 'ffmpeg'
        ? step.label
        : step.kind === 'subtitle-graphics'
          ? step.label
          : step.kind === 'write-file'
            ? `write ${step.path}`
            : step.kind;
    onProgress?.({ step: label, index: index + 1, total: steps.length });

    if (step.kind === 'subtitle-graphics') {
      const rendered = await renderSubtitleGraphics(projectDir, step);
      if (!rendered.ok) return rendered;
      continue;
    }

    if (step.kind === 'write-file') {
      const target = join(projectDir, step.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, step.content);
      continue;
    }

    if (step.kind === 'ffmpeg') {
      const output = step.output === undefined ? undefined : executionOutput(step.output);
      if (output !== undefined) {
        await mkdir(dirname(join(projectDir, output)), { recursive: true });
      }
      const args =
        step.output === undefined ? step.args : redirectPublishedOutput(step.args, step.output);
      const run = await runFfmpeg(args, { cwd: projectDir });
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

    if (measurement === null) {
      return err('ffmpeg-failed', 'loudnorm-apply reached without a measurement step');
    }
    const output = executionOutput(step.output);
    await mkdir(dirname(join(projectDir, output)), { recursive: true });
    if (!Number.isFinite(Number(measurement.input_i))) {
      // Silent audio measures -inf. It still needs the one final AAC encode:
      // the composed intermediate intentionally keeps PCM for parity/quality.
      const copy = await runFfmpeg(
        [
          '-y',
          '-i',
          CACHE_DIR_COMPOSED,
          '-c:v',
          'copy',
          ...AUDIO_ENCODE_ARGS,
          ...MP4_FASTSTART_ARGS,
          output,
        ],
        { cwd: projectDir },
      );
      if (!copy.ok) return copy;
      continue;
    }
    const run = await runFfmpeg(
      substitutePlaceholders(redirectPublishedOutput(step.argsTemplate, step.output), measurement),
      { cwd: projectDir },
    );
    if (!run.ok) return run;
  }

  const probed = await probeMedia(staging.outputAbs);
  if (!probed.ok) return probed;

  // QA/freshness checks compare against the document that PRODUCED the
  // canonical artifact, not whatever the user edited while the render was
  // running. Override renders remain playable but deliberately stay stale.
  const completedAuthoringInputs = await renderInputFingerprints(projectDir, visible, artifactKind);
  if (!completedAuthoringInputs.ok) return completedAuthoringInputs;
  const completedPinnedInputs = await renderInputFingerprints(
    projectDir,
    visible,
    artifactKind,
    executionDoc,
  );
  if (!completedPinnedInputs.ok) return completedPinnedInputs;
  if (
    JSON.stringify(completedAuthoringInputs.value) !== JSON.stringify(authoringInputs.value) ||
    JSON.stringify(completedPinnedInputs.value) !== JSON.stringify(pinnedInputs.value)
  ) {
    return err(
      'io-failed',
      'a mídia do projeto mudou durante o render; execute novamente para gerar um artefato íntegro',
    );
  }

  try {
    await pruneSegmentCache(projectDir);
    const subtitleGraphicsStep = steps.find((step) => step.kind === 'subtitle-graphics');
    if (subtitleGraphicsStep) {
      await pruneSubtitleGraphicsCache(projectDir, subtitleGraphicsStep.manifestPath);
    }
  } catch (cause) {
    return err('io-failed', 'não foi possível finalizar o cache do render', cause);
  }

  if (publishesCanonicalReceipt) {
    try {
      await writeRenderReceipt(
        staging.receiptProjectDir,
        artifactKind,
        renderDoc,
        authoringInputs.value,
      );
    } catch (cause) {
      return err('io-failed', 'não foi possível preparar o registro da entrega de vídeo', cause);
    }
  }

  const outputAbs = join(projectDir, plan.value.outputPath);
  const publication = publicationArtifacts(
    projectDir,
    staging.jobDirAbs,
    artifactKind,
    publishesCanonicalReceipt,
  );
  const promoted = await promoteRenderPublication(
    publication,
    staging.jobDirAbs,
    artifactKind,
    publishesCanonicalReceipt,
    () => {
      // Keep the private backups for manual recovery when rollback itself
      // could not restore the public set.
      staging.preserveJobOnCleanup = true;
    },
  );
  if (!promoted.ok) return promoted;

  return ok({
    outputRel: plan.value.outputPath,
    outputAbs,
    durationS: probed.value.durationS,
    expectedDurationS: plan.value.expectedDurationS,
    editHash: renderEditHash,
    canonical: publishesCanonicalReceipt,
    kind: artifactKind,
    programKey: programKey(renderDoc),
  });
}
