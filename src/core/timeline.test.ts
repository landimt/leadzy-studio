import { describe, expect, it } from 'vitest';
import type { EditDoc, VideoBlock } from './schema.js';
import type { TranscriptWord } from './transcript.js';
import {
  applySuggestion,
  cutInterval,
  outputDuration,
  outputSegments,
  outputTimeOf,
  reorderBlockByDrop,
  restoreInterval,
  restoreWordRange,
  segmentOutputTime,
  snapEdge,
  sourceTimeAt,
  splitBlockAt,
  strikeWordRange,
  withRecomputedDuration,
  wordStates,
} from './timeline.js';

const word = (text: string, start: number, end: number): TranscriptWord => ({
  text,
  start,
  end,
  type: 'word',
});

const doc: EditDoc = {
  version: 2,
  fps: 25,
  output: { width: 1080, height: 1920, loudnormLufs: -14 },
  sources: { cam: { path: 'camera.mp4' } },
  tracks: [
    {
      id: 'base',
      kind: 'video',
      blocks: [
        { source: 'cam', in: 1, out: 5 },
        { source: 'cam', in: 10, out: 14 },
      ],
    },
  ],
  subtitles: { enabled: false, preset: '2p-caps' },
  suggestions: [
    { id: 's1', type: 'silence', source: 'cam', start: 2, end: 3, reason: '1.0s pause' },
  ],
};

describe('output timeline mapping', () => {
  it('concatenates base blocks into the output timeline', () => {
    const segments = outputSegments(doc);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ outputStart: 0, outputEnd: 4 });
    expect(segments[1]).toMatchObject({ outputStart: 4, outputEnd: 8 });
    expect(outputDuration(doc)).toBe(8);
  });

  it('maps output time to source time across the cut', () => {
    expect(sourceTimeAt(doc, 2)).toMatchObject({ source: 'cam', time: 3, blockIndex: 0 });
    expect(sourceTimeAt(doc, 5)).toMatchObject({ source: 'cam', time: 11, blockIndex: 1 });
    expect(sourceTimeAt(doc, 99)).toBeNull();
  });

  it('maps source time to output time, skipping cut material', () => {
    expect(outputTimeOf(doc, 'cam', 3)).toBe(2);
    expect(outputTimeOf(doc, 'cam', 11)).toBe(5);
    expect(outputTimeOf(doc, 'cam', 7)).toBeNull();
  });
});

describe('output timeline mapping — block speed', () => {
  const speedDoc: EditDoc = {
    ...doc,
    tracks: [
      {
        id: 'base',
        kind: 'video',
        blocks: [
          { source: 'cam', in: 1, out: 5 }, // 1x: 4s source -> 4s output
          { source: 'cam', in: 10, out: 14, speed: 2 }, // 2x: 4s source -> 2s output
        ],
      },
    ],
  };

  it("compresses a sped-up block's output duration by its speed, quantized to the fps grid", () => {
    const segments = outputSegments(speedDoc);
    expect(segments[0]).toMatchObject({ outputStart: 0, outputEnd: 4, speed: 1 });
    expect(segments[1]).toMatchObject({ outputStart: 4, outputEnd: 6, speed: 2 });
    expect(outputDuration(speedDoc)).toBe(6);
  });

  it('defaults speed to 1 when the block omits it — byte-identical to a doc that never used the field', () => {
    const segments = outputSegments(doc);
    expect(segments.every((s) => s.speed === 1)).toBe(true);
  });

  it('scales the intra-block source-time delta by 1/speed via segmentOutputTime', () => {
    const segments = outputSegments(speedDoc);
    const spedSegment = segments[1]!;
    // 1s into the sped-up block's source window lands at 0.5s of output (2x).
    expect(segmentOutputTime(spedSegment, 11)).toBeCloseTo(4.5, 5);
    // the very start and end of the window still line up exactly.
    expect(segmentOutputTime(spedSegment, 10)).toBeCloseTo(4, 5);
  });

  it('sourceTimeAt scales the output-to-source delta by speed (the inverse mapping)', () => {
    // output 5 is 1s into the 2x block (starts at output 4) -> 2s of source
    expect(sourceTimeAt(speedDoc, 5)).toMatchObject({ source: 'cam', time: 12, blockIndex: 1 });
  });

  it('outputTimeOf is the exact inverse of sourceTimeAt across a sped-up block', () => {
    const outputTime = outputTimeOf(speedDoc, 'cam', 12);
    expect(outputTime).toBeCloseTo(5, 5);
    expect(sourceTimeAt(speedDoc, outputTime!)).toMatchObject({ time: 12 });
  });

  it('reorderBlockByDrop accounts for speed when computing output-time midpoints', () => {
    // block 0 (1x) spans output 0-4, midpoint 2; block 1 (2x) spans output 4-6, midpoint 5.
    // Dropping block 1 at output 1 (before block 0's midpoint) should move it to the front.
    const blocks = speedDoc.tracks[0]!.blocks as VideoBlock[];
    const result = reorderBlockByDrop(blocks, 1, 1);
    expect(result[0]).toMatchObject({ speed: 2 });
  });
});

