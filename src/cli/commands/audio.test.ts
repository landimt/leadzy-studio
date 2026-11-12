import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { editDocHash, loadEditDoc } from '../../server/services/project.js';
import { clearAudioNoiseSample, setAudioNoiseSample } from './audio.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; hash: string }> {
  const root = await mkdtemp(join(tmpdir(), 'leadzy-audio-sample-'));
  roots.push(root);
  await mkdir(join(root, 'edit'), { recursive: true });
  await writeFile(join(root, 'camera.mp4'), 'media');
  await writeFile(
    join(root, 'edit', 'edit.json'),
    JSON.stringify({
      version: 2,
      fps: 25,
      output: { width: 1080, height: 1920, loudnormLufs: -14, denoise: 0.2 },
      sources: { cam: { path: 'camera.mp4', durationS: 4 } },
      tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 4 }] }],
      subtitles: { enabled: false, preset: 'pill' },
      totalDurationS: 4,
    }),
  );
  const loaded = await loadEditDoc(root);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return { root, hash: editDocHash(loaded.value.doc) };
}

describe('audio room-tone CLI transaction', () => {
  it('sets and clears a source-time sample through the safe edit path', async () => {
    const { root, hash } = await fixture();
    const set = await setAudioNoiseSample(root, {
      source: 'cam',
      start: 0.5,
      end: 1.2,
      strength: 0.35,
      expectHash: hash,
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const sampled = await loadEditDoc(root);
    expect(sampled.ok).toBe(true);
    if (!sampled.ok) return;
    expect(sampled.value.doc.output).toMatchObject({
      denoise: 0.35,
      denoiseSample: { source: 'cam', start: 0.5, end: 1.2 },
    });

    const cleared = await clearAudioNoiseSample(root, set.value.editHash);
    expect(cleared.ok).toBe(true);
    const automatic = await loadEditDoc(root);
    expect(automatic.ok).toBe(true);
    if (automatic.ok) expect(automatic.value.doc.output.denoiseSample).toBeUndefined();
  });

  it('rejects a sample outside the declared source duration', async () => {
    const { root, hash } = await fixture();
    const result = await setAudioNoiseSample(root, {
      source: 'cam',
      start: 3.5,
      end: 4.5,
      expectHash: hash,
    });
    expect(result.ok).toBe(false);
  });
});
