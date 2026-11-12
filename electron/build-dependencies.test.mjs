import { execFile as execFileCallback } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const execFile = promisify(execFileCallback);

describe.skipIf(process.platform !== 'darwin')('patched macOS image reader', () => {
  let directory;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'studio-dmg-image-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('preserves the callback interface used for DMG background dimensions', async () => {
    const readSize = promisify(require('appdmg/lib/read-image-size'));
    const file = path.join(directory, 'background.png');
    await writeFile(
      file,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    await expect(readSize(file)).resolves.toMatchObject({ width: 1, height: 1 });
    await expect(readSize(path.join(directory, 'missing.png'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects an ICNS entry with zero length without hanging the build', async () => {
    const file = path.join(directory, 'invalid.icns');
    const data = Buffer.alloc(16);
    data.write('icns', 0);
    data.writeUInt32BE(data.length, 4);
    data.write('ic09', 8);
    await writeFile(file, data);
    const reader = require.resolve('appdmg/lib/read-image-size');
    const result = await execFile(
      process.execPath,
      [
        '-e',
        'require(process.argv[1])(process.argv[2], (error) => { if (!error || !/Invalid ICNS/.test(error.message)) process.exit(1); });',
        reader,
        file,
      ],
      { timeout: 3_000 },
    );
    expect(result.stderr).toBe('');
  });
});
