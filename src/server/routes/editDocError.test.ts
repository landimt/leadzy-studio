import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { StudioError } from '../../core/result.js';
import { registerErrorHandler, type UnhandledErrorReporter } from '../errorHandler.js';
import { EDIT_DOC_MISSING_MESSAGE, editDocClientError, sendEditDocError } from './editDocError.js';

describe('editDocClientError', () => {
  it('answers a missing edit.json with 404 and a fixed message that omits the project path', () => {
    const error: StudioError = {
      code: 'not-found',
      message: 'no edit.json found in "/Users/someone/creative/edit" — run studio open first',
    };

    expect(editDocClientError(error)).toEqual({
      status: 404,
      code: 'edit_document_missing',
      message: EDIT_DOC_MISSING_MESSAGE,
    });
  });

  it('answers a document that fails the schema with 422 and the detail the user has to fix', () => {
    const error: StudioError = {
      code: 'invalid-edit-json',
      message: 'edit.json failed validation: fps: expected number',
    };

    expect(editDocClientError(error)).toEqual({
      status: 422,
      code: 'invalid_edit_document',
      message: 'edit.json failed validation: fps: expected number',
    });
  });

  it('leaves server-side failures to the error handler', () => {
    expect(editDocClientError({ code: 'io-failed', message: 'EACCES' })).toBeUndefined();
  });
});

describe('sendEditDocError', () => {
  it('throws on a server-side failure so the route answers a content-free 500 with the cause logged', async () => {
    const report = vi.fn<UnhandledErrorReporter>();
    const app = Fastify({ logger: false });
    registerErrorHandler(app, report);
    const secret = '/Users/someone/creative/edit/edit.json';
    app.get('/edit', (_request, reply) =>
      sendEditDocError(reply, { code: 'io-failed', message: `EACCES: open '${secret}'` }),
    );
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/edit' });

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(secret);
    expect(res.json()).toEqual({ error: 'internal_error', message: 'internal error' });
    const logged = report.mock.calls[0]?.[1];
    expect(logged).toBeInstanceOf(Error);
    expect((logged as Error).message).toBe(`cannot read edit.json: EACCES: open '${secret}'`);
    await app.close();
  });

  it('answers a client-side failure directly', async () => {
    const app = Fastify({ logger: false });
    app.get('/edit', (_request, reply) =>
      sendEditDocError(reply, { code: 'not-found', message: 'no edit.json found in "/x/edit"' }),
    );
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/edit' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: 'edit_document_missing',
      message: EDIT_DOC_MISSING_MESSAGE,
    });
    await app.close();
  });
});
