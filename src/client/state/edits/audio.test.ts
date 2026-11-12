import { describe, expect, it } from 'vitest';
import type { EditDoc } from '../../../core/schema.js';
import type { MediaSummary } from '../../api.js';
import {
  setAudioBlockFades,
  setAudioBlockGain,
  setDenoise,
  setDenoiseSample,
  setJoinAudioCrossfadeMs,
  setLoudnormLufs,
  setOutputSpeed,
} from './audio.js';

function makeDoc(output: Partial<EditDoc['output']> = {}): EditDoc {
  return {
    version: 2,
    fps: 25,
    output: { width: 1080, height: 1920, loudnormLufs: -14, ...output },
    sources: { cam: { path: 'camera.mp4', durationS: 10 }, room: { path: 'room.wav' } },
    tracks: [
      { id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 4 }] },
      { id: 'audio-1', kind: 'audio', blocks: [{ source: 'cam', in: 1, out: 4, at: 2 }] },
    ],
    subtitles: { enabled: false, preset: '2p-caps' },
    totalDurationS: 4,
  };
}

const AUDIO = 'audio-1';

function audioBlock(doc: EditDoc | null): unknown {
  const track = doc?.tracks[1];
  return track?.kind === 'audio' ? track.blocks[0] : null;
}

const image: MediaSummary = {
  kind: 'image',
  relPath: 'room.wav',
  width: 1,
  height: 1,
  hasAudio: false,
  transcriptEngine: null,
  proxyRelPath: null,
};
const roomTone: MediaSummary = {
  kind: 'audio',
  relPath: 'room.wav',
  durationS: 3,
  hasAudio: true,
  transcriptEngine: null,
  proxyRelPath: null,
};

describe('setAudioBlockGain', () => {
  it('clamps into [-60, 12], rounds, and removes the field at zero', () => {
    expect(audioBlock(setAudioBlockGain(makeDoc(), AUDIO, 0, 99))).toStrictEqual({
      source: 'cam',
      in: 1,
      out: 4,
      at: 2,
      gainDb: 12,
    });
    expect(audioBlock(setAudioBlockGain(makeDoc(), AUDIO, 0, -99.555))).toStrictEqual({
      source: 'cam',
      in: 1,
      out: 4,
      at: 2,
      gainDb: -60,
    });
    const boosted = setAudioBlockGain(makeDoc(), AUDIO, 0, 3.456);
    expect(audioBlock(boosted)).toStrictEqual({
      source: 'cam',
      in: 1,
      out: 4,
      at: 2,
      gainDb: 3.46,
    });
    expect(audioBlock(setAudioBlockGain(boosted ?? makeDoc(), AUDIO, 0, 0))).toStrictEqual({
      source: 'cam',
      in: 1,
      out: 4,
      at: 2,
    });
  });

  it('is a no-op on the same gain, on zero without a field, on non-finite values and unknown blocks', () => {
    const boosted = setAudioBlockGain(makeDoc(), AUDIO, 0, 3);
    expect(setAudioBlockGain(boosted ?? makeDoc(), AUDIO, 0, 3.004)).toBeNull();
    expect(setAudioBlockGain(makeDoc(), AUDIO, 0, 0)).toBeNull();
    expect(setAudioBlockGain(makeDoc(), AUDIO, 0, Number.NaN)).toBeNull();
    expect(setAudioBlockGain(makeDoc(), AUDIO, 5, 3)).toBeNull();
    expect(setAudioBlockGain(makeDoc(), 'base', 0, 3)).toBeNull();
  });
});

