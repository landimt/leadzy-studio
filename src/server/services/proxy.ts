import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { VideoEncoder } from '../../core/render/options.js';
import { err, ok, type Result } from '../../core/result.js';
import { ffmpegBinary } from './ffmpeg.js';
import { mediaHash } from './mediaHash.js';
import { acquireProjectLock, ProjectLockBusyError } from './projectLock.js';

/**
 * Proxy editing: the player decodes a light 540p copy; the ORIGINAL is what
 * renders. Without this a 4K source stutters in any <video> element.
 */
export function proxyRelPath(mediaRelPath: string): string {
  return `edit/cache/proxy/${basename(mediaRelPath)}.proxy.mp4`;
}

export async function hasFreshProxy(projectDir: string, mediaRelPath: string): Promise<boolean> {
  const hash = await mediaHash(join(projectDir, mediaRelPath));
  if (!hash.ok) return false;
  const stamp = await readFile(join(projectDir, `${proxyRelPath(mediaRelPath)}.hash`), 'utf8')
    .then((text) => text.trim())
    .catch(() => null);
  return stamp === hash.value;
}

export interface ProxyBuildOptions {
  /** Defaults to libx264; the hardware encoder makes first-open proxies near instant. */
  readonly videoEncoder?: VideoEncoder;
}

function proxyEncodeArgs(videoEncoder: VideoEncoder): string[] {
  return videoEncoder === 'h264_videotoolbox'
    ? ['-c:v', 'h264_videotoolbox', '-q:v', '50']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28'];
}

export async function getOrBuildProxy(
  projectDir: string,
  mediaRelPath: string,
  options: ProxyBuildOptions = {},
): Promise<Result<string>> {
  const relative = proxyRelPath(mediaRelPath);
  if (await hasFreshProxy(projectDir, mediaRelPath)) return ok(relative);

  const outputAbs = join(projectDir, relative);
  const temporaryOutput = `${outputAbs}.${String(process.pid)}.${randomUUID()}.tmp.mp4`;
  const temporaryStamp = `${outputAbs}.${String(process.pid)}.${randomUUID()}.tmp.hash`;
  let lock;
  try {
    lock = await acquireProjectLock(projectDir, 'proxy');
  } catch (cause) {
    return err(
      'io-failed',
      cause instanceof ProjectLockBusyError
        ? `proxy generation already in progress for "${mediaRelPath}"`
        : `cannot reserve proxy generation for "${mediaRelPath}"`,
      cause,
    );
  }

  try {
    // Another process may have completed while this one was acquiring the lock.
    if (await hasFreshProxy(projectDir, mediaRelPath)) return ok(relative);

    const hash = await mediaHash(join(projectDir, mediaRelPath));
    if (!hash.ok) return hash;
    const outputDir = dirname(outputAbs);
    const outputName = basename(outputAbs);
    await mkdir(outputDir, { recursive: true });

    // Holding the proxy lock means no live encoder owns these files. Clean up
    // unique staging artifacts left behind if a previous app was force-quit.
    const staleTemporaryFiles = (await readdir(outputDir)).filter(
      (name) =>
        name.startsWith(`${outputName}.`) &&
        (name.endsWith('.tmp.mp4') || name.endsWith('.tmp.hash')),
    );
    await Promise.all(
      staleTemporaryFiles.map((name) => rm(join(outputDir, name), { force: true })),
    );

    await execa(ffmpegBinary(), [
      '-hide_banner',
      '-y',
      '-i',
      join(projectDir, mediaRelPath),
      '-vf',
      "scale='if(gt(iw,ih),-2,540)':'if(gt(iw,ih),540,-2)'",
      ...proxyEncodeArgs(options.videoEncoder ?? 'libx264'),
      '-g',
      '25',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      temporaryOutput,
    ]);

    const currentHash = await mediaHash(join(projectDir, mediaRelPath));
    if (!currentHash.ok) return currentHash;
    if (currentHash.value !== hash.value) {
      return err('io-failed', `source changed while generating proxy for "${mediaRelPath}"`);
    }

    // Publish the complete video first and its receipt last. Readers keep using
    // the original until both renames have completed, never a partial proxy.
    await writeFile(temporaryStamp, hash.value);
    await rename(temporaryOutput, outputAbs);
    await rename(temporaryStamp, `${outputAbs}.hash`);
    return ok(relative);
  } catch (cause) {
    return err('ffmpeg-failed', `proxy generation failed for "${mediaRelPath}"`, cause);
  } finally {
    await Promise.all([
      rm(temporaryOutput, { force: true }).catch(() => undefined),
      rm(temporaryStamp, { force: true }).catch(() => undefined),
    ]);
    await lock.release();
  }
}

/** Warm proxies sequentially without delaying project/server startup. */
export async function warmProxyCache(
  projectDir: string,
  mediaFiles: readonly string[],
  options: ProxyBuildOptions = {},
): Promise<void> {
  for (const file of mediaFiles) {
    const proxy = await getOrBuildProxy(projectDir, file, options);
    if (!proxy.ok && !proxy.error.message.includes('already in progress')) {
      console.warn(`⚠ proxy de ${file} falhou — o player usa o original`);
    }
  }
}
