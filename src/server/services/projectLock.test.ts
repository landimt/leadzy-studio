import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EditDoc } from '../../core/schema.js';
import { renderProject } from './render.js';
import { acquireProjectLock, ProjectLockBusyError } from './projectLock.js';

const roots: string[] = [];

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'leadzy-lock-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('project locks', () => {
  it('is exclusive across callers and becomes available after release', async () => {
    const root = await projectRoot();
    const first = await acquireProjectLock(root, 'edit-write');
    await expect(acquireProjectLock(root, 'edit-write')).rejects.toBeInstanceOf(
      ProjectLockBusyError,
    );
    await first.release();
    const second = await acquireProjectLock(root, 'edit-write');
    await second.release();
  });

  it('lets only one caller recover a stale lock', async () => {
    const root = await projectRoot();
    const lockDir = join(root, 'edit', '.locks');
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, 'edit-write.lock'),
      JSON.stringify({ pid: 999_999, token: 'dead-owner', acquiredAt: 0 }),
    );
    const options = {
      staleAfterMs: 0,
      processAlive: (pid: number): boolean => pid === process.pid,
    };
    const attempts = await Promise.allSettled([
      acquireProjectLock(root, 'edit-write', options),
      acquireProjectLock(root, 'edit-write', options),
    ]);
    const winners = attempts.filter(
      (
        attempt,
      ): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireProjectLock>>> =>
        attempt.status === 'fulfilled',
    );
    expect(winners).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    await winners[0]?.value.release();
  });

  it('recovers the canonical reclaim marker left by a crashed owner', async () => {
    const root = await projectRoot();
    const lockDir = join(root, 'edit', '.locks');
    const lockPath = join(lockDir, 'edit-write.lock');
    const reclaimPath = `${lockPath}.reclaim`;
    await mkdir(reclaimPath, { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999_997, token: 'dead-lock-owner', acquiredAt: 0 }),
    );
    await writeFile(
      join(reclaimPath, 'owner.json'),
      JSON.stringify({ pid: 999_998, token: 'dead-reclaimer', acquiredAt: 0 }),
    );

    const recovered = await acquireProjectLock(root, 'edit-write', {
      staleAfterMs: 0,
      processAlive: (pid) => pid === process.pid,
    });
    await recovered.release();
  });

  it('recovers an abandoned reclaim takeover without allowing two owners', async () => {
    const root = await projectRoot();
    const lockDir = join(root, 'edit', '.locks');
    const lockPath = join(lockDir, 'edit-write.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999_998, token: 'dead-lock-owner', acquiredAt: 0 }),
    );
    // A previous reclaimer crashed after atomically taking over the recovery
    // marker. Its PID/timestamp live in the unique pathname by design.
    await mkdir(`${lockPath}.reclaim.999999.0.abandoned-reclaimer`);

    const options = {
      staleAfterMs: 0,
      processAlive: (pid: number): boolean => pid === process.pid,
    };
    const attempts = await Promise.allSettled([
      acquireProjectLock(root, 'edit-write', options),
      acquireProjectLock(root, 'edit-write', options),
    ]);
    const winners = attempts.filter(
      (
        attempt,
      ): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireProjectLock>>> =>
        attempt.status === 'fulfilled',
    );

    expect(winners).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    await expect(acquireProjectLock(root, 'edit-write', options)).rejects.toBeInstanceOf(
      ProjectLockBusyError,
    );

    await winners[0]?.value.release();
    const afterRelease = await acquireProjectLock(root, 'edit-write', options);
    await afterRelease.release();
  });

  it('makes renderProject reject a concurrent CLI/UI render before probing media', async () => {
    const root = await projectRoot();
    const held = await acquireProjectLock(root, 'render');
    const doc: EditDoc = {
      version: 2,
      fps: 25,
      output: { width: 1080, height: 1920, loudnormLufs: -14 },
      sources: { cam: { path: 'missing.mp4' } },
      tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 1 }] }],
      subtitles: { enabled: false, preset: 'pill' },
      totalDurationS: 1,
    };
    const rendered = await renderProject(root, doc, {
      preview: true,
      subtitles: true,
      loudnorm: true,
    });
    expect(rendered.ok).toBe(false);
    if (!rendered.ok) expect(rendered.error.message).toContain('render');
    await held.release();
  });

  it('preserves the last valid receipt when replacement media cannot be reserved', async () => {
    const root = await projectRoot();
    const receipt = join(root, 'edit', 'cache', 'preview.edit.json');
    await mkdir(join(root, 'edit', 'cache'), { recursive: true });
    await writeFile(receipt, '{}');
    const doc: EditDoc = {
      version: 2,
      fps: 25,
      output: { width: 1080, height: 1920, loudnormLufs: -14 },
      sources: { cam: { path: 'missing.mp4' } },
      tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 1 }] }],
      subtitles: { enabled: false, preset: 'pill' },
      totalDurationS: 1,
    };

    const rendered = await renderProject(root, doc, {
      preview: true,
      subtitles: true,
      loudnorm: true,
    });
    expect(rendered.ok).toBe(false);
    await expect(access(receipt)).resolves.toBeUndefined();
  });
});
