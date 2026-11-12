import { expect, it } from 'vitest';
import { overlayPlaybackFrame } from './overlayPlayback.js';

it('plays the selected source interval normally', () => {
  expect(overlayPlaybackFrame(2.5, 4)).toEqual({ time: 2.5, hold: false });
});
it('holds the last frame throughout an extended overlay without restarting', () => {
  expect(overlayPlaybackFrame(4, 4)).toEqual({ time: 3.999, hold: true });
  expect(overlayPlaybackFrame(5.07, 4)).toEqual({ time: 3.999, hold: true });
});
it('waits for a finite duration before deciding the hold', () => {
  expect(overlayPlaybackFrame(2.5, NaN)).toEqual({ time: 2.5, hold: false });
});
