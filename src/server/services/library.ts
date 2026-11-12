import { randomBytes } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { z } from 'zod';

import { LIBRARY_ITEM_KINDS } from '../../core/libraryKinds.js';
import {
  libraryVariableNameSchema,
  libraryVariableValueSchema,
  LIBRARY_ITEM_ID_PATTERN,
  MAX_LIBRARY_VARIABLES,
  PROJECT_TEMPLATE_FILENAME,
} from '../../core/libraryItem.js';

// `basename` returns "." and ".." unchanged, so the round-trip check alone
// would accept both as "plain filenames".
const plainFilename = (label: string) =>
  z
    .string()
    .min(1)
    .refine(
      (value) => basename(value) === value && value !== '.' && value !== '..',
      `${label} must be a plain filename, no path separators`,
    );

const variableSchema = z
  .object({
    name: libraryVariableNameSchema,
    label: z.string().max(40).optional(),
    default: libraryVariableValueSchema,
  })
  .strict();

const manifestSchema = z
  .object({
    id: z.string().regex(LIBRARY_ITEM_ID_PATTERN, 'invalid library item id'),
    name: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[^\u0000-\u001f\u007f]+$/u, 'name cannot contain control characters'),
    kind: z.enum(LIBRARY_ITEM_KINDS),
    file: plainFilename('file'),
    durationS: z.number().positive().optional(),
    tags: z.array(z.string().min(1)).optional(),
    createdAt: z.string().min(1),
    /** One line of "when to use this piece", for the human grid and the agent prompt. */
    description: z
      .string()
      .min(1)
      .max(200)
      .regex(/^\P{Cc}+$/u, 'description cannot contain control characters')
      .optional(),
    /** HyperFrames composition inside the item folder, with `{{NAME}}` placeholders. */
    template: plainFilename('template').optional(),
    variables: z
      .array(variableSchema)
      .min(1)
      .max(MAX_LIBRARY_VARIABLES)
      .refine(
        (variables) =>
          new Set(variables.map((variable) => variable.name)).size === variables.length,
        'variable names must be unique',
      )
      .optional(),
  })
  .strict()
  .refine((manifest) => manifest.variables === undefined || manifest.template !== undefined, {
    message: 'variables require a template to substitute them into',
  })
  // Import copies the asset AND the template into one project folder, the
  // template under a fixed name — an item whose asset claims either name would
  // have the two overwrite each other there.
  .refine(
    (manifest) =>
      manifest.template === undefined ||
      (manifest.file !== manifest.template && manifest.file !== PROJECT_TEMPLATE_FILENAME),
    { message: `file must differ from template and from "${PROJECT_TEMPLATE_FILENAME}"` },
  );

type LibraryManifest = z.infer<typeof manifestSchema>;

/** The same rules `list()` applies to every folder, for callers that must know before copying. */
export function parseLibraryManifest(
  raw: unknown,
): { ok: true; manifest: LibraryManifest } | { ok: false; message: string } {
  const parsed = manifestSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, manifest: parsed.data }
    : {
        ok: false,
        message: parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      };
}

export type LibraryItem = LibraryManifest & {
  readonly hasPreview: boolean;
  /** Best preview filename inside the item folder: animated webp > frozen png > the file itself when displayable. */
  readonly preview: string | null;
};

export interface SaveFromOptions {
  readonly name: string;
  /** Unvalidated — narrowed against `LIBRARY_ITEM_KINDS` inside `saveFrom`. */
  readonly kind: string;
  readonly durationS?: number;
}

function defaultLibraryDir(): string {
  return process.env.LEADZY_LIBRARY_DIR ?? join(homedir(), '.leadzy-studio', 'library');
}

function slugOf(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'item'
  );
}

