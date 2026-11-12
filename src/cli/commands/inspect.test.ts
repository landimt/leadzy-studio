import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { ffmpegBinary } from '../../server/services/ffmpeg.js';
import { loadEditDoc } from '../../server/services/project.js';
import {
  renderInputFingerprints,
  writeRenderReceipt,
} from '../../server/services/renderReceipt.js';
import {
  keytermsFingerprint,
  transcriptMediaFingerprint,
} from '../../server/services/transcribe.js';
import {
  isPendingTranscript,
  mediaSummaryLine,
  projectStatus,
  transcriptSummaryLine,
  validateProject,
  type TranscriptStatus,
} from './inspect.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(docOverrides: Record<string, unknown> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'leadzy-inspect-'));
  roots.push(root);
  await mkdir(join(root, 'edit', 'assets'), { recursive: true });
  await writeFile(join(root, 'camera.mp4'), 'media');
  await writeFile(join(root, 'edit', 'assets', 'card.png'), 'image');
  const doc = {
    version: 2,
    fps: 25,
    output: { width: 1080, height: 1920, loudnormLufs: -14, speed: 2 },
    sources: { cam: { path: 'camera.mp4', durationS: 4 } },
    tracks: [
      { id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 4 }] },
      {
        id: 'elements',
        kind: 'overlay',
        blocks: [{ file: 'edit/assets/card.png', at: 0, duration: 1 }],
      },
    ],
    subtitles: { enabled: false, preset: 'pill' },
    totalDurationS: 4,
    ...docOverrides,
  };
  await writeFile(join(root, 'edit', 'edit.json'), JSON.stringify(doc));
  return root;
}

