import { cp, copyFile, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { templatePlaceholders, unsafePlaceholders } from '../core/htmlTemplate.js';
import {
  LIBRARY_OVERLAY_TIMING_VARIABLES,
  libraryVariablesSchema,
  PROJECT_TEMPLATE_FILENAME,
  resolveVariableValues,
  sameLibraryVariables,
} from '../core/libraryItem.js';
import { containedPath, isInsideEditDir } from '../core/paths.js';
import { unwrap } from '../core/result.js';
import type { EditDoc, OverlayBlock, OverlayTrack } from '../core/schema.js';
import type { HistoryOrigin } from '../server/services/editHistory.js';
import type { EditWriter } from '../server/services/editWriter.js';
import type { probeMedia } from '../server/services/ffmpeg.js';
import {
  parseLibraryManifest,
  type LibraryItem,
  type OverlayLibrary,
} from '../server/services/library.js';
import type { renderLibraryOverlay } from '../server/services/libraryOverlay.js';

const round2 = (value: number): number => Math.round(value * 100) / 100;

async function pathIsFile(absolute: string): Promise<boolean> {
  try {
    return (await stat(absolute)).isFile();
  } catch {
    return false;
  }
}

// --- import ------------------------------------------------------------

export interface LibraryImportRequest {
  readonly id: string;
  /** Output time where the overlay block starts. */
  readonly at: number;
}

export interface LibraryImportDeps {
  readonly library: Pick<OverlayLibrary, 'list' | 'resolveFile'>;
  readonly editWriter: Pick<EditWriter, 'update'>;
  readonly probe: typeof probeMedia;
  /** Who is editing — the history keeps UI autosaves and agent edits apart. */
  readonly origin: HistoryOrigin;
}

export type LibraryImportErrorCode =
  | 'library_item_not_found'
  | 'library_template_missing'
  | 'library_template_mismatch'
  | 'library_template_unsafe';

export type LibraryImportOutcome =
  | { readonly ok: true; readonly hash: string; readonly file: string }
  | { readonly ok: false; readonly code: LibraryImportErrorCode; readonly message: string };

/**
 * Copies a library item (asset, preview companions, template) into
 * `edit/assets/library/<id>/` and appends an overlay block for it. A failed
 * commit removes the files it created.
 */
export async function importLibraryItem(
  projectDir: string,
  deps: LibraryImportDeps,
  request: LibraryImportRequest,
): Promise<LibraryImportOutcome> {
  const item = (await deps.library.list()).find((candidate) => candidate.id === request.id);
  const sourceFile = item ? await deps.library.resolveFile(item.id, item.file) : null;
  if (!item || !sourceFile) {
    return { ok: false, code: 'library_item_not_found', message: 'no library item with this id' };
  }

  // A parametric item whose template file is gone would import as a silently
  // static overlay, while the library card still advertises it as editable.
  const templateSource =
    item.template !== undefined ? await deps.library.resolveFile(item.id, item.template) : null;
  if (item.variables !== undefined && templateSource === null) {
    return {
      ok: false,
      code: 'library_template_missing',
      message: `template "${item.template ?? ''}" of this item was not found in the library`,
    };
  }

  // The manifest and the template are written as two separate files by an
  // external agent — nothing else guarantees they agree. An undeclared
  // placeholder would make every re-bake fail; a declared-but-unused name
  // would let an edit "apply" without changing anything on screen.
  if (item.variables !== undefined && templateSource !== null) {
    const templateBody = await readFile(templateSource, 'utf8');
    const placeholders = [...templatePlaceholders(templateBody)].sort();
    const declared = item.variables.map((variable) => variable.name).sort();
    if (
      placeholders.length !== declared.length ||
      placeholders.some((name, index) => name !== declared[index])
    ) {
      return {
        ok: false,
        code: 'library_template_mismatch',
        message:
          `the template and the manifest diverge — placeholders in the template: ` +
          `${placeholders.join(', ') || '(none)'}; declared variables: ${declared.join(', ')}`,
      };
    }
    const unsafe = unsafePlaceholders(templateBody);
    if (unsafe.length > 0) {
      return {
        ok: false,
        code: 'library_template_unsafe',
        message:
          `the template puts ${unsafe.join(', ')} inside script/style or an unquoted attribute, ` +
          `where HTML escaping would break the value`,
      };
    }
  }

  // per-item subfolder: ids and filenames can't collide into one another,
  // and a re-import overwrites only its own copy
  const destRel = `edit/assets/library/${item.id}/${item.file}`;
  const destAbs = join(projectDir, destRel);
  const copied: string[] = [];
  try {
    await mkdir(dirname(destAbs), { recursive: true });
    const existedBefore = await pathIsFile(destAbs);
    await copyFile(sourceFile, destAbs);
    if (!existedBefore) copied.push(destAbs);
    for (const extension of ['.png', '.webp']) {
      const companionSource = await deps.library.resolveFile(item.id, `${item.file}${extension}`);
      if (companionSource) {
        const companionExisted = await pathIsFile(`${destAbs}${extension}`);
        await copyFile(companionSource, `${destAbs}${extension}`);
        if (!companionExisted) copied.push(`${destAbs}${extension}`);
      }
    }

    // A parametric piece also brings its source template, under a FIXED name:
    // that is what lets a later re-bake work from the project alone, without
    // the global item it came from having to still exist and still match.
    const libraryRef =
      item.variables !== undefined
        ? { item: item.id, variables: resolveVariableValues(item.variables) }
        : null;
    if (templateSource !== null) {
      const templateDest = join(dirname(destAbs), PROJECT_TEMPLATE_FILENAME);
      const templateExisted = await pathIsFile(templateDest);
      await copyFile(templateSource, templateDest);
      if (!templateExisted) copied.push(templateDest);
    }

    // without position/scale an overlay renders FULLSCREEN-stretched — size
    // the block to the asset's real pixel width relative to the output
    const probe = await deps.probe(sourceFile);
    const assetWidth = probe.ok ? probe.value.width : null;
    const hash = await deps.editWriter.update((doc) => {
      const scale = assetWidth
        ? Math.max(0.05, round2(Math.min(1, assetWidth / doc.output.width)))
        : 0.5;
      const position =
        item.kind === 'cta'
          ? { x: round2(Math.max(0, (1 - scale) / 2)), y: 0.38 }
          : ('bottom-left' as const);
      const block = {
        file: destRel,
        at: round2(request.at),
        duration: item.durationS ?? 4,
        position,
        scale,
        ...(libraryRef !== null ? { library: libraryRef } : {}),
      };
      const overlayTrack = doc.tracks.find(
        (track): track is OverlayTrack => track.kind === 'overlay',
      );
      const tracks = overlayTrack
        ? doc.tracks.map((track) =>
            track === overlayTrack ? { ...track, blocks: [...track.blocks, block] } : track,
          )
        : [...doc.tracks, { id: 'overlays', kind: 'overlay' as const, blocks: [block] }];
      return { ...doc, tracks };
    }, deps.origin);
    return { ok: true, hash, file: destRel };
  } catch (cause) {
    // a failed commit must not leave orphan assets we just created
    for (const file of copied) {
      await rm(file, { force: true }).catch(() => undefined);
    }
    throw cause;
  }
}

// --- re-bake -----------------------------------------------------------

export interface LibraryRebakeRequest {
  readonly trackId: string;
  readonly blockIndex: number;
  /** The block's current file — identity, so a shifted index cannot retarget the bake. */
  readonly file: string;
  /**
   * The block's current `at`. Twins (the same import placed twice) share the
   * file — without the position, an index shift that lands the OTHER twin at
   * `blockIndex` would satisfy file identity and rewrite it. Optional so
   * agent-authored calls keep working; when absent, twins are only protected
   * by the fallback's ambiguity refusal.
   */
  readonly at?: number | undefined;
  readonly variables: Readonly<Record<string, string>>;
}

export type LibraryRebakeErrorCode =
  | 'library_block_not_found'
  | 'invalid_variables'
  | 'variables_mismatch'
  | 'timing_variable_conflict'
  | 'timing_out_of_range';

export interface LibraryRebakePlan {
  readonly itemId: string;
  readonly initialVariablesSnapshot: Readonly<Record<string, string>> | undefined;
  /** The requested value of the piece's single timing variable, when it has one. */
  readonly requestedTimingS: number | null;
}

export type LibraryRebakePreparation =
  | { readonly ok: true; readonly plan: LibraryRebakePlan }
  | { readonly ok: false; readonly code: LibraryRebakeErrorCode; readonly message: string };

interface LocatedBlock {
  readonly track: OverlayTrack;
  readonly block: OverlayBlock;
  readonly blockIndex: number;
}

/**
 * Returns the TRACK by reference, not just the block: the schema does not
 * forbid two overlay tracks sharing an id, and a rewrite keyed on the id
 * would edit `blocks[blockIndex]` in every one of them.
 */
export function locateLibraryBlock(
  doc: EditDoc,
  request: Pick<LibraryRebakeRequest, 'trackId' | 'blockIndex' | 'file' | 'at'>,
): LocatedBlock | undefined {
  const track = doc.tracks.find(
    (candidate): candidate is OverlayTrack =>
      candidate.kind === 'overlay' && candidate.id === request.trackId,
  );
  if (track === undefined) return undefined;
  const exact = track.blocks[request.blockIndex];
  if (
    exact?.file === request.file &&
    exact.library !== undefined &&
    (request.at === undefined || exact.at === request.at)
  ) {
    return { track, block: exact, blockIndex: request.blockIndex };
  }
  // The index goes stale the moment another block on this track is added
  // or removed while HyperFrames renders (minutes). The file name is
  // content-addressed and carries the library ref — when exactly ONE
  // block still matches file AND position, that IS the block whose values
  // were edited. The `at` filter is load-bearing: twins share the file,
  // so a lone surviving twin at ANOTHER position must NOT inherit this
  // bake. Ambiguity keeps the strict failure — guessing between matches
  // could rewrite the wrong one.
  const matches = track.blocks
    .map((block, index) => ({ block, index }))
    .filter(
      ({ block }) =>
        block.file === request.file &&
        block.library !== undefined &&
        (request.at === undefined || block.at === request.at),
    );
  const only = matches.length === 1 ? matches[0] : undefined;
  return only === undefined ? undefined : { track, block: only.block, blockIndex: only.index };
}

/** Everything that can be refused before HyperFrames runs, decided on the document as it is now. */
export function prepareLibraryRebake(
  doc: EditDoc,
  request: LibraryRebakeRequest,
): LibraryRebakePreparation {
  // The same limits the route enforces on its body: values end up in an HTML
  // template and in the document, and a HyperFrames render takes minutes.
  const validVariables = libraryVariablesSchema.safeParse(request.variables);
  if (!validVariables.success) {
    return {
      ok: false,
      code: 'invalid_variables',
      message: `variables must be at most 8 entries of up to 120 characters without control characters: ${validVariables.error.issues.map((issue) => issue.message).join('; ')}`,
    };
  }
  const target = locateLibraryBlock(doc, request);
  if (!target?.block.library) {
    return {
      ok: false,
      code: 'library_block_not_found',
      message: 'no library block at this position',
    };
  }
  const itemId = target.block.library.item;
  const initialVariablesSnapshot =
    target.block.library.variables === undefined
      ? undefined
      : { ...target.block.library.variables };
  // Re-baking is editing the values this block already has, not defining a
  // new set: an unknown or missing name would substitute to nothing and bake
  // a piece with blank text.
  const known = Object.keys(target.block.library.variables ?? {}).sort();
  const posted = Object.keys(request.variables).sort();
  if (known.length !== posted.length || known.some((name, i) => name !== posted[i])) {
    return {
      ok: false,
      code: 'variables_mismatch',
      message: `variables must be exactly: ${known.join(', ') || '(none)'}`,
    };
  }
  const timingVariableNames = Object.keys(LIBRARY_OVERLAY_TIMING_VARIABLES).filter((name) =>
    known.includes(name),
  );
  if (timingVariableNames.length > 1) {
    return {
      ok: false,
      code: 'timing_variable_conflict',
      message: `the piece must use a single timing variable: ${timingVariableNames.join(', ')}`,
    };
  }
  const timingVariableName = timingVariableNames[0];
  const timingBounds =
    timingVariableName === undefined
      ? undefined
      : LIBRARY_OVERLAY_TIMING_VARIABLES[timingVariableName];
  const requestedTimingS =
    timingVariableName === undefined ? null : Number(request.variables[timingVariableName]);
  if (
    requestedTimingS !== null &&
    timingBounds !== undefined &&
    (!Number.isFinite(requestedTimingS) ||
      requestedTimingS < timingBounds.min ||
      requestedTimingS > timingBounds.max)
  ) {
    return {
      ok: false,
      code: 'timing_out_of_range',
      message:
        `${String(timingVariableName)} must be a finite number between ` +
        `${String(timingBounds.min)} and ${String(timingBounds.max)} seconds`,
    };
  }
  return { ok: true, plan: { itemId, initialVariablesSnapshot, requestedTimingS } };
}

export interface LibraryRebakeDeps {
  readonly editWriter: Pick<EditWriter, 'update'>;
  /** Production measures a duration-parametric overlay through ffprobe; tests inject a stub. */
  readonly probe: typeof probeMedia;
  readonly render: typeof renderLibraryOverlay;
  readonly origin: HistoryOrigin;
}

/**
 * Renders the piece with the new values and points the block at the bake.
 * Throws when the block moved or its values changed meanwhile — the caller
 * (a job, or the CLI) reports that as a failure to retry.
 */
export async function applyLibraryRebake(
  projectDir: string,
  deps: LibraryRebakeDeps,
  plan: LibraryRebakePlan,
  request: LibraryRebakeRequest,
): Promise<{ readonly file: string; readonly hash: string }> {
  const assetRel = unwrap(
    await deps.render(projectDir, { itemId: plan.itemId, variables: request.variables }),
  );
  let measuredDurationS: number | null = null;
  if (plan.requestedTimingS !== null) {
    if (!isInsideEditDir(assetRel)) {
      throw new Error(`the bake returned a file outside edit/: "${assetRel}"`);
    }
    measuredDurationS = unwrap(
      await deps.probe(unwrap(containedPath(projectDir, assetRel))),
    ).durationS;
  }
  const hash = await deps.editWriter.update((doc) => {
    // The document is re-read under the lock: an agent may have rewritten
    // it while HyperFrames ran. Failing here beats reporting success for a
    // bake that landed nowhere, or writing it over an unrelated block. The
    // baked files stay behind on purpose — a retry with the same values
    // reuses them instead of rendering again.
    const current = locateLibraryBlock(doc, request);
    if (current === undefined || current.block.library?.item !== plan.itemId) {
      throw new Error(
        'the block moved while the piece was rendering — nothing was applied; try again',
      );
    }
    if (!sameLibraryVariables(current.block.library.variables, plan.initialVariablesSnapshot)) {
      throw new Error(
        "the block's variables changed while the piece was rendering — nothing was applied; try again",
      );
    }
    const tracks = doc.tracks.map((candidate) => {
      if (candidate !== current.track) return candidate;
      return {
        ...current.track,
        blocks: current.track.blocks.map((block, index) =>
          index === current.blockIndex
            ? {
                ...block,
                file: assetRel,
                ...(measuredDurationS !== null ? { duration: measuredDurationS } : {}),
                library: { item: plan.itemId, variables: request.variables },
              }
            : block,
        ),
      };
    });
    return { ...doc, tracks };
  }, deps.origin);
  return { file: assetRel, hash };
}

/** `KEY=value` pairs from the command line; a name without `=` or a repeated name is refused. */
export function parseVariableAssignments(
  assignments: readonly string[],
):
  | { readonly ok: true; readonly variables: Record<string, string> }
  | { readonly ok: false; readonly message: string } {
  const variables: Record<string, string> = {};
  for (const assignment of assignments) {
    const separator = assignment.indexOf('=');
    if (separator <= 0) {
      return { ok: false, message: `expected NAME=value, got "${assignment}"` };
    }
    const name = assignment.slice(0, separator);
    if (Object.hasOwn(variables, name)) {
      return { ok: false, message: `variable "${name}" given twice` };
    }
    variables[name] = assignment.slice(separator + 1);
  }
  return { ok: true, variables };
}

// --- add -------------------------------------------------------------

export type LibraryAddOutcome =
  | { readonly ok: true; readonly item: LibraryItem }
  | { readonly ok: false; readonly message: string };

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Copies a whole item folder into the library. The manifest is validated
 * with the library's own rules BEFORE anything is copied, the destination
 * must not exist yet (a folder already there — listable or not — is never
 * merged into or removed), and after the copy the asset, the template and
 * the preview companions must resolve; otherwise the copy `add` made is
 * removed again, so the library never holds a broken card.
 */
export async function addLibraryItem(
  library: Pick<OverlayLibrary, 'list' | 'resolveFile' | 'baseDir'>,
  itemFolder: string,
): Promise<LibraryAddOutcome> {
  const source = await realpath(itemFolder).catch(() => null);
  if (source === null) return { ok: false, message: `"${itemFolder}" does not exist` };
  const id = basename(source);
  const manifestRaw = await readFile(join(source, 'item.json'), 'utf8').catch(() => null);
  if (manifestRaw === null) return { ok: false, message: `no item.json in "${source}"` };
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestRaw);
  } catch {
    return { ok: false, message: 'item.json is not valid JSON' };
  }
  const manifest = parseLibraryManifest(manifestJson);
  if (!manifest.ok) return { ok: false, message: `item.json: ${manifest.message}` };
  if (manifest.manifest.id !== id) {
    return {
      ok: false,
      message: `item.json id "${manifest.manifest.id}" must equal the folder name "${id}"`,
    };
  }
  const target = join(library.baseDir, id);
  if (await exists(target)) {
    return {
      ok: false,
      message: `library already has a folder "${id}" — remove it first (studio never merges into or deletes an existing item)`,
    };
  }
  await mkdir(library.baseDir, { recursive: true });
  await cp(source, target, { recursive: true, dereference: true });

  const required = [manifest.manifest.file, manifest.manifest.template].filter(
    (name): name is string => name !== undefined,
  );
  const missing: string[] = [];
  for (const name of required) {
    if ((await library.resolveFile(id, name)) === null) missing.push(name);
  }
  const item = (await library.list()).find((candidate) => candidate.id === id);
  if (missing.length > 0 || item === undefined) {
    await rm(target, { recursive: true, force: true });
    return {
      ok: false,
      message:
        missing.length > 0
          ? `the item folder is missing ${missing.map((name) => `"${name}"`).join(', ')} — nothing was added`
          : 'the folder was refused by the library — nothing was added',
    };
  }
  return { ok: true, item };
}
