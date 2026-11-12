import { z } from 'zod';
import { err, ok, type Result } from './result.js';

export interface TranscriptWord {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly type: 'word' | 'spacing' | 'audio_event';
  readonly speakerId?: string;
}

export interface Transcript {
  readonly engine: 'scribe';
  readonly languageCode?: string;
  readonly text: string;
  readonly words: readonly TranscriptWord[];
  readonly audioDurationS?: number;
}

const scribeWordSchema = z
  .object({
    text: z.string(),
    start: z.number().nullable().optional(),
    end: z.number().nullable().optional(),
    type: z.enum(['word', 'spacing', 'audio_event']),
    speaker_id: z.string().nullable().optional(),
  })
  .loose();

export type TranscriptFreshness = 'missing' | 'stale-media' | 'stale-keyterms' | 'fresh';

interface RawScribeWord {
  readonly text: string;
  readonly start?: number | null | undefined;
  readonly end?: number | null | undefined;
  readonly type: 'word' | 'spacing' | 'audio_event';
  readonly speaker_id?: string | null | undefined;
}

const UNTIMED_WORD_S = 0.05;

interface TimedRaw {
  readonly word: RawScribeWord;
  readonly start: number | null;
  readonly end: number | null;
}

function toTimedRaw(word: RawScribeWord): TimedRaw {
  return {
    word,
    start: typeof word.start === 'number' ? word.start : null,
    end: typeof word.end === 'number' ? word.end : null,
  };
}

/**
 * A run of spoken words Scribe left untimed shares the gap between the last
 * timed word before it and the first timed word after it, in equal slices
 * that never overlap a timed neighbour. Without a gap they get a minimal
 * span past the previous word.
 */
function placeRun(
  run: readonly RawScribeWord[],
  previousEnd: number,
  nextStart: number | undefined,
): TranscriptWord[] {
  const available = nextStart !== undefined ? nextStart - previousEnd : 0;
  const slice = available > 0 ? available / run.length : UNTIMED_WORD_S;
  return run.map((word, index) => ({
    text: word.text,
    start: previousEnd + index * slice,
    end: previousEnd + (index + 1) * slice,
    type: word.type,
    ...(typeof word.speaker_id === 'string' ? { speakerId: word.speaker_id } : {}),
  }));
}

/**
 * Scribe v2 may leave an entry without timing. A spoken word must survive
 * (QA, corrections and cuts count words), so it is placed between its timed
 * neighbours; spacing and audio events without full timing carry nothing
 * and go.
 */
function withTiming(words: readonly RawScribeWord[]): TranscriptWord[] {
  const entries = words.map(toTimedRaw);
  const timed: TranscriptWord[] = [];
  let run: RawScribeWord[] = [];
  const flush = (nextStart: number | undefined): void => {
    if (run.length === 0) return;
    timed.push(...placeRun(run, timed[timed.length - 1]?.end ?? 0, nextStart));
    run = [];
  };
  for (const entry of entries) {
    if (entry.start !== null && entry.end !== null) {
      flush(entry.start);
      timed.push({
        text: entry.word.text,
        start: entry.start,
        end: entry.end,
        type: entry.word.type,
        ...(typeof entry.word.speaker_id === 'string' ? { speakerId: entry.word.speaker_id } : {}),
      });
    } else if (entry.word.type === 'word') {
      run.push(entry.word);
    }
  }
  flush(undefined);
  return timed;
}

const scribeSchema = z
  .object({
    language_code: z.string().optional(),
    text: z.string(),
    words: z.array(scribeWordSchema),
    audio_duration_secs: z.number().optional(),
  })
  .loose();

export function parseScribeTranscript(data: unknown): Result<Transcript> {
  const parsed = scribeSchema.safeParse(data);
  if (!parsed.success) {
    return err(
      'invalid-transcript',
      'Scribe transcript JSON has an unexpected shape',
      parsed.error,
    );
  }
  const raw = parsed.data;
  return ok({
    engine: 'scribe',
    ...(raw.language_code !== undefined ? { languageCode: raw.language_code } : {}),
    text: raw.text,
    words: withTiming(raw.words),
    ...(raw.audio_duration_secs !== undefined ? { audioDurationS: raw.audio_duration_secs } : {}),
  });
}

