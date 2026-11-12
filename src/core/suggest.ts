import type { Suggestion } from './schema.js';
import type { SilenceInterval } from './silence.js';
import type { TranscriptWord } from './transcript.js';
import { detectFalseStarts, detectFillers, detectRepetitions } from './repetition.js';
import { DEFAULT_PADDING, type CutPadding } from './timeline.js';

const round2 = (t: number): number => Math.round(t * 100) / 100;

export interface SuggestInput {
  readonly source: string;
  readonly silences: readonly SilenceInterval[];
  readonly words?: readonly TranscriptWord[];
}

/**
 * Non-destructive cut candidates: pauses always work (offline, no API);
 * repetitions and fillers need a transcript. The user accepts or rejects —
 * nothing is applied here.
 */
export function buildSuggestions(
  input: SuggestInput,
  padding: CutPadding = DEFAULT_PADDING,
): Suggestion[] {
  const suggestions: Suggestion[] = [];

  for (const silence of input.silences) {
    const start = silence.start + padding.afterS;
    const end = silence.end - padding.beforeS;
    if (end - start < 0.15) continue;
    suggestions.push({
      id: `sil-${input.source}-${start.toFixed(2)}`,
      type: 'silence',
      source: input.source,
      start: round2(start),
      end: round2(end),
      reason: `${(silence.end - silence.start).toFixed(1)}s pause`,
    });
  }

  if (input.words) {
    const falseStarts = detectFalseStarts(input.words);
    for (const candidate of falseStarts) {
      suggestions.push({
        id: `fs-${input.source}-${candidate.start.toFixed(2)}`,
        type: 'false-start',
        source: input.source,
        start: round2(candidate.start),
        end: round2(candidate.end),
        reason: `"${candidate.text}" — ${candidate.reason}`,
      });
    }
    // A false start is the more precise reading of the same retake: it ends
    // exactly where the phrase restarts and includes the cut-off word.
    const insideFalseStart = (start: number, end: number): boolean =>
      falseStarts.some((f) => start < f.end && end > f.start);
    for (const candidate of detectRepetitions(input.words)) {
      if (insideFalseStart(candidate.start, candidate.end)) continue;
      suggestions.push({
        id: `rep-${input.source}-${candidate.start.toFixed(2)}`,
        type: 'repetition',
        source: input.source,
        start: round2(candidate.start),
        end: round2(candidate.end),
        reason: `"${candidate.text}" — ${candidate.reason}`,
      });
    }
    for (const candidate of detectFillers(input.words, input.silences)) {
      suggestions.push({
        id: `fil-${input.source}-${candidate.start.toFixed(2)}`,
        type: 'filler',
        source: input.source,
        start: round2(candidate.start),
        end: round2(candidate.end),
        reason: candidate.reason,
      });
    }
  }

  return suggestions.sort((a, b) => a.start - b.start);
}

const SUMMARY_ORDER: readonly Suggestion['type'][] = [
  'silence',
  'repetition',
  'false-start',
  'filler',
];

/** `silence 12 · repetition 3 · false-start 5 · filler 2` — only the types that occurred. */
export function suggestionSummaryLine(suggestions: readonly Suggestion[]): string {
  const parts = SUMMARY_ORDER.map(
    (type) => [type, suggestions.filter((s) => s.type === type).length] as const,
  )
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${type} ${String(count)}`);
  return parts.length > 0 ? parts.join(' · ') : 'no suggestions';
}
