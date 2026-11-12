import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';

const CONFIG_FILE_MODE = 0o600;

export const ELEVEN_LABS_API_KEY_SCHEMA = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[^\s\p{Cc}]+$/u, 'must not contain whitespace or control characters');

const MAX_DIRECTORY_PATH_LENGTH = 4096;

export const DIRECTORY_PREFERENCE_SCHEMA = z
  .string()
  .min(1)
  .max(MAX_DIRECTORY_PATH_LENGTH)
  .refine(isAbsolute, 'must be an absolute path');

export const EXPORT_FILENAME_PATTERN_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[^\p{Cc}\r\n]+$/u, 'must not contain control characters or newlines');

const exportModeSchema = z.enum(['project', 'folder', 'ask']);
const localeSchema = z.enum(['pt-BR', 'en']);

export interface UserPreferences {
  readonly locale: 'pt-BR' | 'en';
  readonly defaultProjectDir: string | null;
  readonly exportMode: 'project' | 'folder' | 'ask';
  readonly exportDirectory: string | null;
  readonly exportFilenamePattern: string;
  readonly revealAfterExport: boolean;
}

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  locale: 'pt-BR',
  defaultProjectDir: null,
  exportMode: 'project',
  exportDirectory: null,
  exportFilenamePattern: '{project}',
  revealAfterExport: false,
};

/** The API accepts only the preferences a caller intends to change. */
export const USER_PREFERENCES_PATCH_SCHEMA = z.object({
  locale: localeSchema.optional(),
  defaultProjectDir: z.union([DIRECTORY_PREFERENCE_SCHEMA, z.null()]).optional(),
  exportMode: exportModeSchema.optional(),
  exportDirectory: z.union([DIRECTORY_PREFERENCE_SCHEMA, z.null()]).optional(),
  exportFilenamePattern: EXPORT_FILENAME_PATTERN_SCHEMA.optional(),
  revealAfterExport: z.boolean().optional(),
});

export type UserPreferencesPatch = z.infer<typeof USER_PREFERENCES_PATCH_SCHEMA>;

const storedConfigSchema = z
  .object({
    elevenLabsApiKey: ELEVEN_LABS_API_KEY_SCHEMA.optional(),
    locale: localeSchema.optional(),
    defaultProjectDir: DIRECTORY_PREFERENCE_SCHEMA.optional(),
    exportMode: exportModeSchema.optional(),
    exportDirectory: DIRECTORY_PREFERENCE_SCHEMA.optional(),
    exportFilenamePattern: EXPORT_FILENAME_PATTERN_SCHEMA.optional(),
    revealAfterExport: z.boolean().optional(),
  })
  // A field a previous build wrote (a removed preference) must not cost the
  // user the stored key: unknown keys are dropped, and the next write forgets them.
  .strip();

export type StoredConfig = z.infer<typeof storedConfigSchema>;

function defaultConfigDir(): string {
  return process.env.LEADZY_CONFIG_DIR ?? join(homedir(), '.leadzy-studio');
}

function isEnoent(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}

/**
 * Per-machine user settings — API keys entered through the UI, shared across
 * every project at `~/.leadzy-studio/config.json`. Mirrors OverlayLibrary's
 * baseDir/env-override pattern (services/library.ts): the key never leaves
 * this process except as `present`/`source`/`maskedTail` — never logged, never
 * echoed back whole, never included in an error message.
 */
export class UserConfig {
  private readonly baseDir: string;

  constructor(baseDir: string = defaultConfigDir()) {
    this.baseDir = baseDir;
  }

  private get configPath(): string {
    return join(this.baseDir, 'config.json');
  }

