import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  AUDIO_PREVIEW_BEFORE_OUTPUT_PATH,
  AUDIO_PREVIEW_OUTPUT_PATH,
} from '../../core/audioPreviewPlan.js';
import { audioPreviewSemanticKey } from '../../core/audioPreviewFreshness.js';
import { baseTrackOf, transcriptionKeyterms, type EditDoc } from '../../core/schema.js';
import { outputDuration } from '../../core/timeline.js';
import {
  validateEditDocReferences,
  type ValidationIssue,
} from '../../application/validateEditDocReferences.js';
import { editDocHash, loadEditDoc } from '../../server/services/project.js';
import { probeProjectAsset } from '../../server/services/ffmpeg.js';
import { listProjectMediaFiles } from '../../server/services/projectMedia.js';
import { renderSnapshotHash, renderSnapshotInfo } from '../../server/services/renderReceipt.js';
import type { TranscriptFreshness } from '../../core/transcript.js';
import { inspectTranscriptCache, transcriptCachePath } from '../../server/services/transcribe.js';

export interface ProjectValidation {
  readonly ok: boolean;
  readonly projectDir: string;
  readonly editHash: string | null;
  readonly issues: readonly ValidationIssue[];
}

/**
 * `fresh`, or why `studio transcribe` will redo it (`missing`, `stale-media`,
 * `stale-keyterms`); `silent` media has nothing to transcribe and is never
 * pending; `unreadable` media could not be probed at all.
 */
export type TranscriptStatusState = TranscriptFreshness | 'silent' | 'unreadable';

export interface TranscriptStatus {
  readonly relPath: string;
  /** `null` when the media has no current-engine transcript cache. */
  readonly model: string | null;
  readonly transcribedAt: string | null;
  readonly state: TranscriptStatusState;
}

export function isPendingTranscript(status: TranscriptStatus): boolean {
  return status.state !== 'fresh' && status.state !== 'silent' && status.state !== 'unreadable';
}

/** The one-line human summary: fresh over audible, and how many the next transcribe would touch. */
export function transcriptSummaryLine(transcripts: readonly TranscriptStatus[]): string {
  const audible = transcripts.filter((t) => t.state !== 'silent' && t.state !== 'unreadable');
  const fresh = audible.filter((t) => t.state === 'fresh').length;
  const pending = transcripts.filter(isPendingTranscript).length;
  const unreadable = transcripts.filter((t) => t.state === 'unreadable').length;
  const call =
    pending > 0
      ? ` · ${String(pending)} pending (missing, media or keyterms changed) — run studio transcribe`
      : '';
  const broken = unreadable > 0 ? ` · ${String(unreadable)} unreadable (ffprobe failed)` : '';
  return `transcripts ${String(fresh)}/${String(audible.length)}${call}${broken}`;
}

/** One media file in the folder, whether or not edit.json declares it as a source. */
export interface MediaStatus {
  readonly relPath: string;
  /** The `sources` key that points at this file; `null` means the agent has to add one before cutting, packing or transcribing from it. */
  readonly sourceId: string | null;
  readonly durationS: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly fps: number | null;
  readonly hasAudio: boolean | null;
}

export function mediaSummaryLine(media: readonly MediaStatus[]): string | null {
  const undeclared = media.filter((entry) => entry.sourceId === null);
  if (undeclared.length === 0) return null;
  const list = undeclared
    .map(
      (entry) =>
        `${entry.relPath}${entry.durationS === null ? '' : ` (${entry.durationS.toFixed(1)}s)`}`,
    )
    .join(', ');
  return `media not in edit.json: ${list} — add it to sources to transcribe, pack or cut it`;
}

export interface ProjectStatus {
  readonly ok: true;
  readonly projectDir: string;
  readonly projectName: string;
  readonly editHash: string;
  readonly schemaVersion: number;
  readonly sources: number;
  readonly tracks: number;
  readonly blocks: number;
  readonly baseBlocks: number;
  readonly editorialDurationS: number;
  readonly renderedDurationS: number;
  readonly outputSpeed: number;
  readonly previewExists: boolean;
  readonly previewEditHash: string | null;
  readonly previewCurrent: boolean;
  readonly audioPreviewExists: boolean;
  readonly audioComparisonExists: boolean;
  readonly audioPreviewEditHash: string | null;
  readonly audioPreviewCurrent: boolean;
  readonly audioComparisonCurrent: boolean;
  readonly finalExists: boolean;
  readonly finalEditHash: string | null;
  readonly finalCurrent: boolean;
  readonly keyterms: readonly string[];
  readonly media: readonly MediaStatus[];
  readonly transcripts: readonly TranscriptStatus[];
  readonly validation: ProjectValidation;
}

interface MediaInventory {
  readonly media: MediaStatus[];
  readonly transcripts: TranscriptStatus[];
}

function sourceIdFor(doc: EditDoc, relPath: string): string | null {
  return Object.entries(doc.sources).find(([, source]) => source.path === relPath)?.[0] ?? null;
}

