import { access, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { installationRoot } from '../../core/installation.js';
import { err, ok, type Result } from '../../core/result.js';
import { parseEditDoc, type EditDoc } from '../../core/schema.js';
import { StudioDb, type MediaIndexEntry } from '../../db/index.js';
import { fastVideoEncoder, ffmpegCapabilities, probeMedia } from '../../server/services/ffmpeg.js';
import { loadEditDoc, saveEditDoc } from '../../server/services/project.js';
import { listMediaFiles } from '../../server/services/projectMedia.js';
import { readCachedTranscript } from '../../server/services/transcribe.js';
import { getOrBuildPeaks } from '../../server/services/waveform.js';
import { warmProxyCache } from '../../server/services/proxy.js';
import { mediaHash } from '../../server/services/mediaHash.js';
import { acquireProjectLock, ProjectLockBusyError } from '../../server/services/projectLock.js';

const TEMPLATES_DIR = join(installationRoot(import.meta.url, 3), 'templates');

export interface OpenSummary {
  readonly projectDir: string;
  readonly mediaFiles: readonly string[];
  readonly doc: EditDoc;
  readonly warnings: readonly string[];
  readonly transcribedCount: number;
  readonly ffmpegWarning: string | null;
}

function sourceKeyFor(fileName: string): string {
  const base = basename(fileName).replace(/\.[^.]+$/, '');
  const key = base.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return key || 'media';
}

interface SourceEntry {
  readonly path: string;
  readonly role: 'camera';
  readonly durationS: number;
}

/**
 * Phones shoot 4K at 59.94/60 fps; delivering at that rate doubles every
 * encode for no visible gain on a talking head or a lesson. Halve high frame
 * rates (59.94 → 29.97, 60 → 30, 50 → 25) so the cadence stays clean; keep
 * anything at or below 40 as shot. The doc's `fps` stays editable.
 */
export function defaultOutputFps(sourceFps: number): number {
  return sourceFps > 40 ? Math.round((sourceFps / 2) * 100) / 100 : sourceFps;
}

export interface DefaultSources {
  readonly sources: Readonly<Record<string, SourceEntry>>;
  /** Key of the first (base-track) source. */
  readonly baseKey: string;
  readonly fps: number;
}

/**
 * Every video in the folder becomes a declared source, keyed uniquely; only
 * the first one lands on the base track, so only its probe failure is fatal —
 * a later unreadable file is skipped, exactly as the media index skips it.
 */
export async function defaultSources(
  projectDir: string,
  mediaFiles: readonly string[],
): Promise<Result<DefaultSources>> {
  const sources = new Map<string, SourceEntry>();
  let baseKey: string | null = null;
  let fps = 25;
  for (const [index, file] of mediaFiles.entries()) {
    const probe = await probeMedia(join(projectDir, file));
    if (!probe.ok) {
      if (index === 0) return probe;
      continue;
    }
    const base = sourceKeyFor(file);
    let key = base;
    for (let suffix = 2; sources.has(key); suffix += 1) key = `${base}_${String(suffix)}`;
    sources.set(key, {
      path: file,
      role: 'camera',
      durationS: Math.round(probe.value.durationS * 100) / 100,
    });
    if (index === 0) {
      baseKey = key;
      fps = defaultOutputFps(probe.value.fps);
    }
  }
  if (baseKey === null) return err('not-found', 'no video in the folder — nothing to edit');
  return ok({ sources: Object.fromEntries(sources), baseKey, fps });
}

export async function defaultEditDoc(
  projectDir: string,
  mediaFiles: readonly string[],
): Promise<Result<EditDoc>> {
  const defaults = await defaultSources(projectDir, mediaFiles);
  if (!defaults.ok) return defaults;
  const { sources, baseKey, fps } = defaults.value;
  const durationS = sources[baseKey]?.durationS ?? 0;

  const candidate = {
    version: 2 as const,
    fps,
    output: { width: 1080, height: 1920, loudnormLufs: -14 },
    sources,
    tracks: [
      {
        id: 'base',
        kind: 'video' as const,
        label: baseKey,
        blocks: [{ source: baseKey, in: 0, out: durationS }],
      },
    ],
    subtitles: {
      enabled: true,
      preset: 'pill' as const,
      minWordsPerCue: 2,
      maxWordsPerCue: 3,
      fontSize: 15,
      marginV: 64,
    },
    totalDurationS: durationS,
  };
  return parseEditDoc(candidate);
}

export interface MediaIndex {
  readonly entries: readonly MediaIndexEntry[];
  readonly transcribedCount: number;
  /** Files the index could not read; `open` warns about them and goes on. */
  readonly skipped: readonly string[];
}

/** Waveform, probe, fingerprint and cached transcript per media file — one unreadable file never blocks the folder. */
export async function indexMediaFiles(
  projectDir: string,
  mediaFiles: readonly string[],
): Promise<MediaIndex> {
  const entries: MediaIndexEntry[] = [];
  const skipped: string[] = [];
  let transcribedCount = 0;
  for (const file of mediaFiles) {
    const probe = await probeMedia(join(projectDir, file));
    const hash = probe.ok ? await mediaHash(join(projectDir, file)) : probe;
    // A silent video has no waveform to build; it is still footage.
    const peaks =
      hash.ok && probe.ok && probe.value.hasAudio ? await getOrBuildPeaks(projectDir, file) : hash;
    if (!probe.ok || !hash.ok || !peaks.ok) {
      skipped.push(file);
      continue;
    }
    const transcript = await readCachedTranscript(projectDir, file);
    if (transcript) transcribedCount += 1;
    entries.push({
      relPath: file,
      hash: hash.value,
      durationS: probe.value.durationS,
      transcriptStatus: transcript?.engine ?? 'none',
      transcriptText: transcript?.text ?? null,
    });
  }
  return { entries, transcribedCount, skipped };
}

export async function scaffoldAgentGuides(projectDir: string): Promise<void> {
  const template = join(TEMPLATES_DIR, 'creative-agent-guide.md');
  const managedDir = join(projectDir, 'edit', 'agent');
  const managedGuide = join(managedDir, 'leadzy-studio.md');
  await mkdir(managedDir, { recursive: true });
  // The Studio-owned contract can be refreshed safely because it lives in a
  // dedicated namespace. Root CLAUDE.md / AGENTS.md may contain valuable user
  // instructions, so open must never overwrite them.
  await copyFile(template, managedGuide);
  for (const target of ['CLAUDE.md', 'AGENTS.md']) {
    const path = join(projectDir, target);
    const exists = await access(path).then(
      () => true,
      () => false,
    );
    if (exists) continue;
    await writeFile(
      path,
      [
        '# Instructions for this creative',
        '',
        'Before editing this project, read `edit/agent/leadzy-studio.md` in full.',
        'This file is maintained by Leadzy Studio; these local instructions can be extended without being overwritten.',
        '',
      ].join('\n'),
    );
  }
}

/**
 * RF1: prepare a creative folder — edit/, agent guides, waveforms, index —
 * without ever touching the user's media.
 */
export async function openProject(projectDir: string): Promise<Result<OpenSummary>> {
  const capabilities = await ffmpegCapabilities();
  const ffmpegWarning = capabilities.ok ? null : capabilities.error.message;
  // Matches the Portuguese literal ffmpeg.ts still produces (untranslated as of
  // this pass) — update together when that file's translation lands.
  if (!capabilities.ok && capabilities.error.message.includes('não encontrados')) {
    return capabilities;
  }

  const media = await listMediaFiles(projectDir);
  if (!media.ok) return media;
  if (media.value.length === 0) {
    return err('not-found', `no video found in "${projectDir}"`);
  }

  await mkdir(join(projectDir, 'edit'), { recursive: true });
  await scaffoldAgentGuides(projectDir);

  let doc: EditDoc;
  let warnings: readonly string[] = [];
  let editLock;
  try {
    editLock = await acquireProjectLock(projectDir, 'edit-write', { waitMs: 5_000 });
  } catch (cause) {
    return err(
      'io-failed',
      cause instanceof ProjectLockBusyError
        ? 'the project is being edited; try opening it again in a moment'
        : 'could not reserve the project for opening',
      cause,
    );
  }
  try {
    const loaded = await loadEditDoc(projectDir);
    if (loaded.ok) {
      doc = loaded.value.doc;
      warnings = loaded.value.warnings;
    } else if (loaded.error.code === 'not-found') {
      const created = await defaultEditDoc(projectDir, media.value);
      if (!created.ok) return created;
      doc = created.value;
    } else {
      return loaded;
    }

    const saved = await saveEditDoc(projectDir, doc);
    if (!saved.ok) return saved;
  } finally {
    await editLock.release();
  }

  // Proxy transcodes can take minutes for multi-gigabyte originals. The UI
  // must become interactive immediately and use the original until the warmup
  // publishes a complete proxy in the background.
  const proxyEncoder = capabilities.ok ? fastVideoEncoder(capabilities.value) : 'libx264';
  void warmProxyCache(projectDir, media.value, { videoEncoder: proxyEncoder }).catch(() => {
    console.warn('\u26a0 background proxy failed \u2014 the player uses the original');
  });

  const { entries, transcribedCount, skipped } = await indexMediaFiles(projectDir, media.value);
  if (skipped.length > 0) {
    warnings = [
      ...warnings,
      `media skipped (could not be probed or analysed): ${skipped.join(', ')} — fix or remove the file`,
    ];
  }

  const db = new StudioDb();
  try {
    db.reindexProject(projectDir, entries);
  } finally {
    db.close();
  }

  return ok({
    projectDir,
    mediaFiles: media.value,
    doc,
    warnings,
    transcribedCount,
    ffmpegWarning,
  });
}
