import Fastify from 'fastify';
import type * as pathModule from 'node:path';
import type * as fsModule from 'node:fs';
import type * as fsPromisesModule from 'node:fs/promises';
import { normalize } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safePath } from './streaming.js';
import { OverlayLibrary } from './services/library.js';
import { registerEventsRoutes } from './routes/events.js';
import { JobManager } from './jobs.js';

const mocks = vi.hoisted(() => ({
  realpath: vi.fn<(path: unknown) => Promise<string>>(),
  watch: vi.fn((_paths: unknown, _options: unknown) => ({
    on: vi.fn(),
    close: vi.fn(() => Promise.resolve()),
  })),
}));

// Exercise actual Windows path semantics on every CI host. Filesystem
// results use the same backslash format returned by Windows realpath().
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof pathModule>();
  return { ...actual, ...actual.win32, default: actual.win32 };
});
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof fsPromisesModule>()),
  realpath: mocks.realpath,
  stat: vi.fn(() => Promise.resolve({ isFile: () => true })),
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof fsModule>()),
  mkdirSync: vi.fn(),
}));
vi.mock('chokidar', () => ({ watch: mocks.watch }));

beforeEach(() => {
  mocks.realpath.mockImplementation((path) => Promise.resolve(normalize(String(path))));
});
afterEach(() => vi.clearAllMocks());

describe('Windows filesystem boundaries', () => {
  it('serves contained project media using native real paths', async () => {
    await expect(safePath('C:\\projects\\demo', 'camera.mp4')).resolves.toBe(
      'C:\\projects\\demo\\camera.mp4',
    );
    await expect(safePath('C:\\projects\\demo', 'edit/assets/image.png')).resolves.toBe(
      'C:\\projects\\demo\\edit\\assets\\image.png',
    );
  });

  it('still rejects lexical traversal and symlinks to sibling folders', async () => {
    await expect(safePath('C:\\projects\\demo', '../private.mp4')).resolves.toBeNull();
    mocks.realpath.mockImplementation((path) =>
      Promise.resolve(
        String(path).endsWith('camera.mp4')
          ? 'C:\\projects\\demo-private\\camera.mp4'
          : normalize(String(path)),
      ),
    );
    await expect(safePath('C:\\projects\\demo', 'camera.mp4')).resolves.toBeNull();
  });

  it('resolves library assets and refuses symlinks outside its root', async () => {
    const library = new OverlayLibrary('C:\\Users\\Ana\\library');
    await expect(library.resolveFile('cta-a1b2', 'preview.png')).resolves.toBe(
      'C:\\Users\\Ana\\library\\cta-a1b2\\preview.png',
    );
    mocks.realpath.mockImplementation((path) =>
      Promise.resolve(
        String(path).endsWith('preview.png')
          ? 'C:\\Users\\Ana\\library-private\\preview.png'
          : normalize(String(path)),
      ),
    );
    await expect(library.resolveFile('cta-a1b2', 'preview.png')).resolves.toBeNull();
  });

  it('ignores render intermediates while watching receipts with Chokidar slash paths', async () => {
    const app = Fastify();
    registerEventsRoutes(app, {
      projectDir: 'C:\\projects\\demo',
      jobs: new JobManager(),
      history: { record: vi.fn(() => Promise.resolve()) },
      editWriter: { lastSavedHash: '' },
    });
    try {
      const options = mocks.watch.mock.calls[0]?.[1] as { ignored: (path: string) => boolean };
      expect(options.ignored('C:/projects/demo/edit/cache/segments')).toBe(true);
      expect(options.ignored('C:/projects/demo/edit/cache/final.inputs.json')).toBe(false);
      expect(options.ignored('C:/projects/demo/edit/cache')).toBe(false);
      expect(options.ignored('C:/projects/demo/edit/assets/image.png')).toBe(false);
    } finally {
      await app.close();
    }
  });
});
