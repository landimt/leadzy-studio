import { describe, expect, it } from 'vitest';
import type { EditDoc } from '../../../core/schema.js';
import type { Transcript } from '../../../core/transcript.js';
import {
  correctWord,
  hideCues,
  hideSubtitleRange,
  restoreWords,
  setSubtitleMargin,
  setSubtitlePreset,
  strikeWords,
  unhideSubtitleRange,
  updateSubtitleSettings,
} from './subtitles.js';

function makeDoc(subtitles: Partial<EditDoc['subtitles']> = {}): EditDoc {
  return {
    version: 2,
    fps: 25,
    output: { width: 1080, height: 1920, loudnormLufs: -14 },
    sources: { cam: { path: 'camera.mp4', durationS: 10 } },
    tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 4 }] }],
    subtitles: { enabled: true, preset: '2p-caps', ...subtitles },
    totalDurationS: 4,
  };
}

const transcript: Transcript = {
  engine: 'scribe',
  text: 'um dois tres quatro',
  words: [
    { text: 'um', start: 0.004, end: 1, type: 'word' },
    { text: ' ', start: 1, end: 1, type: 'spacing' },
    { text: 'dois', start: 1, end: 2, type: 'word' },
    { text: 'tres', start: 2, end: 3, type: 'word' },
    { text: 'quatro', start: 3, end: 3.996, type: 'word' },
  ],
};
const transcripts = new Map([['cam', transcript]]);

function baseBlocks(doc: EditDoc | null): readonly { in: number; out: number }[] {
  const base = doc?.tracks[0];
  return base?.kind === 'video' ? base.blocks : [];
}

describe('hideCues', () => {
  it('hides each distinct cue window, rounded, appended after the existing ranges', () => {
    const doc = makeDoc({ hiddenRanges: [{ source: 'cam', start: 9, end: 9.5 }] });

    const next = hideCues(
      doc,
      [
        { source: 'cam', wordStart: 0, wordEnd: 0 },
        { source: 'cam', wordStart: 0, wordEnd: 0 },
        { source: 'cam', wordStart: 0, wordEnd: 1 },
        { source: 'cam', wordStart: 2, wordEnd: 3 },
      ],
      transcripts,
    );

    expect(next?.subtitles.hiddenRanges).toStrictEqual([
      { source: 'cam', start: 9, end: 9.5 },
      { source: 'cam', start: 0, end: 1 },
      { source: 'cam', start: 0, end: 2 },
      { source: 'cam', start: 2, end: 4 },
    ]);
  });

  it('is a no-op without cues, without a transcript, past the last word, or on an empty window', () => {
    expect(hideCues(makeDoc(), [], transcripts)).toBeNull();
    expect(
      hideCues(makeDoc(), [{ source: 'other', wordStart: 0, wordEnd: 0 }], transcripts),
    ).toBeNull();
    expect(
      hideCues(makeDoc(), [{ source: 'cam', wordStart: 3, wordEnd: 9 }], transcripts),
    ).toBeNull();
    expect(
      hideCues(makeDoc(), [{ source: 'cam', wordStart: 2, wordEnd: 1 }], transcripts),
    ).toBeNull();
  });
});

describe('correctWord', () => {
  it('keeps one correction per word, replacing an earlier one and trimming the text', () => {
    const first = correctWord(makeDoc(), 'cam', 1, ' dois ');
    const other = correctWord(first, 'cam', 3, 'quatro!');
    const replaced = correctWord(other, 'cam', 1, 'DOIS');

    expect(replaced.subtitles.corrections).toStrictEqual([
      { source: 'cam', at: 3, text: 'quatro!' },
      { source: 'cam', at: 1, text: 'DOIS' },
    ]);
  });

  it('only touches the correction of the same source', () => {
    const cam = correctWord(makeDoc(), 'cam', 1, 'a');
    const both = correctWord(cam, 'mic', 1, 'b');

    expect(correctWord(both, 'cam', 1, '').subtitles.corrections).toStrictEqual([
      { source: 'mic', at: 1, text: 'b' },
    ]);
  });

  it('removes the correction on blank text and drops the list when it empties', () => {
    const corrected = correctWord(makeDoc(), 'cam', 1, 'dois');

    expect(correctWord(corrected, 'cam', 1, '   ').subtitles).toStrictEqual({
      enabled: true,
      preset: '2p-caps',
      corrections: undefined,
    });
  });
});

