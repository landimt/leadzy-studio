export interface StudioError {
  readonly code:
    | 'invalid-edit-json'
    | 'invalid-transcript'
    | 'path-outside-project'
    | 'ffmpeg-failed'
    | 'ffmpeg-missing-capability'
    | 'hyperframes-failed'
    | 'transcription-failed'
    | 'missing-api-key'
    | 'invalid-api-key'
    | 'io-failed'
    | 'invalid-input'
    | 'not-found';
  readonly message: string;
  readonly cause?: unknown;
}

export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: StudioError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(
  code: StudioError['code'],
  message: string,
  cause?: unknown,
): Result<T> {
  return { ok: false, error: cause === undefined ? { code, message } : { code, message, cause } };
}

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}
