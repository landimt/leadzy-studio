import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { ffmpegBinary } from '../../server/services/ffmpeg.js';
import { defaultOutputFps, defaultSources, indexMediaFiles, scaffoldAgentGuides } from './open.js';

async function clip(target: string): Promise<boolean> {
  try {
    await execa(ffmpegBinary(), [
      '-hide_banner',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=64x64:r=25',
      '-t',
      '1',
      '-pix_fmt',
      'yuv420p',
      target,
    ]);
    return true;
  } catch {
    return false;
  }
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('agent guide scaffold', () => {
  it('refreshes the managed guide without overwriting project instructions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leadzy-guides-'));
    roots.push(root);
    await mkdir(join(root, 'edit'), { recursive: true });
    await writeFile(join(root, 'CLAUDE.md'), '# Minha instrução\n');

    await scaffoldAgentGuides(root);

    expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe('# Minha instrução\n');
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toContain(
      'edit/agent/leadzy-studio.md',
    );
    expect(await readFile(join(root, 'edit', 'agent', 'leadzy-studio.md'), 'utf8')).toContain(
      'Leadzy Studio',
    );
  });
});

describe('default sources', () => {
  it('declares every readable video, keyed uniquely, and skips ones ffprobe rejects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leadzy-open-sources-'));
    roots.push(root);
    if (!(await clip(join(root, 'IMG_4314.MOV')))) return;
    await clip(join(root, 'take.mp4'));
    await clip(join(root, 'take.mov'));
    await writeFile(join(root, 'broken.mp4'), 'not a video');

    const defaults = await defaultSources(root, [
      'IMG_4314.MOV',
      'take.mp4',
      'broken.mp4',
      'take.mov',
    ]);

    expect(defaults.ok).toBe(true);
    if (!defaults.ok) return;
    expect(Object.keys(defaults.value.sources)).toEqual(['img_4314', 'take', 'take_2']);
    expect(defaults.value.sources.take_2).toStrictEqual({
      path: 'take.mov',
      role: 'camera',
      durationS: 1,
    });
    expect(defaults.value).toMatchObject({ baseKey: 'img_4314', fps: 25 });
  });

  it('keys a file named like an Object prototype member without a bogus suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leadzy-open-sources-'));
    roots.push(root);
    if (!(await clip(join(root, 'constructor.mp4')))) return;

    const defaults = await defaultSources(root, ['constructor.mp4']);

    expect(defaults.ok).toBe(true);
    if (!defaults.ok) return;
    expect(defaults.value.baseKey).toBe('constructor');
    expect(Object.keys(defaults.value.sources)).toEqual(['constructor']);
  });

  it('indexes readable files — silent video included — and lists the unreadable ones instead of failing the folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leadzy-open-index-'));
    roots.push(root);
    await mkdir(join(root, 'edit'), { recursive: true });
    if (!(await clip(join(root, 'good.mp4')))) return;
    await writeFile(join(root, 'broken.mp4'), 'not a video');

    const index = await indexMediaFiles(root, ['good.mp4', 'broken.mp4']);

    expect(index.skipped).toEqual(['broken.mp4']);
    expect(index.entries.map((entry) => entry.relPath)).toEqual(['good.mp4']);
    expect(index.entries[0]).toMatchObject({ durationS: 1, transcriptStatus: 'none' });
    expect(index.transcribedCount).toBe(0);
  });

  it('fails when the first video — the one the base track needs — cannot be probed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leadzy-open-sources-'));
    roots.push(root);
    await writeFile(join(root, 'broken.mp4'), 'not a video');

    const sources = await defaultSources(root, ['broken.mp4']);

    expect(sources.ok).toBe(false);
  });
});

describe('defaultOutputFps', () => {
  it.each([
    [59.94, 29.97],
    [60, 30],
    [50, 25],
    [120, 60],
    [30, 30],
    [29.97, 29.97],
    [25, 25],
    [24, 24],
    [40, 40],
  ])('turns a %s fps source into a %s fps document', (source, expected) => {
    expect(defaultOutputFps(source)).toBe(expected);
  });
});
