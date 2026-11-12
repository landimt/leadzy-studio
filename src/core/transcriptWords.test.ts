import { describe, expect, it } from 'vitest';
import type { Transcript } from './transcript.js';
import { blockForWords, formatWordLine, wordsInWindow } from './transcriptWords.js';

function transcript(): Transcript {
  return {
    engine: 'scribe',
    languageCode: 'pt',
    text: '',
    words: [
      { text: 'Olha', start: 1.1, end: 1.28, type: 'word' },
      { text: ' ', start: 1.28, end: 1.3, type: 'spacing' },
      { text: 'pessoal,', start: 1.3, end: 1.78, type: 'word' },
      { text: 'a', start: 2.24, end: 2.34, type: 'word' },
      { text: 'gente', start: 2.42, end: 2.86, type: 'word' },
      { text: '(laughter)', start: 2.9, end: 3.2, type: 'audio_event' },
      { text: 'tá', start: 3.26, end: 3.4, type: 'word' },
      { text: 'Lançando', start: 3.66, end: 4.04, type: 'word' },
    ],
  };
}

describe('wordsInWindow', () => {
  it('returns every spoken word, never spacing or audio events, when no window is given', () => {
    expect(wordsInWindow(transcript()).map((w) => w.text)).toEqual([
      'Olha',
      'pessoal,',
      'a',
      'gente',
      'tá',
      'Lançando',
    ]);
  });

  it('keeps words overlapping the window, excluding those that merely touch it', () => {
    expect(wordsInWindow(transcript(), { from: 1.78, to: 3.26 }).map((w) => w.text)).toEqual([
      'a',
      'gente',
    ]);
    expect(wordsInWindow(transcript(), { from: 1.5, to: 2.3 }).map((w) => w.text)).toEqual([
      'pessoal,',
      'a',
    ]);
  });

  it('matches grep as a case-insensitive plain substring', () => {
    expect(wordsInWindow(transcript(), { grep: 'lanç' }).map((w) => w.text)).toEqual(['Lançando']);
    expect(wordsInWindow(transcript(), { grep: '.' })).toEqual([]);
  });
});

describe('blockForWords', () => {
  it('pads the run with the default margins when there is air on both sides', () => {
    const block = blockForWords(transcript(), 2.24, 2.86);
    expect(block).toStrictEqual({ in: 2.19, out: 2.94, firstWord: 'a', lastWord: 'gente' });
  });

  it('clamps the margins to the neighbouring words instead of cutting into them', () => {
    const block = blockForWords(transcript(), 1.3, 1.78);
    expect(block).toStrictEqual({
      in: 1.28,
      out: 1.86,
      firstWord: 'pessoal,',
      lastWord: 'pessoal,',
    });
    const tail = blockForWords(transcript(), 3.26, 3.4);
    expect(tail?.in).toBe(3.21);
    expect(tail?.out).toBe(3.48);
  });

  it('never starts before zero and pads freely after the last word', () => {
    expect(blockForWords(transcript(), 1.1, 1.28, { beforeS: 5, afterS: 0.08 })?.in).toBe(0);
    expect(blockForWords(transcript(), 3.66, 4.04)?.out).toBe(4.12);
  });

  it('accepts times slightly off a boundary by snapping inward to whole words', () => {
    const block = blockForWords(transcript(), 2.2, 2.9);
    expect(block?.firstWord).toBe('a');
    expect(block?.lastWord).toBe('gente');
  });

  it('keeps a boundary word whose raw time the two-decimal pack rounded away', () => {
    const raw: Transcript = {
      ...transcript(),
      words: [
        { text: 'ok?', start: 72.5249, end: 73.2251, type: 'word' },
        { text: 'E', start: 73.26, end: 73.46, type: 'word' },
      ],
    };
    const block = blockForWords(raw, 72.52, 73.22);
    expect(block).toMatchObject({ firstWord: 'ok?', lastWord: 'ok?' });
    expect(blockForWords(raw, 72.52, 73.2)).toBeNull();
  });

  it('returns null when the window contains no whole word', () => {
    expect(blockForWords(transcript(), 2.3, 2.5)).toBeNull();
    expect(blockForWords(transcript(), 9, 10)).toBeNull();
  });
});

describe('formatWordLine', () => {
  it('prints start, end and text with two decimals', () => {
    expect(formatWordLine({ text: 'tá', start: 3.26, end: 3.4, type: 'word' })).toBe(
      '3.26-3.40 tá',
    );
  });
});
