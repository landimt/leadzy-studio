import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, extname, join, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { MediaProbe } from '../../core/render/plan.js';
import { err, ok, type Result } from '../../core/result.js';
import type { EditDoc } from '../../core/schema.js';
import { probeMedia, probeProjectAsset, probeStillImage } from './ffmpeg.js';
import { resolveProjectFile } from './project.js';

export interface ResolvedProjectMediaLease {
  /** Execution-only clone. Every media path points at a pinned regular file. */
  readonly doc: EditDoc;
  /** Inode identities captured by the same operation that pinned each path. */
  readonly authoringMediaHashes: ReadonlyMap<string, string>;
  /** Removes only this job's private links/copies. Safe to call more than once. */
  release(): Promise<void>;
}

export interface ResolvedProjectMediaOptions {
  /** Malformed lease directories younger than this are left alone. */
  readonly staleAfterMs?: number;
  /** Test seams. */
  readonly now?: () => number;
  readonly processAlive?: (pid: number) => boolean;
  readonly linkFile?: (source: string, destination: string) => Promise<void>;
  readonly beforeCopyOpen?: (source: string) => Promise<void>;
  readonly removeDir?: typeof rm;
  readonly cleanupRetryMs?: number;
}

const LEASE_DIRECTORY = join('edit', 'cache', 'input-leases');
const PROCESS_DIRECTORY = '.processes';
const OWNER_FILE = 'owner.json';
const activeLeaseDirectories = new Set<string>();
const PROCESS_INSTANCE_TOKEN = randomUUID();
const processRegistrations = new Map<string, Promise<void>>();

interface LeaseOwnerRecord {
  readonly pid: number;
  readonly token: string;
  readonly processToken: string;
  readonly acquiredAt: number;
}

interface ProcessInstanceRecord {
  readonly pid: number;
  readonly processToken: string;
  readonly registeredAt: number;
}

