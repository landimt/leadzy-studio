import type { FastifyInstance, FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import {
  type importMedia,
  MAX_MEDIA_IMPORT_BYTES,
  mediaImportByteLimit,
  MediaImportError,
  type MediaImportErrorCode,
} from '../services/mediaImport.js';
import type { getOrBuildPeaks } from '../services/waveform.js';
import { safePath, streamWithRange } from '../streaming.js';
import { type ApiErrorCode, sendApiError } from './apiError.js';
import { wildcardPath } from './params.js';

export interface MediaRouteDeps {
  readonly projectDir: string;
  /** Production streams into the project through importMedia; tests inject a stub importer. */
  readonly mediaImporter: typeof importMedia;
  /** Production builds waveform peaks through ffmpeg; tests inject a stub. */
  readonly peaks: typeof getOrBuildPeaks;
}

/** Import failures the client can act on; `io-failed` is the server's and goes through the error handler. */
const IMPORT_ERROR_CODE: Record<Exclude<MediaImportErrorCode, 'io-failed'>, ApiErrorCode> = {
  'invalid-filename': 'invalid_filename',
  'unsupported-extension': 'unsupported_extension',
  'empty-upload': 'empty_upload',
  'incomplete-upload': 'incomplete_upload',
  'payload-too-large': 'upload_too_large',
  'invalid-media': 'invalid_media',
};

function sendImportError(reply: FastifyReply, cause: MediaImportError): FastifyReply {
  if (cause.code === 'io-failed') throw cause;
  return sendApiError(reply, cause.statusCode, IMPORT_ERROR_CODE[cause.code], cause.message);
}

/**
 * The raw upload relies on the root-level `application/octet-stream` parser
 * registered in startServer; the route-level bodyLimit below must stay in
 * step with that parser's ceiling.
 */
export function registerMediaRoutes(app: FastifyInstance, deps: MediaRouteDeps): void {
  const { projectDir, mediaImporter, peaks: buildPeaks } = deps;

  app.post<{ Querystring: { filename?: unknown }; Body: unknown }>(
    '/api/media/import',
    { bodyLimit: MAX_MEDIA_IMPORT_BYTES },
    async (request, reply) => {
      // only the octet-stream parser hands the handler a stream; any other
      // content type arrives parsed (or absent) and cannot be imported
      if (!(request.body instanceof Readable)) {
        return sendApiError(
          reply,
          415,
          'unsupported_media_type',
          'the upload must be sent as application/octet-stream',
        );
      }
      const upload = request.body;
      const queryFilename = request.query.filename;
      const headerFilename = request.headers['x-file-name'];
      const discardUnreadUpload = (): void => {
        if (!upload.destroyed && !upload.readableEnded) upload.resume();
      };

      if (
        queryFilename !== undefined &&
        headerFilename !== undefined &&
        queryFilename !== headerFilename
      ) {
        discardUnreadUpload();
        return sendApiError(
          reply,
          400,
          'ambiguous_filename',
          'the filename query parameter and the x-file-name header disagree',
        );
      }
      const requestedFilename = queryFilename ?? headerFilename;
      let importByteLimit: number;
      try {
        importByteLimit = mediaImportByteLimit(requestedFilename);
      } catch (cause) {
        discardUnreadUpload();
        if (cause instanceof MediaImportError) return sendImportError(reply, cause);
        throw cause;
      }

      const rawContentLength = request.headers['content-length'];
      let expectedBytes: number | undefined;
      if (rawContentLength !== undefined) {
        expectedBytes = Number(rawContentLength);
        if (!/^\d+$/.test(rawContentLength) || !Number.isSafeInteger(expectedBytes)) {
          discardUnreadUpload();
          return sendApiError(
            reply,
            400,
            'invalid_upload_size',
            'content-length is not a byte count',
          );
        }
        if (expectedBytes > importByteLimit) {
          discardUnreadUpload();
          return sendApiError(
            reply,
            413,
            'upload_too_large',
            `upload exceeds the import limit of ${String(importByteLimit)} bytes for this file type`,
          );
        }
      }

      try {
        const item = await mediaImporter(projectDir, requestedFilename, upload, {
          maxBytes: importByteLimit,
          ...(expectedBytes !== undefined ? { expectedBytes } : {}),
        });
        return await reply.code(201).send({ item });
      } catch (cause) {
        discardUnreadUpload();
        if (cause instanceof MediaImportError) return sendImportError(reply, cause);
        throw cause;
      }
    },
  );

  app.get('/api/media/*', async (request, reply) => {
    const absolute = await safePath(projectDir, wildcardPath(request));
    if (!absolute) {
      return sendApiError(
        reply,
        403,
        'path_outside_project',
        'path must stay inside the project folder',
      );
    }
    await streamWithRange(request, reply, absolute);
  });

  app.get('/api/peaks/*', async (request, reply) => {
    const relative = wildcardPath(request);
    if (!(await safePath(projectDir, relative))) {
      return sendApiError(
        reply,
        403,
        'path_outside_project',
        'path must stay inside the project folder',
      );
    }
    const peaks = await buildPeaks(projectDir, relative);
    if (!peaks.ok) {
      throw new Error(`cannot build peaks: ${peaks.error.message}`, { cause: peaks.error.cause });
    }
    return peaks.value;
  });
}
