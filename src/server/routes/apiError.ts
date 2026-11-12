import type { FastifyReply } from 'fastify';

/**
 * Machine-readable codes for HTTP error responses. The client maps a code to
 * a localized message; `message` is the English fallback for other consumers
 * (agents, curl). It never echoes secrets or server paths; the codes the
 * client shows verbatim (validation detail) may quote the offending field of
 * the request, and only ever land in React text nodes.
 */
export type ApiErrorCode =
  | 'invalid_request'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'internal_error'
  | 'forbidden'
  | 'invalid_body'
  | 'invalid_api_key'
  | 'edit_document_missing'
  | 'invalid_edit_document'
  | 'if_match_required'
  | 'edit_conflict'
  | 'project_busy'
  | 'history_entry_not_found'
  | 'invalid_history_entry'
  | 'path_outside_project'
  | 'reveal_failed'
  | 'invalid_render_options'
  | 'render_in_progress'
  | 'audio_preview_in_progress'
  | 'invalid_query'
  | 'transcript_not_found'
  | 'transcription_in_progress'
  | 'qa_in_progress'
  | 'analysis_in_progress'
  | 'ambiguous_filename'
  | 'invalid_filename'
  | 'unsupported_extension'
  | 'invalid_upload_size'
  | 'upload_too_large'
  | 'empty_upload'
  | 'incomplete_upload'
  | 'invalid_media'
  | 'title_in_progress'
  | 'regeneration_in_progress'
  | 'library_block_not_found'
  | 'library_item_not_found'
  | 'variables_mismatch'
  | 'invalid_variables'
  | 'timing_variable_conflict'
  | 'timing_out_of_range'
  | 'file_outside_edit_dir'
  | 'invalid_library_item'
  | 'library_template_missing'
  | 'library_template_mismatch'
  | 'library_template_unsafe';

export interface ApiErrorBody {
  readonly error: ApiErrorCode;
  readonly message: string;
}

export function sendApiError(
  reply: FastifyReply,
  status: number,
  code: ApiErrorCode,
  message: string,
): FastifyReply {
  const body: ApiErrorBody = { error: code, message };
  return reply.code(status).send(body);
}
