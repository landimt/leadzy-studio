import { describe, expect, it } from 'vitest';
import {
  clampDenoiseSample,
  denoiseReductionDb,
  moveDenoiseSample,
  resizeDenoiseSample,
  roomToneSuggestions,
  waveformTimeAtFraction,
} from './audioSample.js';

describe('room-tone sample helpers', () => {
  it('clamps manual samples to 0.5–2s and keeps them inside the source', () => {
    expect(clampDenoiseSample({ source: 'cam', start: 9.9, end: 13 }, 10)).toEqual({
      source: 'cam',
      start: 8,
      end: 10,
    });
    expect(clampDenoiseSample({ source: 'cam', start: 2, end: 2.1 }, 10)).toEqual({
      source: 'cam',
      start: 2,
      end: 2.5,
    });
  });

  it('returns detected silences as guarded, bounded source-time suggestions', () => {
    const suggestions = roomToneSuggestions([
      {
        source: 'cam',
        intervals: [
          { start: 1, end: 1.3 },
          { start: 4, end: 7 },
        ],
      },
    ]);
    expect(suggestions).toEqual([{ source: 'cam', start: 4.875, end: 6.125 }]);
  });

  it('keeps useful suggestions available for every source', () => {
    const suggestions = roomToneSuggestions(
      [
        { source: 'cam-a', intervals: [{ start: 1, end: 3 }] },
        { source: 'cam-b', intervals: [{ start: 4, end: 6 }] },
      ],
      1,
    );
    expect(suggestions.map((sample) => sample.source)).toEqual(['cam-a', 'cam-b']);
  });

  it('maps pointer fractions and moves a selection without leaving the source', () => {
    expect(waveformTimeAtFraction(0.25, 20)).toBe(5);
    expect(waveformTimeAtFraction(2, 20)).toBe(20);
    expect(moveDenoiseSample({ source: 'cam', start: 4, end: 5 }, 30, 10)).toEqual({
      source: 'cam',
      start: 9,
      end: 10,
    });
  });

  it('resizes either waveform handle within the 0.5–2s contract', () => {
    const sample = { source: 'cam', start: 4, end: 5 };
    expect(resizeDenoiseSample(sample, 'start', 0, 10)).toEqual({
      source: 'cam',
      start: 3,
      end: 5,
    });
    expect(resizeDenoiseSample(sample, 'end', 9, 10)).toEqual({
      source: 'cam',
      start: 4,
      end: 6,
    });
  });

  it('reports the same 6–24 dB denoise reduction configured in the renderer', () => {
    expect(denoiseReductionDb(0)).toBe(0);
    expect(denoiseReductionDb(0.5)).toBe(15);
    expect(denoiseReductionDb(1)).toBe(24);
  });
});
