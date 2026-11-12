import { describe, expect, it } from 'vitest';
import type { EditDoc } from './schema.js';
import type { Transcript, TranscriptWord } from './transcript.js';
import { alignSequences, buildQaReport, expectedWords, isHomophoneOf } from './qaDiff.js';

const doc: EditDoc = {
  version: 2,
  fps: 25,
  output: { width: 1080, height: 1920, loudnormLufs: -14 },
  sources: { cam: { path: 'camera.mp4' } },
  tracks: [
    {
      id: 'base',
      kind: 'video',
      blocks: [
        { source: 'cam', in: 0, out: 2 },
        { source: 'cam', in: 10, out: 12 },
      ],
    },
  ],
  subtitles: { enabled: true, preset: '2p-caps' },
  totalDurationS: 4,
};

const word = (text: string, start: number, end: number): TranscriptWord => ({
  text,
  start,
  end,
  type: 'word',
});

const sourceTranscript: Transcript = {
  engine: 'scribe',
  text: 'olá pessoal cortado segunda parte',
  words: [
    word('olá', 0.2, 0.5),
    word('pessoal', 0.6, 1.1),
    word('cortado', 5, 5.5),
    word('segunda', 10.3, 10.8),
    word('parte', 10.9, 11.4),
  ],
};

function finalTranscript(words: TranscriptWord[]): Transcript {
  return { engine: 'scribe', text: words.map((w) => w.text).join(' '), words };
}

const perfectFinal = finalTranscript([
  word('olá', 0.2, 0.5),
  word('pessoal', 0.6, 1.1),
  word('segunda', 2.3, 2.8),
  word('parte', 2.9, 3.4),
]);

describe('expectedWords', () => {
  it('projects kept words onto the output timeline and skips cut material', () => {
    const words = expectedWords(doc, new Map([['cam', sourceTranscript]]));
    expect(words.map((w) => w.text)).toEqual(['olá', 'pessoal', 'segunda', 'parte']);
    expect(words[2]!.outputTime).toBeCloseTo(2.3, 5);
    expect(words[0]!.isBlockEdge).toBe(true);
    expect(words[1]!.isBlockEdge).toBe(true);
  });

  it('halves the intra-block output time for a word inside a 2x block', () => {
    const speedDoc: EditDoc = {
      ...doc,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 0, out: 2 },
            { source: 'cam', in: 10, out: 12, speed: 2 },
          ],
        },
      ],
    };
    const words = expectedWords(speedDoc, new Map([['cam', sourceTranscript]]));
    // block 1 (1x) ends at output 2; "segunda" is 0.3s into the 2x block's
    // source window -> 0.15s of output, landing at 2 + 0.15 = 2.15
    const segunda = words.find((w) => w.text === 'segunda');
    expect(segunda?.outputTime).toBeCloseTo(2.15, 5);
  });

  it('divides every output time by doc.output.speed — the FINAL clock a retranscription would see', () => {
    const globalSpeedDoc: EditDoc = { ...doc, output: { ...doc.output, speed: 2 } };
    const words = expectedWords(globalSpeedDoc, new Map([['cam', sourceTranscript]]));
    const natural = expectedWords(doc, new Map([['cam', sourceTranscript]]));
    words.forEach((w, i) => {
      expect(w.outputTime).toBeCloseTo(natural[i]!.outputTime / 2, 5);
    });
  });
});

describe('alignSequences', () => {
  it('aligns identical sequences fully', () => {
    const alignment = alignSequences(['a', 'b', 'c'], ['a', 'b', 'c']);
    expect(alignment.pairs).toHaveLength(3);
    expect(alignment.deletions).toHaveLength(0);
    expect(alignment.insertions).toHaveLength(0);
  });

  it('reports deletions and insertions', () => {
    const alignment = alignSequences(['a', 'b', 'c'], ['a', 'x', 'b']);
    expect(alignment.pairs.map((p) => p.expectedIndex)).toEqual([0, 1]);
    expect(alignment.deletions).toContain(2);
    expect(alignment.insertions.length).toBeGreaterThan(0);
  });
});

