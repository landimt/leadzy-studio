import { describe, expect, it } from 'vitest';
import {
  MAX_WORD_DURATION_S,
  parseScribeTranscript,
  parseTranscriptCacheMeta,
  parseTranscriptFile,
  refineWordEnds,
  scaleTranscriptTimes,
  type TranscriptWord,
} from './transcript.js';

const word = (
  text: string,
  start: number,
  end: number,
  type: TranscriptWord['type'] = 'word',
): TranscriptWord => ({
  text,
  start,
  end,
  type,
});

describe('refineWordEnds', () => {
  it('clamps a sentence-final word whose end swallowed the pause', () => {
    // "instruções." marked as lasting 5.7s; real speech ends where silence starts
    const words = [word('as', 9.8, 10.0), word('instruções.', 10.1, 15.8)];
    const refined = refineWordEnds(words, [{ start: 10.9, end: 15.6 }]);
    expect(refined[1]!.end).toBe(10.9);
    expect(refined[0]!.end).toBe(10.0);
  });

  it('leaves words alone when silence starts too early inside them (real speech)', () => {
    const words = [word('ok', 5.0, 5.4)];
    const refined = refineWordEnds(words, [{ start: 5.05, end: 5.6 }]);
    expect(refined[0]!.end).toBe(5.4);
  });

  it('caps an inflated end when no silence catches it', () => {
    const words = [word('inflada', 1.0, 4.5)];
    const refined = refineWordEnds(words, []);
    expect(refined[0]!.end).toBe(1.0 + MAX_WORD_DURATION_S);
  });

  it('leaves a short word untouched when it is under the cap', () => {
    const words = [word('curta', 1, 1.4)];
    expect(refineWordEnds(words, [])[0]!.end).toBe(1.4);
  });

  it('leaves spacing and audio_event entries untouched even past the cap', () => {
    const words = [word('  ', 1, 8, 'spacing'), word('[música]', 1, 8, 'audio_event')];
    const refined = refineWordEnds(words, []);
    expect(refined[0]!.end).toBe(8);
    expect(refined[1]!.end).toBe(8);
  });

  it('lets a measured silence win over the duration cap when it cuts earlier', () => {
    const words = [word('longa', 10.0, 20.0)];
    // silence starts well before start + MAX_WORD_DURATION_S (11.2)
    const refined = refineWordEnds(words, [{ start: 10.5, end: 19.0 }]);
    expect(refined[0]!.end).toBe(10.5);
  });
});

describe('parseTranscriptFile', () => {
  const scribeJson = {
    text: 'olá mundo',
    words: [
      { text: 'olá', start: 0.1, end: 0.4, type: 'word' },
      { text: ' ', start: 0.4, end: 0.5, type: 'spacing' },
      { text: 'mundo', start: 0.5, end: 0.9, type: 'word' },
    ],
  };
  const meta = {
    engine: 'scribe',
    model: 'scribe_v2',
    sourceHash: 'h',
    keytermsHash: 'k',
    transcribedAt: '2026-08-27T15:00:00.000Z',
  };

  it('accepts the Studio cache wrapper written by Scribe v2', () => {
    const parsed = parseTranscriptFile({ ...meta, transcript: scribeJson });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.words.map((w) => w.text)).toEqual(['olá', ' ', 'mundo']);
  });

  it.each([
    ['a raw Scribe JSON without the wrapper', scribeJson],
    [
      'a Scribe v1 wrapper without model and keyterms',
      { engine: 'scribe', sourceHash: 'h', transcript: scribeJson },
    ],
    [
      'a cache written by the removed Whisper engine',
      { ...meta, engine: 'whisper', transcript: scribeJson },
    ],
    ['a cache from another model', { ...meta, model: 'scribe_v1', transcript: scribeJson }],
  ])('refuses %s so the media is transcribed again', (_label, data) => {
    const parsed = parseTranscriptFile(data);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('invalid-transcript');
  });

  it('reads the cache header without the transcript, and nothing from an older format', () => {
    expect(parseTranscriptCacheMeta({ ...meta, transcript: scribeJson })).toEqual(meta);
    expect(
      parseTranscriptCacheMeta({ engine: 'scribe', sourceHash: 'h', transcript: scribeJson }),
    ).toBeNull();
    expect(parseTranscriptCacheMeta(null)).toBeNull();
  });
});

