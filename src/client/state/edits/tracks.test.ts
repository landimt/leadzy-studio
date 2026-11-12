import { describe, expect, it } from 'vitest';
import type { EditDoc } from '../../../core/schema.js';
import type { MediaSummary } from '../../api.js';
import {
  addAudioClip,
  addEmptyTrack,
  addLayer,
  addOverlayImage,
  removeTrack,
  reorderTrack,
  setTrackHidden,
  setTrackMuted,
} from './tracks.js';

const NONE: ReadonlySet<string> = new Set();

function makeDoc(): EditDoc {
  return {
    version: 2,
    fps: 25,
    output: { width: 1080, height: 1920, loudnormLufs: -14 },
    sources: { cam: { path: 'camera.mp4', durationS: 10 } },
    tracks: [
      { id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 4 }] },
      { id: 'layer-1', kind: 'video', blocks: [] },
      {
        id: 'layer-2',
        kind: 'video',
        blocks: [{ source: 'cam', in: 0, out: 2, at: 1, mode: 'pip', audio: 'mute' }],
      },
      { id: 'audio-1', kind: 'audio', blocks: [] },
      { id: 'audio-2', kind: 'audio', blocks: [{ source: 'cam', in: 0, out: 3, at: 1 }] },
      { id: 'fx', kind: 'effect', blocks: [] },
      { id: 'overlays', kind: 'overlay', blocks: [{ file: 'edit/assets/logo.png', at: 1 }] },
    ],
    subtitles: { enabled: false, preset: '2p-caps' },
    totalDurationS: 4,
  };
}

const ids = (doc: EditDoc | null | undefined): string[] => doc?.tracks.map((t) => t.id) ?? [];

const video: MediaSummary = {
  kind: 'video',
  relPath: 'take2.mp4',
  durationS: 7.777,
  fps: 25,
  width: 1080,
  height: 1920,
  hasAudio: true,
  transcriptEngine: null,
  proxyRelPath: null,
};
const silentVideo: MediaSummary = { ...video, relPath: 'silent.mp4', hasAudio: false };
const music: MediaSummary = {
  kind: 'audio',
  relPath: 'music.wav',
  durationS: 30,
  hasAudio: true,
  transcriptEngine: null,
  proxyRelPath: null,
};
const image: MediaSummary = {
  kind: 'image',
  relPath: 'still.png',
  width: 10,
  height: 10,
  hasAudio: false,
  transcriptEngine: null,
  proxyRelPath: null,
};

describe('addEmptyTrack', () => {
  it('inserts an empty row at its kind boundary with the next free id', () => {
    const layer = addEmptyTrack(makeDoc(), 'video');
    expect(layer.trackId).toBe('layer-3');
    expect(ids(layer.doc)).toEqual([
      'base',
      'layer-1',
      'layer-2',
      'layer-3',
      'audio-1',
      'audio-2',
      'fx',
      'overlays',
    ]);

    const effect = addEmptyTrack(makeDoc(), 'effect');
    expect(effect.trackId).toBe('effect-1');
    expect(ids(effect.doc)).toEqual([
      'base',
      'layer-1',
      'layer-2',
      'audio-1',
      'audio-2',
      'fx',
      'effect-1',
      'overlays',
    ]);
  });
});

describe('reorderTrack', () => {
  it('moves a row among its kind and leaves other kinds in their slots', () => {
    const next = reorderTrack(makeDoc(), NONE, 'audio-2', 'audio-1');
    expect(ids(next)).toEqual([
      'base',
      'layer-1',
      'layer-2',
      'audio-2',
      'audio-1',
      'fx',
      'overlays',
    ]);
  });

  it('refuses the base line, cross-kind, unknown, same-target and locked-span moves', () => {
    expect(reorderTrack(makeDoc(), NONE, 'base', 'layer-1')).toBeNull();
    expect(reorderTrack(makeDoc(), NONE, 'layer-2', 'base')).toBeNull();
    expect(reorderTrack(makeDoc(), NONE, 'layer-1', 'audio-1')).toBeNull();
    expect(reorderTrack(makeDoc(), NONE, 'nope', 'audio-1')).toBeNull();
    expect(reorderTrack(makeDoc(), NONE, 'audio-1', 'audio-1')).toBeNull();
    expect(reorderTrack(makeDoc(), new Set(['audio-1']), 'audio-2', 'audio-1')).toBeNull();
    expect(reorderTrack(makeDoc(), new Set(['fx']), 'audio-2', 'audio-1')).not.toBeNull();
  });
});

