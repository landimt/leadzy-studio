import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ExecutableLookupOptions {
  readonly homeDir?: string;
  readonly pathValue?: string;
  readonly platform?: NodeJS.Platform;
  readonly pathExt?: string;
}

export function executablePathDirectories(options: ExecutableLookupOptions = {}): string[] {
  return (options.pathValue ?? process.env.PATH ?? '')
    .split((options.platform ?? process.platform) === 'win32' ? ';' : ':')
    .map((directory) => directory.replace(/^"(.*)"$/, '$1'))
    .filter((directory) => directory.length > 0);
}

/**
 * Windows has no executable bit: a command is a file whose extension makes it
 * runnable, so probe the extensions instead of the bare name — `.cmd` first,
 * because npm and the Studio bridge both ship shims. The bare name is left out
 * on purpose: npm installs an extensionless POSIX shell script next to every
 * `.cmd`, and matching it would hand the caller a file Windows cannot run. The
 * list is also narrower than PATHEXT, which claims `.js`: the repo's own
 * `bin/studio.js` sits on the PATH that `preferLocalToolchain` builds, and it
 * is a Node module, not a command.
 */
export function executableNames(
  name: string,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  if (platform !== 'win32') return [name];
  return [`${name}.cmd`, `${name}.exe`, `${name}.bat`, `${name}.com`];
}

async function isExecutable(path: string, windows: boolean): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, windows ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first runnable file with this name on the PATH, or null. This is the
 * whole of `which` that the Studio needs — and Windows ships no `which`, so
 * shelling out would report every command as missing there.
 */
export async function findExecutable(
  name: string,
  options: ExecutableLookupOptions = {},
): Promise<string | null> {
  const home = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  const windows = platform === 'win32';
  const directories = [
    ...executablePathDirectories(options),
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    ...(windows ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']),
  ].filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);
  const names = executableNames(name, platform);
  for (const directory of directories) {
    for (const candidate of names) {
      const full = join(directory, candidate);
      if (await isExecutable(full, windows)) return full;
    }
  }
  return null;
}
