import { silencesFromPeaks, type WaveformPeaks } from '../../../core/peaks.js';
import { baseTrackOf, type EditDoc, type Suggestion } from '../../../core/schema.js';
import { applySuggestion, cutInterval } from '../../../core/timeline.js';
import { mapVideoTrack } from './mapTrack.js';

// Pure silence-cut and suggestion edits on the base track. The store owns
// history, validation, saving and the extra-selection reset a cut forces.

export interface SilenceCut {
  readonly source: string;
  readonly from: number;
  readonly to: number;
}

export interface SilenceCutKinds {
  readonly interior: boolean;
  readonly edges: boolean;
}

export function silenceCutKey(cut: SilenceCut): string {
  return `${cut.source}:${cut.from.toFixed(4)}:${cut.to.toFixed(4)}`;
}

/**
 * Where the scissors will land: interior silences ≥ minSilenceS PLUS quiet
 * tails touching block edges (breaths at cut joints), which get a relaxed
 * 0.15s rule regardless of the slider. Overlapping candidates are merged.
 */
export function computeSilenceCuts(
  doc: EditDoc,
  peaksBySource: ReadonlyMap<string, WaveformPeaks>,
  minSilenceS: number,
  kinds: SilenceCutKinds = { interior: true, edges: true },
): SilenceCut[] {
  const base = baseTrackOf(doc);
  const cuts: { source: string; from: number; to: number }[] = [];
  for (const [key] of Object.entries(doc.sources)) {
    const peaks = peaksBySource.get(key);
    if (!peaks) continue;
    const fine = silencesFromPeaks(peaks, 'auto', 0.15);
    const coarse = silencesFromPeaks(peaks, 'auto', minSilenceS);
    for (const block of base.blocks) {
      if (block.source !== key) continue;
      if (kinds.interior)
        for (const silence of coarse) {
          const from = Math.max(silence.start + 0.08, block.in);
          const to = Math.min(silence.end - 0.05, block.out);
          if (to - from >= 0.12) cuts.push({ source: key, from, to });
        }
      if (kinds.edges)
        for (const silence of fine) {
          // breath glued to a cut joint: silence overlapping the block edge
          const touchesHead = silence.start <= block.in + 0.02 && silence.end > block.in + 0.1;
          const touchesTail = silence.end >= block.out - 0.02 && silence.start < block.out - 0.1;
          if (touchesHead) {
            const to = Math.min(silence.end - 0.05, block.out - 0.1);
            if (to - block.in >= 0.1) cuts.push({ source: key, from: block.in, to });
          }
          if (touchesTail) {
            const from = Math.max(silence.start + 0.08, block.in + 0.1);
            if (block.out - from >= 0.1) cuts.push({ source: key, from, to: block.out });
          }
        }
    }
  }
  // dedupe overlapping candidates (edge + interior can double-report)
  cuts.sort((a, b) => a.from - b.from);
  const merged: typeof cuts = [];
  for (const cut of cuts) {
    const last = merged[merged.length - 1];
    if (last?.source === cut.source && cut.from <= last.to + 0.01) {
      last.to = Math.max(last.to, cut.to);
    } else {
      merged.push({ ...cut });
    }
  }
  return merged;
}

/** The scissors: applies every cut to the base track as one document change. `null` with no cuts. */
export function cutSilences(doc: EditDoc, cuts: readonly SilenceCut[]): EditDoc | null {
  if (cuts.length === 0) return null;
  const base = baseTrackOf(doc);
  let blocks = base.blocks;
  for (const cut of cuts) {
    blocks = cutInterval(blocks, cut.source, cut.from, cut.to);
  }
  return { ...doc, tracks: [{ ...base, blocks: [...blocks] }, ...doc.tracks.slice(1)] };
}

export function cutSuggestionInterval(doc: EditDoc, suggestion: Suggestion): EditDoc {
  const base = baseTrackOf(doc);
  return mapVideoTrack(doc, base.id, (track) => ({
    ...track,
    blocks: cutInterval(track.blocks, suggestion.source, suggestion.start, suggestion.end),
  }));
}

/** Applies a reviewed subset as one document change (and therefore one undo step). */
export function acceptSuggestions(doc: EditDoc, ids: ReadonlySet<string>): EditDoc {
  let next = doc;
  for (const suggestion of [...(doc.suggestions ?? [])].reverse()) {
    if (!ids.has(suggestion.id)) continue;
    next = applySuggestion(next, suggestion.id);
  }
  return next;
}

/** Applies every pending suggestion; `applySuggestion` resolves each by id, so the order is cosmetic. */
export function acceptAllSuggestions(doc: EditDoc): EditDoc {
  return acceptSuggestions(
    doc,
    new Set((doc.suggestions ?? []).map((suggestion) => suggestion.id)),
  );
}

/** Drops a reviewed subset without touching the timeline. */
export function rejectSuggestions(doc: EditDoc, ids: ReadonlySet<string>): EditDoc {
  if (ids.size === 0) return doc;
  return {
    ...doc,
    suggestions: (doc.suggestions ?? []).filter((suggestion) => !ids.has(suggestion.id)),
  };
}
