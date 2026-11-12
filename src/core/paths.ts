import { err, ok, type Result } from './result.js';

/**
 * The separator the project folder is already written with. This module is
 * bundled into the browser client too, so `node:path` is not available here —
 * and splicing with a literal "/" would leave a Windows path as the mongrel
 * `C:\creative/edit/edit.json`, which opens but leaks into receipts and into
 * every path comparison downstream.
 */
function separatorFor(projectDir: string): string {
  const windowsRoot = /^[a-zA-Z]:[\\/]/.test(projectDir) || projectDir.startsWith('\\\\');
  return windowsRoot ? '\\' : '/';
}

/**
 * String-level containment: normalizes `.`/`..` segments and verifies the
 * result stays inside the project folder. Callers that touch the filesystem
 * must ALSO resolve symlinks (fs.realpath) before trusting the path — that
 * half lives in the server, this half is pure and testable.
 */
export function containedPath(projectDir: string, relativePath: string): Result<string> {
  if (relativePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(relativePath)) {
    return err('path-outside-project', `absolute paths are not allowed: "${relativePath}"`);
  }
  if (relativePath.includes('\0')) {
    return err('path-outside-project', 'path contains a null byte');
  }

  const segments: string[] = [];
  for (const segment of relativePath.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) {
        return err('path-outside-project', `path escapes the project folder: "${relativePath}"`);
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    return err('path-outside-project', 'path resolves to the project folder itself');
  }

  const separator = separatorFor(projectDir);
  const base = /[\\/]$/.test(projectDir) ? projectDir.slice(0, -1) : projectDir;
  return ok(`${base}${separator}${segments.join(separator)}`);
}

/** Writes are only ever allowed inside `edit/` — user media is read-only. */
export function isInsideEditDir(relativePath: string): boolean {
  // relative-only, no null bytes — this helper must stand alone even when a
  // caller forgets to pair it with safePath
  if (relativePath.startsWith('/') || relativePath.includes('\0')) return false;
  // normalize BEFORE checking: "edit/../raw.mp4" must not pass as edit/
  const segments: string[] = [];
  for (const segment of relativePath.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return false;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments[0] === 'edit';
}
