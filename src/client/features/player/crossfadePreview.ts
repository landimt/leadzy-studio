import type { OutputSegment } from '../../../core/timeline.js';

/**
 * Duplicated from renderPlan's MIN_CROSSFADE_OVERLAP_S on purpose: that module
 * imports node:crypto for cache-key hashing and cannot enter a browser bundle.
 * The test suite pins both values together.
 */
export const CROSSFADE_MIN_OVERLAP_S = 0.1;

/**
 * Total crossfade overlap available across BOTH sides, mirroring
 * `resolveJoin` in core/render/audio.ts: a speed mismatch on either
 * side, or too little overlap, degrades a crossfade to the fade-black dip
 * instead of blending — the live preview applies the same test to pick which
 * simulation an emenda gets. The B side never needs a probe (`segment.in` is
 * doc data); the A side needs the PREVIOUS block's source duration, which the
 * Player only knows once `state.project.media` has that source's probe —
 * when it doesn't, this optimistically assumes the full half is available
 * (same documented gap `resolveJoin` doesn't have, since the render always
 * probes first).
 */
export function crossfadeOverlapS(
  previous: OutputSegment | undefined,
  segment: OutputSegment,
  transitionDurationS: number,
  sourceDurationS: ReadonlyMap<string, number>,
): number {
  if (previous?.speed !== 1 || segment.speed !== 1) return 0;
  const half = transitionDurationS / 2;
  const extendBS = Math.min(half, segment.in);
  const previousDurationS = sourceDurationS.get(previous.source);
  const extendAS =
    previousDurationS === undefined
      ? half
      : Math.min(half, Math.max(0, previousDurationS - previous.out));
  return extendAS + extendBS;
}
