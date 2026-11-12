import { describe, expect, it } from 'vitest';
import type { EditDoc } from '../../../core/schema.js';
import { outputDuration, outputSegments } from '../../../core/timeline.js';
import { applyClipRange, clipRangeInfo, dragClipRange } from './clipRange.js';

const doc: EditDoc = {
  version: 2,
  fps: 25,
  output: { width: 1080, height: 1920, loudnormLufs: -14 },
  sources: { cam: { path: 'camera.mp4', durationS: 30 } },
  tracks: [
    {
      id: 'base',
      kind: 'video',
      blocks: [
        { source: 'cam', in: 1, out: 5, speed: 2 },
        { source: 'cam', in: 6, out: 10 },
      ],
    },
    {
      id: 'pip',
      kind: 'video',
      blocks: [{ source: 'cam', in: 2, out: 4, at: 1, mode: 'pip', audio: 'mute', scale: 0.4 }],
    },
    {
      id: 'voice',
      kind: 'audio',
      blocks: [{ source: 'cam', in: 1, out: 4, at: 2, gainDb: -6, fadeInS: 1, fadeOutS: 1 }],
    },
    {
      id: 'art',
      kind: 'overlay',
      blocks: [
        { file: 'card.webm', at: 2, duration: 3, scale: 0.5 },
        { file: 'logo.png', at: 1, duration: 3 },
      ],
    },
    { id: 'fx', kind: 'effect', blocks: [{ type: 'flash', at: 2, duration: 0.3 }] },
  ],
  subtitles: { enabled: false, preset: 'pill' },
  totalDurationS: 6,
};

describe('source range editing', () => {
  it.each(['base', 'pip', 'voice'])(
    'slips %s without moving the block or changing duration',
    (trackId) => {
      const selection = { trackId, blockIndex: 0 };
      const before = clipRangeInfo(doc, selection)!;
      const next = applyClipRange(
        doc,
        selection,
        { start: before.range.start + 5, end: before.range.end + 5 },
        30,
      )!;
      const after = clipRangeInfo(next, selection)!;
      expect(after.at).toBe(before.at);
      expect(after.range.end - after.range.start).toBe(before.range.end - before.range.start);
      expect(outputDuration(next)).toBe(outputDuration(doc));
      expect(doc.tracks[0]!.blocks[0]).toMatchObject({ in: 1, out: 5 });
    },
  );

  it('trims the base with its speed and moves only later base blocks', () => {
    const next = applyClipRange(doc, { trackId: 'base', blockIndex: 0 }, { start: 2, end: 4 }, 30)!;
    expect(outputSegments(next)[1]?.outputStart).toBe(1);
    expect(next.tracks[0]?.blocks[0]).toMatchObject({ speed: 2 });
    expect(next.tracks[1]).toEqual(doc.tracks[1]);
  });

  it('preserves placement and clamps audio fades after a shorter selection', () => {
    const next = applyClipRange(
      doc,
      { trackId: 'voice', blockIndex: 0 },
      { start: 2, end: 2.5 },
      30,
    )!;
    expect(next.tracks[2]?.blocks[0]).toMatchObject({
      in: 2,
      out: 2.5,
      at: 2,
      gainDb: -6,
      fadeInS: 0.5,
    });
    expect(next.tracks[2]?.blocks[0]).not.toHaveProperty('fadeOutS');
  });

  it('persists a source offset for animated overlays while preserving their placement', () => {
    const next = applyClipRange(doc, { trackId: 'art', blockIndex: 0 }, { start: 4, end: 7 }, 10)!;
    expect(next.tracks[3]?.blocks[0]).toMatchObject({
      sourceIn: 4,
      duration: 3,
      at: 2,
      scale: 0.5,
    });
    expect(clipRangeInfo(next, { trackId: 'art', blockIndex: 0 })?.range).toEqual({
      start: 4,
      end: 7,
    });
  });

  it('edits the display window of a still image on the output timeline', () => {
    const selection = { trackId: 'art', blockIndex: 1 };
    expect(clipRangeInfo(doc, selection)?.mode).toBe('timeline');
    expect(applyClipRange(doc, selection, { start: 2, end: 5 }, 6)?.tracks[3]?.blocks[1]).toEqual({
      file: 'logo.png',
      at: 2,
      duration: 3,
    });
  });

  it('honors the effect-specific duration limits', () => {
    const selection = { trackId: 'fx', blockIndex: 0 };
    expect(applyClipRange(doc, selection, { start: 3, end: 3.5 }, 6)?.tracks[4]?.blocks[0]).toEqual(
      { type: 'flash', at: 3, duration: 0.5 },
    );
    expect(applyClipRange(doc, selection, { start: 3, end: 4 }, 6)).toBeNull();
  });

  it.each([
    { start: -1, end: 2 },
    { start: 1, end: 31 },
    { start: 2, end: 2 },
    { start: NaN, end: 5 },
    { start: 0, end: Infinity },
  ])('rejects invalid ranges %j', (range) => {
    expect(applyClipRange(doc, { trackId: 'base', blockIndex: 0 }, range, 30)).toBeNull();
  });

  it('does not invent a source duration when metadata is absent', () => {
    expect(
      clipRangeInfo(
        { ...doc, sources: { cam: { path: 'camera.mp4' } } },
        { trackId: 'base', blockIndex: 0 },
      )?.duration,
    ).toBeNull();
  });
});

describe('dragging a source window', () => {
  const range = { start: 2, end: 5 };
  it('stops at either source boundary without changing the length', () => {
    expect(dragClipRange(range, 'move', -20, 10, 0.2, Infinity)).toEqual({ start: 0, end: 3 });
    expect(dragClipRange(range, 'move', 20, 10, 0.2, Infinity)).toEqual({ start: 7, end: 10 });
  });
  it('never crosses the opposite edge', () => {
    expect(dragClipRange(range, 'start', 20, 10, 0.2, Infinity)).toEqual({ start: 4.8, end: 5 });
    expect(dragClipRange(range, 'end', -20, 10, 0.2, Infinity)).toEqual({ start: 2, end: 2.2 });
  });
  it('caps effect duration while resizing', () => {
    expect(dragClipRange({ start: 2, end: 2.3 }, 'end', 20, 10, 0.08, 0.6).end).toBe(2.6);
  });
});

describe('animated overlays held after EOF', () => {
  const held: EditDoc = {
    ...doc,
    tracks: [
      doc.tracks[0]!,
      { id: 'held', kind: 'overlay', blocks: [{ file: 'card.webm', at: 0, duration: 5.07 }] },
    ],
  };
  const selection = { trackId: 'held', blockIndex: 0 };
  it('preserves an existing hold while trimming the beginning within the source', () => {
    expect(
      applyClipRange(held, selection, { start: 1, end: 5.07 }, 4)?.tracks[1]?.blocks[0],
    ).toMatchObject({ sourceIn: 1, duration: 4.07, at: 0 });
  });
  it('cannot seek into the hold or extend beyond the existing end', () => {
    expect(applyClipRange(held, selection, { start: 4, end: 5.07 }, 4)).toBeNull();
    expect(applyClipRange(held, selection, { start: 1, end: 6 }, 4)).toBeNull();
  });
});
