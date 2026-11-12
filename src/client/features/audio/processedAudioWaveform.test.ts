import { describe, expect, it } from 'vitest';
import {
  audioComparisonDuration,
  audioTimeAtFraction,
  audioTimeFromSliderKey,
  audioWaveformEnvelopePeak,
  boundedAudioTime,
  buildAudioWaveformEnvelope,
  formatAudioClock,
  formatAudioPosition,
  sharedAudioWaveformPeak,
} from './processedAudioWaveform.js';

describe('processed audio waveform helpers', () => {
  it('reduces decoded stereo PCM to a mono min/max envelope', () => {
    const envelope = buildAudioWaveformEnvelope(
      [new Float32Array([-1, 0.5, 0.25, -0.5]), new Float32Array([-0.5, 0.5, -0.25, 1])],
      2,
    );
    expect(envelope.min).toEqual([-0.75, 0]);
    expect(envelope.max).toEqual([0.5, 0.25]);
  });

  it('returns a stable silent envelope when decoded audio has no samples', () => {
    expect(buildAudioWaveformEnvelope([], 3)).toEqual({ min: [0, 0, 0], max: [0, 0, 0] });
  });

  it('maps waveform positions to bounded media time and formats the transport clock', () => {
    expect(audioTimeAtFraction(0.25, 80)).toBe(20);
    expect(audioTimeAtFraction(2, 80)).toBe(80);
    expect(boundedAudioTime(90, 80)).toBe(80);
    expect(boundedAudioTime(-5, 80)).toBe(0);
    expect(formatAudioClock(65.9)).toBe('01:05');
    expect(formatAudioPosition(65.9, 80)).toBe('01:05 / 01:20');
  });

  it('implements the complete keyboard contract for the waveform slider', () => {
    expect(audioTimeFromSliderKey('ArrowLeft', 20, 80)).toBe(15);
    expect(audioTimeFromSliderKey('ArrowDown', 20, 80)).toBe(15);
    expect(audioTimeFromSliderKey('ArrowRight', 20, 80)).toBe(25);
    expect(audioTimeFromSliderKey('ArrowUp', 20, 80)).toBe(25);
    expect(audioTimeFromSliderKey('Home', 20, 80)).toBe(0);
    expect(audioTimeFromSliderKey('End', 20, 80)).toBe(80);
    expect(audioTimeFromSliderKey('Enter', 20, 80)).toBeNull();
    expect(audioTimeFromSliderKey(' ', 20, 80)).toBeNull();
  });

  it('uses one amplitude scale for both sides of an A/B comparison', () => {
    const quiet = { min: [-0.1, -0.2], max: [0.1, 0.15] };
    const loud = { min: [-0.75], max: [0.6] };

    expect(audioWaveformEnvelopePeak(quiet)).toBe(0.2);
    expect(sharedAudioWaveformPeak([quiet, loud])).toBe(0.75);
    expect(sharedAudioWaveformPeak([{ min: [0], max: [0] }])).toBe(0.04);
  });

  it('replaces the document fallback with measured A/B duration after global speed', () => {
    expect(audioComparisonDuration([null, null], 49.6)).toBe(49.6);
    expect(audioComparisonDuration([null, 24.8], 49.6)).toBe(24.8);
    expect(audioComparisonDuration([24.8, 24.79], 49.6)).toBe(24.79);
  });
});
