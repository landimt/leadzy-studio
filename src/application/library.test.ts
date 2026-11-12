import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EditDoc } from '../core/schema.js';
import { OverlayLibrary } from '../server/services/library.js';
import { ok } from '../core/result.js';
import type { LibraryItem } from '../server/services/library.js';
import {
  addLibraryItem,
  applyLibraryRebake,
  importLibraryItem,
  locateLibraryBlock,
  parseVariableAssignments,
  prepareLibraryRebake,
} from './library.js';

const doc = (blocks: EditDoc['tracks'][number]['blocks']): EditDoc =>
  ({
    version: 2,
    fps: 25,
    output: { width: 1080, height: 1920, loudnormLufs: -14 },
    sources: { cam: { path: 'camera.mp4' } },
    tracks: [
      { id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 4 }] },
      { id: 'overlays', kind: 'overlay', blocks },
    ],
    subtitles: { enabled: false, preset: 'pill' },
  }) as EditDoc;

const piece = (at: number, variables: Record<string, string> = { TEXT: 'oi' }) => ({
  file: 'edit/assets/library/caixinha/bake-1.webm',
  at,
  duration: 3,
  library: { item: 'caixinha', variables },
});

describe('locateLibraryBlock', () => {
  it('finds the block by index when file and position still match', () => {
    const found = locateLibraryBlock(doc([piece(0), piece(5)]), {
      trackId: 'overlays',
      blockIndex: 1,
      file: piece(5).file,
      at: 5,
    });
    expect(found?.blockIndex).toBe(1);
  });

  it('follows the block by file and position when the index went stale', () => {
    const found = locateLibraryBlock(
      doc([{ file: 'edit/assets/x.png', at: 1, duration: 1 }, piece(5)]),
      {
        trackId: 'overlays',
        blockIndex: 0,
        file: piece(5).file,
        at: 5,
      },
    );
    expect(found?.blockIndex).toBe(1);
  });

  it('uses the position to tell twins apart, and refuses an index whose position disagrees', () => {
    const twins = doc([piece(0), piece(5)]);
    expect(
      locateLibraryBlock(twins, { trackId: 'overlays', blockIndex: 4, file: piece(0).file, at: 5 })
        ?.blockIndex,
    ).toBe(1);
    expect(
      locateLibraryBlock(twins, { trackId: 'overlays', blockIndex: 0, file: piece(0).file, at: 7 }),
    ).toBeUndefined();
  });

  it('refuses to guess between twins that share the file when no position is given', () => {
    expect(
      locateLibraryBlock(doc([piece(0), piece(5)]), {
        trackId: 'overlays',
        blockIndex: 4,
        file: piece(0).file,
      }),
    ).toBeUndefined();
  });
});

describe('prepareLibraryRebake', () => {
  const request = {
    trackId: 'overlays',
    blockIndex: 0,
    file: piece(0).file,
    variables: { TEXT: 'novo' },
  };

  it("plans the bake with the block's current values as the snapshot", () => {
    const prepared = prepareLibraryRebake(doc([piece(0)]), request);
    expect(prepared).toEqual({
      ok: true,
      plan: {
        itemId: 'caixinha',
        initialVariablesSnapshot: { TEXT: 'oi' },
        requestedTimingS: null,
      },
    });
  });

  it("refuses a variable set that is not exactly the piece's", () => {
    const prepared = prepareLibraryRebake(doc([piece(0)]), {
      ...request,
      variables: { TEXT: 'x', EXTRA: 'y' },
    });
    expect(prepared).toMatchObject({ ok: false, code: 'variables_mismatch' });
    if (!prepared.ok) expect(prepared.message).toContain('TEXT');
  });

  it('refuses a timing value outside the allowed range', () => {
    const prepared = prepareLibraryRebake(doc([piece(0, { DURATION_SECONDS: '2' })]), {
      ...request,
      variables: { DURATION_SECONDS: '999' },
    });
    expect(prepared).toMatchObject({ ok: false, code: 'timing_out_of_range' });
  });

  it('refuses a timing value that is not a number', () => {
    const prepared = prepareLibraryRebake(doc([piece(0, { DURATION_SECONDS: '2' })]), {
      ...request,
      variables: { DURATION_SECONDS: 'abc' },
    });
    expect(prepared).toMatchObject({ ok: false, code: 'timing_out_of_range' });
  });

  it('refuses values the document schema would reject before rendering anything', () => {
    expect(
      prepareLibraryRebake(doc([piece(0)]), { ...request, variables: { TEXT: 'a\nb' } }),
    ).toMatchObject({ ok: false, code: 'invalid_variables' });
    expect(
      prepareLibraryRebake(doc([piece(0)]), { ...request, variables: { TEXT: 'x'.repeat(121) } }),
    ).toMatchObject({ ok: false, code: 'invalid_variables' });
  });

  it('reports a missing block', () => {
    expect(prepareLibraryRebake(doc([]), request)).toMatchObject({
      ok: false,
      code: 'library_block_not_found',
    });
  });
});

