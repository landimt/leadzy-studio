import { describe, expect, it } from 'vitest';
import { engineClockStep, type EngineClockInput } from './engineClock.js';

function frame(overrides: Partial<EngineClockInput> = {}): EngineClockInput {
  return {
    playing: true,
    playhead: 4,
    position: 4.1,
    fileEnd: Number.POSITIVE_INFINITY,
    ended: false,
    duration: 10,
    loop: false,
    speed: 1,
    ...overrides,
  };
}

describe('engineClockStep', () => {
  it.each([
    ['follows the video while playing within tolerance', frame(), { kind: 'follow', time: 4.1 }],
    [
      'seeks the video on a real jump while playing (a scrub)',
      frame({ playhead: 6, position: 4.1 }),
      { kind: 'seek-video', to: 6 },
    ],
    [
      'lets a drift just inside the tolerance pass while playing',
      frame({ playhead: 4, position: 4.25 }),
      { kind: 'follow', time: 4.25 },
    ],
    [
      'seeks on a drift just past the tolerance while playing',
      frame({ playhead: 4, position: 4.375 }),
      { kind: 'seek-video', to: 4 },
    ],
    [
      'reaching exactly the end epsilon counts as the end',
      frame({ playhead: 9.98, position: 9.98 }),
      { kind: 'stop' },
    ],
    [
      'stops at the document end even when the file has a little more',
      frame({ playhead: 9.99, position: 9.985 }),
      { kind: 'stop' },
    ],
    [
      'loops at the end when loop is on',
      frame({ playhead: 9.99, position: 9.99, loop: true }),
      { kind: 'loop' },
    ],
    [
      'stops when the file ended early',
      frame({ playhead: 8, position: 8, ended: true }),
      { kind: 'stop' },
    ],
    [
      'a jump wins over the end — a scrub back from the tail keeps playing',
      frame({ playhead: 2, position: 9.99, ended: true }),
      { kind: 'seek-video', to: 2 },
    ],
    [
      'holds while paused and in sync',
      frame({ playing: false, playhead: 4, position: 4.04 }),
      { kind: 'hold' },
    ],
    [
      'seeks the video while paused once the playhead moved past a scrub',
      frame({ playing: false, playhead: 4.1, position: 4 }),
      { kind: 'seek-video', to: 4.1 },
    ],
    [
      'never loops or stops while paused at the end',
      frame({ playing: false, playhead: 10, position: 10, ended: true, loop: true }),
      { kind: 'hold' },
    ],
  ] as const)('%s', (_label, input, expected) => {
    expect(engineClockStep(input)).toEqual(expected);
  });
});

describe('engineClockStep with output.speed', () => {
  it.each([
    [
      'follows the file in natural time — 4 s of file are 8 s of timeline at speed 2',
      frame({ speed: 2, playhead: 8, position: 4 }),
      { kind: 'follow', time: 8 },
    ],
    [
      'seeks the file to playhead / speed on a scrub',
      frame({ speed: 2, playhead: 6, position: 1 }),
      { kind: 'seek-video', to: 3 },
    ],
    [
      'measures the drift in natural time — half a file second is a full timeline second',
      frame({ speed: 2, playhead: 8, position: 3.8 }),
      { kind: 'seek-video', to: 4 },
    ],
    [
      'reaches the document end when the sped file reaches half of it',
      frame({ speed: 2, playhead: 9.99, position: 4.995 }),
      { kind: 'stop' },
    ],
    [
      'clamps the playhead to what the file can reach, in file units',
      frame({ playing: false, speed: 2, playhead: 10, position: 4.9, fileEnd: 4.9 }),
      { kind: 'hold' },
    ],
    [
      'still seeks a paused file that drifted from a reachable playhead',
      frame({ playing: false, speed: 2, playhead: 10, position: 4.5, fileEnd: 4.9 }),
      { kind: 'seek-video', to: 4.9 },
    ],
  ] as const)('%s', (_label, input, expected) => {
    expect(engineClockStep(input)).toEqual(expected);
  });
});
