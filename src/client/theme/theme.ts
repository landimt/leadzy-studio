export type StudioTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'leadzy-studio-theme';

interface ThemeTarget {
  readonly dataset: { theme?: string };
}

interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isStudioTheme(value: unknown): value is StudioTheme {
  return value === 'light' || value === 'dark';
}

export function nextTheme(theme: StudioTheme): StudioTheme {
  return theme === 'dark' ? 'light' : 'dark';
}

/** Reads the painted theme first, then storage. Safe in the node test environment. */
export function readTheme(target?: ThemeTarget, storage?: ThemeStorage): StudioTheme {
  const resolvedTarget =
    target ?? (typeof document === 'undefined' ? undefined : document.documentElement);
  if (isStudioTheme(resolvedTarget?.dataset.theme)) return resolvedTarget.dataset.theme;

  const resolvedStorage =
    storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
  const stored = resolvedStorage?.getItem(THEME_STORAGE_KEY);
  return isStudioTheme(stored) ? stored : 'light';
}

/** One write path keeps React, the first paint and the persisted preference aligned. */
export function applyTheme(theme: StudioTheme, target?: ThemeTarget, storage?: ThemeStorage): void {
  const resolvedTarget =
    target ?? (typeof document === 'undefined' ? undefined : document.documentElement);
  const resolvedStorage =
    storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
  if (resolvedTarget) resolvedTarget.dataset.theme = theme;
  resolvedStorage?.setItem(THEME_STORAGE_KEY, theme);
}
