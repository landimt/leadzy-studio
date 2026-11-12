import { describe, expect, it } from 'vitest';
import { DEFAULT_DOCK_LAYOUT, moveTab } from './dock.js';
import { DOCK_LAYOUT_STORAGE_KEY, readDockLayout, writeDockLayout } from './dockPreference.js';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    data,
  };
}

describe('dock layout preference', () => {
  it('writes and reads the layout back', () => {
    const storage = memoryStorage();
    const moved = moveTab(DEFAULT_DOCK_LAYOUT, 'cuts', 'workspace', 0);

    writeDockLayout(moved, storage);

    expect(storage.data.has(DOCK_LAYOUT_STORAGE_KEY)).toBe(true);
    expect(readDockLayout(storage)).toEqual(moved);
  });

  it('falls back to the default layout without storage or when storage throws', () => {
    expect(readDockLayout(undefined)).toEqual(DEFAULT_DOCK_LAYOUT);
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readDockLayout(throwing)).toEqual(DEFAULT_DOCK_LAYOUT);
    expect(() => {
      writeDockLayout(DEFAULT_DOCK_LAYOUT, throwing);
    }).not.toThrow();
  });
});
