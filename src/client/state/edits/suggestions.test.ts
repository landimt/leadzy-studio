import { describe, expect, it } from 'vitest';
import type { WaveformPeaks } from '../../../core/peaks.js';
import type { EditDoc, Suggestion } from '../../../core/schema.js';
import {
  acceptAllSuggestions,
  acceptSuggestions,
  computeSilenceCuts,
  cutSilences,
  cutSuggestionInterval,
  rejectSuggestions,
  type SilenceCut,
} from './suggestions.js';

/** One character per 100 ms window: `S` is speech, `.` is room tone. */
function peaksOf(pattern: string): WaveformPeaks {
  const levels = Array.from(pattern).map((c) => (c === 'S' ? 0.8 : 0.01));
  return { version: 1, sampleRate: 48000, windowMs: 100, min: levels.map((l) => -l), max: levels };
}

function makeDoc(
  blocks: { source: string; in: number; out: number }[] = [{ source: 'cam', in: 0, out: 6 }],
): EditDoc {
  return {
    version: 2,
    fps: 25,
    output: { width: 1080, height: 1920, loudnormLufs: -14 },
    sources: { cam: { path: 'camera.mp4', durationS: 6 }, other: { path: 'other.mp4' } },
    tracks: [
      { id: 'base', kind: 'video', blocks },
      { id: 'audio-1', kind: 'audio', blocks: [{ source: 'cam', in: 0, out: 6, at: 0 }] },
    ],
    subtitles: { enabled: false, preset: '2p-caps' },
    totalDurationS: 6,
  };
}

const ms = (value: number): number => Math.round(value * 1000) / 1000;

/** Cuts with times rounded to the millisecond, so float window arithmetic compares as plain numbers. */
function rounded(cuts: readonly SilenceCut[]): SilenceCut[] {
  return cuts.map((cut) => ({ ...cut, from: ms(cut.from), to: ms(cut.to) }));
}

function baseBlocks(doc: EditDoc | null): readonly { in: number; out: number }[] {
  const base = doc?.tracks[0];
  return base?.kind === 'video' ? base.blocks : [];
}

// 6 s: speech 0–2, silence 2–3, speech 3–6
const INTERIOR = new Map([
  ['cam', peaksOf('SSSSSSSSSSSSSSSSSSSS..........SSSSSSSSSSSSSSSSSSSSSSSSSSSSSS')],
]);
// 6 s: breath 0–0.5, speech 0.5–5.5, breath 5.5–6
const EDGES = new Map([
  ['cam', peaksOf('.....SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS.....')],
]);

