import { z } from 'zod';

/**
 * Library item ids name the folder under `~/.leadzy-studio/library/` AND the
 * back-reference persisted in overlay blocks. One pattern for both sides so the
 * manifest and the edit document can never disagree about what an id is.
 */
export const LIBRARY_ITEM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,60}$/;

/** Names a `{{NAME}}` placeholder in a parametric item's template. */
const LIBRARY_VARIABLE_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;

export const MAX_LIBRARY_VARIABLES = 8;
export const MAX_LIBRARY_VARIABLE_VALUE_LENGTH = 120;

/** Variables that also control the rendered clip's measured duration. */
export const LIBRARY_OVERLAY_TIMING_VARIABLES: Readonly<
  Record<string, { readonly min: number; readonly max: number }>
> = {
  DURATION_SECONDS: { min: 1.8, max: 5 },
  HOLD_SECONDS: { min: 0.8, max: 8 },
};

/**
 * Filename the import gives the PROJECT copy of a parametric item's template.
 * Fixed on purpose: a re-bake locates the template from the block's item id
 * alone, so it never depends on a global manifest that may have changed or
 * disappeared since the piece was imported.
 */
export const PROJECT_TEMPLATE_FILENAME = 'template.html';

/** `Cc` is the Unicode control category — newlines included, which would break the HTML the value lands in. */
const NO_CONTROL_CHARS = /^\P{Cc}*$/u;

/** Empty is allowed: clearing a variable in the inspector is a legitimate value. */
export const libraryVariableValueSchema = z
  .string()
  .max(MAX_LIBRARY_VARIABLE_VALUE_LENGTH)
  .regex(NO_CONTROL_CHARS, 'variable value cannot contain control characters');

export const libraryVariableNameSchema = z
  .string()
  .regex(LIBRARY_VARIABLE_NAME_PATTERN, 'variable names are UPPER_SNAKE_CASE, max 32 chars');

/**
 * Values carried on a block, or posted to the re-bake route. Capped like a
 * manifest's own list: without it, a caller could grow this record without
 * bound and every entry would be persisted into edit.json.
 */
export const libraryVariablesSchema = z
  .record(libraryVariableNameSchema, libraryVariableValueSchema)
  .refine(
    (values) => Object.keys(values).length <= MAX_LIBRARY_VARIABLES,
    `at most ${String(MAX_LIBRARY_VARIABLES)} variables`,
  );

/** The part of a manifest variable a bake needs; the human-facing `label` stays out of it. */
export interface LibraryVariable {
  readonly name: string;
  readonly default: string;
}

/**
 * Resolves the values a bake will substitute: the manifest default for every
 * declared variable, overridden by whatever the caller already holds. Called at
 * IMPORT time, so the block carries a complete record and a later re-bake never
 * has to consult the global manifest again.
 */
export function resolveVariableValues(
  variables: readonly LibraryVariable[],
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return Object.fromEntries(
    variables.map((variable) => [variable.name, overrides[variable.name] ?? variable.default]),
  );
}

/** Compares the complete variable snapshot carried by a parametric block. */
export function sameLibraryVariables(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftNames = Object.keys(left).sort();
  const rightNames = Object.keys(right).sort();
  return (
    leftNames.length === rightNames.length &&
    leftNames.every((name, index) => name === rightNames[index] && left[name] === right[name])
  );
}
