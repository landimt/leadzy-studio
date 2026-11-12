import { describe, expect, it } from 'vitest';
import { resolveExportFilename } from './exportFilename.js';

const MORNING = new Date(2026, 7, 26, 9, 5);

describe('resolveExportFilename', () => {
  it.each([
    ['the project name', '{project}', 'AP04.mp4'],
    ['date and time', '{project}-{date}-{time}', 'AP04-2026-08-26-0905.mp4'],
    ['a pattern that already ends in .mp4', '{project}.MP4', 'AP04.mp4'],
    ['path separators and reserved characters', 'a/b:c*d?', 'a-b-c-d.mp4'],
    ['an empty stem', '   ', 'video.mp4'],
    ['runs of spaces and dashes', 'AP04  --  final', 'AP04 - final.mp4'],
  ])('handles %s', (_label, pattern, expected) => {
    expect(resolveExportFilename(pattern, 'AP04', MORNING)).toBe(expected);
  });

  it('caps the stem at 180 characters', () => {
    expect(resolveExportFilename('x'.repeat(300), 'AP04', MORNING)).toBe(`${'x'.repeat(180)}.mp4`);
  });
});
