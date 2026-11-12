import { describe, expect, it } from 'vitest';
import type { TranscriptWord } from './transcript.js';
import { detectFalseStarts, detectFillers, detectRepetitions } from './repetition.js';

function phrase(text: string, startS: number, wordDuration = 0.3, gap = 0.05): TranscriptWord[] {
  return text.split(' ').map((t, i) => ({
    text: t,
    start: startS + i * (wordDuration + gap),
    end: startS + i * (wordDuration + gap) + wordDuration,
    type: 'word' as const,
  }));
}

describe('detectRepetitions', () => {
  it('flags the earlier occurrence of a repeated phrase as the flub', () => {
    // Retake: same 5-word opening spoken twice, second one continues.
    const words = [
      ...phrase('a gente precisa de uma câmera', 0),
      ...phrase('a gente precisa de uma câmera muito boa', 4),
    ];
    const candidates = detectRepetitions(words);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.kind).toBe('repetition');
    expect(candidates[0]!.start).toBe(0);
    expect(candidates[0]!.end).toBeLessThan(4);
  });

  it('ignores repeats outside the proximity window', () => {
    const words = [
      ...phrase('a gente precisa de uma câmera', 0),
      ...phrase('a gente precisa de uma câmera', 60),
    ];
    expect(detectRepetitions(words, { proximityWindowS: 30 })).toHaveLength(0);
  });

  it('ignores short repeats below minNgram', () => {
    const words = [...phrase('muito bom', 0), ...phrase('muito bom', 3)];
    expect(detectRepetitions(words)).toHaveLength(0);
  });
});

describe('detectFillers', () => {
  it('flags an isolated "é" between pauses', () => {
    const words: TranscriptWord[] = [
      { text: 'Então,', start: 0, end: 0.4, type: 'word' },
      { text: 'é,', start: 1.2, end: 1.4, type: 'word' },
      { text: 'vamos', start: 2.2, end: 2.5, type: 'word' },
    ];
    const candidates = detectFillers(words, []);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.text).toBe('é,');
  });

  it('keeps connected speech untouched', () => {
    const words = phrase('é muito simples de usar', 0);
    expect(detectFillers(words, [])).toHaveLength(0);
  });
});

describe('detectFalseStarts', () => {
  it('cuts from the first repeated word up to the restart when the phrase is taken again', () => {
    // AP04: "E quando a me-- e, e quando a mensagem chega"
    const words = [
      ...phrase('E quando a me--', 71.01),
      ...phrase('e,', 72.6),
      ...phrase('e quando a mensagem chega', 72.85),
    ];
    const candidates = detectFalseStarts(words);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ kind: 'false-start', start: 71.01, end: 72.85 });
    expect(candidates[0]?.text).toBe('E quando a me--');
    expect(candidates[0]?.reason).toContain('"me--"');
  });

  it('matches the longest repeated context, not just the minimum', () => {
    // AP04: "Ele só quer receber uma resposta clara e bem-- ele só quer receber uma resposta clara e ser bem atendido"
    const words = [
      ...phrase('Ele só quer receber uma resposta clara e bem--', 14.36),
      ...phrase('ele só quer receber uma resposta clara e ser bem atendido', 17.62),
    ];
    const candidates = detectFalseStarts(words);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ start: 14.36, end: 17.62 });
  });

  it('falls back to the stem of the cut-off word when no context repeats', () => {
    const words = [
      ...phrase('usa a sua aten--', 76.94),
      ...phrase('atenção no que é único', 79.26),
    ];
    const candidates = detectFalseStarts(words);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ start: 76.94 + 3 * 0.35, end: 79.26 });
    expect(candidates[0]?.text).toBe('aten--');
  });

  it('does not let a two-letter stem match anything', () => {
    const words = [...phrase('usa a sua in--', 76.94), ...phrase('intenção no que é único', 79.26)];
    expect(detectFalseStarts(words)).toEqual([]);
  });

  it('ignores a cut-off word whose stem is too short and whose context never returns', () => {
    // AP04: "o que ela re-- o contexto e o que ela realmente precisa" → the context "o que ela"
    // does return, so this is flagged; but "re--" alone before unrelated words is not.
    const words = [...phrase('a dúvida re--', 84.8), ...phrase('agora vamos falar de preço', 85.6)];
    expect(detectFalseStarts(words)).toEqual([]);
  });

  it('does not reach past the lookahead window — a note to the editor in between is not a restart', () => {
    // AP04: "no que-- opa, editor, corta essa parte aí. E quando a me-- …"
    const words = [
      ...phrase('envia e usa sua atenção no que--', 64.96),
      ...phrase('opa, editor, corta essa parte aí.', 68.5),
      ...phrase('e usa sua atenção no que é único', 72.0),
    ];
    expect(detectFalseStarts(words, { lookaheadS: 2 })).toEqual([]);
  });

  it('needs the transcript mark: an ordinary word never starts a candidate', () => {
    const words = [...phrase('e quando a mensagem', 0), ...phrase('e quando a mensagem chega', 2)];
    expect(detectFalseStarts(words)).toEqual([]);
  });
});