describe('hideSubtitleRange / unhideSubtitleRange', () => {
  it('rounds the window and appends it', () => {
    const doc = makeDoc({ hiddenRanges: [{ source: 'cam', start: 5, end: 6 }] });
    const next = hideSubtitleRange(doc, 'cam', 0.004, 0.996);

    expect(next?.subtitles.hiddenRanges).toStrictEqual([
      { source: 'cam', start: 5, end: 6 },
      { source: 'cam', start: 0, end: 1 },
    ]);
  });

  it('refuses a window that is empty once rounded', () => {
    expect(hideSubtitleRange(makeDoc(), 'cam', 1.001, 1.004)).toBeNull();
    expect(hideSubtitleRange(makeDoc(), 'cam', 2, 1)).toBeNull();
  });

  it('removes a range by index and drops the list when the last one goes', () => {
    const doc = makeDoc({
      hiddenRanges: [
        { source: 'cam', start: 0, end: 1 },
        { source: 'cam', start: 2, end: 3 },
      ],
    });

    const one = unhideSubtitleRange(doc, 0);
    expect(one.subtitles.hiddenRanges).toStrictEqual([{ source: 'cam', start: 2, end: 3 }]);
    expect(unhideSubtitleRange(one, 0).subtitles).toStrictEqual({
      enabled: true,
      preset: '2p-caps',
      hiddenRanges: undefined,
    });
    expect(unhideSubtitleRange(doc, 7).subtitles.hiddenRanges).toStrictEqual(
      doc.subtitles.hiddenRanges,
    );
  });
});

describe('strikeWords / restoreWords', () => {
  it('cuts the words out of the base track on word boundaries and restores the interval', () => {
    const struck = strikeWords(makeDoc(), transcript, 'cam', { startIndex: 1, endIndex: 2 });
    const blocks = baseBlocks(struck);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.in).toBe(0);
    expect(blocks[0]?.out).toBeLessThanOrEqual(1);
    expect(blocks[0]?.out).toBeGreaterThan(0.5);
    expect(blocks[1]?.in).toBeGreaterThanOrEqual(3);
    expect(blocks[1]?.in).toBeLessThan(3.5);
    expect(blocks[1]?.out).toBe(4);

    const restored = restoreWords(struck, transcript, 'cam', { startIndex: 1, endIndex: 2 });
    expect(baseBlocks(restored)).toEqual([{ source: 'cam', in: 0, out: 4 }]);
  });

  it('ignores words of a source the base track does not use', () => {
    const struck = strikeWords(makeDoc(), transcript, 'other', { startIndex: 1, endIndex: 2 });

    expect(baseBlocks(struck)).toEqual([{ source: 'cam', in: 0, out: 4 }]);
  });
});

describe('subtitle settings', () => {
  it('switching preset clears the custom theme and force-style', () => {
    const doc = makeDoc({ forceStyle: 'Bold=1' });

    expect(setSubtitlePreset(doc, 'pill').subtitles).toStrictEqual({
      enabled: true,
      preset: 'pill',
      theme: undefined,
      forceStyle: undefined,
    });
  });

  it('merges a settings patch over the current subtitles', () => {
    const doc = makeDoc({ maxWordsPerCue: 4 });

    expect(updateSubtitleSettings(doc, { enabled: false, fontSize: 60 }).subtitles).toStrictEqual({
      enabled: false,
      preset: '2p-caps',
      maxWordsPerCue: 4,
      fontSize: 60,
    });
  });

  it('stores the bottom margin as marginV pixels clamped to [10, 240] and rounded', () => {
    expect(setSubtitleMargin(makeDoc(), 0).subtitles.marginV).toBe(10);
    expect(setSubtitleMargin(makeDoc(), -1).subtitles.marginV).toBe(10);
    expect(setSubtitleMargin(makeDoc(), 1).subtitles.marginV).toBe(240);
    expect(setSubtitleMargin(makeDoc(), 0.5).subtitles.marginV).toBe(144);
    expect(setSubtitleMargin(makeDoc(), 0.1).subtitles.marginV).toBe(29);
    expect(setSubtitleMargin(makeDoc(), 0.3).subtitles.marginV).toBe(86);
  });
});
