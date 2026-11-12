import { describe, expect, it } from 'vitest';
import { formatEditorDuration } from './statusFormat.js';

describe('formatEditorDuration', () => {
  it.each([
    [undefined, '–:––'],
    [0, '00:00'],
    [54.4, '00:54'],
    [65.6, '01:06'],
    [3661, '1:01:01'],
  ])('formats %s seconds as %s', (duration, expected) => {
    expect(formatEditorDuration(duration)).toBe(expected);
  });
});