async function mediaInventory(projectDir: string, doc: EditDoc): Promise<MediaInventory> {
  const keyterms = transcriptionKeyterms(doc);
  const files = await listProjectMediaFiles(projectDir);
  if (!files.ok) return { media: [], transcripts: [] };
  const media: MediaStatus[] = [];
  const transcripts: TranscriptStatus[] = [];
  for (const relPath of files.value) {
    const mediaAbs = join(projectDir, relPath);
    const { state, meta } = await inspectTranscriptCache(
      transcriptCachePath(projectDir, relPath),
      mediaAbs,
      keyterms,
    );
    const probed = await probeProjectAsset(mediaAbs);
    const info = probed.ok ? probed.value : null;
    media.push({
      relPath,
      sourceId: sourceIdFor(doc, relPath),
      durationS: info === null ? null : Math.round(info.durationS * 100) / 100,
      width: info?.kind === 'video' ? info.width : null,
      height: info?.kind === 'video' ? info.height : null,
      fps: info?.kind === 'video' ? info.fps : null,
      hasAudio: info?.hasAudio ?? null,
    });
    // A fresh cache proves the media had audio even when ffprobe cannot read it today.
    const resolvedState: TranscriptStatusState =
      state === 'fresh' ? state : info === null ? 'unreadable' : info.hasAudio ? state : 'silent';
    transcripts.push({
      relPath,
      model: meta?.model ?? null,
      transcribedAt: meta?.transcribedAt ?? null,
      state: resolvedState,
    });
  }
  return { media, transcripts };
}

async function isFile(path: string): Promise<boolean> {
  return stat(path)
    .then((info) => info.isFile())
    .catch(() => false);
}

/** Fast, deterministic validation intended for an agent's preflight loop. */
export async function validateProject(projectDir: string): Promise<ProjectValidation> {
  const loaded = await loadEditDoc(projectDir);
  if (!loaded.ok) {
    return {
      ok: false,
      projectDir,
      editHash: null,
      issues: [{ code: loaded.error.code, path: 'edit/edit.json', message: loaded.error.message }],
    };
  }

  const { doc } = loaded.value;
  const issues = [...(await validateEditDocReferences(projectDir, doc))];

  const derivedDuration = Math.round(outputDuration(doc) * 100) / 100;
  if (doc.totalDurationS === undefined || Math.abs(doc.totalDurationS - derivedDuration) > 0.011) {
    issues.push({
      code: 'stale-duration',
      path: 'totalDurationS',
      message: `expected ${derivedDuration.toFixed(2)}s from the base track; found ${String(doc.totalDurationS ?? 'missing')}`,
    });
  }

  return {
    ok: issues.length === 0,
    projectDir,
    editHash: editDocHash(doc),
    issues,
  };
}

export async function projectStatus(
  projectDir: string,
): Promise<ProjectStatus | ProjectValidation> {
  const validation = await validateProject(projectDir);
  const loaded = await loadEditDoc(projectDir);
  if (!loaded.ok) return validation;
  const { doc } = loaded.value;
  const speed = doc.output.speed ?? 1;
  const editorialDurationS = Math.round(outputDuration(doc) * 100) / 100;
  const editHash = editDocHash(doc);
  const [
    previewExists,
    audioPreviewExists,
    audioPreviewBeforeExists,
    finalExists,
    previewEditHash,
    audioPreviewSnapshot,
    finalEditHash,
  ] = await Promise.all([
    isFile(`${projectDir}/edit/preview.mp4`),
    isFile(join(projectDir, AUDIO_PREVIEW_OUTPUT_PATH)),
    isFile(join(projectDir, AUDIO_PREVIEW_BEFORE_OUTPUT_PATH)),
    isFile(`${projectDir}/edit/final.mp4`),
    renderSnapshotHash(projectDir, 'preview'),
    renderSnapshotInfo(projectDir, 'audio-preview'),
    renderSnapshotHash(projectDir, 'final'),
  ]);
  const keyterms = transcriptionKeyterms(doc);
  const { media, transcripts } = await mediaInventory(projectDir, doc);
  const audioComparisonExists = audioPreviewExists && audioPreviewBeforeExists;
  const audioPreviewEditHash = audioPreviewSnapshot?.editHash ?? null;
  const audioPreviewSemanticallyCurrent =
    audioPreviewSnapshot !== null &&
    audioPreviewSemanticKey(audioPreviewSnapshot.doc) === audioPreviewSemanticKey(doc);
  return {
    ok: true,
    projectDir,
    projectName: basename(projectDir),
    editHash,
    schemaVersion: doc.version,
    sources: Object.keys(doc.sources).length,
    tracks: doc.tracks.length,
    blocks: doc.tracks.reduce((total, track) => total + track.blocks.length, 0),
    baseBlocks: baseTrackOf(doc).blocks.length,
    editorialDurationS,
    renderedDurationS: Math.round((editorialDurationS / speed) * 100) / 100,
    outputSpeed: speed,
    previewExists,
    previewEditHash,
    previewCurrent: previewExists && previewEditHash === editHash,
    audioPreviewExists,
    audioComparisonExists,
    audioPreviewEditHash,
    audioPreviewCurrent: audioPreviewExists && audioPreviewSemanticallyCurrent,
    audioComparisonCurrent: audioComparisonExists && audioPreviewSemanticallyCurrent,
    finalExists,
    finalEditHash,
    finalCurrent: finalExists && finalEditHash === editHash,
    keyterms,
    media,
    transcripts,
    validation,
  };
}
