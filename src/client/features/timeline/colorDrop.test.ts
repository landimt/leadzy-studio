import { expect, it } from 'vitest';
import type { EditDoc } from '../../../core/schema.js';
import { resolveColorDrop } from './colorDrop.js';
const doc: EditDoc = {
  version: 2,
  fps: 30,
  output: { width: 1080, height: 1920, loudnormLufs: null },
  sources: { cam: { path: 'cam.mp4' } },
  tracks: [
    { id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 2 }] },
    { id: 'art', kind: 'overlay', blocks: [] },
  ],
  subtitles: { enabled: false, preset: 'pill' },
};
it('distinguishes clip drops from layer drops and rejects locked or invalid targets', () => {
  expect(resolveColorDrop(doc, 'base', undefined, new Set())).toEqual({ trackId: 'base' });
  expect(resolveColorDrop(doc, 'base', '0', new Set())).toEqual({ trackId: 'base', blockIndex: 0 });
  for (const index of ['-1', '0.5', 'abc', '2'])
    expect(resolveColorDrop(doc, 'base', index, new Set())).toBeNull();
  expect(resolveColorDrop(doc, 'art', undefined, new Set())).toBeNull();
  expect(resolveColorDrop(doc, 'base', '0', new Set(['base']))).toBeNull();
});
