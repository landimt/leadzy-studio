import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { err, ok, type Result } from '../core/result.js';
import { transcriptionKeyterms } from '../core/schema.js';
import { estimateScribeCostUsd } from '../core/scribeCost.js';
import type { TranscriptFreshness } from '../core/transcript.js';
import { StudioDb } from '../db/index.js';
import { probeProjectAsset } from '../server/services/ffmpeg.js';
import { listProjectMediaFiles } from '../server/services/projectMedia.js';
import { mediaHash } from '../server/services/mediaHash.js';
import { editJsonPath, loadEditDoc } from '../server/services/project.js';
import {
  getOrCreateTranscript,
  retireTranscriptCache,
  transcriptArchiveDir,
  transcriptCachePath,
  transcriptCacheState,
} from '../server/services/transcribe.js';

export interface TranscribeSummary {
  readonly transcribed: readonly string[];
  readonly skippedCached: readonly string[];
  /** Media that lost its audio: the transcript of the previous take was moved to history. */
  readonly retired: readonly string[];
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === 's' || answer === 'sim' || answer === 'y' || answer === 'yes';
}

export interface TranscribeCommandOptions {
  readonly apiKey?: string;
  /** Transcribe every media again, current caches included. */
  readonly force?: boolean;
  readonly assumeYes: boolean;
  readonly onProgress?: (message: string) => void;
}

interface PendingMedia {
  readonly file: string;
  readonly durationS: number;
  readonly state: TranscriptFreshness;
}

/** The reasons behind the pre-flight count, e.g. `1 without transcript, 2 with changed keyterms`. */
export function pendingSummary(
  pending: readonly Pick<PendingMedia, 'state'>[],
  force: boolean,
): string {
  if (force) return 'forced';
  const count = (state: TranscriptFreshness): number =>
    pending.filter((p) => p.state === state).length;
  const parts = [
    [count('missing'), 'without transcript'],
    [count('stale-media'), 'with changed media'],
    [count('stale-keyterms'), 'with changed keyterms'],
  ] as const;
  return parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${String(n)} ${label}`)
    .join(', ');
}

/**
 * The keyterms come from the document. No document means no keyterms; a
 * document that exists but cannot be read is refused — re-transcribing with
 * "no keyterms" would bill every media again and lose the primed spelling.
 */
async function projectKeyterms(projectDir: string): Promise<Result<readonly string[]>> {
  const loaded = await loadEditDoc(projectDir);
  if (loaded.ok) return ok(transcriptionKeyterms(loaded.value.doc));
  if (!existsSync(editJsonPath(projectDir))) return ok([]);
  return err(
    'invalid-edit-json',
    'edit/edit.json exists but cannot be read — fix it before transcribing, its keyterms would otherwise be lost',
  );
}

/** The search index must not keep serving a transcript no cache holds. */
async function forgetTranscriptInIndex(projectDir: string, file: string): Promise<void> {
  const hash = await mediaHash(join(projectDir, file));
  const probe = await probeProjectAsset(join(projectDir, file));
  if (!hash.ok || !probe.ok) return;
  const db = new StudioDb();
  try {
    const project = db.upsertProject(projectDir);
    db.upsertMedia(project.id, {
      relPath: file,
      hash: hash.value,
      durationS: probe.value.durationS,
      transcriptStatus: 'none',
      transcriptText: null,
    });
  } finally {
    db.close();
  }
}

/**
 * Transcribes every media file whose cache is missing, whose media file
 * changed, or whose keyterms changed; `force` redoes all of them. Silent
 * media is skipped, and a cache it may still hold is retired.
 */
export async function transcribeProject(
  projectDir: string,
  options: TranscribeCommandOptions,
): Promise<Result<TranscribeSummary>> {
  const media = await listProjectMediaFiles(projectDir);
  if (!media.ok) return media;
  const keyterms = await projectKeyterms(projectDir);
  if (!keyterms.ok) return keyterms;
  const force = options.force === true;

  const pending: PendingMedia[] = [];
  const skippedCached: string[] = [];
  const retired: string[] = [];
  for (const file of media.value) {
    const cacheAbs = transcriptCachePath(projectDir, file);
    const state = await transcriptCacheState(cacheAbs, join(projectDir, file), keyterms.value);
    if (state === 'fresh' && !force) {
      skippedCached.push(file);
      continue;
    }
    const probe = await probeProjectAsset(join(projectDir, file));
    if (!probe.ok) return probe;
    if (!probe.value.hasAudio) {
      // Silent video is valid project media, but it has nothing to transcribe —
      // and a transcript of the take it replaced must stop being served.
      if (state !== 'missing') {
        const moved = await retireTranscriptCache(cacheAbs, transcriptArchiveDir(projectDir));
        if (!moved.ok) return moved;
        await forgetTranscriptInIndex(projectDir, file);
        retired.push(file);
      }
      continue;
    }
    pending.push({ file, durationS: probe.value.durationS, state });
  }

  if (pending.length === 0) {
    return ok({ transcribed: [], skippedCached, retired });
  }

  const totalS = pending.reduce((sum, p) => sum + p.durationS, 0);
  const estimate = estimateScribeCostUsd(totalS, keyterms.value.length);
  console.log(
    `Will transcribe ${String(pending.length)} file(s) (${pendingSummary(pending, force)}), ${(totalS / 60).toFixed(1)} min — estimated Scribe cost ~US$ ${estimate.toFixed(2)}${keyterms.value.length > 0 ? ` with ${String(keyterms.value.length)} keyterm(s)` : ''}.`,
  );
  if (!options.assumeYes) {
    const proceed = await confirm('Continue?');
    if (!proceed)
      return err('transcription-failed', 'cancelled by user (use --yes to skip the confirmation)');
  }

  const transcribed: string[] = [];
  for (const [index, { file }] of pending.entries()) {
    console.log(`Transcribing ${file}…`);
    options.onProgress?.(
      `Transcrevendo ${String(index + 1)} de ${String(pending.length)} · ${basename(file)}`,
    );
    const result = await getOrCreateTranscript(projectDir, file, {
      keyterms: keyterms.value,
      force,
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    });
    if (!result.ok) return result;
    transcribed.push(file);

    const hash = await mediaHash(join(projectDir, file));
    const probe = await probeProjectAsset(join(projectDir, file));
    if (hash.ok && probe.ok) {
      const db = new StudioDb();
      try {
        const project = db.upsertProject(projectDir);
        db.upsertMedia(project.id, {
          relPath: file,
          hash: hash.value,
          durationS: probe.value.durationS,
          transcriptStatus: result.value.engine,
          transcriptText: result.value.text,
        });
      } finally {
        db.close();
      }
    }
  }
  return ok({ transcribed, skippedCached, retired });
}
