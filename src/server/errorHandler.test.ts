import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import {
  frameworkErrorHandler,
  registerErrorHandler,
  type UnhandledErrorReporter,
} from './errorHandler.js';

const SECRET_PATH = '/Users/someone/.leadzy-studio/config.json.tmp';

async function appWithHandler(report?: UnhandledErrorReporter) {
  const app = Fastify({ logger: false, frameworkErrors: frameworkErrorHandler(report) });
  registerErrorHandler(app, report);
  app.get('/eacces', () => {
    throw Object.assign(new Error(`EACCES: permission denied, open '${SECRET_PATH}'`), {
      code: 'EACCES',
    });
  });
  app.get('/app-4xx', () => {
    throw Object.assign(new Error(`not for the wire: ${SECRET_PATH}`), {
      code: 'E_APP',
      statusCode: 418,
    });
  });
  app.get('/fastify-5xx', () => {
    throw Object.assign(new Error(`reply failed at ${SECRET_PATH}`), {
      code: 'FST_ERR_REP_INVALID_PAYLOAD_TYPE',
      statusCode: 500,
    });
  });
  app.get('/fastify-3xx', () => {
    throw Object.assign(new Error(`redirect at ${SECRET_PATH}`), {
      code: 'FST_ERR_X',
      statusCode: 302,
    });
  });
  app.get('/fastify-string-status', () => {
    throw Object.assign(new Error(`string status at ${SECRET_PATH}`), {
      code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE',
      statusCode: '415',
    });
  });
  app.get('/null', () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the handler must survive a non-Error throw
    throw null;
  });
  app.post('/json', { bodyLimit: 64 }, () => ({ ok: true }));
  app.get('/param/:id', () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('registerErrorHandler', () => {
  let app: Awaited<ReturnType<typeof appWithHandler>> | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    app = undefined;
  });

  it('answers an unexpected throw with a content-free 500 and logs the cause to stderr', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    app = await appWithHandler();

    const res = await app.inject({ method: 'GET', url: '/eacces' });

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(SECRET_PATH);
    expect(res.json()).toEqual({ error: 'internal_error', message: 'internal error' });
    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged: readonly unknown[] = consoleError.mock.calls[0] ?? [];
    expect(logged[0]).toBe('unhandled error on GET /eacces');
    expect(logged[1]).toBeInstanceOf(Error);
    expect((logged[1] as Error).message).toContain(SECRET_PATH);
  });

  it.each([
    ['an application error carrying its own 4xx statusCode', '/app-4xx'],
    ['a Fastify error with a 5xx statusCode', '/fastify-5xx'],
    ['a Fastify error with a 3xx statusCode', '/fastify-3xx'],
    ['a Fastify error whose statusCode is a string', '/fastify-string-status'],
    ['a thrown null', '/null'],
  ])(
    'turns %s into the content-free 500 and hands the cause to the reporter',
    async (_label, url) => {
      const report = vi.fn<UnhandledErrorReporter>();
      app = await appWithHandler(report);

      const res = await app.inject({ method: 'GET', url });

      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain(SECRET_PATH);
      expect(res.json()).toEqual({ error: 'internal_error', message: 'internal error' });
      expect(report).toHaveBeenCalledTimes(1);
      expect(report.mock.calls[0]?.[0]).toBe(`unhandled error on GET ${url}`);
    },
  );

  it('still answers the content-free 500 when the reporter itself throws, and says so on stderr', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    app = await appWithHandler(() => {
      throw new Error(`ENOSPC: no space left on device, write '${SECRET_PATH}'`);
    });

    const res = await app.inject({ method: 'GET', url: '/eacces' });

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(SECRET_PATH);
    expect(res.json()).toEqual({ error: 'internal_error', message: 'internal error' });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[0]).toBe('unhandled error reporter failed');
  });

  it('answers a path segment over maxParamLength with 414 invalid_request', async () => {
    app = await appWithHandler();

    const res = await app.inject({ method: 'GET', url: `/param/${'x'.repeat(101)}` });

    expect(res.statusCode).toBe(414);
    expect(res.json()).toEqual({
      error: 'invalid_request',
      message: 'the request could not be parsed',
    });
  });

  it('answers a non-4xx framework error as the content-free 500 and reports it', () => {
    const report = vi.fn<UnhandledErrorReporter>();
    const send = vi.fn();
    const code = vi.fn(() => ({ send }));
    // frameworkErrors runs before routing, so a real reply cannot be obtained through inject for this error
    const reply = { code } as unknown as FastifyReply;
    const error = Object.assign(new Error(`constraint failed at ${SECRET_PATH}`), {
      code: 'FST_ERR_ASYNC_CONSTRAINT',
      statusCode: 500,
    });

    frameworkErrorHandler(report)(error, { method: 'GET', url: '/x' } as never, reply);

    expect(code).toHaveBeenCalledWith(500);
    expect(send).toHaveBeenCalledWith({ error: 'internal_error', message: 'internal error' });
    expect(report).toHaveBeenCalledWith('unhandled error on GET /x', error);
  });

  it('answers a URL that is not valid percent-encoding with 400 invalid_request without echoing it', async () => {
    app = await appWithHandler();

    const res = await app.inject({ method: 'GET', url: '/eacces/50%desconto.mp4' });

    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('desconto');
    expect(res.json()).toEqual({
      error: 'invalid_request',
      message: 'the request could not be parsed',
    });
  });

  it('keeps the status and message of a Fastify body-parser error without echoing the body', async () => {
    app = await appWithHandler();
    const marker = 'sk-marker-in-broken-json';

    const res = await app.inject({
      method: 'POST',
      url: '/json',
      headers: { 'content-type': 'application/json' },
      payload: `{"key": "${marker}`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(marker);
    const body = res.json<{ error: string; message: string }>();
    expect(body.error).toBe('invalid_request');
    expect(body.message).toMatch(/JSON/);
  });

  it('answers the body limit with 413 payload_too_large and an unknown content type with 415', async () => {
    app = await appWithHandler();

    const tooLarge = await app.inject({
      method: 'POST',
      url: '/json',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ blob: 'x'.repeat(200) }),
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json<{ error: string }>().error).toBe('payload_too_large');

    const unsupported = await app.inject({
      method: 'POST',
      url: '/json',
      headers: { 'content-type': 'application/x-unknown' },
      payload: 'x',
    });
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json<{ error: string }>().error).toBe('unsupported_media_type');
  });
});
