import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RenderStep } from '../../core/render/steps.js';
import {
  pruneSubtitleGraphicsCache,
  renderSubtitleGraphics,
  subtitleGraphicsInternals,
} from './subtitleGraphics.js';

let projectDir = '';

function step(): Extract<RenderStep, { kind: 'subtitle-graphics' }> {
  return {
    kind: 'subtitle-graphics',
    label: 'render subtitle graphics',
    manifestPath: 'edit/cache/subtitles/vector-test/overlay.ffconcat',
    cues: [
      {
        start: 0.5,
        end: 1.25,
        text: 'você <font color="#C9A86A">sabia</font> disso?',
        source: 'take',
        wordStart: 0,
        wordEnd: 2,
      },
    ],
    width: 360,
    height: 640,
    fps: 25,
    durationS: 2,
    settings: {
      minWordsPerCue: 2,
      maxWordsPerCue: 3,
      fontSize: 15,
      marginV: 64,
      maxTailS: 0.4,
    },
    theme: {
      fontFamily: 'Inter',
      fontWeight: 800,
      fill: { kind: 'solid', color: '#FBF9F4' },
      highlightFill: { kind: 'solid', color: '#C9A86A' },
      backgroundStyle: 'pill',
      backgroundColor: '#1B1B1A',
      backgroundOpacity: 0.85,
      outlineColor: '#000000',
      outlineWidth: 1.5,
    },
  };
}

afterEach(async () => {
  if (projectDir !== '') await rm(projectDir, { recursive: true, force: true });
  projectDir = '';
});

describe('subtitle graphics', () => {
  it('builds blank gaps around cues in one deterministic concat stream', () => {
    const entries = subtitleGraphicsInternals.frameEntries(step());
    expect(entries.map((entry) => entry.durationS)).toEqual([0.5, 0.75, 0.75]);
    expect(entries[0]?.filename).toBe('blank.png');
    expect(entries[1]?.filename).toMatch(/^cue-[a-f0-9]{20}\.png$/u);
    expect(entries[2]?.filename).toBe('blank.png');
    const manifest = subtitleGraphicsInternals.manifestFor(entries);
    expect(manifest).toContain('ffconcat version 1.0');
    expect(manifest.match(/file 'blank\.png'/gu)).toHaveLength(3);
  });

  it('rasterizes the shared SVG and publishes its manifest last', async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'leadzy-subtitle-graphics-'));
    const input = step();
    const result = await renderSubtitleGraphics(projectDir, input);
    expect(result.ok).toBe(true);

    const manifestPath = join(projectDir, input.manifestPath);
    const manifest = await readFile(manifestPath, 'utf8');
    const cueName = /file '(cue-[a-f0-9]{20}\.png)'/u.exec(manifest)?.[1];
    expect(cueName).toBeDefined();
    if (cueName === undefined) return;
    const png = await readFile(join(projectDir, 'edit/cache/subtitles/vector-test', cueName));
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect((await stat(manifestPath)).size).toBeGreaterThan(0);

    // A complete immutable set is a cache hit and remains byte-for-byte stable.
    const before = png;
    expect((await renderSubtitleGraphics(projectDir, input)).ok).toBe(true);
    const after = await readFile(join(projectDir, 'edit/cache/subtitles/vector-test', cueName));
    expect(after).toEqual(before);
  });

  it('bounds obsolete content-addressed caption sets while retaining the active one', async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'leadzy-subtitle-cache-'));
    const root = join(projectDir, 'edit/cache/subtitles');
    const active = 'vector-aaaaaaaaaaaaaaaaaaaaaaaa';
    for (const name of [
      active,
      'vector-bbbbbbbbbbbbbbbbbbbbbbbb',
      'vector-cccccccccccccccccccccccc',
      'vector-dddddddddddddddddddddddd',
      'vector-eeeeeeeeeeeeeeeeeeeeeeee',
      'vector-ffffffffffffffffffffffff',
    ]) {
      await mkdir(join(root, name), { recursive: true });
    }

    await pruneSubtitleGraphicsCache(projectDir, `edit/cache/subtitles/${active}/overlay.ffconcat`);
    const remaining = await readdir(root);
    expect(remaining).toContain(active);
    expect(remaining).toHaveLength(4);
  });
});
