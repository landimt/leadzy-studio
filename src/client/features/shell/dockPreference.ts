import { type DockLayout, parseDockLayout, serializeDockLayout } from './dock.js';

export const DOCK_LAYOUT_STORAGE_KEY = 'leadzy-dock-layout';

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): PreferenceStorage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}

/** Storage access can throw in private or hardened browser contexts. */
export function readDockLayout(storage = browserStorage()): DockLayout {
  try {
    return parseDockLayout(storage?.getItem(DOCK_LAYOUT_STORAGE_KEY) ?? null);
  } catch {
    return parseDockLayout(null);
  }
}

/** The layout stays usable for the session even when persistence is unavailable. */
export function writeDockLayout(layout: DockLayout, storage = browserStorage()): void {
  try {
    storage?.setItem(DOCK_LAYOUT_STORAGE_KEY, serializeDockLayout(layout));
  } catch {
    return;
  }
}
