import { describe, expect, it } from 'vitest';
import { isPristineProject } from './pristineProject.js';

function doc(baseBlocks: number, sources: number, auxiliary: readonly number[] = [0]) {
  return {
    tracks: [
      { blocks: Array.from({ length: baseBlocks }, () => ({})) },
      ...auxiliary.map((length) => ({ blocks: Array.from({ length }, () => ({})) })),
    ],
    sources: Object.fromEntries(
      Array.from({ length: sources }, (_, i) => [`source${String(i)}`, {}]),
    ),
  };
}

describe('isPristineProject', () => {
  it('rejects a missing document', () => {
    expect(isPristineProject(null)).toBe(false);
  });

  it('accepts base blocks mirroring the sources', () => {
    expect(isPristineProject(doc(3, 3))).toBe(true);
  });

  it('accepts fewer base blocks than sources', () => {
    expect(isPristineProject(doc(2, 3))).toBe(true);
  });

  it('rejects more base blocks than sources, the mark of a split', () => {
    expect(isPristineProject(doc(4, 3))).toBe(false);
  });

  it('rejects content on any auxiliary track, even alongside empty ones', () => {
    expect(isPristineProject(doc(3, 3, [0, 2]))).toBe(false);
  });

  it('accepts a document with only an empty base track', () => {
    expect(isPristineProject({ tracks: [{ blocks: [] }], sources: {} })).toBe(true);
  });

  it('accepts a document with no tracks at all', () => {
    expect(isPristineProject({ tracks: [], sources: {} })).toBe(true);
  });
});
