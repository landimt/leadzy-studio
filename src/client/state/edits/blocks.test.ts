import { describe, expect, it } from 'vitest';
import type { EditDoc } from '../../../core/schema.js';
import { MIN_TIMED_BLOCK_S } from '../../../core/timeline.js';
import type { MediaSummary } from '../../api.js';
import {
  appendToBase,
  deleteBlocks,
  insertIntoBase,
  moveTimedBlock,
  reorderBaseBlock,
  resizeTimedBlock,
  setBlockSpeed,
  setBlockTransition,
  setSelectedTransform,
  canSplitAtPlayhead,
  canTrimAtPlayhead,
  splitAtPlayhead,
  updateOverlayBlock,
  updateSelectedLayerBlock,
  trimAtPlayhead,
  trimSelectedEdge,
  nudgeSelectedBlock,
} from './blocks.js';

function makeDoc(): EditDoc {
  return {
    version: 2,
    fps: 25,
    output: { width: 1080, height: 1920, loudnormLufs: -14 },
    sources: {
      cam: { path: 'camera.mp4', durationS: 10 },
      voice: { path: 'voice.wav', durationS: 6 },
    },
    tracks: [
      {
        id: 'base',
        kind: 'video',
        blocks: [
          { source: 'cam', in: 0, out: 4 },
          { source: 'cam', in: 5, out: 9 },
        ],
      },
      { id: 'audio-1', kind: 'audio', blocks: [{ source: 'voice', in: 1, out: 4, at: 2 }] },
      {
        id: 'overlays',
        kind: 'overlay',
        blocks: [{ file: 'edit/assets/logo.png', at: 1, duration: 2 }],
      },
      {
        id: 'layer-1',
        kind: 'video',
        blocks: [{ source: 'cam', in: 0, out: 2, at: 1, mode: 'pip', audio: 'mute' }],
      },
      { id: 'fx', kind: 'effect', blocks: [{ type: 'flash', at: 2, duration: 0.3 }] },
    ],
    subtitles: { enabled: false, preset: '2p-caps' },
    totalDurationS: 8,
  };
}

const video: MediaSummary = {
  kind: 'video',
  relPath: 'take2.mp4',
  durationS: 3.456,
  fps: 25,
  width: 1080,
  height: 1920,
  hasAudio: true,
  transcriptEngine: null,
  proxyRelPath: null,
};

const image: MediaSummary = {
  kind: 'image',
  relPath: 'still.png',
  width: 100,
  height: 100,
  hasAudio: false,
  transcriptEngine: null,
  proxyRelPath: null,
};

function baseBlocks(doc: EditDoc): readonly { in: number; out: number }[] {
  const base = doc.tracks[0];
  return base?.kind === 'video' ? base.blocks : [];
}

const LAYER = { source: 'cam', in: 0, out: 2, at: 1, mode: 'pip', audio: 'mute' } as const;
const LAYER_SELECTION = { trackId: 'layer-1', blockIndex: 0 } as const;

function layerBlocks(doc: EditDoc | null | undefined): readonly unknown[] {
  const layer = doc?.tracks[3];
  return layer?.kind === 'video' ? layer.blocks : [];
}

function effectBlocks(doc: EditDoc | null | undefined): readonly unknown[] {
  const fx = doc?.tracks[4];
  return fx?.kind === 'effect' ? fx.blocks : [];
}

describe('deleteBlocks', () => {
  it('removes every targeted index across tracks and leaves the rest untouched', () => {
    const next = deleteBlocks(makeDoc(), [
      { trackId: 'base', blockIndex: 0 },
      { trackId: 'audio-1', blockIndex: 0 },
    ]);

    expect(baseBlocks(next)).toEqual([{ source: 'cam', in: 5, out: 9 }]);
    expect(next.tracks[1]).toEqual({ id: 'audio-1', kind: 'audio', blocks: [] });
    expect(next.tracks[2]).toEqual(makeDoc().tracks[2]);
  });
});

describe('trimAtPlayhead', () => {
  it('trims the base block under the cursor and flags that extra selections went stale', () => {
    const trimmed = trimAtPlayhead(makeDoc(), null, 'left', 1.5);

    expect(trimmed?.clearsExtraSelections).toBe(true);
    expect(baseBlocks(trimmed?.doc ?? makeDoc())[0]).toEqual({ source: 'cam', in: 1.5, out: 4 });
  });

  it('trims a selected audio block in source time and keeps the extras', () => {
    const trimmed = trimAtPlayhead(makeDoc(), { trackId: 'audio-1', blockIndex: 0 }, 'right', 3);

    expect(trimmed?.clearsExtraSelections).toBe(false);
    expect(trimmed?.doc.tracks[1]).toEqual({
      id: 'audio-1',
      kind: 'audio',
      blocks: [{ source: 'voice', in: 1, out: 2, at: 2 }],
    });
  });

  it('is a no-op outside the selected block and on a non-finite time', () => {
    expect(trimAtPlayhead(makeDoc(), { trackId: 'audio-1', blockIndex: 0 }, 'left', 9)).toBeNull();
    expect(trimAtPlayhead(makeDoc(), null, 'left', Number.NaN)).toBeNull();
  });
});

