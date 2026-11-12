import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EditDoc } from '../../core/schema.js';
import { acquireProjectLock } from './projectLock.js';
import { finalHearingPlan, parseSnapshot, runQa } from './qa.js';

const doc: EditDoc = {
  version: 2,
  fps: 25,
  output: { width: 1080, height: 1920, loudnormLufs: -14 },
  sources: { camera: { path: 'camera.mp4' } },
  tracks: [
    {
      id: 'base',
      kind: 'video',
      blocks: [{ source: 'camera', in: 0, out: 1 }],
    },
  ],
  subtitles: { enabled: false, preset: '2p-caps' },
};

let projectDir: string | undefined;

afterEach(async () => {
  if (projectDir) await rm(projectDir, { recursive: true, force: true });
  projectDir = undefined;
});

describe('QA render publication consistency', () => {
  it('refuses to read final.mp4 while a render owns the publication lock', async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'leadzy-qa-lock-'));
    const lock = await acquireProjectLock(projectDir, 'render');
    try {
      const result = await runQa(projectDir, doc, {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('io-failed');
        expect(result.error.message).toContain('render is already in progress');
      }
    } finally {
      await lock.release();
    }
  });

  it('recovers an interrupted final publication before reading the artifact pair', async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'leadzy-qa-recovery-'));
    const editDir = join(projectDir, 'edit');
    const cacheDir = join(editDir, 'cache');
    const jobDir = join(cacheDir, 'render-jobs', 'crashed-final');
    await mkdir(jobDir, { recursive: true });
    await Promise.all([
      writeFile(join(jobDir, 'previous-final.mp4'), 'old-final'),
      writeFile(join(jobDir, 'previous-receipt-edit.json'), JSON.stringify(doc)),
      writeFile(join(jobDir, 'previous-receipt-inputs.json'), '{}\n'),
      writeFile(join(editDir, 'final.mp4'), 'interrupted-new-final'),
      writeFile(join(cacheDir, 'final.edit.json'), '{}\n'),
      writeFile(
        join(jobDir, 'publication.json'),
        `${JSON.stringify({
          version: 1,
          artifactKind: 'final',
          canonical: true,
          phase: 'prepared',
          previous: [true, true, true],
        })}\n`,
      ),
    ]);

    const result = await runQa(projectDir, doc, {});
    expect(result.ok).toBe(false); // The synthetic bytes are not media.
    expect(await readFile(join(editDir, 'final.mp4'), 'utf8')).toBe('old-final');
    await expect(access(jobDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('finalHearingPlan', () => {
  it('hears a sped-up final slowed down and maps the times back', () => {
    expect(finalHearingPlan(1.1)).toEqual({ audioTempo: 1 / 1.1, timeScale: 1 / 1.1 });
    expect(finalHearingPlan(0.8)).toEqual({ audioTempo: 1.25, timeScale: 1.25 });
  });

  it('leaves a natural-speed final alone', () => {
    expect(finalHearingPlan(1)).toEqual({ timeScale: 1 });
  });
});

describe('parseSnapshot', () => {
  it('distinguishes no snapshot from an unreadable one', () => {
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot('{ not json')?.ok).toBe(false);
    expect(parseSnapshot(JSON.stringify({ version: 2, corrections: 'old shape' }))?.ok).toBe(false);
  });
});
