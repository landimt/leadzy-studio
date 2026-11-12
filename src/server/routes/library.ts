import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  applyLibraryRebake,
  importLibraryItem,
  prepareLibraryRebake,
} from '../../application/library.js';
import { libraryVariablesSchema } from '../../core/libraryItem.js';
import { isInsideEditDir } from '../../core/paths.js';
import { unwrap } from '../../core/result.js';
import type { OverlayTrack } from '../../core/schema.js';
import type { JobManager } from '../jobs.js';
import type { EditWriter } from '../services/editWriter.js';
import { probeMedia } from '../services/ffmpeg.js';
import type { OverlayLibrary } from '../services/library.js';
import { loadEditDoc } from '../services/project.js';
import { safePath, streamWithRange } from '../streaming.js';
import { sendApiError } from './apiError.js';
import { wildcardPath } from './params.js';
import { sendEditDocError } from './editDocError.js';

const libraryIdParamsSchema = z.object({ id: z.string() });

function sendLibraryItemNotFound(reply: FastifyReply): FastifyReply {
  return sendApiError(reply, 404, 'library_item_not_found', 'no library item with this id');
}

export interface LibraryRouteDeps {
  readonly projectDir: string;
  readonly jobs: Pick<JobManager, 'start'>;
  readonly library: Pick<OverlayLibrary, 'list' | 'resolveFile' | 'remove' | 'saveFrom'>;
  readonly editWriter: Pick<EditWriter, 'update'>;
  /** Production measures a duration-parametric overlay through ffprobe; tests inject a stub. */
  readonly libraryOverlayProbe: typeof probeMedia;
}

