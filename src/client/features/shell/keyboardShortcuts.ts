type ShortcutEvent = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat' | 'isComposing'
>;

export type EditorShortcut =
  | 'playPause'
  | 'seekLeft'
  | 'seekRight'
  | 'settings'
  | 'fullscreen'
  | 'start'
  | 'end'
  | 'split'
  | 'trimLeft'
  | 'trimRight'
  | 'delete'
  | 'undo'
  | 'redo'
  | 'save';

/** Modified app/system shortcuts must never fall through to destructive single-letter edits. */
export function resolveEditorShortcut(event: ShortcutEvent): EditorShortcut | null {
  if (event.isComposing || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.metaKey || event.ctrlKey) {
    if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
    if (key === 'y' && event.ctrlKey && !event.shiftKey) return 'redo';
    if (key === ',' && !event.shiftKey) return 'settings';
    if (key === 's' && !event.shiftKey) return 'save';
    return null;
  }
  if (event.code === 'Space') return event.repeat ? null : 'playPause';
  switch (key) {
    case 'arrowleft':
      return 'seekLeft';
    case 'arrowright':
      return 'seekRight';
    case 'f':
      return event.repeat ? null : 'fullscreen';
    case 'home':
      return 'start';
    case 'end':
      return 'end';
    case 's':
      return 'split';
    case 'q':
      return 'trimLeft';
    case 'w':
      return 'trimRight';
    case 'backspace':
    case 'delete':
      return 'delete';
    default:
      return null;
  }
}
