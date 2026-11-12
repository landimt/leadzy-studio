import { access, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EditDoc } from '../../core/schema.js';
import {
  acquireResolvedProjectMedia,
  probeResolvedProjectMedia,
  sweepStaleResolvedMediaLeases,
} from './resolvedMedia.js';

const roots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function documentFor(path: string): EditDoc {
  return {
    version: 2,
    fps: 25,
    output: { width: 1080, height: 1920, loudnormLufs: null },
    sources: { camera: { path } },
    tracks: [
      {
        id: 'base',
        kind: 'video',
        blocks: [{ source: 'camera', in: 0, out: 1 }],
      },
    ],
    subtitles: { enabled: false, preset: 'pill' },
  };
}

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function imageCanvasDocument(file: string): EditDoc {
  return {
    version: 2,
    fps: 25,
    output: { width: 1080, height: 1920, loudnormLufs: null },
    sources: {},
    tracks: [{ id: 'base', kind: 'video', blocks: [] }],
    subtitles: { enabled: false, preset: 'pill' },
    canvas: {
      background: { kind: 'image', file, fit: 'cover' },
      base: { mode: 'fill' },
    },
  };
}

describe('acquireResolvedProjectMedia', () => {
  it('pins the inode when both the authoring symlink and terminal path are replaced', async () => {
    const root = await temporaryRoot('leadzy-resolved-media-');
    const outside = await temporaryRoot('leadzy-outside-media-');
    await mkdir(join(root, 'media'));
    const first = join(root, 'media', 'first.mp4');
    await writeFile(first, 'first internal bytes');
    await writeFile(join(root, 'media', 'second.mp4'), 'second internal bytes');
    await writeFile(join(outside, 'secret.mp4'), 'outside secret bytes');
    await symlink('media/first.mp4', join(root, 'camera.mp4'));

    const leased = await acquireResolvedProjectMedia(root, documentFor('camera.mp4'));
    expect(leased.ok).toBe(true);
    if (!leased.ok) return;
    const pinned = leased.value.doc.sources.camera?.path ?? '';

    await unlink(join(root, 'camera.mp4'));
    await symlink('media/second.mp4', join(root, 'camera.mp4'));
    await unlink(first);
    await symlink(join(outside, 'secret.mp4'), first);

    expect(await readFile(pinned, 'utf8')).toBe('first internal bytes');
    await leased.value.release();
    await leased.value.release();
    await expect(access(pinned)).rejects.toBeDefined();
  });

  it('rejects a symlink whose real target is outside the project', async () => {
    const root = await temporaryRoot('leadzy-resolved-media-');
    const outside = await temporaryRoot('leadzy-outside-media-');
    await writeFile(join(outside, 'secret.mp4'), 'secret');
    await symlink(join(outside, 'secret.mp4'), join(root, 'camera.mp4'));

    const leased = await acquireResolvedProjectMedia(root, documentFor('camera.mp4'));
    expect(leased.ok).toBe(false);
    if (leased.ok) return;
    expect(leased.error.code).toBe('path-outside-project');
  });

  it.each(['EXDEV', 'EPERM'])('copies safely when hardlinks fail with %s', async (code) => {
    const root = await temporaryRoot('leadzy-resolved-media-');
    await writeFile(join(root, 'camera.mp4'), 'portable source bytes');

    const leased = await acquireResolvedProjectMedia(root, documentFor('camera.mp4'), {
      linkFile: () => {
        const failure = new Error('hardlinks unavailable') as NodeJS.ErrnoException;
        failure.code = code;
        return Promise.reject(failure);
      },
    });

    expect(leased.ok).toBe(true);
    if (!leased.ok) return;
    const pinned = leased.value.doc.sources.camera?.path ?? '';
    await unlink(join(root, 'camera.mp4'));
    await writeFile(join(root, 'camera.mp4'), 'replacement bytes');
    expect(await readFile(pinned, 'utf8')).toBe('portable source bytes');
    expect(leased.value.authoringMediaHashes.get('camera.mp4')).toMatch(/^[0-9a-f]{40}$/);
    await leased.value.release();
  });

  it('rejects an outside symlink raced in before the portable copy opens', async () => {
    const root = await temporaryRoot('leadzy-resolved-media-');
    const outside = await temporaryRoot('leadzy-outside-media-');
    const source = join(root, 'camera.mp4');
    await writeFile(source, 'internal bytes');
    await writeFile(join(outside, 'secret.mp4'), 'outside secret bytes');

    const leased = await acquireResolvedProjectMedia(root, documentFor('camera.mp4'), {
      linkFile: () => {
        const failure = new Error('hardlinks unavailable') as NodeJS.ErrnoException;
        failure.code = 'EPERM';
        return Promise.reject(failure);
      },
      beforeCopyOpen: async () => {
        await unlink(source);
        await symlink(join(outside, 'secret.mp4'), source);
      },
    });

    expect(leased.ok).toBe(false);
    if (leased.ok) return;
    expect(leased.error.code).toBe('io-failed');
  });

  it('pins a canvas background image in the same immutable lease as source media', async () => {
    const root = await temporaryRoot('leadzy-resolved-media-');
    await mkdir(join(root, 'edit', 'assets'), { recursive: true });
    await writeFile(join(root, 'camera.mp4'), 'camera bytes');
    const backgroundPath = join(root, 'edit', 'assets', 'background.png');
    await writeFile(backgroundPath, 'background bytes');
    const doc: EditDoc = {
      ...documentFor('camera.mp4'),
      canvas: {
        background: { kind: 'image', file: 'edit/assets/background.png', fit: 'cover' },
        base: { mode: 'cell', cell: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } },
      },
    };

    const leased = await acquireResolvedProjectMedia(root, doc);
    expect(leased.ok).toBe(true);
    if (!leased.ok) return;
    const pinned =
      leased.value.doc.canvas?.background.kind === 'image'
        ? leased.value.doc.canvas.background.file
        : '';
    expect(pinned).not.toBe('edit/assets/background.png');
    expect(leased.value.authoringMediaHashes.get('edit/assets/background.png')).toMatch(
      /^[0-9a-f]{40}$/,
    );

    await unlink(backgroundPath);
    expect(await readFile(pinned, 'utf8')).toBe('background bytes');
    await leased.value.release();
    await expect(access(pinned)).rejects.toBeDefined();
  });

  it('fails before rendering when a canvas background image is missing', async () => {
    const root = await temporaryRoot('leadzy-resolved-media-');
    await writeFile(join(root, 'camera.mp4'), 'camera bytes');
    const doc: EditDoc = {
      ...documentFor('camera.mp4'),
      canvas: {
        background: { kind: 'image', file: 'edit/assets/missing.png', fit: 'contain' },
        base: { mode: 'fill' },
      },
    };

    const leased = await acquireResolvedProjectMedia(root, doc);
    expect(leased.ok).toBe(false);
    if (leased.ok) return;
    expect(leased.error.code).toBe('io-failed');
    expect(leased.error.message).toContain('edit/assets/missing.png');
  });

  it('retries a transient cleanup failure without rejecting the caller', async () => {
    const root = await temporaryRoot('leadzy-resolved-media-');
    await writeFile(join(root, 'camera.mp4'), 'media');
    let removalAttempts = 0;
    const leased = await acquireResolvedProjectMedia(root, documentFor('camera.mp4'), {
      cleanupRetryMs: 60_000,
      removeDir: async (path, options) => {
        removalAttempts += 1;
        if (removalAttempts === 1) throw new Error('transient EBUSY');
        await rm(path, options);
      },
    });
    expect(leased.ok).toBe(true);
    if (!leased.ok) return;
    const pinned = leased.value.doc.sources.camera?.path ?? '';

    await expect(leased.value.release()).resolves.toBeUndefined();
    await expect(access(pinned)).resolves.toBeUndefined();
    await expect(leased.value.release()).resolves.toBeUndefined();
    await expect(access(pinned)).rejects.toBeDefined();
    expect(removalAttempts).toBe(2);
  });

  it('sweeps dead leases after the grace period and preserves live owners', async () => {
    const root = await temporaryRoot('leadzy-resolved-media-');
    const leaseRoot = join(root, 'edit', 'cache', 'input-leases');
    const deadToken = '11111111-1111-4111-8111-111111111111';
    const liveToken = '22222222-2222-4222-8222-222222222222';
    const dead = join(leaseRoot, `404404-${deadToken}`);
    const live = join(leaseRoot, `505505-${liveToken}`);
    await mkdir(dead, { recursive: true });
    await mkdir(live);
    await writeFile(
      join(dead, 'owner.json'),
      JSON.stringify({
        pid: 404404,
        token: deadToken,
        processToken: 'dead-process',
        acquiredAt: Date.now(),
      }),
    );
    await writeFile(
      join(live, 'owner.json'),
      JSON.stringify({
        pid: 505505,
        token: liveToken,
        processToken: 'live-process',
        acquiredAt: Date.now(),
      }),
    );
    await writeFile(join(dead, 'camera.mp4'), 'orphan');
    await writeFile(join(live, 'camera.mp4'), 'active');

    const removed = await sweepStaleResolvedMediaLeases(root, {
      staleAfterMs: 0,
      processAlive: (pid) => pid === 505505,
    });

    expect(removed).toBe(1);
    await expect(access(dead)).rejects.toBeDefined();
    await expect(access(live)).resolves.toBeUndefined();
  });

  it('reclaims a lease only when the live PID registry identifies a newer process', async () => {
    const root = await temporaryRoot('leadzy-resolved-media-');
    const leaseRoot = join(root, 'edit', 'cache', 'input-leases');
    const token = '33333333-3333-4333-8333-333333333333';
    const reused = join(leaseRoot, `606606-${token}`);
    await mkdir(reused, { recursive: true });
    await writeFile(
      join(reused, 'owner.json'),
      JSON.stringify({
        pid: 606606,
        token,
        processToken: 'previous-process-instance',
        acquiredAt: 1,
      }),
    );
    await mkdir(join(leaseRoot, '.processes'));
    await writeFile(
      join(leaseRoot, '.processes', '606606.json'),
      JSON.stringify({
        pid: 606606,
        processToken: 'new-process-instance',
        registeredAt: Date.now(),
      }),
    );

    const removed = await sweepStaleResolvedMediaLeases(root, {
      processAlive: () => true,
    });

    expect(removed).toBe(1);
    await expect(access(reused)).rejects.toBeDefined();
  });

  it('never removes an old lease while its PID and process token still match', async () => {
    const root = await temporaryRoot('leadzy-resolved-media-');
    const leaseRoot = join(root, 'edit', 'cache', 'input-leases');
    const token = '44444444-4444-4444-8444-444444444444';
    const live = join(leaseRoot, `707707-${token}`);
    await mkdir(live, { recursive: true });
    await writeFile(
      join(live, 'owner.json'),
      JSON.stringify({
        pid: 707707,
        token,
        processToken: 'same-process-instance',
        acquiredAt: 1,
      }),
    );
    await mkdir(join(leaseRoot, '.processes'));
    await writeFile(
      join(leaseRoot, '.processes', '707707.json'),
      JSON.stringify({
        pid: 707707,
        processToken: 'same-process-instance',
        registeredAt: 1,
      }),
    );

    const removed = await sweepStaleResolvedMediaLeases(root, {
      now: () => Number.MAX_SAFE_INTEGER,
      staleAfterMs: 0,
      processAlive: () => true,
    });

    expect(removed).toBe(0);
    await expect(access(live)).resolves.toBeUndefined();
  });

  it('registers one process instance for concurrent render and audio leases', async () => {
    const root = await temporaryRoot('leadzy-resolved-media-');
    await writeFile(join(root, 'camera.mp4'), 'shared media');

    const leases = await Promise.all(
      Array.from({ length: 20 }, () =>
        acquireResolvedProjectMedia(root, documentFor('camera.mp4')),
      ),
    );

    expect(leases.every((lease) => lease.ok)).toBe(true);
    await Promise.all(
      leases.map((lease) => (lease.ok ? lease.value.release() : Promise.resolve())),
    );
  });
});

