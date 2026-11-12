import { describe, expect, it } from 'vitest';
import { summarizeRenderProgress } from './renderProgress.js';

describe('summarizeRenderProgress', () => {
  it.each([
    ['a segment step', '[8/59] segment 8/25', { phase: 'segments', done: 8, total: 25 }],
    ['the last segment', '[25/59] segment 25/25', { phase: 'segments', done: 25, total: 25 }],
    ['a later step', '[57/59] compose', { phase: 'steps', done: 57, total: 59 }],
    [
      'an audio step that mentions segments differently',
      '[28/59] audio crossfade extend segment 1/25',
      { phase: 'steps', done: 28, total: 59 },
    ],
  ] as const)('reads %s', (_label, progress, expected) => {
    expect(summarizeRenderProgress(progress)).toEqual(expected);
  });

  it.each([
    ['no progress yet', undefined],
    ['a free-form line', 'iniciado'],
    ['a malformed counter', '[8/] segment 8/25'],
  ])('answers null for %s', (_label, progress) => {
    expect(summarizeRenderProgress(progress)).toBeNull();
  });
});
