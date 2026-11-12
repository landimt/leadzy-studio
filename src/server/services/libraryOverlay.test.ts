import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bakedOverlayFilename, libraryAssetDir, renderLibraryOverlay } from './libraryOverlay.js';

const TEMPLATE = '<p>{{HEADLINE}}</p><span>{{PRICE}}</span>';

describe('bakedOverlayFilename', () => {
  const itemId = 'cta-verde-a1b2';

  it('gives identical inputs the same name so two blocks share one bake', () => {
    const values = { HEADLINE: 'Compre agora', PRICE: 'R$ 99' };
    expect(bakedOverlayFilename({ itemId, variables: values }, TEMPLATE)).toBe(
      bakedOverlayFilename({ itemId, variables: { ...values } }, TEMPLATE),
    );
  });

  it('ignores the order the values were written in', () => {
    expect(
      bakedOverlayFilename({ itemId, variables: { HEADLINE: 'a', PRICE: 'b' } }, TEMPLATE),
    ).toBe(bakedOverlayFilename({ itemId, variables: { PRICE: 'b', HEADLINE: 'a' } }, TEMPLATE));
  });

  it('gives different values different names so one never overwrites the other', () => {
    expect(bakedOverlayFilename({ itemId, variables: { HEADLINE: 'a' } }, TEMPLATE)).not.toBe(
      bakedOverlayFilename({ itemId, variables: { HEADLINE: 'b' } }, TEMPLATE),
    );
  });

  // A re-import replaces the project's template.html in place. Without the
  // template in the digest, a fresh render would land on the filename an older
  // block still points at and silently change that block's picture.
  it('gives the same values under a changed template a different name', () => {
    const variables = { HEADLINE: 'a', PRICE: 'b' };
    expect(bakedOverlayFilename({ itemId, variables }, TEMPLATE)).not.toBe(
      bakedOverlayFilename({ itemId, variables }, `${TEMPLATE}<!-- v2 -->`),
    );
  });

  it('does not confuse a value ending where the next key begins', () => {
    expect(bakedOverlayFilename({ itemId, variables: { A: 'x', B: 'y' } }, TEMPLATE)).not.toBe(
      bakedOverlayFilename({ itemId, variables: { A: 'xB', B: 'y' } }, TEMPLATE),
    );
  });

  it('separates two items that carry the same values', () => {
    expect(bakedOverlayFilename({ itemId, variables: { HEADLINE: 'a' } }, TEMPLATE)).not.toBe(
      bakedOverlayFilename({ itemId: 'cta-azul-c3d4', variables: { HEADLINE: 'a' } }, TEMPLATE),
    );
  });

  it('produces a plain webm filename with no path separators', () => {
    const name = bakedOverlayFilename(
      { itemId, variables: { HEADLINE: '../../etc/passwd' } },
      TEMPLATE,
    );
    expect(name).toMatch(/^bake-[0-9a-f]{12}\.webm$/);
  });
});

describe('libraryAssetDir', () => {
  it('keeps every item in its own project folder', () => {
    expect(libraryAssetDir('cta-verde-a1b2')).toBe('edit/assets/library/cta-verde-a1b2');
  });
});

/**
 * These cases all fail (or short-circuit) BEFORE the HyperFrames CLI would be
 * spawned, so they stay in the unit tier: no network, no headless Chrome.
 */
describe('renderLibraryOverlay — guards', () => {
  const itemId = 'cta-verde-a1b2';
  let projectDir: string;

  async function writeProjectTemplate(template: string): Promise<void> {
    await mkdir(join(projectDir, libraryAssetDir(itemId)), { recursive: true });
    await writeFile(join(projectDir, libraryAssetDir(itemId), 'template.html'), template);
  }

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'leadzy-bake-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('refuses an item id that is not a library id, before touching the filesystem', async () => {
    for (const bad of ['../../etc', 'UPPER', '', 'has/slash']) {
      const result = await renderLibraryOverlay(projectDir, { itemId: bad, variables: {} });
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('not-found');
    }
    expect(await readdir(projectDir)).toEqual([]);
  });

  it('errors when this project holds no template for the item', async () => {
    const result = await renderLibraryOverlay(projectDir, { itemId, variables: { HEADLINE: 'a' } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
      expect(result.error.message).toContain('no template');
    }
  });

  it('errors instead of baking a blank piece when a placeholder has no value', async () => {
    await writeProjectTemplate(TEMPLATE);
    const result = await renderLibraryOverlay(projectDir, { itemId, variables: { HEADLINE: 'a' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('PRICE');
  });

  it('reuses an existing bake with identical inputs instead of rendering again', async () => {
    await writeProjectTemplate(TEMPLATE);
    const variables = { HEADLINE: 'Compre agora', PRICE: 'R$ 99' };
    const expected = `${libraryAssetDir(itemId)}/${bakedOverlayFilename({ itemId, variables }, TEMPLATE)}`;
    await writeFile(join(projectDir, expected), 'previous-bake-bytes');
    await writeFile(join(projectDir, `${expected}.png`), 'previous-png-bytes');
    await writeFile(join(projectDir, `${expected}.webp`), 'previous-webp-bytes');

    const result = await renderLibraryOverlay(projectDir, { itemId, variables });
    expect(result).toEqual({ ok: true, value: expected });
    // A real render would have replaced these with webm/png/webp bytes.
    expect(await readFile(join(projectDir, expected), 'utf8')).toBe('previous-bake-bytes');
    expect(await readFile(join(projectDir, `${expected}.png`), 'utf8')).toBe('previous-png-bytes');
    expect(await readFile(join(projectDir, `${expected}.webp`), 'utf8')).toBe(
      'previous-webp-bytes',
    );
  });

  // Import refuses such a template, but the project copy is a plain file an
  // agent can rewrite after the import.
  it('errors instead of baking a template whose placeholder sits in a script block', async () => {
    await writeProjectTemplate('<script>show("{{HEADLINE}}", "{{PRICE}}")</script>');
    const result = await renderLibraryOverlay(projectDir, {
      itemId,
      variables: { HEADLINE: 'a', PRICE: 'b' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('script/style');
  });
});
