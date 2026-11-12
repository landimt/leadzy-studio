import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type * as ffmpegModule from '../../server/services/ffmpeg.js';
import { openProject } from './open.js';

vi.mock('../../server/services/ffmpeg.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ffmpegModule>()),
  ffmpegCapabilities: () =>
    Promise.resolve({
      ok: true,
      value: {
        version: 'test',
        hasSubtitlesFilter: true,
        hasVideotoolbox: false,
        hasVideotoolboxDecode: false,
      },
    }),
  probeMedia: () =>
    Promise.resolve({
      ok: true,
      value: { kind: 'video', fps: 25, width: 64, height: 64, durationS: 4, hasAudio: false },
    }),
}));
vi.mock('../../server/services/proxy.js', () => ({ warmProxyCache: () => Promise.resolve() }));
// If opening regresses into the new-project branch, keep its index writes
// isolated from the user's real database while asserting the data loss.
vi.mock('../../db/index.js', () => ({
  StudioDb: class {
    reindexProject = vi.fn();
    close = vi.fn();
  },
}));

describe('opening an existing edit', () => {
  it('preserves a truncated edit.json byte for byte instead of initializing a new cut', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'leadzy-open-corrupt-'));
    const editPath = join(projectDir, 'edit', 'edit.json');
    const interruptedEdit = '{"version":2,"tracks":[{"id":"my-valuable-cut"';
    try {
      await mkdir(join(projectDir, 'edit'));
      await writeFile(editPath, interruptedEdit);
      await writeFile(join(projectDir, 'camera.mp4'), 'isolated video fixture');

      const result = await openProject(projectDir);

      expect(result).toMatchObject({ ok: false, error: { code: 'invalid-edit-json' } });
      expect(await readFile(editPath, 'utf8')).toBe(interruptedEdit);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
