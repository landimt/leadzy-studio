import { describe, expect, it } from 'vitest';
import type { EditDoc, EffectTrack } from '../../../core/schema.js';
import { MIN_TIMED_BLOCK_S } from '../../../core/timeline.js';
import {
  addEffect,
  addEffectBlock,
  addFlashEffect,
  addShakeEffect,
  addZoomEffect,
  updateEffectBlock,
} from './effects.js';

function makeDoc(effects?: EffectTrack): EditDoc {
  return {
    version: 2,
    fps: 25,
    output: { width: 1080, height: 1920, loudnormLufs: -14 },
    sources: { cam: { path: 'camera.mp4', durationS: 10 } },
    tracks: [
      { id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 4 }] },
      ...(effects ? [effects] : []),
      { id: 'overlays', kind: 'overlay', blocks: [{ file: 'edit/assets/logo.png', at: 1 }] },
    ],
    subtitles: { enabled: false, preset: '2p-caps' },
    totalDurationS: 4,
  };
}

const FX: EffectTrack = {
  id: 'fx',
  kind: 'effect',
  blocks: [{ type: 'flash', at: 2, duration: 0.3 }],
};

function effectBlocks(doc: EditDoc, id: string): readonly unknown[] {
  const track = doc.tracks.find((candidate) => candidate.id === id);
  return track?.kind === 'effect' ? track.blocks : [];
}

describe('addEffectBlock', () => {
  it('appends to the existing effect track and selects the new block', () => {
    const added = addEffectBlock(makeDoc(FX), {
      type: 'shake',
      at: 1,
      duration: 0.5,
      intensity: 3,
    });

    expect(added.selection).toEqual({ trackId: 'fx', blockIndex: 1 });
    expect(effectBlocks(added.doc, 'fx')).toStrictEqual([
      { type: 'flash', at: 2, duration: 0.3 },
      { type: 'shake', at: 1, duration: 0.5, intensity: 3 },
    ]);
  });

  it('creates the labelled `effects` track at the end of the rows when there is none', () => {
    const added = addEffectBlock(makeDoc(), { type: 'flash', at: 0, duration: 0.2 });

    expect(added.selection).toEqual({ trackId: 'effects', blockIndex: 0 });
    expect(added.doc.tracks.map((track) => track.id)).toEqual(['base', 'overlays', 'effects']);
    expect(added.doc.tracks[2]).toStrictEqual({
      id: 'effects',
      kind: 'effect',
      label: 'efeitos',
      blocks: [{ type: 'flash', at: 0, duration: 0.2 }],
    });
  });
});

describe('typed effect builders', () => {
  it("round the start and clamp the duration into each type's bounds", () => {
    expect(effectBlocks(addZoomEffect(makeDoc(), 1.006, 0.01, 1.5).doc, 'effects')).toStrictEqual([
      { type: 'zoom', at: 1.01, duration: MIN_TIMED_BLOCK_S, scale: 1.5 },
    ]);
    expect(effectBlocks(addZoomEffect(makeDoc(), 0, 99, 1.5).doc, 'effects')).toStrictEqual([
      { type: 'zoom', at: 0, duration: 99, scale: 1.5 },
    ]);
    expect(effectBlocks(addFlashEffect(makeDoc(), 2, 5).doc, 'effects')).toStrictEqual([
      { type: 'flash', at: 2, duration: 0.6 },
    ]);
    expect(effectBlocks(addFlashEffect(makeDoc(), 2, 0).doc, 'effects')).toStrictEqual([
      { type: 'flash', at: 2, duration: 0.08 },
    ]);
    expect(effectBlocks(addShakeEffect(makeDoc(), 2, 9).doc, 'effects')).toStrictEqual([
      { type: 'shake', at: 2, duration: 1.5, intensity: 5 },
    ]);
    expect(effectBlocks(addShakeEffect(makeDoc(), 2, 0.001, 8).doc, 'effects')).toStrictEqual([
      { type: 'shake', at: 2, duration: 0.15, intensity: 8 },
    ]);
  });

  it('addEffect applies the same normalisation to a catalog block', () => {
    const added = addEffect(makeDoc(), { type: 'flash', at: 3.333, duration: 4 });

    expect(effectBlocks(added.doc, 'effects')).toStrictEqual([
      { type: 'flash', at: 3.33, duration: 0.6 },
    ]);
  });
});

describe('updateEffectBlock', () => {
  const doc = makeDoc({
    id: 'fx',
    kind: 'effect',
    blocks: [
      { type: 'zoom', at: 1, duration: 1, scale: 1.2 },
      { type: 'flash', at: 2, duration: 0.3 },
      { type: 'shake', at: 3, duration: 0.5 },
    ],
  });

  it('clamps every zoom field, keeping unpatched ones', () => {
    expect(
      effectBlocks(updateEffectBlock(doc, 'fx', 0, { at: -1, scale: 9 }), 'fx')[0],
    ).toStrictEqual({
      type: 'zoom',
      at: 0,
      duration: 1,
      scale: 2,
    });
    expect(
      effectBlocks(updateEffectBlock(doc, 'fx', 0, { duration: 0.01, scale: 0.5 }), 'fx')[0],
    ).toStrictEqual({
      type: 'zoom',
      at: 1,
      duration: MIN_TIMED_BLOCK_S,
      scale: 1.01,
    });
  });

  it('clamps a flash duration into [0.08, 0.6] and rounds the start', () => {
    expect(
      effectBlocks(updateEffectBlock(doc, 'fx', 1, { at: 2.555, duration: 9 }), 'fx')[1],
    ).toStrictEqual({
      type: 'flash',
      at: 2.56,
      duration: 0.6,
    });
    expect(effectBlocks(updateEffectBlock(doc, 'fx', 1, { duration: 0 }), 'fx')[1]).toStrictEqual({
      type: 'flash',
      at: 2,
      duration: 0.08,
    });
  });

  it('clamps shake duration and intensity, defaulting a missing intensity to 5', () => {
    expect(
      effectBlocks(updateEffectBlock(doc, 'fx', 2, { duration: 9, intensity: 99 }), 'fx')[2],
    ).toStrictEqual({
      type: 'shake',
      at: 3,
      duration: 1.5,
      intensity: 10,
    });
    expect(
      effectBlocks(updateEffectBlock(doc, 'fx', 2, { duration: 0, intensity: 0.4 }), 'fx')[2],
    ).toStrictEqual({
      type: 'shake',
      at: 3,
      duration: 0.15,
      intensity: 1,
    });
    expect(effectBlocks(updateEffectBlock(doc, 'fx', 2, {}), 'fx')[2]).toStrictEqual({
      type: 'shake',
      at: 3,
      duration: 0.5,
      intensity: 5,
    });
  });

  it('leaves other blocks, other tracks and unknown targets untouched', () => {
    const next = updateEffectBlock(doc, 'fx', 0, { at: 5 });
    expect(effectBlocks(next, 'fx').slice(1)).toStrictEqual(effectBlocks(doc, 'fx').slice(1));
    expect(next.tracks[0]).toStrictEqual(doc.tracks[0]);
    expect(updateEffectBlock(doc, 'overlays', 0, { at: 5 }).tracks).toStrictEqual(doc.tracks);
    expect(updateEffectBlock(doc, 'fx', 9, { at: 5 }).tracks).toStrictEqual(doc.tracks);
  });
});
