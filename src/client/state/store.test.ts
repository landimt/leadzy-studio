import { afterEach, describe, expect, it, vi } from 'vitest';
import { baseTrackOf, type EditDoc } from '../../core/schema.js';
import { audioPreviewSemanticKey } from '../../core/audioPreviewFreshness.js';
import { programKey } from '../../core/render/freshness.js';
import type { Transcript } from '../../core/transcript.js';
import { ApiError, type MediaSummary, type ProjectInfo, type ServerEvent } from '../api.js';
import { EditorStore } from './store.js';
import { type StoreBackend } from './storeState.js';
import {
  BACKGROUND_EDITOR_TRACK_KEY,
  DEFAULT_CANVAS_BACKGROUND_COLOR,
  DEFAULT_CANVAS_BASE_CELL,
  SUBTITLE_EDITOR_TRACK_KEY,
} from './docEdits.js';
import { playhead } from './playhead.js';

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
        { source: 'cam', in: 0, out: 4 },
        { source: 'cam', in: 6, out: 9 },
      ],
    },
  ],
  subtitles: { enabled: true, preset: 'pill' },
  totalDurationS: 7,
};

/** Two tracks, several blocks each — enough surface for range-select and cross-track batch delete. */
const multiDoc: EditDoc = {
  version: 2,
  fps: 25,
  output: { width: 1080, height: 1920, loudnormLufs: -14 },
  sources: { cam: { path: 'camera.mp4' } },
  tracks: [
    {
      id: 'base',
      kind: 'video',
      blocks: [
        { source: 'cam', in: 0, out: 2 },
        { source: 'cam', in: 2, out: 4 },
        { source: 'cam', in: 4, out: 6 },
        { source: 'cam', in: 6, out: 8 },
      ],
    },
    {
      id: 'overlays',
      kind: 'overlay',
      blocks: [
        { file: 'logo.png', at: 0, duration: 2 },
        { file: 'logo2.png', at: 3, duration: 2 },
      ],
    },
  ],
  subtitles: { enabled: true, preset: 'pill' },
  totalDurationS: 8,
};

/** One track per kind — the base video track plus a layer video, an overlay and an effect track. */
const trackKindsDoc: EditDoc = {
  version: 2,
  fps: 25,
  output: { width: 1080, height: 1920, loudnormLufs: -14 },
  sources: { cam: { path: 'camera.mp4' }, pip: { path: 'pip.mp4' } },
  tracks: [
    { id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 4 }] },
    {
      id: 'layer-1',
      kind: 'video',
      blocks: [
        {
          source: 'pip',
          in: 0,
          out: 2,
          at: 0,
          mode: 'pip',
          position: 'bottom-left',
          scale: 0.34,
          audio: 'mute',
        },
      ],
    },
    { id: 'overlays', kind: 'overlay', blocks: [{ file: 'logo.png', at: 0, duration: 2 }] },
    {
      id: 'effects',
      kind: 'effect',
      blocks: [{ type: 'zoom', at: 0, duration: 1, scale: 1.1 }],
    },
  ],
  subtitles: { enabled: true, preset: 'pill' },
  totalDurationS: 4,
};

const audioDoc: EditDoc = {
  version: 2,
  fps: 25,
  output: { width: 1080, height: 1920, loudnormLufs: -14 },
  sources: {
    cam: { path: 'camera.mp4', durationS: 4 },
    music: { path: 'music.wav', durationS: 8 },
  },
  tracks: [
    { id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 4 }] },
    {
      id: 'audio-1',
      kind: 'audio',
      blocks: [{ source: 'music', in: 1, out: 5, at: 2 }],
    },
    { id: 'audio-2', kind: 'audio', blocks: [] },
    { id: 'overlays', kind: 'overlay', blocks: [] },
  ],
  subtitles: { enabled: true, preset: 'pill' },
  totalDurationS: 4,
};

const mixedTrackOrderDoc: EditDoc = {
  version: 2,
  fps: 25,
  output: { width: 1080, height: 1920, loudnormLufs: -14 },
  sources: { cam: { path: 'camera.mp4' } },
  tracks: [
    { id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 4 }] },
    { id: 'layer-1', kind: 'video', blocks: [] },
    { id: 'audio-1', kind: 'audio', blocks: [] },
    { id: 'layer-2', kind: 'video', blocks: [] },
    { id: 'overlays', kind: 'overlay', blocks: [] },
    { id: 'audio-2', kind: 'audio', blocks: [] },
    { id: 'effects', kind: 'effect', blocks: [] },
  ],
  subtitles: { enabled: true, preset: 'pill' },
  totalDurationS: 4,
};

const audioMedia: MediaSummary = {
  kind: 'audio',
  relPath: 'music.wav',
  durationS: 8,
  hasAudio: true,
  transcriptEngine: null,
  proxyRelPath: null,
};

const backgroundVideoMedia: MediaSummary = {
  kind: 'video',
  relPath: 'background-loop.mp4',
  durationS: 12,
  fps: 25,
  width: 1080,
  height: 1920,
  hasAudio: false,
  transcriptEngine: null,
  proxyRelPath: null,
};

const alternateBackgroundVideoMedia: MediaSummary = {
  ...backgroundVideoMedia,
  relPath: 'alternate-background.mp4',
  durationS: 9,
};

const imageMedia: MediaSummary = {
  kind: 'image',
  relPath: 'background.jpg',
  width: 1080,
  height: 1920,
  hasAudio: false,
  transcriptEngine: null,
  proxyRelPath: null,
};

function projectWith(document: EditDoc): ProjectInfo {
  return {
    projectDir: '/tmp/fake',
    media: [],
    images: [],
    doc: document,
    editHash: 'hash-0',
    previewEditHash: null,
    audioPreviewEditHash: null,
    audioPreviewCurrent: false,
    warnings: [],
    apiKeyPresent: false,
    ffmpeg: { ok: true, message: '' },
    hasPreview: false,
    hasAudioPreview: false,
    hasAudioComparison: false,
    hasFinal: false,
    hasProgram: false,
    programKey: null,
    agents: { claude: false, codex: false },
  };
}

interface Harness {
  readonly store: EditorStore;
  readonly putEdit: ReturnType<typeof vi.fn>;
  readonly startAudioPreview: ReturnType<typeof vi.fn>;
  readonly getProject: ReturnType<typeof vi.fn>;
  readonly emit: (event: ServerEvent) => void;
}

async function makeStore(overrides: Partial<StoreBackend> = {}): Promise<Harness> {
  let deliver: (event: ServerEvent) => void = () => undefined;
  const getProject = vi.fn(() => Promise.resolve(projectWith(doc)));
  const putEdit = vi.fn(() => Promise.resolve({ hash: 'hash-1' }));
  const startAudioPreview = vi.fn(() => Promise.resolve({ id: 17 }));
  const backend: StoreBackend = {
    getProject,
    putEdit,
    getTranscript: () => Promise.resolve(null),
    getPeaks: () => Promise.reject(new Error('sem peaks no teste')),
    startAudioPreview,
    subscribe: (onEvent) => {
      deliver = onEvent;
      return () => undefined;
    },
    ...overrides,
  };
  const editorStore = new EditorStore(backend);
  await editorStore.init();
  return {
    store: editorStore,
    putEdit,
    startAudioPreview,
    getProject,
    emit: (event) => {
      deliver(event);
    },
  };
}

describe('EditorStore initialization', () => {
  it('is idempotent and subscribes before slow derived media finishes loading', async () => {
    let finishPeaks: () => void = () => undefined;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const backend: StoreBackend = {
      getProject: () => Promise.resolve(projectWith(doc)),
      putEdit: () => Promise.resolve({ hash: 'hash-1' }),
      getTranscript: () => Promise.resolve(null),
      getPeaks: () =>
        new Promise((_, reject) => {
          finishPeaks = () => {
            reject(new Error('derived data finished'));
          };
        }),
      startAudioPreview: () => Promise.resolve({ id: 17 }),
      subscribe,
    };
    const editorStore = new EditorStore(backend);

    const first = editorStore.init();
    const second = editorStore.init();
    expect(second).toBe(first);
    await vi.waitFor(() => {
      expect(subscribe).toHaveBeenCalledTimes(1);
    });

    finishPeaks();
    await first;
    editorStore.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('allows StartupScreen to retry after the initial project request fails', async () => {
    const getProject = vi
      .fn<() => Promise<ProjectInfo>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(projectWith(doc));
    const subscribe = vi.fn(() => () => undefined);
    const editorStore = new EditorStore({
      getProject,
      putEdit: () => Promise.resolve({ hash: 'hash-1' }),
      getTranscript: () => Promise.resolve(null),
      getPeaks: () => Promise.reject(new Error('sem peaks')),
      startAudioPreview: () => Promise.resolve({ id: 17 }),
      subscribe,
    });

    await editorStore.init();
    expect(editorStore.getState().doc).toBeNull();
    await editorStore.init();

    expect(getProject).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(editorStore.getState().doc).toEqual(doc);
  });

  it('hydrates only sources with an audible/editorial contract, skipping silent canvas-only video', async () => {
    const derivedDoc: EditDoc = {
      ...doc,
      output: {
        ...doc.output,
        denoiseSample: { source: 'room', start: 0, end: 0.5 },
      },
      sources: {
        cam: { path: 'camera.mp4' },
        pip: { path: 'pip.mp4' },
        music: { path: 'music.wav' },
        room: { path: 'room.wav', durationS: 2 },
        caption: { path: 'caption.mp4' },
        suggested: { path: 'suggested.mp4' },
        background: { path: 'background-loop.mp4' },
        orphan: { path: 'unused.mp4' },
      },
      canvas: {
        background: { kind: 'video', source: 'background', fit: 'cover' },
        base: { mode: 'cell', cell: DEFAULT_CANVAS_BASE_CELL },
      },
      tracks: [
        { id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 4 }] },
        {
          id: 'layer-1',
          kind: 'video',
          blocks: [
            {
              source: 'pip',
              in: 0,
              out: 2,
              at: 0,
              mode: 'pip',
              position: 'bottom-left',
              scale: 0.34,
            },
          ],
        },
        {
          id: 'audio-1',
          kind: 'audio',
          blocks: [{ source: 'music', in: 0, out: 2, at: 0 }],
        },
      ],
      subtitles: {
        ...doc.subtitles,
        hiddenRanges: [{ source: 'caption', start: 0, end: 1 }],
      },
      suggestions: [
        {
          id: 'suggestion-1',
          type: 'silence',
          source: 'suggested',
          start: 0,
          end: 1,
          reason: 'quiet',
        },
      ],
    };
    const getTranscript = vi.fn((_path: string) => Promise.resolve(null));
    const getPeaks = vi.fn((_path: string) => Promise.reject(new Error('sem peaks')));

    await makeStore({
      getProject: () => Promise.resolve(projectWith(derivedDoc)),
      getTranscript,
      getPeaks,
    });

    const transcriptPaths = getTranscript.mock.calls.map(([path]) => path);
    const peakPaths = getPeaks.mock.calls.map(([path]) => path);
    expect(new Set(transcriptPaths)).toEqual(
      new Set(['camera.mp4', 'pip.mp4', 'music.wav', 'room.wav', 'caption.mp4', 'suggested.mp4']),
    );
    expect(new Set(peakPaths)).toEqual(new Set(transcriptPaths));
    expect(transcriptPaths).not.toContain('background-loop.mp4');
    expect(transcriptPaths).not.toContain('unused.mp4');
  });
});

describe('EditorStore editor panel mode', () => {
  it('starts in transcript mode', () => {
    const store = new EditorStore();

    expect(store.getState().dockLayout.workspace.active).toBe('transcript');
  });

  it('supports every transition between transcript, media and library', () => {
    const store = new EditorStore();
    const modes = ['transcript', 'media', 'library'] as const;

    for (const from of modes) {
      store.setEditorPanelMode(from);
      for (const to of modes) {
        store.setEditorPanelMode(to);
        expect(store.getState().dockLayout.workspace.active).toBe(to);
        store.setEditorPanelMode(from);
      }
    }
  });

  it('registers imported media without changing the edit history', async () => {
    const { store } = await makeStore();
    const before = store.getState();

    store.registerImportedMedia({
      kind: 'video',
      relPath: 'novo take.mov',
      durationS: 8.4,
      fps: 30,
      width: 1080,
      height: 1920,
      hasAudio: true,
      transcriptEngine: null,
      proxyRelPath: null,
    });

    const after = store.getState();
    expect(after.project?.media.map((item) => item.relPath)).toEqual(['novo take.mov']);
    expect(after.doc).toBe(before.doc);
    expect(after).toMatchObject({ dirty: before.dirty, undoDepth: before.undoDepth });
  });
});

describe('EditorStore canvas background', () => {
  it('enables the restrained default, records history and removes it cleanly', async () => {
    const { store, putEdit } = await makeStore();

    expect(store.getState().backgroundInspectorOpen).toBe(false);
    store.ensureBackground();
    store.selectBackground();
    expect(store.getState()).toMatchObject({
      backgroundInspectorOpen: true,
      selection: null,
      subtitleInspectorOpen: false,
    });

    expect(store.getState().doc?.canvas).toEqual({
      background: { kind: 'color', color: DEFAULT_CANVAS_BACKGROUND_COLOR },
      base: { mode: 'cell', cell: DEFAULT_CANVAS_BASE_CELL },
    });
    expect(store.getState().undoDepth).toBe(1);
    await expect(store.flushSave()).resolves.toBe(true);
    expect(putEdit).toHaveBeenCalledWith(
      expect.objectContaining({ canvas: store.getState().doc?.canvas }),
      'hash-0',
    );

    store.removeBackground();
    expect(store.getState().doc?.canvas).toBeUndefined();
    expect(store.getState().backgroundInspectorOpen).toBe(false);
    expect(store.getState().undoDepth).toBe(2);

    store.undo();
    expect(store.getState().doc?.canvas).toBeDefined();
  });

  it('never leaves a background inspector target without a canvas', async () => {
    const { store } = await makeStore();

    store.selectBackground();
    expect(store.getState().backgroundInspectorOpen).toBe(false);

    store.ensureBackground();
    store.selectBackground();
    expect(store.getState().backgroundInspectorOpen).toBe(true);

    store.undo();
    expect(store.getState().doc?.canvas).toBeUndefined();
    expect(store.getState().backgroundInspectorOpen).toBe(false);
  });

  it('keeps background, base fit and cell edits canonical and mutually exclusive', async () => {
    const { store } = await makeStore();

    store.setBackgroundColor('#202126');
    store.setBackgroundImage('edit/assets/background.jpg', 'contain');
    expect(store.getState().doc?.canvas?.background).toEqual({
      kind: 'image',
      file: 'edit/assets/background.jpg',
      fit: 'contain',
      color: '#202126',
    });
    store.setBackgroundFit('cover');
    store.setCanvasBaseMode('fill');
    expect(store.getState().doc?.canvas?.base).toEqual({ mode: 'fill' });

    store.setCanvasBaseCell({ x: -1, y: 0.7, w: 2, h: 0.5 });
    expect(store.getState().doc?.canvas).toMatchObject({
      background: { kind: 'image', fit: 'cover' },
      base: { mode: 'cell', cell: { x: 0, y: 0.5, w: 1, h: 0.5 } },
    });

    const beforeInvalid = store.getState().doc;
    const historyBeforeInvalid = store.getState().undoDepth;
    store.setBackgroundImage('../outside.png');
    expect(store.getState().doc).toBe(beforeInvalid);
    expect(store.getState().undoDepth).toBe(historyBeforeInvalid);
  });

  it('registers a project video collision-safely and also accepts a known source key', async () => {
    const collisionDoc: EditDoc = {
      ...doc,
      sources: { ...doc.sources, background_loop: { path: 'other.mp4' } },
    };
    const { store } = await makeStore({
      getProject: () =>
        Promise.resolve({ ...projectWith(collisionDoc), media: [backgroundVideoMedia] }),
    });

    store.setBackgroundVideo('background-loop.mp4', 'contain');
    expect(store.getState().doc?.sources.background_loop_2).toEqual({
      path: 'background-loop.mp4',
      durationS: 12,
    });
    expect(store.getState().doc?.canvas?.background).toEqual({
      kind: 'video',
      source: 'background_loop_2',
      fit: 'contain',
      color: DEFAULT_CANVAS_BACKGROUND_COLOR,
    });

    store.setBackgroundVideoSource('cam');
    expect(store.getState().doc?.canvas?.background).toMatchObject({
      kind: 'video',
      source: 'cam',
      fit: 'cover',
    });
    const beforeMissing = store.getState().doc;
    store.setBackgroundVideoSource('missing');
    expect(store.getState().doc).toBe(beforeMissing);
  });

  it('prunes a background-only video source but preserves it when another track shares it', async () => {
    const { store } = await makeStore({
      getProject: () => Promise.resolve({ ...projectWith(doc), media: [backgroundVideoMedia] }),
    });

    store.setBackgroundVideo('background-loop.mp4');
    expect(store.getState().doc?.sources.background_loop).toBeDefined();
    store.removeBackground();
    expect(store.getState().doc?.sources.background_loop).toBeUndefined();

    store.setBackgroundVideo('background-loop.mp4');
    store.addLayer('background-loop.mp4', 0);
    store.removeBackground();

    expect(store.getState().doc?.sources.background_loop).toEqual({
      path: 'background-loop.mp4',
      durationS: 12,
    });
    expect(
      store
        .getState()
        .doc?.tracks.find((track) => track.id === 'layer-1')
        ?.blocks.some((block) => 'source' in block && block.source === 'background_loop'),
    ).toBe(true);
  });

  it('prunes an exclusive video source when the background changes to a color', async () => {
    const { store } = await makeStore({
      getProject: () => Promise.resolve({ ...projectWith(doc), media: [backgroundVideoMedia] }),
    });

    store.setBackgroundVideo('background-loop.mp4');
    store.setBackgroundColor('#202126');

    expect(store.getState().doc?.canvas?.background).toEqual({
      kind: 'color',
      color: '#202126',
    });
    expect(store.getState().doc?.sources.background_loop).toBeUndefined();
  });

  it('prunes an exclusive video source when the background changes to an image', async () => {
    const { store } = await makeStore({
      getProject: () => Promise.resolve({ ...projectWith(doc), media: [backgroundVideoMedia] }),
    });

    store.setBackgroundVideo('background-loop.mp4');
    store.setBackgroundImage('edit/assets/background.jpg', 'contain');

    expect(store.getState().doc?.canvas?.background).toMatchObject({
      kind: 'image',
      file: 'edit/assets/background.jpg',
      fit: 'contain',
    });
    expect(store.getState().doc?.sources.background_loop).toBeUndefined();
  });

  it('prunes video A when video B replaces it and keeps a reused background key', async () => {
    const { store } = await makeStore({
      getProject: () =>
        Promise.resolve({
          ...projectWith(doc),
          media: [backgroundVideoMedia, alternateBackgroundVideoMedia],
        }),
    });

    store.setBackgroundVideo('background-loop.mp4');
    store.setBackgroundVideo('background-loop.mp4', 'contain');
    expect(store.getState().doc?.sources.background_loop).toEqual({
      path: 'background-loop.mp4',
      durationS: 12,
    });

    store.setBackgroundVideo('alternate-background.mp4');

    expect(store.getState().doc?.canvas?.background).toMatchObject({
      kind: 'video',
      source: 'alternate_background',
    });
    expect(store.getState().doc?.sources.background_loop).toBeUndefined();
    expect(store.getState().doc?.sources.alternate_background).toEqual({
      path: 'alternate-background.mp4',
      durationS: 9,
    });
  });

  it('preserves the previous video source when a track shares it during replacement', async () => {
    const { store } = await makeStore({
      getProject: () => Promise.resolve({ ...projectWith(doc), media: [backgroundVideoMedia] }),
    });

    store.setBackgroundVideo('background-loop.mp4');
    store.addLayer('background-loop.mp4', 0);
    store.setBackgroundColor('#202126');

    expect(store.getState().doc?.sources.background_loop).toEqual({
      path: 'background-loop.mp4',
      durationS: 12,
    });
  });

  it('uses the synthetic lock for selection, setters, direct edits, undo and reload pruning', async () => {
    const getProject = vi.fn(() => Promise.resolve(projectWith(doc)));
    const { store } = await makeStore({ getProject });
    store.ensureBackground();
    store.setBackgroundColor('#202126');
    store.selectBackground();
    store.setTrackLocked(BACKGROUND_EDITOR_TRACK_KEY, true);
    const lockedDoc = store.getState().doc;
    const depths = {
      undoDepth: store.getState().undoDepth,
      redoDepth: store.getState().redoDepth,
    };

    expect(store.getState().backgroundInspectorOpen).toBe(false);
    store.selectBackground();
    store.setBackgroundColor('#FFFFFF');
    store.setCanvasBaseMode('fill');
    store.removeBackground();
    if (lockedDoc?.canvas) {
      store.applyDoc({
        ...lockedDoc,
        canvas: { ...lockedDoc.canvas, background: { kind: 'color', color: '#FFFFFF' } },
      });
    }
    store.undo();
    expect(store.getState().doc).toBe(lockedDoc);
    expect(store.getState()).toMatchObject(depths);

    if (!lockedDoc) throw new Error('expected a loaded document');
    getProject.mockResolvedValueOnce(projectWith(lockedDoc));
    await store.reloadFromServer(false);
    expect(store.getState().lockedTrackKeys).toEqual(new Set([BACKGROUND_EDITOR_TRACK_KEY]));
    getProject.mockResolvedValueOnce(projectWith(doc));
    await store.reloadFromServer(false);
    expect(store.getState().lockedTrackKeys).toEqual(new Set());
    getProject.mockResolvedValueOnce({ ...projectWith(doc), doc: null, editHash: null });
    await store.reloadFromServer(false);
    expect(store.getState().lockedTrackKeys).toEqual(new Set());
  });

  it('closes the background inspector when another inspector target is selected', async () => {
    const { store } = await makeStore();
    store.ensureBackground();

    store.selectBackground();
    store.select({ trackId: 'base', blockIndex: 0 });
    expect(store.getState().backgroundInspectorOpen).toBe(false);

    store.selectBackground();
    store.selectSubtitles();
    expect(store.getState()).toMatchObject({
      backgroundInspectorOpen: false,
      subtitleInspectorOpen: true,
    });

    store.selectBackground();
    store.select(null);
    expect(store.getState().backgroundInspectorOpen).toBe(false);
  });
});

