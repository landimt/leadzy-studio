import { describe, expect, it } from 'vitest';
import type { EditDoc, Suggestion } from '../../../core/schema.js';
import {
  formatSuggestionTime,
  silenceCutOutputRange,
  suggestionCopy,
  suggestionOutputRange,
  suggestionOutputRanges,
} from './cutSuggestionReview.js';

const doc: EditDoc = {
  version: 2,
  fps: 25,
  output: { width: 1080, height: 1920, loudnormLufs: -14 },
  sources: { cam: { path: 'camera.mp4' } },
  tracks: [
    {
      id: 'base',
      kind: 'video',
      blocks: [{ source: 'cam', in: 10, out: 20, speed: 2 }],
    },
  ],
  subtitles: { enabled: false, preset: 'pill' },
};

function suggestion(patch: Partial<Suggestion> = {}): Suggestion {
  return {
    id: 's1',
    type: 'silence',
    source: 'cam',
    start: 12,
    end: 14,
    reason: '2.0s pause',
    ...patch,
  };
}

describe('cut suggestion review', () => {
  it('maps source time into the current sped-up montage', () => {
    expect(suggestionOutputRange(doc, suggestion())).toEqual({ at: 1, durationS: 1 });
    expect(silenceCutOutputRange(doc, { source: 'cam', from: 12, to: 14 })).toEqual({
      at: 1,
      durationS: 1,
    });
    expect(suggestionOutputRange(doc, suggestion({ start: 30, end: 31 }))).toBeNull();
  });

  it('drops residual suggestions shorter than 100 ms in the current output', () => {
    expect(suggestionOutputRange(doc, suggestion({ start: 19.92, end: 21 }))).toBeNull();
    expect(suggestionOutputRanges(doc, suggestion({ start: 19.92, end: 21 }))).toEqual([]);
  });

  it('keeps every visible fragment and reports their combined duration', () => {
    const fragmented: EditDoc = {
      ...doc,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 10, out: 13 },
            { source: 'cam', in: 14, out: 16 },
          ],
        },
      ],
    };
    const split = suggestion({ start: 12, end: 15 });

    expect(suggestionOutputRanges(fragmented, split)).toEqual([
      { at: 2, durationS: 1 },
      { at: 3, durationS: 1 },
    ]);
    expect(suggestionOutputRange(fragmented, split)).toEqual({ at: 2, durationS: 2 });
    expect(suggestionCopy(split, 2)).toBe('Pausa de 2,0s');
  });

  it('turns engine reasons into compact Portuguese review copy', () => {
    expect(suggestionCopy(suggestion())).toBe('Pausa de 2,0s');
    expect(
      suggestionCopy(
        suggestion({
          type: 'repetition',
          reason: '"vamos começar de novo" — repeated 4 words',
        }),
      ),
    ).toBe('"vamos começar de novo"');
    expect(
      suggestionCopy(
        suggestion({
          type: 'false-start',
          reason: '"E quando a me--" — false start "me--" — phrase restarted at 72.85s',
        }),
      ),
    ).toBe('Falso começo "E quando a me--"');
    expect(
      suggestionCopy(suggestion({ type: 'filler', reason: 'isolated filler "né" between pauses' })),
    ).toBe('“né” isolado entre pausas');
    expect(formatSuggestionTime(65.23)).toBe('01:05.2');
  });
});
