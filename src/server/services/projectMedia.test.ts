import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EditDoc } from '../../core/schema.js';
import {
  listImageFiles,
  listMediaFiles,
  listProjectMediaFiles,
  probeProjectMedia,
} from './projectMedia.js';

const roots: string[] = [];

async function root(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('project media inventory', () => {
  it('lists timed media and still images without allowing either to become the wrong base input', async () => {
    const projectDir = await root('leadzy-project-');
    await mkdir(join(projectDir, 'edit', 'assets'), { recursive: true });
    await Promise.all([
      writeFile(join(projectDir, 'camera.mp4'), 'video'),
      writeFile(join(projectDir, 'music.wav'), 'audio'),
      writeFile(join(projectDir, 'cover.jpg'), 'root image'),
      writeFile(join(projectDir, 'edit', 'assets', 'background.webp'), 'asset image'),
      writeFile(join(projectDir, 'notes.txt'), 'ignored'),
    ]);
    const projectMedia = await listProjectMediaFiles(projectDir);
    const baseCandidates = await listMediaFiles(projectDir);
    const images = await listImageFiles(projectDir);
    expect(projectMedia.ok && projectMedia.value).toEqual(['camera.mp4', 'music.wav']);
    expect(baseCandidates.ok && baseCandidates.value).toEqual(['camera.mp4']);
    expect(images).toEqual(['cover.jpg', 'edit/assets/background.webp']);
  });

  it('rejects a source symlink that resolves outside the project', async () => {
    const projectDir = await root('leadzy-project-');
    const outsideDir = await root('leadzy-outside-');
    const outside = join(outsideDir, 'private.mp4');
    await writeFile(outside, 'not actually media');
    await symlink(outside, join(projectDir, 'camera.mp4'));
    const doc: EditDoc = {
      version: 2,
      fps: 25,
      output: { width: 1080, height: 1920, loudnormLufs: null },
      sources: { cam: { path: 'camera.mp4' } },
      tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 1 }] }],
      subtitles: { enabled: false, preset: 'pill' },
    };
    const result = await probeProjectMedia(projectDir, doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('path-outside-project');
  });
});
