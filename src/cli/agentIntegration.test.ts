import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executableNames } from '../application/executable.js';
import { installAgentSkills, integrationReadiness } from './agentIntegration.js';

/** The file a command is on this platform: `studio` on POSIX, `studio.cmd` on Windows. */
function command(dir: string, name: string): string {
  return join(dir, executableNames(name)[0] ?? name);
}

async function executable(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '#!/bin/sh\n');
  await chmod(path, 0o755);
}

describe('agent integration', () => {
  it('finds binaries in the explicit PATH and skills in the user profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leadzy-agent-readiness-'));
    const bin = join(root, 'bin');
    await executable(command(bin, 'studio'));
    await executable(command(bin, 'claude'));
    await mkdir(join(root, '.claude', 'skills', 'leadzy-studio'), { recursive: true });
    await writeFile(join(root, '.claude', 'skills', 'leadzy-studio', 'SKILL.md'), 'ready');

    const readiness = await integrationReadiness({ homeDir: root, pathValue: bin });
    expect(readiness.bridgePath).toBe(command(bin, 'studio'));
    expect(readiness.bridgeOnPath).toBe(true);
    expect(readiness.agents.claude).toEqual({
      binaryPath: command(bin, 'claude'),
      skillInstalled: true,
    });
    expect(readiness.agents.codex.skillInstalled).toBe(false);
  });

  it('installs the same bundled skill for Claude Code and Codex', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leadzy-agent-install-'));
    const source = join(root, 'source');
    const home = join(root, 'home');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'SKILL.md'), '# Leadzy Studio');

    const installed = await installAgentSkills({ homeDir: home, sourceDir: source });
    expect(installed).toEqual(['claude', 'codex']);
    expect(
      await readFile(join(home, '.claude', 'skills', 'leadzy-studio', 'SKILL.md'), 'utf8'),
    ).toBe('# Leadzy Studio');
    expect(
      await readFile(join(home, '.codex', 'skills', 'leadzy-studio', 'SKILL.md'), 'utf8'),
    ).toBe('# Leadzy Studio');
  });

  it('finds Windows executable extensions and the installed studio.cmd bridge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leadzy-agent-windows-'));
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'studio.cmd'), '@echo off\r\n');
    await writeFile(join(bin, 'codex.exe'), 'binary');
    await writeFile(join(bin, 'ffmpeg.exe'), 'binary');
    // Unix npm also writes an extensionless shim; Windows must discover
    // its executable sibling, even when both are present.
    await executable(join(bin, 'studio'));
    const readiness = await integrationReadiness({
      homeDir: root,
      pathValue: `${join(root, 'missing')};"${bin}"`,
      platform: 'win32',
      pathExt: '.COM;.EXE;.BAT;.CMD',
    });
    expect(readiness.bridgePath).toBe(join(bin, 'studio.cmd'));
    expect(readiness.bridgeOnPath).toBe(true);
    expect(readiness.agents.codex.binaryPath).toBe(join(bin, 'codex.exe'));
    expect(readiness.ffmpeg).toBe(true);
  });

  it('does not mistake a directory for an executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leadzy-agent-directory-'));
    const bin = join(root, 'bin');
    await mkdir(join(bin, 'studio'), { recursive: true });
    const readiness = await integrationReadiness({ homeDir: root, pathValue: bin });
    expect(readiness.bridgePath).toBeNull();
    expect(readiness.bridgeOnPath).toBe(false);
  });
});
