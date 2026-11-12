import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { copyFile, link, mkdir, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ImageMediaProbe, MediaSummary, TimedMediaProbe } from '../../core/media.js';
import type { Result } from '../../core/result.js';
import { probeProjectAsset, probeStillImage } from './ffmpeg.js';
import { IMAGE_EXTENSIONS, PROJECT_IMPORT_EXTENSIONS } from './projectMedia.js';

/** A deliberately high desktop-media ceiling, enforced without buffering. */
export const MAX_MEDIA_IMPORT_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_IMAGE_IMPORT_BYTES = 50 * 1024 * 1024;

export type ImportedMediaSummary = MediaSummary;

export type MediaImportErrorCode =
  | 'invalid-filename'
  | 'unsupported-extension'
  | 'empty-upload'
  | 'incomplete-upload'
  | 'payload-too-large'
  | 'invalid-media'
  | 'io-failed';

export class MediaImportError extends Error {
  constructor(
    readonly code: MediaImportErrorCode,
    readonly statusCode: 400 | 413 | 415 | 422 | 500,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MediaImportError';
  }
}

type ProbeMedia = (absolutePath: string) => Promise<Result<TimedMediaProbe>>;
type ProbeImage = (absolutePath: string) => Promise<Result<ImageMediaProbe>>;

export interface MediaImportOptions {
  readonly expectedBytes?: number;
  readonly maxBytes?: number;
  /** Test seam; production always uses the existing ffprobe service. */
  readonly probe?: ProbeMedia;
  /** Test seam; production validates still-image codec and geometry via ffprobe. */
  readonly probeStillImage?: ProbeImage;
  /** Test seam for filesystems without hard-link support. */
  readonly linkFile?: typeof link;
}

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[ .]|$)/i;
const WINDOWS_INVALID_CHARACTER = /[<>:"/\\|?*]/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const HARDLINK_FALLBACK_ERRORS = new Set(['EACCES', 'EPERM', 'ENOTSUP', 'EXDEV', 'EMLINK']);

/**
 * Accept one portable leaf filename. Unicode is normalized so canonically
 * equivalent names collide consistently instead of creating lookalike files.
 */
export function normalizeMediaFilename(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0 || input.trim().length === 0) {
    throw new MediaImportError('invalid-filename', 400, 'filename is missing or invalid');
  }
  const filename = input.normalize('NFC');
  if (
    filename === '.' ||
    filename === '..' ||
    CONTROL_CHARACTER.test(filename) ||
    WINDOWS_INVALID_CHARACTER.test(filename) ||
    /[. ]$/.test(filename) ||
    WINDOWS_DEVICE_NAME.test(filename) ||
    Buffer.byteLength(filename, 'utf8') > 240
  ) {
    throw new MediaImportError(
      'invalid-filename',
      400,
      'filename contains a path or invalid characters',
    );
  }
  const extension = extname(filename).toLowerCase();
  if (!PROJECT_IMPORT_EXTENSIONS.has(extension)) {
    throw new MediaImportError(
      'unsupported-extension',
      415,
      `unsupported format: ${extension || 'no extension'}`,
    );
  }
  return filename;
}

/** Filename-aware route ceiling; importMedia independently enforces the same cap while streaming. */
export function mediaImportByteLimit(requestedFilename: unknown): number {
  const filename = normalizeMediaFilename(requestedFilename);
  return IMAGE_EXTENSIONS.has(extname(filename).toLowerCase())
    ? MAX_IMAGE_IMPORT_BYTES
    : MAX_MEDIA_IMPORT_BYTES;
}

function importLimitMessage(image: boolean): string {
  return image ? 'image exceeds the 50 MiB import limit' : 'media exceeds the 4 GiB import limit';
}

class ImportSizeLimitError extends Error {}

function byteLimit(maxBytes: number, onBytes: (received: number) => void): Transform {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      onBytes(received);
      if (received > maxBytes) {
        callback(new ImportSizeLimitError('media import exceeds its byte limit'));
        return;
      }
      callback(null, chunk);
    },
  });
}

function errorCode(cause: unknown): string | undefined {
  return cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined;
}

async function publishExclusive(
  temporary: string,
  destination: string,
  linkFile: typeof link,
): Promise<'published' | 'collision'> {
  try {
    await linkFile(temporary, destination);
    return 'published';
  } catch (cause) {
    const code = errorCode(cause);
    if (code === 'EEXIST') return 'collision';
    if (!HARDLINK_FALLBACK_ERRORS.has(code ?? '')) throw cause;
  }

  try {
    await copyFile(temporary, destination, constants.COPYFILE_EXCL);
    return 'published';
  } catch (cause) {
    if (errorCode(cause) === 'EEXIST') return 'collision';
    throw cause;
  }
}

function collisionName(filename: string, index: number): string {
  if (index === 0) return filename;
  const extension = extname(filename);
  const stem = filename.slice(0, -extension.length);
  return `${stem} (${String(index)})${extension}`;
}

