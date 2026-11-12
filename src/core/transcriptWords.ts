import { spokenWords, type Transcript, type TranscriptWord } from './transcript.js';

export interface WordWindow {
  /** Keep words whose span ends after this source time. */
  readonly from?: number;
  /** Keep words whose span starts before this source time. */
  readonly to?: number;
  /** Case-insensitive substring of the word text; a plain string, never a pattern. */
  readonly grep?: string;
}

export interface CutMargins {
  readonly beforeS: number;
  readonly afterS: number;
}

/** The cut convention the guide asks for: ~50 ms of air before the first word, ~80 ms after the last. */
export const DEFAULT_CUT_MARGINS: CutMargins = { beforeS: 0.05, afterS: 0.08 };

export interface WordBlock {
  readonly in: number;
  readonly out: number;
  readonly firstWord: string;
  readonly lastWord: string;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
/** The pack prints times with two decimals; a bound copied from it may sit 5 ms inside the word it names. */
const BOUNDARY_TOLERANCE_S = 0.006;

export function wordsInWindow(
  transcript: Transcript,
  window: WordWindow = {},
): readonly TranscriptWord[] {
  const needle = window.grep?.toLocaleLowerCase();
  return spokenWords(transcript).filter(
    (word) =>
      (window.from === undefined || word.end > window.from) &&
      (window.to === undefined || word.start < window.to) &&
      (needle === undefined || word.text.toLocaleLowerCase().includes(needle)),
  );
}

/**
 * A base-track block covering a contiguous run of spoken words, padded with
 * air on both sides but never into the neighbouring words — so the cut stays
 * on a word boundary whatever the margins are.
 */
export function blockForWords(
  transcript: Transcript,
  firstStart: number,
  lastEnd: number,
  margins: CutMargins = DEFAULT_CUT_MARGINS,
): WordBlock | null {
  const spoken = spokenWords(transcript);
  const firstIndex = spoken.findIndex((word) => word.start >= firstStart - BOUNDARY_TOLERANCE_S);
  const lastIndex = spoken.findLastIndex((word) => word.end <= lastEnd + BOUNDARY_TOLERANCE_S);
  const first = spoken[firstIndex];
  const last = spoken[lastIndex];
  if (!first || !last || lastIndex < firstIndex) return null;
  const previousEnd = spoken[firstIndex - 1]?.end ?? 0;
  const nextStart = spoken[lastIndex + 1]?.start ?? Number.POSITIVE_INFINITY;
  return {
    in: round2(Math.max(first.start - margins.beforeS, previousEnd)),
    out: round2(Math.min(last.end + margins.afterS, nextStart)),
    firstWord: first.text,
    lastWord: last.text,
  };
}

export function formatWordLine(word: TranscriptWord): string {
  return `${word.start.toFixed(2)}-${word.end.toFixed(2)} ${word.text}`;
}
