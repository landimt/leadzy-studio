import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from '../../core/result.js';
import type { MediaProbe } from '../../core/render/plan.js';
import type { EditDoc } from '../../core/schema.js';
import { probeMedia, probeProjectAsset } from './ffmpeg.js';
import { resolveProjectFile } from './project.js';

const MEDIA_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi']);
const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.aif',
  '.aiff',
]);
const PROJECT_MEDIA_EXTENSIONS = new Set([...MEDIA_EXTENSIONS, ...AUDIO_EXTENSIONS]);
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
export const PROJECT_IMPORT_EXTENSIONS = new Set([
  ...PROJECT_MEDIA_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
]);

/** Images usable as overlays or canvas backgrounds: project root + edit/assets. */
export async function listImageFiles(projectDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const base of ['', 'edit/assets']) {
    const dir = base === '' ? projectDir : join(projectDir, base);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) found.push(base === '' ? entry.name : `${base}/${entry.name}`);
    }
  }
  return found.sort();
}

/** Top-level media files — the user's originals, never touched. */
export async function listMediaFiles(projectDir: string): Promise<Result<string[]>> {
  try {
    const entries = await readdir(projectDir, { withFileTypes: true });
    const media = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => MEDIA_EXTENSIONS.has(name.slice(name.lastIndexOf('.')).toLowerCase()))
      .sort();
    return ok(media);
  } catch (cause) {
    return err('io-failed', `cannot list "${projectDir}"`, cause);
  }
}

/** Video and audio originals shown in Studio's project media bin. */
export async function listProjectMediaFiles(projectDir: string): Promise<Result<string[]>> {
  try {
    const entries = await readdir(projectDir, { withFileTypes: true });
    const media = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) =>
        PROJECT_MEDIA_EXTENSIONS.has(name.slice(name.lastIndexOf('.')).toLowerCase()),
      )
      .sort();
    return ok(media);
  } catch (cause) {
    return err('io-failed', `cannot list "${projectDir}"`, cause);
  }
}

/** Probe every source plus non-image overlay files (webm needs a duration). */
export async function probeProjectMedia(
  projectDir: string,
  doc: EditDoc,
): Promise<Result<Map<string, MediaProbe>>> {
  const probes = new Map<string, MediaProbe>();
  for (const [key, source] of Object.entries(doc.sources)) {
    const resolved = await resolveProjectFile(projectDir, source.path);
    if (!resolved.ok) return resolved;
    const probed = await probeProjectAsset(resolved.value);
    if (!probed.ok) return probed;
    probes.set(key, probed.value);
  }
  for (const track of doc.tracks) {
    if (track.kind !== 'overlay') continue;
    for (const block of track.blocks) {
      const resolved = await resolveProjectFile(projectDir, block.file);
      if (!resolved.ok) return resolved;
      if (block.duration !== undefined || probes.has(block.file)) continue;
      if (/\.(png|jpg|jpeg|webp)$/i.test(block.file)) continue;
      const probed = await probeMedia(resolved.value);
      if (!probed.ok) return probed;
      probes.set(block.file, probed.value);
    }
  }
  return ok(probes);
}