describe('EditorStore subtitle edits', () => {
  it('correctWord upserts one entry per word and an empty text removes it', async () => {
    const { store } = await makeStore();
    store.correctWord('cam', 3, 'certinho');
    store.correctWord('cam', 3, 'certíssimo');
    expect(store.getState().doc?.subtitles.corrections).toEqual([
      { source: 'cam', at: 3, text: 'certíssimo' },
    ]);
    store.correctWord('cam', 3, '   ');
    expect(store.getState().doc?.subtitles.corrections).toBeUndefined();
  });

  it('hideSubtitleRange rounds, rejects empty windows and unhide removes by index', async () => {
    const { store } = await makeStore();
    store.hideSubtitleRange('cam', 1.234, 2.345);
    store.hideSubtitleRange('cam', 5, 5);
    expect(store.getState().doc?.subtitles.hiddenRanges).toEqual([
      { source: 'cam', start: 1.23, end: 2.35 },
    ]);
    store.unhideSubtitleRange(0);
    expect(store.getState().doc?.subtitles.hiddenRanges).toBeUndefined();
  });
});

describe('EditorStore setBlockTransition', () => {
  it('sets, updates and removes the transition on a base block by index', async () => {
    const { store } = await makeStore({ getProject: () => Promise.resolve(projectWith(multiDoc)) });

    store.setBlockTransition(1, { type: 'fade-black', durationS: 0.3 });
    expect(store.getState().doc?.tracks[0]?.blocks[1]).toMatchObject({
      transition: { type: 'fade-black', durationS: 0.3 },
    });

    store.setBlockTransition(1, { type: 'fade-white', durationS: 0.6 });
    expect(store.getState().doc?.tracks[0]?.blocks[1]).toMatchObject({
      transition: { type: 'fade-white', durationS: 0.6 },
    });

    store.setBlockTransition(1, undefined);
    const block = store.getState().doc?.tracks[0]?.blocks[1];
    expect(block).not.toHaveProperty('transition');
    expect(JSON.stringify(block)).not.toContain('transition');
  });

  it('clamps an out-of-range duration to the schema bounds', async () => {
    const { store } = await makeStore({ getProject: () => Promise.resolve(projectWith(multiDoc)) });
    store.setBlockTransition(1, { type: 'fade-black', durationS: 5 });
    expect(store.getState().doc?.tracks[0]?.blocks[1]).toMatchObject({
      transition: { type: 'fade-black', durationS: 1.0 },
    });
  });
});

describe('EditorStore setBlockSpeed', () => {
  it('clamps into SPEED_BOUNDS [0.5,2] and rounds to 2 decimals', async () => {
    const { store } = await makeStore({ getProject: () => Promise.resolve(projectWith(multiDoc)) });
    store.setBlockSpeed(1, 3.456);
    expect(store.getState().doc?.tracks[0]?.blocks[1]).toMatchObject({ speed: 2 });
    store.setBlockSpeed(1, 0.234);
    expect(store.getState().doc?.tracks[0]?.blocks[1]).toMatchObject({ speed: 0.5 });
    store.setBlockSpeed(1, 1.567);
    expect(store.getState().doc?.tracks[0]?.blocks[1]).toMatchObject({ speed: 1.57 });
  });

  it('speed 1 removes the field instead of persisting it', async () => {
    const { store } = await makeStore({ getProject: () => Promise.resolve(projectWith(multiDoc)) });
    store.setBlockSpeed(1, 1.5);
    expect(store.getState().doc?.tracks[0]?.blocks[1]).toMatchObject({ speed: 1.5 });
    store.setBlockSpeed(1, 1);
    const block = store.getState().doc?.tracks[0]?.blocks[1];
    expect(block).not.toHaveProperty('speed');
    expect(JSON.stringify(block)).not.toContain('speed');
  });

  it('is a no-op on a non-finite value and never trips editWarning', async () => {
    const { store } = await makeStore({ getProject: () => Promise.resolve(projectWith(multiDoc)) });
    const docBefore = store.getState().doc;

    store.setBlockSpeed(1, NaN);

    expect(store.getState().doc).toBe(docBefore);
    expect(store.getState().editWarning).toBeNull();
  });

  it("is a no-op on 0 or a negative value — Number('') is 0, not NaN, so the finite check alone would silently clamp a cleared input to SPEED_BOUNDS.min", async () => {
    const { store } = await makeStore({ getProject: () => Promise.resolve(projectWith(multiDoc)) });
    const docBefore = store.getState().doc;

    store.setBlockSpeed(1, Number(''));
    expect(store.getState().doc).toBe(docBefore);

    store.setBlockSpeed(1, 0);
    expect(store.getState().doc).toBe(docBefore);

    store.setBlockSpeed(1, -1);
    expect(store.getState().doc).toBe(docBefore);

    expect(store.getState().editWarning).toBeNull();
  });
});

describe('EditorStore output settings (speed, audio crossfade)', () => {
  it('setOutputSpeed clamps into SPEED_BOUNDS [0.5,2] and rounds to 2 decimals; 1 removes the field', async () => {
    const { store } = await makeStore();
    store.setOutputSpeed(3.456);
    expect(store.getState().doc?.output.speed).toBe(2);
    store.setOutputSpeed(1.234);
    expect(store.getState().doc?.output.speed).toBe(1.23);
    store.setOutputSpeed(1);
    expect(store.getState().doc?.output.speed).toBeUndefined();
  });

  it('setOutputSpeed is a no-op on a non-finite value', async () => {
    const { store } = await makeStore();
    const docBefore = store.getState().doc;

    store.setOutputSpeed(NaN);

    expect(store.getState().doc).toBe(docBefore);
  });

  it('setOutputSpeed is a no-op on zero and negatives (a cleared input reads as 0)', async () => {
    const { store } = await makeStore();
    const docBefore = store.getState().doc;

    store.setOutputSpeed(0);
    store.setOutputSpeed(-1);

    expect(store.getState().doc).toBe(docBefore);
    expect(store.getState().editWarning).toBeNull();
    expect(store.getState().editWarning).toBeNull();
  });

  it('setJoinAudioCrossfadeMs rounds to an integer, clamps into [0,200]; 0 removes the field', async () => {
    const { store } = await makeStore();
    store.setJoinAudioCrossfadeMs(23.6);
    expect(store.getState().doc?.output.joinAudioCrossfadeMs).toBe(24);
    store.setJoinAudioCrossfadeMs(500);
    expect(store.getState().doc?.output.joinAudioCrossfadeMs).toBe(200);
    store.setJoinAudioCrossfadeMs(0);
    expect(store.getState().doc?.output.joinAudioCrossfadeMs).toBeUndefined();
  });

  it('setJoinAudioCrossfadeMs is a no-op on a non-finite value', async () => {
    const { store } = await makeStore();
    const docBefore = store.getState().doc;

    store.setJoinAudioCrossfadeMs(NaN);

    expect(store.getState().doc).toBe(docBefore);
    expect(store.getState().editWarning).toBeNull();
  });
});

describe('EditorStore effect blocks', () => {
  it('addZoomEffect creates the effects track and selects the new block', async () => {
    const { store } = await makeStore();
    store.addZoomEffect(1.234, 1.5, 1.15);
    const doc = store.getState().doc;
    const track = doc?.tracks.find((t) => t.kind === 'effect');
    expect(track?.blocks).toEqual([{ type: 'zoom', at: 1.23, duration: 1.5, scale: 1.15 }]);
    expect(store.getState().selection).toEqual({ trackId: track?.id, blockIndex: 0 });
  });

  it('addFlashEffect and addShakeEffect append to the SAME effects track as addZoomEffect', async () => {
    const { store } = await makeStore();
    store.addZoomEffect(0, 1, 1.1);
    store.addFlashEffect(2, 0.25);
    store.addShakeEffect(3, 0.5);
    const doc = store.getState().doc;
    const tracks = doc?.tracks.filter((t) => t.kind === 'effect');
    expect(tracks).toHaveLength(1);
    expect(tracks?.[0]?.blocks).toEqual([
      { type: 'zoom', at: 0, duration: 1, scale: 1.1 },
      { type: 'flash', at: 2, duration: 0.25 },
      { type: 'shake', at: 3, duration: 0.5, intensity: 5 },
    ]);
  });

  it('addShakeEffect accepts an explicit intensity', async () => {
    const { store } = await makeStore();
    store.addShakeEffect(1, 0.5, 8);
    const track = store.getState().doc?.tracks.find((t) => t.kind === 'effect');
    expect(track?.kind === 'effect' && track.blocks[0]).toMatchObject({ intensity: 8 });
  });

  it('addFlashEffect clamps an out-of-range duration instead of discarding the edit', async () => {
    const { store } = await makeStore();
    store.addFlashEffect(1, 5);
    const track = store.getState().doc?.tracks.find((t) => t.kind === 'effect');
    expect(track?.kind === 'effect' && track.blocks[0]).toMatchObject({
      type: 'flash',
      duration: 0.6,
    });
    expect(store.getState().editWarning).toBeNull();
  });

  it('resizeTimedBlock clamps a flash edge drag to the schema bounds and APPLIES the doc', async () => {
    const { store } = await makeStore();
    store.addFlashEffect(1, 0.25);
    const trackId = store.getState().doc?.tracks.find((t) => t.kind === 'effect')?.id ?? '';
    store.resizeTimedBlock(trackId, 0, 'out', 4);
    let block = store.getState().doc?.tracks.find((t) => t.kind === 'effect')?.blocks[0];
    expect(block).toMatchObject({ at: 1, duration: 0.6 });
    expect(store.getState().editWarning).toBeNull();
    // The drag minimum is the flash minimum (0.08), not MIN_TIMED_BLOCK_S —
    // the whole schema-valid range must be reachable by mouse.
    store.resizeTimedBlock(trackId, 0, 'out', 1.01);
    block = store.getState().doc?.tracks.find((t) => t.kind === 'effect')?.blocks[0];
    expect(block).toMatchObject({ at: 1, duration: 0.08 });
    expect(store.getState().editWarning).toBeNull();
  });

  it('resizeTimedBlock clamps a shake in-edge drag and keeps the end anchored', async () => {
    const { store } = await makeStore();
    store.addShakeEffect(2, 0.5);
    const trackId = store.getState().doc?.tracks.find((t) => t.kind === 'effect')?.id ?? '';
    store.resizeTimedBlock(trackId, 0, 'in', 0);
    const block = store.getState().doc?.tracks.find((t) => t.kind === 'effect')?.blocks[0];
    expect(block).toMatchObject({ at: 1, duration: 1.5 });
    expect(store.getState().editWarning).toBeNull();
  });

  it('updateEffectBlock clamps zoom scale into 1.01–2 (unchanged behavior)', async () => {
    const { store } = await makeStore();
    store.addZoomEffect(0, 1, 1.1);
    const track = store.getState().doc?.tracks.find((t) => t.kind === 'effect');
    store.updateEffectBlock(track!.id, 0, { scale: 5 });
    expect(store.getState().doc?.tracks.find((t) => t.kind === 'effect')?.blocks[0]).toMatchObject({
      scale: 2,
    });
    store.updateEffectBlock(track!.id, 0, { scale: 0 });
    expect(store.getState().doc?.tracks.find((t) => t.kind === 'effect')?.blocks[0]).toMatchObject({
      scale: 1.01,
    });
  });

  it('updateEffectBlock clamps flash duration into 0.08–0.6', async () => {
    const { store } = await makeStore();
    store.addFlashEffect(0, 0.25);
    const track = store.getState().doc?.tracks.find((t) => t.kind === 'effect');
    store.updateEffectBlock(track!.id, 0, { duration: 5 });
    expect(store.getState().doc?.tracks.find((t) => t.kind === 'effect')?.blocks[0]).toMatchObject({
      duration: 0.6,
    });
    store.updateEffectBlock(track!.id, 0, { duration: 0.01 });
    expect(store.getState().doc?.tracks.find((t) => t.kind === 'effect')?.blocks[0]).toMatchObject({
      duration: 0.08,
    });
  });

  it('updateEffectBlock clamps shake duration into 0.15–1.5 and intensity into 1–10 (rounded)', async () => {
    const { store } = await makeStore();
    store.addShakeEffect(0, 0.5);
    const track = store.getState().doc?.tracks.find((t) => t.kind === 'effect');
    store.updateEffectBlock(track!.id, 0, { duration: 3, intensity: 15 });
    expect(store.getState().doc?.tracks.find((t) => t.kind === 'effect')?.blocks[0]).toMatchObject({
      duration: 1.5,
      intensity: 10,
    });
    store.updateEffectBlock(track!.id, 0, { duration: 0.01, intensity: 3.6 });
    expect(store.getState().doc?.tracks.find((t) => t.kind === 'effect')?.blocks[0]).toMatchObject({
      duration: 0.15,
      intensity: 4,
    });
  });

  it('updateEffectBlock preserves an untouched shake intensity across an unrelated patch', async () => {
    const { store } = await makeStore();
    store.addShakeEffect(0, 0.5, 8);
    const track = store.getState().doc?.tracks.find((t) => t.kind === 'effect');
    store.updateEffectBlock(track!.id, 0, { at: 1 });
    expect(store.getState().doc?.tracks.find((t) => t.kind === 'effect')?.blocks[0]).toMatchObject({
      intensity: 8,
      at: 1,
    });
  });
});

describe('EditorStore updateOverlayBlock', () => {
  const docWithOverlay: EditDoc = {
    ...doc,
    tracks: [
      ...doc.tracks,
      {
        id: 'overlays',
        kind: 'overlay',
        blocks: [{ file: 'edit/assets/cta.webm', at: 1, duration: 4, scale: 0.5 }],
      },
    ],
  };

  async function overlayStore(): Promise<Harness> {
    const harness = await makeStore({
      getProject: () => Promise.resolve({ ...projectWith(docWithOverlay) }),
    });
    return harness;
  }

  function overlayBlock(harness: Harness): { position?: unknown; scale?: number } {
    const track = harness.store
      .getState()
      .doc?.tracks.find((candidate) => candidate.kind === 'overlay');
    return (track?.blocks[0] ?? {}) as { position?: unknown; scale?: number };
  }

  it('clamps an out-of-range position into [0, 0.98]', async () => {
    const harness = await overlayStore();
    harness.store.updateOverlayBlock('overlays', 0, { position: { x: 1.5, y: -2 } });
    expect(overlayBlock(harness).position).toEqual({ x: 0.98, y: 0 });
  });

  it('clamps scale into [0.05, 1]', async () => {
    const harness = await overlayStore();
    harness.store.updateOverlayBlock('overlays', 0, { scale: 4 });
    expect(overlayBlock(harness).scale).toBe(1);
    harness.store.updateOverlayBlock('overlays', 0, { scale: 0.001 });
    expect(overlayBlock(harness).scale).toBe(0.05);
  });

  it('distinct coalesce keys keep move and resize as separate undo steps', async () => {
    const harness = await overlayStore();
    harness.store.updateOverlayBlock('overlays', 0, { position: { x: 0.1, y: 0.1 } }, 'ov-pos');
    harness.store.updateOverlayBlock('overlays', 0, { position: { x: 0.2, y: 0.2 } }, 'ov-pos');
    harness.store.updateOverlayBlock('overlays', 0, { scale: 0.7 }, 'ov-resize');
    expect(harness.store.getState().undoDepth).toBe(2);
  });
});

