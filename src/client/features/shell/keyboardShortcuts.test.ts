import { describe, expect, it } from 'vitest';
import { resolveEditorShortcut } from './keyboardShortcuts.js';

function keyEvent(key: string, overrides: Partial<KeyboardEvent> = {}) {
  return {
    key,
    code: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    ...overrides,
  };
}

describe('editor keyboard shortcuts', () => {
  it.each(['ctrlKey', 'metaKey'] as const)(
    'saves on %s+S instead of splitting a block',
    (modifier) => {
      expect(resolveEditorShortcut(keyEvent('s', { [modifier]: true }))).toBe('save');
    },
  );

  it.each(['q', 'w', 'f', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight'])(
    'does not edit or navigate for modified %s',
    (key) => {
      for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
        expect(resolveEditorShortcut(keyEvent(key, { [modifier]: true }))).toBeNull();
      }
    },
  );

  it('preserves bare edit keys and the macOS and Windows undo/redo conventions', () => {
    expect(resolveEditorShortcut(keyEvent('S', { shiftKey: true }))).toBe('split');
    expect(resolveEditorShortcut(keyEvent('q'))).toBe('trimLeft');
    expect(resolveEditorShortcut(keyEvent('w'))).toBe('trimRight');
    expect(resolveEditorShortcut(keyEvent('z', { metaKey: true }))).toBe('undo');
    expect(resolveEditorShortcut(keyEvent('Z', { metaKey: true, shiftKey: true }))).toBe('redo');
    expect(resolveEditorShortcut(keyEvent('y', { ctrlKey: true }))).toBe('redo');
  });

  it('leaves composing input and modified Save As shortcuts alone', () => {
    expect(resolveEditorShortcut(keyEvent('s', { isComposing: true }))).toBeNull();
    expect(resolveEditorShortcut(keyEvent('s', { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(resolveEditorShortcut(keyEvent('s', { ctrlKey: true, altKey: true }))).toBeNull();
  });

  it('toggles playback once per press, without stealing modified Space', () => {
    expect(resolveEditorShortcut(keyEvent(' ', { code: 'Space' }))).toBe('playPause');
    expect(resolveEditorShortcut(keyEvent(' ', { code: 'Space', repeat: true }))).toBeNull();
    expect(resolveEditorShortcut(keyEvent(' ', { code: 'Space', metaKey: true }))).toBeNull();
  });
});
