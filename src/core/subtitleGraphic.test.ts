import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  renderSubtitleGraphicSvg,
  subtitleGraphicFontFamily,
  subtitleGraphicFontWeight,
  subtitleRuns,
} from './subtitleGraphic.js';

const require = createRequire(import.meta.url);

async function font(
  weight: 700 | 800,
): Promise<{ data: ArrayBuffer; family: 'Inter'; weight: 700 | 800 }> {
  const file = require.resolve(`@fontsource/inter/files/inter-latin-${String(weight)}-normal.woff`);
  const data = await readFile(file);
  return {
    data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    family: 'Inter',
    weight,
  };
}

describe('subtitle graphic', () => {
  it('parses painted runs without exposing SRT markup', () => {
    expect(subtitleRuns('voc&ecirc; <font color="#C9A86A">sabia</font> disso?', '#FBF9F4')).toEqual(
      [
        { text: 'voc&ecirc; ', color: '#FBF9F4' },
        { text: 'sabia', color: '#C9A86A' },
        { text: ' disso?', color: '#FBF9F4' },
      ],
    );
  });

  it('uses the closest bundled font weight deterministically', () => {
    expect(subtitleGraphicFontWeight(400)).toBe(400);
    expect(subtitleGraphicFontWeight(650)).toBe(600);
    expect(subtitleGraphicFontWeight(675)).toBe(700);
    expect(subtitleGraphicFontWeight(900)).toBe(900);
  });

  it('maps Arial-like presets to their bundled open metric counterpart', () => {
    expect(subtitleGraphicFontFamily('Arial')).toBe('Arimo');
    expect(subtitleGraphicFontFamily('Helvetica')).toBe('Arimo');
    expect(subtitleGraphicFontFamily('Inter')).toBe('Inter');
  });

  it('renders a rounded, path-based SVG with the authored colors', async () => {
    const svg = await renderSubtitleGraphicSvg({
      cue: { text: 'você <font color="#C9A86A">sabia</font> disso?' },
      dimensions: { width: 1080, height: 1920 },
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
      fonts: await Promise.all([font(700), font(800)]),
    });

    expect(svg).toContain('<svg');
    expect(svg).toContain('rgba(27,27,26,0.85)');
    expect(svg).toContain('#C9A86A');
    expect(svg).not.toContain('<text');
    expect(svg).not.toContain('<font');
    expect(svg).toContain('<path');
    expect(svg).toContain('width="1080" height="1920"');
  });

  it('balances a wide caption into separately rounded lines using real font metrics', async () => {
    const fonts = await Promise.all([font(700), font(800)]);
    const svg = await renderSubtitleGraphicSvg({
      cue: { text: '<font color="#C9A86A">estudante</font> internacional,' },
      dimensions: { width: 1080, height: 1920 },
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
      fonts,
    });

    expect(svg.match(/fill="rgba\(27,27,26,0\.85\)"/gu)).toHaveLength(2);
  });
});