describe('parseVariableAssignments', () => {
  it('splits NAME=value once, keeping = inside the value', () => {
    expect(parseVariableAssignments(['TEXT=a=b', 'CTA=clique'])).toEqual({
      ok: true,
      variables: { TEXT: 'a=b', CTA: 'clique' },
    });
  });

  it('refuses a bare name and a repeated name', () => {
    expect(parseVariableAssignments(['TEXT'])).toMatchObject({ ok: false });
    expect(parseVariableAssignments(['=x'])).toMatchObject({ ok: false });
    expect(parseVariableAssignments(['TEXT=a', 'TEXT=b'])).toMatchObject({ ok: false });
    expect(parseVariableAssignments(['constructor=x'])).toMatchObject({ ok: true });
  });
});

describe('applyLibraryRebake guards', () => {
  const request = {
    trackId: 'overlays',
    blockIndex: 0,
    file: piece(0).file,
    at: 0,
    variables: { TEXT: 'novo' },
  };
  const deps = (docAtWrite: EditDoc) => ({
    editWriter: {
      update: (fn: (d: EditDoc) => EditDoc) => Promise.resolve(fn(docAtWrite)).then(() => 'h'),
    },
    probe: () => Promise.reject(new Error('no probe')),
    render: () => Promise.resolve(ok('edit/assets/library/caixinha/bake-2.webm')),
    origin: 'agent' as const,
  });

  it('refuses to write when the block now belongs to another item', async () => {
    const prepared = prepareLibraryRebake(doc([piece(0)]), request);
    if (!prepared.ok) throw new Error(prepared.message);
    const swapped = doc([{ ...piece(0), library: { item: 'outra', variables: { TEXT: 'oi' } } }]);
    await expect(applyLibraryRebake('/p', deps(swapped), prepared.plan, request)).rejects.toThrow(
      'block moved',
    );
  });

  it('refuses to write when the block is gone', async () => {
    const prepared = prepareLibraryRebake(doc([piece(0)]), request);
    if (!prepared.ok) throw new Error(prepared.message);
    await expect(applyLibraryRebake('/p', deps(doc([])), prepared.plan, request)).rejects.toThrow(
      'block moved',
    );
  });

  it('refuses to write when the values changed meanwhile', async () => {
    const prepared = prepareLibraryRebake(doc([piece(0)]), request);
    if (!prepared.ok) throw new Error(prepared.message);
    const changed = doc([piece(0, { TEXT: 'mudou' })]);
    await expect(applyLibraryRebake('/p', deps(changed), prepared.plan, request)).rejects.toThrow(
      'variables changed',
    );
  });
});

