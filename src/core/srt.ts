import { outputSegments, segmentOutputTime } from './timeline.js';
import type {
  EditDoc,
  SubtitleCorrection,
  SubtitleFill,
  SubtitleHiddenRange,
  SubtitlePreset,
} from './schema.js';
import { spokenWords, type Transcript, type TranscriptWord } from './transcript.js';

export interface SubtitleCue {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly source: string;
  /** Index into `spokenWords(transcript)` of the chunk's first/last word. */
  readonly wordStart: number;
  readonly wordEnd: number;
}

interface IndexedWord extends TranscriptWord {
  readonly index: number;
}

interface PresetConfig {
  readonly minWordsPerCue: number;
  readonly maxWordsPerCue: number;
  readonly uppercase: boolean;
  readonly fontSize: number;
  readonly marginV: number;
  readonly theme: ResolvedSubtitleTheme;
}

export interface ResolvedSubtitleTheme {
  readonly fontFamily: string;
  readonly fontWeight: number;
  readonly fill: SubtitleFill;
  readonly highlightFill: SubtitleFill;
  readonly backgroundStyle: 'pill' | 'outline' | 'none';
  readonly backgroundColor: string;
  readonly backgroundOpacity: number;
  readonly outlineColor: string;
  readonly outlineWidth: number;
}

const PRESETS: Record<SubtitlePreset, PresetConfig> = {
  // dark rounded box, white bold, the spoken word in brand pink — the
  // "Pílula Escura" look is the pill base, not an override on top of it
  pill: {
    minWordsPerCue: 2,
    maxWordsPerCue: 3,
    uppercase: false,
    fontSize: 15,
    marginV: 64,
    theme: {
      fontFamily: 'Arial',
      fontWeight: 700,
      fill: { kind: 'solid', color: '#FFFFFF' },
      highlightFill: { kind: 'solid', color: '#FF3B81' },
      backgroundStyle: 'pill',
      backgroundColor: '#101010',
      backgroundOpacity: 0.85,
      outlineColor: '#000000',
      outlineWidth: 7,
    },
  },
  '2p-caps': {
    minWordsPerCue: 1,
    maxWordsPerCue: 2,
    uppercase: true,
    fontSize: 18,
    marginV: 35,
    theme: {
      fontFamily: 'Helvetica',
      fontWeight: 700,
      fill: { kind: 'solid', color: '#FFFFFF' },
      highlightFill: { kind: 'solid', color: '#FFFFFF' },
      backgroundStyle: 'outline',
      backgroundColor: '#000000',
      backgroundOpacity: 0,
      outlineColor: '#000000',
      outlineWidth: 2,
    },
  },
  '3p-natural': {
    minWordsPerCue: 1,
    maxWordsPerCue: 3,
    uppercase: false,
    fontSize: 16,
    marginV: 60,
    theme: {
      fontFamily: 'Helvetica',
      fontWeight: 700,
      fill: { kind: 'solid', color: '#FFFFFF' },
      highlightFill: { kind: 'solid', color: '#FFFFFF' },
      backgroundStyle: 'outline',
      backgroundColor: '#000000',
      backgroundOpacity: 0,
      outlineColor: '#000000',
      outlineWidth: 2,
    },
  },
};

const DEFAULT_MAX_TAIL_S = 0.4;

export interface ResolvedSubtitleSettings {
  readonly minWordsPerCue: number;
  readonly maxWordsPerCue: number;
  readonly fontSize: number;
  readonly marginV: number;
  readonly maxTailS: number;
}

/** One source of defaults for the renderer, live preview and agent-facing inspector. */
export function subtitleSettingsFor(doc: EditDoc): ResolvedSubtitleSettings {
  const preset = PRESETS[doc.subtitles.preset];
  const maxWordsPerCue = doc.subtitles.maxWordsPerCue ?? preset.maxWordsPerCue;
  return {
    minWordsPerCue: Math.min(doc.subtitles.minWordsPerCue ?? preset.minWordsPerCue, maxWordsPerCue),
    maxWordsPerCue,
    fontSize: doc.subtitles.fontSize ?? preset.fontSize,
    marginV: doc.subtitles.marginV ?? preset.marginV,
    maxTailS: doc.subtitles.maxTailS ?? DEFAULT_MAX_TAIL_S,
  };
}

export function subtitleThemeFor(doc: EditDoc): ResolvedSubtitleTheme {
  const base = PRESETS[doc.subtitles.preset].theme;
  const custom = doc.subtitles.theme;
  return {
    fontFamily: custom?.fontFamily ?? base.fontFamily,
    fontWeight: custom?.fontWeight ?? base.fontWeight,
    fill: custom?.fill ?? base.fill,
    highlightFill: custom?.highlightFill ?? base.highlightFill,
    backgroundStyle: custom?.backgroundStyle ?? base.backgroundStyle,
    backgroundColor: custom?.backgroundColor ?? base.backgroundColor,
    backgroundOpacity: custom?.backgroundOpacity ?? base.backgroundOpacity,
    outlineColor: custom?.outlineColor ?? base.outlineColor,
    outlineWidth: custom?.outlineWidth ?? base.outlineWidth,
  };
}