describe('agent project inspection', () => {
  it('returns stable status fields and distinguishes editorial from rendered duration', async () => {
    const root = await project();
    const status = await projectStatus(root);
    expect('validation' in status).toBe(true);
    if (!('validation' in status)) return;
    expect(status).toMatchObject({
      sources: 1,
      tracks: 2,
      blocks: 2,
      baseBlocks: 1,
      editorialDurationS: 4,
      renderedDurationS: 2,
      outputSpeed: 2,
      previewExists: false,
      previewEditHash: null,
      previewCurrent: false,
      audioPreviewExists: false,
      audioComparisonExists: false,
      audioPreviewEditHash: null,
      audioPreviewCurrent: false,
      audioComparisonCurrent: false,
      finalExists: false,
      finalEditHash: null,
      finalCurrent: false,
    });
    expect(status.validation.ok).toBe(true);
    expect(status.editHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reports missing references and a stale derived duration', async () => {
    const root = await project({
      sources: { cam: { path: 'missing.mp4', durationS: 4 } },
      totalDurationS: 9,
    });
    const report = await validateProject(root);
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(['missing-media', 'stale-duration']);
  });

  it('rejects paths that escape the creative folder', async () => {
    const root = await project({ sources: { cam: { path: '../outside.mp4', durationS: 4 } } });
    const report = await validateProject(root);
    expect(report.ok).toBe(false);
    expect(report.issues[0]?.code).toBe('path-outside-project');
  });

  it('reports an existing preview as stale until its snapshot matches edit.json', async () => {
    const root = await project();
    const loaded = await loadEditDoc(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const currentDoc = loaded.value.doc;
    const currentBase = currentDoc.tracks[0];
    if (currentBase?.kind !== 'video') return;
    const staleDoc: typeof currentDoc = {
      ...currentDoc,
      tracks: [
        {
          ...currentBase,
          blocks: currentBase.blocks.map((block) => ({ ...block, out: block.out - 0.5 })),
        },
        ...currentDoc.tracks.slice(1),
      ],
      totalDurationS: 3.5,
    };
    await mkdir(join(root, 'edit', 'cache'), { recursive: true });
    await writeFile(join(root, 'edit', 'preview.mp4'), 'preview');
    await writeFile(join(root, 'edit', 'audio-preview.m4a'), 'audio preview');
    const stalePreviewInputs = await renderInputFingerprints(root, staleDoc, 'preview');
    const staleAudioInputs = await renderInputFingerprints(root, staleDoc, 'audio-preview');
    expect(stalePreviewInputs.ok && staleAudioInputs.ok).toBe(true);
    if (!stalePreviewInputs.ok || !staleAudioInputs.ok) return;
    await writeRenderReceipt(root, 'preview', staleDoc, stalePreviewInputs.value);
    await writeRenderReceipt(root, 'audio-preview', staleDoc, staleAudioInputs.value);

    const stale = await projectStatus(root);
    expect('validation' in stale && stale.previewExists).toBe(true);
    expect('validation' in stale && stale.previewCurrent).toBe(false);
    expect('validation' in stale && stale.audioPreviewExists).toBe(true);
    expect('validation' in stale && stale.audioComparisonExists).toBe(false);
    expect('validation' in stale && stale.audioPreviewCurrent).toBe(false);
    expect('validation' in stale && stale.audioComparisonCurrent).toBe(false);

    const currentPreviewInputs = await renderInputFingerprints(root, currentDoc, 'preview');
    const currentAudioInputs = await renderInputFingerprints(root, currentDoc, 'audio-preview');
    expect(currentPreviewInputs.ok && currentAudioInputs.ok).toBe(true);
    if (!currentPreviewInputs.ok || !currentAudioInputs.ok) return;
    await writeRenderReceipt(root, 'preview', currentDoc, currentPreviewInputs.value);
    await writeRenderReceipt(root, 'audio-preview', currentDoc, currentAudioInputs.value);
    const legacyCurrent = await projectStatus(root);
    expect('validation' in legacyCurrent && legacyCurrent.audioPreviewCurrent).toBe(true);
    expect('validation' in legacyCurrent && legacyCurrent.audioComparisonExists).toBe(false);
    expect('validation' in legacyCurrent && legacyCurrent.audioComparisonCurrent).toBe(false);

    await writeFile(join(root, 'edit', 'audio-preview-before.m4a'), 'audio before');
    const current = await projectStatus(root);
    expect('validation' in current && current.previewCurrent).toBe(true);
    expect('validation' in current && current.audioComparisonExists).toBe(true);
    expect('validation' in current && current.audioPreviewCurrent).toBe(true);
    expect('validation' in current && current.audioComparisonCurrent).toBe(true);
    if ('validation' in current) {
      expect(current.previewEditHash).toBe(current.editHash);
      expect(current.audioPreviewEditHash).toBe(current.editHash);
    }

    await writeFile(join(root, 'camera.mp4'), 'replacement media bytes');
    const replaced = await projectStatus(root);
    expect('validation' in replaced && replaced.previewCurrent).toBe(false);
    expect('validation' in replaced && replaced.audioPreviewCurrent).toBe(false);
    expect('validation' in replaced && replaced.audioComparisonCurrent).toBe(false);
  });

  it('keeps audio current across visual effects but invalidates an audible cut', async () => {
    const root = await project();
    const loaded = await loadEditDoc(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const renderedDoc = loaded.value.doc;
    const inputs = await renderInputFingerprints(root, renderedDoc, 'audio-preview');
    expect(inputs.ok).toBe(true);
    if (!inputs.ok) return;
    await writeRenderReceipt(root, 'audio-preview', renderedDoc, inputs.value);
    await Promise.all([
      writeFile(join(root, 'edit', 'audio-preview-before.m4a'), 'before'),
      writeFile(join(root, 'edit', 'audio-preview.m4a'), 'after'),
    ]);

    const visualDoc = {
      ...renderedDoc,
      tracks: [
        ...renderedDoc.tracks,
        {
          id: 'effects',
          kind: 'effect' as const,
          blocks: [{ type: 'zoom' as const, at: 1.25, duration: 0.6, scale: 1.2 }],
        },
      ],
    };
    await writeFile(join(root, 'edit', 'edit.json'), JSON.stringify(visualDoc));
    const visual = await projectStatus(root);
    expect('validation' in visual && visual.audioComparisonCurrent).toBe(true);
    if ('validation' in visual) {
      expect(visual.audioPreviewEditHash).not.toBe(visual.editHash);
    }

    const base = visualDoc.tracks[0];
    if (base?.kind !== 'video') return;
    const cutDoc = {
      ...visualDoc,
      tracks: [
        {
          ...base,
          blocks: base.blocks.map((block) => ({ ...block, out: block.out - 0.5 })),
        },
        ...visualDoc.tracks.slice(1),
      ],
      totalDurationS: 3.5,
    };
    await writeFile(join(root, 'edit', 'edit.json'), JSON.stringify(cutDoc));
    const cut = await projectStatus(root);
    expect('validation' in cut && cut.audioComparisonCurrent).toBe(false);
  });
});

describe('transcript status', () => {
  const cache = (sourceHash: string, keytermsHash: string): string =>
    JSON.stringify({
      engine: 'scribe',
      model: 'scribe_v2',
      sourceHash,
      keytermsHash,
      transcribedAt: '2026-08-27T15:00:00.000Z',
      transcript: { text: 'olá', words: [{ text: 'olá', start: 0, end: 0.4, type: 'word' }] },
    });

  async function hashOf(path: string): Promise<string> {
    const hash = await transcriptMediaFingerprint(path);
    if (!hash.ok) throw new Error(hash.error.message);
    return hash.value;
  }

  async function clip(target: string, audible: boolean): Promise<boolean> {
    const inputs = audible
      ? [
          '-f',
          'lavfi',
          '-i',
          'color=c=black:s=64x64:r=25',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:sample_rate=16000',
        ]
      : ['-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=25'];
    try {
      await execa(ffmpegBinary(), [
        '-hide_banner',
        '-v',
        'error',
        '-y',
        ...inputs,
        '-t',
        '1',
        '-pix_fmt',
        'yuv420p',
        target,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  it('reports each media as fresh, why it would be redone, silent or unreadable', async () => {
    const root = await project({ transcription: { keyterms: ['Leadzy'] } });
    await rm(join(root, 'camera.mp4'));
    if (!(await clip(join(root, 'camera.mp4'), true))) return;
    await clip(join(root, 'changed.mp4'), true);
    await clip(join(root, 'replaced.mp4'), true);
    await clip(join(root, 'silent.mp4'), false);
    await writeFile(join(root, 'broken.mp4'), 'not a video');
    await mkdir(join(root, 'edit', 'transcripts'), { recursive: true });
    await writeFile(
      join(root, 'edit', 'transcripts', 'camera.mp4.json'),
      cache(await hashOf(join(root, 'camera.mp4')), keytermsFingerprint(['Leadzy'])),
    );
    await writeFile(
      join(root, 'edit', 'transcripts', 'changed.mp4.json'),
      cache(await hashOf(join(root, 'changed.mp4')), keytermsFingerprint([])),
    );
    await writeFile(
      join(root, 'edit', 'transcripts', 'replaced.mp4.json'),
      cache('a hash from before the file was replaced', keytermsFingerprint(['Leadzy'])),
    );

    const status = await projectStatus(root);

    expect('transcripts' in status).toBe(true);
    if (!('transcripts' in status)) return;
    expect(status.keyterms).toEqual(['Leadzy']);
    expect(status.transcripts.map((t) => [t.relPath, t.model, t.transcribedAt, t.state])).toEqual([
      ['broken.mp4', null, null, 'unreadable'],
      ['camera.mp4', 'scribe_v2', '2026-08-27T15:00:00.000Z', 'fresh'],
      ['changed.mp4', 'scribe_v2', '2026-08-27T15:00:00.000Z', 'stale-keyterms'],
      ['replaced.mp4', 'scribe_v2', '2026-08-27T15:00:00.000Z', 'stale-media'],
      ['silent.mp4', null, null, 'silent'],
    ]);
    expect(status.transcripts.filter(isPendingTranscript).map((t) => t.relPath)).toEqual([
      'changed.mp4',
      'replaced.mp4',
    ]);
    expect(status.media.map((m) => [m.relPath, m.sourceId, m.hasAudio, m.width])).toEqual([
      ['broken.mp4', null, null, null],
      ['camera.mp4', 'cam', true, 64],
      ['changed.mp4', null, true, 64],
      ['replaced.mp4', null, true, 64],
      ['silent.mp4', null, false, 64],
    ]);
    expect(status.media[1]).toMatchObject({ durationS: 1, height: 64, fps: 25 });
    expect(mediaSummaryLine(status.media)).toBe(
      'media not in edit.json: broken.mp4, changed.mp4 (1.0s), replaced.mp4 (1.0s), silent.mp4 (1.0s) — add it to sources to transcribe, pack or cut it',
    );
    expect(mediaSummaryLine(status.media.filter((m) => m.sourceId !== null))).toBeNull();
  });

  it('trusts a fresh cache even when ffprobe cannot read the file (a cache proves the media had audio)', async () => {
    const root = await project();
    await rm(join(root, 'camera.mp4'));
    await writeFile(join(root, 'camera.mp4'), 'not a video at all');
    await mkdir(join(root, 'edit', 'transcripts'), { recursive: true });
    await writeFile(
      join(root, 'edit', 'transcripts', 'camera.mp4.json'),
      cache(await hashOf(join(root, 'camera.mp4')), keytermsFingerprint([])),
    );

    const status = await projectStatus(root);

    if (!('transcripts' in status)) throw new Error('expected a status');
    expect(status.transcripts[0]?.state).toBe('fresh');
  });

  it('reports a media without a current-engine cache as missing, never stale', async () => {
    const root = await project();
    await rm(join(root, 'camera.mp4'));
    if (!(await clip(join(root, 'camera.mp4'), true))) return;
    await mkdir(join(root, 'edit', 'transcripts'), { recursive: true });
    await writeFile(
      join(root, 'edit', 'transcripts', 'camera.mp4.json'),
      JSON.stringify({ engine: 'scribe', sourceHash: 'h', transcript: {} }),
    );

    const status = await projectStatus(root);

    if (!('transcripts' in status)) throw new Error('expected a status');
    expect(status.transcripts).toEqual([
      { relPath: 'camera.mp4', model: null, transcribedAt: null, state: 'missing' },
    ]);
  });
});

describe('transcriptSummaryLine', () => {
  const status = (relPath: string, state: TranscriptStatus['state']): TranscriptStatus => ({
    relPath,
    model: state === 'missing' || state === 'silent' || state === 'unreadable' ? null : 'scribe_v2',
    transcribedAt: null,
    state,
  });

  it('counts fresh over audible media and calls out what the next transcribe touches', () => {
    expect(
      transcriptSummaryLine([
        status('a.mp4', 'fresh'),
        status('b.mp4', 'stale-media'),
        status('c.mp4', 'missing'),
        status('d.mp4', 'silent'),
        status('e.mp4', 'unreadable'),
      ]),
    ).toBe(
      'transcripts 1/3 · 2 pending (missing, media or keyterms changed) — run studio transcribe · 1 unreadable (ffprobe failed)',
    );
  });

  it('stays quiet when everything audible is fresh', () => {
    expect(transcriptSummaryLine([status('a.mp4', 'fresh'), status('d.mp4', 'silent')])).toBe(
      'transcripts 1/1',
    );
  });
});
