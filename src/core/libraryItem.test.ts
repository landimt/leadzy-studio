import { describe, expect, it } from 'vitest';
import {
  libraryVariablesSchema,
  libraryVariableValueSchema,
  resolveVariableValues,
  sameLibraryVariables,
} from './libraryItem.js';

describe('libraryVariablesSchema', () => {
  it('accepts UPPER_SNAKE_CASE names and rejects anything else', () => {
    expect(libraryVariablesSchema.safeParse({ HEADLINE: 'a', SUB_2: 'b' }).success).toBe(true);
    expect(libraryVariablesSchema.safeParse({ headline: 'a' }).success).toBe(false);
    expect(libraryVariablesSchema.safeParse({ '2COLD': 'a' }).success).toBe(false);
    expect(libraryVariablesSchema.safeParse(JSON.parse('{"HEAD-LINE":"a"}')).success).toBe(false);
  });

  it('refuses to carry more values than a manifest can declare', () => {
    const many = Object.fromEntries(
      Array.from({ length: 9 }, (_unused, index) => [`VAR_${String(index)}`, 'x']),
    );
    expect(libraryVariablesSchema.safeParse(many).success).toBe(false);
    const { VAR_8: _dropped, ...eight } = many;
    expect(libraryVariablesSchema.safeParse(eight).success).toBe(true);
  });

  it('drops a __proto__ key instead of carrying it into the document', () => {
    const parsed = libraryVariablesSchema.safeParse(
      JSON.parse('{"__proto__":"polluted","HEADLINE":"ok"}'),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.getOwnPropertyNames(parsed.data)).toEqual(['HEADLINE']);
    }
  });

  it('rejects a value with a newline, which would break the HTML it lands in', () => {
    expect(libraryVariableValueSchema.safeParse('one\ntwo').success).toBe(false);
    expect(libraryVariableValueSchema.safeParse('one two').success).toBe(true);
  });

  it('accepts an empty value so a field can be cleared, and caps the length at 120', () => {
    expect(libraryVariableValueSchema.safeParse('').success).toBe(true);
    expect(libraryVariableValueSchema.safeParse('x'.repeat(120)).success).toBe(true);
    expect(libraryVariableValueSchema.safeParse('x'.repeat(121)).success).toBe(false);
  });
});

describe('resolveVariableValues', () => {
  const variables = [
    { name: 'HEADLINE', default: 'Compre agora' },
    { name: 'PRICE', default: 'R$ 99' },
  ];

  it('falls back to the manifest default for a variable with no override', () => {
    expect(resolveVariableValues(variables, { PRICE: 'R$ 49' })).toEqual({
      HEADLINE: 'Compre agora',
      PRICE: 'R$ 49',
    });
  });

  it('uses every default when there are no overrides at all', () => {
    expect(resolveVariableValues(variables)).toEqual({
      HEADLINE: 'Compre agora',
      PRICE: 'R$ 99',
    });
  });

  it('keeps an override that is deliberately empty', () => {
    expect(resolveVariableValues(variables, { HEADLINE: '' }).HEADLINE).toBe('');
  });

  it('ignores an override for a variable the item does not declare', () => {
    expect(resolveVariableValues(variables, { GHOST: 'x' })).not.toHaveProperty('GHOST');
  });
});

describe('sameLibraryVariables', () => {
  it('compares complete snapshots without depending on key order', () => {
    expect(sameLibraryVariables({ HEADLINE: 'A', PRICE: '1' }, { PRICE: '1', HEADLINE: 'A' })).toBe(
      true,
    );
    expect(sameLibraryVariables({ HEADLINE: 'A' }, { HEADLINE: 'B' })).toBe(false);
    expect(sameLibraryVariables({ HEADLINE: 'A' }, { HEADLINE: 'A', PRICE: '1' })).toBe(false);
  });

  it('distinguishes an absent snapshot from an empty one', () => {
    expect(sameLibraryVariables(undefined, undefined)).toBe(true);
    expect(sameLibraryVariables(undefined, {})).toBe(false);
  });
});
