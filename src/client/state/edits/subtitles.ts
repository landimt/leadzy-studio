import { baseTrackOf, type EditDoc, type SubtitleHiddenRange } from '../../../core/schema.js';
import { restoreWordRange, strikeWordRange, type WordRange } from '../../../core/timeline.js';
import { spokenWords, type Transcript } from '../../../core/transcript.js';
import type { SelectedCue } from '../storeState.js';
import { mapVideoTrack } from './mapTrack.js';

// Pure subtitle and transcript-driven edits. Every function returns the next
// document, or `null` when there is nothing to change; the store owns
// history, validation, saving and selection.

const round2 = (value: number): number => Math.round(value * 100) / 100;

type Subtitles = EditDoc['subtitles'];

/**
 * Hides the cues' source-time windows. Callers hand in duplicates on purpose:
 * the pill preset reuses one (source, wordStart, wordEnd) triple per word chunk
 * (see buildSubtitleCues), so equal triples collapse to one range. Cues whose
 * transcript or words are missing, or whose window is empty, are skipped.
 * `null` when no range would be added.
 */
export function hideCues(
  doc: EditDoc,
  cues: readonly SelectedCue[],
  transcripts: ReadonlyMap<string, Transcript>,
): EditDoc | null {
  if (cues.length === 0) return null;
  const additions: SubtitleHiddenRange[] = [];
  const seen = new Set<string>();
  for (const cue of cues) {
    const key = `${cue.source}:${String(cue.wordStart)}:${String(cue.wordEnd)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const transcript = transcripts.get(cue.source);
    if (!transcript) continue;
    const words = spokenWords(transcript);
    const first = words[cue.wordStart];
    const last = words[cue.wordEnd];
    if (!first || !last) continue;
    const start = round2(first.start);
    const end = round2(last.end);
    if (end <= start) continue;
    additions.push({ source: cue.source, start, end });
  }
  if (additions.length === 0) return null;
  return {
    ...doc,
    subtitles: {
      ...doc.subtitles,
      hiddenRanges: [...(doc.subtitles.hiddenRanges ?? []), ...additions],
    },
  };
}

/** Manual fix for a mistranscribed word; an empty text removes the correction. */
export function correctWord(doc: EditDoc, source: string, at: number, text: string): EditDoc {
  const withoutEntry = (doc.subtitles.corrections ?? []).filter(
    (correction) => !(correction.source === source && correction.at === at),
  );
  const trimmed = text.trim();
  const corrections =
    trimmed.length > 0 ? [...withoutEntry, { source, at, text: trimmed }] : withoutEntry;
  return {
    ...doc,
    subtitles: {
      ...doc.subtitles,
      corrections: corrections.length > 0 ? corrections : undefined,
    },
  };
}

/** Suppresses subtitles over a SOURCE-time window (persisted, independent of cuts/reordering). */
export function hideSubtitleRange(
  doc: EditDoc,
  source: string,
  start: number,
  end: number,
): EditDoc | null {
  const roundedStart = round2(start);
  const roundedEnd = round2(end);
  if (roundedEnd <= roundedStart) return null;
  const hiddenRanges = [
    ...(doc.subtitles.hiddenRanges ?? []),
    { source, start: roundedStart, end: roundedEnd },
  ];
  return { ...doc, subtitles: { ...doc.subtitles, hiddenRanges } };
}

export function unhideSubtitleRange(doc: EditDoc, index: number): EditDoc {
  const hiddenRanges = (doc.subtitles.hiddenRanges ?? []).filter((_, i) => i !== index);
  return {
    ...doc,
    subtitles: {
      ...doc.subtitles,
      hiddenRanges: hiddenRanges.length > 0 ? hiddenRanges : undefined,
    },
  };
}

/** Cuts the words' interval out of the base track (word-boundary cut, never mid-word). */
export function strikeWords(
  doc: EditDoc,
  transcript: Transcript,
  sourceKey: string,
  range: WordRange,
): EditDoc {
  const base = baseTrackOf(doc);
  const words = spokenWords(transcript);
  return mapVideoTrack(doc, base.id, (track) => ({
    ...track,
    blocks: strikeWordRange(track.blocks, sourceKey, words, range),
  }));
}

/** Puts a struck interval back into the base track. */
export function restoreWords(
  doc: EditDoc,
  transcript: Transcript,
  sourceKey: string,
  range: WordRange,
): EditDoc {
  const base = baseTrackOf(doc);
  const words = spokenWords(transcript);
  return mapVideoTrack(doc, base.id, (track) => ({
    ...track,
    blocks: restoreWordRange(track.blocks, sourceKey, words, range),
  }));
}

/** Switching preset drops the custom theme and force-style so the preset's look wins. */
export function setSubtitlePreset(doc: EditDoc, preset: Subtitles['preset']): EditDoc {
  return {
    ...doc,
    subtitles: { ...doc.subtitles, preset, theme: undefined, forceStyle: undefined },
  };
}

export function updateSubtitleSettings(doc: EditDoc, patch: Partial<Subtitles>): EditDoc {
  return { ...doc, subtitles: { ...doc.subtitles, ...patch } };
}

/** Bottom margin as a fraction of the frame, stored as ASS marginV pixels clamped to [10, 240]. */
export function setSubtitleMargin(doc: EditDoc, bottomFraction: number): EditDoc {
  const marginV = Math.round(Math.min(240, Math.max(10, bottomFraction * 288)));
  return { ...doc, subtitles: { ...doc.subtitles, marginV } };
}
