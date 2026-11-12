import type { FastifyReply } from 'fastify';
import type { StudioError } from '../../core/result.js';
import { type ApiErrorCode, sendApiError } from './apiError.js';

export interface ClientErrorResponse {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly message: string;
}

export const EDIT_DOC_MISSING_MESSAGE = 'no edit.json in this project — run `studio open` first';

/**
 * The answers a failed loadEditDoc owes the client. A validation failure
 * carries its detail — field paths and reasons from the document itself,
 * including a source path the user wrote into it, which is what they need
 * to fix; `undefined` means the failure is the server's, not the request's.
 */
export function editDocClientError(error: StudioError): ClientErrorResponse | undefined {
  switch (error.code) {
    case 'not-found':
      return { status: 404, code: 'edit_document_missing', message: EDIT_DOC_MISSING_MESSAGE };
    case 'invalid-edit-json':
      return { status: 422, code: 'invalid_edit_document', message: error.message };
    default:
      return undefined;
  }
}

/** Answers a failed loadEditDoc, or throws so the error handler answers a content-free 500 and logs the cause. */
export function sendEditDocError(reply: FastifyReply, error: StudioError): FastifyReply {
  const response = editDocClientError(error);
  if (response === undefined) {
    throw new Error(`cannot read edit.json: ${error.message}`, { cause: error.cause });
  }
  return sendApiError(reply, response.status, response.code, response.message);
}