describe('EditorStore flushSave', () => {
  it('persists dirty edits and reports success', async () => {
    const { store, putEdit } = await makeStore();
    store.hideSubtitleRange('cam', 1, 2);
    expect(store.getState().dirty).toBe(true);
    await expect(store.flushSave()).resolves.toBe(true);
    expect(putEdit).toHaveBeenCalledTimes(1);
    expect(store.getState().dirty).toBe(false);
  });

  it('reports failure and stays dirty when the save is rejected', async () => {
    const { store } = await makeStore({
      putEdit: () => Promise.reject(new Error('422 inválido')),
    });
    store.hideSubtitleRange('cam', 1, 2);
    await expect(store.flushSave()).resolves.toBe(false);
    expect(store.getState().dirty).toBe(true);
    expect(store.getState().loadError).toContain('422');
  });

  it('is a no-op success when nothing is dirty', async () => {
    const { store, putEdit } = await makeStore();
    await expect(store.flushSave()).resolves.toBe(true);
    expect(putEdit).not.toHaveBeenCalled();
  });

  it('serializes an edit made during an in-flight save and flushes the newest document', async () => {
    let resolveFirst: (value: { hash: string }) => void = () => undefined;
    let resolveSecond: (value: { hash: string }) => void = () => undefined;
    const putEdit = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ hash: string }>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<{ hash: string }>((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const { store, emit } = await makeStore({ putEdit });

    store.setOutputSpeed(1.1);
    const firstSave = store.save();
    await vi.waitFor(() => {
      expect(putEdit).toHaveBeenCalledTimes(1);
    });
    store.setOutputSpeed(1.2);
    const flushed = store.flushSave();
    resolveFirst({ hash: 'hash-a' });
    await vi.waitFor(() => {
      expect(putEdit).toHaveBeenCalledTimes(2);
    });

    expect(putEdit.mock.calls[0]?.[1]).toBe('hash-0');
    expect(putEdit.mock.calls[1]?.[1]).toBe('hash-a');
    expect((putEdit.mock.calls[1]?.[0] as EditDoc).output.speed).toBe(1.2);
    emit({
      kind: 'job',
      id: 1,
      type: 'render',
      state: 'done',
      result: {
        outputRel: 'edit/preview.mp4',
        durationS: 4,
        editHash: 'hash-a',
        canonical: true,
        kind: 'preview',
        programKey: 'program-key-0',
      },
    });
    expect(store.getState().previewOutdated).toBe(true);

    resolveSecond({ hash: 'hash-b' });
    await expect(firstSave).resolves.toBeUndefined();
    await expect(flushed).resolves.toBe(true);
    expect(store.getState().dirty).toBe(false);
  });

  it('turns a stale-hash response into a recoverable conflict without clearing dirty', async () => {
    const { store } = await makeStore({
      putEdit: () => Promise.reject(new ApiError('conflito', 409, 'hash-agent')),
    });
    store.setOutputSpeed(1.1);

    await expect(store.flushSave()).resolves.toBe(false);
    expect(store.getState()).toMatchObject({ dirty: true, conflict: true, loadError: null });
  });

  it('Keep mine refreshes the CAS base before intentionally publishing the local document', async () => {
    const putEdit = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('conflito', 409, 'hash-agent'))
      .mockResolvedValueOnce({ hash: 'hash-local' });
    const { store, getProject } = await makeStore({ putEdit });
    store.setOutputSpeed(1.1);
    await store.flushSave();
    getProject.mockResolvedValueOnce({ ...projectWith(doc), editHash: 'hash-agent' });

    store.keepMine();
    await vi.waitFor(() => {
      expect(putEdit).toHaveBeenCalledTimes(2);
      expect(store.getState().dirty).toBe(false);
    });
    expect(putEdit.mock.calls[1]?.[1]).toBe('hash-agent');
    expect(store.getState().conflict).toBe(false);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe('EditorStore edit-changed routing', () => {
  it('automatically applies consecutive agent edits without a refresh or acknowledgement', async () => {
    const { store, emit, getProject } = await makeStore();
    for (const speed of [1.1, 1.2]) {
      const updated: EditDoc = { ...doc, output: { ...doc.output, speed } };
      const hash = `hash-agent-${String(speed)}`;
      getProject.mockResolvedValueOnce({ ...projectWith(updated), editHash: hash });
      emit({ kind: 'edit-changed', hash, external: true });
      await vi.waitFor(() => {
        expect(store.getState().doc).toEqual(updated);
        expect(store.getState().project?.editHash).toBe(hash);
      });
      expect(store.getState()).toMatchObject({ dirty: false, conflict: false });
    }
  });

  it('automatically picks up edits missed while the event stream was disconnected', async () => {
    const { store, emit, getProject } = await makeStore();
    emit({ kind: 'jobs-snapshot', jobs: [] });
    const updated: EditDoc = { ...doc, subtitles: { enabled: false, preset: 'pill' } };
    getProject.mockResolvedValueOnce({ ...projectWith(updated), editHash: 'hash-offline-edit' });
    emit({ kind: 'jobs-snapshot', jobs: [] });
    await vi.waitFor(() => {
      expect(store.getState().doc).toEqual(updated);
      expect(store.getState().project?.editHash).toBe('hash-offline-edit');
    });
    expect(store.getState()).toMatchObject({ dirty: false, conflict: false });
  });

  it('preserves edits and undo made while an automatic reload is fetching the server document', async () => {
    const { store, emit, getProject } = await makeStore();
    const response = deferred<ProjectInfo>();
    getProject.mockReturnValueOnce(response.promise);
    emit({ kind: 'edit-changed', hash: 'hash-agent', external: true });
    await vi.waitFor(() => {
      expect(getProject).toHaveBeenCalledTimes(2);
    });

    store.hideSubtitleRange('cam', 1, 2);
    const localDoc = store.getState().doc;
    response.resolve({ ...projectWith(doc), editHash: 'hash-agent' });
    await vi.waitFor(() => {
      expect(store.getState().conflict).toBe(true);
    });

    expect(store.getState().doc).toBe(localDoc);
    expect(store.getState().dirty).toBe(true);
    expect(store.getState().undoDepth).toBe(1);
  });

  it('does not roll back a completed local save when a reconnect GET returns its old snapshot', async () => {
    const { store, emit, getProject } = await makeStore();
    emit({ kind: 'jobs-snapshot', jobs: [] });
    const response = deferred<ProjectInfo>();
    getProject.mockReturnValueOnce(response.promise);
    emit({ kind: 'jobs-snapshot', jobs: [] });
    await vi.waitFor(() => {
      expect(getProject).toHaveBeenCalledTimes(2);
    });

    store.hideSubtitleRange('cam', 1, 2);
    await store.flushSave();
    const savedDoc = store.getState().doc;
    response.resolve(projectWith(doc));
    await response.promise;

    expect(store.getState().doc).toBe(savedDoc);
    expect(store.getState()).toMatchObject({ dirty: false, undoDepth: 1 });
  });

  it('does not replace a newer reload when an earlier GET resolves last', async () => {
    const { store, getProject } = await makeStore();
    const older = deferred<ProjectInfo>();
    const newerDoc: EditDoc = { ...doc, subtitles: { enabled: false, preset: 'pill' } };
    getProject.mockReturnValueOnce(older.promise);
    const firstReload = store.reloadFromServer(true);
    await vi.waitFor(() => {
      expect(getProject).toHaveBeenCalledTimes(2);
    });
    getProject.mockResolvedValueOnce({ ...projectWith(newerDoc), editHash: 'hash-newer' });
    await store.reloadFromServer(true);
    older.resolve({ ...projectWith(doc), editHash: 'hash-older' });
    await firstReload;

    expect(store.getState().doc).toEqual(newerDoc);
    expect(store.getState().project?.editHash).toBe('hash-newer');
  });

  it('keeps the newest transcript when hydration from an older reload completes last', async () => {
    const oldTranscript = deferred<Transcript | null>();
    const latestTranscript: Transcript = {
      engine: 'scribe',
      text: 'corrigido',
      words: [{ text: 'corrigido', start: 0, end: 1, type: 'word' }],
    };
    const getTranscript = vi
      .fn<StoreBackend['getTranscript']>()
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce(oldTranscript.promise)
      .mockResolvedValueOnce(latestTranscript);
    const { store } = await makeStore({ getTranscript });
    const firstReload = store.reloadFromServer(true);
    await vi.waitFor(() => {
      expect(getTranscript).toHaveBeenCalledTimes(2);
    });
    await store.reloadFromServer(true);
    oldTranscript.resolve({
      ...latestTranscript,
      text: 'antigo',
      words: [{ text: 'antigo', start: 0, end: 1, type: 'word' }],
    });
    await firstReload;

    expect(store.getState().transcripts.get('cam')?.text).toBe('corrigido');
  });

  it('explicit reload can discard existing local edits but preserves edits made after the click', async () => {
    const { store, getProject } = await makeStore();
    store.hideSubtitleRange('cam', 1, 2);
    await store.reloadFromServer(true);
    expect(store.getState()).toMatchObject({ doc, dirty: false, undoDepth: 0 });

    store.hideSubtitleRange('cam', 1, 2);
    const response = deferred<ProjectInfo>();
    getProject.mockReturnValueOnce(response.promise);
    const reload = store.reloadFromServer(true);
    await vi.waitFor(() => {
      expect(getProject).toHaveBeenCalledTimes(3);
    });
    store.hideSubtitleRange('cam', 3, 4);
    const localDoc = store.getState().doc;
    response.resolve({ ...projectWith(doc), editHash: 'hash-agent' });
    await reload;

    expect(store.getState()).toMatchObject({
      doc: localDoc,
      dirty: true,
      conflict: true,
      undoDepth: 2,
    });
  });

  it('ignores echoes of its own last save', async () => {
    const { store, emit, getProject } = await makeStore();
    emit({ kind: 'edit-changed', hash: 'hash-0', external: false });
    await Promise.resolve();
    expect(getProject).toHaveBeenCalledTimes(1);
    expect(store.getState().conflict).toBe(false);
  });

  it('internal write + clean doc reloads silently without conflict or agent badge', async () => {
    const { store, emit, getProject } = await makeStore();
    emit({ kind: 'edit-changed', hash: 'other-hash', external: false });
    await vi.waitFor(() => {
      expect(getProject).toHaveBeenCalledTimes(2);
    });
    expect(store.getState().conflict).toBe(false);
    expect(store.getState().agentEdited).toBe(false);
  });

  it('internal write + dirty doc is left alone (no conflict banner, no reload)', async () => {
    const { store, emit, getProject } = await makeStore();
    store.hideSubtitleRange('cam', 1, 2);
    emit({ kind: 'edit-changed', hash: 'other-hash', external: false });
    await Promise.resolve();
    expect(getProject).toHaveBeenCalledTimes(1);
    expect(store.getState().conflict).toBe(false);
    expect(store.getState().dirty).toBe(true);
  });

  it('external write + dirty doc raises the conflict banner', async () => {
    const { store, emit } = await makeStore();
    store.hideSubtitleRange('cam', 1, 2);
    emit({ kind: 'edit-changed', hash: 'other-hash', external: true });
    expect(store.getState().conflict).toBe(true);
  });
});

describe('EditorStore preview freshness at boot', () => {
  it('marks an on-disk preview outdated when its edit hash differs from the loaded edit', async () => {
    const staleProject: ProjectInfo = {
      ...projectWith(doc),
      hasPreview: true,
      previewEditHash: 'hash-before-the-last-edit',
    };
    const { store } = await makeStore({ getProject: () => Promise.resolve(staleProject) });

    expect(store.getState().previewOutdated).toBe(true);
  });
});

describe('EditorStore transcription lifecycle', () => {
  it('keeps a background transcription error visible until the next run starts', async () => {
    const { store, emit } = await makeStore();
    emit({ kind: 'job', id: 61, type: 'transcribe', state: 'running' });
    emit({
      kind: 'job',
      id: 61,
      type: 'transcribe',
      state: 'error',
      error: 'modelo local indisponível',
    });

    expect(store.getState().transcriptionError).toBe('modelo local indisponível');

    emit({ kind: 'job', id: 62, type: 'transcribe', state: 'running' });
    expect(store.getState().transcriptionError).toBeNull();
    expect(store.getState().activeJobs.get('transcribe')?.id).toBe(62);
  });
});

describe('EditorStore cut suggestions lifecycle', () => {
  it('keeps an analysis error visible until the next run starts', async () => {
    const { store, emit } = await makeStore();
    emit({ kind: 'job', id: 63, type: 'suggest', state: 'running' });
    emit({ kind: 'job', id: 63, type: 'suggest', state: 'error', error: 'falha na análise' });

    expect(store.getState().suggestionError).toBe('falha na análise');

    emit({ kind: 'job', id: 64, type: 'suggest', state: 'running' });
    expect(store.getState().suggestionError).toBeNull();
    expect(store.getState().activeJobs.get('suggest')?.id).toBe(64);
  });

  it('returns the inspector to the selected block when the user selects the timeline', async () => {
    const { store } = await makeStore();
    store.setCutReviewOpen(true);

    expect(store.getState().cutReviewOpen).toBe(true);
    store.select({ trackId: 'base', blockIndex: 0 });

    expect(store.getState().cutReviewOpen).toBe(false);
    expect(store.getState().selection).toEqual({ trackId: 'base', blockIndex: 0 });
  });

  it('keeps the unified reviewer mode and silence preview options together', async () => {
    const { store } = await makeStore();
    store.setCutReviewMode('silences');
    store.setSuggestionReview({ silence: false, filler: false });
    store.setSilenceReview({ minSilenceS: 0.8, edges: false });

    expect(store.getState().cutReviewMode).toBe('silences');
    expect(store.getState().suggestionReview).toEqual({
      silence: false,
      repetition: true,
      'false-start': true,
      filler: false,
    });
    expect(store.getState().silenceReview).toEqual({
      minSilenceS: 0.8,
      interior: true,
      edges: false,
    });
  });
});

describe('EditorStore audio preview lifecycle', () => {
  const audioPreviewDone = {
    kind: 'job',
    id: 71,
    type: 'audio-preview',
    state: 'done',
    result: {
      outputRel: 'edit/audio-preview.m4a',
      beforeOutputRel: 'edit/audio-preview-before.m4a',
      durationS: 7.01,
      expectedDurationS: 7,
      editHash: 'hash-0',
      semanticKey: audioPreviewSemanticKey(doc),
    },
  } as ServerEvent;

  it('marks an on-disk audio preview stale when its snapshot hash differs at boot', async () => {
    const staleProject: ProjectInfo = {
      ...projectWith(doc),
      hasAudioPreview: true,
      hasAudioComparison: true,
      audioPreviewEditHash: 'hash-before-the-last-edit',
    };
    const { store } = await makeStore({ getProject: () => Promise.resolve(staleProject) });

    expect(store.getState().audioPreviewOutdated).toBe(true);
  });

  it('keeps A/B current when only the full provenance hash differs', async () => {
    const visuallyEditedProject: ProjectInfo = {
      ...projectWith(trackKindsDoc),
      hasAudioPreview: true,
      hasAudioComparison: true,
      audioPreviewEditHash: 'hash-before-visual-effect-edit',
      audioPreviewCurrent: true,
    };
    const { store } = await makeStore({
      getProject: () => Promise.resolve(visuallyEditedProject),
    });

    expect(store.getState().audioPreviewOutdated).toBe(false);
    store.updateEffectBlock('effects', 0, { at: 0.5, duration: 1.2 });
    expect(store.getState().audioPreviewOutdated).toBe(false);
    store.setDenoise(0.4);
    expect(store.getState().audioPreviewOutdated).toBe(true);
  });

  it('does not treat a legacy after-only artifact as an A/B comparison', async () => {
    const legacyProject: ProjectInfo = {
      ...projectWith(doc),
      hasAudioPreview: true,
      hasAudioComparison: false,
      audioPreviewEditHash: 'hash-0',
    };
    const { store } = await makeStore({ getProject: () => Promise.resolve(legacyProject) });

    expect(store.getState().project?.hasAudioComparison).toBe(false);
    expect(store.getState().audioPreviewOutdated).toBe(false);
    expect(store.getState().lastAudioPreview).toBeNull();
  });

  it('tracks the independent job and records a current processed audio artifact', async () => {
    const { store, emit } = await makeStore();
    emit({ kind: 'job', id: 71, type: 'audio-preview', state: 'running' });
    expect(store.getState().activeJobs.has('audio-preview')).toBe(true);

    emit(audioPreviewDone);

    expect(store.getState().activeJobs.has('audio-preview')).toBe(false);
    expect(store.getState().lastAudioPreview).toEqual({
      outputRel: 'edit/audio-preview.m4a',
      beforeOutputRel: 'edit/audio-preview-before.m4a',
      durationS: 7.01,
      expectedDurationS: 7,
    });
    expect(store.getState().project).toMatchObject({
      hasAudioPreview: true,
      hasAudioComparison: true,
      audioPreviewEditHash: 'hash-0',
      audioPreviewCurrent: true,
    });
    expect(store.getState().audioPreviewOutdated).toBe(false);
    expect(store.getState().audioPreviewVersion).toBe(1);
    expect(store.getState().previewVersion).toBe(0);
    expect(store.getState().lastPreviewRender).toBeNull();
  });

  it('keeps the processed audio stale when the edit changes during its job', async () => {
    const { store, emit } = await makeStore();
    emit({ kind: 'job', id: 71, type: 'audio-preview', state: 'running' });
    store.setDenoise(0.4);

    emit(audioPreviewDone);

    expect(store.getState().audioPreviewOutdated).toBe(true);
    expect(store.getState().audioPreviewVersion).toBe(1);
  });

  it('accepts a completed A/B job after a visual-only edit during processing', async () => {
    const { store, emit } = await makeStore();
    emit({ kind: 'job', id: 71, type: 'audio-preview', state: 'running' });
    store.addZoomEffect(0.5, 1.5, 1.15);

    emit(audioPreviewDone);

    expect(store.getState().audioPreviewOutdated).toBe(false);
    expect(store.getState().project?.audioPreviewCurrent).toBe(true);
  });

  it('keeps a malformed result out of the audio preview state', async () => {
    const { store, emit } = await makeStore();
    emit({
      kind: 'job',
      id: 71,
      type: 'audio-preview',
      state: 'done',
      result: { outputRel: 'edit/audio-preview.m4a', durationS: 7, editHash: 'hash-0' },
    });

    expect(store.getState().lastAudioPreview).toBeNull();
    expect(store.getState().audioPreviewVersion).toBe(0);
  });

  it('surfaces an audio job error without overwriting the video render error', async () => {
    const { store, emit } = await makeStore();
    emit({
      kind: 'job',
      id: 71,
      type: 'audio-preview',
      state: 'error',
      error: 'ffmpeg audio failed',
    });

    expect(store.getState().audioPreviewError).toBe('ffmpeg audio failed');
    expect(store.getState().renderError).toBeNull();
  });

  it('ignores a duplicate terminal from job 1 after replacement job 2 is running', async () => {
    const { store, emit } = await makeStore();
    emit({ kind: 'job', id: 71, type: 'audio-preview', state: 'running' });
    emit(audioPreviewDone);
    expect(store.getState().audioPreviewVersion).toBe(1);

    emit({ kind: 'job', id: 72, type: 'audio-preview', state: 'running' });
    emit(audioPreviewDone);

    expect(store.getState().activeJobs.get('audio-preview')?.id).toBe(72);
    expect(store.getState().audioPreviewVersion).toBe(1);
  });

  it('keeps a newer snapshot job when delayed progress from an older job arrives', async () => {
    const { store, emit } = await makeStore();
    emit({
      kind: 'jobs-snapshot',
      jobs: [{ kind: 'job', id: 72, type: 'audio-preview', state: 'running' }],
    });

    emit({
      kind: 'job',
      id: 71,
      type: 'audio-preview',
      state: 'running',
      progress: 'progresso atrasado',
    });
    expect(store.getState().activeJobs.get('audio-preview')?.id).toBe(72);

    emit({
      kind: 'job',
      id: 72,
      type: 'audio-preview',
      state: 'done',
      result: {
        outputRel: 'edit/audio-preview.m4a',
        beforeOutputRel: 'edit/audio-preview-before.m4a',
        durationS: 7.01,
        expectedDurationS: 7,
        editHash: 'hash-0',
        semanticKey: audioPreviewSemanticKey(doc),
      },
    });

    expect(store.getState().activeJobs.has('audio-preview')).toBe(false);
    expect(store.getState().audioPreviewVersion).toBe(1);
  });

  it('discards a reconnect GET captured before a newer terminal event', async () => {
    let resolveReconnect: (project: ProjectInfo) => void = () => undefined;
    const { store, emit, getProject } = await makeStore();
    emit({ kind: 'jobs-snapshot', jobs: [] });
    emit({ kind: 'job', id: 71, type: 'audio-preview', state: 'running' });
    const reconnectProject = new Promise<ProjectInfo>((resolve) => {
      resolveReconnect = resolve;
    });
    getProject.mockReturnValueOnce(reconnectProject);

    emit({
      kind: 'jobs-snapshot',
      jobs: [{ kind: 'job', id: 71, type: 'audio-preview', state: 'running' }],
    });
    emit(audioPreviewDone);
    resolveReconnect(projectWith(doc));
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getState().project).toMatchObject({
      hasAudioPreview: true,
      hasAudioComparison: true,
      audioPreviewEditHash: 'hash-0',
    });
    expect(store.getState().audioPreviewVersion).toBe(1);
  });

  it('keeps the newest reconciliation when two reconnect GETs resolve out of order', async () => {
    let resolveOlder: (project: ProjectInfo) => void = () => undefined;
    let resolveNewer: (project: ProjectInfo) => void = () => undefined;
    const { store, emit, getProject } = await makeStore();
    emit({ kind: 'jobs-snapshot', jobs: [] });

    const olderProject = new Promise<ProjectInfo>((resolve) => {
      resolveOlder = resolve;
    });
    const newerProject = new Promise<ProjectInfo>((resolve) => {
      resolveNewer = resolve;
    });
    getProject.mockReturnValueOnce(olderProject).mockReturnValueOnce(newerProject);

    emit({
      kind: 'jobs-snapshot',
      jobs: [{ kind: 'job', id: 71, type: 'audio-preview', state: 'running' }],
    });
    emit({ kind: 'jobs-snapshot', jobs: [] });

    resolveNewer({
      ...projectWith(doc),
      hasAudioPreview: true,
      hasAudioComparison: true,
      audioPreviewEditHash: 'hash-0',
      audioPreviewCurrent: true,
    });
    await vi.waitFor(() => {
      expect(store.getState().project?.hasAudioComparison).toBe(true);
    });

    resolveOlder(projectWith(doc));
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getState().project?.hasAudioComparison).toBe(true);
    expect(store.getState().audioPreviewVersion).toBe(1);
  });

  it('reuses the guarded reconnect project instead of opening an unguarded reload GET', async () => {
    const { store, emit, getProject } = await makeStore();
    emit({ kind: 'jobs-snapshot', jobs: [] });
    getProject.mockResolvedValueOnce({
      ...projectWith({ ...doc, output: { ...doc.output, loudnormLufs: -12 } }),
      editHash: 'hash-external',
    });

    emit({ kind: 'jobs-snapshot', jobs: [] });
    await vi.waitFor(() => {
      expect(store.getState().project?.editHash).toBe('hash-external');
    });

    // Initial load + the guarded reconciliation response: no second GET.
    expect(getProject).toHaveBeenCalledTimes(2);
    emit({
      kind: 'job',
      id: 72,
      type: 'audio-preview',
      state: 'done',
      result: {
        outputRel: 'edit/audio-preview.m4a',
        beforeOutputRel: 'edit/audio-preview-before.m4a',
        durationS: 7.01,
        expectedDurationS: 7,
        editHash: 'hash-external',
        semanticKey: audioPreviewSemanticKey({
          ...doc,
          output: { ...doc.output, loudnormLufs: -12 },
        }),
      },
    });
    expect(store.getState().project).toMatchObject({
      hasAudioComparison: true,
      audioPreviewEditHash: 'hash-external',
    });
  });

  it('refreshes the visual baseline when reconnect discovers a completed preview', async () => {
    const staleProject: ProjectInfo = {
      ...projectWith(doc),
      hasPreview: true,
      previewEditHash: 'hash-stale',
    };
    const projectGetter = vi
      .fn<() => Promise<ProjectInfo>>()
      .mockResolvedValueOnce(staleProject)
      .mockResolvedValueOnce({ ...staleProject, previewEditHash: 'hash-0' });
    const { store, emit } = await makeStore({ getProject: projectGetter });
    emit({ kind: 'jobs-snapshot', jobs: [] });
    emit({ kind: 'jobs-snapshot', jobs: [] });
    await vi.waitFor(() => {
      expect(store.getState().previewOutdated).toBe(false);
    });
    expect(projectGetter).toHaveBeenCalledTimes(2);

    store.setLoudnormLufs(-12);
    expect(store.getState().previewOutdated).toBe(true);
  });

  it('preserves a current preview baseline across reconnect while an audio edit is dirty', async () => {
    const currentProject: ProjectInfo = {
      ...projectWith(doc),
      hasPreview: true,
      previewEditHash: 'hash-0',
      hasAudioPreview: true,
      hasAudioComparison: true,
      audioPreviewEditHash: 'hash-0',
      audioPreviewCurrent: true,
    };
    const projectGetter = vi.fn(() => Promise.resolve(currentProject));
    const { store, emit } = await makeStore({ getProject: projectGetter });
    emit({ kind: 'jobs-snapshot', jobs: [] });

    store.setLoudnormLufs(-12);
    expect(store.getState().dirty).toBe(true);
    emit({ kind: 'jobs-snapshot', jobs: [] });
    await vi.waitFor(() => {
      expect(projectGetter).toHaveBeenCalledTimes(2);
    });

    store.undo();
    expect(store.getState().previewOutdated).toBe(false);
    expect(store.getState().audioPreviewOutdated).toBe(false);
  });

  it('adopts a newly current receipt as baseline while the local audio edit is dirty', async () => {
    const staleProject: ProjectInfo = {
      ...projectWith(doc),
      hasPreview: true,
      previewEditHash: 'hash-stale',
      hasAudioPreview: true,
      hasAudioComparison: true,
      audioPreviewEditHash: 'hash-stale',
    };
    const currentReceipts: ProjectInfo = {
      ...staleProject,
      previewEditHash: 'hash-0',
      audioPreviewEditHash: 'hash-0',
      audioPreviewCurrent: true,
    };
    const projectGetter = vi
      .fn<() => Promise<ProjectInfo>>()
      .mockResolvedValueOnce(staleProject)
      .mockResolvedValueOnce(currentReceipts);
    const { store, emit } = await makeStore({ getProject: projectGetter });
    emit({ kind: 'jobs-snapshot', jobs: [] });

    store.setLoudnormLufs(-12);
    emit({ kind: 'jobs-snapshot', jobs: [] });
    await vi.waitFor(() => {
      expect(projectGetter).toHaveBeenCalledTimes(2);
    });

    store.undo();
    expect(store.getState().previewOutdated).toBe(false);
    expect(store.getState().audioPreviewOutdated).toBe(false);
  });

  it('keeps a pending visual auto-preview across reconnect when no artifact exists', async () => {
    const { store, emit, getProject } = await makeStore();
    emit({ kind: 'jobs-snapshot', jobs: [] });

    store.setOutputSpeed(1.1);
    await expect(store.flushSave()).resolves.toBe(true);
    const savedDoc = store.getState().doc;
    expect(savedDoc).not.toBeNull();
    getProject.mockResolvedValueOnce({
      ...projectWith(savedDoc ?? doc),
      editHash: 'hash-1',
      hasPreview: false,
    });

    emit({ kind: 'jobs-snapshot', jobs: [] });
    await vi.waitFor(() => {
      expect(getProject).toHaveBeenCalledTimes(2);
    });

    expect(store.getState().previewOutdated).toBe(true);
    expect(store.shouldAutoPreviewCurrentDoc()).toBe(true);
  });
});

describe('EditorStore audio preview auto refresh', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces a burst of audio-control changes into one save and one job', async () => {
    vi.useFakeTimers();
    const { store, putEdit, startAudioPreview } = await makeStore();

    store.setDenoise(0.2);
    store.setDenoise(0.45);
    store.setJoinAudioCrossfadeMs(20);
    expect(store.getState().audioPreviewRefreshState).toBe('debouncing');

    await vi.advanceTimersByTimeAsync(699);
    expect(startAudioPreview).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(putEdit).toHaveBeenCalledTimes(1);
    expect(startAudioPreview).toHaveBeenCalledTimes(1);
  });

  it('does not schedule an audio proof for unrelated output changes', async () => {
    vi.useFakeTimers();
    const { store, startAudioPreview } = await makeStore();

    store.setOutputSize(720, 1280);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(startAudioPreview).not.toHaveBeenCalled();
    expect(store.getState().audioPreviewRefreshState).toBe('idle');
  });

  it.each([
    [
      'gain',
      (store: EditorStore) => {
        store.setAudioBlockGain('audio-1', 0, -6);
      },
    ],
    [
      'fade',
      (store: EditorStore) => {
        store.setAudioBlockFades('audio-1', 0, { fadeInS: 0.4 });
      },
    ],
    [
      'mute',
      (store: EditorStore) => {
        store.setTrackMuted('audio-1', true);
      },
    ],
  ] as const)('refreshes the A/B proof after an audio-track %s edit', async (_name, mutate) => {
    vi.useFakeTimers();
    const { store, startAudioPreview } = await makeStore({
      getProject: () => Promise.resolve({ ...projectWith(audioDoc), media: [audioMedia] }),
    });

    mutate(store);
    expect(store.getState().audioPreviewRefreshState).toBe('debouncing');
    await vi.advanceTimersByTimeAsync(699);
    expect(startAudioPreview).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(startAudioPreview).toHaveBeenCalledTimes(1);
  });

  it('refreshes the A/B proof when an audible edit is undone and redone', async () => {
    vi.useFakeTimers();
    const { store, startAudioPreview } = await makeStore({
      getProject: () => Promise.resolve({ ...projectWith(audioDoc), media: [audioMedia] }),
    });

    store.setAudioBlockGain('audio-1', 0, -6);
    await vi.advanceTimersByTimeAsync(700);
    expect(startAudioPreview).toHaveBeenCalledTimes(1);

    store.undo();
    expect(store.getState().audioPreviewRefreshState).toBe('debouncing');
    await vi.advanceTimersByTimeAsync(700);
    expect(startAudioPreview).toHaveBeenCalledTimes(2);

    store.redo();
    expect(store.getState().audioPreviewRefreshState).toBe('debouncing');
    await vi.advanceTimersByTimeAsync(700);
    expect(startAudioPreview).toHaveBeenCalledTimes(3);
  });

  it('queues one replacement when controls change during an audio job', async () => {
    vi.useFakeTimers();
    const { store, emit, startAudioPreview } = await makeStore();
    emit({ kind: 'job', id: 70, type: 'audio-preview', state: 'running' });

    store.setDenoise(0.35);
    store.setLoudnormLufs(-12);
    await vi.advanceTimersByTimeAsync(700);
    expect(startAudioPreview).not.toHaveBeenCalled();
    expect(store.getState().audioPreviewRefreshState).toBe('queued');

    emit({
      kind: 'job',
      id: 70,
      type: 'audio-preview',
      state: 'done',
      result: {
        outputRel: 'edit/audio-preview.m4a',
        beforeOutputRel: 'edit/audio-preview-before.m4a',
        durationS: 7.01,
        expectedDurationS: 7,
        editHash: 'hash-0',
        semanticKey: audioPreviewSemanticKey(doc),
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(startAudioPreview).toHaveBeenCalledTimes(1);
  });

  it('reconciles a terminal event lost during SSE reconnect and resumes the queued proof', async () => {
    vi.useFakeTimers();
    const { store, emit, startAudioPreview, getProject } = await makeStore();
    emit({ kind: 'jobs-snapshot', jobs: [] });
    emit({ kind: 'job', id: 70, type: 'audio-preview', state: 'running' });

    store.setDenoise(0.35);
    await vi.advanceTimersByTimeAsync(700);
    expect(store.getState().audioPreviewRefreshState).toBe('queued');
    expect(startAudioPreview).not.toHaveBeenCalled();

    const savedDoc = store.getState().doc;
    expect(savedDoc).not.toBeNull();
    getProject.mockResolvedValueOnce({
      ...projectWith(savedDoc ?? doc),
      editHash: 'hash-1',
      hasAudioPreview: true,
      hasAudioComparison: true,
      audioPreviewEditHash: 'hash-1',
      audioPreviewCurrent: true,
    });

    // Reconnection snapshot is authoritative: the missing job completed while
    // EventSource was offline, so no terminal event will ever arrive.
    emit({ kind: 'jobs-snapshot', jobs: [] });
    await vi.waitFor(() => {
      expect(store.getState().activeJobs.has('audio-preview')).toBe(false);
      expect(store.getState().audioPreviewOutdated).toBe(false);
      expect(startAudioPreview).toHaveBeenCalledTimes(1);
    });
  });
});

describe('EditorStore render done', () => {
  it('records lastRender and flips hasFinal on a final render result', async () => {
    const { store, emit } = await makeStore();
    emit({
      kind: 'job',
      type: 'render',
      state: 'done',
      result: {
        outputRel: 'edit/final.mp4',
        outputAbs: '/x/edit/final.mp4',
        durationS: 42.3,
        editHash: 'hash-0',
        canonical: true,
        kind: 'final',
        programKey: 'program-key-0',
      },
    } as ServerEvent);
    expect(store.getState().lastRender).toEqual({ outputRel: 'edit/final.mp4', durationS: 42.3 });
    expect(store.getState().project?.hasFinal).toBe(true);
  });

  it('a final export never marks the rendered preview fresh or bumps its cache version', async () => {
    const project: ProjectInfo = {
      ...projectWith(doc),
      hasPreview: true,
      previewEditHash: 'hash-0',
    };
    const { store, emit } = await makeStore({ getProject: () => Promise.resolve(project) });
    store.setDenoise(0.35);
    const previewVersion = store.getState().previewVersion;

    emit({
      kind: 'job',
      type: 'render',
      state: 'done',
      result: {
        outputRel: 'edit/final.mp4',
        outputAbs: '/x/edit/final.mp4',
        durationS: 42.3,
        editHash: 'hash-0',
        canonical: true,
        kind: 'final',
        programKey: 'program-key-0',
      },
    } as ServerEvent);

    expect(store.getState().previewOutdated).toBe(true);
    expect(store.getState().previewVersion).toBe(previewVersion);
    expect(store.getState().finalVersion).toBe(1);
  });

  it('ignores a malformed render result payload', async () => {
    const { store, emit } = await makeStore();
    emit({
      kind: 'job',
      type: 'render',
      state: 'done',
      result: { wrong: true },
    } as ServerEvent);
    expect(store.getState().lastRender).toBeNull();
  });
});

describe('EditorStore clean-captions export', () => {
  it('records lastRender for a final the receipt does not call canonical', async () => {
    const { store, emit } = await makeStore();

    emit({
      kind: 'job',
      type: 'render',
      state: 'done',
      result: {
        outputRel: 'edit/final.mp4',
        outputAbs: '/x/edit/final.mp4',
        durationS: 5.1,
        editHash: 'hash-0',
        canonical: false,
        kind: 'final',
        programKey: 'program-key-0',
        deliveryPath: '/deliveries/AP04.mp4',
        deliveryName: 'AP04.mp4',
      },
    } as ServerEvent);

    expect(store.getState().lastRender).toEqual({
      outputRel: 'edit/final.mp4',
      durationS: 5.1,
      deliveryPath: '/deliveries/AP04.mp4',
      deliveryName: 'AP04.mp4',
    });
    expect(store.getState().project?.hasFinal).toBe(true);
  });
});

describe('EditorStore preview reveal', () => {
  afterEach(() => {
    playhead.setPlaying(false);
  });

  const previewDone = {
    kind: 'job',
    type: 'render',
    state: 'done',
    result: {
      outputRel: 'edit/preview.mp4',
      outputAbs: '/x/edit/preview.mp4',
      durationS: 5.1,
      editHash: 'hash-0',
      canonical: true,
      kind: 'preview',
      programKey: 'program-key-0',
    },
  } as ServerEvent;

  it('records lastPreviewRender and flips hasPreview on any preview render result', async () => {
    const { store, emit } = await makeStore();
    emit(previewDone);
    expect(store.getState().lastPreviewRender).toEqual({
      outputRel: 'edit/preview.mp4',
      durationS: 5.1,
    });
    expect(store.getState().project?.hasPreview).toBe(true);
  });

  it('keeps an override preview stale immediately in the active session', async () => {
    const { store, emit } = await makeStore();
    emit({
      kind: 'job',
      type: 'render',
      state: 'done',
      result: {
        outputRel: 'edit/preview.mp4',
        durationS: 5.1,
        editHash: 'hash-0',
        canonical: false,
        kind: 'preview',
        programKey: 'program-key-0',
      },
    } as ServerEvent);

    expect(store.getState().previewOutdated).toBe(true);
    expect(store.getState().previewViewerOpen).toBe(false);
    expect(store.getState().lastPreviewRender).toBeNull();
    expect(store.getState().project?.hasPreview).toBe(true);
    expect(store.getState().project?.previewEditHash).toBeNull();
  });

  it('does not auto-open the viewer for a preview render nobody requested (the silent auto-preview)', async () => {
    const { store, emit } = await makeStore();
    emit(previewDone);
    expect(store.getState().previewViewerOpen).toBe(false);
  });

  it('auto-opens the viewer for a user-requested preview render while paused', async () => {
    const { store, emit } = await makeStore();
    playhead.setPlaying(false);
    store.requestPreviewRender();
    emit(previewDone);
    expect(store.getState().previewViewerOpen).toBe(true);
  });

  it('keeps a preview outdated when the edit changes while that render is running', async () => {
    const { store, emit } = await makeStore();
    store.requestPreviewRender();
    emit({ kind: 'job', type: 'render', state: 'running' } as ServerEvent);
    store.setDenoise(0.4);

    emit(previewDone);

    expect(store.getState().previewOutdated).toBe(true);
    expect(store.getState().previewViewerOpen).toBe(false);
    expect(store.getState().previewVersion).toBe(1);
  });

  it('keeps the viewer closed (toast only) for a user-requested preview render while playing', async () => {
    const { store, emit } = await makeStore();
    playhead.setPlaying(true);
    store.requestPreviewRender();
    emit(previewDone);
    expect(store.getState().previewViewerOpen).toBe(false);
    expect(store.getState().lastPreviewRender).not.toBeNull();
  });

  it('the request flag is one-shot — a later preview render without a fresh request stays closed', async () => {
    const { store, emit } = await makeStore();
    store.requestPreviewRender();
    emit(previewDone);
    expect(store.getState().previewViewerOpen).toBe(true);
    store.setPreviewViewerOpen(false);

    emit(previewDone);
    expect(store.getState().previewViewerOpen).toBe(false);
  });

  it('starting a new render clears the previous preview reveal state', async () => {
    const { store, emit } = await makeStore();
    store.requestPreviewRender();
    emit(previewDone);
    expect(store.getState().lastPreviewRender).not.toBeNull();

    emit({ kind: 'job', type: 'render', state: 'running' } as ServerEvent);
    expect(store.getState().lastPreviewRender).toBeNull();
    expect(store.getState().previewViewerOpen).toBe(false);
  });

  it('dismissLastPreviewRender clears both the banner and the viewer', async () => {
    const { store, emit } = await makeStore();
    store.requestPreviewRender();
    emit(previewDone);

    store.dismissLastPreviewRender();

    expect(store.getState().lastPreviewRender).toBeNull();
    expect(store.getState().previewViewerOpen).toBe(false);
  });

  it('a failed render clears the request flag — a later unrelated preview must not inherit it', async () => {
    const { store, emit } = await makeStore();
    store.requestPreviewRender();
    emit({ kind: 'job', type: 'render', state: 'error', error: 'ffmpeg crashed' } as ServerEvent);

    // No request was made for THIS preview render (e.g. the silent auto-preview) —
    // the flag from the earlier, now-failed attempt must not leak into it.
    emit(previewDone);
    expect(store.getState().previewViewerOpen).toBe(false);
  });

  it('a final export consumes the flag too, so a later unrelated preview cannot inherit it', async () => {
    const { store, emit } = await makeStore();
    store.requestPreviewRender();
    emit({
      kind: 'job',
      type: 'render',
      state: 'done',
      result: {
        outputRel: 'edit/final.mp4',
        outputAbs: '/x/edit/final.mp4',
        durationS: 42.3,
        editHash: 'hash-0',
        canonical: true,
        kind: 'final',
        programKey: 'program-key-0',
      },
    } as ServerEvent);

    emit(previewDone);
    expect(store.getState().previewViewerOpen).toBe(false);
  });
});

describe('EditorStore multi-selection (blocks)', () => {
  async function makeMultiStore(overrides: Partial<StoreBackend> = {}) {
    return makeStore({ getProject: () => Promise.resolve(projectWith(multiDoc)), ...overrides });
  }

  it('toggleSelect adds extras, removes an extra, and promotes the next extra when the primary is toggled off', async () => {
    const { store } = await makeMultiStore();
    store.select({ trackId: 'base', blockIndex: 0 });

    store.toggleSelect({ trackId: 'base', blockIndex: 1 });
    expect(store.getState().selection).toEqual({ trackId: 'base', blockIndex: 1 });
    expect(store.getState().extraSelections).toEqual([{ trackId: 'base', blockIndex: 0 }]);

    store.toggleSelect({ trackId: 'base', blockIndex: 2 });
    expect(store.getState().selection).toEqual({ trackId: 'base', blockIndex: 2 });
    expect(store.getState().extraSelections).toEqual([
      { trackId: 'base', blockIndex: 0 },
      { trackId: 'base', blockIndex: 1 },
    ]);

    // toggling an extra off removes it and keeps the primary untouched
    store.toggleSelect({ trackId: 'base', blockIndex: 0 });
    expect(store.getState().selection).toEqual({ trackId: 'base', blockIndex: 2 });
    expect(store.getState().extraSelections).toEqual([{ trackId: 'base', blockIndex: 1 }]);

    // toggling the primary off promotes the first extra
    store.toggleSelect({ trackId: 'base', blockIndex: 2 });
    expect(store.getState().selection).toEqual({ trackId: 'base', blockIndex: 1 });
    expect(store.getState().extraSelections).toEqual([]);

    // toggling the last remaining selection off leaves nothing selected
    store.toggleSelect({ trackId: 'base', blockIndex: 1 });
    expect(store.getState().selection).toBeNull();
    expect(store.getState().extraSelections).toEqual([]);
  });

  it('rangeSelect on the same track selects the contiguous run and keeps the primary', async () => {
    const { store } = await makeMultiStore();
    store.select({ trackId: 'base', blockIndex: 1 });
    store.rangeSelect({ trackId: 'base', blockIndex: 3 });
    expect(store.getState().selection).toEqual({ trackId: 'base', blockIndex: 1 });
    expect(store.getState().extraSelections).toEqual([
      { trackId: 'base', blockIndex: 2 },
      { trackId: 'base', blockIndex: 3 },
    ]);
  });

  it('rangeSelect across a different track falls back to a plain select', async () => {
    const { store } = await makeMultiStore();
    store.select({ trackId: 'base', blockIndex: 0 });
    store.rangeSelect({ trackId: 'overlays', blockIndex: 1 });
    expect(store.getState().selection).toEqual({ trackId: 'overlays', blockIndex: 1 });
    expect(store.getState().extraSelections).toEqual([]);
  });

  it('rangeSelect with no primary falls back to a plain select', async () => {
    const { store } = await makeMultiStore();
    store.rangeSelect({ trackId: 'base', blockIndex: 2 });
    expect(store.getState().selection).toEqual({ trackId: 'base', blockIndex: 2 });
    expect(store.getState().extraSelections).toEqual([]);
  });

  it('deleteSelectedBlock removes the primary and every extra across tracks in one undo step', async () => {
    const { store } = await makeMultiStore();
    store.select({ trackId: 'base', blockIndex: 1 });
    store.toggleSelect({ trackId: 'base', blockIndex: 3 });
    store.toggleSelect({ trackId: 'overlays', blockIndex: 0 });
    const undoDepthBefore = store.getState().undoDepth;

    store.deleteSelectedBlock();

    const tracksAfter = store.getState().doc?.tracks ?? [];
    const baseAfter = tracksAfter.find((t) => t.id === 'base');
    const overlaysAfter = tracksAfter.find((t) => t.id === 'overlays');
    expect(baseAfter?.blocks).toEqual([
      { source: 'cam', in: 0, out: 2 },
      { source: 'cam', in: 4, out: 6 },
    ]);
    expect(overlaysAfter?.blocks).toEqual([{ file: 'logo2.png', at: 3, duration: 2 }]);
    expect(store.getState().selection).toBeNull();
    expect(store.getState().extraSelections).toEqual([]);
    expect(store.getState().undoDepth).toBe(undoDepthBefore + 1);

    store.undo();
    const tracksRestored = store.getState().doc?.tracks ?? [];
    expect(tracksRestored.find((t) => t.id === 'base')?.blocks.length).toBe(4);
    expect(tracksRestored.find((t) => t.id === 'overlays')?.blocks.length).toBe(2);
  });

  it('deleteSelectedBlock with no selection is a no-op', async () => {
    const { store } = await makeMultiStore();
    const undoDepthBefore = store.getState().undoDepth;
    store.deleteSelectedBlock();
    expect(store.getState().undoDepth).toBe(undoDepthBefore);
  });

  it('splitAtPlayhead clears the extras — a split shifts every later block index', async () => {
    const { store } = await makeMultiStore();
    store.select({ trackId: 'base', blockIndex: 0 });
    store.toggleSelect({ trackId: 'base', blockIndex: 1 });
    expect(store.getState().extraSelections).toEqual([{ trackId: 'base', blockIndex: 0 }]);

    store.splitAtPlayhead(5); // lands inside base block index 2 (4s–6s)

    expect(store.getState().doc?.tracks.find((t) => t.id === 'base')?.blocks.length).toBe(5);
    expect(store.getState().extraSelections).toEqual([]);
  });

  it('reorderBaseBlock clears the extras — the whole track gets reshuffled', async () => {
    const { store } = await makeMultiStore();
    store.select({ trackId: 'base', blockIndex: 0 });
    store.toggleSelect({ trackId: 'base', blockIndex: 1 });
    expect(store.getState().extraSelections).toEqual([{ trackId: 'base', blockIndex: 0 }]);

    store.reorderBaseBlock(0, 7); // drag block 0 past the others

    expect(store.getState().extraSelections).toEqual([]);
  });

  it('undo/redo clear stale extras without touching the primary selection', async () => {
    const { store } = await makeMultiStore();
    store.select({ trackId: 'base', blockIndex: 0 });
    store.toggleSelect({ trackId: 'base', blockIndex: 1 });
    store.hideSubtitleRange('cam', 1, 2); // an unrelated doc edit, to give undo() something to do
    expect(store.getState().extraSelections).toEqual([{ trackId: 'base', blockIndex: 0 }]);

    store.undo();
    expect(store.getState().extraSelections).toEqual([]);
    expect(store.getState().selection).toEqual({ trackId: 'base', blockIndex: 1 });

    store.toggleSelect({ trackId: 'base', blockIndex: 2 });
    store.redo();
    expect(store.getState().extraSelections).toEqual([]);
  });
});

describe('EditorStore autoPreview', () => {
  it('defaults to on and setAutoPreview toggles the flag (localStorage may be absent in this environment)', async () => {
    const { store } = await makeStore();
    expect(store.getState().autoPreview).toBe(true);
    store.setAutoPreview(false);
    expect(store.getState().autoPreview).toBe(false);
    store.setAutoPreview(true);
    expect(store.getState().autoPreview).toBe(true);
  });

  it('is fresh at boot when the rendered program key matches, outdated after a cut, fresh again after undo', async () => {
    const fresh: ProjectInfo = {
      ...projectWith(doc),
      hasProgram: true,
      programKey: programKey(doc),
    };
    const { store } = await makeStore({ getProject: () => Promise.resolve(fresh) });
    expect(store.getState().programOutdated).toBe(false);
    expect(store.shouldAutoPreviewCurrentDoc()).toBe(false);

    store.setOutputSpeed(1.1);
    expect(store.getState().programOutdated).toBe(true);
    expect(store.shouldAutoPreviewCurrentDoc()).toBe(true);

    store.undo();
    expect(store.getState().programOutdated).toBe(false);
    expect(store.shouldAutoPreviewCurrentDoc()).toBe(false);
  });

  it.each([
    ['rendered from an older document', { hasProgram: true, programKey: 'program-key-older' }],
    ['never rendered', { hasProgram: false, programKey: null }],
    ['rendered but its file is gone', { hasProgram: false, programKey: programKey(doc) }],
  ])('is outdated at boot when the program was %s', async (_label, program) => {
    const { store } = await makeStore({
      getProject: () => Promise.resolve({ ...projectWith(doc), ...program }),
    });

    expect(store.getState().programOutdated).toBe(true);
    expect(store.shouldAutoPreviewCurrentDoc()).toBe(true);
  });

  it('leaves what the browser composes alone: subtitles and overlay geometry never invalidate the program', async () => {
    const fresh: ProjectInfo = {
      ...projectWith(multiDoc),
      hasProgram: true,
      programKey: programKey(multiDoc),
    };
    const { store } = await makeStore({ getProject: () => Promise.resolve(fresh) });

    store.setSubtitlePreset('3p-natural');
    store.updateOverlayBlock('overlays', 0, { at: 1, scale: 0.5 });

    expect(store.getState().dirty).toBe(true);
    expect(store.getState().programOutdated).toBe(false);
    expect(store.shouldAutoPreviewCurrentDoc()).toBe(false);
  });

  it('audio edits invalidate the program too — it carries the export audio chain', async () => {
    const fresh: ProjectInfo = {
      ...projectWith(audioDoc),
      media: [audioMedia],
      hasProgram: true,
      programKey: programKey(audioDoc),
    };
    const { store } = await makeStore({ getProject: () => Promise.resolve(fresh) });

    store.setAudioBlockGain('audio-1', 0, -6);

    expect(store.getState().programOutdated).toBe(true);
    expect(store.shouldAutoPreviewCurrentDoc()).toBe(true);
  });

  it('adopts a program render result: new key, bumped version, preview untouched', async () => {
    const { store, emit } = await makeStore();
    expect(store.getState().programOutdated).toBe(true);

    emit({
      kind: 'job',
      type: 'render',
      state: 'done',
      result: {
        outputRel: 'edit/program.mp4',
        outputAbs: '/x/edit/program.mp4',
        durationS: 7,
        editHash: 'hash-0',
        canonical: true,
        kind: 'program',
        programKey: programKey(doc),
      },
    } as ServerEvent);

    const state = store.getState();
    expect(state.programOutdated).toBe(false);
    expect(state.programVersion).toBe(1);
    expect(state.project).toMatchObject({ hasProgram: true, programKey: programKey(doc) });
    expect(state.previewOutdated).toBe(false);
    expect(state.previewVersion).toBe(0);
    expect(state.project?.hasPreview).toBe(false);
  });

  it('keeps the program outdated when the render result belongs to an older document', async () => {
    const { store, emit } = await makeStore();
    store.setOutputSpeed(1.1);

    emit({
      kind: 'job',
      type: 'render',
      state: 'done',
      result: {
        outputRel: 'edit/program.mp4',
        outputAbs: '/x/edit/program.mp4',
        durationS: 7,
        editHash: 'hash-0',
        canonical: true,
        kind: 'program',
        programKey: programKey(doc),
      },
    } as ServerEvent);

    expect(store.getState().programOutdated).toBe(true);
    expect(store.getState().project?.programKey).toBe(programKey(doc));
  });

  it('stops retrying after a failed render until the document moves past the failing projection', async () => {
    const { store, emit } = await makeStore();
    expect(store.shouldAutoPreviewCurrentDoc()).toBe(true);

    await store.startProgramRender(() => Promise.resolve({ id: 1 }));
    emit({ kind: 'job', type: 'render', state: 'running', id: 1 });
    emit({ kind: 'job', type: 'render', state: 'error', id: 1, error: 'no transcript' });
    expect(store.getState().programOutdated).toBe(true);
    expect(store.shouldAutoPreviewCurrentDoc()).toBe(false);

    store.setSubtitlePreset('3p-natural');
    expect(store.shouldAutoPreviewCurrentDoc()).toBe(false);

    store.setOutputSpeed(1.1);
    expect(store.shouldAutoPreviewCurrentDoc()).toBe(true);
  });

  it('blames a failed background render on the projection it asked for, not on an edit made meanwhile', async () => {
    const { store, emit } = await makeStore();
    await store.startProgramRender(() => Promise.resolve({ id: 1 }));
    emit({ kind: 'job', type: 'render', state: 'running', id: 1 });
    store.setOutputSpeed(1.1);

    emit({ kind: 'job', type: 'render', state: 'error', id: 1, error: 'no transcript' });
    expect(store.shouldAutoPreviewCurrentDoc()).toBe(true);

    store.undo();
    expect(store.shouldAutoPreviewCurrentDoc()).toBe(false);
  });

  it('never blames the program for a failed user preview or export', async () => {
    const { store, emit } = await makeStore();
    store.requestPreviewRender();
    emit({ kind: 'job', type: 'render', state: 'running', id: 1 });

    emit({ kind: 'job', type: 'render', state: 'error', id: 1, error: 'overlay bake failed' });

    expect(store.shouldAutoPreviewCurrentDoc()).toBe(true);
  });

  it('still blames a background render that only surfaced through the jobs snapshot', async () => {
    const { store, emit } = await makeStore();
    await store.startProgramRender(() => Promise.resolve({ id: 1 }));
    emit({
      kind: 'jobs-snapshot',
      jobs: [{ kind: 'job', id: 1, type: 'render', state: 'running' }],
    });

    emit({ kind: 'job', type: 'render', state: 'error', id: 1, error: 'no transcript' });

    expect(store.shouldAutoPreviewCurrentDoc()).toBe(false);
  });

  it.each([
    [
      'without kind and programKey',
      {
        outputRel: 'edit/program.mp4',
        outputAbs: '/x/edit/program.mp4',
        durationS: 7,
        editHash: 'hash-0',
        canonical: true,
      },
    ],
    [
      'with an unknown kind, even on the preview path',
      {
        outputRel: 'edit/preview.mp4',
        outputAbs: '/x/edit/preview.mp4',
        durationS: 7,
        editHash: 'hash-0',
        canonical: true,
        kind: 'bogus',
        programKey: 'program-key-0',
      },
    ],
    [
      'with a non-string programKey',
      {
        outputRel: 'edit/program.mp4',
        outputAbs: '/x/edit/program.mp4',
        durationS: 7,
        editHash: 'hash-0',
        canonical: true,
        kind: 'program',
        programKey: 1,
      },
    ],
  ])('ignores a render result %s', async (_label, result) => {
    const { store, emit } = await makeStore();

    emit({ kind: 'job', type: 'render', state: 'done', id: 1, result });

    const state = store.getState();
    expect(state.activeJobs.has('render')).toBe(false);
    expect(state.programVersion).toBe(0);
    expect(state.previewVersion).toBe(0);
    expect(state.project).toMatchObject({ hasProgram: false, hasPreview: false });
  });

  it('recomputes program freshness on a conflict and keeps it after keepMine', async () => {
    const serverDoc: EditDoc = { ...doc, output: { ...doc.output, speed: 1.5 } };
    const projectGetter = vi
      .fn<() => Promise<ProjectInfo>>()
      .mockResolvedValueOnce({ ...projectWith(doc), hasProgram: true, programKey: programKey(doc) })
      .mockResolvedValue({
        ...projectWith(serverDoc),
        editHash: 'hash-agent',
        hasProgram: true,
        programKey: programKey(serverDoc),
      });
    const { store, emit } = await makeStore({ getProject: projectGetter });
    emit({ kind: 'jobs-snapshot', jobs: [] });
    store.setSubtitlePreset('3p-natural');
    expect(store.getState().programOutdated).toBe(false);

    emit({ kind: 'jobs-snapshot', jobs: [] });
    await vi.waitFor(() => {
      expect(store.getState().conflict).toBe(true);
    });
    expect(store.getState().programOutdated).toBe(true);
    expect(store.getState().programVersion).toBe(1);

    // keepMine re-reads the project; by then the program was rendered from a
    // document whose projection equals the local one (subtitles are not in it)
    projectGetter.mockResolvedValueOnce({
      ...projectWith(serverDoc),
      editHash: 'hash-agent',
      hasProgram: true,
      programKey: programKey(doc),
    });
    store.keepMine();
    await vi.waitFor(() => {
      expect(store.getState().conflict).toBe(false);
    });
    expect(store.getState().programOutdated).toBe(false);
    expect(store.getState().project?.programKey).toBe(programKey(doc));
  });

  it.each([
    ['fresh for the reloaded document', (serverDoc: EditDoc) => programKey(serverDoc), false],
    ['rendered from yet another document', () => 'program-key-elsewhere', true],
  ])(
    'a clean reload adopts the server program (%s) and bumps programVersion once',
    async (_label, keyOf, outdated) => {
      const serverDoc: EditDoc = { ...doc, output: { ...doc.output, speed: 1.5 } };
      const reloaded: ProjectInfo = {
        ...projectWith(serverDoc),
        editHash: 'hash-agent',
        hasProgram: true,
        programKey: keyOf(serverDoc),
      };
      const projectGetter = vi
        .fn<() => Promise<ProjectInfo>>()
        .mockResolvedValueOnce(projectWith(doc))
        .mockResolvedValue(reloaded);
      const { store, emit } = await makeStore({ getProject: projectGetter });
      emit({ kind: 'jobs-snapshot', jobs: [] });

      emit({ kind: 'jobs-snapshot', jobs: [] });
      await vi.waitFor(() => {
        expect(store.getState().doc).toEqual(serverDoc);
      });
      expect(store.getState().conflict).toBe(false);
      expect(store.getState().programOutdated).toBe(outdated);
      expect(store.getState().programVersion).toBe(1);

      emit({ kind: 'jobs-snapshot', jobs: [] });
      await vi.waitFor(() => {
        expect(projectGetter).toHaveBeenCalledTimes(3);
      });
      expect(store.getState().programVersion).toBe(1);
    },
  );

  it('forgets the program request when the server refuses it, so a later user render is not blamed', async () => {
    const { store, emit } = await makeStore();
    await expect(
      store.startProgramRender(() => Promise.reject(new Error('render_in_progress'))),
    ).rejects.toThrow('render_in_progress');

    emit({ kind: 'job', type: 'render', state: 'running', id: 1 });
    emit({ kind: 'job', type: 'render', state: 'error', id: 1, error: 'overlay bake failed' });

    expect(store.shouldAutoPreviewCurrentDoc()).toBe(true);
  });

  it('a user preview request supersedes a pending program request', async () => {
    const { store, emit } = await makeStore();
    await store.startProgramRender(() => Promise.resolve({ id: 1 }));
    store.requestPreviewRender();

    emit({ kind: 'job', type: 'render', state: 'running', id: 2 });
    emit({ kind: 'job', type: 'render', state: 'error', id: 2, error: 'overlay bake failed' });

    expect(store.shouldAutoPreviewCurrentDoc()).toBe(true);
  });

  it('does not bump programVersion for a render that finished while disconnected unless the key changed', async () => {
    const { store, emit, getProject } = await makeStore();
    emit({
      kind: 'jobs-snapshot',
      jobs: [{ kind: 'job', id: 1, type: 'render', state: 'running' }],
    });

    emit({ kind: 'jobs-snapshot', jobs: [] });
    await vi.waitFor(() => {
      expect(getProject).toHaveBeenCalledTimes(2);
    });

    expect(store.getState().programVersion).toBe(0);
  });

  it('never starts a render for an empty base track', async () => {
    const empty: EditDoc = {
      ...doc,
      tracks: [{ id: 'base', kind: 'video', blocks: [] }],
      totalDurationS: 0,
    };
    const { store } = await makeStore({ getProject: () => Promise.resolve(projectWith(empty)) });

    expect(store.getState().programOutdated).toBe(true);
    expect(store.shouldAutoPreviewCurrentDoc()).toBe(false);
  });

  it('adopts a program discovered on reconnect and bumps programVersion once', async () => {
    const withoutProgram = projectWith(doc);
    const projectGetter = vi
      .fn<() => Promise<ProjectInfo>>()
      .mockResolvedValueOnce(withoutProgram)
      .mockResolvedValueOnce({ ...withoutProgram, hasProgram: true, programKey: programKey(doc) });
    const { store, emit } = await makeStore({ getProject: projectGetter });
    emit({ kind: 'jobs-snapshot', jobs: [] });
    expect(store.getState().programVersion).toBe(0);

    emit({ kind: 'jobs-snapshot', jobs: [] });
    await vi.waitFor(() => {
      expect(store.getState().programOutdated).toBe(false);
    });
    expect(store.getState().programVersion).toBe(1);
  });
});

describe('EditorStore selectBlockAtOutputTime', () => {
  it('selects the base block containing the given output time', async () => {
    const { store } = await makeStore({ getProject: () => Promise.resolve(projectWith(multiDoc)) });
    // multiDoc base blocks are 2s each: [0,2) [2,4) [4,6) [6,8)
    store.selectBlockAtOutputTime(5);
    expect(store.getState().selection).toEqual({ trackId: 'base', blockIndex: 2 });
  });

  it('clears the selection when no block covers the given output time', async () => {
    const { store } = await makeStore({ getProject: () => Promise.resolve(projectWith(multiDoc)) });
    store.select({ trackId: 'base', blockIndex: 0 });
    store.selectBlockAtOutputTime(999);
    expect(store.getState().selection).toBeNull();
  });
});

describe('EditorStore multi-selection (cues)', () => {
  const transcript: Transcript = {
    engine: 'scribe',
    text: 'um dois tres quatro',
    words: [
      { text: 'um', start: 0, end: 1, type: 'word' },
      { text: 'dois', start: 1, end: 2, type: 'word' },
      { text: 'tres', start: 2, end: 3, type: 'word' },
      { text: 'quatro', start: 3, end: 4, type: 'word' },
    ],
  };
  const cueA = { source: 'cam', wordStart: 0, wordEnd: 0 };
  const cueB = { source: 'cam', wordStart: 1, wordEnd: 1 };
  const cueC = { source: 'cam', wordStart: 2, wordEnd: 3 };
  const orderedCues = [cueA, cueB, cueC];

  it('toggleSelectCue adds, removes and promotes extras the same way as block selection', async () => {
    const { store } = await makeStore();
    store.selectCue(cueA);
    store.toggleSelectCue(cueB);
    expect(store.getState().selectedCue).toEqual(cueB);
    expect(store.getState().extraCues).toEqual([cueA]);

    store.toggleSelectCue(cueB);
    expect(store.getState().selectedCue).toEqual(cueA);
    expect(store.getState().extraCues).toEqual([]);
  });

  it('rangeSelectCue selects the contiguous span from the caller-supplied ordered list', async () => {
    const { store } = await makeStore();
    store.selectCue(cueA);
    store.rangeSelectCue(cueC, orderedCues);
    expect(store.getState().selectedCue).toEqual(cueA);
    expect(store.getState().extraCues).toEqual([cueB, cueC]);
  });

  it('hideCues resolves every cue via spokenWords and applies all ranges in a single applyDoc', async () => {
    const { store } = await makeStore({ getTranscript: () => Promise.resolve(transcript) });
    const undoDepthBefore = store.getState().undoDepth;

    store.hideCues([cueA, cueC], store.getState().transcripts);

    expect(store.getState().doc?.subtitles.hiddenRanges).toEqual([
      { source: 'cam', start: 0, end: 1 },
      { source: 'cam', start: 2, end: 4 },
    ]);
    expect(store.getState().undoDepth).toBe(undoDepthBefore + 1);
  });

  it('hideCues dedupes repeated cue identities into a single range (pill preset shares one identity across a word chunk)', async () => {
    const { store } = await makeStore({ getTranscript: () => Promise.resolve(transcript) });

    store.hideCues([cueA, cueA, cueA], store.getState().transcripts);

    expect(store.getState().doc?.subtitles.hiddenRanges).toEqual([
      { source: 'cam', start: 0, end: 1 },
    ]);
  });

  it('hideCues skips cues it cannot resolve and is a no-op when none resolve', async () => {
    const { store } = await makeStore(); // default backend has no transcripts loaded
    const undoDepthBefore = store.getState().undoDepth;

    store.hideCues([cueA], store.getState().transcripts);

    expect(store.getState().doc?.subtitles.hiddenRanges).toBeUndefined();
    expect(store.getState().undoDepth).toBe(undoDepthBefore);
  });
});

describe('EditorStore project media placement', () => {
  it('never routes a still image into timed base, video-layer, audio or video-background paths', async () => {
    const { store } = await makeStore({
      getProject: () => Promise.resolve({ ...projectWith(doc), media: [imageMedia] }),
    });
    const before = store.getState().doc;

    store.appendToBase('background.jpg');
    store.insertIntoBase('background.jpg', 1);
    store.addLayer('background.jpg', 0);
    store.addAudioClip('background.jpg', 0);
    store.setBackgroundVideo('background.jpg');

    expect(store.getState().doc).toBe(before);
    expect(store.getState().undoDepth).toBe(0);
  });

  it('inserts a dragged asset at the nearest cut boundary in the base sequence', async () => {
    const { store } = await makeStore();

    store.insertIntoBase('second-take.mp4', 4.1);

    const current = store.getState().doc;
    expect(current).not.toBeNull();
    const base = baseTrackOf(current ?? doc);
    expect(base.blocks.map((block) => block.source)).toEqual(['cam', 'second_take', 'cam']);
    expect(store.getState().selection).toEqual({ trackId: 'base', blockIndex: 1 });
  });

  it('adds a dragged asset to the requested layer track at the drop time', async () => {
    const { store } = await makeStore({
      getProject: () => Promise.resolve(projectWith(trackKindsDoc)),
    });

    store.addLayer('second-take.mp4', 2.5, 'layer-1');

    const layer = store.getState().doc?.tracks.find((track) => track.id === 'layer-1');
    expect(layer?.kind).toBe('video');
    expect(layer?.blocks).toHaveLength(2);
    expect(layer?.blocks[1]).toMatchObject({ source: 'second_take', at: 2.5 });
    expect(store.getState().selection).toEqual({ trackId: 'layer-1', blockIndex: 1 });
  });

  it('removes a layer block key when the patch value is undefined (swapped toggle-off)', async () => {
    const { store } = await makeStore({
      getProject: () => Promise.resolve(projectWith(trackKindsDoc)),
    });
    store.select({ trackId: 'layer-1', blockIndex: 0 });

    store.updateSelectedLayerBlock({ swapped: true });
    const layerOn = store.getState().doc?.tracks.find((track) => track.id === 'layer-1');
    expect(layerOn?.blocks[0]).toMatchObject({ swapped: true });

    store.updateSelectedLayerBlock({ swapped: undefined });
    const layerOff = store.getState().doc?.tracks.find((track) => track.id === 'layer-1');
    const block = layerOff?.blocks[0];
    expect(block !== undefined && 'swapped' in block).toBe(false);
    expect(block).toMatchObject({ mode: 'pip', position: 'bottom-left' });
  });

  it('creates a layer when media is dropped outside an existing video lane', async () => {
    const { store } = await makeStore();

    store.addLayer('second-take.mp4', 1.5);

    const layer = store.getState().doc?.tracks.find((track) => track.id === 'layer-1');
    expect(layer?.kind).toBe('video');
    expect(layer?.blocks[0]).toMatchObject({ source: 'second_take', at: 1.5 });
    expect(store.getState().selection).toEqual({ trackId: 'layer-1', blockIndex: 0 });
  });

  it('does not place an asset onto a locked destination track', async () => {
    const { store } = await makeStore({
      getProject: () => Promise.resolve(projectWith(trackKindsDoc)),
    });
    store.setTrackLocked('layer-1', true);
    const before = store.getState().doc;

    store.addLayer('second-take.mp4', 2.5, 'layer-1');

    expect(store.getState().doc).toBe(before);
  });
});

describe('EditorStore persisted media tracks', () => {
  it('creates collision-safe video/audio/effect ids at their kind boundaries', async () => {
    const collisionDoc: EditDoc = {
      ...mixedTrackOrderDoc,
      tracks: [
        { id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 4 }] },
        { id: 'layer-1', kind: 'video', blocks: [] },
        { id: 'layer-2', kind: 'video', blocks: [] },
        { id: 'audio-1', kind: 'audio', blocks: [] },
        { id: 'audio-2', kind: 'audio', blocks: [] },
        { id: 'layer-3', kind: 'overlay', blocks: [] },
        { id: 'audio-3', kind: 'overlay', blocks: [] },
        { id: 'effect-1', kind: 'effect', blocks: [] },
        { id: 'effect-2', kind: 'overlay', blocks: [] },
      ],
    };
    const { store } = await makeStore({
      getProject: () => Promise.resolve(projectWith(collisionDoc)),
    });

    expect(store.addEmptyTrack('video')).toBe('layer-4');
    expect(store.addEmptyTrack('audio')).toBe('audio-4');
    expect(store.addEmptyTrack('effect')).toBe('effect-3');

    expect(store.getState().doc?.tracks.map((track) => track.id)).toEqual([
      'base',
      'layer-1',
      'layer-2',
      'layer-4',
      'audio-1',
      'audio-2',
      'audio-4',
      'effect-1',
      'effect-3',
      'layer-3',
      'audio-3',
      'effect-2',
    ]);
    expect(store.getState().undoDepth).toBe(3);
  });

  it('removes empty audio, overlay and effect tracks as persisted edits', async () => {
    const { store } = await makeStore({
      getProject: () => Promise.resolve(projectWith(mixedTrackOrderDoc)),
    });

    store.removeTrack('audio-1');
    store.removeTrack('overlays');
    store.removeTrack('effects');

    expect(store.getState().doc?.tracks.map((track) => track.id)).toEqual([
      'base',
      'layer-1',
      'layer-2',
      'audio-2',
    ]);
    expect(store.getState()).toMatchObject({ dirty: true, undoDepth: 3, redoDepth: 0 });
  });

  it('removes a video layer as one persisted undoable edit', async () => {
    const { store, putEdit } = await makeStore({
      getProject: () => Promise.resolve(projectWith(trackKindsDoc)),
    });
    const originalLayer = trackKindsDoc.tracks.find((track) => track.id === 'layer-1');

    store.select({ trackId: 'layer-1', blockIndex: 0 });
    store.removeTrack('layer-1');

    expect(store.getState().doc?.tracks.some((track) => track.id === 'layer-1')).toBe(false);
    expect(store.getState().doc?.sources.pip).toEqual(trackKindsDoc.sources.pip);
    expect(store.getState().doc?.totalDurationS).toBe(trackKindsDoc.totalDurationS);
    expect(store.getState()).toMatchObject({
      dirty: true,
      selection: null,
      undoDepth: 1,
      redoDepth: 0,
    });

    await expect(store.flushSave()).resolves.toBe(true);
    expect(putEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        tracks: trackKindsDoc.tracks.filter((track) => track.id !== 'layer-1'),
      }),
      'hash-0',
    );

    store.undo();
    expect(store.getState().doc?.tracks.find((track) => track.id === 'layer-1')).toEqual(
      originalLayer,
    );
    store.select({ trackId: 'layer-1', blockIndex: 0 });
    store.redo();
    expect(store.getState().doc?.tracks.some((track) => track.id === 'layer-1')).toBe(false);
    expect(store.getState().selection).toBeNull();
  });

  it('does not create history when removing the base, a missing id, or a locked layer', async () => {
    const { store, putEdit } = await makeStore({
      getProject: () => Promise.resolve(projectWith(trackKindsDoc)),
    });
    const before = store.getState().doc;

    store.removeTrack('base');
    store.removeTrack('missing');
    store.setTrackLocked('layer-1', true);
    store.removeTrack('layer-1');

    expect(store.getState().doc).toBe(before);
    expect(store.getState()).toMatchObject({ dirty: false, undoDepth: 0, redoDepth: 0 });
    expect(putEdit).not.toHaveBeenCalled();
  });

  it('removes an unlocked layer without treating a locked sibling index shift as a reorder', async () => {
    const lockedSiblingDoc: EditDoc = {
      ...trackKindsDoc,
      tracks: [
        trackKindsDoc.tracks[0]!,
        trackKindsDoc.tracks[1]!,
        { id: 'layer-2', kind: 'video', blocks: [] },
        ...trackKindsDoc.tracks.slice(2),
      ],
    };
    const { store } = await makeStore({
      getProject: () => Promise.resolve(projectWith(lockedSiblingDoc)),
    });
    store.setTrackLocked('layer-2', true);

    store.removeTrack('layer-1');

    expect(store.getState().doc?.tracks.map((track) => track.id)).toEqual([
      'base',
      'layer-2',
      'overlays',
      'effects',
    ]);
    expect(store.getState().lockedTrackKeys).toEqual(new Set(['layer-2']));
    expect(store.getState().undoDepth).toBe(1);
  });

  it('reorders only the same-kind projection, preserves slots, and records one undo step', async () => {
    const { store } = await makeStore({
      getProject: () => Promise.resolve(projectWith(mixedTrackOrderDoc)),
    });

    store.reorderTrack('layer-2', 'layer-1');

    expect(store.getState().doc?.tracks.map((track) => track.id)).toEqual([
      'base',
      'layer-2',
      'audio-1',
      'layer-1',
      'overlays',
      'audio-2',
      'effects',
    ]);
    expect(store.getState().undoDepth).toBe(1);

    store.setTrackLocked('layer-2', true);
    store.undo();
    expect(store.getState().doc?.tracks.map((track) => track.id)[1]).toBe('layer-2');
    expect(store.getState()).toMatchObject({ undoDepth: 1, redoDepth: 0 });
    store.setTrackLocked('layer-2', false);
    store.undo();
    expect(store.getState().doc?.tracks.map((track) => track.id)).toEqual(
      mixedTrackOrderDoc.tracks.map((track) => track.id),
    );
  });

  it('rejects base, cross-kind, missing and locked reorder requests without history', async () => {
    const { store } = await makeStore({
      getProject: () => Promise.resolve(projectWith(mixedTrackOrderDoc)),
    });
    const before = store.getState().doc;

    store.reorderTrack('base', 'layer-1');
    store.reorderTrack('layer-1', 'base');
    store.reorderTrack('layer-1', 'audio-1');
    store.reorderTrack('missing', 'layer-1');
    store.setTrackLocked('layer-2', true);
    store.reorderTrack('layer-2', 'layer-1');

    expect(store.getState().doc).toBe(before);
    expect(store.getState().undoDepth).toBe(0);
  });

  it('adds full audio-only and video audio streams, avoids source collisions, and hydrates peaks', async () => {
    const peaks = {
      version: 1 as const,
      sampleRate: 48_000,
      windowMs: 10,
      min: [-0.2, -0.1],
      max: [0.2, 0.1],
    };
    const sourceCollisionDoc: EditDoc = {
      ...audioDoc,
      sources: {
        cam: audioDoc.sources.cam!,
        music: { path: 'different.wav', durationS: 3 },
      },
      tracks: [
        audioDoc.tracks[0]!,
        { id: 'audio-1', kind: 'audio', blocks: [] },
        { id: 'audio-2', kind: 'audio', blocks: [] },
      ],
    };
    const talkMedia: MediaSummary = {
      kind: 'video',
      relPath: 'talk.mp4',
      durationS: 6.2,
      fps: 25,
      width: 1080,
      height: 1920,
      hasAudio: true,
      transcriptEngine: null,
      proxyRelPath: null,
    };
    const { store } = await makeStore({
      getProject: () =>
        Promise.resolve({ ...projectWith(sourceCollisionDoc), media: [audioMedia, talkMedia] }),
      getPeaks: () => Promise.resolve(peaks),
    });
    store.setTrackLocked('audio-1', true);

    store.addAudioClip('music.wav', -2);
    store.addAudioClip('talk.mp4', 2.5, 'audio-2');

    const current = store.getState().doc;
    expect(current?.sources.music?.path).toBe('different.wav');
    expect(current?.sources.music_2).toEqual({ path: 'music.wav', durationS: 8 });
    const audioTrack = current?.tracks.find((track) => track.id === 'audio-2');
    expect(audioTrack?.kind).toBe('audio');
    expect(audioTrack?.blocks).toEqual([
      { source: 'music_2', in: 0, out: 8, at: 0 },
      { source: 'talk', in: 0, out: 6.2, at: 2.5 },
    ]);
    expect(store.getState().selection).toEqual({ trackId: 'audio-2', blockIndex: 1 });
    await vi.waitFor(() => {
      expect(store.getState().peaks.get('music_2')).toEqual(peaks);
      expect(store.getState().peaks.get('talk')).toEqual(peaks);
    });
  });

  it('rejects silent media and never routes known audio-only media to video tracks', async () => {
    const silentMedia: MediaSummary = {
      kind: 'video',
      relPath: 'silent.mp4',
      durationS: 5,
      fps: 25,
      width: 1080,
      height: 1920,
      hasAudio: false,
      transcriptEngine: null,
      proxyRelPath: null,
    };
    const { store } = await makeStore({
      getProject: () =>
        Promise.resolve({ ...projectWith(audioDoc), media: [audioMedia, silentMedia] }),
    });
    const before = store.getState().doc;

    store.addAudioClip('silent.mp4', 0);
    store.addAudioClip('missing.wav', 0);
    store.addLayer('music.wav', 0);
    store.appendToBase('music.wav');

    expect(store.getState().doc).toBe(before);
    expect(store.getState().undoDepth).toBe(0);
  });
});

