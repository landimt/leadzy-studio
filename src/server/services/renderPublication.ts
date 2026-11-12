import { randomUUID } from 'node:crypto';
import { copyFile, link, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { err, ok, type Result } from '../../core/result.js';
import type { RenderArtifactKind } from '../../core/render/options.js';
import { acquireProjectLock, ProjectLockBusyError } from './projectLock.js';

async function cloneFile(source: string, destination: string): Promise<void> {
  try {
    await link(source, destination);
  } catch (cause) {
    // Hardlinks keep a multi-gigabyte previous export cheap. Filesystems that
    // do not support them (some removable/network volumes) still get the same
    // crash-safety guarantee through a copy fallback.
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') throw cause;
    await copyFile(source, destination);
  }
}

async function backupIfPresent(source: string, destination: string): Promise<boolean> {
  try {
    await cloneFile(source, destination);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw cause;
  }
}

interface RenderPublicationArtifact {
  /** Omitted when successful publication must remove the public file (non-canonical receipts). */
  readonly temporary?: string;
  readonly public: string;
  readonly backup: string;
}

interface RenderPublicationJournal {
  readonly version: 1;
  readonly artifactKind: RenderArtifactKind;
  readonly canonical: boolean;
  readonly phase: 'prepared' | 'committed' | 'rolled-back';
  readonly previous: readonly boolean[];
}

const PUBLICATION_JOURNAL = 'publication.json';

async function syncFile(path: string): Promise<void> {
  // Windows flushes a file through FlushFileBuffers, which demands write
  // access: fsync on a read-only handle fails with EPERM and would abort an
  // otherwise complete publication. POSIX flushes a read-only handle fine.
  const handle = await open(path, process.platform === 'win32' ? 'r+' : 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (cause) {
    // Directory fsync is not exposed by every Windows/removable filesystem.
    // Supported POSIX filesystems still get the directory ordering barrier.
    const code = (cause as NodeJS.ErrnoException).code;
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(code ?? '')) throw cause;
  } finally {
    await handle?.close();
  }
}

export function publicationArtifacts(
  projectDir: string,
  jobDirAbs: string,
  artifactKind: RenderArtifactKind,
  canonical: boolean,
): readonly RenderPublicationArtifact[] {
  const receiptCacheDir = join(jobDirAbs, 'receipt-project', 'edit', 'cache');
  return [
    {
      temporary: join(jobDirAbs, `${artifactKind}.mp4`),
      public: join(projectDir, 'edit', `${artifactKind}.mp4`),
      backup: join(jobDirAbs, `previous-${artifactKind}.mp4`),
    },
    {
      ...(canonical ? { temporary: join(receiptCacheDir, `${artifactKind}.edit.json`) } : {}),
      public: join(projectDir, 'edit', 'cache', `${artifactKind}.edit.json`),
      backup: join(jobDirAbs, 'previous-receipt-edit.json'),
    },
    {
      ...(canonical ? { temporary: join(receiptCacheDir, `${artifactKind}.inputs.json`) } : {}),
      public: join(projectDir, 'edit', 'cache', `${artifactKind}.inputs.json`),
      backup: join(jobDirAbs, 'previous-receipt-inputs.json'),
    },
  ];
}

async function writePublicationJournal(
  jobDirAbs: string,
  journal: RenderPublicationJournal,
): Promise<void> {
  const path = join(jobDirAbs, PUBLICATION_JOURNAL);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(journal)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(jobDirAbs);
  } finally {
    await rm(temporary, { force: true });
  }
}

function parsePublicationJournal(raw: string): RenderPublicationJournal | undefined {
  try {
    const value = JSON.parse(raw) as Partial<RenderPublicationJournal>;
    if (
      value.version !== 1 ||
      (value.artifactKind !== 'preview' &&
        value.artifactKind !== 'final' &&
        value.artifactKind !== 'program') ||
      typeof value.canonical !== 'boolean' ||
      (value.phase !== 'prepared' && value.phase !== 'committed' && value.phase !== 'rolled-back')
    ) {
      return undefined;
    }
    if (
      !Array.isArray(value.previous) ||
      value.previous.length !== 3 ||
      !value.previous.every((entry) => typeof entry === 'boolean')
    ) {
      return undefined;
    }
    return value as RenderPublicationJournal;
  } catch {
    return undefined;
  }
}