describe('parseScribeTranscript', () => {
  it('keeps a spoken word Scribe left untimed by borrowing the gap between its neighbours', () => {
    const parsed = parseScribeTranscript({
      text: 'olá meu mundo',
      words: [
        { text: 'olá', start: 0.1, end: 0.4, type: 'word', speaker_id: null },
        { text: ' ', start: null, end: null, type: 'spacing' },
        { text: 'meu', start: null, end: null, type: 'word' },
        { text: 'mundo', start: 0.9, end: 1.2, type: 'word' },
        { text: '(riso)', type: 'audio_event' },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.words).toEqual([
      { text: 'olá', start: 0.1, end: 0.4, type: 'word' },
      { text: 'meu', start: 0.4, end: 0.9, type: 'word' },
      { text: 'mundo', start: 0.9, end: 1.2, type: 'word' },
    ]);
  });

  it('slices the gap evenly among several untimed words, never overlapping a timed neighbour', () => {
    const parsed = parseScribeTranscript({
      text: 'olá meu belo bom mundo',
      words: [
        { text: 'olá', start: 0.1, end: 0.4, type: 'word' },
        { text: 'meu', type: 'word', speaker_id: 'S1' },
        { text: 'belo', start: null, end: null, type: 'word' },
        { text: 'bom', type: 'word' },
        { text: 'mundo', start: 1.0, end: 1.2, type: 'word' },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const words = parsed.value.words;
    expect(words.map((w) => [w.text, w.start, w.end])).toEqual([
      ['olá', 0.1, 0.4],
      ['meu', 0.4, 0.6],
      ['belo', 0.6, 0.8],
      ['bom', 0.8, 1.0],
      ['mundo', 1.0, 1.2],
    ]);
    words.slice(1).forEach((w, i) => {
      expect(w.start).toBeGreaterThanOrEqual(words[i]!.end);
    });
    expect(words[1]?.speakerId).toBe('S1');
    expect(words[2]).not.toHaveProperty('speakerId');
  });

  it('starts an untimed first word at zero and leaves timed short words and zero-width spacing alone', () => {
    const parsed = parseScribeTranscript({
      text: 'eh olá',
      words: [
        { text: 'eh', type: 'word' },
        { text: 'olá', start: 0.2, end: 0.23, type: 'word' },
        { text: ' ', start: 0.23, end: 0.23, type: 'spacing' },
        { text: ' ', start: 0.23, type: 'spacing' },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.words).toEqual([
      { text: 'eh', start: 0, end: 0.2, type: 'word' },
      { text: 'olá', start: 0.2, end: 0.23, type: 'word' },
      { text: ' ', start: 0.23, end: 0.23, type: 'spacing' },
    ]);
  });

  it('gives an untimed word at the end a short span after the previous one', () => {
    const parsed = parseScribeTranscript({
      text: 'olá mundo',
      words: [
        { text: 'olá', start: 0.1, end: 0.4, type: 'word' },
        { text: 'mundo', start: 0.5, type: 'word' },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.words[1]).toEqual({ text: 'mundo', start: 0.4, end: 0.45, type: 'word' });
  });
});

describe('scaleTranscriptTimes', () => {
  it('maps every word and the duration onto the other clock, rounded to milliseconds', () => {
    const scaled = scaleTranscriptTimes(
      {
        engine: 'scribe',
        text: 'olá mundo',
        words: [word('olá', 1.1, 1.65), word(' ', 1.65, 1.7, 'spacing'), word('mundo', 1.7, 2.2)],
        audioDurationS: 3.3,
      },
      1 / 1.1,
    );
    expect(scaled.words.map((w) => [w.start, w.end])).toEqual([
      [1, 1.5],
      [1.5, 1.545],
      [1.545, 2],
    ]);
    expect(scaled.audioDurationS).toBe(3);
  });

  it('leaves a transcript without a duration without one', () => {
    expect(scaleTranscriptTimes({ engine: 'scribe', text: '', words: [] }, 2)).toEqual({
      engine: 'scribe',
      text: '',
      words: [],
    });
  });
});
