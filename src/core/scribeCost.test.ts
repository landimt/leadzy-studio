import { describe, expect, it } from 'vitest';
import { estimateScribeCostUsd } from './scribeCost.js';

describe('estimateScribeCostUsd', () => {
  it('prices one hour at the list rate, rounded to cents', () => {
    expect(estimateScribeCostUsd(3600)).toBe(0.22);
    expect(estimateScribeCostUsd(90)).toBe(0.01);
  });

  it('adds the keyterm surcharge only when keyterms are sent', () => {
    expect(estimateScribeCostUsd(36000, 3)).toBe(2.64);
    expect(estimateScribeCostUsd(36000, 0)).toBe(2.2);
  });

  it('never goes negative or breaks on empty input', () => {
    expect(estimateScribeCostUsd(0)).toBe(0);
    expect(estimateScribeCostUsd(-5, 2)).toBe(0);
  });
});
