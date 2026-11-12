import { unwrap } from '../../core/result.js';
import type { EditDoc } from '../../core/schema.js';
import type { EditHistory, HistoryOrigin } from './editHistory.js';
import { editDocHash, loadEditDoc, saveEditDoc } from './project.js';
import { acquireProjectLock } from './projectLock.js';

const EDIT_LOCK_WAIT_MS = 5_000;

export interface EditWriterOptions {
  /** Test seam; production waits for a busy edit-write lock for 5 s. */
  readonly lockWaitMs?: number;
}

export class EditConflictError extends Error {
  constructor(readonly currentHash: string) {
    super(
      `edit.json changed on disk (current hash ${currentHash}); reload the project, or confirm you want to keep your version`,
    );
    this.name = 'EditConflictError';
  }
}

/**
 * Every edit.json write goes through one instance: writes are chained so a
 * read-modify-write never sees a snapshot older than the previous commit,
 * and each landed write is recorded in the history and remembered by hash
 * so the file watcher can tell the server's own echo from an external edit.
 *
 * Not safe to share across processes — the on-disk project lock covers that.
 */
export class EditWriter {
  private chain: Promise<unknown> = Promise.resolve();
  private savedHash = '';

  constructor(
    private readonly projectDir: string,
    private readonly history: Pick<EditHistory, 'record'>,
    private readonly options: EditWriterOptions = {},
  ) {}

  /** Hash of the last document this writer saved; '' before the first write. */
  get lastSavedHash(): string {
    return this.savedHash;
  }

  /** Serializes every edit.json write: save → record snapshot → return hash. */
  commit(doc: EditDoc, origin: HistoryOrigin, expectHash?: string): Promise<string> {
    return this.enqueue(async () => {
      const loaded = await loadEditDoc(this.projectDir);
      // A deliberate history restore is also the recovery path for a
      // missing/truncated document. Ordinary writes still require a readable
      // current edit, and I/O errors must never be treated as corruption.
      if (
        !loaded.ok &&
        origin === 'restore' &&
        expectHash === undefined &&
        (loaded.error.code === 'not-found' || loaded.error.code === 'invalid-edit-json')
      ) {
        return this.save(doc, origin);
      }
      const current = unwrap(loaded);
      const currentHash = editDocHash(current.doc);
      if (expectHash !== undefined && currentHash !== expectHash) {
        throw new EditConflictError(currentHash);
      }
      if (origin === 'restore') {
        // Capture the document actually being replaced while holding the
        // edit-write lock, after any pending edits have landed.
        await this.history.record(current.doc, 'agent');
      }
      return this.save(doc, origin);
    });
  }

  /**
   * Read-modify-write INSIDE the serialized chain: the doc is loaded after
   * every pending commit has landed, so a concurrent title/suggest/PUT can
   * never be overwritten by a stale snapshot.
   */
  update(update: (doc: EditDoc) => EditDoc, origin: HistoryOrigin): Promise<string> {
    return this.enqueue(async () => {
      const loaded = unwrap(await loadEditDoc(this.projectDir));
      return this.save(update(loaded.doc), origin);
    });
  }

  private async save(doc: EditDoc, origin: HistoryOrigin): Promise<string> {
    // The hash of what saveEditDoc actually wrote, not editDocHash(doc) —
    // zod's parse can reorder keys/apply defaults, and the watcher hashes
    // the file it reads back, so those two must always agree.
    const hash = unwrap(await saveEditDoc(this.projectDir, doc));
    this.savedHash = hash;
    await this.history.record(doc, origin);
    return hash;
  }

  private enqueue(write: () => Promise<string>): Promise<string> {
    const task = this.chain.then(async () => {
      const lock = await acquireProjectLock(this.projectDir, 'edit-write', {
        waitMs: this.options.lockWaitMs ?? EDIT_LOCK_WAIT_MS,
      });
      try {
        return await write();
      } finally {
        await lock.release();
      }
    });
    // A rejected write must not poison the chain for the next writer.
    this.chain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}
