import arimo400Url from '@fontsource/arimo/files/arimo-latin-400-normal.woff?url';
import arimo500Url from '@fontsource/arimo/files/arimo-latin-500-normal.woff?url';
import arimo600Url from '@fontsource/arimo/files/arimo-latin-600-normal.woff?url';
import arimo700Url from '@fontsource/arimo/files/arimo-latin-700-normal.woff?url';
import inter400Url from '@fontsource/inter/files/inter-latin-400-normal.woff?url';
import inter500Url from '@fontsource/inter/files/inter-latin-500-normal.woff?url';
import inter600Url from '@fontsource/inter/files/inter-latin-600-normal.woff?url';
import inter700Url from '@fontsource/inter/files/inter-latin-700-normal.woff?url';
import inter800Url from '@fontsource/inter/files/inter-latin-800-normal.woff?url';
import inter900Url from '@fontsource/inter/files/inter-latin-900-normal.woff?url';
import {
  renderSubtitleGraphicSvg,
  subtitleGraphicFontFamily,
  type SubtitleGraphicFont,
  type SubtitleGraphicInput,
} from '../../../core/subtitleGraphic.js';

type PreviewGraphicInput = Omit<SubtitleGraphicInput, 'fonts'>;

const FONT_SOURCES = {
  Arimo: [
    { url: arimo400Url, weight: 400 },
    { url: arimo500Url, weight: 500 },
    { url: arimo600Url, weight: 600 },
    { url: arimo700Url, weight: 700 },
    // Arimo follows Arial's 400/700 family. Label the bold face for the two
    // heavier CSS choices too, matching the browser's historical Arial
    // fallback instead of synthesizing a different export-only face.
    { url: arimo700Url, weight: 800 },
    { url: arimo700Url, weight: 900 },
  ],
  Inter: [
    { url: inter400Url, weight: 400 },
    { url: inter500Url, weight: 500 },
    { url: inter600Url, weight: 600 },
    { url: inter700Url, weight: 700 },
    { url: inter800Url, weight: 800 },
    { url: inter900Url, weight: 900 },
  ],
} as const;

const fontPromises = new Map<
  SubtitleGraphicFont['family'],
  Promise<readonly SubtitleGraphicFont[]>
>();
const svgCache = new Map<string, Promise<string>>();
const MAX_CACHED_GRAPHICS = 64;

export function subtitleGraphicPreviewKey(input: PreviewGraphicInput): string {
  return JSON.stringify({
    text: input.cue.text,
    dimensions: input.dimensions,
    settings: input.settings,
    theme: input.theme,
  });
}

async function loadFonts(
  family: SubtitleGraphicFont['family'],
): Promise<readonly SubtitleGraphicFont[]> {
  let promise = fontPromises.get(family);
  if (!promise) {
    promise = Promise.all(
      FONT_SOURCES[family].map(async ({ url, weight }) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`cannot load bundled subtitle font (${String(weight)})`);
        return { data: await response.arrayBuffer(), family, weight };
      }),
    );
    fontPromises.set(family, promise);
  }
  return promise;
}

/** Browser half of the shared caption renderer; identical SVG is rasterized for export. */
export function subtitleGraphicPreviewSvg(input: PreviewGraphicInput): Promise<string> {
  const key = subtitleGraphicPreviewKey(input);
  let pending = svgCache.get(key);
  if (!pending) {
    while (svgCache.size >= MAX_CACHED_GRAPHICS) {
      const oldest = svgCache.keys().next().value;
      if (oldest === undefined) break;
      svgCache.delete(oldest);
    }
    pending = loadFonts(subtitleGraphicFontFamily(input.theme.fontFamily)).then(async (fonts) =>
      renderSubtitleGraphicSvg({ ...input, fonts }),
    );
    svgCache.set(key, pending);
    void pending.catch(() => {
      if (svgCache.get(key) === pending) svgCache.delete(key);
    });
  } else {
    svgCache.delete(key);
    svgCache.set(key, pending);
  }
  return pending;
}
