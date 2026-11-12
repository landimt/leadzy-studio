import { describe, expect, it } from 'vitest';
import type { EditDoc } from './schema.js';
import { spokenWords, type Transcript } from './transcript.js';
import { buildSubtitleCues, cuesToSrt, forceStyleFor, subtitleThemeFor } from './srt.js';

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
        { source: 'cam', in: 10, out: 12 },
        { source: 'cam', in: 20, out: 22 },
      ],
    },
  ],
  subtitles: { enabled: true, preset: '2p-caps' },
};

const transcript: Transcript = {
  engine: 'scribe',
  text: 'olá pessoal segunda parte',
  words: [
    { text: 'olá', start: 10.2, end: 10.6, type: 'word' },
    { text: 'pessoal', start: 10.7, end: 11.2, type: 'word' },
    { text: 'cortada', start: 15, end: 15.5, type: 'word' },
    { text: 'segunda', start: 20.3, end: 20.8, type: 'word' },
    { text: 'parte', start: 20.9, end: 21.4, type: 'word' },
  ],
};

describe('buildSubtitleCues', () => {
  it('uses the dark pill with a Leadzy highlight as the default pill theme', () => {
    const theme = subtitleThemeFor({
      ...doc,
      subtitles: { enabled: true, preset: 'pill' },
    });

    expect(theme.fill).toEqual({ kind: 'solid', color: '#FFFFFF' });
    expect(theme.highlightFill).toEqual({ kind: 'solid', color: '#FF3B81' });
    expect(theme.backgroundStyle).toBe('pill');
    expect(theme.backgroundColor).toBe('#101010');
  });

  it('uses OUTPUT timeline offsets, not source times', () => {
    const cues = buildSubtitleCues(doc, new Map([['cam', transcript]]));
    expect(cues).toHaveLength(2);
    // block 1 starts at output 0, source 10 → "olá" at 10.2 lands at 0.2
    expect(cues[0]!.start).toBeCloseTo(0.2, 5);
    // block 2 starts at output 2, source 20 → "segunda" at 20.3 lands at 2.3
    expect(cues[1]!.start).toBeCloseTo(2.3, 5);
  });

  it('drops words from cut material', () => {
    const cues = buildSubtitleCues(doc, new Map([['cam', transcript]]));
    expect(cues.every((c) => !c.text.toLowerCase().includes('cortada'))).toBe(true);
  });

  it('uppercases with the 2p-caps preset', () => {
    const cues = buildSubtitleCues(doc, new Map([['cam', transcript]]));
    expect(cues[0]!.text).toBe('OLÁ PESSOAL');
  });

  it('keeps natural case with 3p-natural', () => {
    const naturalDoc: EditDoc = {
      ...doc,
      subtitles: { enabled: true, preset: '3p-natural' },
    };
    const cues = buildSubtitleCues(naturalDoc, new Map([['cam', transcript]]));
    expect(cues[0]!.text).toBe('olá pessoal');
  });

  it('uses a custom maximum number of words per caption', () => {
    const compactDoc: EditDoc = {
      ...doc,
      subtitles: { enabled: true, preset: '3p-natural', maxWordsPerCue: 1 },
    };
    const cues = buildSubtitleCues(compactDoc, new Map([['cam', transcript]]));
    expect(cues.map((cue) => cue.text)).toEqual(['olá', 'pessoal', 'segunda', 'parte']);
  });

  it('honors the preferred minimum before breaking on punctuation', () => {
    const punctuated: Transcript = {
      ...transcript,
      words: [
        { text: 'olá,', start: 10.2, end: 10.5, type: 'word' },
        { text: 'minha', start: 10.6, end: 10.9, type: 'word' },
        { text: 'gente', start: 11, end: 11.3, type: 'word' },
      ],
    };
    const groupedDoc: EditDoc = {
      ...doc,
      subtitles: {
        enabled: true,
        preset: '3p-natural',
        minWordsPerCue: 2,
        maxWordsPerCue: 3,
      },
    };
    const cues = buildSubtitleCues(groupedDoc, new Map([['cam', punctuated]]));
    expect(cues[0]!.text).toBe('olá, minha gente');
  });

  it('uses the theme highlight instead of a fixed brand color', () => {
    const themedDoc: EditDoc = {
      ...doc,
      subtitles: {
        enabled: true,
        preset: 'pill',
        theme: { highlightFill: { kind: 'solid', color: '#00CC88' } },
      },
    };
    const cues = buildSubtitleCues(themedDoc, new Map([['cam', transcript]]));
    expect(cues[0]!.text).toContain('<font color="#00CC88">olá</font>');
    expect(cues[0]!.text).not.toContain('#e5388c');
  });

  it('renders a gradient highlight as per-character subtitle colors', () => {
    const gradientDoc: EditDoc = {
      ...doc,
      subtitles: {
        enabled: true,
        preset: 'pill',
        theme: {
          highlightFill: { kind: 'gradient', from: '#FF0000', to: '#0000FF' },
        },
      },
    };
    const cues = buildSubtitleCues(gradientDoc, new Map([['cam', transcript]]));
    expect(cues[0]!.text).toContain('<font color="#FF0000">o</font>');
    expect(cues[0]!.text).toContain('<font color="#0000FF">á</font>');
  });

  it('maps the agent font, fill and structure into libass style', () => {
    const themedDoc: EditDoc = {
      ...doc,
      subtitles: {
        enabled: true,
        preset: '3p-natural',
        theme: {
          fontFamily: 'Montserrat',
          fontWeight: 900,
          fill: { kind: 'solid', color: '#112233' },
          backgroundStyle: 'none',
        },
      },
    };
    const style = forceStyleFor(themedDoc);
    expect(style).toContain('FontName=Montserrat');
    expect(style).toContain('Bold=1');
    expect(style).toContain('PrimaryColour=&H00332211');
    expect(style).toContain('BorderStyle=1,Outline=0');
  });
});

