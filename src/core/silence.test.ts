import { describe, expect, it } from 'vitest';
import { detectSilences, int16ToFloat32 } from './silence.js';

const SAMPLE_RATE = 8000;

function tone(durationS: number, amplitude: number): number[] {
  const samples = Math.round(durationS * SAMPLE_RATE);
  return Array.from(
    { length: samples },
    (_, i) => amplitude * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE),
  );
}

describe('detectSilences', () => {
  it('finds a known silence between two loud passages', () => {
    // 1s speech · 0.8s silence · 1s speech
    const pcm = Float32Array.from([...tone(1, 0.5), ...tone(0.8, 0.001), ...tone(1, 0.5)]);
    const silences = detectSilences(pcm, SAMPLE_RATE);
    expect(silences).toHaveLength(1);
    expect(silences[0]!.start).toBeCloseTo(1, 1);
    expect(silences[0]!.end).toBeCloseTo(1.8, 1);
  });

  it('ignores pauses shorter than minSilenceS', () => {
    const pcm = Float32Array.from([...tone(1, 0.5), ...tone(0.3, 0.001), ...tone(1, 0.5)]);
    expect(detectSilences(pcm, SAMPLE_RATE)).toHaveLength(0);
  });

  it('detects trailing silence', () => {
    const pcm = Float32Array.from([...tone(1, 0.5), ...tone(1, 0.001)]);
    const silences = detectSilences(pcm, SAMPLE_RATE);
    expect(silences).toHaveLength(1);
    expect(silences[0]!.end).toBeCloseTo(2, 1);
  });

  it('respects a custom threshold', () => {
    // amplitude 0.01 sine ≈ -43dB RMS: silent at -40dB, audible at -50dB
    const pcm = Float32Array.from([...tone(1, 0.5), ...tone(0.8, 0.01), ...tone(1, 0.5)]);
    expect(detectSilences(pcm, SAMPLE_RATE, { thresholdDb: -40 })).toHaveLength(1);
    expect(detectSilences(pcm, SAMPLE_RATE, { thresholdDb: -50 })).toHaveLength(0);
  });
});

describe('int16ToFloat32', () => {
  it('scales symmetric extremes to [-1, 1)', () => {
    const out = int16ToFloat32(Int16Array.from([-32768, 0, 32767]));
    expect(out[0]).toBe(-1);
    expect(out[1]).toBe(0);
    expect(out[2]).toBeCloseTo(1, 3);
  });
});