describe('EditorStore audio block editing', () => {
  async function audioStore(): Promise<Harness> {
    return makeStore({
      getProject: () => Promise.resolve({ ...projectWith(audioDoc), media: [audioMedia] }),
    });
  }

  it('moves, edge-resizes and frame-trims an audio block in output time', async () => {
    const { store } = await audioStore();
    store.select({ trackId: 'audio-1', blockIndex: 0 });

    store.moveTimedBlock('audio-1', 0, 3);
    store.resizeTimedBlock('audio-1', 0, 'in', 4);
    store.resizeTimedBlock('audio-1', 0, 'out', 6);
    store.trimSelectedEdge('out', -0.5);
    store.nudgeSelectedBlock(1);

    expect(store.getState().doc?.tracks.find((track) => track.id === 'audio-1')?.blocks[0]).toEqual(
      {
        source: 'music',
        in: 2,
        out: 3.5,
        at: 5,
      },
    );
  });

  it('keeps the right edge anchored when a left playhead trim hits minimum duration', async () => {
    const { store } = await audioStore();
    store.select({ trackId: 'audio-1', blockIndex: 0 });

    store.trimAtPlayhead('left', 5.96);

    const block = store.getState().doc?.tracks.find((track) => track.id === 'audio-1')?.blocks[0];
    expect(block).toMatchObject({ source: 'music', in: 4.9, out: 5, at: 5.9 });
    if (block && 'in' in block && 'out' in block && 'at' in block) {
      expect(block.at + (block.out - block.in)).toBeCloseTo(6, 8);
    }
  });

  it('splits and deletes selected audio blocks through the generic selection path', async () => {
    const { store } = await audioStore();
    store.select({ trackId: 'audio-1', blockIndex: 0 });

    store.splitAtPlayhead(4);
    expect(store.getState().doc?.tracks.find((track) => track.id === 'audio-1')?.blocks).toEqual([
      { source: 'music', in: 1, out: 3, at: 2 },
      { source: 'music', in: 3, out: 5, at: 4 },
    ]);

    store.select({ trackId: 'audio-1', blockIndex: 1 });
    const undoDepth = store.getState().undoDepth;
    store.deleteSelectedBlock();
    expect(
      store.getState().doc?.tracks.find((track) => track.id === 'audio-1')?.blocks,
    ).toHaveLength(1);
    expect(store.getState().undoDepth).toBe(undoDepth + 1);
    store.undo();
    expect(
      store.getState().doc?.tracks.find((track) => track.id === 'audio-1')?.blocks,
    ).toHaveLength(2);
  });

  it('clamps gain/fades, canonicalizes defaults, and blocks envelopes on locked rows', async () => {
    const { store } = await audioStore();

    store.setAudioBlockGain('audio-1', 0, 20);
    store.setAudioBlockFades('audio-1', 0, { fadeInS: 3, fadeOutS: 3 });
    expect(
      store.getState().doc?.tracks.find((track) => track.id === 'audio-1')?.blocks[0],
    ).toMatchObject({ gainDb: 12, fadeInS: 3, fadeOutS: 1 });

    store.setAudioBlockGain('audio-1', 0, 0);
    store.setAudioBlockFades('audio-1', 0, { fadeInS: 0, fadeOutS: 0 });
    const canonical = store.getState().doc?.tracks.find((track) => track.id === 'audio-1')
      ?.blocks[0];
    expect(canonical).not.toHaveProperty('gainDb');
    expect(canonical).not.toHaveProperty('fadeInS');
    expect(canonical).not.toHaveProperty('fadeOutS');

    store.setTrackLocked('audio-1', true);
    const beforeLockedEdit = store.getState().doc;
    const historyBeforeLockedEdit = store.getState().undoDepth;
    store.setAudioBlockGain('audio-1', 0, -8);
    store.setAudioBlockFades('audio-1', 0, { fadeInS: 1, fadeOutS: 1 });
    expect(store.getState().doc).toBe(beforeLockedEdit);
    expect(store.getState().undoDepth).toBe(historyBeforeLockedEdit);
  });

  it('keeps an existing fade envelope valid when a trim shortens the clip', async () => {
    const { store } = await audioStore();
    store.setAudioBlockFades('audio-1', 0, { fadeInS: 3, fadeOutS: 1 });

    store.resizeTimedBlock('audio-1', 0, 'out', 4);

    expect(
      store.getState().doc?.tracks.find((track) => track.id === 'audio-1')?.blocks[0],
    ).toMatchObject({ in: 1, out: 3, fadeInS: 2 });
    expect(
      store.getState().doc?.tracks.find((track) => track.id === 'audio-1')?.blocks[0],
    ).not.toHaveProperty('fadeOutS');
    expect(store.getState().editWarning).toBeNull();
  });

  it('allows audio mute headers while locked and removes false from persisted JSON', async () => {
    const { store } = await audioStore();
    store.setTrackLocked('audio-1', true);

    store.setTrackMuted('audio-1', true);
    expect(store.getState().doc?.tracks.find((track) => track.id === 'audio-1')).toMatchObject({
      muted: true,
    });
    store.setTrackMuted('audio-1', false);
    expect(store.getState().doc?.tracks.find((track) => track.id === 'audio-1')).not.toHaveProperty(
      'muted',
    );
  });
});