describe('computeSilenceCuts', () => {
  it('finds an interior silence, trimmed 80 ms after it starts and 50 ms before it ends', () => {
    const [cut, ...rest] = computeSilenceCuts(makeDoc(), INTERIOR, 0.5);

    expect(rest).toHaveLength(0);
    expect(cut?.source).toBe('cam');
    expect(cut?.from).toBeCloseTo(2.08, 5);
    expect(cut?.to).toBeCloseTo(2.95, 5);
  });

  it('ignores an interior silence shorter than the slider, but still cuts breaths at the block edges', () => {
    expect(computeSilenceCuts(makeDoc(), INTERIOR, 1.5)).toHaveLength(0);

    const cuts = computeSilenceCuts(makeDoc(), EDGES, 1.5);
    expect(cuts).toHaveLength(2);
    expect(cuts[0]?.from).toBe(0);
    expect(cuts[0]?.to).toBeCloseTo(0.45, 5);
    expect(cuts[1]?.from).toBeCloseTo(5.58, 5);
    expect(cuts[1]?.to).toBe(6);
  });

  it('honours the kind toggles', () => {
    expect(
      computeSilenceCuts(makeDoc(), INTERIOR, 0.5, { interior: false, edges: true }),
    ).toHaveLength(0);
    expect(
      rounded(computeSilenceCuts(makeDoc(), EDGES, 0.4, { interior: true, edges: false })),
    ).toEqual([
      { source: 'cam', from: 0.08, to: 0.45 },
      { source: 'cam', from: 5.58, to: 5.95 },
    ]);
    expect(
      computeSilenceCuts(makeDoc(), EDGES, 0.5, { interior: false, edges: false }),
    ).toHaveLength(0);
  });

  it('merges an edge breath and an interior silence that overlap into one cut', () => {
    // silence 0–1 is both a head breath (fine rule) and an interior silence (≥ 0.5 s)
    const peaks = new Map([
      ['cam', peaksOf('..........SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS')],
    ]);

    const cuts = computeSilenceCuts(makeDoc(), peaks, 0.5);

    expect(cuts).toHaveLength(1);
    expect(cuts[0]?.from).toBe(0);
    expect(cuts[0]?.to).toBeCloseTo(0.95, 5);
  });

  it('merges the tail breath of one block with the head breath of the next into one cut across the joint', () => {
    // 6 s: speech 0–2.5, silence 2.5–3.5, speech 3.5–6; the joint sits at 3
    const peaks = new Map([
      ['cam', peaksOf('SSSSSSSSSSSSSSSSSSSSSSSSS..........SSSSSSSSSSSSSSSSSSSSSSSSS')],
    ]);
    const joint = makeDoc([
      { source: 'cam', in: 0, out: 3 },
      { source: 'cam', in: 3, out: 6 },
    ]);

    expect(rounded(computeSilenceCuts(joint, peaks, 1.5))).toEqual([
      { source: 'cam', from: 2.58, to: 3.45 },
    ]);
  });

  // 6 s: speech 0–2.5, silence 2.5–3.5, speech 3.5–6
  const JOINT_BREATH = new Map([
    ['cam', peaksOf('SSSSSSSSSSSSSSSSSSSSSSSSS..........SSSSSSSSSSSSSSSSSSSSSSSSS')],
  ]);

  it('still merges across a joint when the next block starts up to 10 ms after the previous one ends', () => {
    const gapped = makeDoc([
      { source: 'cam', in: 0, out: 3 },
      { source: 'cam', in: 3.005, out: 6 },
    ]);

    expect(rounded(computeSilenceCuts(gapped, JOINT_BREATH, 1.5))).toEqual([
      { source: 'cam', from: 2.58, to: 3.45 },
    ]);
  });

  it.each([
    ['head breath starting 10 ms after the block', { in: 2.49, out: 6 }, { from: 2.49, to: 3.45 }],
    ['tail breath ending 10 ms before the block', { in: 0, out: 3.51 }, { from: 2.58, to: 3.51 }],
  ])('tolerates a %s', (_label, block, cut) => {
    const doc = makeDoc([{ source: 'cam', ...block }]);

    expect(rounded(computeSilenceCuts(doc, JOINT_BREATH, 1.5))).toEqual([
      { source: 'cam', ...cut },
    ]);
  });

  it.each([
    ['a head breath that would leave less than 100 ms', { in: 3.38, out: 6 }],
    ['a tail breath that would take less than 100 ms', { in: 0, out: 2.62 }],
  ])('skips %s', (_label, block) => {
    const doc = makeDoc([{ source: 'cam', ...block }]);

    expect(computeSilenceCuts(doc, JOINT_BREATH, 1.5)).toEqual([]);
  });

  it('keeps the longest reach when two blocks report the same silence', () => {
    const repeated = makeDoc([
      { source: 'cam', in: 0, out: 6 },
      { source: 'cam', in: 2, out: 3.2 },
    ]);

    expect(rounded(computeSilenceCuts(repeated, JOINT_BREATH, 0.5))).toEqual([
      { source: 'cam', from: 2.58, to: 3.45 },
    ]);
  });

  it('finds a 0.3 s breath glued to a joint even when the slider would ignore it', () => {
    // 6 s: speech 0–2.7, breath 2.7–3, speech 3–6
    const peaks = new Map([
      ['cam', peaksOf('SSSSSSSSSSSSSSSSSSSSSSSSSSS...SSSSSSSSSSSSSSSSSSSSSSSSSSSSSS')],
    ]);
    const joint = makeDoc([
      { source: 'cam', in: 0, out: 3 },
      { source: 'cam', in: 3, out: 6 },
    ]);

    expect(rounded(computeSilenceCuts(joint, peaks, 1.5))).toEqual([
      { source: 'cam', from: 2.78, to: 3 },
    ]);
  });

  it('cuts a 0.2 s head breath down to 50 ms before the speech starts', () => {
    const peaks = new Map([
      ['cam', peaksOf('..SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS')],
    ]);

    expect(rounded(computeSilenceCuts(makeDoc(), peaks, 1.5))).toEqual([
      { source: 'cam', from: 0, to: 0.15 },
    ]);
  });

  it('keeps 100 ms of a block whose head breath nearly fills it, unless the interior rule claims more', () => {
    // silence 0–0.5 inside a 0.535 s block: ends after `out - 0.05`, but not close enough to count as a tail
    const peaks = new Map([
      ['cam', peaksOf('.....SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS')],
    ]);
    const stub = makeDoc([{ source: 'cam', in: 0, out: 0.535 }]);

    expect(rounded(computeSilenceCuts(stub, peaks, 0.5, { interior: false, edges: true }))).toEqual(
      [{ source: 'cam', from: 0, to: 0.435 }],
    );
    expect(rounded(computeSilenceCuts(stub, peaks, 0.4))).toEqual([
      { source: 'cam', from: 0, to: 0.45 },
    ]);
  });

  it('only looks at blocks of the source the peaks belong to, and skips sources without peaks', () => {
    const doc = makeDoc([
      { source: 'other', in: 0, out: 6 },
      { source: 'cam', in: 0, out: 1 },
    ]);

    expect(computeSilenceCuts(doc, INTERIOR, 0.5)).toHaveLength(0);
    expect(computeSilenceCuts(makeDoc(), new Map(), 0.5)).toHaveLength(0);
  });
});

