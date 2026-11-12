import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { err, ok } from '../../core/result.js';
import {
  importMedia,
  MAX_IMAGE_IMPORT_BYTES,
  MAX_MEDIA_IMPORT_BYTES,
  mediaImportByteLimit,
  MediaImportError,
  normalizeMediaFilename,
} from './mediaImport.js';

const roots: string[] = [];

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'leadzy-media-import-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const successfulProbe = () =>
  Promise.resolve(
    ok({
      kind: 'video' as const,
      durationS: 12.5,
      fps: 29.97,
      width: 1920,
      height: 1080,
      hasAudio: true,
    }),
  );

async function importTempEntries(projectDir: string): Promise<string[]> {
  return readdir(join(projectDir, 'edit', 'cache', 'media-imports')).catch(() => []);
}

describe('normalizeMediaFilename', () => {
  it.each([
    '',
    '   ',
    '../escape.mp4',
    '..\\escape.mp4',
    'line\nbreak.mp4',
    'CON.mp4',
    'lpt9.mov',
    'trailing.mp4.',
    'trailing.mp4 ',
  ])('rejects an unsafe leaf filename: %j', (filename) => {
    expect(() => normalizeMediaFilename(filename)).toThrow(MediaImportError);
  });

  it('normalizes Unicode to NFC', () => {
    expect(normalizeMediaFilename('cafe\u0301.mp4')).toBe('café.mp4');
  });

  it('accepts supported still-image extensions with their dedicated byte ceiling', () => {
    for (const filename of ['still.png', 'still.jpg', 'still.JPEG', 'still.webp']) {
      expect(normalizeMediaFilename(filename)).toBe(filename.normalize('NFC'));
      expect(mediaImportByteLimit(filename)).toBe(MAX_IMAGE_IMPORT_BYTES);
    }
    expect(mediaImportByteLimit('clip.mp4')).toBe(MAX_MEDIA_IMPORT_BYTES);
  });

  it('rejects extensions outside the supported media and image set', () => {
    expect(() => normalizeMediaFilename('notes.txt')).toThrow(
      expect.objectContaining({ code: 'unsupported-extension', statusCode: 415 }),
    );
  });
});

