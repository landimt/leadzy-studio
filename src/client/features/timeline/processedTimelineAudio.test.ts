import type { EditDoc } from '../../../core/schema.js';
import { outputSegments } from '../../../core/timeline.js';
import { describe, expect, it } from 'vitest';
import { resamplePeaks } from '../../../core/peaks.js';
import {
  baseHasEntireAudioMix,
  processedSegmentWindow,
  processedAudioEnd,
  processedTimelinePeaks,
  processedTimelineSource,
} from './processedTimelineAudio.js';

describe('processed audio on the timeline', () => {
  it('never presents missing or stale audio as the current montage', () => {
    const url = (path: string): string => `/media/${path}`;
    expect(processedTimelineSource(false, false, 1, url)).toBeNull();
    expect(processedTimelineSource(true, true, 1, url)).toBeNull();
    expect(processedTimelineSource(true, false, 2, url)).toBe('/media/edit/audio-preview.m4a?v=2');
    expect(processedTimelineSource(true, false, 3, url)).not.toBe(
      processedTimelineSource(true, false, 2, url),
    );
  });

  it('maps the final audio clock back to the full edit, including global speed', () => {
    const samples = new Float32Array(1000);
    samples[250] = 0.5;
    samples[750] = -0.8;
    const peaks = processedTimelinePeaks([samples], 1000);
    const range = processedAudioEnd(2, 2);
    const drawn = resamplePeaks(peaks, 0, range, 4);
    expect(range).toBe(1);
    expect(processedAudioEnd(2, 0.5)).toBe(4);
    expect(drawn.max[1]).toBe(0.5);
    expect(drawn.min[3]).toBeCloseTo(-0.8);
  });

  it('keeps measured amplitude, duration and silent audio without visual normalization', () => {
    const quiet = processedTimelinePeaks([new Float32Array([0, 0.01, -0.02, 0])], 100);
    expect(quiet.windowMs * quiet.min.length).toBe(40);
    expect(Math.max(...quiet.max)).toBeCloseTo(0.01);
    expect(Math.min(...quiet.min)).toBeCloseTo(-0.02);
    expect(processedTimelinePeaks([], 48000).max).toEqual([0]);
  });
});

const montage: EditDoc = {
  version: 2,
  fps: 30,
  output: { width: 1080, height: 1920, loudnormLufs: -14, speed: 2 },
  sources: { cam: { path: 'cam.mp4' } },
  subtitles: { enabled: false, preset: 'pill' },
  tracks: [
    {
      id: 'base',
      kind: 'video',
      blocks: [
        { source: 'cam', in: 87, out: 91, speed: 2 },
        { source: 'cam', in: 30, out: 33 },
        { source: 'cam', in: 87, out: 91 },
      ],
    },
  ],
};

it('slices processed output per cut without changing source thumbnails, including repeats and both speeds', () => {
  const ranges = outputSegments(montage).map((segment) =>
    processedSegmentWindow(segment, montage.output.speed),
  );
  expect(ranges).toEqual([
    { from: 0, to: 1 },
    { from: 1, to: 2.5 },
    { from: 2.5, to: 4.5 },
  ]);
});

it('uses the final waveform on base clips only when the base owns the whole audible mix', () => {
  expect(baseHasEntireAudioMix(montage)).toBe(true);
  const music = {
    id: 'music',
    kind: 'audio' as const,
    blocks: [{ source: 'cam', in: 0, out: 2, at: 0 }],
  };
  expect(baseHasEntireAudioMix({ ...montage, tracks: [...montage.tracks, music] })).toBe(false);
  expect(
    baseHasEntireAudioMix({ ...montage, tracks: [...montage.tracks, { ...music, muted: true }] }),
  ).toBe(true);
  const layer = {
    id: 'demo',
    kind: 'video' as const,
    blocks: [
      { source: 'cam', in: 0, out: 2, at: 0, mode: 'fullscreen' as const, audio: 'mute' as const },
    ],
  };
  expect(baseHasEntireAudioMix({ ...montage, tracks: [...montage.tracks, layer] })).toBe(true);
  expect(
    baseHasEntireAudioMix({
      ...montage,
      tracks: [...montage.tracks, { ...layer, blocks: [{ ...layer.blocks[0]!, audio: 'solo' }] }],
    }),
  ).toBe(false);
});
