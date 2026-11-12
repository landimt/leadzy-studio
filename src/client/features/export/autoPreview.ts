import type { StoreState } from '../../state/storeState.js';

export interface AutoPreviewController {
  readonly getState: () => StoreState;
  readonly shouldAutoPreviewCurrentDoc: () => boolean;
  readonly flushSave: () => Promise<boolean>;
}

/**
 * A freshly opened project has no program and no edits: rendering one then
 * would decode the original at full cost while the proxies are still being
 * built, for a program the first edit invalidates. Wait for that first edit
 * (from the UI or from the agent) unless a program already exists.
 */
export function isUntouchedFirstOpen(state: StoreState): boolean {
  return (
    state.project !== null &&
    !state.project.hasProgram &&
    state.undoDepth === 0 &&
    !state.agentEdited
  );
}

/** One gate shared by the effect and the post-save revalidation. */
export function canStartAutoPreview(state: StoreState, docNeedsProgram: boolean): boolean {
  return (
    state.autoPreview &&
    state.programOutdated &&
    !isUntouchedFirstOpen(state) &&
    state.doc !== null &&
    docNeedsProgram &&
    !state.activeJobs.has('render') &&
    !state.activeJobs.has('audio-preview') &&
    state.audioPreviewRefreshState === 'idle'
  );
}

/**
 * Saves first, then re-reads every condition. A timer that became obsolete
 * while waiting behind another save cannot launch a stale program render.
 */
export async function startAutoPreviewAfterSave(
  controller: AutoPreviewController,
  startRender: () => Promise<unknown>,
  showError: (message: string) => void,
): Promise<boolean> {
  if (!(await controller.flushSave())) return false;
  const current = controller.getState();
  if (!canStartAutoPreview(current, controller.shouldAutoPreviewCurrentDoc())) return false;
  try {
    await startRender();
    return true;
  } catch (cause) {
    showError(cause instanceof Error ? cause.message : String(cause));
    return false;
  }
}
