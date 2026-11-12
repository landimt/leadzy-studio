import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { err, ok, type Result } from '../../core/result.js';
import type { RenderStep } from '../../core/render/steps.js';
import {
  renderSubtitleGraphicSvg,
  subtitleGraphicFontFamily,
  type SubtitleGraphicFont,
} from '../../core/subtitleGraphic.js';

type SubtitleGraphicsStep = Extract<RenderStep, { kind: 'subtitle-graphics' }>;

interface FrameEntry {
  readonly filename: string;
  readonly durationS: number;
}

const require = createRequire(import.meta.url);
const FONT_WEIGHTS = [400, 500, 600, 700, 800, 900] as const;
const MAX_GRAPHIC_CACHE_SETS = 4;
const fontPromises = new Map<
  SubtitleGraphicFont['family'],
  Promise<readonly SubtitleGraphicFont[]>
>();

async function bundledFonts(
  family: SubtitleGraphicFont['family'],
): Promise<readonly SubtitleGraphicFont[]> {
  let promise = fontPromises.get(family);
  if (promise) return promise;
  const packageName = family === 'Inter' ? 'inter' : 'arimo';
  promise = Promise.all(
    FONT_WEIGHTS.map(async (weight) => {
      const fileWeight = family === 'Arimo' && weight > 700 ? 700 : weight;
      const path = require.resolve(
        `@fontsource/${packageName}/files/${packageName}-latin-${String(fileWeight)}-normal.woff`,
      );
      const bytes = await readFile(path);
      return {
        data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        family,
        weight,
      };
    }),
  );
  fontPromises.set(family, promise);
  return promise;
}

function frameFilename(text: string): string {
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 20);
  return `cue-${hash}.png`;
}

function frameEntries(step: SubtitleGraphicsStep): readonly FrameEntry[] {
  const entries: FrameEntry[] = [];
  let cursor = 0;
  const append = (filename: string, durationS: number): void => {
    if (durationS <= 0.000001) return;
    const previous = entries.at(-1);
    if (previous?.filename === filename) {
      entries[entries.length - 1] = {
        filename,
        durationS: previous.durationS + durationS,
      };
      return;
    }
    entries.push({ filename, durationS });
  };

  for (const cue of step.cues) {
    const start = Math.max(cursor, Math.min(step.durationS, cue.start));
    const end = Math.max(start, Math.min(step.durationS, cue.end));
    append('blank.png', start - cursor);
    append(frameFilename(cue.text), end - start);
    cursor = end;
  }
  append('blank.png', step.durationS - cursor);
  if (entries.length === 0) append('blank.png', step.durationS);
  return entries;
}

function manifestFor(entries: readonly FrameEntry[]): string {
  const lines = ['ffconcat version 1.0'];
  for (const entry of entries) {
    lines.push(`file '${entry.filename}'`, `duration ${entry.durationS.toFixed(9)}`);
  }
  // ffconcat ignores the final duration unless another packet follows it.
  const last = entries.at(-1);
  if (last) lines.push(`file '${last.filename}'`);
  return `${lines.join('\n')}\n`;
}

async function isNonEmptyFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data);
    try {
      await rename(temporary, path);
    } catch (cause) {
      // Two concurrent renders of the same content-addressed caption may
      // publish the same immutable asset. Keeping the winner is safe.
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Materialize the one shared SVG caption timeline as transparent PNG frames. */
export async function renderSubtitleGraphics(
  projectDir: string,
  step: SubtitleGraphicsStep,
): Promise<Result<void>> {
  const manifestAbsolute = join(projectDir, step.manifestPath);
  const targetDir = dirname(manifestAbsolute);
  const entries = frameEntries(step);
  const requiredFiles = new Set(['blank.png', ...entries.map((entry) => entry.filename)]);

  if (
    (await isNonEmptyFile(manifestAbsolute)) &&
    (
      await Promise.all(
        [...requiredFiles].map(async (filename) => isNonEmptyFile(join(targetDir, filename))),
      )
    ).every(Boolean)
  ) {
    return ok(undefined);
  }

  try {
    await mkdir(targetDir, { recursive: true });
    const blankSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(step.width)}" height="${String(step.height)}" viewBox="0 0 ${String(step.width)} ${String(step.height)}"/>`;
    await writeAtomic(join(targetDir, 'blank.png'), new Resvg(blankSvg).render().asPng());

    const fonts = await bundledFonts(subtitleGraphicFontFamily(step.theme.fontFamily));
    const cuesByFilename = new Map(step.cues.map((cue) => [frameFilename(cue.text), cue] as const));
    for (const [filename, cue] of cuesByFilename) {
      const svg = await renderSubtitleGraphicSvg({
        cue,
        dimensions: { width: step.width, height: step.height },
        settings: step.settings,
        theme: step.theme,
        fonts,
      });
      await writeAtomic(join(targetDir, filename), new Resvg(svg).render().asPng());
    }
    // The manifest is the commit marker and is published only after every
    // referenced frame exists, so cache hits can never expose a partial set.
    await writeAtomic(manifestAbsolute, manifestFor(entries));
    return ok(undefined);
  } catch (cause) {
    return err('io-failed', 'não foi possível compor as legendas vetoriais', cause);
  }
}

/** Keep content-addressed caption assets bounded as documents evolve. */
export async function pruneSubtitleGraphicsCache(
  projectDir: string,
  keepManifestPath: string,
): Promise<void> {
  const root = join(projectDir, 'edit/cache/subtitles');
  const keepDir = dirname(join(projectDir, keepManifestPath));
  let directories;
  try {
    directories = (await readdir(root, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory() && /^vector-[a-f0-9]{24}$/u.test(entry.name),
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw cause;
  }
  const dated = await Promise.all(
    directories.map(async (entry) => {
      const path = join(root, entry.name);
      return { path, modifiedAt: (await stat(path)).mtimeMs };
    }),
  );
  const retained = new Set(
    [
      ...dated.filter((entry) => entry.path === keepDir),
      ...dated
        .filter((entry) => entry.path !== keepDir)
        .sort((a, b) => b.modifiedAt - a.modifiedAt),
    ]
      .slice(0, MAX_GRAPHIC_CACHE_SETS)
      .map((entry) => entry.path),
  );
  await Promise.all(
    dated
      .filter((entry) => !retained.has(entry.path))
      .map(async (entry) => rm(entry.path, { recursive: true, force: true })),
  );
}

export const subtitleGraphicsInternals = { frameEntries, manifestFor };
