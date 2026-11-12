import type { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { z } from 'zod';
import type { VideoEncoder } from '../../core/render/options.js';
import { unwrap } from '../../core/result.js';
import type { StudioDb } from '../../db/index.js';
import type { JobManager } from '../jobs.js';
import type { revealInFileManager } from '../services/reveal.js';
import { renderAudioPreview } from '../services/audioPreview.js';
import { loadEditDoc } from '../services/project.js';
import type { renderProject } from '../services/render.js';
import { deliverFinalExport } from '../services/exportDelivery.js';
import {
  DIRECTORY_PREFERENCE_SCHEMA,
  EXPORT_FILENAME_PATTERN_SCHEMA,
  type UserConfig,
} from '../services/userConfig.js';
import { sendApiError } from './apiError.js';
import { sendEditDocError } from './editDocError.js';

const renderBodySchema = z
  .object({
    preview: z.boolean().optional(),
    /** One-off destination; `null` keeps the final inside the project even when the preferences deliver to a folder. */
    deliveryDirectory: DIRECTORY_PREFERENCE_SCHEMA.nullable().optional(),
    layers: z.enum(['burn', 'omit']).optional(),
    /** Final encode quality; previews ignore it. */
    quality: z.enum(['recommended', 'high', 'max']).optional(),
    /** Burn the captions in (default) or deliver a clean picture for the platform to caption. */
    subtitles: z.boolean().optional(),
    /** Overrides the "reveal after export" preference for this export. */
    reveal: z.boolean().optional(),
    /** Overrides the delivery filename pattern for this export. */
    filenamePattern: EXPORT_FILENAME_PATTERN_SCHEMA.optional(),
  })
  .strict();

export interface RenderRouteDeps {
  readonly projectDir: string;
  readonly jobs: Pick<JobManager, 'start'>;
  /** Production uses the real ffmpeg render service; tests inject a stub. */
  readonly renderer: typeof renderProject;
  readonly userConfig: Pick<UserConfig, 'preferences'>;
  readonly reveal: typeof revealInFileManager;
  /** Opens a fresh index connection; the caller closes it. */
  readonly openDb: () => StudioDb;
  /** Encoder for preview renders; the final always uses libx264. */
  readonly fastVideoEncoder: VideoEncoder;
}

export function registerRenderRoutes(app: FastifyInstance, deps: RenderRouteDeps): void {
  const { projectDir, jobs, renderer, userConfig, reveal, openDb, fastVideoEncoder } = deps;

  app.post('/api/jobs/render', async (request, reply) => {
    const parsedBody = renderBodySchema.safeParse(request.body === undefined ? {} : request.body);
    if (!parsedBody.success) {
      return sendApiError(
        reply,
        400,
        'invalid_render_options',
        'preview must be a boolean, deliveryDirectory must be an absolute path or null, layers must be "burn" or "omit", quality must be "recommended", "high" or "max", subtitles and reveal must be booleans, filenamePattern must be a valid filename pattern, and no other option is accepted',
      );
    }
    const body = parsedBody.data;
    // the program is a preview-resolution artifact by definition
    const preview = body.layers === 'omit' || (body.preview ?? false);
    // Validate the persisted document before publishing a running job. An
    // invalid H.264 canvas must fail this request, not briefly appear as a job
    // that can only fail asynchronously after the 200 response.
    const loaded = await loadEditDoc(projectDir);
    if (!loaded.ok) return sendEditDocError(reply, loaded.error);
    const renderDoc = loaded.value.doc;
    const id = jobs.start('render', async (progress) => {
      const outcome = unwrap(
        await renderer(
          projectDir,
          renderDoc,
          {
            preview,
            videoEncoder: preview ? fastVideoEncoder : 'libx264',
            layers: body.layers ?? 'burn',
            ...(body.quality !== undefined ? { quality: body.quality } : {}),
            // Loudness always follows the canonical edit.json; the CLI keeps
            // --no-loudnorm strictly as an emergency tool. Captions are the
            // one thing a delivery may leave out on purpose.
            subtitles: body.subtitles ?? true,
            loudnorm: true,
          },
          (p) => {
            progress(`[${String(p.index)}/${String(p.total)}] ${p.step}`);
          },
        ),
      );
      // the program is the player's cache, not a delivery — the index only lists previews and finals
      if (outcome.kind === 'preview' || outcome.kind === 'final') {
        const db = openDb();
        try {
          const project = db.upsertProject(projectDir);
          db.recordRender(project.id, outcome.kind, outcome.outputRel, outcome.durationS, null);
        } finally {
          db.close();
        }
      }
      if (preview) return outcome;

      const preferences = await userConfig.preferences();
      const deliveryDirectory =
        body.deliveryDirectory === null
          ? undefined
          : (body.deliveryDirectory ??
            (preferences.exportMode === 'folder'
              ? (preferences.exportDirectory ?? undefined)
              : undefined));
      if (deliveryDirectory === undefined) {
        if (body.reveal ?? preferences.revealAfterExport)
          await reveal(join(projectDir, outcome.outputRel));
        return outcome;
      }

      progress('copiando vídeo para a pasta de entrega…');
      const delivery = await deliverFinalExport(
        projectDir,
        deliveryDirectory,
        body.filenamePattern ?? preferences.exportFilenamePattern,
      );
      if (body.reveal ?? preferences.revealAfterExport) await reveal(delivery.deliveryPath);
      return { ...outcome, ...delivery };
    });
    if (id === null) {
      return sendApiError(reply, 409, 'render_in_progress', 'a render is already running');
    }
    return { id };
  });

  app.post('/api/jobs/audio-preview', async (_request, reply) => {
    const id = jobs.start('audio-preview', async (progress) => {
      const loaded = unwrap(await loadEditDoc(projectDir));
      return unwrap(
        await renderAudioPreview(projectDir, loaded.doc, (p) => {
          progress(`[${String(p.index)}/${String(p.total)}] ${p.step}`);
        }),
      );
    });
    if (id === null) {
      return sendApiError(
        reply,
        409,
        'audio_preview_in_progress',
        'an audio preview is already running',
      );
    }
    return { id };
  });
}
