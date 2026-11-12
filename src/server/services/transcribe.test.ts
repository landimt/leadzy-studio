import { existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '../../core/result.js';
import {
  ARCHIVED_TRANSCRIPTS_PER_MEDIA,
  readFully,
  archiveTranscriptCopy,
  archivedTranscriptPath,
  callScribe,
  getOrCreateTranscript,
  keytermsFingerprint,
  transcribeToCache,
  transcriptCachePath,
  transcriptCacheState,
  transcriptMediaFingerprint,
  type ScribeDeps,
  type TranscribeDeps,
} from './transcribe.js';

const SCRIBE_JSON = {
  language_code: 'por',
  text: 'olá mundo',
  words: [
    { text: 'olá', start: 0.1, end: 0.4, type: 'word' },
    { text: 'mundo', start: 0.5, end: 0.9, type: 'word' },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function scribeDepsWith(responses: readonly (Response | Error)[]): ScribeDeps & {
  readonly requests: RequestInit[];
  readonly sleeps: number[];
} {
  const queue = [...responses];
  const requests: RequestInit[] = [];
  const sleeps: number[] = [];
  return {
    requests,
    sleeps,
    fetch: (_url, init) => {
      requests.push(init ?? {});
      const next = queue.shift();
      if (next === undefined) throw new Error('no canned response left');
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    openAudio: () => Promise.resolve(new Blob(['aac'], { type: 'audio/mp4' })),
  };
}

function formOf(init: RequestInit | undefined): FormData {
  if (!(init?.body instanceof FormData)) throw new Error('body is not a FormData');
  return init.body;
}

describe('callScribe', () => {
  const request = {
    apiKey: 'sk-test',
    audioAbs: '/tmp/take.mp4.json.m4a',
    keyterms: ['Leadzy', 'Leadzy Extensão'],
  };

  it('asks Scribe v2 for a verbatim, word-timed, diarized transcript primed with the keyterms', async () => {
    const deps = scribeDepsWith([jsonResponse(SCRIBE_JSON)]);

    const result = await callScribe(request, deps);

    expect(result.ok).toBe(true);
    const form = formOf(deps.requests[0]);
    expect(form.get('model_id')).toBe('scribe_v2');
    expect(form.get('no_verbatim')).toBe('false');
    expect(form.get('diarize')).toBe('true');
    expect(form.get('tag_audio_events')).toBe('true');
    expect(form.get('timestamps_granularity')).toBe('word');
    expect(form.has('language_code')).toBe(false);
    expect(form.getAll('keyterms')).toEqual(['Leadzy', 'Leadzy Extensão']);
    expect((form.get('file') as File).name).toBe('take.mp4.json.m4a');
    expect(new Headers(deps.requests[0]?.headers).get('xi-api-key')).toBe('sk-test');
    expect(deps.requests[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends each keyterm once, trimmed, in the authored order', async () => {
    const deps = scribeDepsWith([jsonResponse(SCRIBE_JSON)]);

    await callScribe({ ...request, keyterms: [' Leadzy', 'Carla', 'Leadzy ', ''] }, deps);

    expect(formOf(deps.requests[0]).getAll('keyterms')).toEqual(['Leadzy', 'Carla']);
  });

  it('sends no keyterms field at all when there are none', async () => {
    const deps = scribeDepsWith([jsonResponse(SCRIBE_JSON)]);

    await callScribe({ apiKey: 'sk-test', audioAbs: '/tmp/a.m4a', keyterms: [] }, deps);

    expect(formOf(deps.requests[0]).getAll('keyterms')).toEqual([]);
  });

  it('retries a 429 and a network failure with growing delays, then returns the transcript', async () => {
    const deps = scribeDepsWith([
      jsonResponse({ detail: 'slow down' }, 429),
      new TypeError('fetch failed'),
      jsonResponse(SCRIBE_JSON),
    ]);

    const result = await callScribe(request, deps);

    expect(result.ok).toBe(true);
    expect(deps.requests).toHaveLength(3);
    expect(deps.sleeps).toEqual([1000, 3000]);
  });

  it('retries an exact 500 and then a 502', async () => {
    const deps = scribeDepsWith([
      new Response('boom', { status: 500 }),
      new Response('bad gateway', { status: 502 }),
      jsonResponse(SCRIBE_JSON),
    ]);

    const result = await callScribe(request, deps);

    expect(result.ok).toBe(true);
    expect(deps.requests).toHaveLength(3);
  });

  it('answers a failure, not an exception, when a 200 carries a body that is not JSON', async () => {
    const deps = scribeDepsWith([new Response('<html>captive portal</html>', { status: 200 })]);

    const result = await callScribe(request, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('transcription-failed');
    expect(result.error.message).toContain('JSON');
    expect(deps.requests).toHaveLength(1);
  });

  it('does not retry a timed-out request — a hung Scribe must not be billed again', async () => {
    const deps = scribeDepsWith([new DOMException('The operation timed out', 'TimeoutError')]);

    const result = await callScribe(request, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('transcription-failed');
    expect(result.error.message).toContain('10 minutes');
    expect(deps.requests).toHaveLength(1);
    expect(deps.sleeps).toEqual([]);
  });

  it('gives up after the third transient failure with the last reason', async () => {
    const deps = scribeDepsWith([
      jsonResponse({ detail: 'a' }, 503),
      jsonResponse({ detail: 'b' }, 502),
      new TypeError('socket hang up'),
    ]);

    const result = await callScribe(request, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('transcription-failed');
    expect(result.error.message).toContain('socket hang up');
    expect(result.error.message).toContain('gave up');
    expect(deps.requests).toHaveLength(3);
  });

  it('maps 401 to invalid-api-key without retrying or echoing the response message', async () => {
    const deps = scribeDepsWith([
      jsonResponse({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }, 401),
    ]);

    const result = await callScribe(request, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-api-key');
    expect(result.error.message).toContain('invalid_api_key');
    expect(result.error.message).not.toContain('Invalid API key');
    expect(deps.requests).toHaveLength(1);
  });

  it('tells an account out of credits apart from a bad key (both are 401s)', async () => {
    const deps = scribeDepsWith([
      jsonResponse({ detail: { status: 'quota_exceeded', message: 'Insufficient balance' } }, 401),
    ]);

    const result = await callScribe(request, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('transcription-failed');
    expect(result.error.message).toContain('credits');
    expect(result.error.message).not.toContain('Insufficient balance');
  });

  it('keeps the key message plain when the 401 status is not a string', async () => {
    const deps = scribeDepsWith([jsonResponse({ detail: { status: 123 } }, 401)]);

    const result = await callScribe(request, deps);

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toBe('ElevenLabs rejected the API key — check it in Settings');
  });

  it('still reports a bad key when the 401 body is not JSON', async () => {
    const deps = scribeDepsWith([new Response('Unauthorized', { status: 401 })]);

    const result = await callScribe(request, deps);

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toBe('ElevenLabs rejected the API key — check it in Settings');
  });

  it('fails a non-transient status immediately with a truncated body', async () => {
    const deps = scribeDepsWith([new Response('x'.repeat(500), { status: 422 })]);

    const result = await callScribe(request, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe(`Scribe returned 422: ${'x'.repeat(200)}`);
    expect(deps.requests).toHaveLength(1);
  });
});

describe('keytermsFingerprint', () => {
  it('ignores order, repeats and surrounding whitespace', () => {
    expect(keytermsFingerprint(['Leadzy', ' Extensão'])).toBe(
      keytermsFingerprint(['Extensão', 'Leadzy', 'Leadzy ']),
    );
  });

  it('changes when a term changes', () => {
    expect(keytermsFingerprint(['Leadzy'])).not.toBe(keytermsFingerprint(['Leads']));
    expect(keytermsFingerprint([])).not.toBe(keytermsFingerprint(['Leadzy']));
  });
});

describe('transcribeToCache', () => {
  let dir: string;
  const at = new Date('2026-08-27T15:04:05.000Z');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'leadzy-transcribe-'));
    await writeFile(join(dir, 'take.mp4'), 'fake media bytes');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function depsWith(responses: readonly (Response | Error)[]): TranscribeDeps & {
    readonly scribe: ReturnType<typeof scribeDepsWith>;
    readonly extractAudio: ReturnType<typeof vi.fn>;
  } {
    const scribe = scribeDepsWith(responses);
    const extractAudio = vi.fn(async (_source: string, output: string) => {
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, 'aac');
      return ok(output);
    });
    return { scribe, extractAudio, now: () => at, warn: vi.fn(), archive: archiveTranscriptCopy };
  }

  const cacheAbs = (): string => join(dir, 'edit', 'transcripts', 'take.mp4.json');
  const mediaAbs = (): string => join(dir, 'take.mp4');
  const archiveDir = (): string => join(dir, 'edit', 'history', 'transcripts');

  it('writes a v2 cache with the fingerprints of what produced it and cleans the upload up', async () => {
    const deps = depsWith([jsonResponse(SCRIBE_JSON)]);

    const result = await transcribeToCache(
      mediaAbs(),
      cacheAbs(),
      { apiKey: 'sk-test', keyterms: ['Leadzy'], archiveDir: archiveDir() },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(deps.warn).not.toHaveBeenCalled();
    expect(existsSync(archiveDir())).toBe(false);
    const cache = JSON.parse(await readFile(cacheAbs(), 'utf8')) as Record<string, unknown>;
    expect(cache).toMatchObject({
      engine: 'scribe',
      model: 'scribe_v2',
      keytermsHash: keytermsFingerprint(['Leadzy']),
      transcribedAt: '2026-08-27T15:04:05.000Z',
      transcript: SCRIBE_JSON,
    });
    expect(typeof cache.sourceHash).toBe('string');
    expect(await readdir(join(dir, 'edit', 'transcripts'))).toEqual(['take.mp4.json']);
    expect(deps.extractAudio).toHaveBeenCalledWith(mediaAbs(), `${cacheAbs()}.m4a`, {});
  });

  it('hands the audio tempo to the extraction and nothing when there is none', async () => {
    const slowed = depsWith([jsonResponse(SCRIBE_JSON)]);
    await transcribeToCache(mediaAbs(), cacheAbs(), { apiKey: 'sk-test', audioTempo: 0.9 }, slowed);
    expect(slowed.extractAudio).toHaveBeenCalledWith(mediaAbs(), `${cacheAbs()}.m4a`, {
      tempo: 0.9,
    });

    const natural = depsWith([jsonResponse(SCRIBE_JSON)]);
    await transcribeToCache(mediaAbs(), cacheAbs(), { apiKey: 'sk-test', force: true }, natural);
    expect(natural.extractAudio).toHaveBeenCalledWith(mediaAbs(), `${cacheAbs()}.m4a`, {});
  });

  it('returns a current cache without calling Scribe again', async () => {
    const first = depsWith([jsonResponse(SCRIBE_JSON)]);
    await transcribeToCache(
      mediaAbs(),
      cacheAbs(),
      { apiKey: 'sk-test', keyterms: ['Leadzy'] },
      first,
    );
    const second = depsWith([]);

    const result = await transcribeToCache(
      mediaAbs(),
      cacheAbs(),
      { apiKey: 'sk-test', keyterms: [' Leadzy'] },
      second,
    );

    expect(result.ok).toBe(true);
    expect(second.scribe.requests).toHaveLength(0);
    expect(second.extractAudio).not.toHaveBeenCalled();
  });

  it.each([
    ['the keyterms changed', { keyterms: ['Leadzy', 'Extensão'] }],
    ['the caller forces it', { keyterms: ['Leadzy'], force: true }],
  ])('transcribes again and archives the previous cache when %s', async (_label, options) => {
    await transcribeToCache(
      mediaAbs(),
      cacheAbs(),
      { apiKey: 'sk-test', keyterms: ['Leadzy'] },
      depsWith([jsonResponse(SCRIBE_JSON)]),
    );
    const later = new Date('2026-08-28T09:00:00.000Z');
    const deps = {
      ...depsWith([jsonResponse({ ...SCRIBE_JSON, text: 'second' })]),
      now: () => later,
    };

    const result = await transcribeToCache(
      mediaAbs(),
      cacheAbs(),
      { apiKey: 'sk-test', archiveDir: archiveDir(), ...options },
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.text).toBe('second');
    const archived = archivedTranscriptPath(archiveDir(), cacheAbs(), later);
    expect(archived).toBe(join(archiveDir(), 'take.mp4.2026-08-28T09-00-00.000Z.json'));
    expect(await readdir(join(dir, 'edit', 'transcripts'))).toEqual(['take.mp4.json']);
    const old = JSON.parse(await readFile(archived, 'utf8')) as { transcript: { text: string } };
    expect(old.transcript.text).toBe('olá mundo');
    const current = JSON.parse(await readFile(cacheAbs(), 'utf8')) as { keytermsHash: string };
    expect(current.keytermsHash).toBe(keytermsFingerprint(options.keyterms));
  });

  it('treats a cache from the previous format as absent and moves it to history', async () => {
    await mkdir(join(dir, 'edit', 'transcripts'), { recursive: true });
    await writeFile(
      cacheAbs(),
      JSON.stringify({ engine: 'scribe', sourceHash: 'old', transcript: SCRIBE_JSON }),
    );
    const deps = depsWith([jsonResponse(SCRIBE_JSON)]);

    const result = await transcribeToCache(
      mediaAbs(),
      cacheAbs(),
      { apiKey: 'sk-test', archiveDir: archiveDir() },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(deps.scribe.requests).toHaveLength(1);
    expect(await readdir(archiveDir())).toEqual(['take.mp4.2026-08-27T15-04-05.000Z.json']);
  });

  it('overwrites the previous cache in place when no archive folder is given (the QA cache)', async () => {
    await transcribeToCache(
      mediaAbs(),
      cacheAbs(),
      { apiKey: 'sk-test' },
      depsWith([jsonResponse(SCRIBE_JSON)]),
    );

    const result = await transcribeToCache(
      mediaAbs(),
      cacheAbs(),
      { apiKey: 'sk-test', force: true },
      depsWith([jsonResponse({ ...SCRIBE_JSON, text: 'again' })]),
    );

    expect(result.ok).toBe(true);
    expect(await readdir(join(dir, 'edit'))).toEqual(['transcripts']);
    expect(await readdir(join(dir, 'edit', 'transcripts'))).toEqual(['take.mp4.json']);
  });

  it('keeps the billed transcript when the old cache cannot be archived', async () => {
    await transcribeToCache(
      mediaAbs(),
      cacheAbs(),
      { apiKey: 'sk-test' },
      depsWith([jsonResponse(SCRIBE_JSON)]),
    );
    await mkdir(join(dir, 'edit', 'history'), { recursive: true });
    await writeFile(archiveDir(), 'a file where the folder should be');
    const deps = depsWith([jsonResponse({ ...SCRIBE_JSON, text: 'kept' })]);

    const result = await transcribeToCache(
      mediaAbs(),
      cacheAbs(),
      { apiKey: 'sk-test', force: true, archiveDir: archiveDir() },
      deps,
    );

    expect(result.ok).toBe(true);
    const current = JSON.parse(await readFile(cacheAbs(), 'utf8')) as {
      transcript: { text: string };
    };
    expect(current.transcript.text).toBe('kept');
    expect(deps.warn).toHaveBeenCalledTimes(1);
    expect(await readdir(join(dir, 'edit', 'transcripts'))).toEqual(['take.mp4.json']);
  });

  it('removes the extracted upload even when Scribe fails', async () => {
    const deps = depsWith([new Response('nope', { status: 422 })]);

    const result = await transcribeToCache(mediaAbs(), cacheAbs(), { apiKey: 'sk-test' }, deps);

    expect(result.ok).toBe(false);
    expect(await readdir(join(dir, 'edit', 'transcripts'))).toEqual([]);
  });

  it('keeps a stale cache untouched when there is no key to refresh it with', async () => {
    await transcribeToCache(
      mediaAbs(),
      cacheAbs(),
      { apiKey: 'sk-test', keyterms: ['Leadzy'] },
      depsWith([jsonResponse(SCRIBE_JSON)]),
    );
    const before = await readFile(cacheAbs(), 'utf8');

    const result = await transcribeToCache(mediaAbs(), cacheAbs(), { keyterms: [] }, depsWith([]));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing-api-key');
    expect(await readFile(cacheAbs(), 'utf8')).toBe(before);
  });

  it('reports the cache state the transcribe command decides on', async () => {
    expect(await transcriptCacheState(cacheAbs(), mediaAbs(), [])).toBe('missing');
    await transcribeToCache(
      mediaAbs(),
      cacheAbs(),
      { apiKey: 'sk-test', keyterms: ['Leadzy'] },
      depsWith([jsonResponse(SCRIBE_JSON)]),
    );
    expect(await transcriptCacheState(cacheAbs(), mediaAbs(), ['Leadzy'])).toBe('fresh');
    expect(await transcriptCacheState(cacheAbs(), mediaAbs(), [])).toBe('stale-keyterms');

    await writeFile(mediaAbs(), 'the take was replaced by a longer one');
    expect(await transcriptCacheState(cacheAbs(), mediaAbs(), ['Leadzy'])).toBe('stale-media');
  });

  it('keeps a transcript current across a copy, a move and a touched mtime — only content counts', async () => {
    await writeFile(mediaAbs(), Buffer.alloc(3 * 1024 * 1024, 7));
    const original = await transcriptMediaFingerprint(mediaAbs());
    await copyFile(mediaAbs(), join(dir, 'copy.mp4'));
    await utimes(join(dir, 'copy.mp4'), new Date('2020-01-01'), new Date('2020-01-01'));

    const copied = await transcriptMediaFingerprint(join(dir, 'copy.mp4'));
    expect(copied).toEqual(original);

    const bytes = Buffer.alloc(3 * 1024 * 1024, 7);
    bytes[1024 * 1024 + 10] = 8; // a change in the middle is invisible to the sample …
    await writeFile(join(dir, 'middle.mp4'), bytes);
    expect(await transcriptMediaFingerprint(join(dir, 'middle.mp4'))).toEqual(original);
    bytes[bytes.length - 1] = 9; // … but the head, the tail and the size are covered
    await writeFile(join(dir, 'tail.mp4'), bytes);
    expect(await transcriptMediaFingerprint(join(dir, 'tail.mp4'))).not.toEqual(original);
    await writeFile(
      join(dir, 'longer.mp4'),
      Buffer.concat([Buffer.alloc(3 * 1024 * 1024, 7), Buffer.from([7])]),
    );
    expect(await transcriptMediaFingerprint(join(dir, 'longer.mp4'))).not.toEqual(original);
  });
  it('lands the second Scribe result in the cache when overwriting in place', async () => {
    await transcribeToCache(
      mediaAbs(),
      cacheAbs(),
      { apiKey: 'sk-test' },
      depsWith([jsonResponse(SCRIBE_JSON)]),
    );

    await transcribeToCache(
      mediaAbs(),
      cacheAbs(),
      { apiKey: 'sk-test', force: true },
      depsWith([jsonResponse({ ...SCRIBE_JSON, text: 'again' })]),
    );

    const current = JSON.parse(await readFile(cacheAbs(), 'utf8')) as {
      transcript: { text: string };
    };
    expect(current.transcript.text).toBe('again');
  });

  it('leaves the old cache untouched and reports io-failed when the new file cannot be written', async () => {
    // Root ignores a missing write bit, and Windows has no POSIX mode bits:
    // on either, chmod cannot stage the write failure under test.
    if (process.getuid?.() === 0 || process.platform === 'win32') return;
    await transcribeToCache(
      mediaAbs(),
      cacheAbs(),
      { apiKey: 'sk-test' },
      depsWith([jsonResponse(SCRIBE_JSON)]),
    );
    const before = await readFile(cacheAbs(), 'utf8');
    await chmod(join(dir, 'edit', 'transcripts'), 0o500);
    try {
      const result = await transcribeToCache(
        mediaAbs(),
        cacheAbs(),
        { apiKey: 'sk-test', force: true, archiveDir: archiveDir() },
        {
          ...depsWith([jsonResponse({ ...SCRIBE_JSON, text: 'lost?' })]),
          extractAudio: (_source: string, output: string) => Promise.resolve(ok(output)),
        },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('io-failed');
      expect(await readFile(cacheAbs(), 'utf8')).toBe(before);
      expect(existsSync(archiveDir())).toBe(false);
    } finally {
      await chmod(join(dir, 'edit', 'transcripts'), 0o700);
    }
  });

  it('never leaves the project without a cache: the archive is a copy and the old file is there until the new one lands', async () => {
    await transcribeToCache(
      mediaAbs(),
      cacheAbs(),
      { apiKey: 'sk-test' },
      depsWith([jsonResponse(SCRIBE_JSON)]),
    );
    const seen: { beforeCopy: string; afterCopy: string; target: string }[] = [];
    const deps = depsWith([jsonResponse({ ...SCRIBE_JSON, text: 'second' })]);
    const observing: TranscribeDeps = {
      ...deps,
      archive: async (source, target) => {
        const beforeCopy = await readFile(source, 'utf8');
        await archiveTranscriptCopy(source, target);
        seen.push({ beforeCopy, afterCopy: await readFile(source, 'utf8'), target });
      },
    };

    const result = await transcribeToCache(
      mediaAbs(),
      cacheAbs(),
      { apiKey: 'sk-test', force: true, archiveDir: archiveDir() },
      observing,
    );

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.afterCopy).toBe(seen[0]?.beforeCopy);
    expect(
      (JSON.parse(seen[0]?.beforeCopy ?? '') as { transcript: { text: string } }).transcript.text,
    ).toBe('olá mundo');
    expect(await readdir(join(dir, 'edit', 'transcripts'))).toEqual(['take.mp4.json']);
    expect(await readdir(archiveDir())).toEqual(['take.mp4.2026-08-27T15-04-05.000Z.json']);
  });

  it('archiveTranscriptCopy copies (the source survives) and prunes the oldest copies per media', async () => {
    await mkdir(join(dir, 'edit', 'transcripts'), { recursive: true });
    await writeFile(cacheAbs(), '{"v":1}');
    await mkdir(archiveDir(), { recursive: true });
    await writeFile(join(archiveDir(), 'other.mp4.2025-01-01T00-00-00.000Z.json'), '{}');
    for (let i = 0; i < ARCHIVED_TRANSCRIPTS_PER_MEDIA + 2; i += 1) {
      const stamp = new Date(Date.UTC(2026, 0, 1 + i));
      await archiveTranscriptCopy(
        cacheAbs(),
        archivedTranscriptPath(archiveDir(), cacheAbs(), stamp),
      );
    }

    expect(existsSync(cacheAbs())).toBe(true);
    const kept = (await readdir(archiveDir())).filter((name) => name.startsWith('take.mp4.2026'));
    expect(kept).toHaveLength(ARCHIVED_TRANSCRIPTS_PER_MEDIA);
    expect(kept[0]).toBe('take.mp4.2026-01-03T00-00-00.000Z.json');
    expect(existsSync(join(archiveDir(), 'other.mp4.2025-01-01T00-00-00.000Z.json'))).toBe(true);
  });

  it('removes the upload even when the retry machinery itself throws', async () => {
    const deps = depsWith([new Response('busy', { status: 503 })]);
    const throwing: TranscribeDeps = {
      ...deps,
      scribe: { ...deps.scribe, sleep: () => Promise.reject(new Error('timer torn down')) },
    };

    await expect(
      transcribeToCache(mediaAbs(), cacheAbs(), { apiKey: 'sk-test' }, throwing),
    ).rejects.toThrow('timer torn down');
    expect(await readdir(join(dir, 'edit', 'transcripts'))).toEqual([]);
  });

  it('keeps two media that differ only by extension in separate caches', async () => {
    await writeFile(join(dir, 'take.m4a'), 'the extracted audio next to the video');
    expect(transcriptCachePath(dir, 'take.mp4')).not.toBe(transcriptCachePath(dir, 'take.m4a'));

    await getOrCreateTranscript(
      dir,
      'take.mp4',
      { apiKey: 'sk-test' },
      depsWith([jsonResponse(SCRIBE_JSON)]),
    );
    await getOrCreateTranscript(
      dir,
      'take.m4a',
      { apiKey: 'sk-test' },
      depsWith([jsonResponse({ ...SCRIBE_JSON, text: 'audio' })]),
    );

    expect(await transcriptCacheState(transcriptCachePath(dir, 'take.mp4'), mediaAbs(), [])).toBe(
      'fresh',
    );
    expect(
      await transcriptCacheState(transcriptCachePath(dir, 'take.m4a'), join(dir, 'take.m4a'), []),
    ).toBe('fresh');
    expect((await readdir(join(dir, 'edit', 'transcripts'))).sort()).toEqual([
      'take.m4a.json',
      'take.mp4.json',
    ]);
  });

  it('archives replaced source caches under edit/history/transcripts through getOrCreateTranscript', async () => {
    await getOrCreateTranscript(
      dir,
      'take.mp4',
      { apiKey: 'sk-test' },
      depsWith([jsonResponse(SCRIBE_JSON)]),
    );

    const result = await getOrCreateTranscript(
      dir,
      'take.mp4',
      { apiKey: 'sk-test', force: true },
      depsWith([jsonResponse({ ...SCRIBE_JSON, text: 'redo' })]),
    );

    expect(result.ok).toBe(true);
    expect(await readdir(archiveDir())).toEqual(['take.mp4.2026-08-27T15-04-05.000Z.json']);
    expect(await readdir(join(dir, 'edit', 'transcripts'))).toEqual(['take.mp4.json']);
  });

  it('treats a cache with a good header but an unreadable body as missing', async () => {
    await mkdir(join(dir, 'edit', 'transcripts'), { recursive: true });
    await writeFile(
      cacheAbs(),
      JSON.stringify({
        engine: 'scribe',
        model: 'scribe_v2',
        sourceHash: 'h',
        keytermsHash: keytermsFingerprint([]),
        transcribedAt: '2026-08-27T15:00:00.000Z',
        transcript: null,
      }),
    );

    expect(await transcriptCacheState(cacheAbs(), mediaAbs(), [])).toBe('missing');
  });
  it("prunes only this media's archives, not those of a media whose name extends it", async () => {
    await mkdir(join(dir, 'edit', 'transcripts'), { recursive: true });
    await writeFile(cacheAbs(), '{"v":1}');
    await mkdir(archiveDir(), { recursive: true });
    await writeFile(join(archiveDir(), 'take.mp4.backup.mov.2020-01-01T00-00-00.000Z.json'), '{}');
    for (let i = 0; i < ARCHIVED_TRANSCRIPTS_PER_MEDIA + 1; i += 1) {
      const stamp = new Date(Date.UTC(2026, 0, 1 + i));
      await archiveTranscriptCopy(
        cacheAbs(),
        archivedTranscriptPath(archiveDir(), cacheAbs(), stamp),
      );
    }

    const names = await readdir(archiveDir());
    expect(names).toContain('take.mp4.backup.mov.2020-01-01T00-00-00.000Z.json');
    expect(names.filter((n) => n.startsWith('take.mp4.2026'))).toHaveLength(
      ARCHIVED_TRANSCRIPTS_PER_MEDIA,
    );
    expect(names).not.toContain('take.mp4.2026-01-01T00-00-00.000Z.json');
  });

  it('sweeps temp files an earlier crash left behind, but not a fresh one', async () => {
    await mkdir(join(dir, 'edit', 'transcripts'), { recursive: true });
    const stale = `${cacheAbs()}.deadbeef.tmp`;
    const fresh = `${cacheAbs()}.cafebabe.tmp`;
    await writeFile(stale, '{}');
    await writeFile(fresh, '{}');
    await utimes(stale, new Date(at.getTime() - 3_600_000), new Date(at.getTime() - 3_600_000));

    await transcribeToCache(
      mediaAbs(),
      cacheAbs(),
      { apiKey: 'sk-test' },
      depsWith([jsonResponse(SCRIBE_JSON)]),
    );

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('readFully keeps reading until the requested bytes arrive', async () => {
    const source = Buffer.from('abcdefghij');
    let calls = 0;
    const handle = {
      read: (buffer: Buffer, offset: number, length: number, position: number) => {
        calls += 1;
        const chunk = source.subarray(position, position + Math.min(length, 3));
        chunk.copy(buffer, offset);
        return Promise.resolve({ bytesRead: chunk.length });
      },
    };

    const read = await readFully(handle, 8, 1);

    expect(read.toString()).toBe('bcdefghi');
    expect(calls).toBe(3);
  });
});
