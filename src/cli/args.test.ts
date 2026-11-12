import { describe, expect, it } from 'vitest';
import { parseChoice, parseIdList, parseSeconds } from './args.js';

describe('parseSeconds', () => {
  it('passes an absent flag through as undefined and parses plain numbers', () => {
    expect(parseSeconds('--from', undefined)).toStrictEqual({ ok: true, value: undefined });
    expect(parseSeconds('--from', '30.2')).toStrictEqual({ ok: true, value: 30.2 });
    expect(parseSeconds('--from', '0')).toStrictEqual({ ok: true, value: 0 });
  });

  it.each(['abc', '-1', 'Infinity', 'NaN', '', ' '])('rejects %j', (raw) => {
    const result = parseSeconds('--to', raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-input');
    expect(result.error.message).toContain('--to');
  });
});

describe('parseIdList', () => {
  it('splits on commas, trims and drops empty entries', () => {
    expect(parseIdList(undefined)).toBeUndefined();
    expect(parseIdList('a, b,,c ,')).toEqual(['a', 'b', 'c']);
    expect(parseIdList('')).toEqual([]);
  });
});

describe('parseChoice', () => {
  const levels = ['recommended', 'high', 'max'] as const;

  it('passes an absent flag through as undefined and accepts a listed value', () => {
    expect(parseChoice('--quality', undefined, levels)).toStrictEqual({
      ok: true,
      value: undefined,
    });
    expect(parseChoice('--quality', 'max', levels)).toStrictEqual({ ok: true, value: 'max' });
  });

  it.each(['ultra', 'MAX', ''])('rejects %j and names the accepted values', (raw) => {
    const result = parseChoice('--quality', raw, levels);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-input');
    expect(result.error.message).toContain('--quality');
    expect(result.error.message).toContain('recommended, high, max');
  });
});
