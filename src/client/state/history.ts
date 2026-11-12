/**
 * Undo/redo stacks with gesture coalescing: consecutive records sharing the
 * same key (one drag, one slider sweep) collapse into a single undo step.
 * Undo, redo, endGesture or a record with another/no key close the gesture.
 */
export class CoalescingHistory<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];
  private key: string | null = null;

  get undoDepth(): number {
    return this.undoStack.length;
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }

  /** Call BEFORE replacing the state: `current` is the pre-edit snapshot. */
  record(current: T, coalesceKey?: string): void {
    if (coalesceKey === undefined || coalesceKey !== this.key) {
      this.undoStack.push(current);
    }
    this.key = coalesceKey ?? null;
    this.redoStack = [];
  }

  undo(current: T): T | undefined {
    const previous = this.undoStack.pop();
    if (previous === undefined) return undefined;
    this.key = null;
    this.redoStack.push(current);
    return previous;
  }

  redo(current: T): T | undefined {
    const next = this.redoStack.pop();
    if (next === undefined) return undefined;
    this.key = null;
    this.undoStack.push(current);
    return next;
  }

  endGesture(): void {
    this.key = null;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.key = null;
  }
}