describe('EditorStore timeline track locks', () => {
  const transcript: Transcript = {
    engine: 'scribe',
    text: 'um dois três quatro',
    words: [
      { text: 'um', start: 0, end: 0.8, type: 'word' },
      { text: 'dois', start: 0.8, end: 1.6, type: 'word' },
      { text: 'três', start: 1.6, end: 2.4, type: 'word' },
      { text: 'quatro', start: 2.4, end: 3.2, type: 'word' },
    ],
  };

  it('keeps base content unchanged across append, split and transcript text edits', async () => {
    const { store } = await makeStore({ getTranscript: () => Promise.resolve(transcript) });
    const before = store.getState().doc;

    store.setTrackLocked('base', true);
    store.appendToBase('second-take.mp4');
    store.splitAtPlayhead(1);
    store.strikeWords('cam', { startIndex: 1, endIndex: 1 });

    expect(store.getState().doc).toBe(before);
    expect(store.getState()).toMatchObject({ dirty: false, undoDepth: 0, redoDepth: 0 });
  });

  it('blocks moving or deleting overlay content and rejects selection on the locked row', async () => {
    const { store } = await makeStore({
      getProject: () => Promise.resolve(projectWith(multiDoc)),
    });
    store.select({ trackId: 'overlays', blockIndex: 0 });
    store.setTrackLocked('overlays', true);
    const before = store.getState().doc;

    expect(store.getState().selection).toBeNull();
    store.select({ trackId: 'overlays', blockIndex: 0 });
    expect(store.getState().selection).toBeNull();

    store.moveTimedBlock('overlays', 0, 5);
    const lockedDoc = store.getState().doc;
    if (lockedDoc) {
      store.applyDoc({
        ...lockedDoc,
        tracks: lockedDoc.tracks.map((track) => {
          if (track.kind !== 'overlay' || track.id !== 'overlays') return track;
          return { ...track, blocks: track.blocks.slice(1) };
        }),
      });
    }
    store.removeTrack('overlays');

    expect(store.getState().doc).toBe(before);
    expect(
      store.getState().doc?.tracks.find((track) => track.id === 'overlays')?.blocks,
    ).toHaveLength(2);
    expect(store.getState()).toMatchObject({ dirty: false, undoDepth: 0 });
  });

  it('removes an auxiliary track and preserves selections from other tracks', async () => {
    const { store } = await makeStore({
      getProject: () => Promise.resolve(projectWith(trackKindsDoc)),
    });
    store.select({ trackId: 'base', blockIndex: 0 });
    store.toggleSelect({ trackId: 'layer-1', blockIndex: 0 });

    store.removeTrack('layer-1');

    expect(store.getState().doc?.tracks.some((track) => track.id === 'layer-1')).toBe(false);
    expect(store.getState().selection).toEqual({ trackId: 'base', blockIndex: 0 });
    expect(store.getState().extraSelections).toEqual([]);
  });

  it('allows persisted hidden and muted header controls while layer content is locked', async () => {
    const { store } = await makeStore({
      getProject: () => Promise.resolve(projectWith(trackKindsDoc)),
    });
    store.setTrackLocked('layer-1', true);

    store.setTrackHidden('layer-1', true);
    store.setTrackMuted('layer-1', true);

    expect(store.getState().doc?.tracks.find((track) => track.id === 'layer-1')).toMatchObject({
      hidden: true,
      muted: true,
    });
    expect(store.getState().lockedTrackKeys).toEqual(new Set(['layer-1']));
  });

  it('blocks subtitle settings and corrections while still allowing the enabled header toggle', async () => {
    const { store } = await makeStore();
    const cue = { source: 'cam', wordStart: 0, wordEnd: 1 };
    store.selectCue(cue);
    store.toggleSelectCue({ source: 'cam', wordStart: 2, wordEnd: 3 });
    store.setTrackLocked(SUBTITLE_EDITOR_TRACK_KEY, true);
    const before = store.getState().doc;

    expect(store.getState()).toMatchObject({
      subtitleInspectorOpen: false,
      selectedCue: null,
      extraCues: [],
    });
    store.selectSubtitles();
    store.selectCue(cue);
    expect(store.getState()).toMatchObject({ subtitleInspectorOpen: false, selectedCue: null });
    store.correctWord('cam', 0, 'corrigido');
    store.setSubtitlePreset('2p-caps');
    expect(store.getState().doc).toBe(before);

    store.updateSubtitleSettings({ enabled: false });
    expect(store.getState().doc?.subtitles).toEqual({ enabled: false, preset: 'pill' });
    expect(store.getState().undoDepth).toBe(1);

    store.undo();
    expect(store.getState().doc?.subtitles.enabled).toBe(true);
    expect(store.getState().lockedTrackKeys.has(SUBTITLE_EDITOR_TRACK_KEY)).toBe(true);
  });

  it('blocks undo and redo snapshots that would change locked track content', async () => {
    const { store } = await makeStore({
      getProject: () => Promise.resolve(projectWith(multiDoc)),
    });
    store.moveTimedBlock('overlays', 0, 5);
    store.setTrackLocked('overlays', true);
    const moved = store.getState().doc;
    const beforeBlockedUndo = {
      undoDepth: store.getState().undoDepth,
      redoDepth: store.getState().redoDepth,
    };

    store.undo();
    expect(store.getState().doc).toBe(moved);
    expect(store.getState()).toMatchObject(beforeBlockedUndo);

    store.setTrackLocked('overlays', false);
    store.undo();
    expect(
      store.getState().doc?.tracks.find((track) => track.id === 'overlays')?.blocks[0],
    ).toMatchObject({ at: 0 });
    store.setTrackLocked('overlays', true);
    const beforeBlockedRedo = {
      doc: store.getState().doc,
      undoDepth: store.getState().undoDepth,
      redoDepth: store.getState().redoDepth,
    };

    store.redo();
    expect(store.getState().doc).toBe(beforeBlockedRedo.doc);
    expect(store.getState()).toMatchObject({
      undoDepth: beforeBlockedRedo.undoDepth,
      redoDepth: beforeBlockedRedo.redoDepth,
    });
  });

  it('changes lock state without touching the document, dirty/history, or preview freshness', async () => {
    const { store, putEdit } = await makeStore();
    const before = store.getState();

    store.toggleTrackLocked('base');

    const locked = store.getState();
    expect(locked.lockedTrackKeys).toEqual(new Set(['base']));
    expect(locked.doc).toBe(before.doc);
    expect(locked).toMatchObject({
      dirty: before.dirty,
      undoDepth: before.undoDepth,
      redoDepth: before.redoDepth,
      previewOutdated: before.previewOutdated,
      previewVersion: before.previewVersion,
    });
    expect(JSON.stringify(locked.doc)).not.toContain('lockedTrackKeys');

    store.toggleTrackLocked('base');
    expect(store.getState().lockedTrackKeys).toEqual(new Set());
    expect(putEdit).not.toHaveBeenCalled();
  });

  it('prunes missing track ids on reload and keeps the subtitle key only while a doc exists', async () => {
    const getProject = vi.fn(() => Promise.resolve(projectWith(multiDoc)));
    const { store } = await makeStore({ getProject });
    store.setTrackLocked('overlays', true);
    store.setTrackLocked(SUBTITLE_EDITOR_TRACK_KEY, true);

    getProject.mockResolvedValueOnce(projectWith(doc));
    await store.reloadFromServer(false);
    expect(store.getState().lockedTrackKeys).toEqual(new Set([SUBTITLE_EDITOR_TRACK_KEY]));

    getProject.mockResolvedValueOnce({ ...projectWith(doc), doc: null, editHash: null });
    await store.reloadFromServer(false);
    expect(store.getState().lockedTrackKeys).toEqual(new Set());
  });
});

