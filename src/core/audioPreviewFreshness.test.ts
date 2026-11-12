import { describe, expect, it } from 'vitest';
import { isLayerBlock, type EditDoc, type VideoBlock } from './schema.js';
import { audioPreviewAudibleSourceKeys, audioPreviewSemanticKey } from './audioPreviewFreshness.js';

const doc: EditDoc = {
  version: 2,
  fps: 25,
  output: { width: 1080, height: 1920, loudnormLufs: -14 },
  sources: {
    cam: { path: 'camera.mp4', role: 'camera', durationS: 20 },
    layer: { path: 'layer.mp4' },
    muted: { path: 'muted.mp4' },
    tone: { path: 'tone.mp4' },
  },
  tracks: [
    {
      id: 'base',
      kind: 'video',
      blocks: [{ source: 'cam', in: 0, out: 4, beat: 'hook', transform: { scale: 1, x: 0, y: 0 } }],
    },
    {
      id: 'layers',
      kind: 'video',
      blocks: [
        {
          source: 'layer',
          in: 1,
          out: 3,
          at: 0.5,
          mode: 'pip',
          audio: 'duck',
        },
        {
          source: 'muted',
          in: 0,
          out: 2,
          at: 1,
          mode: 'pip',
          audio: 'mute',
        },
      ],
    },
    {
      id: 'effects',
      kind: 'effect',
      blocks: [{ type: 'zoom', at: 0, duration: 1, scale: 1.1 }],
    },
    {
      id: 'overlays',
      kind: 'overlay',
      blocks: [{ file: 'edit/assets/card.png', at: 1, duration: 2 }],
    },
  ],
  subtitles: { enabled: true, preset: 'pill', fontSize: 15 },
  suggestions: [{ id: 's1', type: 'silence', source: 'cam', start: 4, end: 5, reason: 'silence' }],
  totalDurationS: 4,
};

describe('audioPreviewSemanticKey', () => {
  it('ignores visual-only authoring changes and normalizes equivalent defaults', () => {
    const visualOnly: EditDoc = {
      ...doc,
      output: { ...doc.output, width: 720, height: 1280, joinAudioFadeMs: 30, speed: 1 },
      tracks: doc.tracks.map((track): EditDoc['tracks'][number] => {
        if (track.kind === 'effect') {
          return { ...track, blocks: [{ type: 'zoom', at: 2, duration: 0.5, scale: 1.5 }] };
        }
        if (track.kind === 'overlay') {
          return { ...track, blocks: [{ file: 'edit/assets/other.png', at: 3, duration: 1 }] };
        }
        if (track.id === 'base' && track.kind === 'video') {
          return {
            ...track,
            label: 'renamed',
            blocks: track.blocks.map((block): VideoBlock => ({
              ...block,
              beat: 'different label',
              transform: { scale: 1.4, x: 0.2, y: -0.1 },
              transition: { type: 'fade-black', durationS: 0.2 },
            })),
          };
        }
        return track;
      }),
      subtitles: { enabled: false, preset: '2p-caps' },
      suggestions: [],
      totalDurationS: 99,
    };

    expect(audioPreviewSemanticKey(visualOnly)).toBe(audioPreviewSemanticKey(doc));
  });

  const audibleMutations: readonly [string, (value: EditDoc) => EditDoc][] = [
    [
      'base cut',
      (value) => ({
        ...value,
        tracks: value.tracks.map((track, index) =>
          index === 0 && track.kind === 'video'
            ? {
                ...track,
                blocks: track.blocks.map((block) => ({ ...block, out: block.out - 0.2 })),
              }
            : track,
        ),
      }),
    ],
    ['global speed', (value) => ({ ...value, output: { ...value.output, speed: 1.1 } })],
    [
      'block speed',
      (value) => ({
        ...value,
        tracks: value.tracks.map((track, index) =>
          index === 0 && track.kind === 'video'
            ? {
                ...track,
                blocks: track.blocks.map((block) => ({ ...block, speed: 1.2 })),
              }
            : track,
        ),
      }),
    ],
    ['normalization', (value) => ({ ...value, output: { ...value.output, loudnormLufs: -12 } })],
    [
      'denoise and room tone',
      (value) => ({
        ...value,
        output: {
          ...value.output,
          denoise: 0.3,
          denoiseSample: { source: 'tone', start: 1, end: 2 },
        },
      }),
    ],
    [
      'join treatment',
      (value) => ({
        ...value,
        output: { ...value.output, joinAudioFadeMs: 20, joinAudioCrossfadeMs: 40 },
      }),
    ],
    [
      'base mute',
      (value) => ({
        ...value,
        tracks: value.tracks.map((track, index) =>
          index === 0 && track.kind === 'video' ? { ...track, muted: true } : track,
        ),
      }),
    ],
    [
      'audible layer timing',
      (value) => ({
        ...value,
        tracks: value.tracks.map((track) =>
          track.id === 'layers' && track.kind === 'video'
            ? {
                ...track,
                blocks: track.blocks.map((block) =>
                  isLayerBlock(block) && block.audio === 'duck'
                    ? { ...block, at: block.at + 0.25 }
                    : block,
                ),
              }
            : track,
        ),
      }),
    ],
    [
      'audible layer mute',
      (value) => ({
        ...value,
        tracks: value.tracks.map((track) =>
          track.id === 'layers' && track.kind === 'video' ? { ...track, muted: true } : track,
        ),
      }),
    ],
    [
      'used source path',
      (value) => ({
        ...value,
        sources: {
          ...value.sources,
          cam: { ...value.sources.cam, path: 'replacement.mp4' },
        },
      }),
    ],
  ];

  it.each(audibleMutations)('changes when %s changes', (_label, mutate) => {
    expect(audioPreviewSemanticKey(mutate(doc))).not.toBe(audioPreviewSemanticKey(doc));
  });

  it('ignores muted layer media and inactive room-tone metadata', () => {
    const changed: EditDoc = {
      ...doc,
      output: {
        ...doc.output,
        denoise: 0,
        denoiseSample: { source: 'tone', start: 1, end: 2 },
      },
      sources: {
        ...doc.sources,
        muted: { path: 'replacement-muted.mp4' },
        tone: { path: 'replacement-tone.mp4' },
      },
    };
    expect(audioPreviewSemanticKey(changed)).toBe(audioPreviewSemanticKey(doc));
  });

  it('projects a muted base by duration rather than source identity or source window', () => {
    const mutedBase: EditDoc = {
      ...doc,
      tracks: doc.tracks.map((track, index) =>
        index === 0 && track.kind === 'video' ? { ...track, muted: true } : track,
      ),
    };
    const sameSilence: EditDoc = {
      ...mutedBase,
      sources: {
        ...mutedBase.sources,
        cam: { ...mutedBase.sources.cam, path: 'replacement.mp4' },
      },
      output: {
        ...mutedBase.output,
        joinAudioFadeMs: 8,
        joinAudioCrossfadeMs: 120,
      },
      tracks: mutedBase.tracks.map((track, index) =>
        index === 0 && track.kind === 'video'
          ? {
              ...track,
              blocks: track.blocks.map((block) => ({
                ...block,
                source: 'muted',
                in: block.in + 5,
                out: block.out + 5,
              })),
            }
          : track,
      ),
    };
    expect(audioPreviewSemanticKey(sameSilence)).toBe(audioPreviewSemanticKey(mutedBase));

    const longerSilence: EditDoc = {
      ...mutedBase,
      tracks: mutedBase.tracks.map((track, index) =>
        index === 0 && track.kind === 'video'
          ? {
              ...track,
              blocks: track.blocks.map((block) => ({ ...block, out: block.out + 0.2 })),
            }
          : track,
      ),
    };
    expect(audioPreviewSemanticKey(longerSilence)).not.toBe(audioPreviewSemanticKey(mutedBase));
  });
});

