import { describe, expect, it, vi } from 'vitest';
import { revealInFileManager } from './reveal.js';

describe('revealInFileManager', () => {
  const file = '/creative/edit/final.mp4';

  it('selects the file in Finder on macOS', async () => {
    const run = vi.fn(() => Promise.resolve());
    await revealInFileManager(file, { platform: 'darwin', run });
    expect(run).toHaveBeenCalledWith('open', ['-R', file]);
  });

  it('opens the containing folder elsewhere', async () => {
    const run = vi.fn(() => Promise.resolve());
    await revealInFileManager(file, { platform: 'linux', run });
    expect(run).toHaveBeenCalledWith('xdg-open', ['/creative/edit']);
  });

  it('selects the file in Explorer on Windows, as a single /select, argument', async () => {
    const run = vi.fn((_file: string, _args: readonly string[]) => Promise.resolve());
    const windowsFile = 'C:\\creative\\edit\\final cut.mp4';
    await revealInFileManager(windowsFile, {
      platform: 'win32',
      run,
      exists: () => Promise.resolve(),
    });
    expect(run).toHaveBeenCalledTimes(1);
    const [command, args] = run.mock.calls[0]!;
    expect(command.toLowerCase()).toContain('explorer.exe');
    expect(args).toEqual([`/select,${windowsFile}`]);
  });

  it('fails when Windows has no Explorer to open — its exit status never says so', async () => {
    const run = vi.fn(() => Promise.resolve());
    await expect(
      revealInFileManager('C:\\creative\\edit\\final.mp4', {
        platform: 'win32',
        run,
        exists: () => Promise.reject(new Error('ENOENT')),
      }),
    ).rejects.toThrow('ENOENT');
    expect(run).not.toHaveBeenCalled();
  });
});
