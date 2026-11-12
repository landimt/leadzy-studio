import { groupWords } from './srt.js';
import type { SubtitleCorrection } from './schema.js';
import { correctionWordIndex } from './srt.js';
import { spokenWords, type Transcript, type TranscriptWord } from './transcript.js';

const MIN_WORDS_PER_LINE = 4;
const MAX_WORDS_PER_LINE = 14;
/** Hard line break when the pause between two consecutive words exceeds this. */
const MAX_GAP_S = 0.6;

interface WordRun {
  readonly kind: 'words';
  readonly words: readonly TranscriptWord[];
}
interface EventRun {
  readonly kind: 'event';
  readonly word: TranscriptWord;
}
type Run = WordRun | EventRun;

function formatTime(seconds: number, decimals: number): string {
  return seconds.toFixed(decimals);
}

/** speakerId → "S1"/"S2"/… in order of first appearance among spoken words. */
function speakerLabels(words: readonly TranscriptWord[]): ReadonlyMap<string, string> {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const word of words) {
    if (word.type !== 'word' || word.speakerId === undefined || seen.has(word.speakerId)) continue;
    seen.add(word.speakerId);
    order.push(word.speakerId);
  }
  return new Map(order.map((id, index) => [id, `S${String(index + 1)}`]));
}

/** Spacing is dropped; audio events split the surrounding words into their own runs, in place. */
function toRuns(words: readonly TranscriptWord[]): Run[] {
  const runs: Run[] = [];
  let current: TranscriptWord[] = [];
  const flush = (): void => {
    if (current.length > 0) {
      runs.push({ kind: 'words', words: current });
      current = [];
    }
  };
  for (const word of words) {
    if (word.type === 'spacing') continue;
    if (word.type === 'audio_event') {
      flush();
      runs.push({ kind: 'event', word });
      continue;
    }
    current.push(word);
  }
  flush();
  return runs;
}

function splitByGap(words: readonly TranscriptWord[]): TranscriptWord[][] {
  const groups: TranscriptWord[][] = [];
  let current: TranscriptWord[] = [];
  let previousEnd: number | undefined;
  for (const word of words) {
    if (previousEnd !== undefined && word.start - previousEnd > MAX_GAP_S) {
      groups.push(current);
      current = [];
    }
    current.push(word);
    previousEnd = word.end;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function formatWordLine(
  chunk: readonly TranscriptWord[],
  labels: ReadonlyMap<string, string>,
): string {
  const first = chunk[0];
  const last = chunk[chunk.length - 1];
  if (!first || !last) return '';
  const label = first.speakerId !== undefined ? labels.get(first.speakerId) : undefined;
  const prefix = label ? `(${label}) ` : '';
  const text = chunk.map((word) => word.text).join(' ');
  return `[${formatTime(first.start, 2)}–${formatTime(last.end, 2)}] ${prefix}${text}`;
}

function formatEventLine(word: TranscriptWord): string {
  return `[${formatTime(word.start, 2)}–${formatTime(word.end, 2)}] {${word.text}}`;
}

function header(name: string, transcript: Transcript, speakerCount: number): string {
  const wordCount = transcript.words.filter((word) => word.type === 'word').length;
  const lastWord = transcript.words[transcript.words.length - 1];
  const durationS = lastWord ? lastWord.end : 0;
  const speakerPart = speakerCount > 1 ? ` · ${String(speakerCount)} speakers` : '';
  return `# ${name} — ${formatTime(durationS, 1)}s · ${String(wordCount)} words${speakerPart}`;
}

/**
 * Compact, agent-readable transcript view — a fraction of the raw ~256KB
 * Scribe cache. PRECONDITION: `transcript` must already be refined via
 * `refineTranscript()` (transcript.ts:168) — the raw Scribe `end` timestamp
 * swallows the following pause (see transcript.ts:140-149), which would
 * corrupt the gap-based line breaks below.
 */
/** `# corrections: [45.02] "Leads" → "Leadzy"` — what the subtitles show instead of what was heard. */
function correctionLines(
  transcript: Transcript,
  corrections: readonly Pick<SubtitleCorrection, 'at' | 'text'>[],
): string[] {
  if (corrections.length === 0) return [];
  const spoken = spokenWords(transcript);
  const entries = [...corrections]
    .sort((a, b) => a.at - b.at)
    .map((correction) => {
      const index = correctionWordIndex(spoken, correction.at);
      const heard =
        index === undefined ? '(no word at this time)' : `"${spoken[index]?.text ?? ''}"`;
      return `[${formatTime(correction.at, 2)}] ${heard} → "${correction.text}"`;
    });
  return [`# corrections: ${entries.join(' · ')}`];
}

export function packTranscript(
  name: string,
  transcript: Transcript,
  corrections: readonly Pick<SubtitleCorrection, 'at' | 'text'>[] = [],
): string {
  const distinctSpeakers = speakerLabels(transcript.words);
  // Labels are only useful once there is more than one speaker to distinguish.
  const labels = distinctSpeakers.size > 1 ? distinctSpeakers : new Map<string, string>();
  const lines: string[] = [header(name, transcript, distinctSpeakers.size)];

  for (const run of toRuns(transcript.words)) {
    if (run.kind === 'event') {
      lines.push(formatEventLine(run.word));
      continue;
    }
    for (const gapGroup of splitByGap(run.words)) {
      for (const chunk of groupWords(gapGroup, MIN_WORDS_PER_LINE, MAX_WORDS_PER_LINE)) {
        lines.push(formatWordLine(chunk, labels));
      }
    }
  }

  return [...lines, ...correctionLines(transcript, corrections)].join('\n');
}