const LEASE_NAME = /^(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function parseLeaseOwner(raw: string): LeaseOwnerRecord | undefined {
  try {
    const candidate = JSON.parse(raw) as Partial<LeaseOwnerRecord>;
    return typeof candidate.pid === 'number' &&
      typeof candidate.token === 'string' &&
      typeof candidate.processToken === 'string' &&
      typeof candidate.acquiredAt === 'number'
      ? {
          pid: candidate.pid,
          token: candidate.token,
          processToken: candidate.processToken,
          acquiredAt: candidate.acquiredAt,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function parseProcessInstance(raw: string): ProcessInstanceRecord | undefined {
  try {
    const candidate = JSON.parse(raw) as Partial<ProcessInstanceRecord>;
    return typeof candidate.pid === 'number' &&
      typeof candidate.processToken === 'string' &&
      typeof candidate.registeredAt === 'number'
      ? {
          pid: candidate.pid,
          processToken: candidate.processToken,
          registeredAt: candidate.registeredAt,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

async function registerCurrentProcess(leaseRoot: string, now: () => number): Promise<void> {
  const registryDir = join(leaseRoot, PROCESS_DIRECTORY);
  await mkdir(registryDir, { recursive: true });
  const target = join(registryDir, `${String(process.pid)}.json`);
  const temporary = `${target}.${PROCESS_INSTANCE_TOKEN}.${randomUUID()}.tmp`;
  const record: ProcessInstanceRecord = {
    pid: process.pid,
    processToken: PROCESS_INSTANCE_TOKEN,
    registeredAt: now(),
  };
  await writeFile(temporary, `${JSON.stringify(record)}\n`);
  try {
    await rename(temporary, target);
  } catch (cause) {
    await rm(temporary, { force: true });
    throw cause;
  }
}

function ensureCurrentProcessRegistered(leaseRoot: string, now: () => number): Promise<void> {
  const existing = processRegistrations.get(leaseRoot);
  if (existing !== undefined) return existing;
  const registration = registerCurrentProcess(leaseRoot, now).catch((cause: unknown) => {
    processRegistrations.delete(leaseRoot);
    throw cause;
  });
  processRegistrations.set(leaseRoot, registration);
  return registration;
}

function mediaIdentity(info: {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly size: number | bigint;
  readonly mtimeMs: number;
}): string {
  return createHash('sha1')
    .update(`${String(info.dev)}:${String(info.ino)}:${String(info.size)}:${String(info.mtimeMs)}`)
    .digest('hex');
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

/**
 * Reclaims files left by a killed renderer. Live PIDs are never touched, so
 * concurrent long renders remain safe; malformed/dead owners age through a
 * short grace period before removal.
 */
export async function sweepStaleResolvedMediaLeases(
  projectDir: string,
  options: ResolvedProjectMediaOptions = {},
): Promise<number> {
  const leaseRoot = join(projectDir, LEASE_DIRECTORY);
  const now = options.now ?? Date.now;
  const processAlive = options.processAlive ?? defaultProcessAlive;
  const staleAfterMs = options.staleAfterMs ?? 60_000;
  const removeDir = options.removeDir ?? rm;
  await mkdir(leaseRoot, { recursive: true });
  const entries = await readdir(leaseRoot, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === PROCESS_DIRECTORY) continue;
    const path = join(leaseRoot, entry.name);
    if (activeLeaseDirectories.has(path)) continue;
    const isStale = async (): Promise<boolean> => {
      const nameMatch = LEASE_NAME.exec(entry.name);
      const ownerPath = join(path, OWNER_FILE);
      const [rawOwner, ownerInfo, directoryInfo] = await Promise.all([
        readFile(ownerPath, 'utf8').catch(() => ''),
        stat(ownerPath).catch(() => undefined),
        stat(path).catch(() => undefined),
      ]);
      const owner = parseLeaseOwner(rawOwner);
      const pid = nameMatch?.[1] === undefined ? undefined : Number(nameMatch[1]);
      const token = nameMatch?.[2];
      const validOwner =
        owner !== undefined && pid === owner.pid && token !== undefined && token === owner.token;
      const lastTouched = ownerInfo?.mtimeMs ?? directoryInfo?.mtimeMs;
      if (lastTouched === undefined) return false;
      if (!validOwner) return Math.max(0, now() - lastTouched) >= staleAfterMs;
      if (!processAlive(owner.pid)) return true;

      // A live PID alone is ambiguous after PID reuse. Each Studio process
      // atomically publishes its instance token for this project. A mismatch
      // proves that the lease belongs to an older process; absence/match must
      // be preserved, including SIGSTOP/debugger pauses of arbitrary length.
      const registered = parseProcessInstance(
        await readFile(
          join(leaseRoot, PROCESS_DIRECTORY, `${String(owner.pid)}.json`),
          'utf8',
        ).catch(() => ''),
      );
      return registered?.pid === owner.pid && registered.processToken !== owner.processToken;
    };
    if (!(await isStale())) continue;
    // Re-read owner + registry immediately before deletion. This closes the
    // recovery race where a new process publishes ownership after our scan.
    if (!(await isStale()) || activeLeaseDirectories.has(path)) continue;
    const reclaimed = await removeDir(path, { recursive: true, force: true }).then(
      () => true,
      () => false,
    );
    if (reclaimed) removed += 1;
  }
  return removed;
}

const HARDLINK_FALLBACK_ERRORS = new Set(['EACCES', 'EPERM', 'ENOTSUP', 'EXDEV']);

/**
 * Same inode, seen from two stats. Windows fills `dev` in only for a stat made
 * through an open descriptor — a stat by pathname reports 0 — so a strict
 * comparison would read every ordinary file as swapped and reject the copy.
 * The file index is stable in both, and the pathname is already fenced inside
 * the project, so the device is compared only when the platform supplies it.
 */
function sameFile(
  a: { readonly dev: number; readonly ino: number },
  b: { readonly dev: number; readonly ino: number },
): boolean {
  if (a.ino !== b.ino) return false;
  return a.dev === b.dev || (process.platform === 'win32' && (a.dev === 0 || b.dev === 0));
}

/**
 * Copies through an already-open descriptor. O_NOFOLLOW is used where the
 * platform provides it; realpath+lstat+descriptor identity are revalidated
 * after open as the portable defense for Windows reparse points. A pathname
 * swap after those checks cannot redirect the descriptor.
 */
async function copyPinnedFile(
  projectDir: string,
  source: string,
  destination: string,
): Promise<string> {
  const [beforeInfo, beforeLstat, root, beforeReal] = await Promise.all([
    stat(source),
    lstat(source),
    realpath(projectDir),
    realpath(source),
  ]);
  if (
    !beforeInfo.isFile() ||
    beforeLstat.isSymbolicLink() ||
    (beforeReal !== root && !beforeReal.startsWith(`${root}${sep}`))
  ) {
    throw new Error('render input is not a contained regular file');
  }
  const platformConstants = constants as unknown as Record<string, number | undefined>;
  const handle = await open(source, constants.O_RDONLY | (platformConstants.O_NOFOLLOW ?? 0));
  try {
    const [descriptorInfo, pathInfo, pathLstat, root, currentReal] = await Promise.all([
      handle.stat(),
      stat(source),
      lstat(source),
      realpath(projectDir),
      realpath(source),
    ]);
    const inside = currentReal === root || currentReal.startsWith(`${root}${sep}`);
    const sameInode = sameFile(descriptorInfo, beforeInfo) && sameFile(descriptorInfo, pathInfo);
    if (
      !descriptorInfo.isFile() ||
      !pathInfo.isFile() ||
      pathLstat.isSymbolicLink() ||
      !inside ||
      currentReal !== beforeReal ||
      !sameInode
    ) {
      throw new Error('render input changed while its descriptor was being reserved');
    }
    const identity = mediaIdentity(descriptorInfo);
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      createWriteStream(destination, { flags: 'wx' }),
    );
    const completedInfo = await handle.stat();
    if (mediaIdentity(completedInfo) !== identity) {
      throw new Error('render input changed while it was being copied');
    }
    return identity;
  } finally {
    await handle.close();
  }
}

/** Keep cache filenames readable without allowing path separators. */
function safeStem(path: string): string {
  const stem = basename(path, extname(path)).replace(/[^a-zA-Z0-9_-]+/g, '-');
  return stem.slice(0, 48) || 'media';
}

/**
 * Creates a job-scoped hardlink after realpath containment succeeds. On a
 * filesystem without hardlinks it copies through a no-follow descriptor.
 * ffmpeg then opens this private directory entry rather than an authoring
 * pathname, so replacing either the original symlink or its terminal path
 * cannot redirect an in-flight render. Callers compare both the pinned input
 * and current authoring input at completion to reject in-place/replacement
 * writes.
 */
export async function acquireResolvedProjectMedia(
  projectDir: string,
  doc: EditDoc,
  options: ResolvedProjectMediaOptions = {},
): Promise<Result<ResolvedProjectMediaLease>> {
  const leaseRoot = join(projectDir, LEASE_DIRECTORY);
  const token = randomUUID();
  const leaseDir = join(leaseRoot, `${String(process.pid)}-${token}`);
  const pinnedByAuthoringPath = new Map<string, string>();
  const authoringMediaHashes = new Map<string, string>();
  let nextIndex = 0;
  let released = false;
  let releaseInFlight: Promise<void> | undefined;
  let cleanupRetry: NodeJS.Timeout | undefined;

  const removeDir = options.removeDir ?? rm;
  const cleanupRetryMs = options.cleanupRetryMs ?? 1_000;

  const release = (): Promise<void> => {
    if (released) return Promise.resolve();
    if (releaseInFlight !== undefined) return releaseInFlight;
    releaseInFlight = removeDir(leaseDir, { recursive: true, force: true })
      .then(() => {
        released = true;
        if (cleanupRetry !== undefined) clearTimeout(cleanupRetry);
        activeLeaseDirectories.delete(leaseDir);
      })
      .catch(() => {
        if (cleanupRetry === undefined) {
          cleanupRetry = setTimeout(() => {
            cleanupRetry = undefined;
            void release();
          }, cleanupRetryMs);
          cleanupRetry.unref();
        }
      })
      .finally(() => {
        releaseInFlight = undefined;
      });
    return releaseInFlight;
  };

  try {
    await mkdir(leaseRoot, { recursive: true });
    await ensureCurrentProcessRegistered(leaseRoot, options.now ?? Date.now);
    await sweepStaleResolvedMediaLeases(projectDir, options);
    activeLeaseDirectories.add(leaseDir);
    await mkdir(leaseDir);
    const owner: LeaseOwnerRecord = {
      pid: process.pid,
      token,
      processToken: PROCESS_INSTANCE_TOKEN,
      acquiredAt: (options.now ?? Date.now)(),
    };
    const ownerPath = join(leaseDir, OWNER_FILE);
    await writeFile(ownerPath, `${JSON.stringify(owner)}\n`);
    const pin = async (authoringPath: string): Promise<Result<string>> => {
      const cached = pinnedByAuthoringPath.get(authoringPath);
      if (cached !== undefined) return ok(cached);

      const resolved = await resolveProjectFile(projectDir, authoringPath);
      if (!resolved.ok) return resolved;
      const extension = extname(authoringPath) || extname(resolved.value);
      const pinned = join(
        leaseDir,
        `${String(nextIndex).padStart(3, '0')}-${safeStem(authoringPath)}${extension}`,
      );
      nextIndex += 1;
      try {
        const linkFile = options.linkFile ?? link;
        let authoringHash: string;
        try {
          await linkFile(resolved.value, pinned);
          const info = await lstat(pinned);
          // POSIX hardlink() can preserve a symlink itself on some platforms.
          // Only a regular inode is a valid render input.
          if (!info.isFile() || info.isSymbolicLink()) {
            return err(
              'path-outside-project',
              `media changed while it was being reserved: "${authoringPath}"`,
            );
          }
          authoringHash = mediaIdentity(info);
        } catch (cause) {
          const code = (cause as NodeJS.ErrnoException).code;
          if (code === undefined || !HARDLINK_FALLBACK_ERRORS.has(code)) throw cause;
          await options.beforeCopyOpen?.(resolved.value);
          authoringHash = await copyPinnedFile(projectDir, resolved.value, pinned);
        }
        authoringMediaHashes.set(authoringPath, authoringHash);
      } catch (cause) {
        return err('io-failed', `cannot reserve project media "${authoringPath}"`, cause);
      }
      pinnedByAuthoringPath.set(authoringPath, pinned);
      return ok(pinned);
    };

    const sources: Record<string, EditDoc['sources'][string]> = {};
    for (const [key, source] of Object.entries(doc.sources)) {
      const pinned = await pin(source.path);
      if (!pinned.ok) {
        await release();
        return pinned;
      }
      sources[key] = { ...source, path: pinned.value };
    }

    const tracks: EditDoc['tracks'][number][] = [];
    for (const track of doc.tracks) {
      if (track.kind !== 'overlay') {
        tracks.push(track);
        continue;
      }
      const blocks: (typeof track.blocks)[number][] = [];
      for (const block of track.blocks) {
        const pinned = await pin(block.file);
        if (!pinned.ok) {
          await release();
          return pinned;
        }
        blocks.push({ ...block, file: pinned.value });
      }
      tracks.push({ ...track, blocks });
    }

    let canvas = doc.canvas;
    if (canvas?.background.kind === 'image') {
      const pinned = await pin(canvas.background.file);
      if (!pinned.ok) {
        await release();
        return pinned;
      }
      canvas = {
        ...canvas,
        background: { ...canvas.background, file: pinned.value },
      };
    }

    return ok({
      doc: { ...doc, sources, tracks, ...(canvas === undefined ? {} : { canvas }) },
      authoringMediaHashes,
      release,
    });
  } catch (cause) {
    await release();
    return err('io-failed', 'cannot create an immutable project-media lease', cause);
  }
}

/** Probe a document returned by acquireResolvedProjectMedia. */
export async function probeResolvedProjectMedia(
  doc: EditDoc,
): Promise<Result<Map<string, MediaProbe>>> {
  const probes = new Map<string, MediaProbe>();
  for (const [key, source] of Object.entries(doc.sources)) {
    // A render lease can contain first-class audio-only sources. Keep
    // `probeMedia` for visual overlays, but use the generic project probe for
    // authored sources so music/SFX survives the immutable lease boundary.
    const probed = await probeProjectAsset(source.path);
    if (!probed.ok) return probed;
    probes.set(key, probed.value);
  }
  const canvasBackground = doc.canvas?.background;
  if (canvasBackground?.kind === 'image') {
    const probed = await probeStillImage(canvasBackground.file);
    if (!probed.ok) return probed;
  } else if (canvasBackground?.kind === 'video') {
    const probe = probes.get(canvasBackground.source);
    if (probe === undefined) {
      return err(
        'not-found',
        `no media information for canvas background "${canvasBackground.source}"`,
      );
    }
    if (probe.kind !== 'video') {
      return err(
        'invalid-edit-json',
        `canvas background source "${canvasBackground.source}" has no video stream`,
      );
    }
  }
  for (const track of doc.tracks) {
    if (track.kind !== 'overlay') continue;
    for (const block of track.blocks) {
      if (block.duration !== undefined || probes.has(block.file)) continue;
      if (/\.(png|jpg|jpeg|webp)$/i.test(block.file)) continue;
      const probed = await probeMedia(block.file);
      if (!probed.ok) return probed;
      probes.set(block.file, probed.value);
    }
  }
  return ok(probes);
}
