import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const config = require('../forge.config.cjs');
const root = resolve(import.meta.dirname, '..');

describe('desktop package runtime', () => {
  it.each([
    ['--arch', 'x64'],
    ['--platform', 'win32'],
    ['--arch=arm64', '--arch=x64'],
    ['--platform=darwin', '--platform=win32'],
  ])('rejects ambiguous target options before doing a build: %s', (...flags) => {
    const result = spawnSync(
      process.execPath,
      [resolve(root, 'scripts/desktop-build.mjs'), 'package', ...flags],
      { encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('opções duplicadas ou separadas não são aceitas');
  });
  it('retains every local main-process module import while excluding tests', () => {
    const source = readFileSync(resolve(root, 'electron/main.mjs'), 'utf8');
    const imports = [...source.matchAll(/from ['"]\.\/([^'"]+)['"]/g)].map((match) => match[1]);
    expect(imports).toContain('updateNotice.mjs');
    for (const path of ['main.mjs', 'preload.cjs', ...imports]) {
      expect(config.packagerConfig.ignore(`/electron/${path}`), path).toBe(false);
      expect(config.packagerConfig.ignore(`\\electron\\${path}`), path).toBe(false);
    }
    expect(config.packagerConfig.ignore('/electron/main.test.mjs')).toBe(true);
    expect(config.packagerConfig.ignore('/.env')).toBe(true);
  });

  it('builds install and update artifacts for both desktop platforms', () => {
    expect(config.makers.find((maker) => maker.name.endsWith('maker-squirrel'))?.platforms).toEqual(
      ['win32'],
    );
    expect(config.makers.find((maker) => maker.name.endsWith('maker-zip'))?.platforms).toEqual([
      'darwin',
      'win32',
    ]);
  });
});