describe('probeResolvedProjectMedia', () => {
  it('validates the pinned canvas background after the authoring image is removed', async () => {
    const root = await temporaryRoot('leadzy-resolved-media-probe-');
    await mkdir(join(root, 'edit', 'assets'), { recursive: true });
    const authoringPath = join(root, 'edit', 'assets', 'background.png');
    await writeFile(authoringPath, ONE_PIXEL_PNG);

    const leased = await acquireResolvedProjectMedia(
      root,
      imageCanvasDocument('edit/assets/background.png'),
    );
    expect(leased.ok).toBe(true);
    if (!leased.ok) return;
    try {
      const pinned =
        leased.value.doc.canvas?.background.kind === 'image'
          ? leased.value.doc.canvas.background.file
          : '';
      await unlink(authoringPath);

      const probed = await probeResolvedProjectMedia(leased.value.doc);
      expect(probed.ok).toBe(true);
      if (!probed.ok) return;
      expect(probed.value.size).toBe(0);
      expect(pinned).not.toBe(authoringPath);
    } finally {
      await leased.value.release();
    }
  });

  it('rejects invalid image bytes from a pinned canvas background before rendering', async () => {
    const root = await temporaryRoot('leadzy-resolved-media-probe-');
    await mkdir(join(root, 'edit', 'assets'), { recursive: true });
    const authoringPath = join(root, 'edit', 'assets', 'background.png');
    await writeFile(authoringPath, 'not a png');

    const leased = await acquireResolvedProjectMedia(
      root,
      imageCanvasDocument('edit/assets/background.png'),
    );
    expect(leased.ok).toBe(true);
    if (!leased.ok) return;
    try {
      await unlink(authoringPath);
      const probed = await probeResolvedProjectMedia(leased.value.doc);
      expect(probed.ok).toBe(false);
      if (probed.ok) return;
      expect(probed.error.code).toBe('ffmpeg-failed');
      expect(probed.error.message).toContain('safe still image');
    } finally {
      await leased.value.release();
    }
  });
});
