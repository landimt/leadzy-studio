const OPEN_SUGGESTIONS_TOOL = 'leadzy:open-suggestions-tool';
const OPEN_SPEED_TOOL = 'leadzy:open-speed-tool';
const toolEvents = new EventTarget();

/** MenuBar and Timeline share the unified suggestions/silences reviewer. */
export function requestSuggestionsTool(): void {
  toolEvents.dispatchEvent(new Event(OPEN_SUGGESTIONS_TOOL));
}

export function onSuggestionsToolRequest(open: () => void): () => void {
  const listener = (): void => {
    open();
  };
  toolEvents.addEventListener(OPEN_SUGGESTIONS_TOOL, listener);
  return () => {
    toolEvents.removeEventListener(OPEN_SUGGESTIONS_TOOL, listener);
  };
}

export function requestSpeedTool(): void {
  toolEvents.dispatchEvent(new Event(OPEN_SPEED_TOOL));
}

export function onSpeedToolRequest(open: () => void): () => void {
  const listener = (): void => {
    open();
  };
  toolEvents.addEventListener(OPEN_SPEED_TOOL, listener);
  return () => {
    toolEvents.removeEventListener(OPEN_SPEED_TOOL, listener);
  };
}
