import { describe, expect, it } from 'vitest';
import type { CanvasConfig, EditDoc } from '../../../core/schema.js';
import type { MediaSummary } from '../../api.js';
import { DEFAULT_CANVAS_BACKGROUND_COLOR, DEFAULT_CANVAS_BASE_CELL } from '../docEdits.js';
import {
  ensureBackground,
  removeBackground,
  setBackgroundColor,
  setBackgroundFit,
  setBackgroundImage,
  setBackgroundVideo,
  setBackgroundVideoSource,
  setCanvasBaseCell,
  setCanvasBaseMode,
  setOutputSize,
  updateLayerCell,
} from './canvas.js';

function makeDoc(canvas?: CanvasConfig): EditDoc {
  return {
    version: 2,
    fps: 25,
    output: { width: 1080, height: 1920, loudnormLufs: -14 },
    sources: { cam: { path: 'camera.mp4', durationS: 10 }, loop: { path: 'loop.mp4' } },
    tracks: [
      { id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 4 }] },
      {
        id: 'layer-1',
        kind: 'video',
        blocks: [{ source: 'cam', in: 0, out: 2, at: 1, mode: 'pip', audio: 'mute' }],
      },
    ],
    subtitles: { enabled: false, preset: '2p-caps' },
    ...(canvas ? { canvas } : {}),
    totalDurationS: 4,
  };
}

const DEFAULT_CANVAS: CanvasConfig = {
  background: { kind: 'color', color: DEFAULT_CANVAS_BACKGROUND_COLOR },
  base: { mode: 'cell', cell: DEFAULT_CANVAS_BASE_CELL },
};
const VIDEO_BG: CanvasConfig = {
  background: { kind: 'video', source: 'loop', fit: 'cover', color: '#000000' },
  base: { mode: 'fill' },
};

