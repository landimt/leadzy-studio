import { describe, expect, it } from 'vitest';
import { unwrap } from './result.js';
import { packTranscript } from './transcriptPack.js';
import {
  parseScribeTranscript,
  spokenWords,
  type Transcript,
  type TranscriptWord,
} from './transcript.js';

const SYNTHETIC_WORDS = [
  'grave',
  'uma',
  'frase',
  'curta',
  'com',
  'áudio',
  'limpo',
  'depois',
  'troque',
  'o',
  'enquadramento',
  'para',
  'mostrar',
  'o',
  'produto',
  'adicione',
  'uma',
  'legenda',
  'simples',
  'e',
  'termine',
  'com',
  'um',
  'convite',
  'claro',
  'para',
  'a',
  'próxima',
  'ação',
  'agora',
] as const;

function syntheticScribeFixture(): string {
  const words = SYNTHETIC_WORDS.flatMap((text, index) => {
    const start = Number((0.4 + index * 0.39).toFixed(3));
    const end = index === SYNTHETIC_WORDS.length - 1 ? 11.9 : Number((start + 0.19).toFixed(3));
    const spoken = {
      text,
      start,
      end,
      type: 'word',
      speaker_id: 'speaker_0',
      logprob: -0.01,
    };
    if (index === SYNTHETIC_WORDS.length - 1) return [spoken];
    return [
      spoken,
      {
        text: ' ',
        start: end,
        end: Number((0.4 + (index + 1) * 0.39).toFixed(3)),
        type: 'spacing',
        speaker_id: 'speaker_0',
        logprob: -0.01,
      },
    ];
  });
  return JSON.stringify({ language_code: 'por', text: SYNTHETIC_WORDS.join(' '), words }, null, 2);
}

function word(
  text: string,
  start: number,
  end: number,
  extra: Partial<TranscriptWord> = {},
): TranscriptWord {
  return { text, start, end, type: 'word', ...extra };
}

describe('packTranscript — synthetic Scribe fixture', () => {
  const raw = syntheticScribeFixture();
  const transcript = unwrap(parseScribeTranscript(JSON.parse(raw) as unknown));

  it('produces a pack far smaller than the raw Scribe cache', () => {
    const pack = packTranscript('camera.mp4', transcript);
    expect(pack.length).toBeLessThan(raw.length / 5);
  });

  it('opens with a header naming the source, duration and word count', () => {
    const pack = packTranscript('camera.mp4', transcript);
    const [headerLine] = pack.split('\n');
    expect(headerLine).toBe('# camera.mp4 — 11.9s · 30 words');
  });

  it('omits speaker labels — the fixture has a single speaker', () => {
    const pack = packTranscript('camera.mp4', transcript);
    expect(pack).not.toContain('(S1)');
  });

  it('drops spacing tokens entirely — line word counts sum to the header count', () => {
    const pack = packTranscript('camera.mp4', transcript);
    const contentLines = pack.split('\n').slice(1);
    const totalWords = contentLines.reduce(
      (sum, line) => sum + line.replace(/^\[[^\]]+\]\s*/, '').split(' ').length,
      0,
    );
    expect(totalWords).toBe(30);
  });
});