describe('wordStates', () => {
  it('classifies words by block coverage of their midpoint', () => {
    const words = [word('kept', 1.2, 1.8), word('cut', 6, 7), word('kept2', 10.5, 11)];
    expect(wordStates(doc.tracks[0]!.blocks as VideoBlock[], 'cam', words)).toEqual([
      'kept',
      'cut',
      'kept',
    ]);
  });
});

describe('cutInterval', () => {
  const blocks: VideoBlock[] = [{ source: 'cam', in: 1, out: 5 }];

  it('drops a fully covered block', () => {
    expect(cutInterval(blocks, 'cam', 0, 6)).toHaveLength(0);
  });

  it('trims the right side when the cut hits the tail', () => {
    expect(cutInterval(blocks, 'cam', 4, 6)).toEqual([{ source: 'cam', in: 1, out: 4 }]);
  });

  it('trims the left side when the cut hits the head', () => {
    expect(cutInterval(blocks, 'cam', 0, 2)).toEqual([{ source: 'cam', in: 2, out: 5 }]);
  });

  it('splits the block on a middle cut', () => {
    expect(cutInterval(blocks, 'cam', 2, 3)).toEqual([
      { source: 'cam', in: 1, out: 2 },
      { source: 'cam', in: 3, out: 5 },
    ]);
  });

  it('shifts "at" of the right half when splitting a layer block', () => {
    const layer: VideoBlock[] = [
      { source: 'cam', in: 0, out: 10, at: 20, mode: 'pip', audio: 'mute' },
    ];
    const result = cutInterval(layer, 'cam', 4, 6);
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ in: 6, out: 10, at: 24 });
  });
});

describe('strike and restore words', () => {
  // "one two three four" — striking "three" must land the cut in the air
  // around it, never inside a word.
  const words = [
    word('one', 1, 1.5),
    word('two', 1.6, 2),
    word('three', 2.5, 3),
    word('four', 3.4, 4),
  ];
  const blocks: VideoBlock[] = [{ source: 'cam', in: 0.5, out: 4.5 }];

  it('strikes a middle word with padding taken from its neighbours', () => {
    const result = strikeWordRange(blocks, 'cam', words, { startIndex: 2, endIndex: 2 });
    expect(result).toHaveLength(2);
    // cut starts at two.end + 0.08 = 2.08, ends at four.start - 0.05 = 3.35
    expect(result[0]).toMatchObject({ in: 0.5, out: 2.08 });
    expect(result[1]).toMatchObject({ in: 3.35, out: 4.5 });
  });

  it('striking the first word cuts from the block head', () => {
    const result = strikeWordRange(blocks, 'cam', words, { startIndex: 0, endIndex: 0 });
    expect(result).toHaveLength(1);
    // cut ends at two.start - 0.05 = 1.55
    expect(result[0]).toMatchObject({ in: 1.55, out: 4.5 });
  });

  it('restore bridges the gap created by a strike', () => {
    const struck = strikeWordRange(blocks, 'cam', words, { startIndex: 2, endIndex: 2 });
    const restored = restoreWordRange(struck, 'cam', words, { startIndex: 2, endIndex: 2 });
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ in: 0.5, out: 4.5 });
  });

  it('restore keeps unrelated silence cut', () => {
    const twoBlocks: VideoBlock[] = [
      { source: 'cam', in: 0, out: 2 },
      { source: 'cam', in: 8, out: 10 },
    ];
    const result = restoreInterval(twoBlocks, 'cam', 4, 5);
    expect(result).toHaveLength(3);
    expect(result[1]).toMatchObject({ in: 4, out: 5 });
  });
});