function fillStartColor(fill: SubtitleFill): string {
  return fill.kind === 'solid' ? fill.color : fill.from;
}

function assColor(hex: string, opacity = 1): string {
  const normalized = hex.slice(1);
  const red = normalized.slice(0, 2);
  const green = normalized.slice(2, 4);
  const blue = normalized.slice(4, 6);
  const alpha = Math.round((1 - opacity) * 255)
    .toString(16)
    .padStart(2, '0');
  return `&H${alpha}${blue}${green}${red}`.toUpperCase();
}

export function forceStyleFor(doc: EditDoc): string {
  const settings = subtitleSettingsFor(doc);
  if (doc.subtitles.forceStyle !== undefined) {
    return doc.subtitles.forceStyle
      .replace(/MarginV=\d+/, `MarginV=${String(settings.marginV)}`)
      .replace(/FontSize=\d+/, `FontSize=${String(settings.fontSize)}`);
  }
  const theme = subtitleThemeFor(doc);
  const pill = theme.backgroundStyle === 'pill';
  const outline = theme.backgroundStyle === 'none' ? 0 : theme.outlineWidth;
  const borderColor = pill ? theme.backgroundColor : theme.outlineColor;
  const borderOpacity = pill ? theme.backgroundOpacity : 1;
  return [
    `FontName=${theme.fontFamily}`,
    `FontSize=${String(settings.fontSize)}`,
    `Bold=${theme.fontWeight >= 600 ? '1' : '0'}`,
    `PrimaryColour=${assColor(fillStartColor(theme.fill))}`,
    `OutlineColour=${assColor(borderColor, borderOpacity)}`,
    `BackColour=${assColor(theme.backgroundColor, theme.backgroundOpacity)}`,
    `BorderStyle=${pill ? '3' : '1'}`,
    `Outline=${String(outline)}`,
    'Shadow=0',
    'Alignment=2',
    `MarginV=${String(settings.marginV)}`,
  ].join(',');
}

const ENDS_CLAUSE = /[.,!?;:…]$/u;