describe('buildQaReport', () => {
  const transcripts = new Map([['cam', sourceTranscript]]);

  it('passes on a faithful render', () => {
    const report = buildQaReport({
      doc,
      transcripts,
      finalTranscript: perfectFinal,
      actualDurationS: 4.01,
    });
    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });

  // A muted base is a deliberate silent cut — the source transcript exists but
  // no word reaches the output, and the report must not read that as a 0% match.
  it('passes with speech checks marked not-applicable when the base track is muted', () => {
    const mutedDoc = {
      ...doc,
      tracks: doc.tracks.map((track, i) => (i === 0 ? { ...track, muted: true } : track)),
    };
    const report = buildQaReport({
      doc: mutedDoc,
      transcripts,
      finalTranscript: finalTranscript([]),
      actualDurationS: 4.01,
    });
    expect(report.ok).toBe(true);
    const words = report.checks.find((c) => c.id === 'words-present-in-order')!;
    expect(words.detail).toContain('not applicable');
    expect(report.stats.expectedWordCount).toBe(0);
    expect(report.checks.find((c) => c.id === 'duration')!.ok).toBe(true);
  });

  // Locks that a muted base masks ONLY the speech checks: a hard-coded
  // `ok: true` duration in the muted branch would survive the case above.
  it('still fails the duration check under a muted base', () => {
    const mutedDoc = {
      ...doc,
      tracks: doc.tracks.map((track, i) => (i === 0 ? { ...track, muted: true } : track)),
    };
    const report = buildQaReport({
      doc: mutedDoc,
      transcripts,
      finalTranscript: finalTranscript([]),
      actualDurationS: 9,
    });
    expect(report.checks.find((c) => c.id === 'duration')!.ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('fails block-edges-intact when a boundary word is missing, and reports the issue at its output time', () => {
    const clipped = finalTranscript([
      word('olá', 0.2, 0.5),
      word('pessoal', 0.6, 1.1),
      word('parte', 2.9, 3.4),
    ]);
    const report = buildQaReport({
      doc,
      transcripts,
      finalTranscript: clipped,
      actualDurationS: 4,
    });
    const check = report.checks.find((c) => c.id === 'block-edges-intact')!;
    expect(check.ok).toBe(false);
    // "segunda" is the missing first word of the second block — its output time is 2.3s (see expectedWords test above)
    expect(check.issues).toHaveLength(1);
    expect(check.issues![0]!.label).toBe('segunda');
    expect(check.issues![0]!.outputTime).toBeCloseTo(2.3, 5);
  });

  it('passes block-edges-intact with no issues when every boundary word is present', () => {
    const report = buildQaReport({
      doc,
      transcripts,
      finalTranscript: perfectFinal,
      actualDurationS: 4,
    });
    const check = report.checks.find((c) => c.id === 'block-edges-intact')!;
    expect(check.ok).toBe(true);
    expect(check.issues).toBeUndefined();
  });

  it('tolerates a single short edge word missing when its neighbour matched (ASR noise)', () => {
    const noisy = finalTranscript([
      // "olá" (short) missing, but "pessoal" right next to it matched
      word('pessoal', 0.6, 1.1),
      word('segunda', 2.3, 2.8),
      word('parte', 2.9, 3.4),
    ]);
    const report = buildQaReport({
      doc,
      transcripts,
      finalTranscript: noisy,
      actualDurationS: 4,
    });
    expect(report.checks.find((c) => c.id === 'block-edges-intact')!.ok).toBe(true);
  });

  it('accepts a long edge word the engine heard one letter off, and says so', () => {
    const homophone = finalTranscript([
      word('olá', 0.2, 0.5),
      word('pessoal', 0.6, 1.1),
      word('sigunda', 2.3, 2.8),
      word('parte', 2.9, 3.4),
    ]);
    const report = buildQaReport({
      doc,
      transcripts,
      finalTranscript: homophone,
      actualDurationS: 4,
    });
    const check = report.checks.find((c) => c.id === 'block-edges-intact')!;
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('"segunda"≈"sigunda"');
  });

  it('does not stretch the homophone tolerance to short words or two-letter differences', () => {
    const twoOff = finalTranscript([
      word('olá', 0.2, 0.5),
      word('pessoal', 0.6, 1.1),
      word('sigundo', 2.3, 2.8),
      word('parte', 2.9, 3.4),
    ]);
    const report = buildQaReport({
      doc,
      transcripts,
      finalTranscript: twoOff,
      actualDurationS: 4,
    });
    expect(report.checks.find((c) => c.id === 'block-edges-intact')!.ok).toBe(false);
  });

  it('fails no-cut-content-leaked when cut words survive as a run', () => {
    const leaked = finalTranscript([
      word('olá', 0.2, 0.5),
      word('pessoal', 0.6, 1.1),
      word('isto', 1.3, 1.5),
      word('não', 1.5, 1.7),
      word('devia', 1.7, 1.9),
      word('estar', 1.9, 2.1),
      word('segunda', 2.3, 2.8),
      word('parte', 2.9, 3.4),
    ]);
    const report = buildQaReport({
      doc,
      transcripts,
      finalTranscript: leaked,
      actualDurationS: 4,
    });
    expect(report.checks.find((c) => c.id === 'no-cut-content-leaked')!.ok).toBe(false);
  });

  it('fails subtitle-drift when timings slide past 150ms, and reports the worst offenders with their output times', () => {
    const drifted = finalTranscript([
      word('olá', 0.6, 0.9),
      word('pessoal', 1.0, 1.5),
      word('segunda', 2.7, 3.2),
      word('parte', 3.3, 3.8),
    ]);
    const report = buildQaReport({
      doc,
      transcripts,
      finalTranscript: drifted,
      actualDurationS: 4,
    });
    const check = report.checks.find((c) => c.id === 'subtitle-drift')!;
    expect(check.ok).toBe(false);
    // every word drifted by ~400ms — all four are reported, at their own expected output
    // time; sort by time first since ties in driftMs are float-order-sensitive
    const issues = [...check.issues!].sort((a, b) => a.outputTime - b.outputTime);
    expect(issues.map((issue) => issue.label)).toEqual([
      'drift 400ms',
      'drift 400ms',
      'drift 400ms',
      'drift 400ms',
    ]);
    [0.2, 0.6, 2.3, 2.9].forEach((expectedTime, i) => {
      expect(issues[i]!.outputTime).toBeCloseTo(expectedTime, 5);
    });
  });

  it('passes subtitle-drift with no issues on a faithful render', () => {
    const report = buildQaReport({
      doc,
      transcripts,
      finalTranscript: perfectFinal,
      actualDurationS: 4.01,
    });
    const check = report.checks.find((c) => c.id === 'subtitle-drift')!;
    expect(check.ok).toBe(true);
    expect(check.issues).toBeUndefined();
  });

  it('still surfaces a lone drifted word as an issue even when the aggregate p95 check passes', () => {
    const wordCount = 25;
    const sourceWords: TranscriptWord[] = [];
    for (let i = 0; i < wordCount; i += 1) {
      const start = i * 0.4;
      sourceWords.push(word(`w${String(i)}`, start, start + 0.3));
    }
    const bigDoc: EditDoc = {
      ...doc,
      tracks: [
        { id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: wordCount * 0.4 }] },
      ],
      totalDurationS: wordCount * 0.4,
    };
    const bigSource: Transcript = {
      engine: 'scribe',
      text: sourceWords.map((w) => w.text).join(' '),
      words: sourceWords,
    };
    // only the very last word (index 24) drifts, by 400ms — everything else lands exactly
    const finalWords = sourceWords.map((w, i) =>
      i === wordCount - 1 ? word(w.text, w.start + 0.4, w.end + 0.4) : w,
    );
    const report = buildQaReport({
      doc: bigDoc,
      transcripts: new Map([['cam', bigSource]]),
      finalTranscript: finalTranscript(finalWords),
      actualDurationS: wordCount * 0.4,
    });
    const check = report.checks.find((c) => c.id === 'subtitle-drift')!;
    // floor(25 * 0.95) = 23 (0-indexed) lands on a perfect word, not the one outlier at
    // index 24 — the aggregate p95 stat passes, but the single drifted word is a real,
    // fixable defect and must still show up as a clickable issue
    expect(check.ok).toBe(true);
    expect(check.issues).toHaveLength(1);
    expect(check.issues![0]!.label).toBe('drift 400ms');
    expect(check.issues![0]!.outputTime).toBeCloseTo(24 * 0.4, 5);
  });

  it('scales the expected duration stat by doc.output.speed before comparing against the actual render', () => {
    const globalSpeedDoc: EditDoc = { ...doc, output: { ...doc.output, speed: 2 } };
    const report = buildQaReport({
      doc: globalSpeedDoc,
      transcripts,
      finalTranscript: perfectFinal,
      // totalDurationS is 4 (natural); at 2x the final file should be ~2s
      actualDurationS: 2.0,
    });
    expect(report.stats.expectedDurationS).toBeCloseTo(2, 5);
    expect(report.checks.find((c) => c.id === 'duration')!.ok).toBe(true);
  });

  it('fails duration outside the 1% tolerance', () => {
    const report = buildQaReport({
      doc,
      transcripts,
      finalTranscript: perfectFinal,
      actualDurationS: 4.5,
    });
    expect(report.checks.find((c) => c.id === 'duration')!.ok).toBe(false);
  });
});

describe('isHomophoneOf', () => {
  it('needs six letters on both sides and exactly one edit', () => {
    expect(isHomophoneOf('atendido', 'entendido')).toBe(true); // onset swapped, body kept
    expect(isHomophoneOf('entendido', 'atendido')).toBe(true);
    expect(isHomophoneOf('atendido', 'atendidos')).toBe(true); // one edit
    expect(isHomophoneOf('atendidos', 'atendido')).toBe(true);
    expect(isHomophoneOf('parte', 'partes')).toBe(false); // one side too short
    expect(isHomophoneOf('segunda', 'sigunda')).toBe(true);
    expect(isHomophoneOf('atendido', 'atendido')).toBe(false);
    expect(isHomophoneOf('parte', 'porte')).toBe(false); // too short
    expect(isHomophoneOf('atendido', 'entendida')).toBe(false); // both ends differ
    expect(isHomophoneOf('atendido', 'atendimento')).toBe(false); // another word
    expect(isHomophoneOf('respondendo', 'respondendo-lhe')).toBe(false);
  });
});