  /**
   * A missing file is the ordinary first-run state (nobody configured a key
   * yet) and stays silent. A file that exists but can't be trusted — bad
   * permissions, invalid JSON, a shape that fails validation — warns and
   * falls back to `{}` without ever printing its content, since it may hold
   * a partially-written key.
   */
  async read(): Promise<StoredConfig> {
    let raw: string;
    try {
      raw = await readFile(this.configPath, 'utf8');
    } catch (cause) {
      if (!isEnoent(cause)) {
        console.warn('user config: could not read config.json — treating as empty', cause);
      }
      return {};
    }

    let candidate: unknown;
    try {
      candidate = JSON.parse(raw);
    } catch {
      console.warn('user config: config.json is not valid JSON — treating as empty');
      return {};
    }

    const parsed = storedConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      console.warn(
        `user config: config.json failed validation — treating as empty (${parsed.error.message})`,
      );
      return {};
    }
    return parsed.data;
  }

  /** `null` or `''` removes the key. A malformed key throws instead of writing — same contract as OverlayLibrary.saveFrom. */
  async setElevenLabsKey(key: string | null): Promise<void> {
    const current = await this.read();
    const next: StoredConfig = { ...current };
    if (key === null || key === '') {
      delete next.elevenLabsApiKey;
    } else {
      const parsed = ELEVEN_LABS_API_KEY_SCHEMA.safeParse(key);
      if (!parsed.success) {
        throw new Error(`invalid user config: ${parsed.error.message}`);
      }
      next.elevenLabsApiKey = parsed.data;
    }
    await this.write(next);
  }

  async elevenLabsKey(): Promise<string | undefined> {
    return (await this.read()).elevenLabsApiKey;
  }

  /** Returns the complete, resolved preference set without changing old config files. */
  async preferences(): Promise<UserPreferences> {
    const stored = await this.read();
    return {
      locale: stored.locale ?? DEFAULT_USER_PREFERENCES.locale,
      defaultProjectDir: stored.defaultProjectDir ?? DEFAULT_USER_PREFERENCES.defaultProjectDir,
      exportMode: stored.exportMode ?? DEFAULT_USER_PREFERENCES.exportMode,
      exportDirectory: stored.exportDirectory ?? DEFAULT_USER_PREFERENCES.exportDirectory,
      exportFilenamePattern:
        stored.exportFilenamePattern ?? DEFAULT_USER_PREFERENCES.exportFilenamePattern,
      revealAfterExport: stored.revealAfterExport ?? DEFAULT_USER_PREFERENCES.revealAfterExport,
    };
  }

  /**
   * Merges one or more preferences into config.json. Directory nulls mean
   * "return to default" and are deliberately omitted on disk.
   */
  async setPreferences(patch: UserPreferencesPatch): Promise<UserPreferences> {
    const parsed = USER_PREFERENCES_PATCH_SCHEMA.safeParse(patch);
    if (!parsed.success) {
      throw new Error(`invalid user preferences: ${parsed.error.message}`);
    }

    const current = await this.read();
    const next: StoredConfig = { ...current };
    const preferences = parsed.data;

    if (preferences.locale !== undefined) next.locale = preferences.locale;
    if (preferences.defaultProjectDir !== undefined) {
      if (preferences.defaultProjectDir === null) delete next.defaultProjectDir;
      else next.defaultProjectDir = preferences.defaultProjectDir;
    }
    if (preferences.exportMode !== undefined) next.exportMode = preferences.exportMode;
    if (preferences.exportDirectory !== undefined) {
      if (preferences.exportDirectory === null) delete next.exportDirectory;
      else next.exportDirectory = preferences.exportDirectory;
    }
    if (preferences.exportFilenamePattern !== undefined) {
      next.exportFilenamePattern = preferences.exportFilenamePattern;
    }
    if (preferences.revealAfterExport !== undefined) {
      next.revealAfterExport = preferences.revealAfterExport;
    }

    await this.write(next);
    return this.resolvePreferences(next);
  }

  private resolvePreferences(stored: StoredConfig): UserPreferences {
    return {
      locale: stored.locale ?? DEFAULT_USER_PREFERENCES.locale,
      defaultProjectDir: stored.defaultProjectDir ?? DEFAULT_USER_PREFERENCES.defaultProjectDir,
      exportMode: stored.exportMode ?? DEFAULT_USER_PREFERENCES.exportMode,
      exportDirectory: stored.exportDirectory ?? DEFAULT_USER_PREFERENCES.exportDirectory,
      exportFilenamePattern:
        stored.exportFilenamePattern ?? DEFAULT_USER_PREFERENCES.exportFilenamePattern,
      revealAfterExport: stored.revealAfterExport ?? DEFAULT_USER_PREFERENCES.revealAfterExport,
    };
  }

  private async write(config: StoredConfig): Promise<void> {
    await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    const path = this.configPath;
    const tmpPath = `${path}.tmp`;
    await writeFile(tmpPath, JSON.stringify(config, null, 2) + '\n', { mode: CONFIG_FILE_MODE });
    // writeFile's `mode` only applies on CREATION: a leftover tmp from an
    // interrupted write keeps its old (possibly wider) mode — chmod closes it.
    await chmod(tmpPath, CONFIG_FILE_MODE);
    await rename(tmpPath, path);
  }
}

function elevenLabsApiKey(): string | undefined {
  const key = process.env.ELEVENLABS_API_KEY;
  return key !== undefined && key.length > 0 ? key : undefined;
}

export type ApiKeySource = 'env' | 'config';

/**
 * Env (including the repo `.env`, already loaded into `process.env` by
 * `loadDotEnv` at boot) always wins over the UI-managed config.json — a key
 * an operator pins via the environment must not be silently shadowed by
 * whatever a user later saves through the settings UI. Reads config.json
 * fresh on every call (no cache): saving a new key through the UI must take
 * effect on the very next job it's used in.
 */
export async function resolveElevenLabsApiKey(): Promise<{
  key: string | undefined;
  source: ApiKeySource | null;
}> {
  const envKey = elevenLabsApiKey();
  if (envKey !== undefined) return { key: envKey, source: 'env' };

  const configKey = await new UserConfig().elevenLabsKey();
  if (configKey !== undefined) return { key: configKey, source: 'config' };

  return { key: undefined, source: null };
}