describe('EditorStore track hidden/muted', () => {
  async function kindsStore(): Promise<Harness> {
    return makeStore({ getProject: () => Promise.resolve(projectWith(trackKindsDoc)) });
  }

  it('setTrackHidden round-trips on a layer track and removes the field when false', async () => {
    const { store } = await kindsStore();

    store.setTrackHidden('layer-1', true);
    expect(store.getState().doc?.tracks.find((t) => t.id === 'layer-1')).toMatchObject({
      hidden: true,
    });
    expect(store.getState().editWarning).toBeNull();

    store.setTrackHidden('layer-1', false);
    const track = store.getState().doc?.tracks.find((t) => t.id === 'layer-1');
    expect(track).not.toHaveProperty('hidden');
    expect(JSON.stringify(track)).not.toContain('hidden');
  });

  it('setTrackHidden works on overlay and effect tracks too', async () => {
    const { store } = await kindsStore();

    store.setTrackHidden('overlays', true);
    expect(store.getState().doc?.tracks.find((t) => t.id === 'overlays')).toMatchObject({
      hidden: true,
    });

    store.setTrackHidden('effects', true);
    expect(store.getState().doc?.tracks.find((t) => t.id === 'effects')).toMatchObject({
      hidden: true,
    });
  });

  it('setTrackHidden is a no-op on the base track — doc stays untouched, no undo step', async () => {
    const { store } = await kindsStore();
    const docBefore = store.getState().doc;
    const undoDepthBefore = store.getState().undoDepth;

    store.setTrackHidden('base', true);

    expect(store.getState().doc).toBe(docBefore);
    expect(store.getState().undoDepth).toBe(undoDepthBefore);
  });

  it('setTrackMuted applies on a video track and removes the field when false', async () => {
    const { store } = await kindsStore();

    store.setTrackMuted('layer-1', true);
    expect(store.getState().doc?.tracks.find((t) => t.id === 'layer-1')).toMatchObject({
      muted: true,
    });

    store.setTrackMuted('layer-1', false);
    const track = store.getState().doc?.tracks.find((t) => t.id === 'layer-1');
    expect(track).not.toHaveProperty('muted');
  });

  it('setTrackMuted is a no-op on non-video tracks', async () => {
    const { store } = await kindsStore();
    const docBefore = store.getState().doc;
    const undoDepthBefore = store.getState().undoDepth;

    store.setTrackMuted('overlays', true);

    expect(store.getState().doc).toBe(docBefore);
    expect(store.getState().undoDepth).toBe(undoDepthBefore);
  });

  it('hiddenTracks (derived) reflects the doc after setTrackHidden', async () => {
    const { store } = await kindsStore();
    expect(store.getState().hiddenTracks).toEqual(new Set());

    store.setTrackHidden('layer-1', true);
    expect(store.getState().hiddenTracks).toEqual(new Set(['layer-1']));

    store.setTrackHidden('overlays', true);
    expect(store.getState().hiddenTracks).toEqual(new Set(['layer-1', 'overlays']));

    store.setTrackHidden('layer-1', false);
    expect(store.getState().hiddenTracks).toEqual(new Set(['overlays']));
  });

  it('toggleTrackVisibility flips through setTrackHidden and is a no-op on the base track', async () => {
    const { store } = await kindsStore();

    store.toggleTrackVisibility('overlays');
    expect(store.getState().hiddenTracks.has('overlays')).toBe(true);
    store.toggleTrackVisibility('overlays');
    expect(store.getState().hiddenTracks.has('overlays')).toBe(false);

    const undoDepthBefore = store.getState().undoDepth;
    store.toggleTrackVisibility('base');
    expect(store.getState().undoDepth).toBe(undoDepthBefore);
  });
});

