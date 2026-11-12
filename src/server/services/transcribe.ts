import { createHash, randomUUID } from 'node:crypto';
import { existsSync, openAsBlob } from 'node:fs';
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { err, ok, type Result } from '../../core/result.js';
import {
  parseScribeTranscript,
  parseTranscriptCacheMeta,
  parseTranscriptFile,
  TRANSCRIPT_CACHE_MODEL,
  type Transcript,
  type TranscriptCacheMeta,
  type TranscriptFreshness,
} from '../../core/transcript.js';
import {
  extractAudioForTranscription,
  TRANSCRIPTION_AUDIO_EXTENSION,
  TRANSCRIPTION_AUDIO_MIME,
} from './audio.js';

const SCRIBE_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
/** Upload plus processing of an hour of audio fits comfortably; anything longer is a hung request. */
export const TRANSCRIBE_TIMEOUT_MS = 10 * 60_000;
/** Two retries after the first attempt, spaced so a burst of 429s clears. */
const RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];
const ERROR_BODY_CHARS = 200;

/** `take.mp4` → `edit/transcripts/take.mp4.json`; two media that differ only by extension never share a cache. */
export function transcriptCachePath(projectDir: string, mediaRelPath: string): string {
  return join(projectDir, 'edit', 'transcripts', `${basename(mediaRelPath)}.json`);
}

/** Where replaced source-transcript caches go; the QA cache is not archived. */
export function transcriptArchiveDir(projectDir: string): string {
  return join(projectDir, 'edit', 'history', 'transcripts');
}

/** What Scribe is actually told: trimmed, no blanks, no repeats, in authored order. */
export function normalizeKeyterms(keyterms: readonly string[]): readonly string[] {
  return [...new Set(keyterms.map((term) => term.trim()).filter((term) => term !== ''))];
}

const SAMPLE_BYTES = 1024 * 1024;

/**
 * Identity of the media CONTENT for the transcript cache: size plus a digest
 * of the first and last MiB. A copy, a move to another disk or a cloud
 * re-download keeps it (unlike the inode-based render fingerprint), a
 * re-export or a trimmed take changes it, and a 1 GB source costs two reads.
 */
export interface ReadableHandle {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
}

/** A single `read` may fill less than asked (network mounts); the digest must see every byte. */
export async function readFully(
  handle: ReadableHandle,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

export async function transcriptMediaFingerprint(mediaAbs: string): Promise<Result<string>> {
  try {
    const info = await stat(mediaAbs);
    const handle = await open(mediaAbs, 'r');
    try {
      const head = await readFully(handle, Math.min(SAMPLE_BYTES, info.size), 0);
      const tailStart = Math.max(0, info.size - SAMPLE_BYTES);
      const tail = await readFully(handle, info.size - tailStart, tailStart);
      return ok(
        createHash('sha1').update(String(info.size)).update(head).update(tail).digest('hex'),
      );
    } finally {
      await handle.close();
    }
  } catch (cause) {
    return err('io-failed', `cannot read "${mediaAbs}"`, cause);
  }
}

/** Order does not change what Scribe is told, so it does not change the fingerprint. */
export function keytermsFingerprint(keyterms: readonly string[]): string {
  const normalized = [...normalizeKeyterms(keyterms)].sort();
  return createHash('sha1').update(JSON.stringify(normalized)).digest('hex');
}

async function readJson(path: string): Promise<unknown> {
  return readFile(path, 'utf8')
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);
}

export async function readCachedTranscript(
  projectDir: string,
  mediaRelPath: string,
): Promise<Transcript | null> {
  const parsed = parseTranscriptFile(await readJson(transcriptCachePath(projectDir, mediaRelPath)));
  return parsed.ok ? parsed.value : null;
}

export interface TranscriptCacheInspection {
  readonly state: TranscriptFreshness;
  /** The header of a cache the current engine can read; `null` when there is none. */
  readonly meta: TranscriptCacheMeta | null;
}

/**
 * One read of the cache file decides everything: a file the current engine
 * cannot parse in full counts as missing (it would never be served), then
 * the stat-based media fingerprint, then the keyterms.
 */
export async function inspectTranscriptCache(
  cacheAbs: string,
  mediaAbs: string,
  keyterms: readonly string[],
): Promise<TranscriptCacheInspection> {
  const raw = await readJson(cacheAbs);
  const meta = parseTranscriptCacheMeta(raw);
  if (meta === null || !parseTranscriptFile(raw).ok) return { state: 'missing', meta: null };
  const hash = await transcriptMediaFingerprint(mediaAbs);
  if (!hash.ok || meta.sourceHash !== hash.value) return { state: 'stale-media', meta };
  return {
    state: meta.keytermsHash === keytermsFingerprint(keyterms) ? 'fresh' : 'stale-keyterms',
    meta,
  };
}