export const TRANSCRIPT_CACHE_MODEL = 'scribe_v2';

const cacheMetaSchema = z
  .object({
    engine: z.literal('scribe'),
    model: z.literal(TRANSCRIPT_CACHE_MODEL),
    sourceHash: z.string().min(1),
    keytermsHash: z.string().min(1),
    transcribedAt: z.string().min(1),
  })
  .loose();

const cachedSchema = cacheMetaSchema.extend({ transcript: z.unknown() });

export interface TranscriptCacheMeta {
  readonly engine: 'scribe';
  readonly model: typeof TRANSCRIPT_CACHE_MODEL;
  readonly sourceHash: string;
  readonly keytermsHash: string;
  readonly transcribedAt: string;
}

/**
 * Cache files written by Studio wrap the raw Scribe JSON with the engine
 * model and the fingerprints of what produced it. Anything else — including
 * caches from earlier engines or models — is not a transcript: the media is
 * transcribed again.
 */
export function parseTranscriptFile(data: unknown): Result<Transcript> {
  const wrapped = cachedSchema.safeParse(data);
  if (!wrapped.success) {
    return err(
      'invalid-transcript',
      'transcript cache was not written by the current engine',
      wrapped.error,
    );
  }
  return parseScribeTranscript(wrapped.data.transcript);
}

/** The cache header alone — enough to say whether a transcript is current without parsing its words. */
export function parseTranscriptCacheMeta(data: unknown): TranscriptCacheMeta | null {
  const parsed = cacheMetaSchema.safeParse(data);
  if (!parsed.success) return null;
  const { engine, model, sourceHash, keytermsHash, transcribedAt } = parsed.data;
  return { engine, model, sourceHash, keytermsHash, transcribedAt };
}

/** Spoken words only — spacing and audio events removed. */
export function spokenWords(transcript: Transcript): TranscriptWord[] {
  return transcript.words.filter((w) => w.type === 'word');
}

import type { SilenceInterval } from './silence.js';

// Scribe sometimes swallows the pause with no measurable silence at all; 1.2s
// comfortably covers drawled pt-BR speech without re-hanging the caption.
export const MAX_WORD_DURATION_S = 1.2;

/**
 * Scribe inflates the END of the last word of a sentence — the word timestamp
 * swallows the following pause (measured: a word "lasting" 5.7s). Clamp each
 * word's end at the start of any measured silence that begins inside it, so
 * word-guarded cuts, subtitles and QA all agree with the real audio. When no
 * silence catches it, fall back to a hard duration cap.
 */
export function refineWordEnds(
  words: readonly TranscriptWord[],
  silences: readonly SilenceInterval[],
  minSpokenS = 0.12,
): TranscriptWord[] {
  return words.map((word) => {
    if (word.type !== 'word') return word;
    for (const silence of silences) {
      if (silence.start > word.start + minSpokenS && silence.start < word.end - 0.05) {
        return { ...word, end: Math.round(silence.start * 1000) / 1000 };
      }
    }
    const cap = word.start + MAX_WORD_DURATION_S;
    return word.end > cap ? { ...word, end: cap } : word;
  });
}

export function refineTranscript(
  transcript: Transcript,
  silences: readonly SilenceInterval[],
): Transcript {
  return { ...transcript, words: refineWordEnds(transcript.words, silences) };
}

export function normalizeToken(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** Word times on another clock: a transcript of slowed-down audio mapped back to the file's own seconds. */
export function scaleTranscriptTimes(transcript: Transcript, factor: number): Transcript {
  const round3 = (t: number): number => Math.round(t * factor * 1000) / 1000;
  return {
    ...transcript,
    words: transcript.words.map((word) => ({
      ...word,
      start: round3(word.start),
      end: round3(word.end),
    })),
    ...(transcript.audioDurationS !== undefined
      ? { audioDurationS: round3(transcript.audioDurationS) }
      : {}),
  };
}
