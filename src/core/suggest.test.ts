import { describe, expect, it } from 'vitest';
import { buildSuggestions, suggestionSummaryLine } from './suggest.js';
import type { Suggestion } from './schema.js';
import type { TranscriptWord } from './transcript.js';

function phrase(text: string, startS: number, wordDuration = 0.3, gap = 0.05): TranscriptWord[] {
  return text.split(' ').map((t, i) => ({
    text: t,
    start: startS + i * (wordDuration + gap),
    end: startS + i * (wordDuration + gap) + wordDuration,
    type: 'word' as const,
  }));
}

describe('buildSuggestions', () => {
  it('records a false start once, not also as the repetition it contains', () => {
    const words = [
      ...phrase('Ele só quer receber uma resposta clara e bem--', 14.36),
      ...phrase('ele só quer receber uma resposta clara e ser bem atendido', 17.62),
    ];

    const suggestions = buildSuggestions({ source: 'cam', silences: [], words });

    expect(suggestions.map((s) => s.type)).toEqual(['false-start']);
    expect(suggestions[0]).toMatchObject({
      id: 'fs-cam-14.36',
      source: 'cam',
      start: 14.36,
      end: 17.62,
    });
    expect(suggestions[0]?.reason).toContain('phrase restarted at 17.62s');
  });

  it('keeps a repetition that is not part of a false start, even when a false start exists elsewhere', () => {
    const words = [
      ...phrase('a gente precisa de uma câmera', 0),
      ...phrase('a gente precisa de uma câmera muito boa', 4),
      ...phrase('E quando a me--', 20),
      ...phrase('e quando a mensagem chega', 22),
    ];

    const suggestions = buildSuggestions({ source: 'cam', silences: [], words });

    expect(suggestions.map((s) => [s.type, s.start])).toEqual([
      ['repetition', 0],
      ['false-start', 20],
    ]);
  });
});

describe('suggestionSummaryLine', () => {
  const suggestion = (type: Suggestion['type'], start: number): Suggestion => ({
    id: `${type}-${String(start)}`,
    type,
    source: 'cam',
    start,
    end: start + 1,
    reason: '',
  });

  it('counts each type that occurred in a fixed order', () => {
    expect(
      suggestionSummaryLine([
        suggestion('filler', 1),
        suggestion('false-start', 2),
        suggestion('silence', 3),
        suggestion('false-start', 4),
      ]),
    ).toBe('silence 1 · false-start 2 · filler 1');
  });

  it('says so when there is nothing', () => {
    expect(suggestionSummaryLine([])).toBe('no suggestions');
  });
});