function randomSuffix(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(randomBytes(4), (byte) => alphabet[byte % alphabet.length]).join('');
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Chrome paints VP9-alpha webm as opaque black, so previews come from a
 * companion: `<file>.webp` (animated, alpha) when present, else `<file>.png`
 * (frozen frame), else the file itself when it is already an image.
 */
async function previewFileFor(itemDir: string, file: string): Promise<string | null> {
  if (await pathExists(join(itemDir, `${file}.webp`))) return `${file}.webp`;
  if (await pathExists(join(itemDir, `${file}.png`))) return `${file}.png`;
  const lower = file.toLowerCase();
  if (lower.endsWith('.png') || lower.endsWith('.webp')) return file;
  return null;
}

/**
 * Personal overlay library — lower thirds, CTAs, outros, stickers, title
 * cards — shared across every project at `~/.leadzy-studio/library/`. Each
 * item is a folder `<id>/` holding `item.json` plus its asset file(s).
 * Items may also be written directly by AI agents, not only through this
 * class, so every read validates the manifest before trusting it.
 */
export class OverlayLibrary {
  readonly baseDir: string;

  constructor(baseDir: string = defaultLibraryDir()) {
    this.baseDir = baseDir;
  }

  /** Newest first. A folder with a missing, invalid, or mismatched manifest is skipped with a warning. */
  async list(): Promise<LibraryItem[]> {
    const entries = await readdir(this.baseDir, { withFileTypes: true }).catch(() => []);
    const items: LibraryItem[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const item = await this.readItem(entry.name);
      if (item) items.push(item);
    }
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Resolves `filename` inside item `id`'s folder, symlink-safe. Returns
   * null if `id` or `filename` is malformed, or the resolved path escapes
   * the LIBRARY ROOT, or nothing exists there.
   */
  async resolveFile(id: string, filename: string): Promise<string | null> {
    if (!LIBRARY_ITEM_ID_PATTERN.test(id)) return null;
    if (filename.length === 0 || basename(filename) !== filename) return null;
    const itemDir = join(this.baseDir, id);
    try {
      const real = await realpath(join(itemDir, filename));
      // confine against the LIBRARY root, not the item folder — an item dir
      // that is itself a symlink would otherwise relocate the fence
      const realBase = await realpath(this.baseDir);
      if (!real.startsWith(`${realBase}${sep}`)) return null;
      if (!(await stat(real)).isFile()) return null;
      return real;
    } catch {
      return null;
    }
  }

  /** Copies `absSourceFile` (+ its `.png`/`.webp` companions, if present) into a new library item. */
  async saveFrom(absSourceFile: string, options: SaveFromOptions): Promise<LibraryItem> {
    const id = `${slugOf(options.name)}-${randomSuffix()}`;
    const file = basename(absSourceFile);
    const candidate: unknown = {
      id,
      name: options.name,
      kind: options.kind,
      file,
      createdAt: new Date().toISOString(),
      ...(options.durationS !== undefined ? { durationS: options.durationS } : {}),
    };
    const parsed = manifestSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new Error(`invalid library item: ${parsed.error.message}`);
    }

    const itemDir = join(this.baseDir, id);
    // mkdir({recursive:true}) does not fail on an existing directory — without
    // this check, a random-suffix collision would silently overwrite files
    // inside an unrelated item instead of erroring.
    if (await pathExists(itemDir)) {
      throw new Error(`library item id collision: "${id}" — retry the save`);
    }
    try {
      await mkdir(itemDir, { recursive: true });
      await copyFile(absSourceFile, join(itemDir, file));
      for (const extension of ['.png', '.webp']) {
        const companionSource = `${absSourceFile}${extension}`;
        if (await pathExists(companionSource)) {
          await copyFile(companionSource, join(itemDir, `${file}${extension}`));
        }
      }
      await this.writeManifest(itemDir, parsed.data);
    } catch (cause) {
      // A source file vanishing mid-copy, a full disk, a permission error —
      // whatever the cause, a half-written item folder must not survive it
      // (list() would otherwise pile up manifest-less directories over time).
      await rm(itemDir, { recursive: true, force: true }).catch(() => undefined);
      throw cause;
    }
    const preview = await previewFileFor(itemDir, file);
    return { ...parsed.data, hasPreview: preview !== null, preview };
  }

  /**
   * Deletes item `id`'s folder permanently — there is no trash and no undo,
   * which is why the UI double-confirms before calling this. Projects that
   * already imported the piece keep their copies AND their re-bakes (the
   * asset and the template both travel with the import); only future imports
   * of this item stop working. Returns false when nothing exists to remove.
   * A folder with a broken manifest is still removable — the whole point of
   * deletion is cleaning up.
   */
  async remove(id: string): Promise<boolean> {
    if (!LIBRARY_ITEM_ID_PATTERN.test(id)) return false;
    const itemDir = join(this.baseDir, id);
    let entry;
    try {
      entry = await lstat(itemDir);
    } catch {
      return false;
    }
    // An item dir that is a symlink gets unlinked, never followed — rm would
    // otherwise wipe whatever tree the link points at outside the library.
    if (entry.isSymbolicLink()) {
      await rm(itemDir);
      return true;
    }
    if (!entry.isDirectory()) return false;
    await rm(itemDir, { recursive: true });
    return true;
  }

  private async readItem(id: string): Promise<LibraryItem | null> {
    const itemDir = join(this.baseDir, id);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(itemDir, 'item.json'), 'utf8'));
    } catch (cause) {
      console.warn(`overlay library: skipping "${id}" — cannot read item.json`, cause);
      return null;
    }
    const parsed = manifestSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(
        `overlay library: skipping "${id}" — invalid item.json: ${parsed.error.message}`,
      );
      return null;
    }
    if (parsed.data.id !== id) {
      console.warn(
        `overlay library: skipping "${id}" — item.json id "${parsed.data.id}" does not match its folder`,
      );
      return null;
    }
    const preview = await previewFileFor(itemDir, parsed.data.file);
    return { ...parsed.data, hasPreview: preview !== null, preview };
  }

  private async writeManifest(itemDir: string, manifest: LibraryManifest): Promise<void> {
    const path = join(itemDir, 'item.json');
    const tmpPath = `${path}.tmp`;
    await writeFile(tmpPath, JSON.stringify(manifest, null, 2) + '\n');
    await rename(tmpPath, path);
  }
}
