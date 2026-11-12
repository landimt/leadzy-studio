import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executableNames, findExecutable } from './executable.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directoryWith(...files: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'leadzy-executable-'));
  roots.push(root);
  for (const file of files) {
    // executable on POSIX, where the lookup checks X_OK; Windows has no such bit
    await writeFile(join(root, file), '');
    await chmod(join(root, file), 0o755);
  }
  return root;
}

describe('executableNames', () => {
  it('probes the bare name on POSIX', () => {
    expect(executableNames('studio', 'darwin')).toEqual(['studio']);
  });

  it('probes the runnable extensions on Windows, .cmd first', () => {
    expect(executableNames('studio', 'win32')).toEqual([
      'studio.cmd',
      'studio.exe',
      'studio.bat',
      'studio.com',
    ]);
  });

  it('never claims .js on Windows — a Node module on the PATH is not a command', () => {
    expect(executableNames('studio', 'win32')).not.toContain('studio.js');
  });
});

describe('findExecutable', () => {
  it('finds a runnable name on the PATH', async () => {
    const command = executableNames('codex')[0] ?? 'codex';
    const dir = await directoryWith(command);
    const found = await findExecutable('codex', {
      pathValue: dir,
      homeDir: dir,
    });
    expect(found).toBe(join(dir, command));
  });

  it('finds the .cmd shim on Windows, where the bare name does not exist', async () => {
    const dir = await directoryWith('claude.cmd');
    const found = await findExecutable('claude', {
      pathValue: dir,
      homeDir: dir,
      platform: 'win32',
    });
    expect(found).toBe(join(dir, 'claude.cmd'));
  });

  it('skips the extensionless POSIX shim npm writes beside the .cmd on Windows', async () => {
    const dir = await directoryWith('studio', 'studio.cmd');
    const found = await findExecutable('studio', {
      pathValue: dir,
      homeDir: dir,
      platform: 'win32',
    });
    expect(found).toBe(join(dir, 'studio.cmd'));
  });

  it('answers null when nothing on the PATH carries the name', async () => {
    const dir = await directoryWith('something-else');
    const found = await findExecutable('claude', {
      pathValue: dir,
      homeDir: dir,
      platform: 'win32',
    });
    expect(found).toBeNull();
  });

  it('honors PATH order', async () => {
    const command = executableNames('studio')[0] ?? 'studio';
    const first = await directoryWith(command);
    const second = await directoryWith(command);
    const found = await findExecutable('studio', {
      pathValue: `${first}${delimiter}${second}`,
      homeDir: first,
    });
    expect(found).toBe(join(first, command));
  });
});
