import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OverlayLibrary } from './library.js';

let baseDir: string;
let sourceDir: string;
let library: OverlayLibrary;

async function writeSource(name: string, bytes = 'fake-asset-bytes'): Promise<string> {
  const path = join(sourceDir, name);
  await writeFile(path, bytes);
  return path;
}

/** Writes a manifest an AGENT could have written — the path every new field arrives through. */
async function writeManifest(id: string, manifest: Record<string, unknown>): Promise<void> {
  await mkdir(join(baseDir, id), { recursive: true });
  await writeFile(join(baseDir, id, 'item.json'), JSON.stringify(manifest));
}

function parametricManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cta-verde-a1b2',
    name: 'CTA verde',
    kind: 'cta',
    file: 'cta.webm',
    createdAt: new Date().toISOString(),
    description: 'Use no fim do anúncio, sobre o rosto.',
    template: 'source.html',
    variables: [
      { name: 'HEADLINE', label: 'Chamada', default: 'Compre agora' },
      { name: 'PRICE', default: 'R$ 99' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'leadzy-library-'));
  sourceDir = mkdtempSync(join(tmpdir(), 'leadzy-library-src-'));
  library = new OverlayLibrary(baseDir);
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
  rmSync(sourceDir, { recursive: true, force: true });
});