function escapeSubtitleText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hexChannels(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function gradientColor(from: string, to: string, progress: number): string {
  const start = hexChannels(from);
  const end = hexChannels(to);
  const channel = (index: number): string =>
    Math.round((start[index] ?? 0) + ((end[index] ?? 0) - (start[index] ?? 0)) * progress)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(0)}${channel(1)}${channel(2)}`.toUpperCase();
}

function paintText(text: string, fill: SubtitleFill): string {
  if (fill.kind === 'solid') {
    return `<font color="${fill.color.toUpperCase()}">${escapeSubtitleText(text)}</font>`;
  }
  const characters = Array.from(text);
  const paintedCount = characters.filter((character) => !/\s/u.test(character)).length;
  let paintedIndex = 0;
  return characters
    .map((character) => {
      if (/\s/u.test(character)) return escapeSubtitleText(character);
      const progress = paintedCount <= 1 ? 0 : paintedIndex / (paintedCount - 1);
      paintedIndex += 1;
      return `<font color="${gradientColor(fill.from, fill.to, progress)}">${escapeSubtitleText(character)}</font>`;
    })
    .join('');
}

export function groupWords<T extends { readonly text: string }>(
  words: readonly T[],
  minWordsPerCue: number,
  maxWordsPerCue: number,
): T[][] {
  const groups: T[][] = [];
  let chunk: T[] = [];

  for (const word of words) {
    chunk.push(word);
    const reachedMax = chunk.length >= maxWordsPerCue;
    const reachedClause = chunk.length >= minWordsPerCue && ENDS_CLAUSE.test(word.text);
    if (reachedMax || reachedClause) {
      groups.push(chunk);
      chunk = [];
    }
  }
  if (chunk.length > 0) groups.push(chunk);

  // Avoid a one-word orphan at the end whenever min/max can both be respected.
  const last = groups.at(-1);
  const previous = groups.at(-2);
  if (last && previous && last.length < minWordsPerCue) {
    const movable = Math.min(
      minWordsPerCue - last.length,
      Math.max(0, previous.length - minWordsPerCue),
    );
    if (movable > 0) last.unshift(...previous.splice(previous.length - movable, movable));
    if (last.length < minWordsPerCue && previous.length + last.length <= maxWordsPerCue) {
      previous.push(...last);
      groups.pop();
    }
  }

  return groups;
}

/** The spoken word a correction points at: the first one whose span contains `at`. */
export function correctionWordIndex(
  words: readonly TranscriptWord[],
  at: number,
): number | undefined {
  const index = words.findIndex((word) => word.start <= at && at < word.end);
  return index === -1 ? undefined : index;
}

/** Corrected text by spoken-word index; a correction pointing between words is ignored. */
export function resolveCorrections(
  words: readonly TranscriptWord[],
  corrections: readonly Pick<SubtitleCorrection, 'at' | 'text'>[],
): ReadonlyMap<number, string> {
  const resolved = new Map<number, string>();
  for (const correction of corrections) {
    const index = correctionWordIndex(words, correction.at);
    if (index !== undefined) resolved.set(index, correction.text);
  }
  return resolved;
}

/** Corrections and hidden ranges apply once per source, in SOURCE time, before any segment shift. */
function preparedWordsFor(
  source: string,
  transcript: Transcript,
  hiddenRanges: readonly SubtitleHiddenRange[],
  corrections: readonly SubtitleCorrection[],
): IndexedWord[] {
  const hiddenForSource = hiddenRanges.filter((r) => r.source === source);
  const spoken = spokenWords(transcript);
  const correctionsForSource = resolveCorrections(
    spoken,
    corrections.filter((c) => c.source === source),
  );
  return spoken
    .map((word, index): IndexedWord => ({ ...word, index }))
    .map((word) => {
      const correctedText = correctionsForSource.get(word.index);
      return correctedText === undefined ? word : { ...word, text: correctedText };
    })
    .filter((word) => {
      const mid = (word.start + word.end) / 2;
      return !hiddenForSource.some((range) => range.start <= mid && mid < range.end);
    });
}

/**
 * Cue times live on the OUTPUT timeline: each kept word is mapped through
 * `segmentOutputTime`, which honors the block's speed. Building from source
 * timestamps without that mapping is the classic desync bug — never do it.
 */
export function buildSubtitleCues(
  doc: EditDoc,
  transcripts: ReadonlyMap<string, Transcript>,
): SubtitleCue[] {
  const preset = PRESETS[doc.subtitles.preset];
  const settings = subtitleSettingsFor(doc);
  const theme = subtitleThemeFor(doc);
  const cues: SubtitleCue[] = [];
  const hiddenRanges = doc.subtitles.hiddenRanges ?? [];
  const corrections = doc.subtitles.corrections ?? [];
  const preparedWordsBySource = new Map<string, IndexedWord[]>();

  for (const segment of outputSegments(doc)) {
    const transcript = transcripts.get(segment.source);
    if (!transcript) continue;
    const toOutput = (sourceTime: number): number => segmentOutputTime(segment, sourceTime);
    let prepared = preparedWordsBySource.get(segment.source);
    if (!prepared) {
      prepared = preparedWordsFor(segment.source, transcript, hiddenRanges, corrections);
      preparedWordsBySource.set(segment.source, prepared);
    }
    const words = prepared.filter(
      (w) => (w.start + w.end) / 2 >= segment.in && (w.start + w.end) / 2 < segment.out,
    );

    const appendChunk = (chunk: typeof words): void => {
      const first = chunk[0];
      const last = chunk[chunk.length - 1];
      if (!first || !last) return;
      const wordStart = first.index;
      const wordEnd = last.index;
      // A cue must not outlive its last spoken word by more than maxTailS.
      const tailCap = toOutput(last.end) + settings.maxTailS;
      if (doc.subtitles.preset === 'pill') {
        // karaoke: one cue per word — the pink highlight follows the voice
        chunk.forEach((word, i) => {
          const next = chunk[i + 1];
          const rawEnd = toOutput(next ? next.start : last.end + 0.15);
          cues.push({
            start: Math.max(0, toOutput(word.start)),
            end: Math.max(0, Math.min(rawEnd, tailCap)),
            text: chunk
              .map((w) => {
                const fill = w === word ? theme.highlightFill : theme.fill;
                return w === word || fill.kind === 'gradient'
                  ? paintText(w.text, fill)
                  : escapeSubtitleText(w.text);
              })
              .join(' '),
            source: segment.source,
            wordStart,
            wordEnd,
          });
        });
      } else {
        const plain = chunk.map((w) => w.text).join(' ');
        cues.push({
          start: Math.max(0, toOutput(first.start)),
          end: Math.max(0, Math.min(toOutput(last.end), tailCap)),
          text:
            theme.fill.kind === 'gradient'
              ? paintText(preset.uppercase ? plain.toLocaleUpperCase('pt-BR') : plain, theme.fill)
              : escapeSubtitleText(preset.uppercase ? plain.toLocaleUpperCase('pt-BR') : plain),
          source: segment.source,
          wordStart,
          wordEnd,
        });
      }
    };
    for (const chunk of groupWords(words, settings.minWordsPerCue, settings.maxWordsPerCue)) {
      appendChunk(chunk);
    }
  }

  for (let i = 0; i < cues.length - 1; i += 1) {
    const current = cues[i];
    const next = cues[i + 1];
    if (current && next && current.end > next.start) {
      cues[i] = { ...current, end: next.start };
    }
  }
  return cues;
}

function formatSrtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  const pad = (n: number, width: number): string => n.toString().padStart(width, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(rest, 3)}`;
}

export function cuesToSrt(cues: readonly SubtitleCue[]): string {
  return cues
    .map(
      (cue, i) =>
        `${String(i + 1)}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${cue.text}\n`,
    )
    .join('\n');
}