describe('setAudioBlockFades', () => {
  it('sets both sides, rounds to 3 decimals, and keeps an omitted side', () => {
    const both = setAudioBlockFades(makeDoc(), AUDIO, 0, { fadeInS: 0.2004, fadeOutS: 0.5 });
    expect(audioBlock(both)).toStrictEqual({
      source: 'cam',
      in: 1,
      out: 4,
      at: 2,
      fadeInS: 0.2,
      fadeOutS: 0.5,
    });
    expect(
      audioBlock(setAudioBlockFades(both ?? makeDoc(), AUDIO, 0, { fadeOutS: 1 })),
    ).toStrictEqual({
      source: 'cam',
      in: 1,
      out: 4,
      at: 2,
      fadeInS: 0.2,
      fadeOutS: 1,
    });
  });

  it('fits the envelope inside the clip: fade-in caps at the duration, fade-out at what is left', () => {
    expect(
      audioBlock(setAudioBlockFades(makeDoc(), AUDIO, 0, { fadeInS: 9, fadeOutS: 9 })),
    ).toStrictEqual({
      source: 'cam',
      in: 1,
      out: 4,
      at: 2,
      fadeInS: 3,
    });
    expect(
      audioBlock(setAudioBlockFades(makeDoc(), AUDIO, 0, { fadeInS: 2, fadeOutS: 9 })),
    ).toStrictEqual({
      source: 'cam',
      in: 1,
      out: 4,
      at: 2,
      fadeInS: 2,
      fadeOutS: 1,
    });
  });

  it('clears a side at zero (or below) and is a no-op when nothing changes, on NaN, or on unknown blocks', () => {
    const both = setAudioBlockFades(makeDoc(), AUDIO, 0, { fadeInS: 0.5, fadeOutS: 0.5 });
    expect(
      audioBlock(setAudioBlockFades(both ?? makeDoc(), AUDIO, 0, { fadeInS: -1 })),
    ).toStrictEqual({
      source: 'cam',
      in: 1,
      out: 4,
      at: 2,
      fadeOutS: 0.5,
    });
    expect(setAudioBlockFades(both ?? makeDoc(), AUDIO, 0, { fadeInS: 0.5 })).toBeNull();
    expect(setAudioBlockFades(makeDoc(), AUDIO, 0, {})).toBeNull();
    expect(setAudioBlockFades(makeDoc(), AUDIO, 0, { fadeInS: Number.NaN })).toBeNull();
    expect(
      setAudioBlockFades(makeDoc(), AUDIO, 0, { fadeOutS: Number.POSITIVE_INFINITY }),
    ).toBeNull();
    expect(setAudioBlockFades(makeDoc(), AUDIO, 3, { fadeInS: 1 })).toBeNull();
  });
});

describe('output audio settings', () => {
  it('denoise clamps into [0, 1], rounds, removes the field at zero, and ignores NaN', () => {
    expect(setDenoise(makeDoc(), 7)?.output.denoise).toBe(1);
    expect(setDenoise(makeDoc(), 0.456)?.output.denoise).toBe(0.46);
    expect(setDenoise(makeDoc({ denoise: 0.5 }), -1)?.output).toStrictEqual({
      width: 1080,
      height: 1920,
      loudnormLufs: -14,
    });
    expect(setDenoise(makeDoc(), Number.NaN)).toBeNull();
  });

  it('loudnorm clamps into [-24, -9], rounds, accepts null, and ignores NaN', () => {
    expect(setLoudnormLufs(makeDoc(), 0)?.output.loudnormLufs).toBe(-9);
    expect(setLoudnormLufs(makeDoc(), -99)?.output.loudnormLufs).toBe(-24);
    expect(setLoudnormLufs(makeDoc(), -16.123)?.output.loudnormLufs).toBe(-16.12);
    expect(setLoudnormLufs(makeDoc(), null)?.output.loudnormLufs).toBeNull();
    expect(setLoudnormLufs(makeDoc(), Number.NaN)).toBeNull();
  });

  it('speed clamps into the speed bounds, removes the field at 1, and refuses zero, negatives and NaN', () => {
    expect(setOutputSpeed(makeDoc(), 9)?.output.speed).toBe(2);
    expect(setOutputSpeed(makeDoc(), 0.1)?.output.speed).toBe(0.5);
    expect(setOutputSpeed(makeDoc(), 1.234)?.output.speed).toBe(1.23);
    expect(setOutputSpeed(makeDoc({ speed: 1.5 }), 1)?.output).toStrictEqual({
      width: 1080,
      height: 1920,
      loudnormLufs: -14,
    });
    expect(setOutputSpeed(makeDoc(), 0)).toBeNull();
    expect(setOutputSpeed(makeDoc(), -1)).toBeNull();
    expect(setOutputSpeed(makeDoc(), Number.NaN)).toBeNull();
  });

  it('crossfade rounds to an integer, clamps into [0, 200], removes the field at zero, and ignores NaN', () => {
    expect(setJoinAudioCrossfadeMs(makeDoc(), 999)?.output.joinAudioCrossfadeMs).toBe(200);
    expect(setJoinAudioCrossfadeMs(makeDoc(), 33.6)?.output.joinAudioCrossfadeMs).toBe(34);
    expect(
      setJoinAudioCrossfadeMs(makeDoc({ joinAudioCrossfadeMs: 80 }), -5)?.output,
    ).toStrictEqual({
      width: 1080,
      height: 1920,
      loudnormLufs: -14,
    });
    expect(setJoinAudioCrossfadeMs(makeDoc(), Number.NaN)).toBeNull();
  });
});