describe('OverlayLibrary', () => {
  it('saves an item with its alpha-companion png and reports hasPreview', async () => {
    const source = await writeSource('lower-third.webm');
    await writeFile(`${source}.png`, 'fake-png-bytes');

    const item = await library.saveFrom(source, {
      name: 'Rodapé',
      kind: 'lower-third',
      durationS: 3,
    });

    expect(item.name).toBe('Rodapé');
    expect(item.kind).toBe('lower-third');
    expect(item.file).toBe('lower-third.webm');
    expect(item.durationS).toBe(3);
    expect(item.hasPreview).toBe(true);
    expect(item.id).toMatch(/^rodape-[a-z0-9]{4}$/);

    const listed = await library.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: item.id, hasPreview: true });
  });

  describe('remove', () => {
    it('deletes the whole item folder and the list no longer shows it', async () => {
      const source = await writeSource('cta.webm');
      const item = await library.saveFrom(source, { name: 'CTA final', kind: 'cta' });

      await expect(library.remove(item.id)).resolves.toBe(true);

      expect(await library.list()).toHaveLength(0);
      expect(await readdir(baseDir)).toHaveLength(0);
    });

    it('removes a folder with a broken manifest — cleanup must not require validity', async () => {
      await mkdir(join(baseDir, 'meio-escrito-a1b2'), { recursive: true });
      await writeFile(join(baseDir, 'meio-escrito-a1b2', 'item.json'), '{not json');

      await expect(library.remove('meio-escrito-a1b2')).resolves.toBe(true);
      expect(await readdir(baseDir)).toHaveLength(0);
    });

    it('returns false for a missing item and for a malformed or traversal id', async () => {
      await expect(library.remove('nunca-existiu-a1b2')).resolves.toBe(false);
      await expect(library.remove('MAIUSCULO')).resolves.toBe(false);
      await expect(library.remove('')).resolves.toBe(false);
    });

    it('refuses a traversal id even when the target actually exists outside the root', async () => {
      // sourceDir is a real sibling of baseDir inside tmpdir — the exact tree
      // a missing id guard would let `rm -rf` reach through "../".
      const victim = await writeSource('nao-me-apague.txt');
      const escape = `../${basename(sourceDir)}`;

      await expect(library.remove(escape)).resolves.toBe(false);
      await expect(readdir(sourceDir)).resolves.toContain(basename(victim));
    });

    it('unlinks a symlinked item dir without touching the tree it points at', async () => {
      const outside = mkdtempSync(join(tmpdir(), 'leadzy-remove-outside-'));
      try {
        await writeFile(join(outside, 'vitima.txt'), 'must survive');
        await symlink(outside, join(baseDir, 'link-malicioso'));

        await expect(library.remove('link-malicioso')).resolves.toBe(true);

        expect(await readdir(baseDir)).toHaveLength(0);
        expect(await readdir(outside)).toEqual(['vitima.txt']);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  it('reports hasPreview false when no companion png exists', async () => {
    const source = await writeSource('sticker.webm');
    const item = await library.saveFrom(source, { name: 'Sticker sem preview', kind: 'sticker' });
    expect(item.hasPreview).toBe(false);
  });

  it('gives two items saved under the same name distinct, non-colliding ids', async () => {
    const sourceA = await writeSource('a.webm');
    const sourceB = await writeSource('b.webm');
    const itemA = await library.saveFrom(sourceA, { name: 'CTA', kind: 'cta' });
    const itemB = await library.saveFrom(sourceB, { name: 'CTA', kind: 'cta' });

    expect(itemA.id).not.toBe(itemB.id);
    expect(await library.list()).toHaveLength(2);
  });

  it('lists newest first', async () => {
    const sourceA = await writeSource('a.webm');
    const itemA = await library.saveFrom(sourceA, { name: 'Primeiro', kind: 'other' });
    // OverlayLibrary stamps createdAt from the wall clock with no injectable
    // seam — a short real delay is the only way to force a distinguishable,
    // later timestamp for the ordering assertion below.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const sourceB = await writeSource('b.webm');
    const itemB = await library.saveFrom(sourceB, { name: 'Segundo', kind: 'other' });

    const listed = await library.list();
    expect(listed.map((entry) => entry.id)).toEqual([itemB.id, itemA.id]);
  });

  it('skips a folder with corrupted item.json instead of throwing', async () => {
    const source = await writeSource('good.webm');
    const good = await library.saveFrom(source, { name: 'Bom', kind: 'other' });

    const brokenDir = join(baseDir, 'broken-item');
    await mkdir(brokenDir, { recursive: true });
    await writeFile(join(brokenDir, 'item.json'), '{not valid json');

    const listed = await library.list();
    expect(listed.map((entry) => entry.id)).toEqual([good.id]);
  });

  it('skips a folder whose manifest id does not match its own folder name', async () => {
    const source = await writeSource('good.webm');
    const good = await library.saveFrom(source, { name: 'Bom', kind: 'other' });

    const mismatchedDir = join(baseDir, 'folder-name');
    await mkdir(mismatchedDir, { recursive: true });
    await writeFile(
      join(mismatchedDir, 'item.json'),
      JSON.stringify({
        id: 'different-id',
        name: 'Mismatch',
        kind: 'other',
        file: 'x.webm',
        createdAt: new Date().toISOString(),
      }),
    );

    const listed = await library.list();
    expect(listed.map((entry) => entry.id)).toEqual([good.id]);
  });

  it('resolveFile returns the real path for a valid item + filename', async () => {
    const source = await writeSource('a.webm');
    const item = await library.saveFrom(source, { name: 'A', kind: 'other' });
    const resolved = await library.resolveFile(item.id, item.file);
    // realpath() resolves symlinks (e.g. macOS /tmp -> /private/tmp), so
    // compare against the same resolution rather than the raw mkdtemp path.
    expect(resolved).toBe(await realpath(join(baseDir, item.id, item.file)));
  });

  it('resolveFile rejects a malformed id without touching the filesystem', async () => {
    expect(await library.resolveFile('', 'a.webm')).toBeNull();
    expect(await library.resolveFile('../etc', 'a.webm')).toBeNull();
    expect(await library.resolveFile('id/with/slash', 'a.webm')).toBeNull();
  });

  it('resolveFile refuses an item folder that is a symlink escaping the library root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'leadzy-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'secret');
    const { symlink } = await import('node:fs/promises');
    await symlink(outside, join(baseDir, 'evil-item'));
    expect(await library.resolveFile('evil-item', 'secret.txt')).toBeNull();
    rmSync(outside, { recursive: true, force: true });
  });

  it('saveFrom rejects a non-finite durationS instead of corrupting the manifest', async () => {
    const source = await writeSource('inf.webm');
    await expect(
      library.saveFrom(source, { name: 'Inf', kind: 'other', durationS: Infinity }),
    ).rejects.toThrow('invalid library item');
    expect(await library.list()).toEqual([]);
  });

  it('resolveFile rejects a filename that is not a plain basename', async () => {
    const source = await writeSource('a.webm');
    const item = await library.saveFrom(source, { name: 'A', kind: 'other' });
    expect(await library.resolveFile(item.id, '../secret.txt')).toBeNull();
    expect(await library.resolveFile(item.id, '')).toBeNull();
  });

  it('resolveFile returns null for a nonexistent item or file', async () => {
    expect(await library.resolveFile('does-not-exist-x1y2', 'a.webm')).toBeNull();
    const source = await writeSource('a.webm');
    const item = await library.saveFrom(source, { name: 'A', kind: 'other' });
    expect(await library.resolveFile(item.id, 'missing.webm')).toBeNull();
  });

  it('saveFrom rejects an unknown kind', async () => {
    const source = await writeSource('a.webm');
    await expect(library.saveFrom(source, { name: 'A', kind: 'not-a-real-kind' })).rejects.toThrow(
      /invalid library item/,
    );
  });

  it('saveFrom rejects a source file that does not exist', async () => {
    await expect(
      library.saveFrom(join(sourceDir, 'missing.webm'), { name: 'A', kind: 'other' }),
    ).rejects.toThrow();
  });

  it('leaves no orphaned item folder when saveFrom fails partway through', async () => {
    await expect(
      library.saveFrom(join(sourceDir, 'missing.webm'), { name: 'Falha', kind: 'other' }),
    ).rejects.toThrow();

    const remaining = await readdir(baseDir).catch(() => []);
    expect(remaining).toEqual([]);
  });

  describe('parametric items', () => {
    it('exposes description, template and variables from an agent-written manifest', async () => {
      await writeManifest('cta-verde-a1b2', parametricManifest());

      const [item] = await library.list();
      expect(item?.description).toBe('Use no fim do anúncio, sobre o rosto.');
      expect(item?.template).toBe('source.html');
      expect(item?.variables).toEqual([
        { name: 'HEADLINE', label: 'Chamada', default: 'Compre agora' },
        { name: 'PRICE', default: 'R$ 99' },
      ]);
    });

    it('keeps listing a plain item that declares none of the new fields', async () => {
      await writeManifest('plain-item-a1b2', {
        id: 'plain-item-a1b2',
        name: 'Antigo',
        kind: 'other',
        file: 'old.webm',
        createdAt: new Date().toISOString(),
      });

      const [item] = await library.list();
      expect(item?.id).toBe('plain-item-a1b2');
      expect(item?.template).toBeUndefined();
      expect(item?.variables).toBeUndefined();
    });

    it('skips an item whose variable name is not UPPER_SNAKE_CASE', async () => {
      await writeManifest(
        'cta-verde-a1b2',
        parametricManifest({ variables: [{ name: 'headline', default: 'x' }] }),
      );
      expect(await library.list()).toEqual([]);
    });

    it('skips an item declaring variables with no template to substitute them into', async () => {
      const { template: _template, ...withoutTemplate } = parametricManifest();
      await writeManifest('cta-verde-a1b2', withoutTemplate);
      expect(await library.list()).toEqual([]);
    });

    it('skips an item whose variables repeat a name', async () => {
      await writeManifest(
        'cta-verde-a1b2',
        parametricManifest({
          variables: [
            { name: 'HEADLINE', default: 'a' },
            { name: 'HEADLINE', default: 'b' },
          ],
        }),
      );
      expect(await library.list()).toEqual([]);
    });

    it('skips an item declaring more variables than the form can show', async () => {
      await writeManifest(
        'cta-verde-a1b2',
        parametricManifest({
          variables: Array.from({ length: 9 }, (_unused, index) => ({
            name: `VAR_${String(index)}`,
            default: 'x',
          })),
        }),
      );
      expect(await library.list()).toEqual([]);
    });

    it('skips a template that is a path instead of a plain filename', async () => {
      await writeManifest(
        'cta-verde-a1b2',
        parametricManifest({ template: '../../../etc/passwd' }),
      );
      expect(await library.list()).toEqual([]);
    });

    it('skips an item whose asset would collide with the template in the project folder', async () => {
      await writeManifest('cta-verde-a1b2', parametricManifest({ file: 'template.html' }));
      expect(await library.list()).toEqual([]);

      await writeManifest(
        'cta-verde-a1b2',
        parametricManifest({ file: 'source.html', template: 'source.html' }),
      );
      expect(await library.list()).toEqual([]);
    });

    it('bounds the description and still rejects unknown keys', async () => {
      await writeManifest('cta-verde-a1b2', parametricManifest({ description: 'x'.repeat(200) }));
      expect(await library.list()).toHaveLength(1);

      await writeManifest('cta-verde-a1b2', parametricManifest({ description: 'x'.repeat(201) }));
      expect(await library.list()).toEqual([]);

      await writeManifest('cta-verde-a1b2', parametricManifest({ description: '' }));
      expect(await library.list()).toEqual([]);

      await writeManifest('cta-verde-a1b2', parametricManifest({ rogue: 'field' }));
      expect(await library.list()).toEqual([]);
    });
  });
});
