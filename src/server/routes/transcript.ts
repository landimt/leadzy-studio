import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { unwrap } from '../../core/result.js';
import type { StudioDb } from '../../db/index.js';
import { suggestCuts } from '../../application/suggestCuts.js';
import { transcribeProject } from '../../application/transcribeProject.js';
import type { JobManager } from '../jobs.js';
import type { EditWriter } from '../services/editWriter.js';
import { resolveElevenLabsApiKey } from '../services/userConfig.js';
import { loadEditDoc } from '../services/project.js';
import { runQa } from '../services/qa.js';
import { readCachedTranscript } from '../services/transcribe.js';
import { sendApiError } from './apiError.js';
import { wildcardPath } from './params.js';

export interface TranscriptRouteDeps {
  readonly projectDir: string;
  readonly jobs: Pick<JobManager, 'start'>;
  readonly editWriter: Pick<EditWriter, 'commit'>;
  /** Opens a fresh index connection; the caller closes it. */
  readonly openDb: () => StudioDb;
}

/** `{ engine }` is a client from before Scribe became the only engine — refuse instead of billing silently. */
const emptyBodySchema = z.strictObject({});
const transcribeBodySchema = z.strictObject({ force: z.boolean().optional() });
const suggestBodySchema = z.object({
  thresholdDb: z.number().optional(),
  minSilenceS: z.number().positive().optional(),
});
const searchQuerySchema = z.object({ q: z.string().optional() });

const EMPTY_BODY_MESSAGE = 'request body must be an empty JSON object';
const TRANSCRIBE_BODY_MESSAGE = 'request body must be a JSON object with at most a boolean "force"';
const SUGGEST_BODY_MESSAGE =
  'request body must be a JSON object; "thresholdDb" must be a number and "minSilenceS" a positive number';

export function registerTranscriptRoutes(app: FastifyInstance, deps: TranscriptRouteDeps): void {
  const { projectDir, jobs, editWriter, openDb } = deps;

  app.get('/api/transcript/*', async (request, reply) => {
    const transcript = await readCachedTranscript(projectDir, wildcardPath(request));
    if (!transcript) {
      return sendApiError(reply, 404, 'transcript_not_found', 'no transcript for this media');
    }
    return transcript;
  });

  app.post('/api/jobs/transcribe', async (request, reply) => {
    const parsed = transcribeBodySchema.safeParse(request.body === undefined ? {} : request.body);
    if (!parsed.success) return sendApiError(reply, 400, 'invalid_body', TRANSCRIBE_BODY_MESSAGE);
    const force = parsed.data.force === true;
    const { key: apiKey } = await resolveElevenLabsApiKey();
    const id = jobs.start('transcribe', async (progress) => {
      progress('transcrevendo mídias pendentes…');
      return unwrap(
        await transcribeProject(projectDir, {
          ...(apiKey !== undefined ? { apiKey } : {}),
          force,
          assumeYes: true,
          onProgress: progress,
        }),
      );
    });
    if (id === null) {
      return sendApiError(
        reply,
        409,
        'transcription_in_progress',
        'a transcription is already running',
      );
    }
    return { id };
  });

  app.post('/api/jobs/qa', async (request, reply) => {
    const parsed = emptyBodySchema.safeParse(request.body === undefined ? {} : request.body);
    if (!parsed.success) return sendApiError(reply, 400, 'invalid_body', EMPTY_BODY_MESSAGE);
    const { key: apiKey } = await resolveElevenLabsApiKey();
    const id = jobs.start('qa', async (progress) => {
      progress('retranscrevendo o vídeo final…');
      const loaded = unwrap(await loadEditDoc(projectDir));
      const report = unwrap(
        await runQa(projectDir, loaded.doc, {
          ...(apiKey !== undefined ? { apiKey } : {}),
        }),
      );
      const db = openDb();
      try {
        const project = db.upsertProject(projectDir);
        db.setRenderQa(project.id, 'edit/final.mp4', report.ok);
      } finally {
        db.close();
      }
      return report;
    });
    if (id === null)
      return sendApiError(reply, 409, 'qa_in_progress', 'a QA pass is already running');
    return { id };
  });

  app.post('/api/jobs/suggest', async (request, reply) => {
    const parsed = suggestBodySchema.safeParse(request.body === undefined ? {} : request.body);
    if (!parsed.success) return sendApiError(reply, 400, 'invalid_body', SUGGEST_BODY_MESSAGE);
    const { thresholdDb, minSilenceS } = parsed.data;
    const id = jobs.start('suggest', async (progress) => {
      progress('analisando pausas e repetições…');
      return unwrap(
        await suggestCuts(
          projectDir,
          {
            ...(thresholdDb !== undefined ? { thresholdDb } : {}),
            ...(minSilenceS !== undefined ? { minSilenceS } : {}),
          },
          (doc, expectHash) => editWriter.commit(doc, 'suggest', expectHash),
          progress,
        ),
      );
    });
    if (id === null) {
      return sendApiError(reply, 409, 'analysis_in_progress', 'a cut analysis is already running');
    }
    return { id };
  });

  app.get('/api/search', (request, reply) => {
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendApiError(reply, 400, 'invalid_query', '"q" must be a single string');
    }
    const { q } = parsed.data;
    if (q === undefined || q === '') return { hits: [] };
    const db = openDb();
    try {
      return { hits: db.search(q) };
    } finally {
      db.close();
    }
  });
}
