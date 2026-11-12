import { describe, expect, it, vi } from 'vitest';
import {
  onSuggestionsToolRequest,
  onSpeedToolRequest,
  requestSuggestionsTool,
  requestSpeedTool,
} from './toolEvents.js';

describe('timeline tool event bridge', () => {
  it('opens the standalone speed dialog without adding UI state to the editor store', () => {
    const open = vi.fn();
    const unsubscribe = onSpeedToolRequest(open);
    requestSpeedTool();
    expect(open).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it('opens the shared cut-suggestion reviewer and cleans up its subscription', () => {
    const open = vi.fn();
    const unsubscribe = onSuggestionsToolRequest(open);
    requestSuggestionsTool();
    expect(open).toHaveBeenCalledOnce();
    unsubscribe();
    requestSuggestionsTool();
    expect(open).toHaveBeenCalledOnce();
  });
});