describe('audioPreviewAudibleSourceKeys', () => {
  it('includes base, audible layers and an active manual room-tone sample only', () => {
    const withDenoise: EditDoc = {
      ...doc,
      output: {
        ...doc.output,
        denoise: 0.3,
        denoiseSample: { source: 'tone', start: 1, end: 2 },
      },
    };
    expect([...audioPreviewAudibleSourceKeys(withDenoise)].sort()).toEqual([
      'cam',
      'layer',
      'tone',
    ]);
  });

  it('includes unmuted music/SFX rows and excludes muted ones', () => {
    const withAudio: EditDoc = {
      ...doc,
      sources: { ...doc.sources, music: { path: 'music.flac', durationS: 12 } },
      tracks: [
        ...doc.tracks,
        {
          id: 'music',
          kind: 'audio',
          blocks: [{ source: 'music', in: 0, out: 4, at: 0.5 }],
        },
      ],
    };
    expect(audioPreviewAudibleSourceKeys(withAudio).has('music')).toBe(true);
    const muted: EditDoc = {
      ...withAudio,
      tracks: withAudio.tracks.map((track) =>
        track.kind === 'audio' ? { ...track, muted: true } : track,
      ),
    };
    expect(audioPreviewAudibleSourceKeys(muted).has('music')).toBe(false);
  });
});

describe('audio track freshness projection', () => {
  const withAudio: EditDoc = {
    ...doc,
    sources: { ...doc.sources, music: { path: 'music.flac', durationS: 12 } },
    tracks: [
      ...doc.tracks,
      {
        id: 'music',
        kind: 'audio',
        label: 'Music',
        blocks: [
          {
            source: 'music',
            in: 1,
            out: 5,
            at: 0.5,
            gainDb: -6,
            fadeInS: 0.2,
            fadeOutS: 0.4,
          },
        ],
      },
    ],
  };

  it.each(['at', 'gainDb', 'fadeInS', 'fadeOutS'] as const)(
    'changes when audio block %s changes',
    (field) => {
      const changed: EditDoc = {
        ...withAudio,
        tracks: withAudio.tracks.map((track) =>
          track.kind === 'audio'
            ? {
                ...track,
                blocks: track.blocks.map((block) => ({
                  ...block,
                  [field]: (block[field] ?? 0) + 0.1,
                })),
              }
            : track,
        ),
      };
      expect(audioPreviewSemanticKey(changed)).not.toBe(audioPreviewSemanticKey(withAudio));
    },
  );

  it('ignores labels and the contents of a muted audio row', () => {
    const muted: EditDoc = {
      ...withAudio,
      tracks: withAudio.tracks.map((track) =>
        track.kind === 'audio' ? { ...track, muted: true } : track,
      ),
    };
    const renamedAndRetimed: EditDoc = {
      ...muted,
      tracks: muted.tracks.map((track) =>
        track.kind === 'audio'
          ? {
              ...track,
              label: 'Renamed',
              blocks: track.blocks.map((block) => ({ ...block, at: block.at + 2, gainDb: 8 })),
            }
          : track,
      ),
    };
    expect(audioPreviewSemanticKey(renamedAndRetimed)).toBe(audioPreviewSemanticKey(muted));
  });
});