describe('EditorStore updateLayerCell', () => {
  it('applies a valid cell rect to the layer block', async () => {
    const { store } = await makeStore({
      getProject: () => Promise.resolve(projectWith(trackKindsDoc)),
    });

    store.updateLayerCell('layer-1', 0, { x: 0.1, y: 0.2, w: 0.4, h: 0.3 });

    expect(store.getState().doc?.tracks.find((t) => t.id === 'layer-1')?.blocks[0]).toMatchObject({
      cell: { x: 0.1, y: 0.2, w: 0.4, h: 0.3 },
    });
  });

  it('clamps x/y so the rect stays inside the frame, using the already-clamped w/h', async () => {
    const { store } = await makeStore({
      getProject: () => Promise.resolve(projectWith(trackKindsDoc)),
    });

    store.updateLayerCell('layer-1', 0, { x: 0.9, y: 0.1, w: 0.5, h: 0.3 });

    expect(store.getState().doc?.tracks.find((t) => t.id === 'layer-1')?.blocks[0]).toMatchObject({
      cell: { x: 0.5, y: 0.1, w: 0.5, h: 0.3 },
    });
  });

  it('enforces the 0.05 minimum on w/h and caps at 1', async () => {
    const { store } = await makeStore({
      getProject: () => Promise.resolve(projectWith(trackKindsDoc)),
    });

    store.updateLayerCell('layer-1', 0, { x: 0, y: 0, w: 0.01, h: 2 });

    expect(store.getState().doc?.tracks.find((t) => t.id === 'layer-1')?.blocks[0]).toMatchObject({
      cell: { x: 0, y: 0, w: 0.05, h: 1 },
    });
  });

  it('is a no-op on a base (non-layer) block', async () => {
    const { store } = await makeStore({
      getProject: () => Promise.resolve(projectWith(trackKindsDoc)),
    });
    const docBefore = store.getState().doc;

    store.updateLayerCell('base', 0, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 });

    expect(store.getState().doc?.tracks.find((t) => t.id === 'base')?.blocks[0]).toEqual(
      docBefore?.tracks.find((t) => t.id === 'base')?.blocks[0],
    );
  });

  it('is a no-op when a component is NaN (e.g. a zero-width gizmo drag or a cleared input) — doc untouched, no discard warning', async () => {
    const { store } = await makeStore({
      getProject: () => Promise.resolve(projectWith(trackKindsDoc)),
    });
    const docBefore = store.getState().doc;

    store.updateLayerCell('layer-1', 0, { x: NaN, y: 0, w: 0.5, h: 0.5 });

    expect(store.getState().doc).toBe(docBefore);
    expect(store.getState().editWarning).toBeNull();
  });
});

