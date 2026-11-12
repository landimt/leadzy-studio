import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  escapeHtml,
  substituteTemplate,
  templatePlaceholders,
  unsafePlaceholders,
} from '../../core/htmlTemplate.js';
import { LIBRARY_ITEM_ID_PATTERN, PROJECT_TEMPLATE_FILENAME } from '../../core/libraryItem.js';
import { err, ok, type Result } from '../../core/result.js';
import { probeMedia, runFfmpeg } from './ffmpeg.js';
import { renderHyperframes } from './hyperframes.js';

export interface LibraryOverlaySpec {
  readonly itemId: string;
  readonly variables: Readonly<Record<string, string>>;
}

/** Project folder holding an imported item's asset, its template, and every bake of it. */
export function libraryAssetDir(itemId: string): string {
  return `edit/assets/library/${itemId}`;
}

/**
 * Content-derived asset name over everything the render consumes: the item, the
 * values, and the template itself. Identical inputs share one file; any
 * difference gets its own. Hashing the template matters because a re-import
 * replaces it in place — without it, a fresh render would land on the name an
 * older block still points at and silently change that block's picture.
 *
 * The variable entries are sorted first: a record's key order is an accident of
 * how it was written, not part of its meaning.
 */
function bakeDigest(spec: LibraryOverlaySpec, template: string): string {
  const canonical = JSON.stringify([
    spec.itemId,
    Object.keys(spec.variables)
      .sort()
      .map((name) => [name, spec.variables[name]]),
    createHash('sha256').update(template).digest('hex'),
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

export function bakedOverlayFilename(spec: LibraryOverlaySpec, template: string): string {
  return `bake-${bakeDigest(spec, template)}.webm`;
}

async function isNonEmptyFile(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isFile() && info.size > 0,
    () => false,
  );
}

function companionStillArgs(assetAbs: string): string[] {
  return [
    '-c:v',
    'libvpx-vp9',
    '-i',
    assetAbs,
    '-frames:v',
    '1',
    '-update',
    '1',
    '-pix_fmt',
    'rgba',
    `${assetAbs}.png`,
  ];
}

/**
 * Writes `<asset>.png` from the first seek that yields a frame: 1.5s (the
 * library's settled-frame convention), half the piece for anything shorter,
 * then frame 0 as the last resort. Frame 0 comes last because an intro
 * animation can leave it fully transparent — a blank preview reads as a
 * broken bake.
 */
async function writeSettledStill(projectDir: string, assetAbs: string): Promise<Result<string>> {
  const probe = await probeMedia(assetAbs);
  const half = probe.ok ? Number((probe.value.durationS / 2).toFixed(3)) : 0.5;
  let failure: Result<string> | null = null;
  for (const seek of [...new Set([1.5, half, 0])]) {
    const run = await runFfmpeg(['-y', '-ss', String(seek), ...companionStillArgs(assetAbs)], {
      cwd: projectDir,
    });
    if (!run.ok) {
      failure = run;
      continue;
    }
    // Load-bearing, not belt-and-braces: seeking past EOF makes ffmpeg exit 0
    // and write NO file at all. The on-disk check is the real success signal;
    // trusting the exit code alone would ship short pieces with no PNG.
    if (await isNonEmptyFile(`${assetAbs}.png`)) return ok(`${assetAbs}.png`);
  }
  return (
    failure ?? err('ffmpeg-failed', `no frame could be extracted from "${assetAbs}" for a preview`)
  );
}

/**
 * Re-renders a parametric library piece with new variable values through
 * HyperFrames (HTML+GSAP → webm with alpha) and returns its project-relative
 * path. The template comes from the PROJECT's copy, never the global library:
 * the item there may have changed or been deleted since the import, and a
 * re-bake must reproduce the piece this project actually holds.
 *
 * The template is expected to be self-contained — sibling files of the library
 * item are not carried into the project, so a composition that references one
 * would render without it.
 */
export async function renderLibraryOverlay(
  projectDir: string,
  spec: LibraryOverlaySpec,
): Promise<Result<string>> {
  if (!LIBRARY_ITEM_ID_PATTERN.test(spec.itemId)) {
    return err('not-found', `invalid library item id "${spec.itemId}"`);
  }
  const assetDir = libraryAssetDir(spec.itemId);
  try {
    const template = await readFile(
      join(projectDir, assetDir, PROJECT_TEMPLATE_FILENAME),
      'utf8',
    ).catch(() => null);
    if (template === null) {
      return err('not-found', `"${spec.itemId}" has no template in this project to re-bake from`);
    }
    // A placeholder with no value would substitute to nothing and quietly bake
    // a piece with missing text, reported as a success.
    const missing = templatePlaceholders(template).filter(
      (name) => spec.variables[name] === undefined,
    );
    if (missing.length > 0) {
      return err(
        'not-found',
        `template of "${spec.itemId}" expects values this block does not carry: ${missing.join(', ')}`,
      );
    }
    // Import refuses these, but the project copy is a plain file an agent can
    // rewrite afterwards — re-check before spending a headless-Chrome render
    // on a piece whose text would come out visibly mangled.
    const unsafe = unsafePlaceholders(template);
    if (unsafe.length > 0) {
      return err(
        'not-found',
        `template of "${spec.itemId}" places ${unsafe.join(', ')} inside script/style or an unquoted attribute, where HTML escaping breaks the value`,
      );
    }

    const digest = bakeDigest(spec, template);
    const assetRel = `${assetDir}/bake-${digest}.webm`;
    const assetAbs = join(projectDir, assetRel);
    // Same item, same values, same template — the existing files ARE this
    // render. Companions count: a bake missing one (older Studio versions
    // wrote no webp) falls through and heals below without re-rendering.
    const present = await Promise.all(
      [assetAbs, `${assetAbs}.png`, `${assetAbs}.webp`].map(isNonEmptyFile),
    );
    if (present.every(Boolean)) return ok(assetRel);

    if (!present[0]) {
      // Digest + pid make the work dir private to this render: within a
      // process the job queue serializes bakes, and another Studio process on
      // the same project can neither clear this slot mid-render nor copy its
      // half-written render.webm into the content-addressed destination.
      const slot = join(
        projectDir,
        'edit',
        'assets',
        'src',
        `library-${spec.itemId}-${digest}-${String(process.pid)}`,
      );
      // A reused work dir would let a previous run's render.webm be copied out
      // as this one's result when the CLI exits without writing a new one.
      await rm(slot, { recursive: true, force: true });
      await mkdir(slot, { recursive: true });
      const values = Object.fromEntries(
        Object.entries(spec.variables).map(([name, value]) => [name, escapeHtml(value)]),
      );
      await writeFile(join(slot, 'index.html'), substituteTemplate(template, values));
      const render = await renderHyperframes(slot);
      if (!render.ok) return render;
      const rendered = join(slot, 'render.webm');
      if (!(await isNonEmptyFile(rendered))) {
        return err('hyperframes-failed', `HyperFrames produced no video for "${spec.itemId}"`);
      }
      await mkdir(join(projectDir, assetDir), { recursive: true });
      await cp(rendered, assetAbs);
    }

    // Chrome paints VP9-alpha webm as opaque black in <video>, so the live
    // player falls back to these companions. The PNG must be a SETTLED frame:
    // library pieces animate in AND out, so a frame near the end catches the
    // exit fade and reads as a broken bake.
    const still = await writeSettledStill(projectDir, assetAbs);
    if (!still.ok) return still;
    // Animated webp mirrors what an imported item carries, so a re-baked
    // block keeps a moving preview in the player instead of a frozen frame.
    // Best-effort: the player degrades to the PNG, and failing the bake here
    // would strand webm+png at this digest — every retry would skip the
    // render and die again on the same cosmetic step.
    const animated = await runFfmpeg(
      [
        '-y',
        '-c:v',
        'libvpx-vp9',
        '-i',
        assetAbs,
        '-vf',
        'scale=480:-2:flags=lanczos,fps=16',
        '-loop',
        '0',
        '-quality',
        '70',
        `${assetAbs}.webp`,
      ],
      { cwd: projectDir },
    );
    if (!animated.ok) {
      console.warn(`animated webp companion failed for ${assetRel}: ${animated.error.message}`);
    }
    return ok(assetRel);
  } catch (cause) {
    return err('io-failed', `failed to re-bake the library piece "${spec.itemId}"`, cause);
  }
}
