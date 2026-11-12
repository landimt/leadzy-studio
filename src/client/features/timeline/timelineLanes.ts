/** Output-timeline span of one block, in seconds. */
export interface LaneSpan {
  readonly start: number;
  readonly end: number;
}

export interface LaneAssignment {
  /** Lane per block, parallel to the input. Lane 0 is the base row. */
  readonly lanes: readonly number[];
  readonly laneCount: number;
}

/** Blocks that merely touch (end === next start) share a lane. */
const TOUCH_EPSILON_S = 1e-9;

function overlapsInTime(a: LaneSpan, b: LaneSpan): boolean {
  return a.start < b.end - TOUCH_EPSILON_S && b.start < a.end - TOUCH_EPSILON_S;
}

/**
 * Splits overlapping blocks of one track into stacked lanes so none hides
 * another in the timeline. The invariant is the z-order story: a block later
 * in the array composites ON TOP in the render (renderPlan composites
 * overlays in block order and the player mirrors it), so it must sit on a
 * STRICTLY higher lane than every earlier block it overlaps in time — the
 * caller draws higher lanes higher up, making "visually on top" and "renders
 * on top" agree for every pair the viewer can ever see together. Below that
 * floor, lanes are reused first-fit, so disjoint blocks share rows no matter
 * their array order. Chained overlaps (A∩B, B∩C, A∥C) therefore staircase
 * upward instead of dropping back — honesty over compactness.
 */
export function assignOverlayLanes(spans: readonly LaneSpan[]): LaneAssignment {
  const laneSpans: LaneSpan[][] = [];
  const lanes: number[] = [];
  spans.forEach((span, index) => {
    let minLane = 0;
    for (let earlier = 0; earlier < index; earlier += 1) {
      const other = spans[earlier];
      if (other !== undefined && overlapsInTime(span, other)) {
        minLane = Math.max(minLane, (lanes[earlier] ?? 0) + 1);
      }
    }
    let lane = minLane;
    while (laneSpans[lane]?.some((other) => overlapsInTime(span, other)) === true) {
      lane += 1;
    }
    (laneSpans[lane] ??= []).push(span);
    lanes.push(lane);
  });
  return { lanes, laneCount: Math.max(1, laneSpans.length) };
}
