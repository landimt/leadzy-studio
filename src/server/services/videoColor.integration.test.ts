import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { videoColorFilter } from '../../core/videoColor.js';
import { COLOR_PRESETS } from '../../core/colorPresets.js';
import { ffmpegBinary } from './ffmpeg.js';

describe('color filters with real FFmpeg', () => {
  it('executes every preset without coloring the later pink overlay', async () => {
    for (const preset of COLOR_PRESETS) {
      const filter = videoColorFilter(preset.color);
      const graph = `[0:v]${filter || 'null'}[graded];[graded][1:v]overlay=32:0,format=rgb24[out]`;
      const { stdout } = await execa(
        ffmpegBinary(),
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=0x8090A0:s=64x64:r=1',
          '-f',
          'lavfi',
          '-i',
          'color=c=0xE5388C:s=32x64:r=1',
          '-filter_complex',
          graph,
          '-map',
          '[out]',
          '-frames:v',
          '1',
          '-f',
          'rawvideo',
          '-',
        ],
        { encoding: 'buffer' },
      );
      const at = (32 * 64 + 48) * 3;
      expect(Math.abs(stdout[at]! - 229)).toBeLessThan(5);
      expect(Math.abs(stdout[at + 1]! - 56)).toBeLessThan(5);
      expect(Math.abs(stdout[at + 2]! - 140)).toBeLessThan(5);
      if (preset.id === 'mono') {
        const left = (32 * 64 + 16) * 3;
        // YUV420 to RGB incurs a few integer levels of chroma rounding.
        expect(Math.abs(stdout[left]! - stdout[left + 1]!)).toBeLessThanOrEqual(4);
        expect(Math.abs(stdout[left + 1]! - stdout[left + 2]!)).toBeLessThanOrEqual(4);
      }
    }
  }, 30000);
});
