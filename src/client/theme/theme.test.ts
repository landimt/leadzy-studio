import { describe, expect, it, vi } from 'vitest';
import { applyTheme, nextTheme, readTheme, THEME_STORAGE_KEY } from './theme.js';

describe('studio theme', () => {
  it('alternates on every toggle instead of closing over the first value', () => {
    expect(nextTheme(nextTheme('light'))).toBe('light');
    expect(nextTheme(nextTheme('dark'))).toBe('dark');
  });

  it('prefers the theme already painted on the document', () => {
    const storage = { getItem: vi.fn(() => 'light'), setItem: vi.fn() };
    expect(readTheme({ dataset: { theme: 'dark' } }, storage)).toBe('dark');
  });

  it('writes the DOM and local preference through the same function', () => {
    const target = { dataset: {} as { theme?: string } };
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
    applyTheme('dark', target, storage);
    expect(target.dataset.theme).toBe('dark');
    expect(storage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, 'dark');
  });
});
