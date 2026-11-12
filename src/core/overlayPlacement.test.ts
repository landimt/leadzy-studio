import { describe, expect, it } from 'vitest';
import {
  OVERLAY_MARGIN_FRACTION,
  OVERLAY_MARGIN_PERCENT,
  overlayAnchor,
} from './overlayPlacement.js';

describe('overlayAnchor', () => {
  it.each([
    ['nothing', undefined, { kind: 'corner', horizontal: 'left', vertical: 'bottom' }],
    ['bottom-left', 'bottom-left', { kind: 'corner', horizontal: 'left', vertical: 'bottom' }],
    ['top-left', 'top-left', { kind: 'corner', horizontal: 'left', vertical: 'top' }],
    ['top-right', 'top-right', { kind: 'corner', horizontal: 'right', vertical: 'top' }],
    ['bottom-right', 'bottom-right', { kind: 'corner', horizontal: 'right', vertical: 'bottom' }],
    ['a dragged fraction', { x: 0.2, y: 0.7 }, { kind: 'fraction', x: 0.2, y: 0.7 }],
  ] as const)('reads %s', (_label, position, expected) => {
    expect(overlayAnchor(position)).toEqual(expected);
  });

  it('keeps the margin exact in both units the callers print', () => {
    expect(String(OVERLAY_MARGIN_PERCENT)).toBe('3');
    expect(String(OVERLAY_MARGIN_FRACTION)).toBe('0.03');
  });
});