describe('packTranscript — synthetic cases', () => {
  it('breaks the line when the gap between words exceeds 0.6s, even mid-clause', () => {
    const transcript: Transcript = {
      engine: 'scribe',
      text: 'cores livres outra estrutura',
      words: [
        word('cores', 0.65, 0.9),
        word('livres', 0.95, 1.4),
        // 1.4 -> 2.1 gap is 0.7s, over the 0.6s threshold: hard break here
        word('outra', 2.1, 2.3),
        word('estrutura', 2.35, 2.6),
      ],
    };
    const lines = packTranscript('clip.mp4', transcript).split('\n').slice(1);
    expect(lines).toEqual(['[0.65–1.40] cores livres', '[2.10–2.60] outra estrutura']);
  });

  it('breaks on clause punctuation once the minimum word count is reached', () => {
    // The trailing chunk has exactly MIN_WORDS_PER_LINE (4) words so groupWords'
    // orphan-avoidance (merge a too-short trailing chunk back) does not apply.
    const words: TranscriptWord[] = [
      word('um', 0, 0.2),
      word('dois', 0.25, 0.45),
      word('três', 0.5, 0.7),
      word('quatro,', 0.75, 0.95),
      word('cinco', 1.0, 1.2),
      word('seis', 1.25, 1.45),
      word('sete', 1.5, 1.7),
      word('oito', 1.75, 1.95),
    ];
    const transcript: Transcript = { engine: 'scribe', text: '', words };
    const lines = packTranscript('clip.mp4', transcript).split('\n').slice(1);
    expect(lines).toEqual(['[0.00–0.95] um dois três quatro,', '[1.00–1.95] cinco seis sete oito']);
  });

  it('places an audio_event on its own line, in chronological position', () => {
    const transcript: Transcript = {
      engine: 'scribe',
      text: '',
      words: [
        word('primeira', 0.1, 0.5),
        word('frase', 0.55, 0.9),
        { text: 'laughter', start: 2.1, end: 2.3, type: 'audio_event' },
        word('segunda', 3.05, 3.4),
        word('frase', 3.45, 3.9),
      ],
    };
    const lines = packTranscript('clip.mp4', transcript).split('\n').slice(1);
    expect(lines).toEqual([
      '[0.10–0.90] primeira frase',
      '[2.10–2.30] {laughter}',
      '[3.05–3.90] segunda frase',
    ]);
  });

  it('ignores type:"spacing" entries entirely', () => {
    const transcript: Transcript = {
      engine: 'scribe',
      text: '',
      words: [
        word('olá', 0, 0.3),
        { text: ' ', start: 0.3, end: 0.35, type: 'spacing' },
        word('mundo', 0.4, 0.7),
      ],
    };
    const lines = packTranscript('clip.mp4', transcript).split('\n').slice(1);
    expect(lines).toEqual(['[0.00–0.70] olá mundo']);
  });

  it('omits speaker labels when 0 or 1 distinct speakers are present', () => {
    const single: Transcript = {
      engine: 'scribe',
      text: '',
      words: [
        word('oi', 0, 0.2, { speakerId: 'speaker_0' }),
        word('tudo', 0.25, 0.5, { speakerId: 'speaker_0' }),
        word('bem', 0.55, 0.8, { speakerId: 'speaker_0' }),
        word('hoje', 0.85, 1.1, { speakerId: 'speaker_0' }),
      ],
    };
    expect(packTranscript('clip.mp4', single)).not.toContain('(S1)');

    const none: Transcript = {
      engine: 'scribe',
      text: '',
      words: [word('oi', 0, 0.2), word('tudo', 0.25, 0.5), word('bem', 0.55, 0.8)],
    };
    expect(packTranscript('clip.mp4', none)).not.toMatch(/\(S\d\)/);
  });

  it('labels lines (S1)/(S2) by first appearance when 2+ speakers are present', () => {
    const transcript: Transcript = {
      engine: 'scribe',
      text: '',
      words: [
        word('cores', 0.65, 1.0, { speakerId: 'speaker_7' }),
        word('livres,', 1.05, 1.4, { speakerId: 'speaker_7' }),
        // gap keeps the speaker change on its own line
        word('segunda', 3.05, 3.4, { speakerId: 'speaker_3' }),
        word('frase', 3.45, 3.9, { speakerId: 'speaker_3' }),
      ],
    };
    const lines = packTranscript('clip.mp4', transcript).split('\n').slice(1);
    expect(lines).toEqual(['[0.65–1.40] (S1) cores livres,', '[3.05–3.90] (S2) segunda frase']);
    expect(packTranscript('clip.mp4', transcript).split('\n')[0]).toContain('2 speakers');
  });

  it('formats times with exactly 2 decimals regardless of source precision', () => {
    const transcript: Transcript = {
      engine: 'scribe',
      text: '',
      words: [word('um', 0.123456, 0.4, {}), word('dois', 0.45, 0.678912)],
    };
    const lines = packTranscript('clip.mp4', transcript).split('\n').slice(1);
    expect(lines).toEqual(['[0.12–0.68] um dois']);
  });
});

describe('packTranscript corrections', () => {
  const transcript = unwrap(parseScribeTranscript(JSON.parse(syntheticScribeFixture()) as unknown));

  it('ends with the active corrections, naming the word heard at each time', () => {
    const lines = packTranscript('camera.mp4', transcript, [
      { at: spokenWords(transcript)[3]!.start + 0.01, text: 'Leadzy' },
      { at: 9999, text: 'nowhere' },
    ]).split('\n');
    expect(lines[lines.length - 1]).toBe(
      `# corrections: [${(spokenWords(transcript)[3]!.start + 0.01).toFixed(2)}] "${spokenWords(transcript)[3]!.text}" → "Leadzy" · [9999.00] (no word at this time) → "nowhere"`,
    );
  });

  it('adds no footer without corrections', () => {
    expect(packTranscript('camera.mp4', transcript)).not.toContain('# corrections');
  });
});
