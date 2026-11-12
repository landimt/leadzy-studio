import { describe, expect, it } from 'vitest';
import {
  H264_OUTPUT_LIMITS,
  isValidH264OutputDimensions,
  parseEditDoc,
  transcriptionKeyterms,
} from './schema.js';

const validDoc = {
  version: 2,
  fps: 25,
  output: { width: 1080, height: 1920, loudnormLufs: -14 },
  sources: {
    cam: { path: 'camera.mp4', role: 'camera', durationS: 64.6 },
    screen: { path: 'screen.mov', role: 'screen', durationS: 21 },
  },
  tracks: [
    {
      id: 'base',
      kind: 'video',
      label: 'camera',
      blocks: [
        { source: 'cam', in: 1.51, out: 5.9, beat: 'HOOK', reason: 'direct opening' },
        { source: 'cam', in: 6.33, out: 10.84 },
      ],
    },
    {
      id: 'demo',
      kind: 'video',
      blocks: [
        {
          source: 'screen',
          in: 4,
          out: 13.5,
          at: 41.2,
          mode: 'pip',
          position: 'bottom-left',
          scale: 0.34,
          audio: 'mute',
        },
      ],
    },
    {
      id: 'overlays',
      kind: 'overlay',
      blocks: [{ file: 'edit/assets/cta.webm', at: 48, duration: 4 }],
    },
  ],
  subtitles: { enabled: true, preset: '2p-caps' },
  totalDurationS: 53.3,
};

/** The overlay track of the valid document, with its blocks replaced by raw candidates. */
function docWithOverlayBlocks(blocks: readonly unknown[]): unknown {
  return {
    ...validDoc,
    tracks: [validDoc.tracks[0], validDoc.tracks[1], { id: 'overlays', kind: 'overlay', blocks }],
  };
}