/** Overlay library items and the HyperFrames jobs (title card, parametric re-bake) that write overlay blocks. */
export function registerLibraryRoutes(app: FastifyInstance, deps: LibraryRouteDeps): void {
  const { projectDir, jobs, library, editWriter, libraryOverlayProbe } = deps;

  const titleBodySchema = z.object({
    text: z.string().optional(),
    style: z.enum(['dark', 'paper', 'plain']).optional(),
    pos: z.enum(['top', 'center']).optional(),
    at: z.number().min(0).optional(),
    durationS: z.number().positive().optional(),
    trackId: z.string().min(1).optional(),
    blockIndex: z.number().int().min(0).optional(),
  });

  app.post('/api/jobs/title', async (request, reply) => {
    const parsedBody = titleBodySchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      return sendApiError(
        reply,
        400,
        'invalid_body',
        'request body must be a JSON object; text, style (dark|paper|plain), pos (top|center), at, durationS, trackId and blockIndex are optional',
      );
    }
    const body = parsedBody.data;
    const id = jobs.start('title', async (progress) => {
      progress('gerando o card com HyperFrames…');
      const { renderTitleCard } = await import('../services/title.js');
      const spec = {
        text: body.text ?? 'Título',
        style: body.style ?? 'dark',
        pos: body.pos ?? 'top',
        durationS: body.durationS ?? 4,
      };
      const assetRel = unwrap(await renderTitleCard(projectDir, spec));
      const block = {
        file: assetRel,
        at: body.at ?? 0.5,
        duration: spec.durationS,
        title: { text: spec.text, style: spec.style, pos: spec.pos },
      };
      await editWriter.update((doc) => {
        const overlayTrack = doc.tracks.find(
          (track): track is OverlayTrack =>
            track.kind === 'overlay' && (body.trackId === undefined || track.id === body.trackId),
        );
        const tracks = overlayTrack
          ? doc.tracks.map((track) => {
              if (track !== overlayTrack) return track;
              const blocks =
                body.blockIndex === undefined
                  ? [...track.blocks, block]
                  : track.blocks.map((existing, i) => (i === body.blockIndex ? block : existing));
              return { ...track, blocks };
            })
          : [...doc.tracks, { id: 'overlays', kind: 'overlay' as const, blocks: [block] }];
        return { ...doc, tracks };
      }, 'title');
      return block;
    });
    if (id === null) {
      return sendApiError(
        reply,
        409,
        'title_in_progress',
        'a title card is already being generated',
      );
    }
    return { id };
  });

  const libraryOverlayBodySchema = z
    .object({
      trackId: z.string().min(1),
      blockIndex: z.number().int().min(0),
      /** The block's current file — identity, so a shifted index cannot retarget the bake. */
      file: z.string().min(1),
      /**
       * The block's current `at`. Twins (the same import placed twice) share
       * the file — without the position, an index shift that lands the OTHER
       * twin at `blockIndex` would satisfy file identity and rewrite it.
       * Optional so agent-authored calls keep working; when absent, twins are
       * only protected by the fallback's ambiguity refusal.
       */
      at: z.number().min(0).optional(),
      variables: libraryVariablesSchema,
    })
    .strict();

  /**
   * Re-bakes an imported parametric library piece with new variable values.
   * The item id comes from the BLOCK, never the request: it is the id the
   * document already validated, and it lands in a filesystem path.
   */
  app.post('/api/jobs/library-overlay', async (request, reply) => {
    const parsedBody = libraryOverlayBodySchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      return sendApiError(
        reply,
        400,
        'invalid_body',
        'request body must be a JSON object with trackId, blockIndex, file, variables and an optional at, and nothing else',
      );
    }
    const body = parsedBody.data;

    const loaded = await loadEditDoc(projectDir);
    if (!loaded.ok) return sendEditDocError(reply, loaded.error);
    const prepared = prepareLibraryRebake(loaded.value.doc, body);
    if (!prepared.ok) {
      return sendApiError(
        reply,
        prepared.code === 'library_block_not_found' ? 404 : 400,
        prepared.code,
        prepared.message,
      );
    }

    const id = jobs.start('library-overlay', async (progress) => {
      progress('regerando a peça com HyperFrames…');
      const { renderLibraryOverlay } = await import('../services/libraryOverlay.js');
      const baked = await applyLibraryRebake(
        projectDir,
        { editWriter, probe: libraryOverlayProbe, render: renderLibraryOverlay, origin: 'ui' },
        prepared.plan,
        body,
      );
      return { file: baked.file };
    });
    if (id === null) {
      return sendApiError(
        reply,
        409,
        'regeneration_in_progress',
        'a piece is already being regenerated',
      );
    }
    return { id };
  });

  // --- overlay library ---------------------------------------------------

  app.get('/api/library', async () => {
    return { items: await library.list() };
  });

  app.get('/api/library/file/:id/*', async (request, reply) => {
    const { id } = libraryIdParamsSchema.parse(request.params);
    const absolute = await library.resolveFile(id, wildcardPath(request));
    if (!absolute) return sendLibraryItemNotFound(reply);
    await streamWithRange(request, reply, absolute);
  });

  app.delete('/api/library/:id', async (request, reply) => {
    const { id } = libraryIdParamsSchema.parse(request.params);
    // a raw EACCES/EBUSY carries the absolute library path: the error handler keeps it off the wire
    const removed = await library.remove(id);
    if (!removed) return sendLibraryItemNotFound(reply);
    return { removed: true };
  });

  const libraryImportBodySchema = z.object({ id: z.string().min(1), at: z.number().min(0) });

  app.post('/api/library/import', async (request, reply) => {
    const parsedBody = libraryImportBodySchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      return sendApiError(
        reply,
        400,
        'invalid_body',
        'request body must be a JSON object with a string "id" and a finite "at" of zero or more seconds',
      );
    }
    const outcome = await importLibraryItem(
      projectDir,
      { library, editWriter, probe: probeMedia, origin: 'ui' },
      parsedBody.data,
    );
    if (!outcome.ok) {
      return outcome.code === 'library_item_not_found'
        ? sendLibraryItemNotFound(reply)
        : sendApiError(reply, 422, outcome.code, outcome.message);
    }
    return { hash: outcome.hash };
  });

  const librarySaveBodySchema = z.object({
    file: z.string().min(1),
    name: z.string(),
    kind: z.string(),
    durationS: z.number().optional(),
  });

  app.post('/api/library/save', async (request, reply) => {
    const parsedBody = librarySaveBodySchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      return sendApiError(
        reply,
        400,
        'invalid_body',
        'request body must be a JSON object with string "file", "name" and "kind" and an optional numeric "durationS"',
      );
    }
    const { file: relative, name, kind, durationS } = parsedBody.data;
    if (!isInsideEditDir(relative)) {
      return sendApiError(reply, 400, 'file_outside_edit_dir', 'file must be inside edit/');
    }
    const absolute = await safePath(projectDir, relative);
    if (!absolute) {
      return sendApiError(
        reply,
        400,
        'path_outside_project',
        'path must stay inside the project folder',
      );
    }

    try {
      const item = await library.saveFrom(absolute, {
        name,
        kind,
        ...(durationS !== undefined ? { durationS } : {}),
      });
      return { item };
    } catch (cause) {
      // saveFrom throws "invalid library item: ..." on a rejected name/kind/
      // durationS — the only failure that traces back to this request's body.
      // Anything else (mkdir/copyFile failing, an id collision) is an
      // unexpected server-side fault the error handler answers for.
      if (cause instanceof Error && cause.message.startsWith('invalid library item:')) {
        return sendApiError(reply, 400, 'invalid_library_item', cause.message);
      }
      throw cause;
    }
  });
}
