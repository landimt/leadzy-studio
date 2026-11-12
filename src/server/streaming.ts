import type { FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { resolveProjectFile } from './services/project.js';

const MEDIA_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
};

/**
 * Resolves a project-relative path to its real absolute location, or null when
 * it escapes the project root — including through a symlink planted inside it.
 */
export async function safePath(projectDir: string, relative: string): Promise<string | null> {
  const resolved = await resolveProjectFile(projectDir, relative);
  return resolved.ok ? resolved.value : null;
}

/** Streams a local file honoring single-range requests (206/416), whole otherwise. */
export async function streamWithRange(
  request: FastifyRequest,
  reply: FastifyReply,
  absolutePath: string,
): Promise<void> {
  const info = await stat(absolutePath);
  const rangeHeader = request.headers.range;
  const extension = extname(absolutePath).toLowerCase();
  const contentType = MEDIA_CONTENT_TYPES[extension] ?? 'application/octet-stream';

  if (rangeHeader === undefined) {
    await reply
      .headers({
        'content-length': info.size,
        'accept-ranges': 'bytes',
        'content-type': contentType,
      })
      .send(createReadStream(absolutePath));
    return;
  }

  const range = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  const rejectRange = async (): Promise<void> => {
    await reply
      .code(416)
      .headers({
        'content-range': `bytes */${String(info.size)}`,
        'accept-ranges': 'bytes',
      })
      .send();
  };
  if (!range || info.size === 0 || (range[1] === '' && range[2] === '')) {
    await rejectRange();
    return;
  }

  let start: number;
  let end: number;
  if (range[1] === '') {
    const suffixLength = Number(range[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      await rejectRange();
      return;
    }
    start = Math.max(0, info.size - suffixLength);
    end = info.size - 1;
  } else {
    start = Number(range[1]);
    const requestedEnd = range[2] === '' ? info.size - 1 : Number(range[2]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(requestedEnd) ||
      start < 0 ||
      start >= info.size ||
      requestedEnd < start
    ) {
      await rejectRange();
      return;
    }
    end = Math.min(requestedEnd, info.size - 1);
  }
  await reply
    .code(206)
    .headers({
      'content-range': `bytes ${String(start)}-${String(end)}/${String(info.size)}`,
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
      'content-type': contentType,
    })
    .send(createReadStream(absolutePath, { start, end }));
}
