import { describe, expect, it } from 'vitest';
import { videoColorSchema } from './schema.js';
import { resolvedVideoColor, videoColorFilter } from './videoColor.js';

describe('scoped color contract', () => {
  it('rejects unsupported/raw filters, NaN and unsafe values', () => {
    for (const value of [
      { saturation: 4 },
      { brightness: NaN },
      { input: 'raw' },
      { filter: 'movie=/tmp/private' },
      { hue: Infinity },
    ])
      expect(videoColorSchema.safeParse(value).success).toBe(false);
  });
  it('overrides rather than compounding a layer grade and can bypass it', () => {
    expect(resolvedVideoColor({ saturation: 1.2 }, { contrast: 1.1 })).toEqual({ contrast: 1.1 });
    expect(resolvedVideoColor({ input: 'hlg' }, { enabled: false })).toBeUndefined();
    expect(videoColorFilter({ enabled: false, saturation: 2 })).toBe('');
  });
  it('converts HDR before any adjustment and leaves SDR neutral untouched', () => {
    expect(videoColorFilter({ input: 'sdr' })).toBe('');
    const graph = videoColorFilter({ input: 'hlg', saturation: 0.96 });
    expect(graph).toContain('tin=arib-std-b67');
    expect(graph.indexOf('tonemap=')).toBeLessThan(graph.indexOf('eq='));
    expect(graph).toContain('zscale=t=bt709:m=bt709:r=limited');
  });
});
