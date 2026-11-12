import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { editDocHash, loadEditDoc } from '../server/services/project.js';
import { applyEditDocument } from './applyEditDocument.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(locked = false): Promise<{ root: string; doc: Record<string, unknown> }> {
  const root = await mkdtemp(join(tmpdir(), 'leadzy-agent-edit-'));
  roots.push(root);
  await mkdir(join(root, 'edit'), { recursive: true });
  await writeFile(join(root, 'camera.mp4'), 'media');
  const doc = {
    version: 2,
    fps: 25,
    output: { width: 1080, height: 1920, loudnormLufs: -14 },
    sources: { cam: { path: 'camera.mp4', durationS: 4 } },
    tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 4 }] }],
    subtitles: { enabled: true, preset: 'pill', ...(locked ? { locked: true } : {}) },
    totalDurationS: 4,
  };
  await writeFile(join(root, 'edit', 'edit.json'), JSON.stringify(doc));
  return { root, doc };
}

describe('agent-safe edit transaction', () => {
  it('recomputes duration, writes atomically and records recoverable snapshots', async () => {
    const { root, doc } = await fixture();
    const loaded = await loadEditDoc(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const next = {
      ...doc,
      tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 1, out: 3 }] }],
      totalDurationS: 999,
    };
    const result = await applyEditDocument(root, next, {
      expectHash: editDocHash(loaded.value.doc),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalDurationS).toBe(2);
    const persisted = JSON.parse(await readFile(join(root, 'edit', 'edit.json'), 'utf8')) as {
      totalDurationS: number;
    };
    expect(persisted.totalDurationS).toBe(2);
    const history = await import('../server/services/editHistory.js').then(({ EditHistory }) =>
      new EditHistory(root).list(),
    );
    expect(history).toHaveLength(2);
  });

  it('refuses a stale expected hash without changing edit.json', async () => {
    const { root, doc } = await fixture();
    const before = await readFile(join(root, 'edit', 'edit.json'), 'utf8');
    const result = await applyEditDocument(root, doc, { expectHash: '0'.repeat(40) });
    expect(result.ok).toBe(false);
    expect(await readFile(join(root, 'edit', 'edit.json'), 'utf8')).toBe(before);
  });

  it('enforces subtitles.locked for agent mutations', async () => {
    const { root, doc } = await fixture(true);
    const loaded = await loadEditDoc(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const result = await applyEditDocument(
      root,
      { ...doc, subtitles: { enabled: false, preset: 'pill', locked: true } },
      { expectHash: editDocHash(loaded.value.doc) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('subtitles.locked=true');
  });

  it('lets only one writer commit when two agents start from the same hash', async () => {
    const { root, doc } = await fixture();
    const loaded = await loadEditDoc(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const expectHash = editDocHash(loaded.value.doc);
    const docA = {
      ...doc,
      tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 2 }] }],
    };
    const docB = {
      ...doc,
      tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 3 }] }],
    };

    const results = await Promise.all([
      applyEditDocument(root, docA, { expectHash }),
      applyEditDocument(root, docB, { expectHash }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    const persisted = JSON.parse(await readFile(join(root, 'edit', 'edit.json'), 'utf8')) as {
      totalDurationS: number;
    };
    const winner = results.find((result) => result.ok);
    expect(winner?.ok && winner.value.totalDurationS).toBe(persisted.totalDurationS);
  });
});
