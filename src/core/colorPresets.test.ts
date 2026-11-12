import { describe, expect, it } from 'vitest';
import { applyColorPreset, COLOR_PRESETS } from './colorPresets.js';
import { type EditDoc, baseTrackOf, parseEditDoc } from './schema.js';
const doc: EditDoc = {
  version: 2,
  fps: 30,
  output: { width: 1080, height: 1920, loudnormLufs: null },
  sources: { cam: { path: 'cam.mp4' } },
  tracks: [
    {
      id: 'base',
      kind: 'video',
      color: { input: 'hlg', contrast: 1.2 },
      blocks: [
        { source: 'cam', in: 0, out: 2 },
        { source: 'cam', in: 2, out: 4, color: { saturation: 0.7 } },
      ],
    },
    { id: 'art', kind: 'overlay', blocks: [{ file: 'edit/assets/logo.png', at: 0, duration: 4 }] },
  ],
  subtitles: { enabled: false, preset: 'pill' },
};
describe('color preset application', () => {
  it('preserves HDR input, subtitles, graphics and clip overrides for every preset', () => {
    for (const preset of COLOR_PRESETS) {
      const next = applyColorPreset(doc, { trackId: 'base' }, preset.id)!;
      expect(parseEditDoc(next).ok).toBe(true);
      expect(baseTrackOf(next).color?.input).toBe('hlg');
      expect(next.tracks[1]).toBe(doc.tracks[1]);
      expect(baseTrackOf(next).blocks).toBe(baseTrackOf(doc).blocks);
      expect(next.subtitles).toBe(doc.subtitles);
    }
  });
  it('only changes the targeted clip and inherits technical conversion', () => {
    const next = applyColorPreset(doc, { trackId: 'base', blockIndex: 0 }, 'warm')!;
    expect(baseTrackOf(next).color).toBe(baseTrackOf(doc).color);
    expect(baseTrackOf(next).blocks[1]).toBe(baseTrackOf(doc).blocks[1]);
    expect(baseTrackOf(next).blocks[0]?.color).toEqual({
      input: 'hlg',
      warmth: 0.3,
      saturation: 0.98,
    });
  });
  it('rejects invalid destinations without altering the document', () => {
    expect(applyColorPreset(doc, { trackId: 'art' }, 'mono')).toBeNull();
    expect(applyColorPreset(doc, { trackId: 'base', blockIndex: 7 }, 'mono')).toBeNull();
  });
});
