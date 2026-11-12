import { describe, expect, it } from 'vitest';
import {
  NOISE_FLOOR_FALLBACK_DB,
  NOISE_FLOOR_MAX_DB,
  NOISE_FLOOR_MIN_DB,
} from '../../core/render/options.js';
import type { SilenceInterval } from '../../core/silence.js';
import {
  AFFTDN_PROFILE_BAND_COUNT,
  intersectIntervals,
  noiseFloorDbFromSamples,
  parseAfftdnBandProfile,
} from './noiseFloor.js';

const SAMPLE_RATE = 8000;

function sineSegment(durationS: number, amplitude: number, freqHz = 220): Float32Array {
  const n = Math.round(durationS * SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE);
  }
  return out;
}

function concat(...segments: Float32Array[]): Float32Array {
  const total = segments.reduce((sum, s) => sum + s.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const segment of segments) {
    out.set(segment, offset);
    offset += segment.length;
  }
  return out;
}

describe('noiseFloorDbFromSamples', () => {
  it('measures a low floor from a quiet silence window, ignoring the loud speech region', () => {
    const speech = sineSegment(0.5, 0.5);
    const roomTone = sineSegment(0.5, 0.02, 60);
    const samples = concat(speech, roomTone);
    const silences: SilenceInterval[] = [{ start: 0.5, end: 1.0 }];

    const floorDb = noiseFloorDbFromSamples(samples, SAMPLE_RATE, silences);

    // room tone at amplitude 0.02 measures ~-37dBFS; speech at 0.5 measures
    // ~-9dBFS — a floor this low proves the loud region was NOT sampled.
    expect(floorDb).toBeGreaterThan(NOISE_FLOOR_MIN_DB);
    expect(floorDb).toBeLessThan(-30);
  });

  it('falls back to -50 dBFS when no silence window is supplied', () => {
    const samples = sineSegment(1, 0.5);

    const floorDb = noiseFloorDbFromSamples(samples, SAMPLE_RATE, []);

    expect(floorDb).toBe(NOISE_FLOOR_FALLBACK_DB);
  });

  it('falls back when the supplied silence totals under 200ms', () => {
    const samples = sineSegment(1, 0.02, 60);
    const silences: SilenceInterval[] = [{ start: 0, end: 0.1 }];

    const floorDb = noiseFloorDbFromSamples(samples, SAMPLE_RATE, silences);

    expect(floorDb).toBe(NOISE_FLOOR_FALLBACK_DB);
  });

  it('clamps an extremely quiet silence window to the -80dB floor', () => {
    const samples = sineSegment(1, 0.00001, 60);
    const silences: SilenceInterval[] = [{ start: 0, end: 1 }];

    const floorDb = noiseFloorDbFromSamples(samples, SAMPLE_RATE, silences);

    expect(floorDb).toBe(NOISE_FLOOR_MIN_DB);
  });

  it('clamps a silence window measured louder than -20dB to the ceiling', () => {
    const samples = sineSegment(1, 0.9, 60);
    const silences: SilenceInterval[] = [{ start: 0, end: 1 }];

    const floorDb = noiseFloorDbFromSamples(samples, SAMPLE_RATE, silences);

    expect(floorDb).toBe(NOISE_FLOOR_MAX_DB);
  });

  it('treats an all-zero silence window as the -80dB floor, not -Infinity', () => {
    const samples = new Float32Array(SAMPLE_RATE);
    const silences: SilenceInterval[] = [{ start: 0, end: 1 }];

    const floorDb = noiseFloorDbFromSamples(samples, SAMPLE_RATE, silences);

    expect(floorDb).toBe(NOISE_FLOOR_MIN_DB);
  });

  it('measures only the source windows actually used, ignoring a digitally-silent head/tail outside them', () => {
    // 0-2s: digital silence (as if past every cut — never rendered).
    // 2-3s: room tone at ~-45dBFS (the base track's actual [in,out) window).
    // 3-5s: digital silence again.
    const zerosHead = new Float32Array(2 * SAMPLE_RATE);
    const roomTone = sineSegment(1, 0.00795, 60);
    const zerosTail = new Float32Array(2 * SAMPLE_RATE);
    const samples = concat(zerosHead, roomTone, zerosTail);

    // A whole-file silence scan would flag all of 0-5s as quiet.
    const wholeFileSilences: SilenceInterval[] = [{ start: 0, end: 5 }];
    const usedWindows: SilenceInterval[] = [{ start: 2, end: 3 }];

    const floorDb = noiseFloorDbFromSamples(
      samples,
      SAMPLE_RATE,
      intersectIntervals(wholeFileSilences, usedWindows),
    );

    // Without the intersection this would clamp to -80 (dominated by the 4s
    // of digital silence); scoped to the used window it reflects the ~-45dB
    // room tone instead.
    expect(floorDb).toBeGreaterThan(-50);
    expect(floorDb).toBeLessThan(-40);
  });

  it('falls back to -50dBFS when the intersection with the used windows totals under 200ms', () => {
    const samples = sineSegment(1, 0.008, 60);
    const wholeFileSilences: SilenceInterval[] = [{ start: 0, end: 1 }];
    const usedWindows: SilenceInterval[] = [{ start: 0, end: 0.1 }];

    const floorDb = noiseFloorDbFromSamples(
      samples,
      SAMPLE_RATE,
      intersectIntervals(wholeFileSilences, usedWindows),
    );

    expect(floorDb).toBe(NOISE_FLOOR_FALLBACK_DB);
  });
});

