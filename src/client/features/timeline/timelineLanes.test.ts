import { describe, expect, it } from 'vitest';

import { assignOverlayLanes } from './timelineLanes.js';

describe('assignOverlayLanes', () => {
  it('keeps non-overlapping blocks on the single base lane', () => {
    const result = assignOverlayLanes([
      { start: 0, end: 2 },
      { start: 5, end: 7 },
      { start: 2, end: 5 },
    ]);
    expect(result.lanes).toEqual([0, 0, 0]);
    expect(result.laneCount).toBe(1);
  });

  it('gives the later (renders-on-top) block the higher lane when two overlap', () => {
    const result = assignOverlayLanes([
      { start: 10, end: 14 },
      { start: 12, end: 16 },
    ]);
    expect(result.lanes).toEqual([0, 1]);
    expect(result.laneCount).toBe(2);
  });

  it('reuses a lane once every block it overlapped has ended', () => {
    const result = assignOverlayLanes([
      { start: 0, end: 4 },
      { start: 2, end: 6 },
      { start: 10, end: 12 },
    ]);
    expect(result.lanes).toEqual([0, 1, 0]);
    expect(result.laneCount).toBe(2);
  });

  it('staircases a chain: each block sits strictly above every earlier one it overlaps', () => {
    // C overlaps B (4–6) and composites above it in the render; dropping C
    // back to lane 0 would show it BELOW B exactly while both are on screen.
    const result = assignOverlayLanes([
      { start: 0, end: 4 },
      { start: 2, end: 6 },
      { start: 4, end: 8 },
    ]);
    expect(result.lanes).toEqual([0, 1, 2]);
    expect(result.laneCount).toBe(3);
  });

  it('stacks three simultaneous blocks on three lanes', () => {
    const result = assignOverlayLanes([
      { start: 1, end: 5 },
      { start: 1, end: 5 },
      { start: 1, end: 5 },
    ]);
    expect(result.lanes).toEqual([0, 1, 2]);
    expect(result.laneCount).toBe(3);
  });

  it('treats exact touching as non-overlap and reports one lane for no blocks', () => {
    expect(
      assignOverlayLanes([
        { start: 0, end: 3 },
        { start: 3, end: 6 },
      ]).laneCount,
    ).toBe(1);
    expect(assignOverlayLanes([]).laneCount).toBe(1);
  });
});
