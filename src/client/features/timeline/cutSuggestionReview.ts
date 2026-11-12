import type { EditDoc, Suggestion } from '../../../core/schema.js';
import {
  actionableSourceIntervalOutputRanges,
  sourceIntervalOutputRanges,
  type SourceOutputRange,
} from '../../../core/timeline.js';
import type { SilenceCut } from '../../state/edits/suggestions.js';

export type SuggestionOutputRange = SourceOutputRange;

function summarizeRanges(ranges: readonly SuggestionOutputRange[]): SuggestionOutputRange | null {
  const first = ranges[0];
  if (!first) return null;
  return {
    at: first.at,
    durationS: ranges.reduce((sum, range) => sum + range.durationS, 0),
  };
}

/** Every actionable occurrence of a source-time suggestion in the montage. */
export function suggestionOutputRanges(
  doc: EditDoc,
  suggestion: Suggestion,
): SuggestionOutputRange[] {
  return actionableSourceIntervalOutputRanges(
    doc,
    suggestion.source,
    suggestion.start,
    suggestion.end,
  );
}

/** First occurrence plus the combined duration of every visible fragment. */
export function suggestionOutputRange(
  doc: EditDoc,
  suggestion: Suggestion,
): SuggestionOutputRange | null {
  return summarizeRanges(suggestionOutputRanges(doc, suggestion));
}

/** Every output-time preview fragment of one waveform-derived silence cut. */
export function silenceCutOutputRanges(doc: EditDoc, cut: SilenceCut): SuggestionOutputRange[] {
  return sourceIntervalOutputRanges(doc, cut.source, cut.from, cut.to);
}

/** Output-time preview of one waveform-derived silence cut. */
export function silenceCutOutputRange(doc: EditDoc, cut: SilenceCut): SuggestionOutputRange | null {
  return summarizeRanges(silenceCutOutputRanges(doc, cut));
}

export function suggestionCopy(suggestion: Suggestion, visibleDurationS?: number): string {
  const durationS = visibleDurationS ?? suggestion.end - suggestion.start;
  if (suggestion.type === 'silence') return `Pausa de ${durationS.toFixed(1).replace('.', ',')}s`;
  if (suggestion.type === 'repetition') {
    const spoken = suggestion.reason.split(' — ')[0]?.trim();
    return spoken && spoken.length > 0 ? spoken : 'Trecho repetido';
  }
  if (suggestion.type === 'false-start') {
    const spoken = suggestion.reason.split(' — ')[0]?.trim();
    return spoken && spoken.length > 0 ? `Falso começo ${spoken}` : 'Falso começo';
  }
  const filler = /"([^"]+)"/.exec(suggestion.reason)?.[1];
  return filler ? `“${filler}” isolado entre pausas` : 'Vício de linguagem entre pausas';
}

export function formatSuggestionTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remainder = safe - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${remainder.toFixed(1).padStart(4, '0')}`;
}
