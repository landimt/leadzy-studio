import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

interface LockRecord {
  readonly pid: number;
  readonly token: string;
  readonly acquiredAt: number;
}

export interface ProjectLock {
  readonly path: string;
  release(): Promise<void>;
}

export interface ProjectLockOptions {
  /** How long to wait for the current owner before reporting a busy project. */
  readonly waitMs?: number;
  readonly retryMs?: number;
  /** Malformed lock files older than this can be recovered after a crash. */
  readonly staleAfterMs?: number;
  /** Test seams. */
  readonly now?: () => number;
  readonly processAlive?: (pid: number) => boolean;
}

export class ProjectLockBusyError extends Error {
  readonly code = 'project-lock-busy';

  constructor(readonly lockName: string) {
    super(`the project is busy with another operation (${lockName})`);
    this.name = 'ProjectLockBusyError';
  }
}

function defaultProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseRecord(raw: string): LockRecord | undefined {
  try {
    const candidate = JSON.parse(raw) as Partial<LockRecord>;
    return typeof candidate.pid === 'number' &&
      typeof candidate.token === 'string' &&
      typeof candidate.acquiredAt === 'number'
      ? { pid: candidate.pid, token: candidate.token, acquiredAt: candidate.acquiredAt }
      : undefined;
  } catch {
    return undefined;
  }
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Cross-process lock for operations that publish shared project state
 * (`edit.json`, render artifacts, previews, and proxies). The owner PID prevents an old
 * timestamp from stealing a legitimately long render; crash leftovers are
 * recoverable once their process is gone.
 */
export async function acquireProjectLock(
  projectDir: string,
  lockName: 'edit-write' | 'render' | 'audio-preview' | 'proxy',
  options: ProjectLockOptions = {},
): Promise<ProjectLock> {
  const now = options.now ?? Date.now;
  const processAlive = options.processAlive ?? defaultProcessAlive;
  const waitMs = options.waitMs ?? 0;
  const retryMs = options.retryMs ?? 40;
  const staleAfterMs = options.staleAfterMs ?? 10 * 60_000;
  const lockDir = join(projectDir, 'edit', '.locks');
  const lockPath = join(lockDir, `${lockName}.lock`);
  const reclaimName = `${lockName}.lock.reclaim`;
  const reclaimPath = join(lockDir, reclaimName);
  const deadline = now() + waitMs;
  await mkdir(lockDir, { recursive: true });

  const reclaimMarkers = async (): Promise<string[]> => {
    const entries = await readdir(lockDir, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          (entry.name === reclaimName || entry.name.startsWith(`${reclaimName}.`)),
      )
      .map((entry) => join(lockDir, entry.name));
  };

  const markerRecordPath = (markerPath: string): string => join(markerPath, 'owner.json');

  const writeMarkerOwner = async (markerPath: string): Promise<void> => {
    const record: LockRecord = { pid: process.pid, token: randomUUID(), acquiredAt: now() };
    await writeFile(markerRecordPath(markerPath), `${JSON.stringify(record)}\n`);
  };

  const releaseMarker = async (markerPath: string): Promise<void> => {
    await unlink(markerRecordPath(markerPath)).catch(() => undefined);
    await rmdir(markerPath).catch(() => undefined);
  };

  const createReclaimMarker = async (): Promise<boolean> => {
    // Publish a fully initialized, non-empty directory in one rename. This
    // avoids an observable empty canonical marker when staleAfterMs is zero.
    const temporaryMarker = join(lockDir, `.${reclaimName}.${randomUUID()}.tmp`);
    await mkdir(temporaryMarker);
    try {
      await writeMarkerOwner(temporaryMarker);
      await rename(temporaryMarker, reclaimPath);
      return true;
    } catch (cause) {
      await releaseMarker(temporaryMarker);
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY') return false;
      throw cause;
    }
  };

  const staleRecordAt = async (
    path: string,
    fallbackStatPath = path,
  ): Promise<{ readonly stale: boolean }> => {
    const [raw, info] = await Promise.all([
      readFile(path, 'utf8').catch(() => ''),
      stat(path)
        .catch(() => stat(fallbackStatPath))
        .catch(() => undefined),
    ]);
    const record = parseRecord(raw);
    const ageMs = info ? Math.max(0, now() - info.mtimeMs) : 0;
    const ownerGone = record !== undefined && !processAlive(record.pid);
    const malformedAndStale = record === undefined && ageMs >= staleAfterMs;
    return {
      stale: (ownerGone && ageMs >= Math.min(1_000, staleAfterMs)) || malformedAndStale,
    };
  };

  const removeStaleLock = async (): Promise<void> => {
    if ((await staleRecordAt(lockPath)).stale) await unlink(lockPath).catch(() => undefined);
  };

  const markerNameRecord = (markerPath: string): LockRecord | undefined => {
    const prefix = `${reclaimPath}.`;
    if (!markerPath.startsWith(prefix)) return undefined;
    const [pidRaw, acquiredAtRaw, token] = markerPath.slice(prefix.length).split('.', 3);
    const pid = Number(pidRaw);
    const acquiredAt = Number(acquiredAtRaw);
    return Number.isInteger(pid) && pid > 0 && Number.isFinite(acquiredAt) && token
      ? { pid, acquiredAt, token }
      : undefined;
  };

  const markerIsStale = async (markerPath: string): Promise<boolean> => {
    // Takeover markers carry their owner in the pathname, so the ownership
    // transfer is complete at the same atomic rename that publishes the name.
    const namedRecord = markerNameRecord(markerPath);
    if (namedRecord) {
      const ageMs = Math.max(0, now() - namedRecord.acquiredAt);
      return !processAlive(namedRecord.pid) && ageMs >= Math.min(1_000, staleAfterMs);
    }
    return (await staleRecordAt(markerRecordPath(markerPath), markerPath)).stale;
  };

  /**
   * A crashed reclaimer leaves its directory behind. Never delete and reuse
   * that pathname: two observers could otherwise delete each other's fresh
   * mutex (the classic ABA race). Renaming the sole stale marker to a brand-new
   * name atomically transfers ownership, while every marker name keeps regular
   * acquirers out until the winner finishes.
   */
  const takeOverAbandonedMarker = async (
    markers: readonly string[],
  ): Promise<string | undefined> => {
    if (markers.length !== 1) return undefined;
    const marker = markers[0];
    if (!marker) return undefined;
    if (!(await markerIsStale(marker))) return undefined;
    const claimedMarker = `${reclaimPath}.${String(process.pid)}.${String(now())}.${randomUUID()}`;
    try {
      await rename(marker, claimedMarker);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw cause;
    }
    return claimedMarker;
  };

  for (;;) {
    const markers = await reclaimMarkers();
    if (markers.length > 0) {
      const claimedMarker = await takeOverAbandonedMarker(markers);
      if (claimedMarker) {
        try {
          await removeStaleLock();
        } finally {
          await releaseMarker(claimedMarker);
        }
        continue;
      }
      if (now() >= deadline) throw new ProjectLockBusyError(lockName);
      await delay(retryMs);
      continue;
    }
    const token = randomUUID();
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockPath, 'wx');
      const record: LockRecord = { pid: process.pid, token, acquiredAt: now() };
      await handle.writeFile(`${JSON.stringify(record)}\n`);
      await handle.close();
      handle = undefined;
      if ((await reclaimMarkers()).length > 0) {
        const current = parseRecord(await readFile(lockPath, 'utf8').catch(() => ''));
        if (current?.token === token) await unlink(lockPath).catch(() => undefined);
        if (now() >= deadline) throw new ProjectLockBusyError(lockName);
        await delay(retryMs);
        continue;
      }
      return {
        path: lockPath,
        release: async () => {
          const current = parseRecord(await readFile(lockPath, 'utf8').catch(() => ''));
          if (current?.token === token) await unlink(lockPath).catch(() => undefined);
        },
      };
    } catch (cause) {
      const ownedLockFile = handle !== undefined;
      await handle?.close().catch(() => undefined);
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        if (ownedLockFile) await unlink(lockPath).catch(() => undefined);
        throw cause;
      }

      const [raw, info] = await Promise.all([
        readFile(lockPath, 'utf8').catch(() => ''),
        stat(lockPath).catch(() => undefined),
      ]);
      const existing = parseRecord(raw);
      const ageMs = info ? Math.max(0, now() - info.mtimeMs) : 0;
      const ownerGone = existing !== undefined && !processAlive(existing.pid);
      const malformedAndStale = existing === undefined && ageMs >= staleAfterMs;
      if ((ownerGone && ageMs >= Math.min(1_000, staleAfterMs)) || malformedAndStale) {
        if (!(await createReclaimMarker())) {
          if (now() >= deadline) throw new ProjectLockBusyError(lockName);
          await delay(retryMs);
          continue;
        }
        try {
          // Re-read only after owning the recovery mutex. The record may
          // have changed since the first observation.
          await removeStaleLock();
        } finally {
          await releaseMarker(reclaimPath);
        }
        continue;
      }
      if (now() >= deadline) throw new ProjectLockBusyError(lockName);
      await delay(retryMs);
    }
  }
}