async function restorePreviousPublication(
  artifacts: readonly RenderPublicationArtifact[],
  previous: readonly boolean[],
): Promise<void> {
  // The inputs receipt is the commit marker used by freshness readers. Keep
  // it absent until the MP4 and edit snapshot have both been restored.
  const commitMarker = artifacts[2];
  if (!commitMarker) throw new Error('render publication commit marker is missing');
  await rm(commitMarker.public, { force: true });
  for (const [index, artifact] of artifacts.entries()) {
    if (index === 2) continue;
    if (previous[index]) {
      const temporary = `${artifact.backup}.restore-${randomUUID()}`;
      try {
        await cloneFile(artifact.backup, temporary);
        await rename(temporary, artifact.public);
      } finally {
        await rm(temporary, { force: true });
      }
    } else await rm(artifact.public, { force: true });
  }
  if (previous[2]) {
    const temporary = `${commitMarker.backup}.restore-${randomUUID()}`;
    try {
      await cloneFile(commitMarker.backup, temporary);
      await rename(temporary, commitMarker.public);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  await syncDirectory(dirname(artifacts[0]?.public ?? commitMarker.public));
  await syncDirectory(dirname(commitMarker.public));
}

export async function removePublicationJob(jobDirAbs: string): Promise<void> {
  await rm(jobDirAbs, { recursive: true, force: true });
  await syncDirectory(dirname(jobDirAbs));
}

/** Caller must hold the project's render lock. */
export async function recoverRenderPublicationsUnderLock(
  projectDir: string,
): Promise<Result<void>> {
  const jobsDir = join(projectDir, 'edit', 'cache', 'render-jobs');
  let entries;
  try {
    entries = await readdir(jobsDir, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return ok(undefined);
    return err('io-failed', 'não foi possível verificar entregas de vídeo interrompidas', cause);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobDirAbs = join(jobsDir, entry.name);
    const raw = await readFile(join(jobDirAbs, PUBLICATION_JOURNAL), 'utf8').catch(() => '');
    const journal = parsePublicationJournal(raw);
    if (!journal) {
      const names = await readdir(jobDirAbs).catch(() => []);
      if (names.some((name) => name.startsWith('previous-'))) {
        // Never guess after a power loss: these may be the only recoverable
        // copies of the previous public set, so quarantine them in place.
        return err('io-failed', `entrega interrompida requer recuperação manual em "${jobDirAbs}"`);
      }
      // No journal and no backups means publication never touched a public path.
      await removePublicationJob(jobDirAbs);
      continue;
    }
    if (journal.phase === 'prepared') {
      const artifacts = publicationArtifacts(
        projectDir,
        jobDirAbs,
        journal.artifactKind,
        journal.canonical,
      );
      try {
        await restorePreviousPublication(artifacts, journal.previous);
        await writePublicationJournal(jobDirAbs, {
          ...journal,
          phase: 'rolled-back',
        });
      } catch (cause) {
        return err(
          'io-failed',
          'não foi possível recuperar a entrega de vídeo interrompida',
          cause,
        );
      }
    }
    await removePublicationJob(jobDirAbs);
  }
  return ok(undefined);
}

/** Recovers a process crash before serving or starting the next render. */
export async function recoverRenderPublications(projectDir: string): Promise<Result<void>> {
  let lock;
  try {
    lock = await acquireProjectLock(projectDir, 'render');
  } catch (cause) {
    // An active renderer owns both its staging directory and public commit.
    if (cause instanceof ProjectLockBusyError) return ok(undefined);
    return err('io-failed', 'não foi possível reservar a recuperação de vídeo', cause);
  }
  try {
    return await recoverRenderPublicationsUnderLock(projectDir);
  } finally {
    await lock.release();
  }
}

/**
 * Promotes the validated MP4 and its receipt set as one rollback-capable
 * transaction. The MP4 moves first, then the two receipts: an interrupted
 * promotion can therefore never leave new receipts advertising an old file.
 */
export async function promoteRenderPublication(
  artifacts: readonly RenderPublicationArtifact[],
  jobDirAbs: string,
  artifactKind: RenderArtifactKind,
  canonical: boolean,
  onRollbackFailure?: () => void,
): Promise<Result<void>> {
  const previous: boolean[] = [];

  try {
    // Backups are links/copies: the previous MP4 remains publicly available
    // until the staged MP4 atomically replaces that pathname.
    for (const artifact of artifacts) {
      const existed = await backupIfPresent(artifact.public, artifact.backup);
      previous.push(existed);
      if (existed) await syncFile(artifact.backup);
    }
    await syncDirectory(jobDirAbs);
    for (const artifact of artifacts) {
      if (artifact.temporary !== undefined) await syncFile(artifact.temporary);
    }
    await writePublicationJournal(jobDirAbs, {
      version: 1,
      artifactKind,
      canonical,
      phase: 'prepared',
      previous,
    });

    const [video, editReceipt, inputsReceipt] = artifacts;
    if (!video?.temporary || !editReceipt || !inputsReceipt) {
      throw new Error('render publication artifact set is incomplete');
    }
    // Invalidate freshness first, atomically swap the MP4, then publish the
    // inputs receipt last as the commit marker for the complete set.
    await rm(inputsReceipt.public, { force: true });
    await syncDirectory(dirname(inputsReceipt.public));
    await rename(video.temporary, video.public);
    await syncDirectory(dirname(video.public));
    if (canonical) {
      if (!editReceipt.temporary || !inputsReceipt.temporary) {
        throw new Error('canonical render receipts were not staged');
      }
      await rename(editReceipt.temporary, editReceipt.public);
      await syncDirectory(dirname(editReceipt.public));
      await rename(inputsReceipt.temporary, inputsReceipt.public);
      await syncDirectory(dirname(inputsReceipt.public));
    } else {
      await rm(editReceipt.public, { force: true });
      await syncDirectory(dirname(editReceipt.public));
    }
    await writePublicationJournal(jobDirAbs, {
      version: 1,
      artifactKind,
      canonical,
      phase: 'committed',
      previous,
    });
    return ok(undefined);
  } catch (cause) {
    try {
      if (previous.length === artifacts.length) {
        await restorePreviousPublication(artifacts, previous);
        await writePublicationJournal(jobDirAbs, {
          version: 1,
          artifactKind,
          canonical,
          phase: 'rolled-back',
          previous,
        });
      }
    } catch (rollbackCause) {
      onRollbackFailure?.();
      return err('io-failed', 'não foi possível restaurar a entrega de vídeo anterior', {
        cause,
        rollbackCause,
      });
    }
    return err('io-failed', 'não foi possível publicar a nova entrega de vídeo', cause);
  }
}
