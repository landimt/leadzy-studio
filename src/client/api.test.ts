import { describe, expect, it } from 'vitest';
import { ApiError, toApiError } from './api.js';

describe('toApiError', () => {
  it('translates a known error code and keeps the code, status and hash', () => {
    const error = toApiError(
      { error: 'invalid_api_key', message: 'elevenLabsApiKey must be…', currentHash: 'h1' },
      400,
      'Bad Request',
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe('chave inválida — confira o formato');
    expect(error.code).toBe('invalid_api_key');
    expect(error.status).toBe(400);
    expect(error.currentHash).toBe('h1');
  });

  it('shows the server detail for a code whose message is the payload', () => {
    const error = toApiError(
      {
        error: 'invalid_edit_document',
        message: 'edit.json failed validation: fps: expected number',
      },
      422,
      'Unprocessable Entity',
    );

    expect(error.message).toBe('edit.json failed validation: fps: expected number');
    expect(error.code).toBe('invalid_edit_document');
  });

  it('falls back to the English message for a code this client does not know', () => {
    const error = toApiError({ error: 'from_the_future', message: 'something new' }, 422, 'x');

    expect(error.message).toBe('something new');
    expect(error.code).toBeUndefined();
  });

  it('shows the sentence of an older server that answers with a plain error string', () => {
    const error = toApiError({ error: 'servidor antigo: frase em português' }, 409, 'Conflict');

    expect(error.message).toBe('servidor antigo: frase em português');
    expect(error.code).toBeUndefined();
  });

  it('uses the HTTP status line when the body is missing or empty', () => {
    expect(toApiError(null, 502, 'Bad Gateway').message).toBe('502 Bad Gateway');
    expect(toApiError({}, 404, 'Not Found').message).toBe('404 Not Found');
  });

  it('does not treat prototype names as error codes', () => {
    expect(toApiError({ error: 'constructor' }, 500, 'x').code).toBeUndefined();
  });
});
