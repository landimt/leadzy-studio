import type { SettingsPreferences } from '../../api.js';

/** What the dialog remembers per project after an export — the last delivery choice. */
export interface ExportDeliveryChoice {
  readonly mode: 'project' | 'folder';
  readonly directory: string;
  readonly pattern: string;
  readonly reveal: boolean;
}

const STORAGE_PREFIX = 'leadzy-export-delivery:';

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): PreferenceStorage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}

type DeliveryPreferences = Pick<
  SettingsPreferences,
  'exportMode' | 'exportDirectory' | 'exportFilenamePattern' | 'revealAfterExport'
>;

/** The starting choice: the global preferences, unless this project exported before. */
export function initialDeliveryChoice(
  projectDir: string,
  preferences: DeliveryPreferences,
  storage = browserStorage(),
): ExportDeliveryChoice {
  const fromPreferences: ExportDeliveryChoice = {
    mode: preferences.exportMode === 'project' ? 'project' : 'folder',
    directory: preferences.exportDirectory ?? '',
    pattern: preferences.exportFilenamePattern,
    reveal: preferences.revealAfterExport,
  };
  try {
    const raw = storage?.getItem(STORAGE_PREFIX + projectDir);
    if (raw === null || raw === undefined) return fromPreferences;
    const parsed = JSON.parse(raw) as Partial<ExportDeliveryChoice>;
    return {
      mode:
        parsed.mode === 'folder' || parsed.mode === 'project' ? parsed.mode : fromPreferences.mode,
      directory:
        typeof parsed.directory === 'string' ? parsed.directory : fromPreferences.directory,
      pattern:
        typeof parsed.pattern === 'string' && parsed.pattern.trim() !== ''
          ? parsed.pattern
          : fromPreferences.pattern,
      reveal: typeof parsed.reveal === 'boolean' ? parsed.reveal : fromPreferences.reveal,
    };
  } catch {
    return fromPreferences;
  }
}

/** Remembering is a courtesy: storage that refuses never blocks an export. */
export function rememberDeliveryChoice(
  projectDir: string,
  choice: ExportDeliveryChoice,
  storage = browserStorage(),
): void {
  try {
    storage?.setItem(STORAGE_PREFIX + projectDir, JSON.stringify(choice));
  } catch {
    return;
  }
}
