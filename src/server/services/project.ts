import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { err, ok, type Result } from '../../core/result.js';
import { containedPath } from '../../core/paths.js';
import { parseEditDoc, type EditDoc } from '../../core/schema.js';

export function editJsonPath(projectDir: string): string {
  return join(projectDir, 'edit', 'edit.json');
}

export interface LoadedEditDoc {
  readonly doc: EditDoc;
  readonly warnings: readonly string[];
}

/**
 * edit/edit.json is the document.
 */
export async function loadEditDoc(projectDir: string): Promise<Result<LoadedEditDoc>> {
  const path = editJsonPath(projectDir);
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (cause) {
    // openProject creates a new edit only on not-found. A read failure or
    // truncated JSON must never turn an existing project into a fresh one.
    return (cause as NodeJS.ErrnoException).code === 'ENOENT'
      ? err('not-found', `no edit.json found in "${projectDir}/edit" — run studio open first`)
      : err('io-failed', 'cannot read edit.json', cause);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content) as unknown;
  } catch (cause) {
    return err(
      'invalid-edit-json',
      'edit.json is not valid JSON; repair it or restore a backup',
      cause,
    );
  }
  const parsed = parseEditDoc(raw);
  if (!parsed.ok) return parsed;
  return ok({ doc: parsed.value, warnings: [] });
}

export function editDocHash(doc: EditDoc): string {
  return createHash('sha1').update(JSON.stringify(doc)).digest('hex');
}

/** Resolves an existing project-relative file and rejects symlink escapes. */
export async function resolveProjectFile(
  projectDir: string,
  relativePath: string,
): Promise<Result<string>> {
  const contained = containedPath(projectDir, relativePath);
  if (!contained.ok) return contained;
  try {
    const [root, target] = await Promise.all([realpath(projectDir), realpath(contained.value)]);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      return err(
        'path-outside-project',
        `path resolves outside the project folder: "${relativePath}"`,
      );
    }
    return ok(target);
  } catch (cause) {
    return err('io-failed', `cannot resolve project file "${relativePath}"`, cause);
  }
}

/** Atomic write (tmp + rename) so the file watcher never sees a half-write. */
export async function saveEditDoc(projectDir: string, doc: EditDoc): Promise<Result<string>> {
  const validated = parseEditDoc(doc);
  if (!validated.ok) return validated;
  const path = editJsonPath(projectDir);
  const tmpPath = `${path}.tmp`;
  try {
    await mkdir(join(projectDir, 'edit'), { recursive: true });
    await writeFile(tmpPath, JSON.stringify(validated.value, null, 2) + '\n');
    await rename(tmpPath, path);
    return ok(editDocHash(validated.value));
  } catch (cause) {
    return err('io-failed', `cannot write "${path}"`, cause);
  }
}
