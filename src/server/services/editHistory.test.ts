import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EditDoc } from '../../core/schema.js';
import { EditHistory } from './editHistory.js';
import { editDocHash } from './project.js';

let dir: string;
let clockMs: number;

const clock = (): number => clockMs;

function makeDoc(totalDurationS: number): EditDoc {
  return {
    version: 2,
    fps: 25,
    output: { width: 1080, height: 1920, loudnormLufs: -14 },
    sources: { cam: { path: 'camera.mp4' } },
    tracks: [
      {
        id: 'base',
        kind: 'video',
        blocks: [
          { source: 'cam', in: 1, out: 5 },
          { source: 'cam', in: 10, out: 14 },
        ],
      },
    ],
    subtitles: { enabled: false, preset: '2p-caps' },
    totalDurationS,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'leadzy-history-'));
  clockMs = Date.parse('2026-01-01T00:00:00.000Z');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('EditHistory', () => {
  it('records a snapshot and lists it with the correct metadata', async () => {
    const history = new EditHistory(dir, clock);
    const doc = makeDoc(8);
    await history.record(doc, 'ui');

    const entries = await history.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      origin: 'ui',
      hash: editDocHash(doc),
      totalDurationS: 8,
      blocks: 2,
    });
    expect(entries[0]!.id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-ui$/);
    expect(entries[0]!.ts).toBe(new Date(clockMs).toISOString());
  });

  it('dedupes a repeated hash regardless of origin', async () => {
    const history = new EditHistory(dir, clock);
    const doc = makeDoc(8);
    await history.record(doc, 'ui');
    await history.record(doc, 'ui');
    await history.record(doc, 'agent');

    expect(await history.list()).toHaveLength(1);
  });

  it('canonicalizes through the schema before hashing, so key order never defeats the dedupe check', async () => {
    const history = new EditHistory(dir, clock);
    const original = makeDoc(8);
    await history.record(original, 'ui');

    // Same content, keys inserted in the opposite order — JSON.stringify is
    // order-sensitive, so this is a stand-in for a spread that appends a
    // previously-absent optional field out of schema order.
    const reordered: EditDoc = {
      totalDurationS: original.totalDurationS,
      subtitles: original.subtitles,
      tracks: original.tracks,
      sources: original.sources,
      output: original.output,
      fps: original.fps,
      version: original.version,
    };
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(original));

    clockMs += 1_000;
    await history.record(reordered, 'agent');

    expect(await history.list()).toHaveLength(1);
  });

  it('coalesces same-origin ui writes under 60s, splits at 60s, and never coalesces other origins', async () => {
    const history = new EditHistory(dir, clock);

    await history.record(makeDoc(8), 'ui');
    clockMs += 30_000;
    await history.record(makeDoc(9), 'ui');

    let entries = await history.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.totalDurationS).toBe(9);

    clockMs += 30_000; // exactly 60s since the group's original snapshot
    await history.record(makeDoc(10), 'ui');

    entries = await history.list();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.totalDurationS).toBe(10);
    expect(entries[1]!.totalDurationS).toBe(9);

    clockMs += 1_000;
    await history.record(makeDoc(11), 'agent');
    clockMs += 1_000;
    await history.record(makeDoc(12), 'agent');

    entries = await history.list();
    expect(entries).toHaveLength(4);
  });

  it('prunes to the 100 newest snapshots', async () => {
    const history = new EditHistory(dir, clock);
    for (let i = 0; i < 102; i++) {
      await history.record(makeDoc(i), 'agent');
      clockMs += 1_000;
    }

    const entries = await history.list();
    expect(entries).toHaveLength(100);
    expect(entries[0]!.totalDurationS).toBe(101);
    expect(entries.at(-1)!.totalDurationS).toBe(2);
  });

  it('rejects a malicious history id instead of escaping edit/history', async () => {
    const history = new EditHistory(dir, clock);
    await history.record(makeDoc(8), 'ui');

    const traversal = await history.read('../../etc/passwd');
    expect(traversal.ok).toBe(false);

    const withSlash = await history.read('2026-01-01T00-00-00-000Z-ui/../../etc/passwd');
    expect(withSlash.ok).toBe(false);
  });

  it('serializes concurrent record() calls instead of racing on the same filename', async () => {
    const history = new EditHistory(dir, clock);
    await Promise.all([history.record(makeDoc(20), 'agent'), history.record(makeDoc(21), 'agent')]);

    const entries = await history.list();
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.totalDurationS).sort()).toEqual([20, 21]);
  });

  it('skips a corrupted snapshot file in list() without throwing', async () => {
    const history = new EditHistory(dir, clock);
    await history.record(makeDoc(8), 'ui');

    const historyDir = join(dir, 'edit', 'history');
    await writeFile(join(historyDir, '2026-01-01T00-01-00-000Z-agent.json'), '{not valid json');

    const entries = await history.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.totalDurationS).toBe(8);
  });
});
