import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EditDoc } from '../../core/schema.js';
import { EditHistory } from './editHistory.js';
import { EditConflictError, EditWriter } from './editWriter.js';
import { editDocHash, editJsonPath, loadEditDoc } from './project.js';
import { ProjectLockBusyError } from './projectLock.js';

function makeDoc(totalDurationS: number): EditDoc {
  return {
    version: 2,
    fps: 25,
    output: { width: 1080, height: 1920, loudnormLufs: -14 },
    sources: { cam: { path: 'camera.mp4' } },
    tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 1, out: 5 }] }],
    subtitles: { enabled: false, preset: '2p-caps' },
    totalDurationS,
  };
}

let projectDir: string;
let history: EditHistory;
let writer: EditWriter;

/** Resolves true if `promise` settles within `ms`, false otherwise. */
function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(false);
      }, ms);
    }),
  ]);
}

async function savedDoc(): Promise<EditDoc> {
  const loaded = await loadEditDoc(projectDir);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value.doc;
}

async function savedHash(): Promise<string> {
  return editDocHash(await savedDoc());
}

beforeEach(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'leadzy-edit-writer-'));
  await mkdir(join(projectDir, 'edit'), { recursive: true });
  await writeFile(editJsonPath(projectDir), JSON.stringify(makeDoc(1), null, 2) + '\n');
  history = new EditHistory(projectDir);
  writer = new EditWriter(projectDir, history);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('EditWriter.commit', () => {
  it('saves the document, returns the hash of what was written and remembers it', async () => {
    const hash = await writer.commit(makeDoc(2), 'ui');

    expect(hash).toBe(await savedHash());
    expect((await savedDoc()).totalDurationS).toBe(2);
    expect(writer.lastSavedHash).toBe(hash);
  });

  it('reports the hash of what was written, not of the document it was handed', async () => {
    // Same content, different key order: JSON.stringify — and therefore
    // editDocHash — differs from the schema-ordered document saveEditDoc writes.
    const reordered: EditDoc = { totalDurationS: 2, ...makeDoc(2) };
    expect(editDocHash(reordered)).not.toBe(editDocHash(makeDoc(2)));

    const hash = await writer.commit(reordered, 'ui');

    expect(hash).toBe(editDocHash(await savedDoc()));
    expect(hash).not.toBe(editDocHash(reordered));
    expect(writer.lastSavedHash).toBe(hash);
  });

  it('exposes the new hash before the history snapshot is recorded', async () => {
    let hashSeenByHistory = '';
    const recorder = {
      record: (): Promise<void> => {
        hashSeenByHistory = observed.lastSavedHash;
        return Promise.resolve();
      },
    };
    const observed = new EditWriter(projectDir, recorder);

    const hash = await observed.commit(makeDoc(2), 'ui');

    expect(hashSeenByHistory).toBe(hash);
  });

  it('does not settle until the history snapshot has been recorded', async () => {
    let recordStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      recordStarted = resolve;
    });
    let finishRecording: () => void = () => undefined;
    const recorder = {
      record: (): Promise<void> => {
        recordStarted();
        return new Promise((resolve) => {
          finishRecording = resolve;
        });
      },
    };
    const gated = new EditWriter(projectDir, recorder);

    const commit = gated.commit(makeDoc(2), 'ui');
    expect(await settledWithin(started, 1_000)).toBe(true);
    expect(await settledWithin(commit, 200)).toBe(false);

    finishRecording();
    expect(await commit).toBe(await savedHash());
  });

  it('rejects when edit.json is missing and leaves lastSavedHash untouched', async () => {
    await rm(editJsonPath(projectDir));

    await expect(writer.commit(makeDoc(2), 'ui')).rejects.toThrow(/edit\.json/);

    expect(writer.lastSavedHash).toBe('');
    expect(await history.list()).toEqual([]);
  });

  it.each(['missing', 'truncated', 'invalid-schema'])(
    'restores a valid snapshot when the current edit is %s',
    async (failure) => {
      if (failure === 'missing') await rm(editJsonPath(projectDir));
      else
        await writeFile(editJsonPath(projectDir), failure === 'truncated' ? '{"version":' : '{}');

      const hash = await writer.commit(makeDoc(8), 'restore');

      expect((await savedDoc()).totalDurationS).toBe(8);
      expect(hash).toBe(await savedHash());
      expect((await history.list()).map((entry) => entry.origin)).toEqual(['restore']);
    },
  );

  it('does not restore over an unreadable current edit', async () => {
    await rm(editJsonPath(projectDir));
    await mkdir(editJsonPath(projectDir));

    await expect(writer.commit(makeDoc(8), 'restore')).rejects.toThrow('io-failed');
    expect(await history.list()).toEqual([]);
    expect(writer.lastSavedHash).toBe('');
  });

  it('preserves the current on-disk edit under the lock before restoring', async () => {
    // This edit has not reached the file watcher/history yet.
    await writeFile(editJsonPath(projectDir), JSON.stringify(makeDoc(7)));

    await writer.commit(makeDoc(2), 'restore');

    expect((await history.list()).map((entry) => [entry.origin, entry.totalDurationS])).toEqual([
      ['restore', 2],
      ['agent', 7],
    ]);
  });

  it('preserves a queued edit that lands before the restore acquires its lock', async () => {
    const pending = writer.commit(makeDoc(7), 'ui');
    const restoring = writer.commit(makeDoc(2), 'restore');
    await Promise.all([pending, restoring]);

    expect((await savedDoc()).totalDurationS).toBe(2);
    expect((await history.list()).map((entry) => entry.totalDurationS)).toEqual([2, 7]);
  });

  it('serializes two concurrent commits: the second sees the first and a stale expectation loses', async () => {
    const initialHash = await savedHash();

    const first = writer.commit(makeDoc(2), 'ui', initialHash);
    const stale = writer.commit(makeDoc(3), 'ui', initialHash);

    const firstHash = await first;
    await expect(stale).rejects.toBeInstanceOf(EditConflictError);
    await expect(stale).rejects.toMatchObject({ currentHash: firstHash });
    expect((await savedDoc()).totalDurationS).toBe(2);

    const fresh = await writer.commit(makeDoc(3), 'ui', firstHash);
    expect(fresh).toBe(await savedHash());
    expect((await savedDoc()).totalDurationS).toBe(3);
  });

  it('keeps accepting writes after a rejected one — the chain and the lock are both released', async () => {
    await expect(writer.commit(makeDoc(2), 'ui', 'not-the-current-hash')).rejects.toBeInstanceOf(
      EditConflictError,
    );

    const hash = await writer.commit(makeDoc(4), 'ui', await savedHash());

    expect(hash).toBe(await savedHash());
    expect((await savedDoc()).totalDurationS).toBe(4);
  });

  it('leaves lastSavedHash untouched when the commit is rejected', async () => {
    const before = await writer.commit(makeDoc(2), 'ui');

    await expect(writer.commit(makeDoc(3), 'ui', 'stale')).rejects.toBeInstanceOf(
      EditConflictError,
    );

    expect(writer.lastSavedHash).toBe(before);
  });

  it('records one history snapshot per landed commit, tagged with its origin', async () => {
    await writer.commit(makeDoc(2), 'ui');
    await writer.commit(makeDoc(3), 'suggest');
    await expect(writer.commit(makeDoc(4), 'restore', 'stale')).rejects.toBeInstanceOf(
      EditConflictError,
    );

    const entries = await history.list();

    expect(entries.map((entry) => entry.origin)).toEqual(['suggest', 'ui']);
    expect(entries.map((entry) => entry.totalDurationS)).toEqual([3, 2]);
  });

  it('surfaces a held project lock instead of writing around it', async () => {
    const lockDir = join(projectDir, 'edit', '.locks');
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, 'edit-write.lock'),
      JSON.stringify({ pid: process.pid, token: 'held-by-another-writer', acquiredAt: Date.now() }),
    );
    const busy = new EditWriter(projectDir, history, { lockWaitMs: 100 });

    await expect(busy.commit(makeDoc(2), 'ui')).rejects.toBeInstanceOf(ProjectLockBusyError);
    expect((await savedDoc()).totalDurationS).toBe(1);
  });
});

