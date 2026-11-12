import type satori from 'satori';
import type { ResolvedSubtitleSettings, ResolvedSubtitleTheme, SubtitleCue } from './srt.js';

interface SubtitleGraphicDimensions {
  readonly width: number;
  readonly height: number;
}

export interface SubtitleGraphicFont {
  readonly data: ArrayBuffer;
  readonly family: 'Arimo' | 'Inter';
  readonly weight: 400 | 500 | 600 | 700 | 800 | 900;
}

export interface SubtitleGraphicInput {
  readonly cue: Pick<SubtitleCue, 'text'>;
  readonly dimensions: SubtitleGraphicDimensions;
  readonly settings: ResolvedSubtitleSettings;
  readonly theme: ResolvedSubtitleTheme;
  readonly fonts: readonly SubtitleGraphicFont[];
}

interface SubtitleRun {
  readonly text: string;
  readonly color: string;
}

interface SubtitleWord {
  readonly runs: readonly SubtitleRun[];
  readonly text: string;
}

const SIDE_MARGIN_RATIO = 0.026;
const PILL_PADDING_X_EM = 12 / 27.7;
const PILL_PADDING_Y_EM = 5 / 27.7;
const PILL_RADIUS_EM = 10 / 27.7;
const parsedFontCache = new WeakMap<
  ArrayBuffer,
  {
    getAdvanceWidth(
      text: string,
      fontSize: number,
      options?: { kerning?: boolean; letterSpacing?: number },
    ): number;
  }
>();

function decodeSubtitleText(value: string): string {
  return value.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
}

function fillStartColor(fill: ResolvedSubtitleTheme['fill']): string {
  return fill.kind === 'solid' ? fill.color : fill.from;
}

export function subtitleRuns(text: string, defaultColor: string): readonly SubtitleRun[] {
  const runs: SubtitleRun[] = [];
  const tag = /<font color="(#[0-9a-f]{6})">([\s\S]*?)<\/font>/giu;
  let cursor = 0;
  for (const match of text.matchAll(tag)) {
    const index = match.index;
    if (index > cursor) {
      runs.push({ text: decodeSubtitleText(text.slice(cursor, index)), color: defaultColor });
    }
    const color = match[1];
    const content = match[2];
    if (color !== undefined && content !== undefined) {
      runs.push({ text: decodeSubtitleText(content), color: color.toUpperCase() });
    }
    cursor = index + match[0].length;
  }
  if (cursor < text.length) {
    runs.push({ text: decodeSubtitleText(text.slice(cursor)), color: defaultColor });
  }
  return runs.length > 0 ? runs : [{ text: decodeSubtitleText(text), color: defaultColor }];
}

