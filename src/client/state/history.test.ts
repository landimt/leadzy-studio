import { describe, expect, it } from 'vitest';
import { CoalescingHistory } from './history.js';

describe('CoalescingHistory', () => {
  it('each keyless record is its own undo step', () => {
    const history = new CoalescingHistory<string>();
    history.record('a');
    history.record('b');
    expect(history.undoDepth).toBe(2);
  });

  it('a gesture of N records with the same key is one undo step back to the pre-gesture snapshot', () => {
    const history = new CoalescingHistory<string>();
    history.record('start', 'drag');
    history.record('mid', 'drag');
    history.record('late', 'drag');
    expect(history.undoDepth).toBe(1);
    expect(history.undo('end')).toBe('start');
    expect(history.undoDepth).toBe(0);
  });

  it('endGesture closes the step: the same key afterwards opens a new one', () => {
    const history = new CoalescingHistory<string>();
    history.record('a', 'drag');
    history.endGesture();
    history.record('b', 'drag');
    expect(history.undoDepth).toBe(2);
  });

  it('a different key or a keyless record closes the previous gesture', () => {
    const history = new CoalescingHistory<string>();
    history.record('a', 'drag');
    history.record('b', 'other');
    history.record('c');
    history.record('d', 'drag');
    expect(history.undoDepth).toBe(4);
  });

  it('drag → undo → drag with the same key does not lose the new snapshot', () => {
    const history = new CoalescingHistory<string>();
    history.record('start', 'drag');
    expect(history.undo('moved')).toBe('start');
    history.record('start-again', 'drag');
    expect(history.undoDepth).toBe(1);
    expect(history.undo('moved-again')).toBe('start-again');
  });

  it('redo restores what undo removed; a new record clears the redo stack', () => {
    const history = new CoalescingHistory<string>();
    history.record('v1');
    expect(history.undo('v2')).toBe('v1');
    expect(history.redoDepth).toBe(1);
    expect(history.redo('v1')).toBe('v2');
    expect(history.undo('v2')).toBe('v1');
    history.record('v1');
    expect(history.redoDepth).toBe(0);
    expect(history.redo('anything')).toBeUndefined();
  });

  it('undo/redo on empty stacks return undefined without side effects', () => {
    const history = new CoalescingHistory<string>();
    expect(history.undo('x')).toBeUndefined();
    expect(history.redoDepth).toBe(0);
    expect(history.redo('x')).toBeUndefined();
    expect(history.undoDepth).toBe(0);
  });

  it('clear resets stacks and the open gesture', () => {
    const history = new CoalescingHistory<string>();
    history.record('a', 'drag');
    history.clear();
    expect(history.undoDepth).toBe(0);
    expect(history.redoDepth).toBe(0);
    history.record('b', 'drag');
    expect(history.undoDepth).toBe(1);
  });
});