describe('addLibraryItem', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'leadzy-library-add-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function itemFolder(id: string, manifest: Record<string, unknown>): Promise<string> {
    const folder = join(root, 'src', id);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'item.json'), JSON.stringify(manifest));
    await writeFile(join(folder, 'piece.png'), 'png bytes');
    return folder;
  }

  it('copies a valid item folder into the library and lists it', async () => {
    const library = new OverlayLibrary(join(root, 'library'));
    const folder = await itemFolder('lower-third', {
      id: 'lower-third',
      name: 'Lower third',
      kind: 'lower-third',
      file: 'piece.png',
      createdAt: '2026-08-28T10:00:00.000Z',
    });

    const added = await addLibraryItem(library, folder);

    expect(added).toMatchObject({ ok: true, item: { id: 'lower-third', kind: 'lower-third' } });
    expect((await library.list()).map((i) => i.id)).toEqual(['lower-third']);
    expect(await addLibraryItem(library, folder)).toMatchObject({ ok: false });
  });

  it('never merges into or removes a folder that already exists in the library', async () => {
    const library = new OverlayLibrary(join(root, 'library'));
    await mkdir(join(root, 'library', 'lower-third'), { recursive: true });
    await writeFile(join(root, 'library', 'lower-third', 'item.json'), '{ "id": "lower-third" }');
    await writeFile(join(root, 'library', 'lower-third', 'stray.bin'), 'forty megabytes');
    const folder = await itemFolder('lower-third', {
      id: 'lower-third',
      name: 'Lower third',
      kind: 'lower-third',
      file: 'piece.png',
      createdAt: '2026-08-28T10:00:00.000Z',
    });

    const added = await addLibraryItem(library, folder);

    expect(added).toMatchObject({ ok: false });
    expect(existsSync(join(root, 'library', 'lower-third', 'stray.bin'))).toBe(true);
  });

  it('refuses an item whose asset is missing, leaving no folder behind', async () => {
    const library = new OverlayLibrary(join(root, 'library'));
    const folder = await itemFolder('no-asset', {
      id: 'no-asset',
      name: 'No asset',
      kind: 'sticker',
      file: 'missing.png',
      createdAt: '2026-08-28T10:00:00.000Z',
    });

    const added = await addLibraryItem(library, folder);

    expect(added).toMatchObject({ ok: false });
    expect(existsSync(join(root, 'library', 'no-asset'))).toBe(false);
  });

  it('follows a symlinked item folder to the real one', async () => {
    const library = new OverlayLibrary(join(root, 'library'));
    const folder = await itemFolder('linked', {
      id: 'linked',
      name: 'Linked',
      kind: 'sticker',
      file: 'piece.png',
      createdAt: '2026-08-28T10:00:00.000Z',
    });
    await symlink(folder, join(root, 'link-to-linked'));

    const added = await addLibraryItem(library, join(root, 'link-to-linked'));

    expect(added).toMatchObject({ ok: true, item: { id: 'linked' } });
    expect((await stat(join(root, 'library', 'linked'))).isDirectory()).toBe(true);
  });

  it('refuses a folder whose manifest id differs from its name, and an invalid manifest leaves nothing behind', async () => {
    const library = new OverlayLibrary(join(root, 'library'));
    const wrongId = await itemFolder('a-piece', {
      id: 'other',
      name: 'x',
      kind: 'cta',
      file: 'piece.png',
      createdAt: 'now',
    });
    expect(await addLibraryItem(library, wrongId)).toMatchObject({ ok: false });

    const broken = await itemFolder('broken', {
      id: 'broken',
      name: 'x',
      kind: 'not-a-kind',
      file: 'piece.png',
      createdAt: 'now',
    });
    expect(await addLibraryItem(library, broken)).toMatchObject({ ok: false });
    expect(await library.list()).toEqual([]);
  });
});