describe('buildSubtitleCues — block speed', () => {
  it('halves the intra-block offset for a word inside a 2x block', () => {
    const speedDoc: EditDoc = {
      ...doc,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          // 10..14 (4s source) at 2x -> 2s of output, starting at output 0
          blocks: [{ source: 'cam', in: 10, out: 14, speed: 2 }],
        },
      ],
    };
    const speedTranscript: Transcript = {
      engine: 'scribe',
      text: 'meio',
      // 2s into the block's source window (in=10) -> 1s of output at 2x
      words: [{ text: 'meio', start: 12, end: 12.4, type: 'word' }],
    };
    const cues = buildSubtitleCues(speedDoc, new Map([['cam', speedTranscript]]));
    expect(cues).toHaveLength(1);
    expect(cues[0]!.start).toBeCloseTo(1, 5);
  });

  it("leaves a 1x block's cue timing unchanged (speed omitted stays byte-identical)", () => {
    const cues = buildSubtitleCues(doc, new Map([['cam', transcript]]));
    const explicitSpeedDoc: EditDoc = {
      ...doc,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 10, out: 12, speed: 1 },
            { source: 'cam', in: 20, out: 22, speed: 1 },
          ],
        },
      ],
    };
    const explicitCues = buildSubtitleCues(explicitSpeedDoc, new Map([['cam', transcript]]));
    expect(explicitCues).toEqual(cues);
  });
});

describe('cuesToSrt', () => {
  it('formats standard SRT with comma milliseconds', () => {
    const srt = cuesToSrt([
      { start: 0.2, end: 1.25, text: 'OLÁ PESSOAL', source: 'cam', wordStart: 0, wordEnd: 1 },
    ]);
    expect(srt).toContain('1\n00:00:00,200 --> 00:00:01,250\nOLÁ PESSOAL');
  });
});

const threeWordTranscript: Transcript = {
  engine: 'scribe',
  text: 'um dois tres',
  words: [
    { text: 'um', start: 20.1, end: 20.3, type: 'word' },
    { text: 'dois', start: 20.4, end: 20.6, type: 'word' },
    { text: 'tres', start: 20.7, end: 20.9, type: 'word' },
  ],
};

describe('buildSubtitleCues — hidden ranges', () => {
  it('removes exactly the word inside the hidden range, preserving the cues before and after it', () => {
    const hiddenDoc: EditDoc = {
      ...doc,
      subtitles: {
        enabled: true,
        preset: '3p-natural',
        maxWordsPerCue: 1,
        hiddenRanges: [{ source: 'cam', start: 20.45, end: 20.55 }],
      },
    };
    const cues = buildSubtitleCues(hiddenDoc, new Map([['cam', threeWordTranscript]]));
    expect(cues.map((c) => c.text)).toEqual(['um', 'tres']);
  });

  it('does not leave the hidden word as a pill cue or inside another chunk cue', () => {
    const hiddenDoc: EditDoc = {
      ...doc,
      subtitles: {
        enabled: true,
        preset: 'pill',
        hiddenRanges: [{ source: 'cam', start: 20.45, end: 20.55 }],
      },
    };
    const cues = buildSubtitleCues(hiddenDoc, new Map([['cam', threeWordTranscript]]));
    expect(cues.some((c) => c.text.toLowerCase().includes('dois'))).toBe(false);
    expect(cues.length).toBeGreaterThan(0);
  });

  it('does not affect words from a different source with identical timestamps', () => {
    const twoSourceDoc: EditDoc = {
      ...doc,
      sources: { cam: { path: 'camera.mp4' }, screen: { path: 'screen.mov' } },
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 10, out: 12 },
            { source: 'screen', in: 10, out: 12 },
          ],
        },
      ],
      subtitles: {
        enabled: true,
        preset: '3p-natural',
        maxWordsPerCue: 1,
        hiddenRanges: [{ source: 'screen', start: 10.1, end: 10.7 }],
      },
    };
    const screenTranscript: Transcript = {
      engine: 'scribe',
      text: 'olá pessoal',
      words: [
        { text: 'olá', start: 10.2, end: 10.6, type: 'word' },
        { text: 'pessoal', start: 10.7, end: 11.2, type: 'word' },
      ],
    };
    const cues = buildSubtitleCues(
      twoSourceDoc,
      new Map([
        ['cam', transcript],
        ['screen', screenTranscript],
      ]),
    );
    const camCues = cues.filter((c) => c.source === 'cam');
    expect(camCues.map((c) => c.text)).toEqual(['olá', 'pessoal']);
  });
});