describe('EditorStore output settings (denoise, loudnorm)', () => {
  it('setDenoise clamps into [0,1] rounded to 2 decimals', async () => {
    const { store } = await makeStore();
    store.setDenoise(1.567);
    expect(store.getState().doc?.output.denoise).toBe(1);
    store.setDenoise(0.234);
    expect(store.getState().doc?.output.denoise).toBe(0.23);
  });

  it('setDenoise at 0 (or clamped down to 0) removes the field', async () => {
    const { store } = await makeStore();
    store.setDenoise(0.5);
    expect(store.getState().doc?.output.denoise).toBe(0.5);
    store.setDenoise(0);
    expect(store.getState().doc?.output.denoise).toBeUndefined();
    store.setDenoise(0.5);
    store.setDenoise(-1);
    expect(store.getState().doc?.output.denoise).toBeUndefined();
  });

  it('setDenoise is a no-op on a non-finite value (e.g. a cleared number input)', async () => {
    const { store } = await makeStore();
    const docBefore = store.getState().doc;

    store.setDenoise(NaN);

    expect(store.getState().doc).toBe(docBefore);
    expect(store.getState().editWarning).toBeNull();
  });

  it('setDenoiseSample stores source-time room tone at the UI 0.5–2s bounds', async () => {
    const { store } = await makeStore();

    store.setDenoiseSample({ source: 'cam', start: 2, end: 2.1 });
    expect(store.getState().doc?.output.denoiseSample).toEqual({
      source: 'cam',
      start: 2,
      end: 2.5,
    });

    store.setDenoiseSample({ source: 'cam', start: 4, end: 9 });
    expect(store.getState().doc?.output.denoiseSample).toEqual({
      source: 'cam',
      start: 4,
      end: 6,
    });
  });

  it('setDenoiseSample clears to automatic mode and rejects unknown sources', async () => {
    const { store } = await makeStore();
    store.setDenoiseSample({ source: 'cam', start: 1, end: 2 });
    const configured = store.getState().doc;

    store.setDenoiseSample({ source: 'missing', start: 1, end: 2 });
    expect(store.getState().doc).toBe(configured);

    store.setDenoiseSample(null);
    expect(store.getState().doc?.output.denoiseSample).toBeUndefined();
  });

  it('setDenoise coalesces repeated slider events into one undo step', async () => {
    const { store } = await makeStore();
    const undoDepthBefore = store.getState().undoDepth;

    for (let i = 1; i <= 20; i += 1) store.setDenoise(i / 20);

    expect(store.getState().undoDepth).toBe(undoDepthBefore + 1);
    expect(store.getState().doc?.output.denoise).toBe(1);
  });

  it('setLoudnormLufs clamps a number into [-24,-9] and passes null through unclamped', async () => {
    const { store } = await makeStore();
    store.setLoudnormLufs(-2);
    expect(store.getState().doc?.output.loudnormLufs).toBe(-9);
    store.setLoudnormLufs(-40);
    expect(store.getState().doc?.output.loudnormLufs).toBe(-24);
    store.setLoudnormLufs(-16.5);
    expect(store.getState().doc?.output.loudnormLufs).toBe(-16.5);
    store.setLoudnormLufs(null);
    expect(store.getState().doc?.output.loudnormLufs).toBeNull();
  });

  it('setLoudnormLufs is a no-op on a non-finite number, but null is still accepted', async () => {
    const { store } = await makeStore();
    const docBefore = store.getState().doc;

    store.setLoudnormLufs(NaN);

    expect(store.getState().doc).toBe(docBefore);
    expect(store.getState().editWarning).toBeNull();

    store.setLoudnormLufs(null);
    expect(store.getState().doc?.output.loudnormLufs).toBeNull();
  });

  it('setLoudnormLufs coalesces repeated slider events into one undo step', async () => {
    const { store } = await makeStore();
    const undoDepthBefore = store.getState().undoDepth;

    for (let i = 0; i < 20; i += 1) store.setLoudnormLufs(-24 + i);

    expect(store.getState().undoDepth).toBe(undoDepthBefore + 1);
  });

  it('setLoudnormEnabled(false) writes null; setLoudnormEnabled(true) restores the last target picked', async () => {
    const { store } = await makeStore();
    store.setLoudnormLufs(-18);

    store.setLoudnormEnabled(false);
    expect(store.getState().doc?.output.loudnormLufs).toBeNull();

    store.setLoudnormEnabled(true);
    expect(store.getState().doc?.output.loudnormLufs).toBe(-18);
  });

  it('setLoudnormEnabled(true) falls back to -14 on a doc that never had a target', async () => {
    const offDoc: EditDoc = { ...doc, output: { ...doc.output, loudnormLufs: null } };
    const { store } = await makeStore({ getProject: () => Promise.resolve(projectWith(offDoc)) });

    store.setLoudnormEnabled(true);

    expect(store.getState().doc?.output.loudnormLufs).toBe(-14);
  });

  it('setLoudnormEnabled(true) seeds its restore value from the loaded doc, not a fixed default', async () => {
    const customDoc: EditDoc = { ...doc, output: { ...doc.output, loudnormLufs: -20 } };
    const { store } = await makeStore({
      getProject: () => Promise.resolve(projectWith(customDoc)),
    });

    store.setLoudnormEnabled(false);
    expect(store.getState().doc?.output.loudnormLufs).toBeNull();

    store.setLoudnormEnabled(true);
    expect(store.getState().doc?.output.loudnormLufs).toBe(-20);
  });
});

describe('EditorStore silence cuts', () => {
  const ms = (value: number): number => Math.round(value * 1000) / 1000;
  /** camera.mp4 peaks, 100 ms windows: silence 2–3 and 7–8, speech elsewhere up to 9 s. */
  const isSilent = (window: number): boolean =>
    (window >= 20 && window < 30) || (window >= 70 && window < 80);
  const camPeaks = {
    version: 1 as const,
    sampleRate: 48_000,
    windowMs: 100,
    min: Array.from({ length: 90 }, (_, i) => (isSilent(i) ? -0.01 : -0.8)),
    max: Array.from({ length: 90 }, (_, i) => (isSilent(i) ? 0.01 : 0.8)),
  };

  it('cutAllSilences reports the number of cuts, splits the base track, drops extra selections and records one undo step', async () => {
    const { store } = await makeStore({ getPeaks: () => Promise.resolve(camPeaks) });
    store.select({ trackId: 'base', blockIndex: 0 });
    store.toggleSelect({ trackId: 'base', blockIndex: 1 });
    expect(store.getState().extraSelections).toHaveLength(1);

    expect(store.cutAllSilences(0.5)).toBe(2);

    const after = store.getState();
    const blocks = after.doc ? baseTrackOf(after.doc).blocks : [];
    expect(blocks.map((block) => [ms(block.in), ms(block.out)])).toEqual([
      [0, 2.08],
      [2.95, 4],
      [6, 7.08],
      [7.95, 9],
    ]);
    expect(after.extraSelections).toEqual([]);
    expect(after.undoDepth).toBe(1);

    expect(store.cutAllSilences(0.5)).toBe(0);
    expect(store.getState().undoDepth).toBe(1);
  });

  it('dismisses one silence from the review and excludes it from the batch cut', async () => {
    const { store } = await makeStore({ getPeaks: () => Promise.resolve(camPeaks) });
    const [dismissed] = store.computeSilenceCuts(0.5);
    expect(dismissed).toBeDefined();

    store.dismissSilenceCut(dismissed!);
    expect(store.getState().dismissedSilenceCutKeys.size).toBe(1);
    expect(store.computeSilenceCuts(0.5)).toHaveLength(1);
    expect(store.cutAllSilences(0.5)).toBe(1);

    const after = store.getState();
    const blocks = after.doc ? baseTrackOf(after.doc).blocks : [];
    expect(blocks.map((block) => [ms(block.in), ms(block.out)])).toEqual([
      [0, 4],
      [6, 7.08],
      [7.95, 9],
    ]);
  });

  it('restores dismissed silences explicitly and when detection settings change', async () => {
    const { store } = await makeStore({ getPeaks: () => Promise.resolve(camPeaks) });
    const [dismissed] = store.computeSilenceCuts(0.5);
    expect(dismissed).toBeDefined();

    store.dismissSilenceCut(dismissed!);
    store.restoreDismissedSilenceCuts();
    expect(store.getState().dismissedSilenceCutKeys.size).toBe(0);
    expect(store.computeSilenceCuts(0.5)).toHaveLength(2);

    store.dismissSilenceCut(dismissed!);
    store.setSilenceReview({ minSilenceS: 0.6 });
    expect(store.getState().dismissedSilenceCutKeys.size).toBe(0);
  });
});

describe('EditorStore proof mode', () => {
  it('is off by default and toggles', async () => {
    const { store } = await makeStore();
    expect(store.getState().proofMode).toBe(false);

    store.setProofMode(true);
    expect(store.getState().proofMode).toBe(true);
    store.setProofMode(false);
    expect(store.getState().proofMode).toBe(false);
  });
});

describe('EditorStore debug panel', () => {
  it('records every server event in the debug log, newest last, and toggles the panel', async () => {
    const { store, emit } = await makeStore();
    expect(store.getState().debugOpen).toBe(false);

    emit({ kind: 'job', id: 3, type: 'render', state: 'running', progress: '[1/4] extract' });
    emit({ kind: 'assets-changed' });
    store.setDebugOpen(true);

    const { debugLog, debugOpen } = store.getState();
    expect(debugOpen).toBe(true);
    expect(debugLog.map((entry) => [entry.kind, entry.text])).toEqual([
      ['job:render', '#3 running — [1/4] extract'],
      ['assets-changed', 'assets alterados no disco'],
    ]);
  });
});

describe('EditorStore dock', () => {
  it('activates a tab in its own area and derives cutReviewOpen from the cuts tab being on screen', () => {
    const store = new EditorStore();
    expect(store.getState().cutReviewOpen).toBe(false);

    store.activateDockTab('cuts');
    expect(store.getState().dockLayout.side.active).toBe('cuts');
    expect(store.getState().cutReviewOpen).toBe(true);

    store.activateDockTab('inspector');
    expect(store.getState().cutReviewOpen).toBe(false);
  });

  it('moves a tab across areas and keeps the review state consistent with the move', () => {
    const store = new EditorStore();
    store.setCutReviewOpen(true);

    store.moveDockTab('cuts', 'workspace', 0);

    const { dockLayout, cutReviewOpen } = store.getState();
    expect(dockLayout.workspace.tabs[0]).toBe('cuts');
    expect(dockLayout.workspace.active).toBe('cuts');
    expect(dockLayout.side).toEqual({ tabs: ['inspector'], active: 'inspector' });
    expect(cutReviewOpen).toBe(true);

    store.moveDockTabToArea('cuts', 'side');
    expect(store.getState().dockLayout.side.tabs).toEqual(['inspector', 'cuts']);
  });

  it('closing the review shows the sibling tab, and is a no-op when cuts is alone in its area', () => {
    const store = new EditorStore();
    store.setCutReviewOpen(true);
    store.setCutReviewOpen(false);
    expect(store.getState().dockLayout.side.active).toBe('inspector');
    expect(store.getState().cutReviewOpen).toBe(false);

    store.moveDockTab('inspector', 'workspace', 0);
    store.setCutReviewOpen(true);
    store.setCutReviewOpen(false);
    expect(store.getState().dockLayout.side).toEqual({ tabs: ['cuts'], active: 'cuts' });
    expect(store.getState().cutReviewOpen).toBe(true);
  });

  it('tracks the tab being dragged', () => {
    const store = new EditorStore();
    store.beginDockDrag('media');
    expect(store.getState().dockDrag).toBe('media');
    store.endDockDrag();
    expect(store.getState().dockDrag).toBeNull();
  });
});

describe('agent-generated audio artifacts', () => {
  it('adopts a CLI audio receipt without losing local visual edits or undo', async () => {
    const stale = {
      ...projectWith(doc),
      hasAudioPreview: true,
      hasAudioComparison: true,
      audioPreviewEditHash: 'older',
      audioPreviewCurrent: false,
    };
    const getter = vi
      .fn<() => Promise<ProjectInfo>>()
      .mockResolvedValueOnce(stale)
      .mockResolvedValue({ ...stale, audioPreviewEditHash: 'hash-0', audioPreviewCurrent: true });
    const { store, emit } = await makeStore({ getProject: getter });
    store.setOutputSize(720, 1280);
    const undoBefore = store.getState().undoDepth;
    emit({ kind: 'artifacts-changed' });
    await vi.waitFor(() => {
      expect(store.getState().audioPreviewOutdated).toBe(false);
    });
    expect(store.getState().doc?.output.width).toBe(720);
    expect(store.getState().dirty).toBe(true);
    expect(store.getState().undoDepth).toBe(undoBefore);
    expect(store.getState().audioPreviewVersion).toBe(1);
    store.dispose();
  });

  it('refreshes processed audio after an agent changes the montage', async () => {
    vi.useFakeTimers();
    try {
      const current = {
        ...projectWith(doc),
        hasAudioPreview: true,
        hasAudioComparison: true,
        audioPreviewEditHash: 'hash-0',
        audioPreviewCurrent: true,
      };
      const nextDoc = { ...doc, output: { ...doc.output, denoise: 0.3 } };
      const getter = vi
        .fn<() => Promise<ProjectInfo>>()
        .mockResolvedValueOnce(current)
        .mockResolvedValue({
          ...current,
          doc: nextDoc,
          editHash: 'hash-agent',
          audioPreviewCurrent: false,
        });
      const { store, emit, startAudioPreview } = await makeStore({ getProject: getter });
      emit({ kind: 'edit-changed', external: true, hash: 'hash-agent' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(startAudioPreview).toHaveBeenCalledTimes(1);
      expect(store.getState().doc?.output.denoise).toBe(0.3);
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('video layer adjustments', () => {
  it('edits scoped color with undo and respects a locked track', async () => {
    const { store } = await makeStore();
    store.setVideoColor('base', { input: 'hlg', saturation: 0.96 });
    expect(baseTrackOf(store.getState().doc!).color).toEqual({ input: 'hlg', saturation: 0.96 });
    expect(baseTrackOf(store.getState().doc!).blocks).toEqual(baseTrackOf(doc).blocks);
    store.undo();
    expect(baseTrackOf(store.getState().doc!).color).toBeUndefined();
    store.setTrackLocked('base', true);
    store.setVideoColor('base', { saturation: 2 });
    expect(baseTrackOf(store.getState().doc!).color).toBeUndefined();
    store.dispose();
  });
  it('changes all base clip speeds in one undo step without rewriting source bounds or global speed', async () => {
    const { store } = await makeStore();
    store.setBaseLayerSpeed(1.1);
    const next = store.getState().doc!;
    expect(baseTrackOf(next).blocks.map((b) => b.speed)).toEqual([1.1, 1.1]);
    expect(next.output.speed).toBeUndefined();
    expect(next.subtitles).toEqual(doc.subtitles);
    expect(store.getState().undoDepth).toBe(1);
    store.undo();
    expect(baseTrackOf(store.getState().doc!).blocks).toEqual(baseTrackOf(doc).blocks);
    store.dispose();
  });
});

describe('color drop transaction', () => {
  it('adds Color preserving inherited HDR and adjustments, and repeated drops only open it', async () => {
    const { store } = await makeStore();
    const color = { input: 'hlg' as const, saturation: 0.96, contrast: 1.03 };
    store.setVideoColor('base', color);
    const before = store.getState().undoDepth;
    store.addVideoColorEffect({ trackId: 'base', blockIndex: 1 });
    expect(baseTrackOf(store.getState().doc!).blocks[1]?.color).toEqual(color);
    expect(baseTrackOf(store.getState().doc!).blocks[0]?.color).toBeUndefined();
    expect(store.getState().undoDepth).toBe(before + 1);
    store.addVideoColorEffect({ trackId: 'base', blockIndex: 1 });
    expect(store.getState().undoDepth).toBe(before + 1);
    expect(store.getState().colorInspectorTarget).toEqual({ trackId: 'base', blockIndex: 1 });
    store.undo();
    expect(baseTrackOf(store.getState().doc!).blocks[1]?.color).toBeUndefined();
    expect(baseTrackOf(store.getState().doc!).color).toEqual(color);
    store.dispose();
  });
  it('adds neutral Color and refuses a locked target', async () => {
    const { store } = await makeStore();
    store.setTrackLocked('base', true);
    store.addVideoColorEffect({ trackId: 'base' });
    expect(baseTrackOf(store.getState().doc!).color).toBeUndefined();
    store.setTrackLocked('base', false);
    store.addVideoColorEffect({ trackId: 'base' });
    expect(baseTrackOf(store.getState().doc!).color).toEqual({});
    store.dispose();
  });

  it('applies to one clip, opens its inspector, and undoes in one step', async () => {
    const { store } = await makeStore();
    store.applyVideoColorPreset({ trackId: 'base', blockIndex: 1 }, 'mono');
    const base = baseTrackOf(store.getState().doc!);
    expect(base.color).toBeUndefined();
    expect(base.blocks[0]?.color).toBeUndefined();
    expect(base.blocks[1]?.color?.saturation).toBe(0);
    expect(store.getState().colorInspectorTarget).toEqual({ trackId: 'base', blockIndex: 1 });
    expect(store.getState().selection).toEqual({ trackId: 'base', blockIndex: 1 });
    store.undo();
    expect(baseTrackOf(store.getState().doc!).blocks).toEqual(baseTrackOf(doc).blocks);
    store.dispose();
  });
  it('applies layer scope explicitly and refuses locked layers', async () => {
    const { store } = await makeStore();
    store.applyVideoColorPreset({ trackId: 'base' }, 'warm');
    expect(baseTrackOf(store.getState().doc!).color?.warmth).toBe(0.3);
    expect(store.getState().colorInspectorTarget).toEqual({ trackId: 'base' });
    store.setTrackLocked('base', true);
    store.applyVideoColorPreset({ trackId: 'base' }, 'mono');
    expect(baseTrackOf(store.getState().doc!).color?.warmth).toBe(0.3);
    store.dispose();
  });
});

describe('compact layout isolation', () => {
  it('switches tools and layouts without changing the edit or selection', async () => {
    const { store } = await makeStore();
    store.select({ trackId: 'base', blockIndex: 0 });
    const before = store.getState();
    store.applyDockPreset('compact');
    store.activateDockTab('cuts');
    expect(store.getState().cutReviewOpen).toBe(true);
    expect(store.getState().dockLayout.workspace.active).toBe('cuts');
    expect(store.getState().doc).toBe(before.doc);
    expect(store.getState().dirty).toBe(before.dirty);
    expect(store.getState().undoDepth).toBe(before.undoDepth);
    expect(store.getState().selection).toEqual(before.selection);
    store.applyDockPreset('vertical');
    expect(store.getState().cutReviewOpen).toBe(false);
    expect(store.getState().dockLayout.side.tabs).toContain('inspector');
    store.dispose();
  });
});

describe('clip source editor', () => {
  it('cancels without changing the document or undo history', async () => {
    const { store } = await makeStore();
    const before = store.getState().doc;
    store.openClipEditor({ trackId: 'base', blockIndex: 0 });
    expect(store.getState().clipEditor?.doc).toBe(before);
    store.closeClipEditor();
    expect(store.getState().doc).toBe(before);
    expect(store.getState().undoDepth).toBe(0);
    store.dispose();
  });
  it('applies a slip as one undo step and supports redo', async () => {
    const { store } = await makeStore();
    store.openClipEditor({ trackId: 'base', blockIndex: 0 });
    const session = store.getState().clipEditor!;
    expect(store.commitClipRange(session, { start: 2, end: 6 }, 20)).toBe(true);
    expect(store.getState().clipEditor).toBeNull();
    expect(store.getState().undoDepth).toBe(1);
    expect(store.getState().doc?.tracks[0]?.blocks[0]).toMatchObject({ in: 2, out: 6 });
    store.undo();
    expect(store.getState().doc?.tracks[0]?.blocks[0]).toMatchObject({ in: 0, out: 4 });
    store.redo();
    expect(store.getState().doc?.tracks[0]?.blocks[0]).toMatchObject({ in: 2, out: 6 });
    store.dispose();
  });
  it('rejects a stale session after another edit and respects track locks', async () => {
    const { store } = await makeStore();
    store.openClipEditor({ trackId: 'base', blockIndex: 0 });
    const session = store.getState().clipEditor!;
    store.applyDoc({ ...session.doc, output: { ...session.doc.output, width: 720 } });
    expect(store.commitClipRange(session, { start: 2, end: 6 }, 20)).toBe(false);
    store.closeClipEditor();
    store.toggleTrackLocked('base');
    store.openClipEditor({ trackId: 'base', blockIndex: 0 });
    expect(store.getState().clipEditor).toBeNull();
    store.dispose();
  });
});
