import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EditDoc } from '../../core/schema.js';
import {
  RENDERER_CONTRACT_FINGERPRINT,
  renderInputFingerprints,
  renderSnapshotInfo,
  writeRenderReceipt,
} from './renderReceipt.js';
import { acquireResolvedProjectMedia } from './resolvedMedia.js';

const roots: string[] = [];

async function root(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('render receipts and input fingerprints', () => {
  it('fingerprints the pinned execution path rather than a changed authoring symlink', async () => {
    const projectDir = await root('leadzy-project-');
    const first = join(projectDir, 'first.mp4');
    const second = join(projectDir, 'second.mp4');
    await writeFile(first, 'first bytes');
    await writeFile(second, 'different second bytes');
    await symlink('first.mp4', join(projectDir, 'camera.mp4'));
    const doc: EditDoc = {
      version: 2,
      fps: 25,
      output: { width: 1080, height: 1920, loudnormLufs: null },
      sources: { cam: { path: 'camera.mp4' } },
      tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 1 }] }],
      subtitles: { enabled: false, preset: 'pill' },
    };
    const executionDoc: EditDoc = {
      ...doc,
      sources: { cam: { path: first } },
    };
    await unlink(join(projectDir, 'camera.mp4'));
    await symlink('second.mp4', join(projectDir, 'camera.mp4'));

    const pinned = await renderInputFingerprints(projectDir, doc, 'audio-preview', executionDoc);
    const current = await renderInputFingerprints(projectDir, doc, 'audio-preview');
    expect(pinned.ok).toBe(true);
    expect(current.ok).toBe(true);
    if (!pinned.ok || !current.ok) return;
    expect(pinned.value['source:cam']).not.toBe(current.value['source:cam']);
  });

  it('uses the hash captured by the lease when the authoring path changes before baseline assembly', async () => {
    const projectDir = await root('leadzy-project-');
    const first = join(projectDir, 'first.mp4');
    const second = join(projectDir, 'second.mp4');
    await writeFile(first, 'first bytes');
    await writeFile(second, 'different second bytes');
    await symlink('first.mp4', join(projectDir, 'camera.mp4'));
    const doc: EditDoc = {
      version: 2,
      fps: 25,
      output: { width: 1080, height: 1920, loudnormLufs: null },
      sources: { cam: { path: 'camera.mp4' } },
      tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 1 }] }],
      subtitles: { enabled: false, preset: 'pill' },
    };
    const leased = await acquireResolvedProjectMedia(projectDir, doc);
    expect(leased.ok).toBe(true);
    if (!leased.ok) return;

    try {
      await unlink(join(projectDir, 'camera.mp4'));
      await symlink('second.mp4', join(projectDir, 'camera.mp4'));

      const captured = await renderInputFingerprints(
        projectDir,
        doc,
        'audio-preview',
        undefined,
        leased.value.authoringMediaHashes,
      );
      const current = await renderInputFingerprints(projectDir, doc, 'audio-preview');
      expect(captured.ok).toBe(true);
      expect(current.ok).toBe(true);
      if (!captured.ok || !current.ok) return;
      expect(captured.value['source:cam']).toBe(
        leased.value.authoringMediaHashes.get('camera.mp4'),
      );
      expect(captured.value['source:cam']).not.toBe(current.value['source:cam']);
    } finally {
      await leased.value.release();
    }
  });

  it('fingerprints only media that can enter an audio preview', async () => {
    const projectDir = await root('leadzy-project-');
    await Promise.all([
      writeFile(join(projectDir, 'camera.mp4'), 'camera audio'),
      writeFile(join(projectDir, 'audible.mp4'), 'layer audio'),
      writeFile(join(projectDir, 'visual.mp4'), 'visual-only layer'),
      writeFile(join(projectDir, 'tone.mp4'), 'manual room tone'),
    ]);
    const doc: EditDoc = {
      version: 2,
      fps: 25,
      output: {
        width: 1080,
        height: 1920,
        loudnormLufs: -14,
        denoise: 0.3,
        denoiseSample: { source: 'tone', start: 0, end: 0.5 },
      },
      sources: {
        cam: { path: 'camera.mp4' },
        audible: { path: 'audible.mp4' },
        visual: { path: 'visual.mp4' },
        tone: { path: 'tone.mp4' },
      },
      tracks: [
        { id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 1 }] },
        {
          id: 'layers',
          kind: 'video',
          blocks: [
            {
              source: 'audible',
              in: 0,
              out: 1,
              at: 0,
              mode: 'pip',
              audio: 'duck',
            },
            {
              source: 'visual',
              in: 0,
              out: 1,
              at: 0,
              mode: 'pip',
              audio: 'mute',
            },
          ],
        },
      ],
      subtitles: { enabled: false, preset: 'pill' },
    };

    const result = await renderInputFingerprints(projectDir, doc, 'audio-preview');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value).sort()).toEqual([
      'source:audible',
      'source:cam',
      'source:tone',
    ]);
  });

  it('fingerprints a program by its base, audible layers and audio clips — never overlays or transcripts', async () => {
    const projectDir = await root('leadzy-project-');
    await Promise.all([
      writeFile(join(projectDir, 'camera.mp4'), 'camera'),
      writeFile(join(projectDir, 'audible.mp4'), 'layer audio'),
      writeFile(join(projectDir, 'visual.mp4'), 'visual-only layer'),
    ]);
    // the overlay file is deliberately absent: the program never reads it
    const doc: EditDoc = {
      version: 2,
      fps: 25,
      output: { width: 1080, height: 1920, loudnormLufs: -14 },
      sources: {
        cam: { path: 'camera.mp4' },
        audible: { path: 'audible.mp4' },
        visual: { path: 'visual.mp4' },
      },
      tracks: [
        { id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 1 }] },
        {
          id: 'layers',
          kind: 'video',
          blocks: [
            { source: 'audible', in: 0, out: 1, at: 0, mode: 'pip', audio: 'duck' },
            { source: 'visual', in: 0, out: 1, at: 0, mode: 'pip', audio: 'mute' },
          ],
        },
        {
          id: 'overlays',
          kind: 'overlay',
          blocks: [{ file: 'edit/assets/cta.webm', at: 0, duration: 1 }],
        },
      ],
      subtitles: { enabled: true, preset: 'pill' },
    };

    const program = await renderInputFingerprints(projectDir, doc, 'program');

    expect(program.ok).toBe(true);
    if (!program.ok) return;
    expect(Object.keys(program.value).sort()).toEqual(['source:audible', 'source:cam']);
  });

  it('fingerprints the canvas background video and the denoise sample of a program', async () => {
    const projectDir = await root('leadzy-project-');
    await Promise.all([
      writeFile(join(projectDir, 'camera.mp4'), 'camera'),
      writeFile(join(projectDir, 'bg.mp4'), 'background loop'),
      writeFile(join(projectDir, 'tone.wav'), 'room tone'),
    ]);
    const doc: EditDoc = {
      version: 2,
      fps: 25,
      output: {
        width: 1080,
        height: 1920,
        loudnormLufs: -14,
        denoise: 0.4,
        denoiseSample: { source: 'tone', start: 0, end: 0.5 },
      },
      sources: { cam: { path: 'camera.mp4' }, bg: { path: 'bg.mp4' }, tone: { path: 'tone.wav' } },
      tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 1 }] }],
      canvas: { background: { kind: 'video', source: 'bg', fit: 'cover' }, base: { mode: 'fill' } },
      subtitles: { enabled: false, preset: 'pill' },
    };

    const program = await renderInputFingerprints(projectDir, doc, 'program');

    expect(program.ok).toBe(true);
    if (!program.ok) return;
    expect(Object.keys(program.value).sort()).toEqual(['source:bg', 'source:cam', 'source:tone']);
  });

  it('fingerprints an image canvas background only for visual artifacts', async () => {
    const projectDir = await root('leadzy-project-');
    await mkdir(join(projectDir, 'edit', 'assets'), { recursive: true });
    await Promise.all([
      writeFile(join(projectDir, 'camera.mp4'), 'camera bytes'),
      writeFile(join(projectDir, 'edit', 'assets', 'background.png'), 'background v1'),
    ]);
    const doc: EditDoc = {
      version: 2,
      fps: 25,
      output: { width: 1080, height: 1920, loudnormLufs: null },
      sources: { cam: { path: 'camera.mp4' } },
      tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 1 }] }],
      subtitles: { enabled: false, preset: 'pill' },
      canvas: {
        background: { kind: 'image', file: 'edit/assets/background.png', fit: 'cover' },
        base: { mode: 'fill' },
      },
    };

    const previewV1 = await renderInputFingerprints(projectDir, doc, 'preview');
    const finalV1 = await renderInputFingerprints(projectDir, doc, 'final');
    const audioV1 = await renderInputFingerprints(projectDir, doc, 'audio-preview');
    expect(previewV1.ok && Object.keys(previewV1.value).sort()).toEqual([
      'background:edit/assets/background.png',
      'source:cam',
    ]);
    expect(finalV1.ok && Object.keys(finalV1.value).sort()).toEqual([
      'background:edit/assets/background.png',
      'source:cam',
    ]);
    expect(audioV1.ok && Object.keys(audioV1.value)).toEqual(['source:cam']);
    if (!previewV1.ok || !audioV1.ok) return;

    await writeFile(join(projectDir, 'edit', 'assets', 'background.png'), 'background v2');
    const previewV2 = await renderInputFingerprints(projectDir, doc, 'preview');
    const audioV2 = await renderInputFingerprints(projectDir, doc, 'audio-preview');
    expect(previewV2.ok).toBe(true);
    expect(audioV2.ok).toBe(true);
    if (!previewV2.ok || !audioV2.ok) return;
    expect(previewV2.value['background:edit/assets/background.png']).not.toBe(
      previewV1.value['background:edit/assets/background.png'],
    );
    expect(audioV2.value).toEqual(audioV1.value);
  });

  it('retains a canvas background video source only for visual fingerprints', async () => {
    const projectDir = await root('leadzy-project-');
    await Promise.all([
      writeFile(join(projectDir, 'camera.mp4'), 'camera bytes'),
      writeFile(join(projectDir, 'background.mp4'), 'background video bytes'),
    ]);
    const doc: EditDoc = {
      version: 2,
      fps: 25,
      output: { width: 1080, height: 1920, loudnormLufs: null },
      sources: {
        cam: { path: 'camera.mp4' },
        background: { path: 'background.mp4' },
      },
      tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 1 }] }],
      subtitles: { enabled: false, preset: 'pill' },
      canvas: {
        background: { kind: 'video', source: 'background', fit: 'contain' },
        base: { mode: 'fill' },
      },
    };

    const preview = await renderInputFingerprints(projectDir, doc, 'preview');
    const audio = await renderInputFingerprints(projectDir, doc, 'audio-preview');
    expect(preview.ok && Object.keys(preview.value).sort()).toEqual([
      'source:background',
      'source:cam',
    ]);
    expect(audio.ok && Object.keys(audio.value)).toEqual(['source:cam']);
  });

  it('tracks subtitle transcripts only for sources used by the base video track', async () => {
    const projectDir = await root('leadzy-project-');
    const transcriptDir = join(projectDir, 'edit', 'transcripts');
    await mkdir(transcriptDir, { recursive: true });
    await Promise.all([
      writeFile(join(projectDir, 'camera.mp4'), 'camera bytes'),
      writeFile(join(projectDir, 'music.wav'), 'music bytes'),
      writeFile(join(transcriptDir, 'camera.mp4.json'), 'camera transcript v1'),
      writeFile(join(transcriptDir, 'music.wav.json'), 'music transcript v1'),
    ]);
    const doc: EditDoc = {
      version: 2,
      fps: 25,
      output: { width: 1080, height: 1920, loudnormLufs: null },
      sources: {
        cam: { path: 'camera.mp4' },
        music: { path: 'music.wav' },
      },
      tracks: [
        { id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 1 }] },
        {
          id: 'music',
          kind: 'audio',
          blocks: [{ source: 'music', in: 0, out: 1, at: 0 }],
        },
      ],
      subtitles: { enabled: true, preset: 'pill' },
    };

    const inputs = await renderInputFingerprints(projectDir, doc, 'preview');
    expect(inputs.ok).toBe(true);
    if (!inputs.ok) return;
    expect(Object.keys(inputs.value).sort()).toEqual([
      'source:cam',
      'source:music',
      'transcript:cam',
    ]);
    await writeRenderReceipt(projectDir, 'preview', doc, inputs.value);

    await writeFile(join(transcriptDir, 'music.wav.json'), 'music transcript v2');
    expect(await renderSnapshotInfo(projectDir, 'preview')).not.toBeNull();

    await writeFile(join(transcriptDir, 'camera.mp4.json'), 'camera transcript v2');
    expect(await renderSnapshotInfo(projectDir, 'preview')).toBeNull();
  });

  it('invalidates receipts without the current renderer contract fingerprint', async () => {
    const projectDir = await root('leadzy-project-');
    await writeFile(join(projectDir, 'camera.mp4'), 'camera bytes');
    const doc: EditDoc = {
      version: 2,
      fps: 25,
      output: { width: 1080, height: 1920, loudnormLufs: null },
      sources: { cam: { path: 'camera.mp4' } },
      tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 1 }] }],
      subtitles: { enabled: false, preset: 'pill' },
    };
    const inputs = await renderInputFingerprints(projectDir, doc, 'preview');
    expect(inputs.ok).toBe(true);
    if (!inputs.ok) return;
    await writeRenderReceipt(projectDir, 'preview', doc, inputs.value);

    const receiptPath = join(projectDir, 'edit', 'cache', 'preview.inputs.json');
    const current = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
    expect(current.rendererContract).toBe(RENDERER_CONTRACT_FINGERPRINT);
    expect(await renderSnapshotInfo(projectDir, 'preview')).not.toBeNull();

    const legacy = { ...current };
    delete legacy.rendererContract;
    await writeFile(receiptPath, `${JSON.stringify(legacy)}\n`);
    expect(await renderSnapshotInfo(projectDir, 'preview')).toBeNull();

    await writeFile(
      receiptPath,
      `${JSON.stringify({ ...current, rendererContract: 'leadzy-renderer-contract-v1' })}\n`,
    );
    expect(await renderSnapshotInfo(projectDir, 'preview')).toBeNull();
  });

  it('accepts known legacy muted-source fingerprints but rejects arbitrary receipt keys', async () => {
    const projectDir = await root('leadzy-project-');
    await Promise.all([
      writeFile(join(projectDir, 'camera.mp4'), 'camera audio'),
      writeFile(join(projectDir, 'visual.mp4'), 'visual-only layer'),
    ]);
    const doc: EditDoc = {
      version: 2,
      fps: 25,
      output: { width: 1080, height: 1920, loudnormLufs: -14 },
      sources: { cam: { path: 'camera.mp4' }, visual: { path: 'visual.mp4' } },
      tracks: [
        { id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 1 }] },
        {
          id: 'visual-layer',
          kind: 'video',
          blocks: [
            {
              source: 'visual',
              in: 0,
              out: 1,
              at: 0,
              mode: 'pip',
              audio: 'mute',
            },
          ],
        },
      ],
      subtitles: { enabled: false, preset: 'pill' },
    };
    const legacyInputs = await renderInputFingerprints(projectDir, doc, 'preview');
    expect(legacyInputs.ok).toBe(true);
    if (!legacyInputs.ok) return;
    await writeRenderReceipt(projectDir, 'audio-preview', doc, legacyInputs.value);

    await writeFile(join(projectDir, 'visual.mp4'), 'changed visual-only bytes');
    expect(await renderSnapshotInfo(projectDir, 'audio-preview')).not.toBeNull();

    const current = await renderInputFingerprints(projectDir, doc, 'audio-preview');
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    await writeRenderReceipt(projectDir, 'audio-preview', doc, {
      ...current.value,
      unexpected: 'not a version-1 source key',
    });
    expect(await renderSnapshotInfo(projectDir, 'audio-preview')).toBeNull();
  });
});
