import { unwrap } from '../../core/result.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { transcriptPack } from './transcriptPack.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const scribeCache = (words: readonly { text: string; start: number; end: number }[]): unknown => ({
  engine: 'scribe',
  model: 'scribe_v2',
  sourceHash: 'h',
  keytermsHash: 'k',
  transcribedAt: '2026-08-27T15:00:00.000Z',
  transcript: {
    language_code: 'por',
    text: words.map((w) => w.text).join(' '),
    words: words.map((w) => ({ ...w, type: 'word' as const })),
    audio_duration_secs: words[words.length - 1]?.end ?? 0,
  },
});

async function project(
  sources: Record<string, string>,
  subtitles: Record<string, unknown> = { enabled: false, preset: 'pill' },
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'leadzy-transcript-pack-'));
  roots.push(root);
  await mkdir(join(root, 'edit', 'transcripts'), { recursive: true });
  const docSources: Record<string, { path: string }> = {};
  for (const [key, mediaName] of Object.entries(sources)) {
    await writeFile(join(root, mediaName), 'fake media bytes');
    docSources[key] = { path: mediaName };
  }
  const doc = {
    version: 2,
    fps: 25,
    output: { width: 1080, height: 1920, loudnormLufs: -14 },
    sources: docSources,
    tracks: [{ id: 'base', kind: 'video', blocks: [] }],
    subtitles,
  };
  await writeFile(join(root, 'edit', 'edit.json'), JSON.stringify(doc));
  return root;
}

async function cacheTranscript(
  root: string,
  mediaName: string,
  words: readonly { text: string; start: number; end: number }[],
): Promise<void> {
  await writeFile(
    join(root, 'edit', 'transcripts', `${mediaName}.json`),
    JSON.stringify(scribeCache(words)),
  );
}

describe('transcriptPack command', () => {
  it('packs every source with a cached transcript, concatenated', async () => {
    const root = await project({ cam: 'camera.mp4', screen: 'screen.mp4' });
    await cacheTranscript(root, 'camera.mp4', [
      { text: 'olá', start: 0, end: 0.3 },
      { text: 'mundo', start: 0.35, end: 0.7 },
    ]);
    await cacheTranscript(root, 'screen.mp4', [
      { text: 'segunda', start: 0, end: 0.4 },
      { text: 'fonte', start: 0.45, end: 0.8 },
    ]);

    const result = await transcriptPack(root);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('# camera.mp4');
    expect(result.value).toContain('# screen.mp4');
    expect(result.value.split('\n\n')).toHaveLength(2);
  });

  it('lists only the corrections of each source under its own pack', async () => {
    const root = await project(
      { cam: 'camera.mp4', screen: 'screen.mp4' },
      {
        enabled: true,
        preset: 'pill',
        corrections: [
          { source: 'cam', at: 0.1, text: 'oi' },
          { source: 'screen', at: 10.1, text: 'tela' },
        ],
      },
    );
    await cacheTranscript(root, 'camera.mp4', [{ text: 'olá', start: 0, end: 0.3 }]);
    await cacheTranscript(root, 'screen.mp4', [{ text: 'écran', start: 10, end: 10.3 }]);

    const pack = unwrap(await transcriptPack(root, { source: 'cam' }));

    expect(pack).toContain('# corrections: [0.10] "olá" → "oi"');
    expect(pack).not.toContain('tela');
  });

  it('filters to a single source with --source', async () => {
    const root = await project({ cam: 'camera.mp4', screen: 'screen.mp4' });
    await cacheTranscript(root, 'camera.mp4', [{ text: 'olá', start: 0, end: 0.3 }]);
    await cacheTranscript(root, 'screen.mp4', [{ text: 'oi', start: 0, end: 0.2 }]);

    const result = await transcriptPack(root, { source: 'screen' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('# screen.mp4');
    expect(result.value).not.toContain('# camera.mp4');
  });

  it('fails with "not-found" when --source names an unknown source key', async () => {
    const root = await project({ cam: 'camera.mp4' });
    await cacheTranscript(root, 'camera.mp4', [{ text: 'olá', start: 0, end: 0.3 }]);

    const result = await transcriptPack(root, { source: 'nope' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not-found');
  });

  it('fails with "not-found" when the requested source has no cached transcript', async () => {
    const root = await project({ cam: 'camera.mp4' });

    const result = await transcriptPack(root, { source: 'cam' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not-found');
  });

  it('skips sources without a cached transcript when no --source is given', async () => {
    const root = await project({ cam: 'camera.mp4', screen: 'screen.mp4' });
    await cacheTranscript(root, 'camera.mp4', [{ text: 'olá', start: 0, end: 0.3 }]);

    const result = await transcriptPack(root);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('# camera.mp4');
    expect(result.value).not.toContain('# screen.mp4');
  });

  it('fails with "not-found" when no source has a cached transcript', async () => {
    const root = await project({ cam: 'camera.mp4' });

    const result = await transcriptPack(root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not-found');
  });
});
