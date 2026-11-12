import { describe, expect, it } from 'vitest';
import { isValidH264OutputDimensions, type EditDoc } from '../../../core/schema.js';
import {
  audioSpeedSummary,
  exportDimensionsForTier,
  exportDurationSeconds,
  exportResolutionTierForDimensions,
} from '../export/exportSummary.js';

describe('export processing summary', () => {
  it('reports denoise even when loudness normalization is disabled', () => {
    const output: EditDoc['output'] = {
      width: 1080,
      height: 1920,
      loudnormLufs: null,
      denoise: 0.4,
    };

    expect(audioSpeedSummary(output)).toContain('sem normalização · ruído 40%');
  });

  it('calculates the real post-speed duration on the project frame grid', () => {
    const doc = {
      version: 2 as const,
      fps: 25,
      output: { width: 1080, height: 1920, loudnormLufs: -14, speed: 1.25 },
      sources: { cam: { path: 'camera.mp4', durationS: 12 } },
      tracks: [
        {
          id: 'base',
          kind: 'video' as const,
          blocks: [{ source: 'cam', in: 0, out: 10 }],
        },
      ],
      subtitles: { enabled: true, preset: 'pill' as const },
      totalDurationS: 10,
    };

    expect(exportDurationSeconds(doc)).toBe(8);
  });

  it('offers a real 4K canvas while preserving vertical and horizontal aspect', () => {
    expect(exportDimensionsForTier({ width: 1080, height: 1920 }, '4K')).toEqual({
      width: 2160,
      height: 3840,
    });
    expect(exportDimensionsForTier({ width: 1920, height: 1080 }, '4K')).toEqual({
      width: 3840,
      height: 2160,
    });
  });

  it('preserves a custom 4:5 canvas instead of silently changing it to 9:16', () => {
    expect(exportDimensionsForTier({ width: 1080, height: 1350 }, '4K')).toEqual({
      width: 2160,
      height: 2700,
    });
    expect(exportResolutionTierForDimensions({ width: 1080, height: 1350 })).toBe('1080p');
  });

  it('rounds scaled dimensions to H.264-compatible even values', () => {
    const dimensions = exportDimensionsForTier({ width: 1001, height: 1500 }, '720p');

    expect(dimensions.width).toBe(720);
    expect(dimensions.width % 2).toBe(0);
    expect(dimensions.height % 2).toBe(0);
    expect(isValidH264OutputDimensions(dimensions)).toBe(true);
  });

  it('keeps an invalid current size explicit instead of selecting a corrected preset', () => {
    const current = { width: 1081, height: 1920 };

    expect(exportResolutionTierForDimensions(current)).toBeNull();
    expect(isValidH264OutputDimensions(current)).toBe(false);
  });
});
