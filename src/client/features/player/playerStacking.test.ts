import { describe, expect, it } from 'vitest';

import type { LayerBlock } from '../../../core/schema.js';
import {
  layerZ,
  overlayCss,
  overlayZ,
  pipPlace,
  swappedMiniZ,
  swappedMiniStyle,
} from './playerStacking.js';

const pipBlock: LayerBlock = {
  source: 'screen',
  in: 4,
  out: 6,
  at: 3,
  mode: 'pip',
  audio: 'mute',
};

describe('player stacking invariants', () => {
  it('keeps the swapped mini strictly between its layer and the next one', () => {
    expect(swappedMiniZ(0)).toBeGreaterThan(layerZ(0));
    expect(swappedMiniZ(0)).toBeLessThan(layerZ(1));
    expect(swappedMiniZ(1)).toBeGreaterThan(layerZ(1));
    expect(swappedMiniZ(1)).toBeLessThan(layerZ(2));
  });

  it('keeps overlays above every layer and every possible mini', () => {
    expect(layerZ(2)).toBeLessThan(overlayZ(3));
    expect(swappedMiniZ(2)).toBeLessThan(overlayZ(3));
    expect(swappedMiniZ(0)).toBeLessThan(overlayZ(1));
  });

  it('floors every layer above the stage chrome (background 0, base 1, crossfade 2, effect 3)', () => {
    expect(layerZ(0)).toBeGreaterThan(3);
  });
});

describe('swappedMiniStyle', () => {
  it('shrinks the frame to the scale on BOTH axes and anchors the corner with 3% margins', () => {
    expect(swappedMiniStyle({ ...pipBlock, scale: 0.5, position: 'top-right' }, 1)).toEqual({
      position: 'absolute',
      width: '50%',
      height: '50%',
      right: '3%',
      top: '3%',
      zIndex: swappedMiniZ(1),
      pointerEvents: 'none',
    });
  });

  it('defaults to bottom-left at scale 0.34 and honors dragged {x,y} fractions', () => {
    const defaulted = swappedMiniStyle(pipBlock, 0);
    expect(defaulted).toMatchObject({ width: '34%', height: '34%', left: '3%', bottom: '3%' });
    expect(pipPlace({ x: 0.25, y: 0.5 })).toEqual({ left: '25%', top: '50%' });
  });
});

describe('overlayCss', () => {
  it.each([
    [
      'top-left',
      { kind: 'corner', horizontal: 'left', vertical: 'top' },
      { left: '3%', top: '3%' },
    ],
    [
      'top-right',
      { kind: 'corner', horizontal: 'right', vertical: 'top' },
      { right: '3%', top: '3%' },
    ],
    [
      'bottom-left',
      { kind: 'corner', horizontal: 'left', vertical: 'bottom' },
      { left: '3%', bottom: '3%' },
    ],
    [
      'bottom-right',
      { kind: 'corner', horizontal: 'right', vertical: 'bottom' },
      { right: '3%', bottom: '3%' },
    ],
    ['a fraction', { kind: 'fraction', x: 0.2, y: 0.7 }, { left: '20%', top: '70%' }],
  ] as const)('places %s exactly like the plan', (_label, anchor, css) => {
    expect(overlayCss(anchor)).toStrictEqual(css);
  });

  it('pipPlace reads the position through the shared anchor — nothing means bottom-left', () => {
    expect(pipPlace(undefined)).toStrictEqual({ left: '3%', bottom: '3%' });
    expect(pipPlace('top-right')).toStrictEqual({ right: '3%', top: '3%' });
  });
});