describe('importLibraryItem', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'leadzy-library-import-'));
    await mkdir(join(root, 'lib'), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const item = (overrides: Partial<LibraryItem> = {}): LibraryItem => ({
    id: 'piece',
    name: 'Piece',
    kind: 'sticker',
    file: 'piece.png',
    createdAt: '2026-08-28T10:00:00.000Z',
    hasPreview: false,
    preview: null,
    ...overrides,
  });

  async function libraryWith(
    items: LibraryItem[],
    files: Record<string, string>,
  ): Promise<{
    list: () => Promise<LibraryItem[]>;
    resolveFile: (id: string, name: string) => Promise<string | null>;
  }> {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(root, 'lib', name), content);
    }
    return {
      list: () => Promise.resolve(items),
      resolveFile: (_id, name) => Promise.resolve(name in files ? join(root, 'lib', name) : null),
    };
  }

  function writerCapturing(initial: EditDoc): {
    update: (fn: (doc: EditDoc) => EditDoc, origin: string) => Promise<string>;
    current: () => EditDoc;
    origins: string[];
  } {
    let current = initial;
    const origins: string[] = [];
    return {
      update: (fn, origin) => {
        origins.push(origin);
        current = fn(current);
        return Promise.resolve('hash-after');
      },
      current: () => current,
      origins,
    };
  }

  const probeWidth = (width: number) => () =>
    Promise.resolve(
      ok({ kind: 'video' as const, durationS: 1, fps: 25, width, height: 100, hasAudio: false }),
    );

  it('copies the asset and appends a sized block to the existing overlay track', async () => {
    const library = await libraryWith([item()], { 'piece.png': 'png', 'piece.png.webp': 'webp' });
    const writer = writerCapturing(doc([piece(0)]));

    const outcome = await importLibraryItem(
      root,
      { library, editWriter: writer, probe: probeWidth(540), origin: 'agent' },
      { id: 'piece', at: 2.345 },
    );

    expect(outcome).toEqual({
      ok: true,
      hash: 'hash-after',
      file: 'edit/assets/library/piece/piece.png',
    });
    expect(writer.origins).toEqual(['agent']);
    const overlays = writer.current().tracks.find((t) => t.id === 'overlays');
    expect(overlays?.blocks).toHaveLength(2);
    expect(overlays?.blocks[1]).toEqual({
      file: 'edit/assets/library/piece/piece.png',
      at: 2.35,
      duration: 4,
      position: 'bottom-left',
      scale: 0.5,
    });
    expect(writer.current().tracks).toHaveLength(2);
  });

  it('centres a CTA and creates the overlay track when the document has none', async () => {
    const library = await libraryWith([item({ kind: 'cta', durationS: 3.2 })], {
      'piece.png': 'png',
    });
    const base = doc([]);
    const writer = writerCapturing({
      ...base,
      tracks: base.tracks.filter((t) => t.kind !== 'overlay'),
    });

    const outcome = await importLibraryItem(
      root,
      { library, editWriter: writer, probe: probeWidth(1080), origin: 'agent' },
      { id: 'piece', at: 0 },
    );

    expect(outcome.ok).toBe(true);
    const overlays = writer.current().tracks.find((t) => t.kind === 'overlay');
    expect(overlays?.id).toBe('overlays');
    expect(overlays?.blocks[0]).toMatchObject({
      position: { x: 0, y: 0.38 },
      scale: 1,
      duration: 3.2,
    });
  });

  it('reports a listed item whose asset file is gone as not found', async () => {
    const library = await libraryWith([item()], {});
    const outcome = await importLibraryItem(
      root,
      { library, editWriter: writerCapturing(doc([])), probe: probeWidth(1), origin: 'agent' },
      { id: 'piece', at: 0 },
    );
    expect(outcome).toMatchObject({ ok: false, code: 'library_item_not_found' });
  });

  it('refuses a parametric item whose template placeholders and manifest disagree, naming both sides', async () => {
    const library = await libraryWith(
      [item({ template: 'template.html', variables: [{ name: 'TEXT', default: 'oi' }] })],
      { 'piece.png': 'png', 'template.html': '<p>static</p>' },
    );
    const outcome = await importLibraryItem(
      root,
      { library, editWriter: writerCapturing(doc([])), probe: probeWidth(1), origin: 'agent' },
      { id: 'piece', at: 0 },
    );
    expect(outcome).toMatchObject({ ok: false, code: 'library_template_mismatch' });
    if (!outcome.ok) expect(outcome.message).toContain('(none)');
  });

  it('refuses a template that puts a placeholder inside a script', async () => {
    const library = await libraryWith(
      [item({ template: 'template.html', variables: [{ name: 'TEXT', default: 'oi' }] })],
      { 'piece.png': 'png', 'template.html': '<script>var t = "{{TEXT}}";</script>' },
    );
    const outcome = await importLibraryItem(
      root,
      { library, editWriter: writerCapturing(doc([])), probe: probeWidth(1), origin: 'agent' },
      { id: 'piece', at: 0 },
    );
    expect(outcome).toMatchObject({ ok: false, code: 'library_template_unsafe' });
  });
});

describe('applyLibraryRebake', () => {
  it('repoints only the target block at the new bake and records the new values', async () => {
    const initial = doc([piece(0, { TEXT: 'a' }), piece(5, { TEXT: 'b' })]);
    let current = initial;
    const request = {
      trackId: 'overlays',
      blockIndex: 1,
      file: piece(5).file,
      at: 5,
      variables: { TEXT: 'novo' },
    };
    const prepared = prepareLibraryRebake(initial, request);
    if (!prepared.ok) throw new Error(prepared.message);

    const baked = await applyLibraryRebake(
      '/p',
      {
        editWriter: {
          update: (fn) => {
            current = fn(current);
            return Promise.resolve('h');
          },
        },
        probe: () => Promise.reject(new Error('no timing variable, no probe')),
        render: () => Promise.resolve(ok('edit/assets/library/caixinha/bake-2.webm')),
        origin: 'agent',
      },
      prepared.plan,
      request,
    );

    expect(baked).toEqual({ file: 'edit/assets/library/caixinha/bake-2.webm', hash: 'h' });
    const overlays = current.tracks.find((t) => t.id === 'overlays');
    expect(overlays?.blocks[0]).toEqual(piece(0, { TEXT: 'a' }));
    expect(overlays?.blocks[1]).toMatchObject({
      file: 'edit/assets/library/caixinha/bake-2.webm',
      library: { item: 'caixinha', variables: { TEXT: 'novo' } },
    });
  });
});