describe('parseEditDoc', () => {
  it('accepts the spec example document', () => {
    const result = parseEditDoc(validDoc);
    expect(result.ok).toBe(true);
  });

  it('round-trips an overlay block carrying a library back-reference', () => {
    const result = parseEditDoc(
      docWithOverlayBlocks([
        {
          file: 'edit/assets/library/cta-verde-a1b2/bake-0123456789ab.webm',
          at: 48,
          duration: 4,
          library: { item: 'cta-verde-a1b2', variables: { HEADLINE: 'Compre agora', PRICE: '' } },
        },
      ]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const track = result.value.tracks[2];
      expect(track?.kind).toBe('overlay');
      expect(track?.kind === 'overlay' ? track.blocks[0]?.library : null).toEqual({
        item: 'cta-verde-a1b2',
        variables: { HEADLINE: 'Compre agora', PRICE: '' },
      });
    }
  });

  it('rejects a library back-reference with a malformed item id or variable name', () => {
    for (const library of [
      { item: '../escape', variables: { HEADLINE: 'a' } },
      { item: 'UPPER-ID', variables: { HEADLINE: 'a' } },
      { item: 'cta-verde-a1b2', variables: { headline: 'a' } },
      { item: 'cta-verde-a1b2', extra: true },
    ]) {
      const doc = docWithOverlayBlocks([
        { file: 'edit/assets/cta.webm', at: 48, duration: 4, library },
      ]);
      expect(parseEditDoc(doc).ok, JSON.stringify(library)).toBe(false);
    }
  });

  it('rejects unknown fields anywhere', () => {
    const result = parseEditDoc({ ...validDoc, futureField: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-edit-json');
  });

  // Times reach ffmpeg filtergraphs verbatim; zod >= 4 rejects non-finite
  // numbers by default and this test keeps that guarantee pinned across
  // dependency changes.
  it('rejects non-finite times', () => {
    for (const bad of [Infinity, -Infinity, NaN]) {
      const doc = structuredClone(validDoc);
      doc.tracks[0]!.blocks[0] = { source: 'cam', in: bad, out: 2 };
      expect(parseEditDoc(doc).ok).toBe(false);
    }
  });

  it('accepts even H.264 output sizes through 8K UHD', () => {
    for (const output of [
      { width: 3840, height: 2160 },
      { width: 2160, height: 3840 },
      { width: 2160, height: 2700 },
      { width: 7680, height: 4320 },
    ]) {
      expect(isValidH264OutputDimensions(output)).toBe(true);
      expect(
        parseEditDoc({
          ...validDoc,
          output: { ...validDoc.output, ...output },
        }).ok,
      ).toBe(true);
    }
  });

  it('rejects odd, overlong, and over-budget H.264 output sizes', () => {
    const invalid = [
      { width: 1081, height: 1920 },
      { width: 1080, height: 1921 },
      { width: H264_OUTPUT_LIMITS.maxSide + 2, height: 2160 },
      { width: 8192, height: 4096 },
    ];

    for (const output of invalid) {
      expect(isValidH264OutputDimensions(output)).toBe(false);
      expect(
        parseEditDoc({
          ...validDoc,
          output: { ...validDoc.output, ...output },
        }).ok,
      ).toBe(false);
    }
  });

  function docWithLayerBlock(block: unknown) {
    return {
      ...validDoc,
      tracks: validDoc.tracks.map((track, i) => (i === 1 ? { ...track, blocks: [block] } : track)),
    };
  }

  const cellBlock = { source: 'screen', in: 4, out: 13.5, at: 0, mode: 'cell', audio: 'mute' };

  it('accepts a cell-mode layer block inside the frame and a left/right split', () => {
    expect(
      parseEditDoc(docWithLayerBlock({ ...cellBlock, cell: { x: 0.1, y: 0.05, w: 0.5, h: 0.4 } }))
        .ok,
    ).toBe(true);
    expect(
      parseEditDoc(
        docWithLayerBlock({
          source: 'screen',
          in: 4,
          out: 13.5,
          at: 0,
          mode: 'split',
          split: { ratio: 0.5, arrangement: 'left' },
          audio: 'mute',
        }),
      ).ok,
    ).toBe(true);
  });

  it('accepts swapped on a pip layer block and rejects non-boolean swapped', () => {
    const pipBlock = { source: 'screen', in: 4, out: 13.5, at: 0, mode: 'pip', audio: 'mute' };
    expect(parseEditDoc(docWithLayerBlock({ ...pipBlock, swapped: true })).ok).toBe(true);
    expect(parseEditDoc(docWithLayerBlock({ ...pipBlock, swapped: false })).ok).toBe(true);
    expect(parseEditDoc(docWithLayerBlock(pipBlock)).ok).toBe(true);
    expect(parseEditDoc(docWithLayerBlock({ ...pipBlock, swapped: 'yes' })).ok).toBe(false);
  });

  it('rejects cell mode without the cell field and cells escaping the frame', () => {
    const missing = parseEditDoc(docWithLayerBlock(cellBlock));
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.message).toContain('tracks.1.blocks.0: cell mode requires');
    }
    const escaping = parseEditDoc(
      docWithLayerBlock({ ...cellBlock, cell: { x: 0.7, y: 0.1, w: 0.5, h: 0.4 } }),
    );
    expect(escaping.ok).toBe(false);
    if (!escaping.ok) expect(escaping.error.message).toContain('inside the frame');
  });

  it('bounds block speed and output speed to 0.5–2 and joinAudioCrossfadeMs to 0–200', () => {
    const withBlockSpeed = (speed: number) => ({
      ...validDoc,
      tracks: validDoc.tracks.map((track, i) =>
        i === 0 ? { ...track, blocks: [{ source: 'cam', in: 0, out: 4, speed }] } : track,
      ),
    });
    expect(parseEditDoc(withBlockSpeed(1.5)).ok).toBe(true);
    expect(parseEditDoc(withBlockSpeed(3)).ok).toBe(false);
    expect(parseEditDoc(withBlockSpeed(0.4)).ok).toBe(false);
    const withOutput = (patch: Record<string, number>) => ({
      ...validDoc,
      output: { ...validDoc.output, ...patch },
    });
    expect(parseEditDoc(withOutput({ speed: 1.1 })).ok).toBe(true);
    expect(parseEditDoc(withOutput({ speed: 2.5 })).ok).toBe(false);
    expect(parseEditDoc(withOutput({ joinAudioCrossfadeMs: 40 })).ok).toBe(true);
    expect(parseEditDoc(withOutput({ joinAudioCrossfadeMs: 300 })).ok).toBe(false);
  });

  it('bounds output.denoise to 0–1', () => {
    const withDenoise = (denoise: number) => ({
      ...validDoc,
      output: { ...validDoc.output, denoise },
    });
    expect(parseEditDoc(withDenoise(0.5)).ok).toBe(true);
    expect(parseEditDoc(withDenoise(1.5)).ok).toBe(false);
  });

  it('accepts a 0.2–3s source-time denoise sample from a known source', () => {
    const withSample = (start: number, end: number, source = 'cam') => ({
      ...validDoc,
      output: { ...validDoc.output, denoise: 0.5, denoiseSample: { source, start, end } },
    });

    expect(parseEditDoc(withSample(2, 2.2)).ok).toBe(true);
    expect(parseEditDoc(withSample(2, 5)).ok).toBe(true);
    expect(parseEditDoc(withSample(2, 2.19)).ok).toBe(false);
    expect(parseEditDoc(withSample(2, 5.01)).ok).toBe(false);
  });

  it('rejects an inverted, unknown, or out-of-source denoise sample', () => {
    const withSample = (source: string, start: number, end: number) => ({
      ...validDoc,
      output: { ...validDoc.output, denoiseSample: { source, start, end } },
    });

    expect(parseEditDoc(withSample('cam', 4, 4)).ok).toBe(false);
    expect(parseEditDoc(withSample('missing', 1, 2)).ok).toBe(false);
    expect(parseEditDoc(withSample('screen', 20.5, 21.1)).ok).toBe(false);
    // A source without duration metadata can still be sampled; ffprobe owns
    // the runtime range check for that common hand-authored case.
    const withoutKnownDuration = {
      ...validDoc,
      sources: { ...validDoc.sources, cam: { path: 'camera.mp4', role: 'camera' } },
      output: {
        ...validDoc.output,
        denoiseSample: { source: 'cam', start: 100, end: 101 },
      },
    };
    expect(parseEditDoc(withoutKnownDuration).ok).toBe(true);
  });

  it('accepts hidden/muted on layer tracks but never hidden on the base', () => {
    const layerHidden = {
      ...validDoc,
      tracks: validDoc.tracks.map((track, i) =>
        i === 1 ? { ...track, hidden: true, muted: true } : track,
      ),
    };
    expect(parseEditDoc(layerHidden).ok).toBe(true);
    const baseHidden = {
      ...validDoc,
      tracks: validDoc.tracks.map((track, i) => (i === 0 ? { ...track, hidden: true } : track)),
    };
    const result = parseEditDoc(baseHidden);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('base track cannot be hidden');
  });

  it('accepts persisted audio tracks with timed source slices', () => {
    const result = parseEditDoc({
      ...validDoc,
      tracks: [
        ...validDoc.tracks,
        {
          id: 'audio-1',
          kind: 'audio',
          label: 'music',
          muted: true,
          blocks: [
            {
              source: 'screen',
              in: 1.25,
              out: 8.5,
              at: 3,
              gainDb: -4.5,
              fadeInS: 0.75,
              fadeOutS: 1.25,
            },
          ],
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it('validates audio block bounds, source references and the video base invariant', () => {
    const audioTrack = {
      id: 'audio-1',
      kind: 'audio',
      blocks: [{ source: 'screen', in: 1, out: 4, at: 0 }],
    };

    expect(
      parseEditDoc({
        ...validDoc,
        tracks: [
          ...validDoc.tracks,
          { ...audioTrack, blocks: [{ source: 'screen', in: 4, out: 4, at: 0 }] },
        ],
      }).ok,
    ).toBe(false);
    const unknownSource = parseEditDoc({
      ...validDoc,
      tracks: [
        ...validDoc.tracks,
        { ...audioTrack, blocks: [{ source: 'ghost', in: 0, out: 4, at: 0 }] },
      ],
    });
    expect(unknownSource.ok).toBe(false);
    if (!unknownSource.ok) expect(unknownSource.error.message).toContain('unknown source "ghost"');

    const pastKnownDuration = parseEditDoc({
      ...validDoc,
      tracks: [
        ...validDoc.tracks,
        { ...audioTrack, blocks: [{ source: 'screen', in: 20, out: 21.1, at: 0 }] },
      ],
    });
    expect(pastKnownDuration.ok).toBe(false);
    if (!pastKnownDuration.ok)
      expect(pastKnownDuration.error.message).toContain('ends after source "screen"');

    const audioFirst = parseEditDoc({
      ...validDoc,
      tracks: [audioTrack, ...validDoc.tracks],
    });
    expect(audioFirst.ok).toBe(false);
    if (!audioFirst.ok)
      expect(audioFirst.error.message).toContain('tracks[0] must be a video track');
  });

  it('bounds audio gain and requires fades to fit inside the source slice', () => {
    const withAudioBlock = (block: Record<string, unknown>) => ({
      ...validDoc,
      tracks: [
        ...validDoc.tracks,
        {
          id: 'audio-1',
          kind: 'audio',
          blocks: [{ source: 'screen', in: 0, out: 4, at: 0, ...block }],
        },
      ],
    });

    expect(parseEditDoc(withAudioBlock({ gainDb: -60 })).ok).toBe(true);
    expect(parseEditDoc(withAudioBlock({ gainDb: 12 })).ok).toBe(true);
    expect(parseEditDoc(withAudioBlock({ gainDb: -61 })).ok).toBe(false);
    expect(parseEditDoc(withAudioBlock({ gainDb: 13 })).ok).toBe(false);
    expect(parseEditDoc(withAudioBlock({ fadeInS: 1.5, fadeOutS: 2.5 })).ok).toBe(true);
    const excessiveFades = parseEditDoc(withAudioBlock({ fadeInS: 2.01, fadeOutS: 2 }));
    expect(excessiveFades.ok).toBe(false);
    if (!excessiveFades.ok) expect(excessiveFades.error.message).toContain('fades must fit');
  });

  it('rejects "at" on base track blocks', () => {
    const doc = structuredClone(validDoc);
    doc.tracks[0]!.blocks[0] = {
      source: 'cam',
      in: 1,
      out: 2,
      at: 5,
      mode: 'pip',
      audio: 'mute',
    };
    const result = parseEditDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('base track blocks concatenate');
  });

  it('rejects layer blocks without "at"', () => {
    const doc = structuredClone(validDoc);
    doc.tracks[1]!.blocks[0] = { source: 'screen', in: 4, out: 13.5 };
    const result = parseEditDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('must carry "at"');
  });

  it('rejects blocks that reference unknown sources', () => {
    const doc = structuredClone(validDoc);
    doc.tracks[0]!.blocks[0] = { source: 'ghost', in: 1, out: 2 };
    const result = parseEditDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('unknown source "ghost"');
  });

  it('keeps legacy documents valid when canvas is omitted', () => {
    const result = parseEditDoc(validDoc);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.canvas).toBeUndefined();
  });

  it('accepts color, project-image and registered-video canvas backgrounds', () => {
    const variants = [
      {
        background: { kind: 'color', color: '#171416' },
        base: { mode: 'fill' },
      },
      {
        background: {
          kind: 'image',
          file: 'edit/assets/backgrounds/paper.jpg',
          fit: 'cover',
          color: '#F7F3EE',
        },
        base: { mode: 'cell', cell: { x: 0.08, y: 0.22, w: 0.84, h: 0.56 } },
      },
      {
        background: { kind: 'video', source: 'screen', fit: 'contain', color: '#101010' },
        base: { mode: 'cell', cell: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } },
      },
    ];

    for (const canvas of variants) {
      expect(parseEditDoc({ ...validDoc, canvas }).ok).toBe(true);
    }
  });

  it('rejects unsafe background image paths, malformed colors and invalid cell mode', () => {
    const canvases = [
      {
        background: { kind: 'image', file: '/tmp/background.png', fit: 'cover' },
        base: { mode: 'fill' },
      },
      {
        background: { kind: 'image', file: 'edit/../background.png', fit: 'cover' },
        base: { mode: 'fill' },
      },
      {
        background: { kind: 'image', file: '..\\background.png', fit: 'contain' },
        base: { mode: 'fill' },
      },
      {
        background: { kind: 'color', color: 'black' },
        base: { mode: 'fill' },
      },
      {
        background: { kind: 'color', color: '#171416' },
        base: { mode: 'cell' },
      },
      {
        background: { kind: 'color', color: '#171416' },
        base: { mode: 'cell', cell: { x: 0.8, y: 0.2, w: 0.4, h: 0.5 } },
      },
    ];

    for (const canvas of canvases) {
      expect(parseEditDoc({ ...validDoc, canvas }).ok).toBe(false);
    }
  });

  it('rejects a canvas video background that references an unknown source', () => {
    const result = parseEditDoc({
      ...validDoc,
      canvas: {
        background: { kind: 'video', source: 'missing', fit: 'cover' },
        base: { mode: 'fill' },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('canvas background references');
  });

  it('rejects blocks with out <= in', () => {
    const doc = structuredClone(validDoc);
    doc.tracks[0]!.blocks[0] = { source: 'cam', in: 5, out: 5 };
    expect(parseEditDoc(doc).ok).toBe(false);
  });

  it('rejects split mode without split config', () => {
    const doc = structuredClone(validDoc);
    doc.tracks[1]!.blocks[0] = {
      source: 'screen',
      in: 4,
      out: 13.5,
      at: 41.2,
      mode: 'split',
      audio: 'mute',
    };
    const result = parseEditDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('split');
  });

  it('accepts agent-defined subtitle grouping limits', () => {
    const result = parseEditDoc({
      ...validDoc,
      subtitles: {
        enabled: true,
        preset: 'pill',
        minWordsPerCue: 2,
        maxWordsPerCue: 4,
        fontSize: 17,
        marginV: 72,
      },
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a custom subtitle max tail', () => {
    const result = parseEditDoc({
      ...validDoc,
      subtitles: { enabled: true, preset: '2p-caps', maxTailS: 0.6 },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a subtitle max tail above 2 seconds', () => {
    const result = parseEditDoc({
      ...validDoc,
      subtitles: { enabled: true, preset: '2p-caps', maxTailS: 2.5 },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a negative subtitle max tail', () => {
    const result = parseEditDoc({
      ...validDoc,
      subtitles: { enabled: true, preset: '2p-caps', maxTailS: -0.1 },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects subtitle grouping when the minimum exceeds the maximum', () => {
    const result = parseEditDoc({
      ...validDoc,
      subtitles: {
        enabled: true,
        preset: '2p-caps',
        minWordsPerCue: 4,
        maxWordsPerCue: 2,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('minWordsPerCue');
  });

  it('accepts an agent-defined subtitle theme with gradient fills', () => {
    const result = parseEditDoc({
      ...validDoc,
      subtitles: {
        enabled: true,
        preset: 'pill',
        theme: {
          fontFamily: 'Montserrat',
          fontWeight: 800,
          fill: { kind: 'solid', color: '#F7F3EE' },
          highlightFill: { kind: 'gradient', from: '#FF7A00', to: '#7C5CFF' },
          backgroundStyle: 'none',
          outlineColor: '#101010',
          outlineWidth: 3,
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects unsafe subtitle colors and font declarations', () => {
    const result = parseEditDoc({
      ...validDoc,
      subtitles: {
        enabled: true,
        preset: 'pill',
        theme: {
          fontFamily: 'Arial,PrimaryColour=&H00FFFFFF',
          highlightFill: { kind: 'solid', color: 'pink' },
        },
      },
    });
    expect(result.ok).toBe(false);
  });

  it('accepts a document with hidden subtitle ranges and word corrections', () => {
    const result = parseEditDoc({
      ...validDoc,
      subtitles: {
        enabled: true,
        preset: '2p-caps',
        hiddenRanges: [{ source: 'cam', start: 4.2, end: 4.8 }],
        corrections: [{ source: 'cam', at: 1.5, text: 'certinho' }],
      },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a hidden subtitle range whose end does not exceed its start', () => {
    const result = parseEditDoc({
      ...validDoc,
      subtitles: {
        enabled: true,
        preset: '2p-caps',
        hiddenRanges: [{ source: 'cam', start: 4.8, end: 4.8 }],
      },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a correction at a negative time', () => {
    const result = parseEditDoc({
      ...validDoc,
      subtitles: {
        enabled: true,
        preset: '2p-caps',
        corrections: [{ source: 'cam', at: -1, text: 'certinho' }],
      },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a correction containing line breaks (would corrupt the SRT framing)', () => {
    const result = parseEditDoc({
      ...validDoc,
      subtitles: {
        enabled: true,
        preset: '2p-caps',
        corrections: [{ source: 'cam', at: 0, text: 'a\n\nb' }],
      },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a correction with an extra field', () => {
    const result = parseEditDoc({
      ...validDoc,
      subtitles: {
        enabled: true,
        preset: '2p-caps',
        corrections: [{ source: 'cam', wordIndex: 0, text: 'certinho', confidence: 0.9 }],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('no longer use wordIndex');
    expect(result.error.message).toContain('{ source, at, text }');
  });

  it('labels a root-level issue as (root) instead of an empty path', () => {
    const result = parseEditDoc('not an object');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('(root):');
  });

  it('does not attach the wordIndex hint to unrelated correction errors', () => {
    const result = parseEditDoc({
      ...validDoc,
      subtitles: {
        enabled: true,
        preset: '2p-caps',
        corrections: [{ source: 'cam', at: -1, text: 'certinho' }],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).not.toContain('wordIndex');
  });

  function docWithEffectBlock(block: unknown) {
    return {
      ...validDoc,
      tracks: [...validDoc.tracks, { id: 'effects', kind: 'effect', blocks: [block] }],
    };
  }

  it('accepts a zoom effect block', () => {
    const result = parseEditDoc(
      docWithEffectBlock({ type: 'zoom', at: 1, duration: 2, scale: 1.2 }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a zoom effect with scale outside 1.01–2', () => {
    const result = parseEditDoc(docWithEffectBlock({ type: 'zoom', at: 1, duration: 2, scale: 1 }));
    expect(result.ok).toBe(false);
  });

  it('accepts a flash effect block', () => {
    const result = parseEditDoc(docWithEffectBlock({ type: 'flash', at: 1, duration: 0.25 }));
    expect(result.ok).toBe(true);
  });

  it('rejects a flash effect with a scale field (unknown to this variant)', () => {
    const result = parseEditDoc(
      docWithEffectBlock({ type: 'flash', at: 1, duration: 0.25, scale: 1.2 }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a flash effect with duration outside 0.08–0.6', () => {
    expect(parseEditDoc(docWithEffectBlock({ type: 'flash', at: 1, duration: 0.05 })).ok).toBe(
      false,
    );
    expect(parseEditDoc(docWithEffectBlock({ type: 'flash', at: 1, duration: 0.7 })).ok).toBe(
      false,
    );
  });

  it('accepts a shake effect block with and without intensity', () => {
    expect(parseEditDoc(docWithEffectBlock({ type: 'shake', at: 1, duration: 0.5 })).ok).toBe(true);
    expect(
      parseEditDoc(docWithEffectBlock({ type: 'shake', at: 1, duration: 0.5, intensity: 8 })).ok,
    ).toBe(true);
  });

  it('rejects a shake effect with duration outside 0.15–1.5', () => {
    expect(parseEditDoc(docWithEffectBlock({ type: 'shake', at: 1, duration: 0.1 })).ok).toBe(
      false,
    );
    expect(parseEditDoc(docWithEffectBlock({ type: 'shake', at: 1, duration: 1.6 })).ok).toBe(
      false,
    );
  });

  it('rejects a shake effect with intensity outside 1–10', () => {
    expect(
      parseEditDoc(docWithEffectBlock({ type: 'shake', at: 1, duration: 0.5, intensity: 0 })).ok,
    ).toBe(false);
    expect(
      parseEditDoc(docWithEffectBlock({ type: 'shake', at: 1, duration: 0.5, intensity: 11 })).ok,
    ).toBe(false);
  });

  it('rejects a shake effect with a non-integer intensity', () => {
    const result = parseEditDoc(
      docWithEffectBlock({ type: 'shake', at: 1, duration: 0.5, intensity: 3.5 }),
    );
    expect(result.ok).toBe(false);
  });

  function docWithBaseTransition(transition: unknown) {
    return {
      ...validDoc,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          label: 'camera',
          blocks: [
            { source: 'cam', in: 1.51, out: 5.9 },
            { source: 'cam', in: 6.33, out: 10.84, transition },
          ],
        },
        ...validDoc.tracks.slice(1),
      ],
    };
  }

  it('accepts a base block with a valid transition', () => {
    const result = parseEditDoc(docWithBaseTransition({ type: 'fade-black', durationS: 0.3 }));
    expect(result.ok).toBe(true);
  });

  it('rejects a transition duration outside 0.1–1.0', () => {
    const result = parseEditDoc(docWithBaseTransition({ type: 'crossfade', durationS: 1.5 }));
    expect(result.ok).toBe(false);
  });

  it('rejects a transition with an extra field', () => {
    const result = parseEditDoc(
      docWithBaseTransition({ type: 'fade-white', durationS: 0.3, easing: 'linear' }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('transcription keyterms', () => {
  it('reads an empty list from a document without the section', () => {
    const parsed = parseEditDoc(validDoc);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(transcriptionKeyterms(parsed.value)).toEqual([]);
  });

  it('keeps trimmed keyterms in the authored order', () => {
    const parsed = parseEditDoc({
      ...validDoc,
      transcription: { keyterms: [' Leadzy Extensão', 'Carla'] },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok)
      expect(transcriptionKeyterms(parsed.value)).toEqual(['Leadzy Extensão', 'Carla']);
  });

  it.each([
    ['an empty term', { keyterms: [''] }],
    ['a term of 50 characters', { keyterms: ['x'.repeat(50)] }],
    ['a term of six words', { keyterms: ['um dois três quatro cinco seis'] }],
    ['more than 100 terms', { keyterms: Array.from({ length: 101 }, (_, i) => `t${String(i)}`) }],
    ['an unknown field', { keyterms: ['ok'], language: 'pt' }],
  ])('rejects %s', (_label, transcription) => {
    expect(parseEditDoc({ ...validDoc, transcription }).ok).toBe(false);
  });
});
