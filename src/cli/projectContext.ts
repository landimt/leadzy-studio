import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { err, ok, type Result } from '../core/result.js';

/** Canonical absolute project dir — symlinks resolved before anything trusts it. */
export function resolveProjectDir(input: string): Result<string> {
  try {
    const absolute = realpathSync(resolve(input));
    if (!statSync(absolute).isDirectory()) {
      return err('not-found', `"${input}" is not a folder`);
    }
    return ok(absolute);
  } catch (cause) {
    return err('not-found', `folder "${input}" not found`, cause);
  }
}