function rgba(hex: string, opacity: number): string {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${String(red)},${String(green)},${String(blue)},${String(opacity)})`;
}

export function subtitleGraphicFontWeight(weight: number): SubtitleGraphicFont['weight'] {
  const supported = [400, 500, 600, 700, 800, 900] as const;
  return supported.reduce((closest, candidate) =>
    Math.abs(candidate - weight) < Math.abs(closest - weight) ? candidate : closest,
  );
}

/**
 * The vector renderer uses redistributable fonts only. Arimo is the open,
 * metric-compatible counterpart for the preset's historical Arial; an
 * explicitly authored Inter theme remains Inter.
 */
export function subtitleGraphicFontFamily(fontFamily: string): SubtitleGraphicFont['family'] {
  return fontFamily.trim().toLocaleLowerCase('en-US') === 'inter' ? 'Inter' : 'Arimo';
}

function preserveRunSpaces(value: string): string {
  // A colour run is a separate flex child. Ordinary leading/trailing spaces
  // are trimmed at that boundary by layout engines; NBSP keeps the authored
  // word gap without creating a visible seam in the shared pill.
  return value.replaceAll(' ', '\u00a0');
}

function subtitleWords(runs: readonly SubtitleRun[]): readonly SubtitleWord[] {
  const words: SubtitleWord[] = [];
  let current: SubtitleRun[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    words.push({ runs: current, text: current.map((run) => run.text).join('') });
    current = [];
  };
  for (const run of runs) {
    for (const part of run.text.split(/(\s+)/u)) {
      if (part === '') continue;
      if (/^\s+$/u.test(part)) flush();
      else current.push({ text: part, color: run.color });
    }
  }
  flush();
  return words;
}

function lineRuns(words: readonly SubtitleWord[]): readonly SubtitleRun[] {
  return words.flatMap((word, index) => [
    ...(index > 0 ? [{ text: ' ', color: word.runs[0]?.color ?? '#FFFFFF' }] : []),
    ...word.runs,
  ]);
}

function partitions<T>(items: readonly T[], parts: number): readonly (readonly T[])[][] {
  if (parts === 1) return [[items]];
  const output: T[][][] = [];
  for (let split = 1; split <= items.length - parts + 1; split += 1) {
    for (const tail of partitions(items.slice(split), parts - 1)) {
      output.push([items.slice(0, split), ...tail.map((part) => [...part])]);
    }
  }
  return output;
}

function balancedWordLines(
  words: readonly SubtitleWord[],
  maxWidth: number,
  measure: (text: string) => number,
): readonly (readonly SubtitleWord[])[] {
  if (words.length <= 1) return [words];
  for (let lineCount = 1; lineCount <= words.length; lineCount += 1) {
    const candidates = partitions(words, lineCount)
      .map((lines) => ({
        lines,
        widths: lines.map((line) => measure(line.map((word) => word.text).join(' '))),
      }))
      .filter(({ lines, widths }) =>
        widths.every((width, index) => width <= maxWidth || lines[index]?.length === 1),
      )
      .sort((a, b) => {
        const spread = (widths: readonly number[]): number =>
          Math.max(...widths) - Math.min(...widths);
        return spread(a.widths) - spread(b.widths);
      });
    const best = candidates[0];
    if (best) return best.lines;
  }
  return words.map((word) => [word]);
}

/**
 * The one visual source of truth for a caption frame. Satori converts the
 * HTML-like layout to SVG paths using our bundled font, so the browser can
 * display this SVG directly and the renderer can rasterize the exact same
 * paths without asking a second text engine to reinterpret the style.
 */
export async function renderSubtitleGraphicSvg(input: SubtitleGraphicInput): Promise<string> {
  const { cue, dimensions, settings, theme, fonts } = input;
  const fontSize = (settings.fontSize / 288) * dimensions.height;
  const maxWidth = dimensions.width * (1 - SIDE_MARGIN_RATIO * 2);
  const defaultColor = fillStartColor(theme.fill);
  const runs = subtitleRuns(cue.text, defaultColor);
  const fontWeight = subtitleGraphicFontWeight(theme.fontWeight);
  const fontFamily = subtitleGraphicFontFamily(theme.fontFamily);
  const selectedFont =
    fonts.find((font) => font.family === fontFamily && font.weight === fontWeight) ?? fonts[0];
  if (!selectedFont) throw new Error(`no bundled ${fontFamily} subtitle font is available`);
  const { default: opentype } = await import('@shuding/opentype.js');
  const cachedFont = parsedFontCache.get(selectedFont.data);
  const parsedFont = cachedFont ?? opentype.parse(selectedFont.data);
  if (!cachedFont) parsedFontCache.set(selectedFont.data, parsedFont);
  const contentMaxWidth = maxWidth - fontSize * PILL_PADDING_X_EM * 2;
  const lines = balancedWordLines(subtitleWords(runs), contentMaxWidth, (text) =>
    parsedFont.getAdvanceWidth(text, fontSize, { kerning: true, letterSpacing: -0.015 }),
  );
  const element = {
    type: 'div',
    props: {
      style: {
        width: dimensions.width,
        height: dimensions.height,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-end',
        paddingBottom: (settings.marginV / 288) * dimensions.height,
      },
      children: {
        type: 'div',
        props: {
          style: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: fontSize * 0.08,
          },
          children: lines.map((line, lineIndex) => ({
            type: 'div',
            props: {
              key: lineIndex,
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: `${String(fontSize * PILL_PADDING_Y_EM)}px ${String(fontSize * PILL_PADDING_X_EM)}px`,
                borderRadius: fontSize * PILL_RADIUS_EM,
                backgroundColor: rgba(theme.backgroundColor, theme.backgroundOpacity),
                color: defaultColor,
                fontFamily,
                fontSize,
                fontWeight,
                lineHeight: 1.2,
                letterSpacing: '-0.015em',
                textAlign: 'center',
                whiteSpace: 'nowrap',
              },
              children: lineRuns(line).map((run, index) => ({
                type: 'span',
                props: {
                  key: index,
                  style: { color: run.color },
                  children: preserveRunSpaces(run.text),
                },
              })),
            },
          })),
        },
      },
    },
  };

  const { default: renderSvg } = await import('satori');
  return renderSvg(element as Parameters<typeof satori>[0], {
    width: dimensions.width,
    height: dimensions.height,
    fonts: fonts.map((font) => ({
      name: font.family,
      data: font.data,
      weight: font.weight,
      style: 'normal' as const,
    })),
  });
}
