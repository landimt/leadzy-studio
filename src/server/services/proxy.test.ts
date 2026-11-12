import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ExecaLike = (command: string, args: readonly string[]) => Promise<{ exitCode: number }>;

const execaMock = vi.hoisted(() => vi.fn<ExecaLike>());

vi.mock('execa', () => ({ execa: execaMock }));

import { ffmpegBinary } from './ffmpeg.js';
import { acquireProjectLock } from './projectLock.js';
import { getOrBuildProxy, hasFreshProxy, proxyRelPath } from './proxy.js';

describe('proxy cache', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'leadzy-proxy-'));
    await writeFile(join(projectDir, 'source.mp4'), 'original media');
    execaMock.mockReset();
    execaMock.mockImplementation(async (_command: string, args: readonly string[]) => {
      const output = args.at(-1);
      if (!output) throw new Error('missing proxy output');
      await writeFile(output, 'complete proxy');
      return { exitCode: 0 };
    });
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('cleans abandoned staging files and publishes a fresh proxy atomically', async () => {
    const relative = proxyRelPath('source.mp4');
    const output = join(projectDir, relative);
    await mkdir(join(projectDir, 'edit', 'cache', 'proxy'), { recursive: true });
    await writeFile(`${output}.123.abandoned.tmp.mp4`, 'partial');
    await writeFile(`${output}.123.abandoned.tmp.hash`, 'partial');

    const result = await getOrBuildProxy(projectDir, 'source.mp4');

    expect(result).toEqual({ ok: true, value: relative });
    expect(await readFile(output, 'utf8')).toBe('complete proxy');
    expect(await hasFreshProxy(projectDir, 'source.mp4')).toBe(true);
    expect(
      (await readdir(join(projectDir, 'edit', 'cache', 'proxy'))).filter((name) =>
        name.includes('.tmp.'),
      ),
    ).toEqual([]);
  });

  it('does not start a second encoder while another process owns the proxy lock', async () => {
    const lock = await acquireProjectLock(projectDir, 'proxy');
    try {
      const result = await getOrBuildProxy(projectDir, 'source.mp4');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('already in progress');
      expect(execaMock).not.toHaveBeenCalled();
    } finally {
      await lock.release();
    }
  });

  it('encodes with the hardware encoder and its own quality flag when videoEncoder is h264_videotoolbox', async () => {
    const result = await getOrBuildProxy(projectDir, 'source.mp4', {
      videoEncoder: 'h264_videotoolbox',
    });

    expect(result.ok).toBe(true);
    expect(execaMock).toHaveBeenCalledTimes(1);
    const call = execaMock.mock.calls[0];
    expect(call?.[0]).toBe(ffmpegBinary());
    const args = call?.[1] ?? [];
    const encodeFlagsAt = args.indexOf('-c:v');
    expect(args.slice(encodeFlagsAt, encodeFlagsAt + 4)).toEqual([
      '-c:v',
      'h264_videotoolbox',
      '-q:v',
      '50',
    ]);
    expect(args).not.toContain('libx264');
  });

  it('encodes with libx264 veryfast crf 28 by default', async () => {
    const result = await getOrBuildProxy(projectDir, 'source.mp4');

    expect(result.ok).toBe(true);
    const call = execaMock.mock.calls[0];
    expect(call?.[0]).toBe(ffmpegBinary());
    const args = call?.[1] ?? [];
    const encodeFlagsAt = args.indexOf('-c:v');
    expect(args.slice(encodeFlagsAt, encodeFlagsAt + 6)).toEqual([
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '28',
    ]);
  });
});