describe('setDenoiseSample', () => {
  it('stores a sample clamped to 0.5–2 s inside the source and rounded to milliseconds', () => {
    const next = setDenoiseSample(makeDoc(), undefined, { source: 'cam', start: 1.0004, end: 9 });
    expect(next?.output.denoiseSample).toStrictEqual({ source: 'cam', start: 1, end: 3 });

    const tail = setDenoiseSample(makeDoc(), undefined, { source: 'cam', start: 9.8, end: 9.9 });
    expect(tail?.output.denoiseSample).toStrictEqual({ source: 'cam', start: 9.5, end: 10 });
  });

  it('uses the media duration when the source has none, and accepts an unbounded source', () => {
    const bounded = setDenoiseSample(makeDoc(), roomTone, { source: 'room', start: 2.9, end: 3.5 });
    expect(bounded?.output.denoiseSample).toStrictEqual({ source: 'room', start: 2.4, end: 3 });

    const open = setDenoiseSample(makeDoc(), undefined, { source: 'room', start: 40, end: 41 });
    expect(open?.output.denoiseSample).toStrictEqual({ source: 'room', start: 40, end: 41 });

    const minimum = setDenoiseSample(
      makeDoc(),
      { ...roomTone, durationS: 0.5 },
      { source: 'room', start: 0, end: 0.5 },
    );
    expect(minimum?.output.denoiseSample).toStrictEqual({ source: 'room', start: 0, end: 0.5 });
  });

  it('clears the sample on null and refuses unknown sources, empty or non-finite windows, images and sub-half-second media', () => {
    expect(
      setDenoiseSample(
        makeDoc({ denoiseSample: { source: 'cam', start: 1, end: 2 } }),
        undefined,
        null,
      )?.output,
    ).toStrictEqual({
      width: 1080,
      height: 1920,
      loudnormLufs: -14,
    });
    expect(setDenoiseSample(makeDoc(), undefined, { source: 'nope', start: 1, end: 2 })).toBeNull();
    expect(setDenoiseSample(makeDoc(), undefined, { source: 'cam', start: 2, end: 2 })).toBeNull();
    expect(
      setDenoiseSample(makeDoc(), undefined, { source: 'cam', start: Number.NaN, end: 2 }),
    ).toBeNull();
    expect(setDenoiseSample(makeDoc(), image, { source: 'room', start: 1, end: 2 })).toBeNull();
    expect(
      setDenoiseSample(
        makeDoc(),
        { ...roomTone, durationS: 0.4 },
        { source: 'room', start: 0, end: 0.4 },
      ),
    ).toBeNull();
  });
});
