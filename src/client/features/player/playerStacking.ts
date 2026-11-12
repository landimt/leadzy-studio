import type { CSSProperties } from 'react';
import type { LayerBlock } from '../../../core/schema.js';
import {
  OVERLAY_MARGIN_PERCENT,
  type OverlayAnchor,
  overlayAnchor,
  PIP_DEFAULT_SCALE,
} from '../../../core/overlayPlacement.js';

/**
 * Stage stacking for authored video layers. Layers advance by 2 so a swapped
 * PiP's mini base frame gets a STRICTLY intermediate z (2i+1): above its own
 * layer, below the next one — never a DOM-order tie. Overlays sit above every
 * layer and every possible mini. This mirrors the render graph's compositing
 * order (core/render/plan.ts layerClips → overlayClips); keep the three functions
 * consistent or the preview stacks differently than the export.
 */
const LAYER_BASE_Z = 10;

export function layerZ(layerIndex: number): number {
  return LAYER_BASE_Z + 2 * layerIndex;
}

export function swappedMiniZ(layerIndex: number): number {
  return layerZ(layerIndex) + 1;
}

export function overlayZ(layerCount: number): number {
  return LAYER_BASE_Z + 2 * layerCount + 1;
}

/**
 * The plan's `overlayPosition` in CSS — same anchor, same margin per axis,
 * dragged `{x,y}` as fractions of the full frame.
 */
export function overlayCss(anchor: OverlayAnchor): CSSProperties {
  if (anchor.kind === 'fraction') {
    return { left: `${String(anchor.x * 100)}%`, top: `${String(anchor.y * 100)}%` };
  }
  const margin = `${String(OVERLAY_MARGIN_PERCENT)}%`;
  return {
    ...(anchor.horizontal === 'left' ? { left: margin } : { right: margin }),
    ...(anchor.vertical === 'top' ? { top: margin } : { bottom: margin }),
  };
}

export function pipPlace(position: LayerBlock['position']): CSSProperties {
  return overlayCss(overlayAnchor(position));
}

/**
 * The swapped-PiP mini: the composed base frame shrunk into the PiP rect.
 * Width AND height take the scale because the frame keeps the stage's aspect
 * ratio — exactly what the render's `scale=pipWidth:-2` produces. Pointer
 * events stay off; the base window re-enables its own when editing.
 */
export function swappedMiniStyle(block: LayerBlock, layerIndex: number): CSSProperties {
  const scale = block.scale ?? PIP_DEFAULT_SCALE;
  return {
    position: 'absolute',
    width: `${String(scale * 100)}%`,
    height: `${String(scale * 100)}%`,
    ...pipPlace(block.position),
    zIndex: swappedMiniZ(layerIndex),
    pointerEvents: 'none',
  };
}
