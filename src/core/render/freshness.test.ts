import { describe, expect, it } from 'vitest';
import type { EditDoc } from '../schema.js';
import { programKey, programSourceKeys } from './freshness.js';

const doc: EditDoc = {
  version: 2,
  fps: 25,
  output: { width: 1080, height: 1920, loudnormLufs: -14 },
  sources: {
    cam: { path: 'camera.mp4', durationS: 64.6 },
    screen: { path: 'screen.mov', durationS: 21 },
    silent: { path: 'broll.mov', durationS: 30 },
    music: { path: 'music.wav', durationS: 120 },
  },
  tracks: [
    {
      id: 'base',
      kind: 'video',
      blocks: [
        { source: 'cam', in: 1.51, out: 5.9 },
        { source: 'cam', in: 6.33, out: 10.84 },
      ],
    },
    {
      id: 'layers',
      kind: 'video',
      blocks: [
        {
          source: 'screen',
          in: 4,
          out: 6,
          at: 3,
          mode: 'pip',
          position: 'bottom-left',
          scale: 0.34,
          audio: 'duck',
        },
        { source: 'silent', in: 0, out: 2, at: 6, mode: 'pip', audio: 'mute' },
      ],
    },
    {
      id: 'overlays',
      kind: 'overlay',
      blocks: [{ file: 'edit/assets/cta.webm', at: 5, duration: 2 }],
    },
    { id: 'effects', kind: 'effect', blocks: [{ type: 'zoom', at: 1, duration: 2, scale: 1.2 }] },
    {
      id: 'audio-1',
      kind: 'audio',
      blocks: [{ source: 'music', in: 0, out: 8, at: 0, gainDb: -12 }],
    },
  ],
  subtitles: { enabled: true, preset: '2p-caps' },
  totalDurationS: 8.9,
};

function withTrack(edit: (track: EditDoc['tracks'][number]) => EditDoc['tracks'][number]): EditDoc {
  return { ...doc, tracks: doc.tracks.map(edit) };
}

const withCanvas: EditDoc = {
  ...doc,
  canvas: { background: { kind: 'color', color: '#000000' }, base: { mode: 'fill' } },
};
const withRepointedBackground: EditDoc = {
  ...doc,
  sources: { ...doc.sources, bg: { path: 'other-bg.mp4' } },
  canvas: { background: { kind: 'video', source: 'bg', fit: 'cover' }, base: { mode: 'fill' } },
};

describe('programKey', () => {
  it.each([
    [
      'moving an overlay',
      withTrack((t) => (t.kind === 'overlay' ? { ...t, blocks: [{ ...t.blocks[0]!, at: 6 }] } : t)),
    ],
    [
      'swapping the overlay file',
      withTrack((t) =>
        t.kind === 'overlay'
          ? { ...t, blocks: [{ ...t.blocks[0]!, file: 'edit/assets/other.png' }] }
          : t,
      ),
    ],
    ['disabling subtitles', { ...doc, subtitles: { enabled: false, preset: '2p-caps' } }],
    ['changing the subtitle preset', { ...doc, subtitles: { enabled: true, preset: 'pill' } }],
    [
      'resizing and moving the PiP layer',
      withTrack((t) =>
        t.id === 'layers' && t.kind === 'video'
          ? { ...t, blocks: [{ ...t.blocks[0]!, position: 'top-right', scale: 0.5 }, t.blocks[1]!] }
          : t,
      ),
    ],
    [
      'writing the default join fade explicitly',
      { ...doc, output: { ...doc.output, joinAudioFadeMs: 30 } },
    ],
  ] as const)('is stable when %s — the browser composes that', (_label, edited) => {
    expect(programKey(edited)).toBe(programKey(doc));
  });

  it.each([
    [
      'cutting the base',
      withTrack((t) =>
        t.id === 'base' && t.kind === 'video'
          ? { ...t, blocks: [{ ...t.blocks[0]!, out: 5.5 }, t.blocks[1]!] }
          : t,
      ),
    ],
    ['changing the global speed', { ...doc, output: { ...doc.output, speed: 1.5 } }],
    ['turning denoise on', { ...doc, output: { ...doc.output, denoise: 0.6 } }],
    ['changing the loudness target', { ...doc, output: { ...doc.output, loudnormLufs: -16 } }],
    [
      'changing a camera effect',
      withTrack((t) =>
        t.kind === 'effect'
          ? { ...t, blocks: [{ type: 'zoom', at: 1, duration: 3, scale: 1.2 }] }
          : t,
      ),
    ],
    ['adding a canvas', withCanvas],
    [
      'muting the ducked layer',
      withTrack((t) =>
        t.id === 'layers' && t.kind === 'video'
          ? { ...t, blocks: [{ ...t.blocks[0]!, audio: 'mute' }, t.blocks[1]!] }
          : t,
      ),
    ],
    ['repointing the canvas background video', withRepointedBackground],
    [
      'changing an audio clip gain',
      withTrack((t) =>
        t.kind === 'audio' ? { ...t, blocks: [{ ...t.blocks[0]!, gainDb: -6 }] } : t,
      ),
    ],
  ] as const)('changes when %s — the engine renders that', (_label, edited) => {
    expect(programKey(edited)).not.toBe(programKey(doc));
  });
});

describe('programSourceKeys', () => {
  it('lists the base, audible layers and audio clips, never a silent layer', () => {
    expect([...programSourceKeys(doc)].sort()).toEqual(['cam', 'music', 'screen']);
  });

  it('adds the canvas background video and the denoise sample source', () => {
    const withBackground: EditDoc = {
      ...doc,
      sources: { ...doc.sources, bg: { path: 'bg.mp4' }, tone: { path: 'tone.wav' } },
      output: {
        ...doc.output,
        denoise: 0.4,
        denoiseSample: { source: 'tone', start: 0, end: 0.5 },
      },
      canvas: { background: { kind: 'video', source: 'bg', fit: 'cover' }, base: { mode: 'fill' } },
    };
    expect([...programSourceKeys(withBackground)].sort()).toEqual([
      'bg',
      'cam',
      'music',
      'screen',
      'tone',
    ]);
  });

  it('ignores the denoise sample while denoise is off, and a hidden layer track', () => {
    const off: EditDoc = {
      ...doc,
      sources: { ...doc.sources, tone: { path: 'tone.wav' } },
      output: { ...doc.output, denoiseSample: { source: 'tone', start: 0, end: 0.5 } },
    };
    expect([...programSourceKeys(off)]).not.toContain('tone');
    const hidden = withTrack((t) => (t.id === 'layers' ? { ...t, hidden: true } : t));
    expect([...programSourceKeys(hidden)].sort()).toEqual(['cam', 'music']);
  });

  it('drops a layer source once its track is muted', () => {
    const muted = withTrack((t) => (t.id === 'layers' ? { ...t, muted: true } : t));
    expect([...programSourceKeys(muted)].sort()).toEqual(['cam', 'music']);
  });
});

it('invalidates program on base grade', () => {
  const gradedBase = {
    ...doc,
    tracks: doc.tracks.map((track, i) =>
      i === 0 ? { ...track, color: { saturation: 0.8 } } : track,
    ),
  } as EditDoc;
  expect(programKey(gradedBase)).not.toBe(programKey(doc));
});
