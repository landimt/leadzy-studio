import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserConfig } from './userConfig.js';

let baseDir: string;
let config: UserConfig;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'leadzy-config-'));
  config = new UserConfig(baseDir);
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('UserConfig', () => {
  it('read() returns {} when no config file has ever been written', async () => {
    expect(await config.read()).toEqual({});
    expect(await config.elevenLabsKey()).toBeUndefined();
  });

  it('set/read/clear round-trip', async () => {
    await config.setElevenLabsKey('sk-abcdef12');
    expect(await config.elevenLabsKey()).toBe('sk-abcdef12');
    expect(await config.read()).toEqual({ elevenLabsApiKey: 'sk-abcdef12' });

    await config.setElevenLabsKey(null);
    expect(await config.elevenLabsKey()).toBeUndefined();
    expect(await config.read()).toEqual({});
  });

  it('setElevenLabsKey("") also clears the key', async () => {
    await config.setElevenLabsKey('sk-abcdef12');
    await config.setElevenLabsKey('');
    expect(await config.elevenLabsKey()).toBeUndefined();
  });

  it('resolves defaults without writing them to an existing config', async () => {
    expect(await config.preferences()).toEqual({
      locale: 'pt-BR',
      defaultProjectDir: null,
      exportMode: 'project',
      exportDirectory: null,
      exportFilenamePattern: '{project}',
      revealAfterExport: false,
    });
  });

  it('persists and merges preferences without removing the ElevenLabs key', async () => {
    await config.setElevenLabsKey('sk-abcdef12');
    await config.setPreferences({
      locale: 'en',
      defaultProjectDir: '/Users/tester/Projects',
      exportMode: 'folder',
      exportDirectory: '/Users/tester/Exports',
      exportFilenamePattern: '{project}-v1',
      revealAfterExport: false,
    });
    await config.setPreferences({ exportMode: 'ask', revealAfterExport: true });

    expect(await config.elevenLabsKey()).toBe('sk-abcdef12');
    expect(await config.preferences()).toEqual({
      locale: 'en',
      defaultProjectDir: '/Users/tester/Projects',
      exportMode: 'ask',
      exportDirectory: '/Users/tester/Exports',
      exportFilenamePattern: '{project}-v1',
      revealAfterExport: true,
    });
  });

  it('removes cleared directories from disk and resolves them as null', async () => {
    await config.setPreferences({
      defaultProjectDir: '/Users/tester/Projects',
      exportDirectory: '/Users/tester/Exports',
    });
    await config.setPreferences({ defaultProjectDir: null, exportDirectory: null });

    expect(await config.preferences()).toMatchObject({
      defaultProjectDir: null,
      exportDirectory: null,
    });
    expect(JSON.parse(await readFile(join(baseDir, 'config.json'), 'utf8'))).not.toHaveProperty(
      'defaultProjectDir',
    );
    expect(JSON.parse(await readFile(join(baseDir, 'config.json'), 'utf8'))).not.toHaveProperty(
      'exportDirectory',
    );
  });

  it('rejects relative directories without changing prior preferences', async () => {
    await config.setPreferences({ exportDirectory: '/Users/tester/Exports' });
    await expect(config.setPreferences({ exportDirectory: 'relative/path' })).rejects.toThrow(
      'invalid user preferences',
    );
    expect((await config.preferences()).exportDirectory).toBe('/Users/tester/Exports');
  });

  it('accepts only the supported interface locales', async () => {
    await config.setPreferences({ locale: 'en' });
    expect((await config.preferences()).locale).toBe('en');
    await expect(config.setPreferences({ locale: 'es' as unknown as 'en' })).rejects.toThrow(
      'invalid user preferences',
    );
    expect((await config.preferences()).locale).toBe('en');
  });

  it.each(['', '   ', 'line one\nline two', `has${String.fromCharCode(0)}nul`, 'a'.repeat(121)])(
    'rejects an unsafe export filename pattern',
    async (exportFilenamePattern) => {
      await expect(config.setPreferences({ exportFilenamePattern })).rejects.toThrow(
        'invalid user preferences',
      );
    },
  );

  it('a corrupted config.json is treated as {} instead of throwing', async () => {
    await writeFile(join(baseDir, 'config.json'), '{not valid json');
    expect(await config.read()).toEqual({});
  });

  it('a config.json that fails schema validation is treated as {} instead of throwing', async () => {
    await writeFile(join(baseDir, 'config.json'), JSON.stringify({ elevenLabsApiKey: 'short' }));
    expect(await config.read()).toEqual({});
  });

  it('a config.json with a field from a previous build keeps the key and drops the field', async () => {
    await writeFile(
      join(baseDir, 'config.json'),
      JSON.stringify({
        elevenLabsApiKey: 'sk-abcdef12',
        locale: 'en',
        transcriptionEngine: 'whisper',
      }),
    );

    await config.setPreferences({ revealAfterExport: true });

    expect(await config.elevenLabsKey()).toBe('sk-abcdef12');
    expect((await config.preferences()).locale).toBe('en');
    expect(JSON.parse(await readFile(join(baseDir, 'config.json'), 'utf8'))).toEqual({
      elevenLabsApiKey: 'sk-abcdef12',
      locale: 'en',
      revealAfterExport: true,
    });
  });

  // Windows has no POSIX mode bits; the key is protected there by the ACL
  // the file inherits from the per-user application-data folder.
  it.skipIf(process.platform === 'win32')('writes config.json with file mode 0o600', async () => {
    await config.setElevenLabsKey('sk-abcdef12');
    const info = await stat(join(baseDir, 'config.json'));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('leaves no .tmp file behind after a successful write', async () => {
    await config.setElevenLabsKey('sk-abcdef12');
    await expect(stat(join(baseDir, 'config.json.tmp'))).rejects.toThrow();
  });

  it('rejects a key containing a space', async () => {
    await expect(config.setElevenLabsKey('has a space')).rejects.toThrow('invalid user config');
    expect(await config.elevenLabsKey()).toBeUndefined();
  });

  it('rejects a key containing a control character', async () => {
    await expect(config.setElevenLabsKey('has\tcontrol1')).rejects.toThrow('invalid user config');
    expect(await config.elevenLabsKey()).toBeUndefined();
  });

  it('rejects a key shorter than 8 characters', async () => {
    await expect(config.setElevenLabsKey('short1')).rejects.toThrow('invalid user config');
  });

  it('rejects a key longer than 200 characters', async () => {
    await expect(config.setElevenLabsKey('a'.repeat(201))).rejects.toThrow('invalid user config');
  });

  it('a rejected key leaves a previously stored key untouched', async () => {
    await config.setElevenLabsKey('sk-original1');
    await expect(config.setElevenLabsKey('bad key')).rejects.toThrow();
    expect(await config.elevenLabsKey()).toBe('sk-original1');
  });

  it('defaults baseDir to LEADZY_CONFIG_DIR when no constructor argument is passed', async () => {
    const previous = process.env.LEADZY_CONFIG_DIR;
    process.env.LEADZY_CONFIG_DIR = baseDir;
    try {
      const defaultConfig = new UserConfig();
      await defaultConfig.setElevenLabsKey('sk-abcdef12');
      const onDisk = JSON.parse(await readFile(join(baseDir, 'config.json'), 'utf8')) as unknown;
      expect(onDisk).toEqual({ elevenLabsApiKey: 'sk-abcdef12' });
    } finally {
      if (previous === undefined) delete process.env.LEADZY_CONFIG_DIR;
      else process.env.LEADZY_CONFIG_DIR = previous;
    }
  });
});