describe('EditWriter.update', () => {
  it('reads the document only after the pending commit has landed', async () => {
    const commit = writer.commit(makeDoc(10), 'ui');
    const update = writer.update(
      (doc) => ({ ...doc, totalDurationS: (doc.totalDurationS ?? 0) + 1 }),
      'title',
    );

    await commit;
    const hash = await update;

    expect((await savedDoc()).totalDurationS).toBe(11);
    expect(hash).toBe(await savedHash());
    expect(writer.lastSavedHash).toBe(hash);
    expect((await history.list()).map((entry) => entry.origin)).toEqual(['title', 'ui']);
  });

  it('writes nothing and records nothing when the updater throws, then keeps accepting writes', async () => {
    await expect(
      writer.update(() => {
        throw new Error('updater failed');
      }, 'title'),
    ).rejects.toThrow('updater failed');

    expect((await savedDoc()).totalDurationS).toBe(1);
    expect(await history.list()).toEqual([]);
    expect(writer.lastSavedHash).toBe('');

    const hash = await writer.commit(makeDoc(5), 'ui', await savedHash());
    expect((await savedDoc()).totalDurationS).toBe(5);
    expect(writer.lastSavedHash).toBe(hash);
  });

  it('writes exactly what the updater returned', async () => {
    await writer.update((doc) => ({ ...doc, totalDurationS: 7 }), 'title');

    const raw = JSON.parse(await readFile(editJsonPath(projectDir), 'utf8')) as EditDoc;
    expect(raw.totalDurationS).toBe(7);
  });
});
