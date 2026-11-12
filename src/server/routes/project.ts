import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AUDIO_PREVIEW_BEFORE_OUTPUT_PATH,
  AUDIO_PREVIEW_OUTPUT_PATH,
} from '../../core/audioPreviewPlan.js';
import { audioPreviewSemanticKey } from '../../core/audioPreviewFreshness.js';
import type { MediaSummary } from '../../core/media.js';
import { ffmpegCapabilities, probeProjectAsset, type probeStillImage } from '../services/ffmpeg.js';
import { transcriptionKeyterms } from '../../core/schema.js';
import { editDocHash, editJsonPath, loadEditDoc } from '../services/project.js';
import { listImageFiles, listProjectMediaFiles } from '../services/projectMedia.js';
import { renderSnapshotHash, renderSnapshotInfo } from '../services/renderReceipt.js';
import { hasFreshProxy, proxyRelPath } from '../services/proxy.js';
import {
  readCachedTranscript,
  transcriptCachePath,
  transcriptCacheState,
} from '../services/transcribe.js';
import { resolveElevenLabsApiKey } from '../services/userConfig.js';
import { safePath } from '../streaming.js';
import { programKey } from '../../core/render/freshness.js';
import type { revealInFileManager } from '../services/reveal.js';
import { sendApiError } from './apiError.js';

interface AgentAvailability {
  readonly claude: boolean;
  readonly codex: boolean;
}

export interface ProjectRouteDeps {
  readonly projectDir: string;
  /** Production probes through ffprobe; tests inject a stub. */
  readonly imageProbe: typeof probeStillImage;
  readonly agents: AgentAvailability;
  /** Production opens the desktop file manager; tests inject a stub. */
  readonly reveal: typeof revealInFileManager;
}

const revealBodySchema = z.object({ path: z.string().min(1) });

export function registerProjectRoutes(app: FastifyInstance, deps: ProjectRouteDeps): void {
  const { projectDir, imageProbe, agents, reveal } = deps;

  app.get('/api/project', async () => {
    const ffmpeg = await ffmpegCapabilities();
    const media = await listProjectMediaFiles(projectDir);
    const images = await listImageFiles(projectDir);
    const loaded = await loadEditDoc(projectDir);
    // No document: nothing primes the transcript. An unreadable one: unknown
    // keyterms, so no staleness is claimed (a claim would invite a re-bill).
    const keyterms = loaded.ok
      ? transcriptionKeyterms(loaded.value.doc)
      : existsSync(editJsonPath(projectDir))
        ? null
        : [];
    const summaries: MediaSummary[] = [];
    if (media.ok) {
      for (const relPath of media.value) {
        const probe = await probeProjectAsset(join(projectDir, relPath));
        if (!probe.ok) continue;
        const transcript = await readCachedTranscript(projectDir, relPath);
        const transcriptUpdatedAt = transcript
          ? await stat(transcriptCachePath(projectDir, relPath))
              .then((cache) => cache.mtime.toISOString())
              .catch(() => null)
          : null;
        const transcriptState =
          keyterms !== null
            ? await transcriptCacheState(
                transcriptCachePath(projectDir, relPath),
                join(projectDir, relPath),
                keyterms,
              )
            : undefined;
        summaries.push(
          probe.value.kind === 'video'
            ? {
                kind: 'video',
                relPath,
                durationS: probe.value.durationS,
                fps: probe.value.fps,
                width: probe.value.width,
                height: probe.value.height,
                hasAudio: probe.value.hasAudio,
                transcriptEngine: transcript?.engine ?? null,
                transcriptUpdatedAt,
                ...(transcriptState !== undefined ? { transcriptState } : {}),
                proxyRelPath: (await hasFreshProxy(projectDir, relPath))
                  ? proxyRelPath(relPath)
                  : null,
              }
            : {
                kind: 'audio',
                relPath,
                durationS: probe.value.durationS,
                hasAudio: true,
                transcriptEngine: transcript?.engine ?? null,
                transcriptUpdatedAt,
                ...(transcriptState !== undefined ? { transcriptState } : {}),
                proxyRelPath: null,
              },
        );
      }
    }
    for (const relPath of images) {
      const probe = await imageProbe(join(projectDir, relPath));
      if (!probe.ok) continue;
      summaries.push({
        kind: 'image',
        relPath,
        width: probe.value.width,
        height: probe.value.height,
        hasAudio: false,
        transcriptEngine: null,
        proxyRelPath: null,
      });
    }
    summaries.sort((a, b) => a.relPath.localeCompare(b.relPath));
    const { key: elevenLabsKey } = await resolveElevenLabsApiKey();
    const audioPreviewSnapshot = await renderSnapshotInfo(projectDir, 'audio-preview');
    const programSnapshot = await renderSnapshotInfo(projectDir, 'program');
    const hasAudioPreview = existsSync(join(projectDir, AUDIO_PREVIEW_OUTPUT_PATH));
    const hasAudioComparison =
      existsSync(join(projectDir, AUDIO_PREVIEW_BEFORE_OUTPUT_PATH)) && hasAudioPreview;
    const audioPreviewCurrent =
      hasAudioComparison &&
      loaded.ok &&
      audioPreviewSnapshot !== null &&
      audioPreviewSemanticKey(audioPreviewSnapshot.doc) ===
        audioPreviewSemanticKey(loaded.value.doc);
    return {
      projectDir,
      media: summaries,
      images,
      doc: loaded.ok ? loaded.value.doc : null,
      editHash: loaded.ok ? editDocHash(loaded.value.doc) : null,
      warnings: loaded.ok ? loaded.value.warnings : [],
      apiKeyPresent: elevenLabsKey !== undefined,
      ffmpeg: ffmpeg.ok
        ? { ok: true, message: ffmpeg.value.version }
        : { ok: false, message: ffmpeg.error.message },
      hasPreview: existsSync(join(projectDir, 'edit', 'preview.mp4')),
      previewEditHash: await renderSnapshotHash(projectDir, 'preview'),
      hasAudioPreview,
      hasAudioComparison,
      audioPreviewEditHash: audioPreviewSnapshot?.editHash ?? null,
      audioPreviewCurrent,
      hasFinal: existsSync(join(projectDir, 'edit', 'final.mp4')),
      hasProgram: existsSync(join(projectDir, 'edit', 'program.mp4')),
      programKey: programSnapshot === null ? null : programKey(programSnapshot.doc),
      agents,
    };
  });

  app.post('/api/reveal', async (request, reply) => {
    const parsed = revealBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendApiError(
        reply,
        400,
        'invalid_body',
        'request body must be a JSON object with a non-empty string "path"',
      );
    }
    const absolute = await safePath(projectDir, parsed.data.path);
    if (!absolute) {
      return sendApiError(
        reply,
        400,
        'path_outside_project',
        'path must stay inside the project folder and exist',
      );
    }
    try {
      await reveal(absolute);
      return { ok: true };
    } catch (cause) {
      console.warn('reveal: failed to open the file manager', cause);
      return sendApiError(reply, 500, 'reveal_failed', 'could not open the file manager');
    }
  });
}
