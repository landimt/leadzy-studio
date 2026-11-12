import { type ClipTransform } from '../schema.js';

export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

export function previewDimensions(output: Dimensions): Dimensions {
  const shortSide = Math.min(output.width, output.height);
  if (shortSide <= 720) return output;
  const factor = 720 / shortSide;
  const even = (v: number): number => 2 * Math.round((v * factor) / 2);
  return { width: even(output.width), height: even(output.height) };
}

/** Quantize a fractional cell side for yuv420p without ever producing 0px. */
export function cellDimension(outputSide: number, fraction: number): number {
  return Math.max(2, 2 * Math.round((outputSide * fraction) / 2));
}

function coverFilter(dims: Dimensions): string {
  return `scale=${String(dims.width)}:${String(dims.height)}:force_original_aspect_ratio=increase,crop=${String(dims.width)}:${String(dims.height)}`;
}

export function ffmpegColor(color: string): string {
  return `0x${color.slice(1)}`;
}

export function backgroundMediaFitFilter(dims: Dimensions, fit: 'cover' | 'contain'): string {
  if (fit === 'cover') return coverFilter(dims);
  return `scale=${String(dims.width)}:${String(dims.height)}:force_original_aspect_ratio=decrease`;
}

/**
 * Editor-style clip transform inside a cell: cover-scale × scale, offset by
 * (x,y) cell fractions, then crop what overflows and pad what falls short —
 * valid for punch-ins (scale>1) and shrunk clips over black (scale<1).
 */
export function cellFilter(dims: Dimensions, transform?: ClipTransform): string {
  if (!transform || (transform.scale === 1 && transform.x === 0 && transform.y === 0)) {
    return coverFilter(dims);
  }
  const W = dims.width;
  const H = dims.height;
  const sw = cellDimension(W, transform.scale);
  const sh = cellDimension(H, transform.scale);
  const tx = Math.round(transform.x * W);
  const ty = Math.round(transform.y * H);
  return (
    `scale=${String(sw)}:${String(sh)}:force_original_aspect_ratio=increase,` +
    `crop='min(iw,${String(W)})':'min(ih,${String(H)})'` +
    `:'max(0,min(iw-out_w,(iw-out_w)/2-${String(tx)}))'` +
    `:'max(0,min(ih-out_h,(ih-out_h)/2-${String(ty)}))',` +
    `pad=${String(W)}:${String(H)}` +
    `:'max(0,min(out_w-iw,(out_w-iw)/2+${String(tx)}))'` +
    `:'max(0,min(out_h-ih,(out_h-ih)/2+${String(ty)}))':black`
  );
}
