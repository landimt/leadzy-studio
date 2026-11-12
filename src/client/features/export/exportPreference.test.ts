import { describe, expect, it } from 'vitest';
import { initialDeliveryChoice, rememberDeliveryChoice } from './exportPreference.js';

const preferences = {
  exportMode: 'ask' as const,
  exportDirectory: '/deliveries',
  exportFilenamePattern: '{project}',
  revealAfterExport: true,
};

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

const throwing = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('initialDeliveryChoice', () => {
  it('starts from the preferences — "ask" and "folder" both mean a folder', () => {
    expect(initialDeliveryChoice('/p', preferences, memoryStorage())).toEqual({
      mode: 'folder',
      directory: '/deliveries',
      pattern: '{project}',
      reveal: true,
    });
    expect(
      initialDeliveryChoice('/p', { ...preferences, exportMode: 'project' }, undefined).mode,
    ).toBe('project');
  });

  it('prefers what this project chose last time', () => {
    const storage = memoryStorage();
    rememberDeliveryChoice(
      '/p',
      { mode: 'project', directory: '/x', pattern: '{project}-{date}', reveal: false },
      storage,
    );

    expect(initialDeliveryChoice('/p', preferences, storage)).toEqual({
      mode: 'project',
      directory: '/x',
      pattern: '{project}-{date}',
      reveal: false,
    });
  });

  it('ignores garbage fields and broken JSON', () => {
    const garbage = memoryStorage({
      'leadzy-export-delivery:/q': '{"mode":"cloud","pattern":"  "}',
    });
    expect(initialDeliveryChoice('/q', preferences, garbage)).toMatchObject({
      mode: 'folder',
      pattern: '{project}',
    });

    const broken = memoryStorage({ 'leadzy-export-delivery:/r': '{' });
    expect(initialDeliveryChoice('/r', preferences, broken)).toEqual(
      initialDeliveryChoice('/r', preferences, memoryStorage()),
    );
  });

  it('never throws when storage refuses', () => {
    expect(initialDeliveryChoice('/p', preferences, throwing).mode).toBe('folder');
    expect(() => {
      rememberDeliveryChoice(
        '/p',
        { mode: 'project', directory: '', pattern: 'x', reveal: false },
        throwing,
      );
    }).not.toThrow();
  });
});