describe('intersectIntervals', () => {
  it('keeps only the overlapping portion of two interval lists', () => {
    const a: SilenceInterval[] = [{ start: 0, end: 5 }];
    const b: SilenceInterval[] = [
      { start: 2, end: 3 },
      { start: 4, end: 6 },
    ];

    expect(intersectIntervals(a, b)).toEqual([
      { start: 2, end: 3 },
      { start: 4, end: 5 },
    ]);
  });

  it('returns nothing for non-overlapping intervals', () => {
    const a: SilenceInterval[] = [{ start: 0, end: 1 }];
    const b: SilenceInterval[] = [{ start: 2, end: 3 }];

    expect(intersectIntervals(a, b)).toEqual([]);
  });

  it('excludes a touching-but-not-overlapping boundary (zero-length intersection)', () => {
    const a: SilenceInterval[] = [{ start: 0, end: 2 }];
    const b: SilenceInterval[] = [{ start: 2, end: 4 }];

    expect(intersectIntervals(a, b)).toEqual([]);
  });

  it('returns an empty list when either input is empty', () => {
    expect(intersectIntervals([], [{ start: 0, end: 1 }])).toEqual([]);
    expect(intersectIntervals([{ start: 0, end: 1 }], [])).toEqual([]);
  });
});

describe('parseAfftdnBandProfile', () => {
  const profile = [
    13.491182, 11.013278, 8.853911, 6.911881, 5.102978, 3.35998, 1.63265, -0.112258, -1.891005,
    -3.702863, -5.530118, -7.338067, -9.075019, -10.672297, -12.044235,
  ];

  it('extracts the stable 15-band bn payload from ffmpeg logger output', () => {
    const stderr = [
      'Stream mapping:',
      `[Parsed_afftdn_1 @ 0x123] bn=${profile.join(' ')} `,
      'video:0KiB audio:112KiB',
    ].join('\n');

    expect(parseAfftdnBandProfile(stderr)).toEqual(profile);
    expect(parseAfftdnBandProfile(stderr)).toHaveLength(AFFTDN_PROFILE_BAND_COUNT);
  });

  it('uses the last valid profile and rejects malformed or non-finite payloads', () => {
    const first = new Array(AFFTDN_PROFILE_BAND_COUNT).fill(1).join(' ');
    const last = new Array(AFFTDN_PROFILE_BAND_COUNT).fill(-2).join(' ');
    expect(parseAfftdnBandProfile(`bn=${first}\nbn=broken\nbn=${last}\n`)).toEqual(
      new Array(AFFTDN_PROFILE_BAND_COUNT).fill(-2),
    );
    expect(parseAfftdnBandProfile('bn=1 2 3\n')).toBeUndefined();
    expect(
      parseAfftdnBandProfile(`bn=${new Array(14).fill('0').join(' ')} Infinity\n`),
    ).toBeUndefined();
  });
});
