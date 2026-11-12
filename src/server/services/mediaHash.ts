import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { err, ok, type Result } from '../../core/result.js';

/**
 * Identity of a media inode for cache/receipt purposes. Path and ctime are
 * deliberately excluded: a render job pins the inode with a temporary
 * hardlink, whose creation/removal changes both without changing media bytes.
 * dev+ino+size+mtime still invalidates replacement and in-place edits without
 * content-hashing a 1GB source on every open.
 */
export async function mediaHash(absolutePath: string): Promise<Result<string>> {
  try {
    const info = await stat(absolutePath);
    const digest = createHash('sha1')
      .update(
        `${String(info.dev)}:${String(info.ino)}:${String(info.size)}:${String(info.mtimeMs)}`,
      )
      .digest('hex');
    return ok(digest);
  } catch (cause) {
    return err('io-failed', `cannot stat "${absolutePath}"`, cause);
  }
}