describe('importMedia', () => {
  it('streams, probes, and publishes a MediaSummary-compatible item', async () => {
    const projectDir = await temporaryProject();

    const item = await importMedia(projectDir, 'camera.MP4', Readable.from(['video-bytes']), {
      expectedBytes: 11,
      probe: successfulProbe,
    });

    expect(item).toEqual({
      kind: 'video',
      relPath: 'camera.MP4',
      durationS: 12.5,
      fps: 29.97,
      width: 1920,
      height: 1080,
      hasAudio: true,
      transcriptEngine: null,
      proxyRelPath: null,
    });
    expect(await readFile(join(projectDir, 'camera.MP4'), 'utf8')).toBe('video-bytes');
    expect(await importTempEntries(projectDir)).toEqual([]);
  });

  it('publishes an audio-only original without inventing video geometry', async () => {
    const projectDir = await temporaryProject();
    const item = await importMedia(projectDir, 'soundtrack.mp3', Readable.from(['audio-bytes']), {
      probe: () =>
        Promise.resolve(ok({ kind: 'audio' as const, durationS: 42, hasAudio: true as const })),
    });

    expect(item).toEqual({
      kind: 'audio',
      relPath: 'soundtrack.mp3',
      durationS: 42,
      hasAudio: true,
      transcriptEngine: null,
      proxyRelPath: null,
    });
    expect(await readFile(join(projectDir, 'soundtrack.mp3'), 'utf8')).toBe('audio-bytes');
  });

  it('validates and publishes a still image under edit/assets without inventing duration', async () => {
    const projectDir = await temporaryProject();
    let timedProbeCalled = false;
    const item = await importMedia(projectDir, 'background.JPEG', Readable.from(['image-bytes']), {
      probe: () => {
        timedProbeCalled = true;
        return successfulProbe();
      },
      probeStillImage: () =>
        Promise.resolve(
          ok({ kind: 'image' as const, width: 2400, height: 1600, hasAudio: false as const }),
        ),
    });

    expect(timedProbeCalled).toBe(false);
    expect(item).toEqual({
      kind: 'image',
      relPath: 'edit/assets/background.JPEG',
      width: 2400,
      height: 1600,
      hasAudio: false,
      transcriptEngine: null,
      proxyRelPath: null,
    });
    expect(await readFile(join(projectDir, 'edit', 'assets', 'background.JPEG'), 'utf8')).toBe(
      'image-bytes',
    );
  });

  it('uses collision-safe names inside edit/assets for still images', async () => {
    const projectDir = await temporaryProject();
    await mkdir(join(projectDir, 'edit', 'assets'), { recursive: true });
    await writeFile(join(projectDir, 'edit', 'assets', 'background.png'), 'original');
    const item = await importMedia(projectDir, 'background.png', Readable.from(['replacement']), {
      probeStillImage: () =>
        Promise.resolve(
          ok({ kind: 'image' as const, width: 100, height: 100, hasAudio: false as const }),
        ),
    });

    expect(item.relPath).toBe('edit/assets/background (1).png');
    expect(await readFile(join(projectDir, 'edit', 'assets', 'background.png'), 'utf8')).toBe(
      'original',
    );
    expect(await readFile(join(projectDir, item.relPath), 'utf8')).toBe('replacement');
  });

  it('enforces the image ceiling even when a caller passes the larger media limit', async () => {
    const projectDir = await temporaryProject();
    await expect(
      importMedia(projectDir, 'huge.webp', Readable.from([]), {
        expectedBytes: MAX_IMAGE_IMPORT_BYTES + 1,
        maxBytes: MAX_MEDIA_IMPORT_BYTES,
        probeStillImage: () =>
          Promise.resolve(
            ok({ kind: 'image' as const, width: 100, height: 100, hasAudio: false as const }),
          ),
      }),
    ).rejects.toMatchObject({ code: 'payload-too-large', statusCode: 413 });
    await expect(readFile(join(projectDir, 'edit', 'assets', 'huge.webp'))).rejects.toBeDefined();
    expect(await importTempEntries(projectDir)).toEqual([]);
  });

  it('suffixes a collision and never changes the original', async () => {
    const projectDir = await temporaryProject();
    await writeFile(join(projectDir, 'camera.mp4'), 'original-bytes');
    await writeFile(join(projectDir, 'camera (1).mp4'), 'another-original');

    const item = await importMedia(projectDir, 'camera.mp4', Readable.from(['new-bytes']), {
      probe: successfulProbe,
    });

    expect(item.relPath).toBe('camera (2).mp4');
    expect(await readFile(join(projectDir, 'camera.mp4'), 'utf8')).toBe('original-bytes');
    expect(await readFile(join(projectDir, 'camera (1).mp4'), 'utf8')).toBe('another-original');
    expect(await readFile(join(projectDir, 'camera (2).mp4'), 'utf8')).toBe('new-bytes');
  });

  it('rejects a zero-byte upload and removes its temporary file', async () => {
    const projectDir = await temporaryProject();

    await expect(
      importMedia(projectDir, 'empty.mp4', Readable.from([]), { probe: successfulProbe }),
    ).rejects.toMatchObject({ code: 'empty-upload', statusCode: 400 });
    expect(await importTempEntries(projectDir)).toEqual([]);
  });

  it('returns 413 semantics when streamed bytes exceed the limit and cleans up', async () => {
    const projectDir = await temporaryProject();

    await expect(
      importMedia(projectDir, 'large.mp4', Readable.from(['1234']), {
        maxBytes: 3,
        probe: successfulProbe,
      }),
    ).rejects.toMatchObject({ code: 'payload-too-large', statusCode: 413 });
    expect(await importTempEntries(projectDir)).toEqual([]);
  });

  it('rejects an oversized declared length before creating a temporary file', async () => {
    const projectDir = await temporaryProject();

    await expect(
      importMedia(projectDir, 'large.mp4', Readable.from(['123']), {
        expectedBytes: 4,
        maxBytes: 3,
        probe: successfulProbe,
      }),
    ).rejects.toMatchObject({ code: 'payload-too-large', statusCode: 413 });
    expect(await importTempEntries(projectDir)).toEqual([]);
  });

  it('rejects an incomplete declared length and cleans up', async () => {
    const projectDir = await temporaryProject();

    await expect(
      importMedia(projectDir, 'partial.mp4', Readable.from(['123']), {
        expectedBytes: 10,
        probe: successfulProbe,
      }),
    ).rejects.toMatchObject({ code: 'incomplete-upload', statusCode: 400 });
    expect(await importTempEntries(projectDir)).toEqual([]);
  });

  it('cleans up when the upload stream fails midway', async () => {
    const projectDir = await temporaryProject();
    let started = false;
    const interrupted = new Readable({
      read() {
        if (started) return;
        started = true;
        this.push('partial');
        this.destroy(new Error('connection lost'));
      },
    });

    await expect(
      importMedia(projectDir, 'partial.mp4', interrupted, { probe: successfulProbe }),
    ).rejects.toMatchObject({ code: 'incomplete-upload', statusCode: 400 });
    expect(await importTempEntries(projectDir)).toEqual([]);
  });

  it('does not publish invalid video bytes and cleans up after probing', async () => {
    const projectDir = await temporaryProject();

    await expect(
      importMedia(projectDir, 'not-video.mp4', Readable.from(['not-a-video']), {
        probe: () => Promise.resolve(err('ffmpeg-failed', 'invalid fixture')),
      }),
    ).rejects.toMatchObject({ code: 'invalid-media', statusCode: 422 });
    await expect(readFile(join(projectDir, 'not-video.mp4'))).rejects.toBeDefined();
    expect(await importTempEntries(projectDir)).toEqual([]);
  });

  it('does not publish an image when still-image validation fails', async () => {
    const projectDir = await temporaryProject();

    await expect(
      importMedia(projectDir, 'unsafe.webp', Readable.from(['not-an-image']), {
        probeStillImage: () => Promise.resolve(err('ffmpeg-failed', 'unsafe image fixture')),
      }),
    ).rejects.toMatchObject({ code: 'invalid-media', statusCode: 422 });
    await expect(readFile(join(projectDir, 'edit', 'assets', 'unsafe.webp'))).rejects.toBeDefined();
    expect(await importTempEntries(projectDir)).toEqual([]);
  });
});
