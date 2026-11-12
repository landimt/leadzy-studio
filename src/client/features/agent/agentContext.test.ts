import { describe, expect, it } from 'vitest';
import { EditorStore } from '../../state/store.js';
import { agentContext, contextPrompt } from './agentContext.js';
describe('agent handoff', () => {
  it('serializes an explicit allowlist rather than secrets/settings or all state', () => {
    const state = new EditorStore().getState();
    const context = agentContext(
      {
        ...state,
        dirty: true,
        selection: { trackId: 'base', blockIndex: 2 },
        lockedTrackKeys: new Set(['base']),
      },
      1.23456,
    );
    expect(context.unsavedChanges).toBe(true);
    expect(context.nextAction).toBe('wait-for-save');
    expect(context.protocol).toBe('leadzy-studio.ui.v1');
    expect(context.playheadSeconds).toBe(1.235);
    expect(context.lockedTracks).toEqual(['base']);
    expect(context.selection?.blockIndex).toBe(2);
    expect(Object.keys(context)).not.toContain('settings');
    expect(Object.keys(context)).not.toContain('transcripts');
    const text = contextPrompt('Improve selected video', context);
    expect(text).toContain('--expect-hash');
    expect(text).toContain('Unsaved UI changes');
  });
});

it('prioritizes conflict resolution and drops an obsolete color target after selecting another track', () => {
  const state = new EditorStore().getState();
  const context = agentContext(
    {
      ...state,
      dirty: true,
      conflict: true,
      colorInspectorTarget: { trackId: 'base' },
      selection: { trackId: 'demo', blockIndex: 0 },
    },
    0,
  );
  expect(context.nextAction).toBe('resolve-conflict');
  expect(context.colorTarget).toBeNull();
});
