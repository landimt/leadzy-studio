import { err, ok, type Result } from '../core/result.js';
import { parseEditDoc } from '../core/schema.js';
import { withRecomputedDuration } from '../core/timeline.js';
import { EditHistory } from '../server/services/editHistory.js';
import { editDocHash, loadEditDoc, saveEditDoc } from '../server/services/project.js';
import { acquireProjectLock, ProjectLockBusyError } from '../server/services/projectLock.js';
import { validateEditDocReferences } from './validateEditDocReferences.js';

export interface ApplyEditOptions {
  readonly expectHash?: string;
}

export interface ApplyEditOutcome {
  readonly ok: true;
  readonly previousHash: string;
  readonly editHash: string;
  readonly totalDurationS: number;
}

/**
 * Agent-safe edit transaction: schema + references + duration, optimistic
 * hash guard, atomic write and recoverable snapshots. The lock serializes
 * multiple CLI agents; the hash guard catches a UI edit made before commit.
 */
export async function applyEditDocument(
  projectDir: string,
  input: unknown,
  options: ApplyEditOptions = {},
): Promise<Result<ApplyEditOutcome>> {
  const parsed = parseEditDoc(input);
  if (!parsed.ok) return parsed;
  const next = withRecomputedDuration(parsed.value);
  const referenceIssues = await validateEditDocReferences(projectDir, next);
  if (referenceIssues.length > 0) {
    return err(
      'invalid-edit-json',
      referenceIssues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
    );
  }

  let lock;
  try {
    lock = await acquireProjectLock(projectDir, 'edit-write', { waitMs: 5_000 });
  } catch (cause) {
    return err(
      'io-failed',
      cause instanceof ProjectLockBusyError
        ? 'another edit is in progress; refresh the status and try again'
        : 'could not reserve the project for editing',
      cause,
    );
  }

  try {
    const loaded = await loadEditDoc(projectDir);
    if (!loaded.ok) return loaded;
    const current = loaded.value.doc;
    const previousHash = editDocHash(current);
    if (options.expectHash !== undefined && options.expectHash !== previousHash) {
      return err(
        'invalid-edit-json',
        `conflict: edit.json changed (expected ${options.expectHash}, current ${previousHash}); run "studio status --json" and reapply your intent`,
      );
    }
    if (
      current.subtitles.locked === true &&
      JSON.stringify(current.subtitles) !== JSON.stringify(next.subtitles)
    ) {
      return err(
        'invalid-edit-json',
        'subtitles.locked=true: the edit tried to change protected subtitle settings',
      );
    }

    const history = new EditHistory(projectDir);
    await history.record(current, 'agent');
    const saved = await saveEditDoc(projectDir, next);
    if (!saved.ok) return saved;
    await history.record(next, 'agent');
    return ok({
      ok: true,
      previousHash,
      editHash: saved.value,
      totalDurationS: next.totalDurationS ?? 0,
    });
  } finally {
    await lock.release();
  }
}
