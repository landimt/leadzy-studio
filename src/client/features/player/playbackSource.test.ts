import { describe, expect, it } from 'vitest';
import { playbackSourceUrl, resolvePlaybackMode } from './playbackSource.js';

describe('resolvePlaybackMode', () => {
  it.each([
    ['proof when the user asks for it and the preview is fresh', true, true, true, 'proof'],
    [
      'proof even when the program is stale — the preview is the whole output',
      true,
      true,
      false,
      'proof',
    ],
    ['engine when the proof is requested but the preview is stale', true, false, true, 'engine'],
    [
      'engine when the program is fresh and nobody asked for the proof',
      false,
      true,
      true,
      'engine',
    ],
    ['simulation when nothing fresh exists', false, false, false, 'simulation'],
    [
      'simulation when only the preview is fresh and nobody asked for the proof',
      false,
      true,
      false,
      'simulation',
    ],
    ['engine when only the program is fresh', false, false, true, 'engine'],
    ['simulation when only a stale proof was requested', true, false, false, 'simulation'],
  ] as const)('%s', (_label, proofRequested, previewFresh, programFresh, expected) => {
    expect(resolvePlaybackMode({ proofRequested, previewFresh, programFresh })).toBe(expected);
  });
});

describe('playbackSourceUrl', () => {
  const mediaUrl = (relPath: string): string => `/media/${relPath}`;

  it('plays the program in engine mode, busted by programVersion only', () => {
    expect(playbackSourceUrl('engine', { programVersion: 3, previewVersion: 9 }, mediaUrl)).toBe(
      '/media/edit/program.mp4?v=3',
    );
  });

  it('plays the preview in proof mode, busted by previewVersion only', () => {
    expect(playbackSourceUrl('proof', { programVersion: 3, previewVersion: 9 }, mediaUrl)).toBe(
      '/media/edit/preview.mp4?v=9',
    );
  });
});
