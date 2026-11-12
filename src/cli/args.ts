import { err, ok, type Result } from '../core/result.js';

/** A non-negative seconds value from the command line; `undefined` when the flag was not given. */
export function parseSeconds(flag: string, raw: string | undefined): Result<number | undefined> {
  if (raw === undefined) return ok(undefined);
  const value = Number(raw);
  if (raw.trim().length === 0 || !Number.isFinite(value) || value < 0) {
    return err('invalid-input', `${flag} must be a non-negative number of seconds, got "${raw}"`);
  }
  return ok(value);
}

/** `a,b, c` → `['a', 'b', 'c']`; `undefined` when the flag was not given. */
export function parseIdList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/** One of a fixed set of values; `undefined` when the flag was not given. A typo stops the command instead of falling back to the default. */
export function parseChoice<T extends string>(
  flag: string,
  raw: string | undefined,
  choices: readonly T[],
): Result<T | undefined> {
  if (raw === undefined) return ok(undefined);
  const match = choices.find((choice) => choice === raw);
  if (match === undefined) {
    return err('invalid-input', `${flag} must be one of ${choices.join(', ')}, got "${raw}"`);
  }
  return ok(match);
}
