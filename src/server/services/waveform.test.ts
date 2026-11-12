import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { expect, it } from 'vitest';
import { unwrap } from '../../core/result.js';
import { ffmpegBinary } from './ffmpeg.js';
import { getOrBuildPeaks } from './waveform.js';

it('caches a flat envelope for video without audio and invalidates it when audio is added', async () => {
  const root = await mkdtemp(join(tmpdir(), 'leadzy-silent-peaks-'));
  try {
    const path = join(root, 'screen.mp4');
    await execa(ffmpegBinary(), [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=64x64:r=25',
      '-t',
      '1',
      '-an',
      path,
    ]);
    const silent = unwrap(await getOrBuildPeaks(root, 'screen.mp4'));
    expect(silent.min).toHaveLength(100);
    expect(silent.max.every((value) => value === 0)).toBe(true);
    expect(await readFile(join(root, 'edit/waveforms/screen.mp4.peaks.json'), 'utf8')).toContain(
      'sourceHash',
    );
    expect(unwrap(await getOrBuildPeaks(root, 'screen.mp4'))).toEqual(silent);
    await execa(ffmpegBinary(), [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=64x64:r=25',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=16000',
      '-t',
      '1',
      path,
    ]);
    expect(
      unwrap(await getOrBuildPeaks(root, 'screen.mp4')).max.some((value) => value > 0.01),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