describe('buildSubtitleCues — corrections', () => {
  it('replaces the text in every cue where the word appears, including when highlighted', () => {
    const correctedDoc: EditDoc = {
      ...doc,
      subtitles: {
        enabled: true,
        preset: 'pill',
        corrections: [{ source: 'cam', at: spokenWords(transcript)[1]!.start, text: 'gente' }],
      },
    };
    const cues = buildSubtitleCues(correctedDoc, new Map([['cam', transcript]]));
    const chunkCues = cues.filter((c) => c.wordStart === 0 && c.wordEnd === 1);
    expect(chunkCues.length).toBeGreaterThan(0);
    expect(chunkCues.every((c) => c.text.includes('gente'))).toBe(true);
    expect(chunkCues.some((c) => c.text.includes('pessoal'))).toBe(false);
  });

  it('escapes "<" in the corrected text', () => {
    const correctedDoc: EditDoc = {
      ...doc,
      subtitles: {
        enabled: true,
        preset: '3p-natural',
        maxWordsPerCue: 1,
        corrections: [{ source: 'cam', at: spokenWords(transcript)[0]!.start, text: '<script>' }],
      },
    };
    const cues = buildSubtitleCues(correctedDoc, new Map([['cam', transcript]]));
    expect(cues[0]!.text).toBe('&lt;script&gt;');
  });
});

describe('buildSubtitleCues — wordStart/wordEnd', () => {
  it('reports the spokenWords index range of the chunk', () => {
    const chunkDoc: EditDoc = {
      ...doc,
      subtitles: { enabled: true, preset: '3p-natural', minWordsPerCue: 3, maxWordsPerCue: 3 },
    };
    const cues = buildSubtitleCues(chunkDoc, new Map([['cam', threeWordTranscript]]));
    expect(cues).toHaveLength(1);
    expect(cues[0]!.wordStart).toBe(0);
    expect(cues[0]!.wordEnd).toBe(2);
  });
});

describe('buildSubtitleCues — cue tail clamp', () => {
  const tailTranscript: Transcript = {
    engine: 'scribe',
    text: 'ultima palavra',
    words: [
      { text: 'ultima', start: 10.0, end: 10.3, type: 'word' },
      { text: 'palavra', start: 10.4, end: 10.7, type: 'word' },
    ],
  };
  const singleBlockDoc: EditDoc = {
    ...doc,
    tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 10, out: 11 }] }],
  };

  it('keeps a karaoke cue end within the default max tail of its last word', () => {
    const karaokeDoc: EditDoc = { ...singleBlockDoc, subtitles: { enabled: true, preset: 'pill' } };
    const cues = buildSubtitleCues(karaokeDoc, new Map([['cam', tailTranscript]]));
    const lastCue = cues[cues.length - 1]!;
    // last word ends at 10.7, shifted by offset -10 → 0.7; default tail is 0.4
    expect(lastCue.end).toBeLessThanOrEqual(0.7 + 0.4 + 1e-9);
  });

  it('clamps the cue end to a custom maxTailS', () => {
    const customDoc: EditDoc = {
      ...singleBlockDoc,
      subtitles: { enabled: true, preset: 'pill', maxTailS: 0.05 },
    };
    const cues = buildSubtitleCues(customDoc, new Map([['cam', tailTranscript]]));
    const lastCue = cues[cues.length - 1]!;
    expect(lastCue.end).toBeCloseTo(0.7 + 0.05, 5);
  });

  it('still clamps against the following cue when the overlap is tighter than the tail', () => {
    const overlapTranscript: Transcript = {
      ...tailTranscript,
      words: [...tailTranscript.words, { text: 'depois', start: 10.75, end: 11.0, type: 'word' }],
    };
    const overlapDoc: EditDoc = {
      ...doc,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 10, out: 10.72 },
            { source: 'cam', in: 10.72, out: 11.2 },
          ],
        },
      ],
      subtitles: { enabled: true, preset: 'pill' },
    };
    const cues = buildSubtitleCues(overlapDoc, new Map([['cam', overlapTranscript]]));
    // "palavra" cue's default tail cap (0.7 + 0.4 = 1.1) would not bind, but
    // "depois" starts at 0.75 — the existing next-cue overlap clamp must win.
    const palavraCue = cues[1]!;
    const depoisCue = cues[2]!;
    expect(palavraCue.end).toBe(depoisCue.start);
    expect(palavraCue.end).toBeCloseTo(0.75, 5);
  });
});