/**
 * Streams an upload to a private temporary file, probes the complete bytes,
 * then publishes one collision-free name without overwriting. Timeline media
 * stays at the project root; still images live under edit/assets.
 */
export async function importMedia(
  projectDir: string,
  requestedFilename: unknown,
  source: Readable,
  options: MediaImportOptions = {},
): Promise<ImportedMediaSummary> {
  const filename = normalizeMediaFilename(requestedFilename);
  const isImage = IMAGE_EXTENSIONS.has(extname(filename).toLowerCase());
  const configuredMaxBytes = options.maxBytes ?? MAX_MEDIA_IMPORT_BYTES;
  const maxBytes = isImage
    ? Math.min(configuredMaxBytes, MAX_IMAGE_IMPORT_BYTES)
    : configuredMaxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new MediaImportError('io-failed', 500, 'invalid import byte limit');
  }
  if (options.expectedBytes !== undefined) {
    if (!Number.isSafeInteger(options.expectedBytes) || options.expectedBytes < 0) {
      throw new MediaImportError('incomplete-upload', 400, 'invalid upload size');
    }
    if (options.expectedBytes > maxBytes) {
      throw new MediaImportError('payload-too-large', 413, importLimitMessage(isImage));
    }
  }

  const importDir = join(projectDir, 'edit', 'cache', 'media-imports');
  const temporary = join(importDir, `${randomUUID()}.upload`);
  let receivedBytes = 0;
  let firstStreamFailure: 'source' | 'destination' | undefined;
  const rememberSourceFailure = (): void => {
    firstStreamFailure ??= 'source';
  };
  source.once('error', rememberSourceFailure);

  try {
    await mkdir(importDir, { recursive: true });
    const destination = createWriteStream(temporary, { flags: 'wx' });
    const rememberDestinationFailure = (): void => {
      firstStreamFailure ??= 'destination';
    };
    destination.once('error', rememberDestinationFailure);
    try {
      await pipeline(
        source,
        byteLimit(maxBytes, (received) => {
          receivedBytes = received;
        }),
        destination,
      );
    } catch (cause) {
      if (cause instanceof ImportSizeLimitError) {
        throw new MediaImportError('payload-too-large', 413, importLimitMessage(isImage), cause);
      }
      if (firstStreamFailure === 'source') {
        throw new MediaImportError('incomplete-upload', 400, 'upload interrupted', cause);
      }
      throw new MediaImportError('io-failed', 500, 'could not receive the media', cause);
    } finally {
      destination.off('error', rememberDestinationFailure);
    }

    if (receivedBytes === 0) {
      throw new MediaImportError('empty-upload', 400, 'the uploaded media is empty');
    }
    if (options.expectedBytes !== undefined && receivedBytes !== options.expectedBytes) {
      throw new MediaImportError('incomplete-upload', 400, 'upload incomplete');
    }

    const probed = isImage
      ? await (options.probeStillImage ?? probeStillImage)(temporary)
      : await (options.probe ?? probeProjectAsset)(temporary);
    if (!probed.ok) {
      throw new MediaImportError(
        'invalid-media',
        422,
        'the uploaded file does not contain valid media',
        probed.error,
      );
    }

    const destinationDir = isImage ? join(projectDir, 'edit', 'assets') : projectDir;
    await mkdir(destinationDir, { recursive: true });
    let destinationName = '';
    for (let suffix = 0; ; suffix += 1) {
      const candidate = collisionName(filename, suffix);
      const outcome = await publishExclusive(
        temporary,
        join(destinationDir, candidate),
        options.linkFile ?? link,
      );
      if (outcome === 'published') {
        destinationName = isImage ? `edit/assets/${candidate}` : candidate;
        break;
      }
    }
    // Publication already succeeded. A transient unlink failure must not turn
    // that success into a retry that creates a duplicate collision suffix;
    // the finally block makes a second best-effort cleanup attempt.
    await rm(temporary, { force: true }).catch(() => undefined);
    switch (probed.value.kind) {
      case 'video':
        return {
          kind: 'video',
          relPath: destinationName,
          durationS: probed.value.durationS,
          fps: probed.value.fps,
          width: probed.value.width,
          height: probed.value.height,
          hasAudio: probed.value.hasAudio,
          transcriptEngine: null,
          proxyRelPath: null,
        };
      case 'audio':
        return {
          kind: 'audio',
          relPath: destinationName,
          durationS: probed.value.durationS,
          hasAudio: true,
          transcriptEngine: null,
          proxyRelPath: null,
        };
      case 'image':
        return {
          kind: 'image',
          relPath: destinationName,
          width: probed.value.width,
          height: probed.value.height,
          hasAudio: false,
          transcriptEngine: null,
          proxyRelPath: null,
        };
    }
  } catch (cause) {
    if (cause instanceof MediaImportError) throw cause;
    throw new MediaImportError('io-failed', 500, 'could not import the media', cause);
  } finally {
    source.off('error', rememberSourceFailure);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
