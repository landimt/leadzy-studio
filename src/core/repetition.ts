import { normalizeToken, type TranscriptWord } from './transcript.js';
import type { SilenceInterval } from './silence.js';

export interface RepetitionCandidate {
  readonly kind: 'repetition' | 'filler' | 'false-start';
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly reason: string;
}

export interface RepetitionOptions {
  readonly minNgram?: number;
  readonly proximityWindowS?: number;
}

const DEFAULTS: Required<RepetitionOptions> = {
  minNgram: 4,
  proximityWindowS: 30,
};

const FILLER_TOKENS = new Set(['é', 'e', 'né', 'hã', 'ãh', 'uh', 'um', 'hum', 'tipo']);

/**
 * A retake shows up as the same phrase (≥ minNgram words) spoken twice within
 * a short window — the earlier occurrence is the flubbed attempt; the last one
 * is usually the keeper.
 */
export function detectRepetitions(
  words: readonly TranscriptWord[],
  options: RepetitionOptions = {},
): RepetitionCandidate[] {
  const { minNgram, proximityWindowS } = { ...DEFAULTS, ...options };
  const spoken = words.filter((w) => w.type === 'word');
  const tokens = spoken.map((w) => normalizeToken(w.text));

  const candidates: RepetitionCandidate[] = [];
  const claimed = new Set<number>();

  for (let i = 0; i < spoken.length - minNgram; i += 1) {
    if (claimed.has(i)) continue;
    const anchorEnd = spoken[i + minNgram - 1];
    if (!anchorEnd) break;

    for (let j = i + minNgram; j < spoken.length - minNgram + 1; j += 1) {
      const laterStart = spoken[j];
      if (!laterStart) break;
      if (laterStart.start - anchorEnd.end > proximityWindowS) break;

      let matchLength = 0;
      while (
        i + matchLength < j &&
        j + matchLength < spoken.length &&
        tokens[i + matchLength] !== '' &&
        tokens[i + matchLength] === tokens[j + matchLength]
      ) {
        matchLength += 1;
      }
      if (matchLength >= minNgram) {
        const firstWord = spoken[i];
        const lastWord = spoken[i + matchLength - 1];
        if (firstWord && lastWord) {
          candidates.push({
            kind: 'repetition',
            start: firstWord.start,
            end: lastWord.end,
            text: spoken
              .slice(i, i + matchLength)
              .map((w) => w.text)
              .join(' '),
            reason: `repeated ${String(matchLength)} words ~${(laterStart.start - firstWord.start).toFixed(1)}s later — earlier take is usually the flub`,
          });
          for (let k = i; k < i + matchLength; k += 1) claimed.add(k);
        }
        break;
      }
    }
  }
  return candidates;
}

/**
 * Isolated fillers ("é...", "né" alone between pauses) are cut candidates.
 * Only meaningful with a verbatim transcript.
 */
export function detectFillers(
  words: readonly TranscriptWord[],
  silences: readonly SilenceInterval[],
  minGapS = 0.3,
): RepetitionCandidate[] {
  const spoken = words.filter((w) => w.type === 'word');
  const isPauseAt = (time: number): boolean =>
    silences.some((s) => time >= s.start - 0.05 && time <= s.end + 0.05);

  const candidates: RepetitionCandidate[] = [];
  spoken.forEach((word, i) => {
    if (!FILLER_TOKENS.has(normalizeToken(word.text))) return;
    const previous = spoken[i - 1];
    const next = spoken[i + 1];
    const gapBefore = previous ? word.start - previous.end : Number.POSITIVE_INFINITY;
    const gapAfter = next ? next.start - word.end : Number.POSITIVE_INFINITY;
    const isolatedBefore = gapBefore >= minGapS || isPauseAt(word.start);
    const isolatedAfter = gapAfter >= minGapS || isPauseAt(word.end);
    if (isolatedBefore && isolatedAfter) {
      candidates.push({
        kind: 'filler',
        start: word.start,
        end: word.end,
        text: word.text,
        reason: `isolated filler "${word.text}" between pauses`,
      });
    }
  });
  return candidates;
}

export interface FalseStartOptions {
  /** How far after the truncated word the restart may begin. */
  readonly lookaheadS?: number;
  /** Words before the truncated one that must reappear at the restart. */
  readonly minContext?: number;
  readonly maxContext?: number;
}

const FALSE_START_DEFAULTS: Required<FalseStartOptions> = {
  lookaheadS: 4,
  minContext: 2,
  maxContext: 8,
};

/** Scribe marks a word cut off mid-way with a trailing double dash. */
const TRUNCATION = /(--|—)\s*[.,!?…]*$/u;
const MIN_STEM_CHARS = 3;

export function isTruncatedWord(text: string): boolean {
  return TRUNCATION.test(text.trim());
}

function contextMatch(
  tokens: readonly string[],
  anchor: number,
  restart: number,
  options: Required<FalseStartOptions>,
): number {
  for (let k = Math.min(options.maxContext, anchor); k >= options.minContext; k -= 1) {
    let same = true;
    for (let offset = 0; offset < k; offset += 1) {
      const before = tokens[anchor - k + offset];
      if (before === '' || before !== tokens[restart + offset]) {
        same = false;
        break;
      }
    }
    if (same) return k;
  }
  return 0;
}

/**
 * A false start is a word cut off mid-way (`me--`) followed shortly by the
 * speaker taking the phrase again. The flubbed attempt runs from the first
 * word that is repeated at the restart up to the restart itself; a stumble
 * on a single word (`in--` … `intenção`) is caught by its stem when no
 * context repeats. Only the transcript's own marks are trusted — nothing
 * here guesses at intent.
 */
export function detectFalseStarts(
  words: readonly TranscriptWord[],
  options: FalseStartOptions = {},
): RepetitionCandidate[] {
  const settings = { ...FALSE_START_DEFAULTS, ...options };
  const spoken = words.filter((w) => w.type === 'word');
  const tokens = spoken.map((w) => normalizeToken(w.text));
  const candidates: RepetitionCandidate[] = [];

  spoken.forEach((anchor, i) => {
    if (!isTruncatedWord(anchor.text)) return;
    const stem = normalizeToken(anchor.text);
    for (let j = i + 1; j < spoken.length; j += 1) {
      const restart = spoken[j];
      if (!restart) break;
      if (restart.start - anchor.end > settings.lookaheadS) break;
      const context = contextMatch(tokens, i, j, settings);
      const stemMatch =
        context === 0 &&
        stem.length >= MIN_STEM_CHARS &&
        (tokens[j] ?? '').startsWith(stem) &&
        tokens[j] !== stem;
      if (context === 0 && !stemMatch) continue;
      const first = context > 0 ? spoken[i - context] : anchor;
      if (!first) break;
      candidates.push({
        kind: 'false-start',
        start: first.start,
        end: restart.start,
        text: spoken
          .slice(i - context, i + 1)
          .map((w) => w.text)
          .join(' '),
        reason: `false start "${anchor.text}" — phrase restarted at ${restart.start.toFixed(2)}s`,
      });
      break;
    }
  });
  return candidates;
}
