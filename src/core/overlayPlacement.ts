import type { Position } from './schema.js';

/** Corner margin on each axis, as the export and the player both apply it. */
export const OVERLAY_MARGIN_PERCENT = 3;
export const OVERLAY_MARGIN_FRACTION = OVERLAY_MARGIN_PERCENT / 100;

/** Default PiP width as a fraction of the frame — render, player, inspector and new tracks agree on it. */
export const PIP_DEFAULT_SCALE = 0.34;

export type OverlayAnchor =
  | {
      readonly kind: 'corner';
      readonly horizontal: 'left' | 'right';
      readonly vertical: 'top' | 'bottom';
    }
  | { readonly kind: 'fraction'; readonly x: number; readonly y: number };

/**
 * Where an overlay sits in the frame — the one reading of `position` the
 * render plan and the player share. `{x,y}` are fractions of the FULL frame
 * (that is how the drag persists them); a named corner keeps the margin on
 * each axis; nothing means bottom-left.
 */
export function overlayAnchor(position: Position | undefined): OverlayAnchor {
  if (position === undefined) return { kind: 'corner', horizontal: 'left', vertical: 'bottom' };
  if (typeof position === 'object') return { kind: 'fraction', x: position.x, y: position.y };
  return {
    kind: 'corner',
    horizontal: position.includes('left') ? 'left' : 'right',
    vertical: position.includes('top') ? 'top' : 'bottom',
  };
}
