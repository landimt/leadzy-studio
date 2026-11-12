import { describe, expect, it } from 'vitest';
import { MIN_CROSSFADE_OVERLAP_S } from '../../../core/render/options.js';
import type { OutputSegment } from '../../../core/timeline.js';
import { CROSSFADE_MIN_OVERLAP_S, crossfadeOverlapS } from './crossfadePreview.js';

function segment(partial: Partial<OutputSegment>): OutputSegment {
  return {
    source: 'cam',
    in: 4,
    out: 6,
    outputStart: 0,
    outputEnd: 2,
    blockIndex: 0,
    speed: 1,
    ...partial,
  };
}

// The preview must reach the same dip-vs-blend verdict as renderPlan's
// resolveJoin — these cases use the same numbers its tests use.
describe('crossfadeOverlapS', () => {
  it('pins the duplicated threshold to renderPlan (the module cannot import it: node:crypto)', () => {
    expect(CROSSFADE_MIN_OVERLAP_S).toBe(MIN_CROSSFADE_OVERLAP_S);
  });

  it('returns 0 when either side has speed != 1 — the render degrades to a dip', () => {
    const previous = segment({});
    expect(crossfadeOverlapS(segment({ speed: 2 }), segment({}), 0.4, new Map())).toBe(0);
    expect(crossfadeOverlapS(previous, segment({ speed: 1.5 }), 0.4, new Map())).toBe(0);
    expect(crossfadeOverlapS(undefined, segment({}), 0.4, new Map())).toBe(0);
  });

  it('B at in: 0 with a short A side yields less than the minimum — dip', () => {
    const previous = segment({ source: 'cam', out: 6 });
    const durations = new Map([['cam', 6.05]]);
    const overlap = crossfadeOverlapS(previous, segment({ in: 0 }), 0.4, durations);
    expect(overlap).toBeCloseTo(0.05, 5);
    expect(overlap).toBeLessThan(CROSSFADE_MIN_OVERLAP_S);
  });

  it('assumes the full half optimistically when the A source duration is unknown', () => {
    const overlap = crossfadeOverlapS(segment({}), segment({ in: 0.05 }), 0.4, new Map());
    expect(overlap).toBeCloseTo(0.2 + 0.05, 5);
  });

  it('returns the full extension when both sides have enough material — blend', () => {
    const previous = segment({ out: 6 });
    const durations = new Map([['cam', 10]]);
    const overlap = crossfadeOverlapS(previous, segment({ in: 4 }), 0.4, durations);
    expect(overlap).toBeCloseTo(0.4, 5);
    expect(overlap).toBeGreaterThanOrEqual(CROSSFADE_MIN_OVERLAP_S);
  });
});