describe('addAudioClip', () => {
  it('fills the first empty unlocked audio row, registers the source and selects the clip', () => {
    const added = addAudioClip(makeDoc(), NONE, music, 'music.wav', 2.345);

    expect(added?.selection).toEqual({ trackId: 'audio-1', blockIndex: 0 });
    expect(added?.doc.sources[added.key]).toStrictEqual({ path: 'music.wav', durationS: 30 });
    expect(added?.doc.tracks[3]).toStrictEqual({
      id: 'audio-1',
      kind: 'audio',
      blocks: [{ source: added?.key, in: 0, out: 30, at: 2.35 }],
    });
  });

  it('creates a labelled audio row after the existing ones when none is empty', () => {
    const doc = makeDoc();
    const added = addAudioClip(doc, new Set(['audio-1']), music, 'music.wav', -3);

    expect(added?.selection).toEqual({ trackId: 'audio-3', blockIndex: 0 });
    expect(ids(added?.doc)).toEqual([
      'base',
      'layer-1',
      'layer-2',
      'audio-1',
      'audio-2',
      'audio-3',
      'fx',
      'overlays',
    ]);
    expect(added?.doc.tracks[5]).toStrictEqual({
      id: 'audio-3',
      kind: 'audio',
      label: added?.key,
      blocks: [{ source: added?.key, in: 0, out: 30, at: 0 }],
    });
  });

  it('appends to the requested row and refreshes the duration of an existing source', () => {
    const doc = makeDoc();
    doc.sources.cam = { path: 'camera.mp4', durationS: 10, role: 'camera' };
    const added = addAudioClip(doc, NONE, video, 'camera.mp4', 1, 'audio-2');

    expect(added?.key).toBe('cam');
    expect(added?.selection).toEqual({ trackId: 'audio-2', blockIndex: 1 });
    expect(added?.doc.sources.cam).toStrictEqual({
      path: 'camera.mp4',
      role: 'camera',
      durationS: 7.777,
    });
  });

  it('refuses images, silent video, missing media, unknown or locked target rows and non-finite times', () => {
    expect(addAudioClip(makeDoc(), NONE, image, 'still.png', 0)).toBeNull();
    expect(addAudioClip(makeDoc(), NONE, silentVideo, 'silent.mp4', 0)).toBeNull();
    expect(addAudioClip(makeDoc(), NONE, undefined, 'ghost.wav', 0)).toBeNull();
    expect(addAudioClip(makeDoc(), NONE, { ...music, durationS: 0 }, 'music.wav', 0)).toBeNull();
    expect(addAudioClip(makeDoc(), NONE, music, 'music.wav', 0, 'nope')).toBeNull();
    expect(addAudioClip(makeDoc(), NONE, music, 'music.wav', 0, 'layer-1')).toBeNull();
    expect(
      addAudioClip(makeDoc(), new Set(['audio-1']), music, 'music.wav', 0, 'audio-1'),
    ).toBeNull();
    expect(addAudioClip(makeDoc(), NONE, music, 'music.wav', Number.NaN)).toBeNull();
  });
});

