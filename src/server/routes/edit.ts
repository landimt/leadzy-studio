import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { parseEditDoc } from '../../core/schema.js';
import type { EditHistory } from '../services/editHistory.js';
import { EditConflictError, type EditWriter } from '../services/editWriter.js';
import { editDocHash, loadEditDoc } from '../services/project.js';
import { ProjectLockBusyError } from '../services/projectLock.js';
import { type ApiErrorBody, sendApiError } from './apiError.js';
import { sendEditDocError } from './editDocError.js';

export interface EditRouteDeps {
  readonly projectDir: string;
  readonly history: Pick<EditHistory, 'list' | 'read' | 'record'>;
  readonly editWriter: Pick<EditWriter, 'commit'>;
}

interface EditConflictBody extends ApiErrorBody {
  readonly currentHash: string;
}

const restoreBodySchema = z.object({ id: z.string().min(1) });

/** The two recoverable ways an edit.json commit refuses; anything else is the server's fault. */
function sendCommitFailure(reply: FastifyReply, cause: unknown): FastifyReply {
  if (cause instanceof EditConflictError) {
    const body: EditConflictBody = {
      error: 'edit_conflict',
      message: cause.message,
      currentHash: cause.currentHash,
    };
    return reply.code(409).send(body);
  }
  if (cause instanceof ProjectLockBusyError) {
    return sendApiError(reply, 409, 'project_busy', cause.message);
  }
  throw cause;
}

export function registerEditRoutes(app: FastifyInstance, deps: EditRouteDeps): void {
  const { projectDir, history, editWriter } = deps;

  app.get('/api/edit', async (_request, reply) => {
    const loaded = await loadEditDoc(projectDir);
    if (!loaded.ok) return sendEditDocError(reply, loaded.error);
    return { doc: loaded.value.doc, hash: editDocHash(loaded.value.doc) };
  });

  app.put('/api/edit', async (request, reply) => {
    const parsed = parseEditDoc(request.body);
    if (!parsed.ok) {
      return sendApiError(reply, 422, 'invalid_edit_document', parsed.error.message);
    }
    const expectHash = request.headers['if-match'];
    if (typeof expectHash !== 'string' || expectHash.length === 0) {
      return sendApiError(
        reply,
        428,
        'if_match_required',
        'send the current edit hash in If-Match; reload the project to get it',
      );
    }
    try {
      const hash = await editWriter.commit(parsed.value, 'ui', expectHash);
      return { hash };
    } catch (cause) {
      return sendCommitFailure(reply, cause);
    }
  });

  app.get('/api/history', async () => {
    return { entries: await history.list() };
  });

  app.post('/api/history/restore', async (request, reply) => {
    const parsed = restoreBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendApiError(
        reply,
        400,
        'invalid_body',
        'request body must be a JSON object with a non-empty string "id"',
      );
    }
    const snapshot = await history.read(parsed.data.id);
    if (!snapshot.ok) {
      return snapshot.error.code === 'not-found'
        ? sendApiError(reply, 404, 'history_entry_not_found', 'no history entry with this id')
        : sendApiError(
            reply,
            422,
            'invalid_history_entry',
            'the history snapshot is not a valid edit document',
          );
    }
    try {
      const hash = await editWriter.commit(snapshot.value, 'restore');
      return { hash };
    } catch (cause) {
      return sendCommitFailure(reply, cause);
    }
  });
}