export async function transcriptCacheState(
  cacheAbs: string,
  mediaAbs: string,
  keyterms: readonly string[],
): Promise<TranscriptFreshness> {
  return (await inspectTranscriptCache(cacheAbs, mediaAbs, keyterms)).state;
}

export interface ScribeRequest {
  readonly apiKey: string;
  readonly audioAbs: string;
  readonly keyterms: readonly string[];
}

export interface ScribeDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly openAudio: (path: string) => Promise<Blob>;
}

const DEFAULT_SCRIBE_DEPS: ScribeDeps = {
  fetch: (input, init) => globalThis.fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  openAudio: (path) => openAsBlob(path, { type: TRANSCRIPTION_AUDIO_MIME }),
};

/**
 * Fields per https://elevenlabs.io/docs/api-reference/speech-to-text/convert.
 * No `language_code`: the API documents it as the language OF the file, not a
 * hint, and an ad may be in any language — Scribe detects it. `no_verbatim`
 * exists only on scribe_v2 and defaults to false; it is sent so the contract
 * the editor depends on (fillers and false starts kept) is explicit.
 */
function scribeForm(request: ScribeRequest, audio: Blob): FormData {
  const form = new FormData();
  form.append('file', audio, basename(request.audioAbs));
  form.append('model_id', TRANSCRIPT_CACHE_MODEL);
  form.append('no_verbatim', 'false');
  form.append('diarize', 'true');
  form.append('tag_audio_events', 'true');
  form.append('timestamps_granularity', 'word');
  for (const term of normalizeKeyterms(request.keyterms)) form.append('keyterms', term);
  return form;
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** ElevenLabs answers 401 for a bad key AND for an account out of credits; `detail.status` tells them apart. */
async function unauthorizedResult(response: Response): Promise<Result<unknown>> {
  const body = (await response.json().catch(() => null)) as {
    detail?: { status?: unknown };
  } | null;
  const status =
    typeof body?.detail?.status === 'string'
      ? body.detail.status.replace(/\s+/g, ' ').slice(0, 60)
      : null;
  if (status === 'quota_exceeded') {
    return err(
      'transcription-failed',
      'the ElevenLabs account has no transcription credits left — top it up or use another key',
    );
  }
  return err(
    'invalid-api-key',
    `ElevenLabs rejected the API key${status !== null ? ` (${status})` : ''} — check it in Settings`,
  );
}

type Attempt =
  | { readonly outcome: 'done'; readonly result: Result<unknown> }
  | { readonly outcome: 'retry'; readonly reason: string };

async function attemptScribe(request: ScribeRequest, deps: ScribeDeps): Promise<Attempt> {
  let response: Response;
  try {
    response = await deps.fetch(SCRIBE_URL, {
      method: 'POST',
      headers: { 'xi-api-key': request.apiKey },
      body: scribeForm(request, await deps.openAudio(request.audioAbs)),
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
  } catch (cause) {
    if (cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')) {
      // A hung request is not a blip: retrying re-uploads and can bill the same audio again.
      return {
        outcome: 'done',
        result: err(
          'transcription-failed',
          `Scribe did not answer within ${String(TRANSCRIBE_TIMEOUT_MS / 60_000)} minutes — try again later`,
          cause,
        ),
      };
    }
    return { outcome: 'retry', reason: cause instanceof Error ? cause.message : String(cause) };
  }
  if (response.status === 401) {
    return { outcome: 'done', result: await unauthorizedResult(response) };
  }
  if (response.ok) {
    try {
      return { outcome: 'done', result: ok(await response.json()) };
    } catch (cause) {
      return {
        outcome: 'done',
        result: err(
          'transcription-failed',
          'the Scribe response could not be read as JSON (interrupted or not a Scribe answer)',
          cause,
        ),
      };
    }
  }
  const body = await response.text().catch(() => '');
  const reason = `Scribe returned ${String(response.status)}: ${body.slice(0, ERROR_BODY_CHARS)}`;
  return isRetryable(response.status)
    ? { outcome: 'retry', reason }
    : { outcome: 'done', result: err('transcription-failed', reason) };
}

/** One POST to Scribe with retries on transient failures; the audio is streamed, never buffered. */
export async function callScribe(
  request: ScribeRequest,
  deps: ScribeDeps = DEFAULT_SCRIBE_DEPS,
): Promise<Result<unknown>> {
  let lastReason = 'no attempt made';
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await deps.sleep(RETRY_DELAYS_MS[attempt - 1] ?? 0);
    const outcome = await attemptScribe(request, deps);
    if (outcome.outcome === 'done') return outcome.result;
    lastReason = outcome.reason;
  }
  return err('transcription-failed', `${lastReason} (gave up after retries)`);
}

export interface TranscribeOptions {
  readonly apiKey?: string;
  readonly keyterms?: readonly string[];
  /** Transcribe again even when the cache is current. */
  readonly force?: boolean;
  /** Where the replaced cache is kept; without it the old cache is simply overwritten. */
  readonly archiveDir?: string;
  /** Slow the audio down (or speed it up) before the engine hears it; word times come back on that clock. */
  readonly audioTempo?: number;
}

export interface TranscribeDeps {
  readonly scribe: ScribeDeps;
  readonly extractAudio: typeof extractAudioForTranscription;
  readonly now: () => Date;
  readonly warn: (message: string, cause: unknown) => void;
  /** Keeps a copy of the cache being replaced; the source must still exist afterwards. */
  readonly archive: typeof archiveTranscriptCopy;
}

/** How many replaced caches per media the archive keeps; older ones are pruned. */
export const ARCHIVED_TRANSCRIPTS_PER_MEDIA = 5;

/** Copies — never moves — so the cache stays readable until the replacement lands. */
export async function archiveTranscriptCopy(cacheAbs: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(cacheAbs, target);
  const own = archivePattern(cacheAbs);
  const siblings = (await readdir(dirname(target))).filter((name) => own.test(name)).sort();
  await Promise.all(
    siblings
      .slice(0, Math.max(0, siblings.length - ARCHIVED_TRANSCRIPTS_PER_MEDIA))
      .map((name) => rm(join(dirname(target), name), { force: true })),
  );
}

const DEFAULT_TRANSCRIBE_DEPS: TranscribeDeps = {
  scribe: DEFAULT_SCRIBE_DEPS,
  extractAudio: extractAudioForTranscription,
  now: () => new Date(),
  warn: (message, cause) => {
    console.warn(message, cause);
  },
  archive: archiveTranscriptCopy,
};

/** `edit/transcripts/take.mp4.json` → `<archiveDir>/take.mp4.2026-08-27T15-04-05.000Z.json`. */
export function archivedTranscriptPath(archiveDir: string, cacheAbs: string, at: Date): string {
  const stamp = at.toISOString().replace(/:/g, '-');
  return join(archiveDir, `${basename(cacheAbs, '.json')}.${stamp}.json`);
}

/** Only THIS media's archives: `take.mp4.<stamp>.json`, never `take.mp4.backup.mov.<stamp>.json`. */
function archivePattern(cacheAbs: string): RegExp {
  const escaped = basename(cacheAbs, '.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}\\.\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z\\.json$`);
}

/** Temp files older than this were left by a process that died mid-write. */
const ORPHAN_TMP_MS = 5 * 60_000;

async function sweepOrphanedTmp(cacheAbs: string, now: Date): Promise<void> {
  const prefix = `${basename(cacheAbs)}.`;
  const entries = await readdir(dirname(cacheAbs)).catch(() => []);
  await Promise.all(
    entries
      .filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
      .map(async (name) => {
        const path = join(dirname(cacheAbs), name);
        const info = await stat(path).catch(() => null);
        if (info !== null && now.getTime() - info.mtimeMs > ORPHAN_TMP_MS) {
          await rm(path, { force: true });
        }
      }),
  );
}

/** Moves a cache aside (a media that no longer has audio keeps nothing to serve). */
export async function retireTranscriptCache(
  cacheAbs: string,
  archiveDir: string,
  at: Date = new Date(),
): Promise<Result<void>> {
  try {
    await mkdir(archiveDir, { recursive: true });
    await rename(cacheAbs, archivedTranscriptPath(archiveDir, cacheAbs, at));
    return ok(undefined);
  } catch (cause) {
    return err('io-failed', `cannot retire transcript cache "${cacheAbs}"`, cause);
  }
}

async function transcribeAudio(
  mediaAbs: string,
  audioAbs: string,
  request: Omit<ScribeRequest, 'audioAbs'>,
  tempo: number | undefined,
  deps: TranscribeDeps,
): Promise<Result<unknown>> {
  try {
    const extracted = await deps.extractAudio(
      mediaAbs,
      audioAbs,
      tempo === undefined ? {} : { tempo },
    );
    if (!extracted.ok) return extracted;
    return await callScribe({ ...request, audioAbs }, deps.scribe);
  } finally {
    await rm(audioAbs, { force: true });
  }
}

/**
 * The billed result is never lost and the cache never disappears: the new
 * content is written to a private temp file next to the old one, whatever
 * cache exists at that moment is COPIED to the archive (a failure there is
 * only warned about), and the temp file is renamed over the old one last —
 * readers see the old or the new cache, never none, and two writers cannot
 * truncate each other's temp file.
 */
async function replaceCache(
  cacheAbs: string,
  content: string,
  archiveDir: string | undefined,
  deps: TranscribeDeps,
): Promise<Result<void>> {
  const at = deps.now();
  const tmpAbs = `${cacheAbs}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(cacheAbs), { recursive: true });
    await sweepOrphanedTmp(cacheAbs, at);
    await writeFile(tmpAbs, content);
  } catch (cause) {
    return err('io-failed', `cannot write transcript cache "${cacheAbs}"`, cause);
  }
  if (archiveDir !== undefined && existsSync(cacheAbs)) {
    const target = archivedTranscriptPath(archiveDir, cacheAbs, at);
    try {
      await deps.archive(cacheAbs, target);
    } catch (cause) {
      deps.warn(`transcript cache "${cacheAbs}" could not be archived to "${target}"`, cause);
    }
  }
  try {
    await rename(tmpAbs, cacheAbs);
    return ok(undefined);
  } catch (cause) {
    await rm(tmpAbs, { force: true });
    return err('io-failed', `cannot replace transcript cache "${cacheAbs}"`, cause);
  }
}

/**
 * Transcribes a media file into a cache keyed on what produced it: the media
 * identity and the keyterms. A current cache is returned as is; a stale or
 * forced one is replaced. Used for project sources and for the QA
 * retranscription of the rendered output.
 */
export async function transcribeToCache(
  mediaAbs: string,
  cacheAbs: string,
  options: TranscribeOptions,
  deps: TranscribeDeps = DEFAULT_TRANSCRIBE_DEPS,
): Promise<Result<Transcript>> {
  const hash = await transcriptMediaFingerprint(mediaAbs);
  if (!hash.ok) return hash;
  const keyterms = normalizeKeyterms(options.keyterms ?? []);
  const keytermsHash = keytermsFingerprint(keyterms);

  const existing = await readJson(cacheAbs);
  const meta = parseTranscriptCacheMeta(existing);
  if (
    options.force !== true &&
    meta?.sourceHash === hash.value &&
    meta.keytermsHash === keytermsHash
  ) {
    const parsed = parseTranscriptFile(existing);
    if (parsed.ok) return parsed;
  }

  if (!options.apiKey) {
    return err('missing-api-key', 'ELEVENLABS_API_KEY not set — add it in Settings or in .env');
  }

  const raw = await transcribeAudio(
    mediaAbs,
    `${cacheAbs}${TRANSCRIPTION_AUDIO_EXTENSION}`,
    { apiKey: options.apiKey, keyterms },
    options.audioTempo,
    deps,
  );
  if (!raw.ok) return raw;

  const parsed = parseScribeTranscript(raw.value);
  if (!parsed.ok) return parsed;

  const replaced = await replaceCache(
    cacheAbs,
    JSON.stringify(
      {
        engine: 'scribe',
        model: TRANSCRIPT_CACHE_MODEL,
        sourceHash: hash.value,
        keytermsHash,
        transcribedAt: deps.now().toISOString(),
        transcript: raw.value,
      },
      null,
      1,
    ),
    options.archiveDir,
    deps,
  );
  if (!replaced.ok) return replaced;
  return parsed;
}

/** Project-source transcription: the cache contract above, replaced caches kept in history. */
export async function getOrCreateTranscript(
  projectDir: string,
  mediaRelPath: string,
  options: TranscribeOptions,
  deps?: TranscribeDeps,
): Promise<Result<Transcript>> {
  return transcribeToCache(
    join(projectDir, mediaRelPath),
    transcriptCachePath(projectDir, mediaRelPath),
    { ...options, archiveDir: transcriptArchiveDir(projectDir) },
    deps,
  );
}
