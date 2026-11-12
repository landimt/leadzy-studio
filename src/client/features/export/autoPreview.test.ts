import { describe, expect, it, vi } from 'vitest';
import type { EditDoc } from '../../../core/schema.js';
import type { StoreState } from '../../state/storeState.js';
import {
  canStartAutoPreview,
  isUntouchedFirstOpen,
  startAutoPreviewAfterSave,
} from './autoPreview.js';

function eligibleState(): StoreState {
  return {
    autoPreview: true,
    programOutdated: true,
    doc: { version: 2 } as EditDoc,
    activeJobs: new Map(),
    audioPreviewRefreshState: 'idle',
    project: { hasProgram: true },
    undoDepth: 0,
    agentEdited: false,
  } as unknown as StoreState;
}

describe('canStartAutoPreview on first open', () => {
  const untouched = (): StoreState =>
    ({ ...eligibleState(), project: { hasProgram: false } }) as unknown as StoreState;

  it('waits when the project was just opened, has no program and nobody edited it yet', () => {
    expect(isUntouchedFirstOpen(untouched())).toBe(true);
    expect(canStartAutoPreview(untouched(), true)).toBe(false);
  });

  it('starts once the user edits, the agent edits, or a program already exists', () => {
    expect(canStartAutoPreview({ ...untouched(), undoDepth: 1 }, true)).toBe(true);
    expect(canStartAutoPreview({ ...untouched(), agentEdited: true }, true)).toBe(true);
    expect(canStartAutoPreview(eligibleState(), true)).toBe(true);
  });
});

describe('startAutoPreviewAfterSave', () => {
  it('revalidates visual changes after a slow save before starting video', async () => {
    let resolveSave: (saved: boolean) => void = () => undefined;
    let visualChanges = true;
    const state = eligibleState();
    const startRender = vi.fn(() => Promise.resolve());
    const task = startAutoPreviewAfterSave(
      {
        getState: () => state,
        shouldAutoPreviewCurrentDoc: () => visualChanges,
        flushSave: () =>
          new Promise<boolean>((resolve) => {
            resolveSave = resolve;
          }),
      },
      startRender,
      vi.fn(),
    );

    visualChanges = false;
    resolveSave(true);

    await expect(task).resolves.toBe(false);
    expect(startRender).not.toHaveBeenCalled();
  });

  it('waits for the lightweight audio proof to become idle', async () => {
    const state = { ...eligibleState(), audioPreviewRefreshState: 'saving' } as StoreState;
    const startRender = vi.fn(() => Promise.resolve());

    await expect(
      startAutoPreviewAfterSave(
        {
          getState: () => state,
          shouldAutoPreviewCurrentDoc: () => true,
          flushSave: () => Promise.resolve(true),
        },
        startRender,
        vi.fn(),
      ),
    ).resolves.toBe(false);
    expect(startRender).not.toHaveBeenCalled();
  });
});