describe('splitBlockAt', () => {
  it('splits a base block at source time', () => {
    const result = splitBlockAt([{ source: 'cam', in: 1, out: 5 }], 0, 3);
    expect(result).toEqual([
      { source: 'cam', in: 1, out: 3 },
      { source: 'cam', in: 3, out: 5 },
    ]);
  });

  it('splits a layer and keeps the second half aligned on the output timeline', () => {
    const result = splitBlockAt(
      [
        {
          source: 'screen',
          in: 1,
          out: 5,
          at: 10,
          mode: 'split',
          split: { ratio: 0.5, arrangement: 'top' },
          audio: 'mute',
        },
      ],
      0,
      3,
    );
    expect(result).toEqual([
      {
        source: 'screen',
        in: 1,
        out: 3,
        at: 10,
        mode: 'split',
        split: { ratio: 0.5, arrangement: 'top' },
        audio: 'mute',
      },
      {
        source: 'screen',
        in: 3,
        out: 5,
        at: 12,
        mode: 'split',
        split: { ratio: 0.5, arrangement: 'top' },
        audio: 'mute',
      },
    ]);
  });

  it('ignores split points outside the block', () => {
    const blocks: VideoBlock[] = [{ source: 'cam', in: 1, out: 5 }];
    expect(splitBlockAt(blocks, 0, 5)).toEqual(blocks);
  });
});

describe('reorderBlockByDrop', () => {
  // output spans: A 0–2, B 2–5, C 5–6
  const takes: VideoBlock[] = [
    { source: 'cam', in: 0, out: 2 },
    { source: 'cam', in: 10, out: 13 },
    { source: 'cam', in: 20, out: 21 },
  ];

  it('moves the first block to the end when dropped past the others', () => {
    expect(reorderBlockByDrop(takes, 0, 4)).toEqual([takes[1], takes[2], takes[0]]);
  });

  it('moves the last block to the front when dropped at zero', () => {
    expect(reorderBlockByDrop(takes, 2, 0)).toEqual([takes[2], takes[0], takes[1]]);
  });

  it('drops between two blocks when the leading edge crosses a midpoint', () => {
    // C dropped at 1.5 → leading edge past A's midpoint (1.0), before B's (3.5)
    expect(reorderBlockByDrop(takes, 2, 1.5)).toEqual([takes[0], takes[2], takes[1]]);
  });

  it('a small jiggle that crosses nothing keeps the order', () => {
    expect(reorderBlockByDrop(takes, 1, 2.3)).toEqual(takes);
    expect(reorderBlockByDrop(takes, 1, 1.7)).toEqual(takes);
  });

  it('keeps the order when dropped back on its own position', () => {
    expect(reorderBlockByDrop(takes, 1, 2)).toEqual(takes);
  });

  it('returns an unchanged copy for an out-of-range index', () => {
    expect(reorderBlockByDrop(takes, 9, 0)).toEqual(takes);
  });
});

describe('snapEdge', () => {
  const words = [word('hello', 2, 2.4)];

  it('snaps an "in" edge to just before the nearest word', () => {
    const result = snapEdge(2.1, 'in', words, []);
    expect(result.snapped).toBe(true);
    expect(result.time).toBe(1.95);
    expect(result.word?.text).toBe('hello');
  });

  it('snaps an "out" edge to just after the word', () => {
    const result = snapEdge(2.5, 'out', words, []);
    expect(result.time).toBe(2.48);
  });

  it('falls back to silence boundaries without a transcript', () => {
    const result = snapEdge(5.1, 'out', [], [{ start: 5, end: 6 }]);
    expect(result.snapped).toBe(true);
    expect(result.time).toBe(5.08);
  });

  it('does not snap beyond the threshold', () => {
    const result = snapEdge(9, 'in', words, [], 0.25);
    expect(result.snapped).toBe(false);
    expect(result.time).toBe(9);
  });
});

describe('suggestions', () => {
  it('applySuggestion cuts the interval and removes the suggestion', () => {
    const next = applySuggestion(doc, 's1');
    expect(next.suggestions).toHaveLength(0);
    const blocks = next.tracks[0]!.blocks;
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ in: 1, out: 2 });
    expect(blocks[1]).toMatchObject({ in: 3, out: 5 });
  });

  it('withRecomputedDuration tracks the base line', () => {
    const next = withRecomputedDuration(applySuggestion(doc, 's1'));
    expect(next.totalDurationS).toBe(7);
  });
});
