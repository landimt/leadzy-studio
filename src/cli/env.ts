import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { installationRoot } from '../core/installation.js';

const REPO_ROOT = installationRoot(import.meta.url, 2);

/**
 * A full ffmpeg (with libass) dropped in <repo>/bin wins over whatever is on
 * the PATH — the painless fix for capped system builds (Homebrew case).
 */
export function preferLocalToolchain(): void {
  const binDir = join(REPO_ROOT, 'bin');
  if (existsSync(binDir) && !(process.env.PATH ?? '').startsWith(binDir)) {
    process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ''}`;
  }
}

/**
 * Minimal .env loader (repo root only). The API key never leaves the server
 * process: not logged, not written to any project file, not sent to the client.
 */
export function loadDotEnv(): void {
  let content: string;
  try {
    content = readFileSync(join(REPO_ROOT, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const separator = trimmed.indexOf('=');
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
