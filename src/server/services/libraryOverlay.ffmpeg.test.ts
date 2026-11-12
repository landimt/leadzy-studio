import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkFfmpeg, runFfmpeg } from './ffmpeg.js';
import { bakedOverlayFilename, libraryAssetDir, renderLibraryOverlay } from './libraryOverlay.js';

const TEMPLATE = '<p>{{HEADLINE}}</p>';
const ffmpeg = await checkFfmpeg();

/**
 * Companion generation against the real (bundled) ffmpeg — the unit tier in
 * libraryOverlay.test.ts stops before any binary runs, so the self-heal path
 * and the seek ladder would otherwise ship untested.
 */
describe.skipIf(!ffmpeg.ok)('renderLibraryOverlay — companions (real ffmpeg)', () => {
  const itemId = 'cta-verde-a1b2';
  const variables = { HEADLINE: 'Compre agora' };
  let projectDir: string;

  async function synthAlphaWebm(
    path: string,
    durationS: number,
    options: { readonly alphaFadeInS?: number } = {},
  ): Promise<void> {
    const fade =
      options.alphaFadeInS !== undefined
        ? `,fade=in:st=0:d=${String(options.alphaFadeInS)}:alpha=1`
        : '';
    const result = await runFfmpeg(
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=red:s=64x64:d=${String(durationS)}:r=10,format=yuva420p${fade}`,
        '-c:v',
        'libvpx-vp9',
        '-pix_fmt',
        'yuva420p',
        path,
      ],
      { cwd: projectDir },
    );
    expect(result.ok).toBe(true);
  }

  async function seedBake(
    durationS: number,
    options: { readonly alphaFadeInS?: number } = {},
  ): Promise<string> {
    await mkdir(join(projectDir, libraryAssetDir(itemId)), { recursive: true });
    await writeFile(join(projectDir, libraryAssetDir(itemId), 'template.html'), TEMPLATE);
    const assetRel = `${libraryAssetDir(itemId)}/${bakedOverlayFilename({ itemId, variables }, TEMPLATE)}`;
    await synthAlphaWebm(join(projectDir, assetRel), durationS, options);
    return assetRel;
  }

  /** Mean alpha of the PNG, 0–255, via alphaextract into a 1×1 gray raw byte. */
  async function pngMeanAlpha(pngRel: string): Promise<number> {
    const out = join(projectDir, 'alpha.bin');
    const result = await runFfmpeg(
      [
        '-y',
        '-i',
        pngRel,
        '-vf',
        'alphaextract,scale=1:1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'gray',
        out,
      ],
      { cwd: projectDir },
    );
    expect(result.ok).toBe(true);
    return (await readFile(out))[0] ?? 0;
  }

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'leadzy-bake-ffmpeg-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it(
    'heals missing companions without re-rendering the existing webm',
    { timeout: 30_000 },
    async () => {
      const assetRel = await seedBake(2);
      const before = await readFile(join(projectDir, assetRel));

      const result = await renderLibraryOverlay(projectDir, { itemId, variables });
      expect(result).toEqual({ ok: true, value: assetRel });

      expect(await readFile(join(projectDir, assetRel))).toEqual(before);
      expect((await stat(join(projectDir, `${assetRel}.png`))).size).toBeGreaterThan(0);
      expect((await stat(join(projectDir, `${assetRel}.webp`))).size).toBeGreaterThan(0);
    },
  );

  // Seeking past EOF makes ffmpeg exit 0 and write nothing, so a piece
  // shorter than the 1.5s convention must fall down the seek ladder. The clip
  // fades in over 0.3s so its frame 0 is FULLY TRANSPARENT: the visibility
  // assert fails if the duration/2 rung ever degrades to frame 0 — a blank
  // but non-empty PNG would pass a size check.
  it(
    'writes a VISIBLE frame for a piece shorter than the settled-frame seek',
    { timeout: 30_000 },
    async () => {
      const assetRel = await seedBake(1, { alphaFadeInS: 0.3 });

      const result = await renderLibraryOverlay(projectDir, { itemId, variables });
      expect(result).toEqual({ ok: true, value: assetRel });
      expect(await pngMeanAlpha(`${assetRel}.png`)).toBeGreaterThan(200);
    },
  );
});
