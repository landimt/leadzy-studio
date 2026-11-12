import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { containedPath } from '../../core/paths.js';
import { err, type Result } from '../../core/result.js';
import { baseTrackOf, parseEditDoc, type EditDoc } from '../../core/schema.js';
import { editDocHash } from './project.js';

export type HistoryOrigin = 'ui' | 'title' | 'suggest' | 'restore' | 'agent' | 'startup';

export interface HistoryEntry {
  readonly id: string;
  readonly ts: string;
  readonly origin: HistoryOrigin;
  readonly hash: string;
  readonly totalDurationS: number;
  readonly blocks: number;
}

const HISTORY_ORIGINS: readonly string[] = [
  'ui',
  'title',
  'suggest',
  'restore',
  'agent',
  'startup',
];

/** A snapshot filename is `<ts>-<origin>.json`; ts sorts chronologically as a string. */
const FILE_NAME_PATTERN =
  /^((\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z)-(ui|title|suggest|restore|agent|startup)\.json$/;

/** Same shape, without the `.json` suffix — what `read()` receives from callers. */
const ID_PATTERN = /^[0-9T-]+Z-(ui|title|suggest|restore|agent|startup)$/;

const COALESCE_WINDOW_MS = 60_000;
const MAX_SNAPSHOTS = 100;

function isHistoryOrigin(value: string): value is HistoryOrigin {
  return HISTORY_ORIGINS.includes(value);
}

function toFileTimestamp(millis: number): string {
  return new Date(millis).toISOString().replace(/[:.]/g, '-');
}

interface ParsedFileName {
  readonly id: string;
  readonly isoTs: string;
  readonly tsMillis: number;
  readonly origin: HistoryOrigin;
}

function parseFileName(fileName: string): ParsedFileName | undefined {
  const match = FILE_NAME_PATTERN.exec(fileName);
  const fileTs = match?.[1];
  const date = match?.[2];
  const hh = match?.[3];
  const mm = match?.[4];
  const ss = match?.[5];
  const ms = match?.[6];
  const origin = match?.[7];
  if (
    fileTs === undefined ||
    date === undefined ||
    hh === undefined ||
    mm === undefined ||
    ss === undefined ||
    ms === undefined ||
    origin === undefined ||
    !isHistoryOrigin(origin)
  ) {
    return undefined;
  }
  const isoTs = `${date}T${hh}:${mm}:${ss}.${ms}Z`;
  return { id: `${fileTs}-${origin}`, isoTs, tsMillis: Date.parse(isoTs), origin };
}

interface NewestSnapshot {
  readonly fileName: string;
  readonly origin: HistoryOrigin;
  readonly hash: string;
  readonly tsMillis: number;
}

/**
 * Post-image snapshots of edit.json under `edit/history/`, one file per
 * meaningful change. Never allowed to break a save: every public method that
 * writes swallows its own errors (logged, not thrown).
 */
export class EditHistory {
  private readonly projectDir: string;
  private readonly now: () => number;
  private cache: NewestSnapshot | undefined;
  // record() has multiple unsynchronized callers (the file watcher's
  // external-edit detection and the restore route's orphan-state safety net
  // both call it outside the server's own commitChain) — this queue is what
  // keeps two concurrent calls from deriving the same `now()`-based filename
  // and racing on the same rename() target.
  private queue: Promise<void> = Promise.resolve();

  constructor(projectDir: string, now: () => number = Date.now) {
    this.projectDir = projectDir;
    this.now = now;
  }

  private historyDir(): string {
    return join(this.projectDir, 'edit', 'history');
  }

  /**
   * Records a post-image snapshot. No-ops on a hash match against the newest
   * snapshot (dedupe). A run of same-origin 'ui' autosaves within 60s
   * replaces the newest snapshot in place instead of piling up files — other
   * origins always get their own file. Calls are serialized internally, so
   * any number of concurrent callers is safe.
   */
  async record(doc: EditDoc, origin: HistoryOrigin): Promise<void> {
    const task = this.queue.then(() => this.writeSnapshot(doc, origin));
    this.queue = task;
    return task;
  }

  private async writeSnapshot(doc: EditDoc, origin: HistoryOrigin): Promise<void> {
    try {
      // Round-trip through the schema before hashing/persisting: a raw,
      // pre-validation `doc` can differ in key order from its own
      // schema-ordered re-parse (e.g. a spread that appends an absent
      // optional field at the end instead of its schema position), and
      // every future read of this snapshot (newestSnapshot/list) hashes the
      // re-parsed form. Hashing the raw doc here would silently defeat the
      // dedupe check below against those future reads.
      const validated = parseEditDoc(doc);
      if (!validated.ok) {
        console.warn(
          `edit history: refusing to record an invalid doc (origin=${origin}): ${validated.error.message}`,
        );
        return;
      }
      const canonical = validated.value;
      const hash = editDocHash(canonical);
      const newest = await this.newestSnapshot();
      if (newest?.hash === hash) return;

      const coalesce =
        origin === 'ui' &&
        newest?.origin === 'ui' &&
        this.now() - newest.tsMillis < COALESCE_WINDOW_MS;

      const dir = this.historyDir();
      await mkdir(dir, { recursive: true });

      // Two non-coalesced writes landing on the same clock millisecond (a
      // frozen/coarse clock, or two callers racing on the internal queue)
      // would otherwise derive the same filename and the second overwrites
      // the first — bump strictly past the newest known snapshot instead.
      const tsMillis = coalesce
        ? newest.tsMillis
        : Math.max(this.now(), (newest?.tsMillis ?? 0) + 1);
      const fileName = coalesce ? newest.fileName : `${toFileTimestamp(tsMillis)}-${origin}.json`;
      const path = join(dir, fileName);
      const tmpPath = `${path}.tmp`;
      await writeFile(tmpPath, JSON.stringify(canonical, null, 2) + '\n');
      await rename(tmpPath, path);

      this.cache = { fileName, origin, hash, tsMillis };
      await this.prune();
    } catch (cause) {
      console.warn(`edit history: failed to record snapshot (origin=${origin})`, cause);
    }
  }

  /** Newest first. Corrupted or unreadable snapshot files are skipped, not thrown. */
  async list(): Promise<HistoryEntry[]> {
    const dir = this.historyDir();
    const names = await readdir(dir).catch(() => [] as string[]);
    const entries: HistoryEntry[] = [];
    for (const fileName of names
      .filter((name) => name.endsWith('.json'))
      .sort()
      .reverse()) {
      const parsed = parseFileName(fileName);
      if (!parsed) {
        console.warn(`edit history: skipping unrecognized snapshot file "${fileName}"`);
        continue;
      }
      const doc = await this.readSnapshotFile(join(dir, fileName));
      if (!doc.ok) {
        console.warn(
          `edit history: skipping corrupted snapshot "${fileName}": ${doc.error.message}`,
        );
        continue;
      }
      entries.push({
        id: parsed.id,
        ts: parsed.isoTs,
        origin: parsed.origin,
        hash: editDocHash(doc.value),
        totalDurationS: doc.value.totalDurationS ?? 0,
        blocks: baseTrackOf(doc.value).blocks.length,
      });
    }
    return entries;
  }

  /**
   * `id` is untrusted — validated by pattern, then confined to the history
   * dir. No realpath/symlink check on top of that (unlike `safePath` for
   * media routes): every file directly under `edit/history/` is written by
   * this class alone (transcript archives live in the `transcripts/`
   * subfolder, which the id pattern cannot address), so there is no
   * untrusted symlink to defend against here.
   */
  async read(id: string): Promise<Result<EditDoc>> {
    if (!ID_PATTERN.test(id)) {
      return err('not-found', `invalid history entry id "${id}"`);
    }
    const contained = containedPath(this.historyDir(), `${id}.json`);
    if (!contained.ok) {
      return err('not-found', `invalid history entry id "${id}"`);
    }
    return this.readSnapshotFile(contained.value);
  }

  private async readSnapshotFile(path: string): Promise<Result<EditDoc>> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (cause) {
      return err('not-found', `no history snapshot at "${path}"`, cause);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (cause) {
      return err('invalid-edit-json', `history snapshot at "${path}" is not valid JSON`, cause);
    }
    return parseEditDoc(json);
  }

  private async newestSnapshot(): Promise<NewestSnapshot | undefined> {
    if (this.cache) return this.cache;
    const dir = this.historyDir();
    const names = await readdir(dir).catch(() => [] as string[]);
    const fileName = names
      .filter((name) => name.endsWith('.json'))
      .sort()
      .at(-1);
    if (fileName === undefined) return undefined;
    const parsed = parseFileName(fileName);
    if (!parsed) return undefined;
    const doc = await this.readSnapshotFile(join(dir, fileName));
    if (!doc.ok) return undefined;
    const snapshot: NewestSnapshot = {
      fileName,
      origin: parsed.origin,
      hash: editDocHash(doc.value),
      tsMillis: parsed.tsMillis,
    };
    this.cache = snapshot;
    return snapshot;
  }

  private async prune(): Promise<void> {
    const dir = this.historyDir();
    const names = (await readdir(dir).catch(() => [] as string[]))
      .filter((name) => name.endsWith('.json'))
      .sort();
    const excess = names.length - MAX_SNAPSHOTS;
    if (excess <= 0) return;
    for (const fileName of names.slice(0, excess)) {
      await unlink(join(dir, fileName)).catch(() => undefined);
    }
  }
}
