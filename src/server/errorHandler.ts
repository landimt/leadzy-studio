import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type ApiErrorCode, sendApiError } from './routes/apiError.js';

type FastifyClientError = FastifyError & { readonly statusCode: number };

/** Fastify's own request errors: their messages are static and never echo the request. */
function isFastifyClientError(error: unknown): error is FastifyClientError {
  if (error === null || typeof error !== 'object') return false;
  const { code, statusCode } = error as Partial<FastifyError>;
  return (
    typeof code === 'string' &&
    code.startsWith('FST_ERR_') &&
    typeof statusCode === 'number' &&
    statusCode >= 400 &&
    statusCode < 500
  );
}

function clientErrorCode(statusCode: number): ApiErrorCode {
  if (statusCode === 413) return 'payload_too_large';
  if (statusCode === 415) return 'unsupported_media_type';
  return 'invalid_request';
}

/**
 * Receives the cause of every content-free 500; the wire never carries it.
 * Best effort: a throw is swallowed and a returned promise is not awaited,
 * so a reporter must observe its own failures.
 */
export type UnhandledErrorReporter = (context: string, error: unknown) => void;

const reportToStderr: UnhandledErrorReporter = (context, error) => {
  console.error(context, error);
};

/**
 * Shapes every error that escapes a route handler. Fastify's own 4xx (body
 * parser, payload limits) keep their status, while anything else becomes a
 * content-free 500 so a raw EACCES never ships an absolute path to the
 * client. The server runs with `logger: false`, so the cause is handed to
 * the reporter — stderr for the CLI, a log file for the desktop app —
 * instead of vanishing.
 */
export function registerErrorHandler(
  app: FastifyInstance,
  report: UnhandledErrorReporter = reportToStderr,
): void {
  app.setErrorHandler((error: unknown, request, reply) => {
    if (isFastifyClientError(error)) {
      return sendApiError(
        reply,
        error.statusCode,
        clientErrorCode(error.statusCode),
        error.message,
      );
    }
    reportSafely(report, `unhandled error on ${request.method} ${request.url}`, error);
    return sendApiError(reply, 500, 'internal_error', 'internal error');
  });
}

function reportSafely(report: UnhandledErrorReporter, context: string, error: unknown): void {
  try {
    report(context, error);
  } catch (reporterFailure) {
    // a throwing reporter would hand Fastify's default handler a new error
    // to serialize — the reporter never decides what reaches the wire
    console.error('unhandled error reporter failed', reporterFailure);
  }
}

/**
 * Errors Fastify raises before routing — a URL that is not valid
 * percent-encoding, a path segment over `maxParamLength`, an async route
 * constraint failing — never reach `setErrorHandler`, and Fastify's own body
 * would echo the offending URL. Same contract as the handler above: the
 * framework's 4xx keep their status with a fixed message, anything else is
 * the content-free 500 with the cause reported.
 */
export function frameworkErrorHandler(
  report: UnhandledErrorReporter = reportToStderr,
): (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => void {
  return (error, request, reply) => {
    if (isFastifyClientError(error)) {
      void sendApiError(
        reply,
        error.statusCode,
        clientErrorCode(error.statusCode),
        'the request could not be parsed',
      );
      return;
    }
    reportSafely(report, `unhandled error on ${request.method} ${request.url}`, error);
    void sendApiError(reply, 500, 'internal_error', 'internal error');
  };
}
