import type { VideoColor } from './schema.js';

/** A clip overrides the layer, never compounds its grade. */
export function resolvedVideoColor(layer?: VideoColor, clip?: VideoColor): VideoColor | undefined {
  const color = clip ?? layer;
  return color?.enabled === false ? undefined : color;
}

/** Runs on a source stream BEFORE canvas, graphics, other layers or captions. */
export function videoColorFilter(color?: VideoColor): string {
  if (!color || color.enabled === false) return '';
  const filters: string[] = [];
  if (color.input === 'hlg' || color.input === 'pq') {
    const transfer = color.input === 'hlg' ? 'arib-std-b67' : 'smpte2084';
    filters.push(
      `zscale=pin=bt2020:tin=${transfer}:min=bt2020nc:rin=limited:t=linear:npl=100`,
      'format=gbrpf32le',
      'zscale=p=bt709',
      'tonemap=tonemap=mobius:desat=0',
      'zscale=t=bt709:m=bt709:r=limited',
      'format=yuv420p',
    );
  }
  if (
    (color.brightness ?? 0) !== 0 ||
    (color.contrast ?? 1) !== 1 ||
    (color.saturation ?? 1) !== 1 ||
    (color.gamma ?? 1) !== 1
  ) {
    filters.push(
      `eq=brightness=${String(color.brightness ?? 0)}:contrast=${String(color.contrast ?? 1)}:saturation=${String(color.saturation ?? 1)}:gamma=${String(color.gamma ?? 1)}`,
    );
  }
  if ((color.warmth ?? 0) !== 0) {
    const shift = (color.warmth ?? 0) * 0.15;
    filters.push(
      `colorbalance=rs=${String(shift)}:bs=${String(-shift)}:rm=${String(shift / 2)}:bm=${String(-shift / 2)}:pl=1`,
    );
  }
  if ((color.hue ?? 0) !== 0) filters.push(`hue=h=${String(color.hue)}`);
  return filters.join(',');
}

/** Interactive approximation only; program/preview render uses the exact FFmpeg grade. */
export function videoColorCss(color?: VideoColor): string | undefined {
  if (!color || color.enabled === false) return undefined;
  return `brightness(${String(1 + (color.brightness ?? 0))}) contrast(${String(color.contrast ?? 1)}) saturate(${String(color.saturation ?? 1)}) hue-rotate(${String(color.hue ?? 0)}deg)`;
}