describe('splitAtPlayhead', () => {
  it('splits the base block under the playhead into two adjoining blocks', () => {
    const next = splitAtPlayhead(makeDoc(), null, 1);

    expect(baseBlocks(next ?? makeDoc())).toEqual([
      { source: 'cam', in: 0, out: 1 },
      { source: 'cam', in: 1, out: 4 },
      { source: 'cam', in: 5, out: 9 },
    ]);
  });

  it('is a no-op on a non-finite playhead', () => {
    expect(splitAtPlayhead(makeDoc(), null, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('refuses a playhead resting on a block edge instead of returning an identical doc', () => {
    expect(splitAtPlayhead(makeDoc(), null, 0)).toBeNull();
    expect(splitAtPlayhead(makeDoc(), null, 4)).toBeNull();
  });
});

describe('canSplitAtPlayhead / canTrimAtPlayhead', () => {
  it('answers false where the tool would swallow the click', () => {
    const doc = makeDoc();
    // the needle every project opens on: the very start of the first block
    expect(canSplitAtPlayhead(doc, null, 0)).toBe(false);
    // the emenda between two base blocks is an edge on both sides
    expect(canSplitAtPlayhead(doc, null, 4)).toBe(false);
    // past the end of the montage there is no block at all
    expect(canSplitAtPlayhead(doc, null, 8)).toBe(false);
    expect(canSplitAtPlayhead(doc, null, Number.NaN)).toBe(false);
  });

  it('answers true inside a block', () => {
    expect(canSplitAtPlayhead(makeDoc(), null, 1)).toBe(true);
    expect(canSplitAtPlayhead(makeDoc(), null, 5)).toBe(true);
  });

  it('reads each trim side independently at a block edge', () => {
    const doc = makeDoc();
    // nothing to the left of the first frame; everything to its right
    expect(canTrimAtPlayhead(doc, null, 'left', 0)).toBe(false);
    expect(canTrimAtPlayhead(doc, null, 'right', 0)).toBe(true);
    expect(canTrimAtPlayhead(doc, null, 'left', 1)).toBe(true);
    expect(canTrimAtPlayhead(doc, null, 'right', 8)).toBe(false);
  });

  it('follows the selected audio clip instead of the base track', () => {
    const doc = makeDoc();
    const clip = { trackId: 'audio-1', blockIndex: 0 };
    // the clip sits at output 2 and lasts 3s, so its own start is an edge
    expect(canSplitAtPlayhead(doc, clip, 2)).toBe(false);
    expect(canSplitAtPlayhead(doc, clip, 3)).toBe(true);
  });

  it.each([
    ['audio-1', [1, 2, 5, 6]],
    ['layer-1', [0, 1, 3, 4]],
  ] as const)('disables both trims on and outside the edges of %s', (trackId, times) => {
    const doc = makeDoc();
    const selection = { trackId, blockIndex: 0 };
    for (const time of times) {
      for (const side of ['left', 'right'] as const) {
        expect(trimAtPlayhead(doc, selection, side, time)).toBeNull();
        expect(canTrimAtPlayhead(doc, selection, side, time)).toBe(false);
      }
    }
  });
});

describe('setBlockSpeed', () => {
  it('is a no-op on zero, negatives and non-finite values', () => {
    expect(setBlockSpeed(makeDoc(), 0, 0)).toBeNull();
    expect(setBlockSpeed(makeDoc(), 0, -1)).toBeNull();
    expect(setBlockSpeed(makeDoc(), 0, Number.NaN)).toBeNull();
  });

  it('clamps into the speed bounds, rounds to 2 decimals, and removes the field at 1', () => {
    const fast = setBlockSpeed(makeDoc(), 0, 9.999);
    expect(baseBlocks(fast ?? makeDoc())[0]).toEqual({ source: 'cam', in: 0, out: 4, speed: 2 });

    const natural = setBlockSpeed(fast ?? makeDoc(), 0, 1);
    expect(baseBlocks(natural ?? makeDoc())[0]).toEqual({ source: 'cam', in: 0, out: 4 });
  });
});

describe('reorderBaseBlock', () => {
  it('reports where the dragged block landed', () => {
    const reordered = reorderBaseBlock(makeDoc(), 0, 7.9);

    expect(reordered?.nextIndex).toBe(1);
    expect(baseBlocks(reordered?.doc ?? makeDoc())).toEqual([
      { source: 'cam', in: 5, out: 9 },
      { source: 'cam', in: 0, out: 4 },
    ]);
  });

  it('is a no-op when the drop keeps the order and on a missing index', () => {
    expect(reorderBaseBlock(makeDoc(), 0, 0)).toBeNull();
    expect(reorderBaseBlock(makeDoc(), 5, 0)).toBeNull();
  });
});

describe('moveTimedBlock', () => {
  it('moves audio and overlay blocks, clamping at zero and rounding', () => {
    const audio = moveTimedBlock(makeDoc(), 'audio-1', 0, -0.4);
    expect(audio?.tracks[1]).toEqual({
      id: 'audio-1',
      kind: 'audio',
      blocks: [{ source: 'voice', in: 1, out: 4, at: 0 }],
    });

    const overlay = moveTimedBlock(makeDoc(), 'overlays', 0, 3.333);
    expect(overlay?.tracks[2]).toEqual({
      id: 'overlays',
      kind: 'overlay',
      blocks: [{ file: 'edit/assets/logo.png', at: 3.33, duration: 2 }],
    });
  });

  it('is a no-op for the same position, a base block and a missing block', () => {
    expect(moveTimedBlock(makeDoc(), 'audio-1', 0, 2)).toBeNull();
    expect(moveTimedBlock(makeDoc(), 'base', 0, 3)).toBeNull();
    expect(moveTimedBlock(makeDoc(), 'overlays', 4, 3)).toBeNull();
  });
});

describe('resizeTimedBlock', () => {
  it('keeps the audio output end anchored when the in-edge is dragged', () => {
    const next = resizeTimedBlock(makeDoc(), 'audio-1', 0, 'in', 3);

    expect(next?.tracks[1]).toEqual({
      id: 'audio-1',
      kind: 'audio',
      blocks: [{ source: 'voice', in: 2, out: 4, at: 3 }],
    });
  });

  it('never shrinks an overlay below the minimum timed duration', () => {
    const next = resizeTimedBlock(makeDoc(), 'overlays', 0, 'out', 1.01);
    const overlays = next?.tracks[2];

    expect(overlays?.kind === 'overlay' ? overlays.blocks[0]?.duration : null).toBe(
      MIN_TIMED_BLOCK_S,
    );
  });

  it('is a no-op when the audio block would not change', () => {
    expect(resizeTimedBlock(makeDoc(), 'audio-1', 0, 'out', 5)).toBeNull();
  });
});

describe('appendToBase / insertIntoBase', () => {
  it('registers the new source with its rounded duration and appends a block', () => {
    const appended = appendToBase(makeDoc(), video, 'take2.mp4');

    expect(appended?.key).toBeDefined();
    expect(appended?.insertIndex).toBe(2);
    expect(appended?.doc.sources[appended.key]).toEqual({ path: 'take2.mp4', durationS: 3.46 });
    expect(baseBlocks(appended?.doc ?? makeDoc())[2]).toEqual({
      source: appended?.key,
      in: 0,
      out: 3.46,
    });
    expect(appended?.doc.tracks.slice(1)).toStrictEqual(makeDoc().tracks.slice(1));
  });

  it('reuses an existing source record instead of rewriting it', () => {
    const appended = appendToBase(makeDoc(), undefined, 'camera.mp4');
    expect(appended?.key).toBe('cam');
    expect(appended?.doc.sources).toStrictEqual(makeDoc().sources);
    expect(baseBlocks(appended?.doc ?? makeDoc())[2]).toEqual({ source: 'cam', in: 0, out: 5 });

    const inserted = insertIntoBase(makeDoc(), undefined, 'camera.mp4', 3);
    expect(inserted?.key).toBe('cam');
    expect(inserted?.doc.sources).toStrictEqual(makeDoc().sources);
    expect(baseBlocks(inserted?.doc ?? makeDoc())[1]).toEqual({ source: 'cam', in: 0, out: 5 });
  });

  it('inserts at the nearest cut boundary and reports the index', () => {
    const inserted = insertIntoBase(makeDoc(), video, 'take2.mp4', 3);

    expect(inserted?.insertIndex).toBe(1);
    expect(baseBlocks(inserted?.doc ?? makeDoc()).map((block) => block.out)).toEqual([4, 3.46, 9]);
    expect(inserted?.doc.tracks.slice(1)).toStrictEqual(makeDoc().tracks.slice(1));

    const unknown = insertIntoBase(makeDoc(), undefined, 'mystery.mp4', 3);
    expect(baseBlocks(unknown?.doc ?? makeDoc())[1]).toEqual({
      source: unknown?.key,
      in: 0,
      out: 5,
    });
    expect(unknown?.doc.sources[unknown.key]).toEqual({ path: 'mystery.mp4', durationS: 5 });
  });

  it('refuses still images', () => {
    expect(appendToBase(makeDoc(), image, 'still.png')).toBeNull();
    expect(insertIntoBase(makeDoc(), image, 'still.png', 0)).toBeNull();
  });
});

describe('trimSelectedEdge', () => {
  it('clamps a video in-edge so the block keeps at least 0.1 s', () => {
    const next = trimSelectedEdge(makeDoc(), { trackId: 'base', blockIndex: 0 }, 'in', 10);

    expect(baseBlocks(next ?? makeDoc())[0]).toEqual({ source: 'cam', in: 3.9, out: 4 });
  });

  it('caps an audio out-edge at the source duration', () => {
    const next = trimSelectedEdge(makeDoc(), { trackId: 'audio-1', blockIndex: 0 }, 'out', 10);

    expect(next?.tracks[1]).toEqual({
      id: 'audio-1',
      kind: 'audio',
      blocks: [{ source: 'voice', in: 1, out: 6, at: 2 }],
    });
  });

  it('is a no-op on a non-finite delta', () => {
    expect(
      trimSelectedEdge(makeDoc(), { trackId: 'base', blockIndex: 0 }, 'in', Number.NaN),
    ).toBeNull();
  });
});

describe('layer and effect branches', () => {
  it('trims a selected layer block in source time, moves its start, and keeps the extras', () => {
    const left = trimAtPlayhead(makeDoc(), LAYER_SELECTION, 'left', 1.5);
    expect(left?.clearsExtraSelections).toBe(false);
    expect(layerBlocks(left?.doc)).toEqual([{ ...LAYER, in: 0.5, at: 1.5 }]);

    const right = trimAtPlayhead(makeDoc(), LAYER_SELECTION, 'right', 2.5);
    expect(layerBlocks(right?.doc)).toEqual([{ ...LAYER, out: 1.5 }]);
  });

  it('splits a selected layer block and shifts the right half to the cut time', () => {
    const next = splitAtPlayhead(makeDoc(), LAYER_SELECTION, 2);

    expect(layerBlocks(next)).toEqual([
      { ...LAYER, out: 1 },
      { ...LAYER, in: 1, at: 2 },
    ]);
  });

  it('moves layer and effect blocks, rounding the output time', () => {
    expect(layerBlocks(moveTimedBlock(makeDoc(), 'layer-1', 0, 3.333))).toEqual([
      { ...LAYER, at: 3.33 },
    ]);
    expect(effectBlocks(moveTimedBlock(makeDoc(), 'fx', 0, 4))).toEqual([
      { type: 'flash', at: 4, duration: 0.3 },
    ]);
  });

  it('resizes an overlay from its in-edge keeping the end anchored, and clamps an effect to its bounds', () => {
    const overlay = resizeTimedBlock(makeDoc(), 'overlays', 0, 'in', 1.2)?.tracks[2];
    expect(overlay).toEqual({
      id: 'overlays',
      kind: 'overlay',
      blocks: [{ file: 'edit/assets/logo.png', at: 1.2, duration: 1.8 }],
    });

    const pinched = resizeTimedBlock(makeDoc(), 'overlays', 0, 'in', 2.99)?.tracks[2];
    expect(pinched).toEqual({
      id: 'overlays',
      kind: 'overlay',
      blocks: [{ file: 'edit/assets/logo.png', at: 2.8, duration: MIN_TIMED_BLOCK_S }],
    });

    expect(effectBlocks(resizeTimedBlock(makeDoc(), 'fx', 0, 'in', 0))).toEqual([
      { type: 'flash', at: 1.7, duration: 0.6 },
    ]);

    expect(effectBlocks(resizeTimedBlock(makeDoc(), 'fx', 0, 'out', 5))).toEqual([
      { type: 'flash', at: 2, duration: 0.6 },
    ]);
  });

  it('nudges a base block by shifting both source edges and a layer block by its output start', () => {
    const base = nudgeSelectedBlock(makeDoc(), { trackId: 'base', blockIndex: 0 }, 0.5);
    expect(baseBlocks(base ?? makeDoc())[0]).toEqual({ source: 'cam', in: 0.5, out: 4.5 });

    expect(layerBlocks(nudgeSelectedBlock(makeDoc(), LAYER_SELECTION, -5))).toEqual([
      { ...LAYER, at: 0 },
    ]);
  });
});

describe('setSelectedTransform', () => {
  const primary = { trackId: 'base', blockIndex: 0 } as const;

  it('clamps scale into [0.2, 4] and offsets into [-1, 1] on every bound', () => {
    const high = setSelectedTransform(makeDoc(), primary, { scale: 9, x: 3, y: 3 });
    expect(baseBlocks(high)[0]).toEqual({
      source: 'cam',
      in: 0,
      out: 4,
      transform: { scale: 4, x: 1, y: 1 },
    });

    const low = setSelectedTransform(makeDoc(), primary, { scale: 0.01, x: -3, y: -3 });
    expect(baseBlocks(low)[0]).toEqual({
      source: 'cam',
      in: 0,
      out: 4,
      transform: { scale: 0.2, x: -1, y: -1 },
    });
  });

  it('keeps the axes a partial patch does not mention', () => {
    const scaled = setSelectedTransform(makeDoc(), primary, { scale: 2, x: 0.5, y: -0.5 });
    const next = setSelectedTransform(scaled, primary, { x: -0.25 });

    expect(baseBlocks(next)[0]).toEqual({
      source: 'cam',
      in: 0,
      out: 4,
      transform: { scale: 2, x: -0.25, y: -0.5 },
    });
    expect(baseBlocks(setSelectedTransform(scaled, primary, { y: 0.1 }))[0]).toEqual({
      source: 'cam',
      in: 0,
      out: 4,
      transform: { scale: 2, x: 0.5, y: 0.1 },
    });
  });

  it('starts from the identity when the block has no transform yet', () => {
    expect(baseBlocks(setSelectedTransform(makeDoc(), primary, { y: 0.3 }))[0]).toEqual({
      source: 'cam',
      in: 0,
      out: 4,
      transform: { scale: 1, x: 0, y: 0.3 },
    });
  });

  it('removes the transform only when scale, x and y are ALL back at the identity', () => {
    const moved = setSelectedTransform(makeDoc(), primary, { scale: 2, x: 0.5, y: -0.5 });
    const identity = setSelectedTransform(moved, primary, { scale: 1, x: 0, y: 0 });
    expect(baseBlocks(identity)[0]).toEqual({ source: 'cam', in: 0, out: 4 });
  });

  it.each([
    { scale: 1, x: 0.3, y: 0 },
    { scale: 2, x: 0, y: 0 },
    { scale: 1, x: 0, y: 0.3 },
  ])('keeps a transform that is not the identity: %o', (kept) => {
    const moved = setSelectedTransform(makeDoc(), primary, { scale: 2, x: 0.5, y: -0.5 });
    const next = setSelectedTransform(moved, primary, kept);
    expect(baseBlocks(next)[0]).toEqual({ source: 'cam', in: 0, out: 4, transform: kept });
  });
});

describe('audio split, base trim drop and boundary clamps', () => {
  it('splits a selected audio block, stripping the fade that no longer sits at an edge', () => {
    const doc = makeDoc();
    const audio = doc.tracks[1];
    if (audio?.kind !== 'audio') throw new Error('fixture');
    audio.blocks = [{ source: 'voice', in: 1, out: 4, at: 2, fadeInS: 0.2, fadeOutS: 0.2 }];

    const next = splitAtPlayhead(doc, { trackId: 'audio-1', blockIndex: 0 }, 3);

    expect(next?.tracks[1]).toEqual({
      id: 'audio-1',
      kind: 'audio',
      blocks: [
        { source: 'voice', in: 1, out: 2, at: 2, fadeInS: 0.2 },
        { source: 'voice', in: 2, out: 4, at: 3, fadeOutS: 0.2 },
      ],
    });
    expect(splitAtPlayhead(doc, { trackId: 'audio-1', blockIndex: 0 }, 2)).toBeNull();
  });

  it('drops a base block whose trimmed duration falls under 0.1 s — that is why extras go stale', () => {
    const doc = makeDoc();
    const base = doc.tracks[0];
    if (base?.kind !== 'video') throw new Error('fixture');
    // 0.6 − 0.5 is 0.09999999999999998 in floating point: the minimum-duration
    // clamp alone does not keep the block, the trailing filter removes it.
    base.blocks = [
      { source: 'cam', in: 0, out: 0.6 },
      { source: 'cam', in: 5, out: 9 },
    ];

    const trimmed = trimAtPlayhead(doc, null, 'left', 0.55);

    expect(trimmed?.clearsExtraSelections).toBe(true);
    expect(baseBlocks(trimmed?.doc ?? doc)).toEqual([{ source: 'cam', in: 5, out: 9 }]);
  });

  it('keeps 0.1 s when a left trim on audio lands past the end and moves the start with it', () => {
    const trimmed = trimAtPlayhead(makeDoc(), { trackId: 'audio-1', blockIndex: 0 }, 'left', 4.95);

    expect(trimmed?.doc.tracks[1]).toEqual({
      id: 'audio-1',
      kind: 'audio',
      blocks: [{ source: 'voice', in: 3.9, out: 4, at: 4.9 }],
    });
  });

  it('refuses a layer trim exactly at the block edges', () => {
    expect(trimAtPlayhead(makeDoc(), LAYER_SELECTION, 'left', 1)).toBeNull();
    expect(trimAtPlayhead(makeDoc(), LAYER_SELECTION, 'right', 3)).toBeNull();
  });

  it('never pulls an audio in-edge before the source start nor its out-edge past the source end', () => {
    const early = resizeTimedBlock(makeDoc(), 'audio-1', 0, 'in', 0);
    expect(early?.tracks[1]).toEqual({
      id: 'audio-1',
      kind: 'audio',
      blocks: [{ source: 'voice', in: 0, out: 4, at: 1 }],
    });

    const late = resizeTimedBlock(makeDoc(), 'audio-1', 0, 'out', 100);
    expect(late?.tracks[1]).toEqual({
      id: 'audio-1',
      kind: 'audio',
      blocks: [{ source: 'voice', in: 1, out: 6, at: 2 }],
    });
  });

  it('treats an overlay without a duration as 2 s when resizing', () => {
    const doc = makeDoc();
    const overlays = doc.tracks[2];
    if (overlays?.kind !== 'overlay') throw new Error('fixture');
    overlays.blocks = [{ file: 'edit/assets/logo.png', at: 1 }];

    expect(resizeTimedBlock(doc, 'overlays', 0, 'in', 1.5)?.tracks[2]).toEqual({
      id: 'overlays',
      kind: 'overlay',
      blocks: [{ file: 'edit/assets/logo.png', at: 1.5, duration: 1.5 }],
    });
  });

  it('clamps a negative nudge and a negative in-edge trim at zero on the base track', () => {
    const nudged = nudgeSelectedBlock(makeDoc(), { trackId: 'base', blockIndex: 0 }, -1);
    expect(baseBlocks(nudged ?? makeDoc())[0]).toEqual({ source: 'cam', in: 0, out: 3 });

    const trimmed = trimSelectedEdge(makeDoc(), { trackId: 'base', blockIndex: 0 }, 'in', -1);
    expect(baseBlocks(trimmed ?? makeDoc())[0]).toEqual({ source: 'cam', in: 0, out: 4 });
  });

  it('inserts after a segment exactly when the drop reaches its midpoint', () => {
    expect(insertIntoBase(makeDoc(), video, 'take2.mp4', 2)?.insertIndex).toBe(1);
    expect(insertIntoBase(makeDoc(), video, 'take2.mp4', 1.99)?.insertIndex).toBe(0);
  });
});

describe('setBlockTransition, updateOverlayBlock, updateSelectedLayerBlock', () => {
  it('clamps a transition into [0.1, 1] s and removes it on undefined', () => {
    const long = setBlockTransition(makeDoc(), 1, { type: 'crossfade', durationS: 5 });
    expect(baseBlocks(long)[1]).toEqual({
      source: 'cam',
      in: 5,
      out: 9,
      transition: { type: 'crossfade', durationS: 1 },
    });

    const short = setBlockTransition(makeDoc(), 1, { type: 'fade-black', durationS: 0.01 });
    expect(baseBlocks(short)[1]).toEqual({
      source: 'cam',
      in: 5,
      out: 9,
      transition: { type: 'fade-black', durationS: 0.1 },
    });

    expect(baseBlocks(setBlockTransition(long, 1, undefined))[1]).toEqual({
      source: 'cam',
      in: 5,
      out: 9,
    });
  });

  it('clamps an overlay position into the 0–0.98 window and scale into [0.05, 1]', () => {
    const next = updateOverlayBlock(makeDoc(), 'overlays', 0, {
      position: { x: 2, y: -1 },
      scale: 7,
    });

    expect(next.tracks[2]).toStrictEqual({
      id: 'overlays',
      kind: 'overlay',
      blocks: [
        { file: 'edit/assets/logo.png', at: 1, duration: 2, position: { x: 0.98, y: 0 }, scale: 1 },
      ],
    });
    expect(
      updateOverlayBlock(makeDoc(), 'overlays', 0, { position: 'bottom-left' }).tracks[2],
    ).toStrictEqual({
      id: 'overlays',
      kind: 'overlay',
      blocks: [{ file: 'edit/assets/logo.png', at: 1, duration: 2, position: 'bottom-left' }],
    });
  });

  it('removes a layer block key when the patch value is undefined', () => {
    const next = updateSelectedLayerBlock(makeDoc(), LAYER_SELECTION, {
      scale: 0.5,
      mode: undefined,
    });

    expect(layerBlocks(next)).toStrictEqual([
      { source: 'cam', in: 0, out: 2, at: 1, audio: 'mute', scale: 0.5 },
    ]);
  });
});

describe('boundary cases the first pass missed', () => {
  function withBase(blocks: { source: string; in: number; out: number }[]): EditDoc {
    const doc = makeDoc();
    const base = doc.tracks[0];
    if (base?.kind !== 'video') throw new Error('fixture');
    base.blocks = blocks;
    return doc;
  }
  function withAudio(block: {
    source: string;
    in: number;
    out: number;
    at: number;
    fadeInS?: number;
    fadeOutS?: number;
  }): EditDoc {
    const doc = makeDoc();
    const audio = doc.tracks[1];
    if (audio?.kind !== 'audio') throw new Error('fixture');
    audio.blocks = [block];
    return doc;
  }
  const AUDIO = { trackId: 'audio-1', blockIndex: 0 } as const;
  const BASE = { trackId: 'base', blockIndex: 0 } as const;

  it('keeps a base block at exactly 0.1 s on a right trim and on a left trim near the end', () => {
    const right = trimAtPlayhead(
      withBase([
        { source: 'cam', in: 0, out: 0.6 },
        { source: 'cam', in: 5, out: 9 },
      ]),
      null,
      'right',
      0.1,
    );
    expect(baseBlocks(right?.doc ?? makeDoc())).toEqual([
      { source: 'cam', in: 0, out: 0.1 },
      { source: 'cam', in: 5, out: 9 },
    ]);

    const left = trimAtPlayhead(makeDoc(), null, 'left', 3.95);
    expect(baseBlocks(left?.doc ?? makeDoc())[0]).toEqual({ source: 'cam', in: 3.9, out: 4 });
  });

  it('refuses an audio split whose rounded cut lands on an edge', () => {
    expect(splitAtPlayhead(makeDoc(), AUDIO, 2.004)).toBeNull();
    expect(splitAtPlayhead(makeDoc(), AUDIO, 4.996)).toBeNull();
  });

  it('is a no-op when an audio out-edge drag cannot extend a block already at the source end', () => {
    const doc = withAudio({ source: 'voice', in: 1, out: 6, at: 2 });
    expect(resizeTimedBlock(doc, 'audio-1', 0, 'out', 100)).toBeNull();
  });

  it('nudges and edge-trims audio blocks in source and output time together', () => {
    expect(nudgeSelectedBlock(makeDoc(), AUDIO, -5)?.tracks[1]).toEqual({
      id: 'audio-1',
      kind: 'audio',
      blocks: [{ source: 'voice', in: 1, out: 4, at: 0 }],
    });
    const audioOf = (doc: EditDoc | null): unknown => {
      const track = doc?.tracks[1];
      return track?.kind === 'audio' ? track.blocks[0] : null;
    };
    expect(audioOf(trimSelectedEdge(makeDoc(), AUDIO, 'in', 0.5))).toEqual({
      source: 'voice',
      in: 1.5,
      out: 4,
      at: 2.5,
    });
    expect(audioOf(trimSelectedEdge(makeDoc(), AUDIO, 'in', -5))).toEqual({
      source: 'voice',
      in: 0,
      out: 4,
      at: 1,
    });
    expect(audioOf(trimSelectedEdge(makeDoc(), AUDIO, 'in', 10))).toEqual({
      source: 'voice',
      in: 3.9,
      out: 4,
      at: 4.9,
    });
    expect(audioOf(trimSelectedEdge(makeDoc(), AUDIO, 'out', -10))).toEqual({
      source: 'voice',
      in: 1,
      out: 1.1,
      at: 2,
    });
  });

  it('never inverts an audio block when an edge is dragged across the other one', () => {
    expect(resizeTimedBlock(makeDoc(), 'audio-1', 0, 'in', 10)?.tracks[1]).toEqual({
      id: 'audio-1',
      kind: 'audio',
      blocks: [{ source: 'voice', in: 3.8, out: 4, at: 4.8 }],
    });
    expect(resizeTimedBlock(makeDoc(), 'audio-1', 0, 'out', 0)?.tracks[1]).toEqual({
      id: 'audio-1',
      kind: 'audio',
      blocks: [{ source: 'voice', in: 1, out: 1.2, at: 2 }],
    });
  });

  it('keeps the 0.1 s minimum on every trim branch and refuses exact-edge audio trims', () => {
    expect(trimAtPlayhead(makeDoc(), AUDIO, 'left', 2)).toBeNull();
    expect(trimAtPlayhead(makeDoc(), AUDIO, 'right', 5)).toBeNull();
    expect(trimAtPlayhead(makeDoc(), AUDIO, 'right', 2.03)?.doc.tracks[1]).toEqual({
      id: 'audio-1',
      kind: 'audio',
      blocks: [{ source: 'voice', in: 1, out: 1.1, at: 2 }],
    });
    expect(layerBlocks(trimAtPlayhead(makeDoc(), LAYER_SELECTION, 'left', 2.95)?.doc)).toEqual([
      { ...LAYER, in: 1.9, at: 2.95 },
    ]);
    expect(layerBlocks(trimAtPlayhead(makeDoc(), LAYER_SELECTION, 'right', 1.05)?.doc)).toEqual([
      { ...LAYER, out: 0.1 },
    ]);
    expect(baseBlocks(trimSelectedEdge(makeDoc(), BASE, 'out', -10) ?? makeDoc())[0]).toEqual({
      source: 'cam',
      in: 0,
      out: 0.1,
    });
  });

  it('clamps speed, overlay geometry and insertion fallbacks at their lower bounds', () => {
    expect(baseBlocks(setBlockSpeed(makeDoc(), 0, 0.01) ?? makeDoc())[0]).toEqual({
      source: 'cam',
      in: 0,
      out: 4,
      speed: 0.5,
    });

    expect(
      updateOverlayBlock(makeDoc(), 'overlays', 0, { scale: 0.001, at: -1, duration: 0 }).tracks[2],
    ).toStrictEqual({
      id: 'overlays',
      kind: 'overlay',
      blocks: [{ file: 'edit/assets/logo.png', at: 0, duration: MIN_TIMED_BLOCK_S, scale: 0.05 }],
    });

    const bare = makeDoc();
    const overlays = bare.tracks[2];
    if (overlays?.kind !== 'overlay') throw new Error('fixture');
    overlays.blocks = [{ file: 'edit/assets/logo.png', at: 1 }];
    expect(updateOverlayBlock(bare, 'overlays', 0, {}).tracks[2]).toStrictEqual({
      id: 'overlays',
      kind: 'overlay',
      blocks: [{ file: 'edit/assets/logo.png', at: 1, duration: 2 }],
    });

    const unknown = appendToBase(makeDoc(), undefined, 'mystery.mp4');
    expect(baseBlocks(unknown?.doc ?? makeDoc())[2]).toEqual({
      source: unknown?.key,
      in: 0,
      out: 5,
    });
    expect(appendToBase(makeDoc(), { ...video, durationS: 0 }, 'take2.mp4')).toBeNull();
    expect(insertIntoBase(makeDoc(), video, 'take2.mp4', Number.NaN)?.insertIndex).toBe(2);
  });
});

describe('sources without a duration, fades under trims, and unsupported tracks', () => {
  const AUDIO = { trackId: 'audio-1', blockIndex: 0 } as const;
  function withVoice(
    block: { in: number; out: number; at: number; fadeInS?: number; fadeOutS?: number },
    durationS?: number,
  ): EditDoc {
    const doc = makeDoc();
    doc.sources.voice = { path: 'voice.wav', ...(durationS !== undefined ? { durationS } : {}) };
    const audio = doc.tracks[1];
    if (audio?.kind !== 'audio') throw new Error('fixture');
    audio.blocks = [{ source: 'voice', ...block }];
    return doc;
  }
  const audioBlock = (doc: EditDoc | null | undefined): unknown => {
    const track = doc?.tracks[1];
    return track?.kind === 'audio' ? track.blocks[0] : null;
  };

  it('lets an audio out-edge grow freely when the source duration is unknown', () => {
    const doc = withVoice({ in: 1, out: 4, at: 2 });
    expect(audioBlock(resizeTimedBlock(doc, 'audio-1', 0, 'out', 100))).toStrictEqual({
      source: 'voice',
      in: 1,
      out: 99,
      at: 2,
    });
    expect(audioBlock(trimSelectedEdge(doc, AUDIO, 'out', 10))).toStrictEqual({
      source: 'voice',
      in: 1,
      out: 14,
      at: 2,
    });
  });

  it('clamps fades to the shortened block on every audio trim path', () => {
    const faded = (): EditDoc =>
      withVoice({ in: 1, out: 4, at: 2, fadeInS: 1.5, fadeOutS: 1.5 }, 6);
    const head = { source: 'voice', in: 1, out: 1.5, at: 2, fadeInS: 0.5 };
    const tail = { source: 'voice', in: 3.5, out: 4, at: 4.5, fadeInS: 0.5 };

    expect(audioBlock(trimAtPlayhead(faded(), AUDIO, 'right', 2.5)?.doc)).toStrictEqual(head);
    expect(audioBlock(trimAtPlayhead(faded(), AUDIO, 'left', 4.5)?.doc)).toStrictEqual(tail);
    expect(audioBlock(resizeTimedBlock(faded(), 'audio-1', 0, 'out', 2.5))).toStrictEqual(head);
    expect(audioBlock(resizeTimedBlock(faded(), 'audio-1', 0, 'in', 4.5))).toStrictEqual(tail);
    expect(audioBlock(trimSelectedEdge(faded(), AUDIO, 'out', -2.5))).toStrictEqual(head);
    expect(audioBlock(trimSelectedEdge(faded(), AUDIO, 'in', 2.5))).toStrictEqual(tail);
  });

  it('will not shrink an audio block that is already under the minimum timed duration', () => {
    const tiny = withVoice({ in: 0, out: 0.1, at: 2 }, 6);
    expect(resizeTimedBlock(tiny, 'audio-1', 0, 'in', 2.05)).toBeNull();
    expect(resizeTimedBlock(tiny, 'audio-1', 0, 'out', 2.05)).toBeNull();
  });

  it('does not resize base or layer video blocks — those are edge trims, not timed resizes', () => {
    expect(resizeTimedBlock(makeDoc(), 'base', 0, 'out', 3)).toBeNull();
    expect(resizeTimedBlock(makeDoc(), 'layer-1', 0, 'in', 1.5)).toBeNull();
  });
});
