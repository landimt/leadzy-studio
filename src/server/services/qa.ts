import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from '../../core/result.js';
import { buildQaReport, type QaReport } from '../../core/qaDiff.js';
import { parseEditDoc, transcriptionKeyterms, type EditDoc } from '../../core/schema.js';
import { scaleTranscriptTimes } from '../../core/transcript.js';
import { probeMedia } from './ffmpeg.js';
import { loadProjectTranscripts } from './projectTranscripts.js';
import { acquireProjectLock, ProjectLockBusyError } from './projectLock.js';
import { recoverRenderPublicationsUnderLock } from './renderPublication.js';
import { transcribeToCache } from './transcribe.js';

export interface QaOptions {
  readonly apiKey?: string;
}

/**
 * The honesty check: retranscribe the RENDERED file and diff it against what
 * the edit doc promised. Writes edit/qa/report.json for agents and CI.
 */
async function runQaLocked(
  projectDir: string,
  doc: EditDoc,
  options: QaOptions,
): Promise<Result<QaReport>> {
  const finalAbs = join(projectDir, 'edit', 'final.mp4');
  const probed = await probeMedia(finalAbs);
  if (!probed.ok) {
    return err('not-found', 'edit/final.mp4 does not exist — run studio render before QA');
  }

  // Prefer the snapshot saved at render time — the current edit.json may have
  // moved on (that difference is a stale preview, not a broken render). A
  // snapshot that exists but cannot be read must not be replaced by the
  // current document in silence: the comparison would blame the render.
  const snapshotPath = join(projectDir, 'edit', 'cache', 'final.edit.json');
  const snapshot = parseSnapshot(await readFile(snapshotPath, 'utf8').catch(() => null));
  if (snapshot !== null && !snapshot.ok) {
    return err(
      'invalid-edit-json',
      'edit/cache/final.edit.json (the document the final was rendered from) cannot be read by this version — run studio render again before QA',
    );
  }
  const effectiveDoc = snapshot?.ok ? snapshot.value : doc;

  const transcripts = await loadProjectTranscripts(projectDir, effectiveDoc);
  if (transcripts.size === 0) {
    return err(
      'not-found',
      'no source transcripts in edit/transcripts — QA compares expected vs spoken text',
    );
  }

  // A final rendered at 1.1× is heard slowed back to natural speed — the
  // engine misreads homophones in sped-up speech ("atendido" → "entendido") —
  // and the word times are mapped back onto the final's own clock.
  const hearing = finalHearingPlan(effectiveDoc.output.speed ?? 1);
  const finalTranscript = await transcribeToCache(
    finalAbs,
    join(projectDir, 'edit', 'qa', 'final.transcript.json'),
    // Keyterms are a transcription setting, not a render setting: the final
    // must be heard with the same priming as the current source transcripts.
    {
      ...options,
      keyterms: transcriptionKeyterms(doc),
      ...(hearing.audioTempo !== undefined ? { audioTempo: hearing.audioTempo } : {}),
    },
  );
  if (!finalTranscript.ok) return finalTranscript;

  const report = buildQaReport({
    doc: effectiveDoc,
    transcripts,
    finalTranscript: scaleTranscriptTimes(finalTranscript.value, hearing.timeScale),
    actualDurationS: probed.value.durationS,
  });

  const reportPath = join(projectDir, 'edit', 'qa', 'report.json');
  try {
    await mkdir(join(projectDir, 'edit', 'qa'), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  } catch (cause) {
    return err('io-failed', `cannot write "${reportPath}"`, cause);
  }
  return ok(report);
}

/** `null` when there is no snapshot; a Result otherwise — never a silent fallback. */
export function parseSnapshot(text: string | null): ReturnType<typeof parseEditDoc> | null {
  if (text === null) return null;
  try {
    return parseEditDoc(JSON.parse(text));
  } catch (cause) {
    return err('invalid-edit-json', 'render snapshot is not valid JSON', cause);
  }
}

export interface FinalHearingPlan {
  /** Passed to the extraction so the engine hears natural speech; absent at speed 1. */
  readonly audioTempo?: number;
  /** Multiplies the engine's word times back onto the final's clock. */
  readonly timeScale: number;
}

/** A final at 1.1× is heard at 1/1.1 and its word times are scaled by 1/1.1 back. */
export function finalHearingPlan(speed: number): FinalHearingPlan {
  if (speed === 1) return { timeScale: 1 };
  const tempo = 1 / speed;
  return { audioTempo: tempo, timeScale: tempo };
}

export async function runQa(
  projectDir: string,
  doc: EditDoc,
  options: QaOptions,
): Promise<Result<QaReport>> {
  let renderLock;
  try {
    // QA reads final.mp4 and its render snapshot as one logical artifact.
    // Sharing the render lock prevents it from observing the short commit
    // window between the atomic MP4 swap and the receipt commit marker.
    renderLock = await acquireProjectLock(projectDir, 'render');
  } catch (cause) {
    return cause instanceof ProjectLockBusyError
      ? err('io-failed', 'a render is already in progress; run QA once it finishes', cause)
      : err('io-failed', 'could not reserve the final delivery for QA', cause);
  }
  try {
    const recovered = await recoverRenderPublicationsUnderLock(projectDir);
    if (!recovered.ok) return recovered;
    return await runQaLocked(projectDir, doc, options);
  } finally {
    await renderLock.release();
  }
}