const video: MediaSummary = {
  kind: 'video',
  relPath: 'loop.mp4',
  durationS: 12.5,
  fps: 25,
  width: 1080,
  height: 1920,
  hasAudio: false,
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

describe('ensureBackground / removeBackground', () => {
  it('creates the restrained default canvas once and refuses to overwrite an existing one', () => {
    expect(ensureBackground(makeDoc())?.canvas).toStrictEqual(DEFAULT_CANVAS);
    expect(ensureBackground(makeDoc(VIDEO_BG))).toBeNull();
  });

  it('removes the canvas key entirely and prunes a video background source nothing else uses', () => {
    const next = removeBackground(makeDoc(VIDEO_BG));

    expect(next).toStrictEqual({
      ...makeDoc(),
      sources: { cam: { path: 'camera.mp4', durationS: 10 } },
    });
    expect(removeBackground(makeDoc())).toBeNull();
  });

  it('keeps the previous background source when a track still references it', () => {
    const doc = makeDoc(VIDEO_BG);
    const base = doc.tracks[0];
    if (base?.kind !== 'video') throw new Error('fixture');
    base.blocks = [{ source: 'loop', in: 0, out: 1 }];

    expect(removeBackground(doc)?.sources).toStrictEqual(doc.sources);
  });
});

describe('background color, image and fit', () => {
  it('sets a color on the default canvas when there is none, and is a no-op on the same color', () => {
    const colored = setBackgroundColor(makeDoc(), '#ff0000');
    expect(colored?.canvas).toStrictEqual({
      ...DEFAULT_CANVAS,
      background: { kind: 'color', color: '#ff0000' },
    });
    expect(setBackgroundColor(colored ?? makeDoc(), '#ff0000')).toBeNull();
  });

  it('keeps the previous color as the letterbox fallback for an image, and omits it when there was none', () => {
    const fromColor = setBackgroundImage(makeDoc(), 'edit/assets/bg.png');
    expect(fromColor?.canvas?.background).toStrictEqual({
      kind: 'image',
      file: 'edit/assets/bg.png',
      fit: 'cover',
      color: DEFAULT_CANVAS_BACKGROUND_COLOR,
    });

    const colorless = makeDoc({
      background: { kind: 'image', file: 'a.png', fit: 'cover' },
      base: { mode: 'fill' },
    });
    expect(setBackgroundImage(colorless, 'b.png', 'contain')?.canvas?.background).toStrictEqual({
      kind: 'image',
      file: 'b.png',
      fit: 'contain',
    });
  });

  it('changes the fit of media backgrounds only', () => {
    expect(setBackgroundFit(makeDoc(VIDEO_BG), 'contain')?.canvas?.background).toStrictEqual({
      kind: 'video',
      source: 'loop',
      fit: 'contain',
      color: '#000000',
    });
    expect(setBackgroundFit(makeDoc(VIDEO_BG), 'cover')).toBeNull();
    expect(setBackgroundFit(makeDoc(DEFAULT_CANVAS), 'contain')).toBeNull();
    expect(setBackgroundFit(makeDoc(), 'contain')).toBeNull();
  });
});

describe('video backgrounds', () => {
  it('uses an already-registered video source and keeps the fallback color', () => {
    const next = setBackgroundVideoSource(makeDoc(DEFAULT_CANVAS), video, 'loop');

    expect(next?.canvas?.background).toStrictEqual({
      kind: 'video',
      source: 'loop',
      fit: 'cover',
      color: DEFAULT_CANVAS_BACKGROUND_COLOR,
    });
    expect(setBackgroundVideoSource(makeDoc(), video, 'nope')).toBeNull();
    expect(setBackgroundVideoSource(makeDoc(), image, 'loop')).toBeNull();
  });

  it('registers a new video path with its duration and makes it the background', () => {
    const next = setBackgroundVideo(makeDoc(), { ...video, relPath: 'sky.mp4' }, 'sky.mp4');
    const key = next?.canvas?.background.kind === 'video' ? next.canvas.background.source : null;

    expect(key).not.toBeNull();
    expect(next?.sources[key ?? '']).toStrictEqual({ path: 'sky.mp4', durationS: 12.5 });
    expect(next?.canvas?.base).toStrictEqual(DEFAULT_CANVAS.base);
  });

  it('refreshes the duration of an existing source only when the media is a known video', () => {
    const known = setBackgroundVideo(makeDoc(), video, 'loop.mp4');
    expect(known?.sources.loop).toStrictEqual({ path: 'loop.mp4', durationS: 12.5 });

    const unknown = setBackgroundVideo(makeDoc(), undefined, 'loop.mp4');
    expect(unknown?.sources.loop).toStrictEqual({ path: 'loop.mp4' });
  });

  it('refuses images, unknown unregistered paths, and an unchanged background', () => {
    expect(setBackgroundVideo(makeDoc(), image, 'still.png')).toBeNull();
    expect(setBackgroundVideo(makeDoc(), undefined, 'ghost.mp4')).toBeNull();
    const doc = makeDoc(VIDEO_BG);
    expect(setBackgroundVideo(doc, undefined, 'loop.mp4')).toBeNull();
  });

  it('prunes the previous video source when another one replaces it', () => {
    const next = setBackgroundVideo(makeDoc(VIDEO_BG), { ...video, relPath: 'sky.mp4' }, 'sky.mp4');

    expect(next?.sources.loop).toBeUndefined();
    expect(next?.sources.cam).toStrictEqual({ path: 'camera.mp4', durationS: 10 });
  });
});

describe('base window', () => {
  it('switches to fill and back to a cell, restoring the previous cell or the default', () => {
    const cell = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 };
    const doc = makeDoc({ ...DEFAULT_CANVAS, base: { mode: 'cell', cell } });

    const filled = setCanvasBaseMode(doc, 'fill');
    expect(filled?.canvas?.base).toStrictEqual({ mode: 'fill' });
    expect(setCanvasBaseMode(filled ?? doc, 'cell')?.canvas?.base).toStrictEqual({
      mode: 'cell',
      cell: DEFAULT_CANVAS_BASE_CELL,
    });
    expect(setCanvasBaseMode(doc, 'cell')).toBeNull();
  });

  it('clamps a base cell into the frame and refuses non-finite components', () => {
    const next = setCanvasBaseCell(makeDoc(), { x: 0.9, y: -1, w: 2, h: 0.01 });

    expect(next?.canvas?.base).toStrictEqual({ mode: 'cell', cell: { x: 0, y: 0, w: 1, h: 0.05 } });
    expect(setCanvasBaseCell(makeDoc(), { x: Number.NaN, y: 0, w: 0.5, h: 0.5 })).toBeNull();
  });

  it('sets the output size without touching other output fields', () => {
    expect(setOutputSize(makeDoc(), 1920, 1080).output).toStrictEqual({
      width: 1920,
      height: 1080,
      loudnormLufs: -14,
    });
  });
});

describe('updateLayerCell', () => {
  it('writes a clamped cell on a layer block and leaves base blocks alone', () => {
    const next = updateLayerCell(makeDoc(), 'layer-1', 0, { x: 0.5, y: 0.5, w: 0.75, h: 0.75 });
    const layer = next?.tracks[1];

    expect(layer?.kind === 'video' ? layer.blocks[0] : null).toStrictEqual({
      source: 'cam',
      in: 0,
      out: 2,
      at: 1,
      mode: 'pip',
      audio: 'mute',
      cell: { x: 0.25, y: 0.25, w: 0.75, h: 0.75 },
    });
    expect(
      updateLayerCell(makeDoc(), 'base', 0, { x: 0, y: 0, w: 1, h: 1 })?.tracks[0],
    ).toStrictEqual(makeDoc().tracks[0]);
    expect(
      updateLayerCell(makeDoc(), 'layer-1', 0, { x: 0, y: 0, w: Number.POSITIVE_INFINITY, h: 1 }),
    ).toBeNull();
  });
});
