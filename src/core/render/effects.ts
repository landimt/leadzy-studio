import {
  SHAKE_DEFAULT_INTENSITY,
  type FlashEffectBlock,
  type ShakeEffectBlock,
  type ZoomEffectBlock,
} from '../schema.js';
import { fmt } from './steps.js';
import type { Dimensions } from './canvas.js';

/**
 * Punch-in zoom: split the current video, crop+scale one branch to a tighter
 * framing, overlay it back only during the effect window (the untouched
 * branch shows everywhere else — `enable` gates the composite, not the crop).
 */
export function zoomEffectFilters(
  effect: ZoomEffectBlock,
  dims: Dimensions,
  index: number,
  src: string,
  outLabel: string,
): string[] {
  const enable = `enable='between(t,${fmt(effect.at)},${fmt(effect.at + effect.duration)})'`;
  const cropW = 2 * Math.round(dims.width / effect.scale / 2);
  const cropH = 2 * Math.round(dims.height / effect.scale / 2);
  const a = `ea${String(index)}`;
  const b = `eb${String(index)}`;
  const z = `ez${String(index)}`;
  return [
    `${src}split=2[${a}][${b}]`,
    `[${b}]crop=${String(cropW)}:${String(cropH)},scale=${String(dims.width)}:${String(dims.height)}[${z}]`,
    `[${a}][${z}]overlay=0:0:${enable}[${outLabel}]`,
  ];
}

/**
 * Impact flash: a white layer whose alpha ramps 0 → 0.9 → 0 across the
 * window (geq on the alpha channel), generated for only `effect.duration`
 * worth of frames and timeshifted onto the window with setpts. Bounding the
 * generated clip this way keeps the per-pixel geq cost to the flash itself —
 * measured: geq over a whole 12s 1080x1920 timeline took 30+ CPU-minutes and
 * was killed before finishing; this bounded form took 0.74s for the same
 * output.
 */
export function flashEffectFilters(
  effect: FlashEffectBlock,
  dims: Dimensions,
  fps: number,
  index: number,
  src: string,
  outLabel: string,
): string[] {
  const enable = `enable='between(t,${fmt(effect.at)},${fmt(effect.at + effect.duration)})'`;
  const white = `ef${String(index)}`;
  const alpha = `255*max(0,min(1,1-abs(2*T/${fmt(effect.duration)}-1)))*0.9`;
  return [
    `color=c=white:s=${String(dims.width)}x${String(dims.height)}:d=${fmt(effect.duration)}:r=${String(fps)},format=yuva420p,geq=r='255':g='255':b='255':a='${alpha}',setpts=PTS+${fmt(effect.at)}/TB[${white}]`,
    `${src}[${white}]overlay=0:0:${enable}[${outLabel}]`,
  ];
}

/**
 * Camera shake: a light fixed zoom-in (opens a margin so the jitter never
 * exposes the frame edge) plus a deterministic sine-jitter crop offset
 * scaled by `intensity` and capped at 80% of that margin — same
 * split+crop+scale+overlay shape as the zoom effect above. `crop`'s x/y
 * expressions are re-evaluated per output frame (verified against a static
 * patterned input — a uniform-color source can't distinguish per-frame
 * evaluation from a frozen offset, since any crop of a flat color looks the
 * same), so the jitter animates frame by frame rather than freezing at init.
 */
export function shakeEffectFilters(
  effect: ShakeEffectBlock,
  dims: Dimensions,
  index: number,
  src: string,
  outLabel: string,
): string[] {
  const enable = `enable='between(t,${fmt(effect.at)},${fmt(effect.at + effect.duration)})'`;
  const intensity = effect.intensity ?? SHAKE_DEFAULT_INTENSITY;
  const zoomFactor = 1 + 0.04 * (intensity / 5);
  const cropW = 2 * Math.round(dims.width / zoomFactor / 2);
  const cropH = 2 * Math.round(dims.height / zoomFactor / 2);
  const ampX = ((dims.width - cropW) / 2) * 0.8;
  const ampY = ((dims.height - cropH) / 2) * 0.8;
  const t0 = fmt(effect.at);
  const jitterX = `${fmt(ampX / 2)}*sin((t-${t0})*37)+${fmt(ampX / 2)}*sin((t-${t0})*53+1.3)`;
  const jitterY = `${fmt(ampY / 2)}*sin((t-${t0})*41)+${fmt(ampY / 2)}*sin((t-${t0})*59+0.7)`;
  const a = `sa${String(index)}`;
  const b = `sb${String(index)}`;
  const z = `sz${String(index)}`;
  return [
    `${src}split=2[${a}][${b}]`,
    `[${b}]crop=${String(cropW)}:${String(cropH)}:'(in_w-out_w)/2+${jitterX}':'(in_h-out_h)/2+${jitterY}',scale=${String(dims.width)}:${String(dims.height)}[${z}]`,
    `[${a}][${z}]overlay=0:0:${enable}[${outLabel}]`,
  ];
}