describe('cutSilences / cutSuggestionInterval / acceptAllSuggestions', () => {
  it('applies every cut to the base track and leaves the other tracks alone', () => {
    const next = cutSilences(makeDoc(), [
      { source: 'cam', from: 1, to: 2 },
      { source: 'cam', from: 4, to: 5 },
    ]);

    expect(baseBlocks(next).map((block) => [block.in, block.out])).toEqual([
      [0, 1],
      [2, 4],
      [5, 6],
    ]);
    expect(next?.tracks[1]).toStrictEqual(makeDoc().tracks[1]);
    expect(cutSilences(makeDoc(), [])).toBeNull();
  });

  it('cuts one suggestion interval out of the base track', () => {
    const suggestion: Suggestion = {
      id: 's1',
      type: 'silence',
      source: 'cam',
      start: 2,
      end: 3,
      reason: 'pause',
    };

    expect(
      baseBlocks(cutSuggestionInterval(makeDoc(), suggestion)).map((b) => [b.in, b.out]),
    ).toEqual([
      [0, 2],
      [3, 6],
    ]);
  });

  it('accepts every pending suggestion and clears the list', () => {
    const doc: EditDoc = {
      ...makeDoc(),
      suggestions: [
        { id: 'a', type: 'silence', source: 'cam', start: 1, end: 2, reason: 'pause' },
        { id: 'b', type: 'filler', source: 'cam', start: 4, end: 5, reason: 'um' },
      ],
    };

    const next = acceptAllSuggestions(doc);

    expect(next.suggestions).toEqual([]);
    expect(baseBlocks(next).map((block) => [block.in, block.out])).toEqual([
      [0, 1],
      [2, 4],
      [5, 6],
    ]);
    expect(acceptAllSuggestions(makeDoc())).toStrictEqual(makeDoc());
  });

  it('accepts or rejects a reviewed subset in one document result', () => {
    const doc: EditDoc = {
      ...makeDoc(),
      suggestions: [
        { id: 'a', type: 'silence', source: 'cam', start: 1, end: 2, reason: 'pause' },
        { id: 'b', type: 'filler', source: 'cam', start: 4, end: 5, reason: 'um' },
      ],
    };

    const accepted = acceptSuggestions(doc, new Set(['a']));
    expect(accepted.suggestions?.map((suggestion) => suggestion.id)).toEqual(['b']);
    expect(baseBlocks(accepted).map((block) => [block.in, block.out])).toEqual([
      [0, 1],
      [2, 6],
    ]);

    const rejected = rejectSuggestions(doc, new Set(['b']));
    expect(rejected.suggestions?.map((suggestion) => suggestion.id)).toEqual(['a']);
    expect(baseBlocks(rejected)).toStrictEqual(baseBlocks(doc));
  });
});
