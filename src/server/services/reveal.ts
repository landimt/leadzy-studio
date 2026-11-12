import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface RevealDeps {
  readonly platform?: NodeJS.Platform;
  readonly run?: (file: string, args: readonly string[]) => Promise<unknown>;
  readonly exists?: (path: string) => Promise<void>;
}

/**
 * Shows a file in the desktop file manager: selected in Finder on macOS and in
 * Explorer on Windows, its folder via xdg-open elsewhere.
 */
export async function revealInFileManager(absolute: string, deps: RevealDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const run =
    deps.run ??
    (async (file: string, args: readonly string[]) => {
      const { execa } = await import('execa');
      // Explorer answers a non-zero status even when the window opened, so the
      // command's own status is never the signal — see below.
      return execa(file, [...args], { reject: platform !== 'win32' });
    });

  if (platform === 'darwin') {
    await run('open', ['-R', absolute]);
    return;
  }

  if (platform === 'win32') {
    // Explorer exits 1 whether it worked or not, and a CreateProcess failure
    // is indistinguishable from that, so its status cannot be trusted either
    // way. Checking the binary first is what turns a missing file manager into
    // a real error instead of a silent no-op. `/select,` takes the path as one
    // argument, with no space after the comma.
    const explorer = join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe');
    await (deps.exists ?? access)(explorer);
    await run(explorer, [`/select,${absolute}`]);
    return;
  }

  await run('xdg-open', [dirname(absolute)]);
}
