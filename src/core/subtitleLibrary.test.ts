import { describe, expect, it } from 'vitest';
import { parseEditDoc } from './schema.js';
import { forceStyleFor } from './srt.js';
import { SUBTITLE_LIBRARY, type SubtitleLibraryStyle } from './subtitleLibrary.js';

function editDocFor(style: SubtitleLibraryStyle): unknown {
  return {
    version: 2,
    fps: 25,
    output: { width: 1080, height: 1920, loudnormLufs: -14 },
    sources: { cam: { path: 'camera.mp4' } },
    tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 5 }] }],
    subtitles: {
      enabled: true,
      preset: style.preset,
      ...(style.theme !== undefined ? { theme: style.theme } : {}),
      ...(style.fontSize !== undefined ? { fontSize: style.fontSize } : {}),
      ...(style.marginV !== undefined ? { marginV: style.marginV } : {}),
      ...(style.minWordsPerCue !== undefined ? { minWordsPerCue: style.minWordsPerCue } : {}),
      ...(style.maxWordsPerCue !== undefined ? { maxWordsPerCue: style.maxWordsPerCue } : {}),
    },
  };
}

describe('SUBTITLE_LIBRARY', () => {
  it('starts with the unmodified pill preset used by new projects', () => {
    expect(SUBTITLE_LIBRARY[0]).toEqual({
      id: 'pilula-escura',
      label: 'Pílula Escura',
      preset: 'pill',
    });
  });

  it('has unique ids', () => {
    const ids = SUBTITLE_LIBRARY.map((style) => style.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(SUBTITLE_LIBRARY)('style "$id" produces a valid edit.json', (style) => {
    const result = parseEditDoc(editDocFor(style));
    expect(result.ok).toBe(true);
  });

  // Regression guard: `backgroundStyle: 'none'` makes forceStyleFor emit
  // Outline=0 — bare, unreadable text over video. No library style may rely
  // on 'none' for a look that also wants a stroke.
  it.each(SUBTITLE_LIBRARY)('style "$id" keeps a visible stroke', (style) => {
    const result = parseEditDoc(editDocFor(style));
    if (!result.ok) throw new Error(result.error.message);
    expect(forceStyleFor(result.value)).not.toContain('Outline=0');
  });
});