describe('addLayer', () => {
  it('fills the first empty unlocked layer with a five-second PiP and registers the rounded source', () => {
    const added = addLayer(makeDoc(), NONE, video, 'take2.mp4', 1.006);

    expect(added?.selection).toEqual({ trackId: 'layer-1', blockIndex: 0 });
    expect(added?.doc.sources[added.key]).toStrictEqual({ path: 'take2.mp4', durationS: 7.78 });
    expect(added?.doc.tracks[1]).toStrictEqual({
      id: 'layer-1',
      kind: 'video',
      blocks: [
        {
          source: added?.key,
          in: 0,
          out: 5,
          at: 1.01,
          mode: 'pip',
          position: 'bottom-left',
          scale: 0.34,
          audio: 'mute',
        },
      ],
    });
  });

  it('creates a labelled layer after the video rows when none is empty, without touching an existing source', () => {
    const added = addLayer(makeDoc(), new Set(['layer-1']), undefined, 'camera.mp4', 0);

    expect(added?.key).toBe('cam');
    expect(added?.doc.sources).toStrictEqual(makeDoc().sources);
    expect(ids(added?.doc)).toEqual([
      'base',
      'layer-1',
      'layer-2',
      'layer-3',
      'audio-1',
      'audio-2',
      'fx',
      'overlays',
    ]);
    expect(added?.selection).toEqual({ trackId: 'layer-3', blockIndex: 0 });
  });

  it('appends to the requested layer and uses the default five seconds for unknown media', () => {
    const added = addLayer(makeDoc(), NONE, undefined, 'mystery.mp4', 2, 'layer-2');
    const layer = added?.doc.tracks[2];

    expect(added?.selection).toEqual({ trackId: 'layer-2', blockIndex: 1 });
    expect(layer?.kind === 'video' ? layer.blocks[1]?.out : null).toBe(5);
    expect(added?.doc.sources[added.key]).toStrictEqual({ path: 'mystery.mp4', durationS: 5 });
  });

  it('never treats an empty base line as a free layer row', () => {
    const doc = makeDoc();
    const base = doc.tracks[0];
    if (base?.kind !== 'video') throw new Error('fixture');
    base.blocks = [];

    const added = addLayer(doc, new Set(['layer-1']), video, 'take2.mp4', 0);

    expect(added?.selection).toEqual({ trackId: 'layer-3', blockIndex: 0 });
    expect(added?.doc.tracks[0]).toStrictEqual({ id: 'base', kind: 'video', blocks: [] });
  });

  it('keeps a short clip at its own length instead of the five-second default', () => {
    const added = addLayer(makeDoc(), NONE, { ...video, durationS: 3.333 }, 'take2.mp4', 0);
    const layer = added?.doc.tracks[1];

    expect(layer?.kind === 'video' ? layer.blocks[0]?.out : null).toBe(3.33);
    expect(added?.doc.sources[added.key]).toStrictEqual({ path: 'take2.mp4', durationS: 3.33 });
  });

  it('refuses still images, the base as target, unknown or locked targets, zero durations and non-finite times', () => {
    expect(addLayer(makeDoc(), NONE, image, 'still.png', 0)).toBeNull();
    expect(addLayer(makeDoc(), NONE, video, 'take2.mp4', 0, 'base')).toBeNull();
    expect(addLayer(makeDoc(), NONE, video, 'take2.mp4', 0, 'nope')).toBeNull();
    expect(addLayer(makeDoc(), new Set(['layer-2']), video, 'take2.mp4', 0, 'layer-2')).toBeNull();
    expect(addLayer(makeDoc(), NONE, { ...video, durationS: 0 }, 'take2.mp4', 0)).toBeNull();
    expect(addLayer(makeDoc(), NONE, video, 'take2.mp4', Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('removeTrack', () => {
  it('removes a row and refuses the base line, locked rows and unknown ids', () => {
    expect(ids(removeTrack(makeDoc(), NONE, 'audio-2'))).toEqual([
      'base',
      'layer-1',
      'layer-2',
      'audio-1',
      'fx',
      'overlays',
    ]);
    expect(removeTrack(makeDoc(), NONE, 'base')).toBeNull();
    expect(removeTrack(makeDoc(), new Set(['audio-2']), 'audio-2')).toBeNull();
    expect(removeTrack(makeDoc(), NONE, 'nope')).toBeNull();
  });
});

describe('setTrackHidden / setTrackMuted', () => {
  it('adds and removes the persisted hidden flag on visual rows only', () => {
    const hidden = setTrackHidden(makeDoc(), 'layer-1', true);
    expect(hidden?.tracks[1]).toStrictEqual({
      id: 'layer-1',
      kind: 'video',
      blocks: [],
      hidden: true,
    });
    expect(setTrackHidden(hidden ?? makeDoc(), 'layer-1', false)?.tracks[1]).toStrictEqual({
      id: 'layer-1',
      kind: 'video',
      blocks: [],
    });
    expect(setTrackHidden(makeDoc(), 'base', true)).toBeNull();
    expect(setTrackHidden(makeDoc(), 'audio-1', true)).toBeNull();
    expect(setTrackHidden(makeDoc(), 'nope', true)).toBeNull();
  });

  it('adds and removes the persisted mute on video and audio rows, and is a no-op when already there', () => {
    const muted = setTrackMuted(makeDoc(), 'audio-2', true);
    expect(muted?.tracks[4]).toStrictEqual({
      id: 'audio-2',
      kind: 'audio',
      blocks: [{ source: 'cam', in: 0, out: 3, at: 1 }],
      muted: true,
    });
    expect(setTrackMuted(muted ?? makeDoc(), 'audio-2', true)).toBeNull();
    expect(setTrackMuted(muted ?? makeDoc(), 'audio-2', false)?.tracks[4]).toStrictEqual(
      makeDoc().tracks[4],
    );
    expect(setTrackMuted(makeDoc(), 'audio-2', false)).toBeNull();
    expect(setTrackMuted(makeDoc(), 'layer-2', true)?.tracks[2]).toMatchObject({
      id: 'layer-2',
      muted: true,
    });
    expect(setTrackMuted(makeDoc(), 'fx', true)).toBeNull();
    expect(setTrackMuted(makeDoc(), 'overlays', true)).toBeNull();
  });
});

describe('addOverlayImage', () => {
  it('appends to the first overlay row, or creates `overlays` at the end', () => {
    const appended = addOverlayImage(makeDoc(), 'edit/assets/cta.png', 2.005);
    expect(appended.tracks[6]).toStrictEqual({
      id: 'overlays',
      kind: 'overlay',
      blocks: [
        { file: 'edit/assets/logo.png', at: 1 },
        { file: 'edit/assets/cta.png', at: 2.01, duration: 4, position: 'bottom-left', scale: 0.5 },
      ],
    });

    const bare = makeDoc();
    bare.tracks = bare.tracks.filter((track) => track.kind !== 'overlay');
    const created = addOverlayImage(bare, 'edit/assets/cta.png', 0);
    expect(ids(created)).toEqual([
      'base',
      'layer-1',
      'layer-2',
      'audio-1',
      'audio-2',
      'fx',
      'overlays',
    ]);
  });
});
