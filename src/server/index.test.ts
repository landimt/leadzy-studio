import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ok } from '../core/result.js';
import type { EditDoc, OverlayTrack } from '../core/schema.js';
import { startServer, type StartedServer } from './index.js';
import type { LibraryItem } from './services/library.js';
import type * as libraryOverlayModule from './services/libraryOverlay.js';
import { importMedia } from './services/mediaImport.js';
import { programKey } from '../core/render/freshness.js';
import { editDocHash, editJsonPath } from './services/project.js';
import { renderInputFingerprints, writeRenderReceipt } from './services/renderReceipt.js';

/**
 * The re-bake job's only external step is the HyperFrames render — mocked so
 * the route's write-back path stays in the unit tier (no headless Chrome).
 * Every other export of the module stays real; `title.ts` imports one.
 */
const renderLibraryOverlayMock = vi.hoisted(() =>
  vi.fn<typeof libraryOverlayModule.renderLibraryOverlay>(),
);
vi.mock('./services/libraryOverlay.js', async (importOriginal) => ({
  ...(await importOriginal<typeof libraryOverlayModule>()),
  renderLibraryOverlay: renderLibraryOverlayMock,
}));

const JSON_HEADERS = { 'content-type': 'application/json' };
const isRoot = process.getuid?.() === 0;
// These tests stage an EACCES by removing a folder's write bit. Root
// ignores that bit and Windows has no POSIX mode bits at all, so neither
// can produce the failure the assertions are about.
const cannotDenyWrites = isRoot || process.platform === 'win32';

async function currentEditHash(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/edit`);
  const body = (await response.json()) as { hash: string };
  return body.hash;
}

function editHeaders(expectHash: string): Record<string, string> {
  return { ...JSON_HEADERS, 'if-match': expectHash };
}

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

const BASE_DOC = makeDoc(1);

let projectDir: string;
let libraryDir: string;
let configDir: string;
let server: StartedServer;
let baseUrl: string;
const renderRequests: boolean[] = [];
const libraryOverlayProbePaths: string[] = [];
let measuredLibraryOverlayDurationS = 3;

// One server, booted once: these routes don't need per-test isolation (the
// baseline 'startup' snapshot is immutable once written — see the reasoning
// in each `it`), and starting/closing the Vite dev-middleware Fastify wraps
// per test is slow and races its esbuild dep-scanner on teardown. Matches
// the shared-setup pattern in render.integration.test.ts.
beforeAll(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'leadzy-server-'));
  // OverlayLibrary defaults to the real home directory — a test run must
  // never touch it, so LEADZY_LIBRARY_DIR is set before startServer
  // constructs the library (see services/library.ts).
  libraryDir = mkdtempSync(join(tmpdir(), 'leadzy-library-'));
  process.env.LEADZY_LIBRARY_DIR = libraryDir;
  // Same reasoning for UserConfig (services/userConfig.ts) — a test run
  // must never touch the real ~/.leadzy-studio/config.json.
  configDir = mkdtempSync(join(tmpdir(), 'leadzy-config-'));
  process.env.LEADZY_CONFIG_DIR = configDir;
  await mkdir(join(projectDir, 'edit'), { recursive: true });
  await writeFile(editJsonPath(projectDir), JSON.stringify(BASE_DOC, null, 2) + '\n');
  server = await startServer(projectDir, {
    mediaImporter: (dir, filename, source, options) =>
      importMedia(dir, filename, source, {
        ...options,
        probe: async (path) => {
          // Route tests exercise the raw streaming transport without making
          // the unit suite depend on a platform ffprobe binary/codec fixture.
          const info = await stat(path);
          return ok({
            kind: 'video',
            durationS: info.size,
            fps: 25,
            width: 1080,
            height: 1920,
            hasAudio: true,
          });
        },
        probeStillImage: async (path) => {
          const info = await stat(path);
          return ok({
            kind: 'image',
            width: 1200 + info.size,
            height: 800,
            hasAudio: false,
          });
        },
      }),
    imageProbe: () =>
      Promise.resolve(ok({ kind: 'image', width: 1200, height: 800, hasAudio: false })),
    libraryOverlayProbe: (path) => {
      libraryOverlayProbePaths.push(path);
      return Promise.resolve(
        ok({
          kind: 'video',
          durationS: measuredLibraryOverlayDurationS,
          fps: 25,
          width: 1080,
          height: 1920,
          hasAudio: false,
        }),
      );
    },
    renderer: (dir, doc, options) => {
      renderRequests.push(options.preview);
      const outputRel = options.preview ? 'edit/preview.mp4' : 'edit/final.mp4';
      return Promise.resolve(
        ok({
          outputRel,
          outputAbs: join(dir, outputRel),
          durationS: 1,
          expectedDurationS: 1,
          editHash: editDocHash(doc),
          canonical: true,
          kind: options.preview ? 'preview' : 'final',
          programKey: programKey(doc),
        }),
      );
    },
  });
  baseUrl = server.address;
}, 20_000);

afterAll(async () => {
  await server.close();
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(libraryDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  delete process.env.LEADZY_LIBRARY_DIR;
  delete process.env.LEADZY_CONFIG_DIR;
});

describe('server routes', { concurrent: false }, () => {
  describe('POST /api/media/import', () => {
    it("streams a body larger than Fastify's default 1 MiB and returns the imported item", async () => {
      const bytes = Buffer.alloc(1024 * 1024 + 17, 0x61);
      const filename = 'new-camera.mp4';
      try {
        const response = await fetch(
          `${baseUrl}/api/media/import?filename=${encodeURIComponent(filename)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: bytes,
          },
        );

        expect(response.status).toBe(201);
        const body = (await response.json()) as {
          item: { relPath: string; transcriptEngine: null; proxyRelPath: null };
        };
        expect(body.item).toMatchObject({
          relPath: filename,
          transcriptEngine: null,
          proxyRelPath: null,
        });
        expect((await stat(join(projectDir, filename))).size).toBe(bytes.length);
      } finally {
        await rm(join(projectDir, filename), { force: true });
      }
    });

    it('accepts x-file-name when the query parameter is absent', async () => {
      const filename = 'header-camera.mov';
      try {
        const response = await fetch(`${baseUrl}/api/media/import`, {
          method: 'POST',
          headers: {
            'content-type': 'application/octet-stream',
            'x-file-name': filename,
          },
          body: 'header-video-bytes',
        });

        expect(response.status).toBe(201);
        const body = (await response.json()) as { item: { relPath: string } };
        expect(body.item.relPath).toBe(filename);
      } finally {
        await rm(join(projectDir, filename), { force: true });
      }
    });

    it('imports a still image into edit/assets and exposes it in the unified media inventory', async () => {
      const filename = 'campaign-background.JPEG';
      const relPath = `edit/assets/${filename}`;
      try {
        const response = await fetch(
          `${baseUrl}/api/media/import?filename=${encodeURIComponent(filename)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: 'image-bytes',
          },
        );

        expect(response.status).toBe(201);
        const body = (await response.json()) as { item: Record<string, unknown> };
        expect(body.item).toMatchObject({
          kind: 'image',
          relPath,
          width: 1211,
          height: 800,
          hasAudio: false,
          transcriptEngine: null,
          proxyRelPath: null,
        });
        expect(await readFile(join(projectDir, relPath), 'utf8')).toBe('image-bytes');

        const projectResponse = await fetch(`${baseUrl}/api/project`);
        const project = (await projectResponse.json()) as {
          media: Record<string, unknown>[];
        };
        expect(project.media).toContainEqual(
          expect.objectContaining({ kind: 'image', relPath, width: 1200, height: 800 }),
        );
      } finally {
        await rm(join(projectDir, relPath), { force: true });
      }
    });

    it('rejects unsupported extensions before publishing', async () => {
      const response = await fetch(`${baseUrl}/api/media/import?filename=notes.txt`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: 'not-media',
      });

      expect(response.status).toBe(415);
      expect(((await response.json()) as { error: string }).error).toBe('unsupported_extension');
      await expect(readFile(join(projectDir, 'notes.txt'))).rejects.toBeDefined();
    });

    it.each(['../escape.mp4', '..\\escape.mp4', 'bad\nname.mp4', 'CON.mp4'])(
      'rejects an unsafe filename without sanitizing it into a destination: %j',
      async (filename) => {
        const response = await fetch(
          `${baseUrl}/api/media/import?filename=${encodeURIComponent(filename)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: 'not-media',
          },
        );

        expect(response.status).toBe(400);
      },
    );

    it('uses a collision suffix without overwriting the existing original', async () => {
      const original = join(projectDir, 'collision.mp4');
      const imported = join(projectDir, 'collision (1).mp4');
      await writeFile(original, 'original-video');
      try {
        const response = await fetch(`${baseUrl}/api/media/import?filename=collision.mp4`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: 'new-video',
        });

        expect(response.status).toBe(201);
        const body = (await response.json()) as { item: { relPath: string } };
        expect(body.item.relPath).toBe('collision (1).mp4');
        expect(await readFile(original, 'utf8')).toBe('original-video');
        expect(await readFile(imported, 'utf8')).toBe('new-video');
      } finally {
        await Promise.all([rm(original, { force: true }), rm(imported, { force: true })]);
      }
    });

    it('rejects a zero-byte upload', async () => {
      const response = await fetch(`${baseUrl}/api/media/import?filename=empty.mp4`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array(),
      });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe('empty_upload');
      await expect(readFile(join(projectDir, 'empty.mp4'))).rejects.toBeDefined();
    });
  });

  describe('GET /api/media/*', () => {
    it.each([
      ['preview.jpg', 'image/jpeg'],
      ['preview.jpeg', 'image/jpeg'],
      ['preview.webp', 'image/webp'],
    ])('serves %s with its image content type', async (filename, contentType) => {
      const relPath = `edit/assets/${filename}`;
      await mkdir(join(projectDir, 'edit', 'assets'), { recursive: true });
      await writeFile(join(projectDir, relPath), 'image');
      try {
        const response = await fetch(`${baseUrl}/api/media/${encodeURIComponent(relPath)}`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe(contentType);
      } finally {
        await rm(join(projectDir, relPath), { force: true });
      }
    });

    it('serves suffix byte ranges from the end of an audio artifact', async () => {
      await writeFile(join(projectDir, 'edit', 'range-proof.m4a'), '0123456789');

      const response = await fetch(`${baseUrl}/api/media/edit%2Frange-proof.m4a`, {
        headers: { range: 'bytes=-4' },
      });

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe('bytes 6-9/10');
      expect(await response.text()).toBe('6789');
    });

    it('rejects unsatisfiable byte ranges with the complete size', async () => {
      await writeFile(join(projectDir, 'edit', 'range-proof.m4a'), '0123456789');

      const response = await fetch(`${baseUrl}/api/media/edit%2Frange-proof.m4a`, {
        headers: { range: 'bytes=10-' },
      });

      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe('bytes */10');
    });
  });

  describe('GET /api/project', () => {
    it('does not expose an audio comparison when only the before artifact exists', async () => {
      const beforePath = join(projectDir, 'edit', 'audio-preview-before.m4a');
      const afterPath = join(projectDir, 'edit', 'audio-preview.m4a');
      await rm(afterPath, { force: true });
      await writeFile(beforePath, 'audio before');
      try {
        const res = await fetch(`${baseUrl}/api/project`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          hasAudioPreview: boolean;
          hasAudioComparison: boolean;
        };
        expect(body.hasAudioPreview).toBe(false);
        expect(body.hasAudioComparison).toBe(false);
      } finally {
        await rm(beforePath, { force: true });
      }
    });

    it('exposes the hash of the document that produced the preview', async () => {
      await mkdir(join(projectDir, 'edit', 'cache'), { recursive: true });
      await writeFile(join(projectDir, 'camera.mp4'), 'camera');
      await writeFile(join(projectDir, 'edit', 'preview.mp4'), 'preview');
      await writeFile(join(projectDir, 'edit', 'audio-preview.m4a'), 'audio preview');
      const previewInputs = await renderInputFingerprints(projectDir, BASE_DOC, 'preview');
      const audioInputs = await renderInputFingerprints(projectDir, BASE_DOC, 'audio-preview');
      expect(previewInputs.ok).toBe(true);
      expect(audioInputs.ok).toBe(true);
      if (!previewInputs.ok || !audioInputs.ok) return;
      await writeRenderReceipt(projectDir, 'preview', BASE_DOC, previewInputs.value);
      await writeRenderReceipt(projectDir, 'audio-preview', BASE_DOC, audioInputs.value);

      const res = await fetch(`${baseUrl}/api/project`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        hasPreview: boolean;
        previewEditHash: string | null;
        hasAudioPreview: boolean;
        hasAudioComparison: boolean;
        audioPreviewEditHash: string | null;
        audioPreviewCurrent: boolean;
      };
      expect(body.hasPreview).toBe(true);
      expect(body.previewEditHash).toBe(editDocHash(BASE_DOC));
      expect(body.hasAudioPreview).toBe(true);
      expect(body.hasAudioComparison).toBe(false);
      expect(body.audioPreviewEditHash).toBe(editDocHash(BASE_DOC));
      expect(body.audioPreviewCurrent).toBe(false);

      await writeFile(join(projectDir, 'edit', 'audio-preview-before.m4a'), 'audio before');
      const comparisonRes = await fetch(`${baseUrl}/api/project`);
      const comparison = (await comparisonRes.json()) as {
        hasAudioComparison: boolean;
        audioPreviewCurrent: boolean;
      };
      expect(comparison.hasAudioComparison).toBe(true);
      expect(comparison.audioPreviewCurrent).toBe(true);

      const visualDoc: EditDoc = {
        ...BASE_DOC,
        tracks: [
          ...BASE_DOC.tracks,
          {
            id: 'effects',
            kind: 'effect',
            blocks: [{ type: 'zoom', at: 1, duration: 0.5, scale: 1.2 }],
          },
        ],
      };
      await writeFile(editJsonPath(projectDir), `${JSON.stringify(visualDoc, null, 2)}\n`);
      const visualRes = await fetch(`${baseUrl}/api/project`);
      const visual = (await visualRes.json()) as {
        editHash: string;
        audioPreviewEditHash: string;
        audioPreviewCurrent: boolean;
      };
      expect(visual.audioPreviewCurrent).toBe(true);
      expect(visual.audioPreviewEditHash).not.toBe(visual.editHash);

      await writeFile(editJsonPath(projectDir), `${JSON.stringify(BASE_DOC, null, 2)}\n`);
      await Promise.all([
        rm(join(projectDir, 'edit', 'audio-preview-before.m4a'), { force: true }),
        rm(join(projectDir, 'edit', 'audio-preview.m4a'), { force: true }),
      ]);
    });
  });

  describe('POST /api/reveal', () => {
    it.each([
      ['a non-string path', { path: 123 }],
      ['an empty path', { path: '' }],
      ['no path', {}],
    ])('rejects %s with 400 invalid_body', async (_label, payload) => {
      const res = await fetch(`${baseUrl}/api/reveal`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
    });

    it('rejects an absolute path with 400', async () => {
      const res = await fetch(`${baseUrl}/api/reveal`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ path: '/etc/passwd' }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('path_outside_project');
    });

    it('rejects a traversal path with 400', async () => {
      const res = await fetch(`${baseUrl}/api/reveal`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ path: '../../etc/passwd' }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'path_outside_project',
        message: 'path must stay inside the project folder and exist',
      });
    });
  });

  describe('POST /api/history/restore', () => {
    it('returns 404 for a traversal id', async () => {
      const res = await fetch(`${baseUrl}/api/history/restore`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: '../../etc/passwd' }),
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: 'history_entry_not_found',
        message: 'no history entry with this id',
      });
    });

    it.each([
      ['a numeric id', JSON.stringify({ id: 123 })],
      ['an empty id', JSON.stringify({ id: '' })],
      ['no id', JSON.stringify({})],
      ['a string body', '"2099-01-01T00-00-00-000Z-ui"'],
    ])('rejects %s with 400 invalid_body', async (_label, raw) => {
      const res = await fetch(`${baseUrl}/api/history/restore`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: raw,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
    });

    it('returns 404 for a malformed id', async () => {
      const res = await fetch(`${baseUrl}/api/history/restore`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: 'not-a-valid-id' }),
      });
      expect(res.status).toBe(404);
    });

    it('returns 404 for a well-formed but nonexistent id', async () => {
      const res = await fetch(`${baseUrl}/api/history/restore`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: '2099-01-01T00-00-00-000Z-ui' }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/history', () => {
    it('includes the startup baseline snapshot', async () => {
      const res = await fetch(`${baseUrl}/api/history`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { entries: { origin: string; hash: string }[] };
      expect(Array.isArray(body.entries)).toBe(true);
      const startup = body.entries.find((entry) => entry.origin === 'startup');
      expect(startup).toBeDefined();
      expect(startup?.hash).toBe(editDocHash(BASE_DOC));
    });
  });

  describe('PUT /api/edit', () => {
    it('requires an expected hash instead of accepting a blind overwrite', async () => {
      const response = await fetch(`${baseUrl}/api/edit`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify(makeDoc(8)),
      });
      expect(response.status).toBe(428);
      expect(((await response.json()) as { error: string }).error).toBe('if_match_required');
    });

    it('rejects a document that fails the schema with 422 and the validation detail', async () => {
      const response = await fetch(`${baseUrl}/api/edit`, {
        method: 'PUT',
        headers: editHeaders(await currentEditHash()),
        body: JSON.stringify({ ...makeDoc(8), fps: 'fast' }),
      });
      expect(response.status).toBe(422);
      const body = (await response.json()) as { error: string; message: string };
      expect(body.error).toBe('invalid_edit_document');
      expect(body.message).toContain('edit.json failed validation');
      expect(body.message).toContain('fps');
    });

    it('serializes concurrent writes and rejects the stale writer without losing the winner', async () => {
      const docA = makeDoc(10);
      const docB = makeDoc(20);
      const expectHash = await currentEditHash();
      const [resA, resB] = await Promise.all([
        fetch(`${baseUrl}/api/edit`, {
          method: 'PUT',
          headers: editHeaders(expectHash),
          body: JSON.stringify(docA),
        }),
        fetch(`${baseUrl}/api/edit`, {
          method: 'PUT',
          headers: editHeaders(expectHash),
          body: JSON.stringify(docB),
        }),
      ]);
      expect([resA.status, resB.status].sort()).toEqual([200, 409]);
      const loser = resA.status === 409 ? resA : resB;
      const conflict = (await loser.json()) as { error: string; currentHash: string };
      expect(conflict.error).toBe('edit_conflict');
      expect(conflict.currentHash).toBe(await currentEditHash());

      const onDisk = JSON.parse(await readFile(editJsonPath(projectDir), 'utf8')) as EditDoc;
      expect([docA.totalDurationS, docB.totalDurationS]).toContain(onDisk.totalDurationS);

      const editRes = await fetch(`${baseUrl}/api/edit`);
      const { hash: currentHash } = (await editRes.json()) as { hash: string };
      expect(currentHash).toBe(editDocHash(onDisk));

      const historyRes = await fetch(`${baseUrl}/api/history`);
      const { entries } = (await historyRes.json()) as { entries: { hash: string }[] };
      expect(entries[0]?.hash).toBe(currentHash);
    });
  });

  describe('POST /api/jobs/render', () => {
    it('rejects non-boolean preview and unknown options', async () => {
      for (const body of [{ preview: 'false' }, { preview: false, unexpected: true }]) {
        const response = await fetch(`${baseUrl}/api/jobs/render`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(body),
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: 'invalid_render_options',
          message:
            'preview must be a boolean, deliveryDirectory must be an absolute path or null, layers must be "burn" or "omit", quality must be "recommended", "high" or "max", subtitles and reveal must be booleans, filenamePattern must be a valid filename pattern, and no other option is accepted',
        });
      }
    });

    it('keeps boolean false as a final render request', async () => {
      const response = await fetch(`${baseUrl}/api/jobs/render`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ preview: false }),
      });

      expect(response.status).toBe(200);
      expect(renderRequests.at(-1)).toBe(false);
    });

    it('rejects an invalid H.264 canvas before creating a render job', async () => {
      const path = editJsonPath(projectDir);
      const previous = await readFile(path, 'utf8');
      try {
        const invalid = {
          ...BASE_DOC,
          output: { ...BASE_DOC.output, width: 1081 },
        };
        await writeFile(path, JSON.stringify(invalid, null, 2) + '\n');

        const response = await fetch(`${baseUrl}/api/jobs/render`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ preview: false }),
        });

        expect(response.status).toBe(422);
        const body = (await response.json()) as { error: string; message: string };
        expect(body.error).toBe('invalid_edit_document');
        expect(body.message).toContain('output.width');
        expect(body.message).toContain('even for H.264');
      } finally {
        await writeFile(path, previous);
      }
    });
  });

  describe('restore round-trip', () => {
    it('PUT a new doc, restore the startup baseline, GET /api/edit reflects the restored doc', async () => {
      const docB = makeDoc(99);
      const expectHash = await currentEditHash();
      const putRes = await fetch(`${baseUrl}/api/edit`, {
        method: 'PUT',
        headers: editHeaders(expectHash),
        body: JSON.stringify(docB),
      });
      expect(putRes.status).toBe(200);

      const historyRes = await fetch(`${baseUrl}/api/history`);
      const { entries } = (await historyRes.json()) as {
        entries: { id: string; origin: string }[];
      };
      const startupEntry = entries.find((entry) => entry.origin === 'startup');
      expect(startupEntry).toBeDefined();

      const restoreRes = await fetch(`${baseUrl}/api/history/restore`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: startupEntry?.id }),
      });
      expect(restoreRes.status).toBe(200);

      const editRes = await fetch(`${baseUrl}/api/edit`);
      const { doc } = (await editRes.json()) as { doc: EditDoc };
      expect(doc.totalDurationS).toBe(BASE_DOC.totalDurationS);
    });
  });

  describe('GET /api/library', () => {
    it('returns an empty list before any item is saved', async () => {
      const res = await fetch(`${baseUrl}/api/library`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: LibraryItem[] };
      expect(body.items).toEqual([]);
    });
  });

  let savedItem: LibraryItem;

  describe('POST /api/library/save', () => {
    it('rejects a file outside edit/ with 400', async () => {
      const res = await fetch(`${baseUrl}/api/library/save`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ file: 'camera.mp4', name: 'Fora do edit', kind: 'other' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects traversal dressed up as edit/ (edit/../) with 400', async () => {
      await writeFile(join(projectDir, 'raw-footage.mp4'), 'RAW SOURCE FOOTAGE');
      const res = await fetch(`${baseUrl}/api/library/save`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ file: 'edit/../raw-footage.mp4', name: 'Roubo', kind: 'other' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects a non-finite durationS with 400 instead of corrupting the manifest', async () => {
      const res = await fetch(`${baseUrl}/api/library/save`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: '{"file":"edit/assets/lower-third.webm","name":"Inf","kind":"other","durationS":1e999}',
      });
      expect(res.status).toBe(400);
    });

    it('saves a project asset into the library with the correct hasPreview flag', async () => {
      await mkdir(join(projectDir, 'edit', 'assets'), { recursive: true });
      await writeFile(join(projectDir, 'edit', 'assets', 'lower-third.webm'), 'fake-webm-bytes');
      await writeFile(join(projectDir, 'edit', 'assets', 'lower-third.webm.png'), 'fake-png-bytes');

      const res = await fetch(`${baseUrl}/api/library/save`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          file: 'edit/assets/lower-third.webm',
          name: 'Rodapé de teste',
          kind: 'lower-third',
          durationS: 3,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { item: LibraryItem };
      expect(body.item.kind).toBe('lower-third');
      expect(body.item.file).toBe('lower-third.webm');
      expect(body.item.durationS).toBe(3);
      expect(body.item.hasPreview).toBe(true);
      savedItem = body.item;

      const listRes = await fetch(`${baseUrl}/api/library`);
      const listBody = (await listRes.json()) as { items: LibraryItem[] };
      expect(listBody.items.map((entry) => entry.id)).toContain(savedItem.id);
      expect(listBody.items.find((entry) => entry.id === savedItem.id)?.hasPreview).toBe(true);
    });
  });

  describe('GET /api/library/file/:id/*', () => {
    it('streams the saved item file', async () => {
      const res = await fetch(`${baseUrl}/api/library/file/${savedItem.id}/${savedItem.file}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('fake-webm-bytes');
    });

    it('returns 404 for a traversal id', async () => {
      // %2e stays percent-encoded through URL normalization (unlike a
      // literal ".."), so this actually reaches the server as id="..".
      const res = await fetch(`${baseUrl}/api/library/file/%2e%2e/secret.txt`);
      expect(res.status).toBe(404);
    });

    it('returns 404 for a traversal filename', async () => {
      const res = await fetch(`${baseUrl}/api/library/file/${savedItem.id}/%2e%2e`);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/library/import', () => {
    it('returns 404 for a nonexistent item', async () => {
      const res = await fetch(`${baseUrl}/api/library/import`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: 'does-not-exist-x1y2', at: 0 }),
      });
      expect(res.status).toBe(404);
    });

    it('rejects a non-finite "at" with 400', async () => {
      const res = await fetch(`${baseUrl}/api/library/import`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: savedItem.id, at: Number.POSITIVE_INFINITY }),
      });
      expect(res.status).toBe(400);
    });

    it('copies the asset into edit/assets/library and adds an overlay block', async () => {
      const res = await fetch(`${baseUrl}/api/library/import`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: savedItem.id, at: 2.344 }),
      });
      expect(res.status).toBe(200);

      const destRel = `edit/assets/library/${savedItem.id}/${savedItem.file}`;
      const destBytes = await readFile(join(projectDir, destRel), 'utf8');
      expect(destBytes).toBe('fake-webm-bytes');
      const companionBytes = await readFile(join(projectDir, `${destRel}.png`), 'utf8');
      expect(companionBytes).toBe('fake-png-bytes');

      const editRes = await fetch(`${baseUrl}/api/edit`);
      const { doc } = (await editRes.json()) as { doc: EditDoc };
      const overlayTrack = doc.tracks.find(
        (track): track is OverlayTrack => track.kind === 'overlay',
      );
      expect(overlayTrack).toBeDefined();
      const block = overlayTrack?.blocks.find((candidate) => candidate.file === destRel);
      expect(block).toMatchObject({ file: destRel, at: 2.34, duration: 3 });
    });

    it('streams a filename containing a literal "%" instead of 500', async () => {
      await writeFile(join(projectDir, 'edit', 'assets', '50%off.webm'), 'percent-bytes');
      const save = await fetch(`${baseUrl}/api/library/save`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ file: 'edit/assets/50%off.webm', name: 'Promo 50', kind: 'cta' }),
      });
      expect(save.status).toBe(200);
      const { item } = (await save.json()) as { item: LibraryItem };
      const res = await fetch(
        `${baseUrl}/api/library/file/${item.id}/${encodeURIComponent(item.file)}`,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('percent-bytes');
    });

    it('two concurrent imports both land — the read happens inside the commit chain', async () => {
      await writeFile(join(projectDir, 'edit', 'assets', 'second.webm'), 'second-bytes');
      const save = await fetch(`${baseUrl}/api/library/save`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ file: 'edit/assets/second.webm', name: 'Segundo', kind: 'other' }),
      });
      const { item: second } = (await save.json()) as { item: LibraryItem };

      const [a, b] = await Promise.all([
        fetch(`${baseUrl}/api/library/import`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ id: savedItem.id, at: 0.5 }),
        }),
        fetch(`${baseUrl}/api/library/import`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ id: second.id, at: 0.9 }),
        }),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);

      const editRes = await fetch(`${baseUrl}/api/edit`);
      const { doc } = (await editRes.json()) as { doc: EditDoc };
      const overlayTrack = doc.tracks.find(
        (track): track is OverlayTrack => track.kind === 'overlay',
      );
      const files = (overlayTrack?.blocks ?? []).map((candidate) => candidate.file);
      expect(files).toContain(`edit/assets/library/${savedItem.id}/${savedItem.file}`);
      expect(files).toContain(`edit/assets/library/${second.id}/${second.file}`);
    });
  });

  describe('parametric library items', () => {
    const PARAMETRIC_ID = 'cta-param-a1b2';
    const TEMPLATE = '<p>{{HEADLINE}}</p><span>{{PRICE}}</span>';
    const DURATION_TEMPLATE =
      '<div><p>{{HEADLINE}}</p><span>{{PRICE}}</span><i>{{DURATION_SECONDS}}</i></div>';
    const DURATION_VARIABLES = [
      { name: 'HEADLINE', label: 'Chamada', default: 'Compre agora' },
      { name: 'PRICE', default: 'R$ 99' },
      { name: 'DURATION_SECONDS', label: 'Duração', default: '3' },
    ];
    const HOLD_VARIABLES = [
      { name: 'HEADLINE', label: 'Chamada', default: 'Compre agora' },
      { name: 'HOLD_SECONDS', label: 'Tempo parado', default: '3' },
    ];

    /** Written straight into the library folder, the way an agent creates one. */
    async function writeParametricItem(
      overrides: Record<string, unknown> = {},
      options: {
        readonly itemId?: string;
        readonly withTemplate?: boolean;
        readonly templateBody?: string;
      } = {},
    ): Promise<string> {
      const itemId = options.itemId ?? PARAMETRIC_ID;
      const itemDir = join(libraryDir, itemId);
      await mkdir(itemDir, { recursive: true });
      await writeFile(join(itemDir, 'cta.webm'), 'parametric-webm-bytes');
      if (options.withTemplate !== false) {
        await writeFile(join(itemDir, 'source.html'), options.templateBody ?? TEMPLATE);
      }
      await writeFile(
        join(itemDir, 'item.json'),
        JSON.stringify({
          id: itemId,
          name: 'CTA parametrico',
          kind: 'cta',
          file: 'cta.webm',
          durationS: 3,
          createdAt: new Date().toISOString(),
          description: 'Use no fim do anuncio.',
          template: 'source.html',
          variables: [
            { name: 'HEADLINE', label: 'Chamada', default: 'Compre agora' },
            { name: 'PRICE', default: 'R$ 99' },
          ],
          ...overrides,
        }),
      );
      return itemId;
    }

    async function overlayBlocks(): Promise<OverlayTrack['blocks']> {
      const res = await fetch(`${baseUrl}/api/edit`);
      const { doc } = (await res.json()) as { doc: EditDoc };
      const track = doc.tracks.find(
        (candidate): candidate is OverlayTrack => candidate.kind === 'overlay',
      );
      return track?.blocks ?? [];
    }

    async function importParametric(
      overrides: Record<string, unknown> = {},
      options: {
        readonly itemId?: string;
        readonly withTemplate?: boolean;
        readonly templateBody?: string;
      } = {},
    ): Promise<{ trackId: string; blockIndex: number; file: string }> {
      const itemId = await writeParametricItem(overrides, options);
      const res = await fetch(`${baseUrl}/api/library/import`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: itemId, at: 1 }),
      });
      expect(res.status).toBe(200);
      const blocks = await overlayBlocks();
      const blockIndex = blocks.findLastIndex((block) => block.library?.item === itemId);
      expect(blockIndex).toBeGreaterThanOrEqual(0);
      return { trackId: 'overlays', blockIndex, file: blocks[blockIndex]!.file };
    }

    it('import copies the template under the fixed name and stamps the resolved defaults', async () => {
      const { blockIndex } = await importParametric();

      const templateBytes = await readFile(
        join(projectDir, 'edit', 'assets', 'library', PARAMETRIC_ID, 'template.html'),
        'utf8',
      );
      expect(templateBytes).toBe(TEMPLATE);

      const block = (await overlayBlocks())[blockIndex];
      expect(block?.library).toEqual({
        item: PARAMETRIC_ID,
        variables: { HEADLINE: 'Compre agora', PRICE: 'R$ 99' },
      });
    });

    it('refuses to import a parametric item whose template file is missing', async () => {
      await writeParametricItem({ template: 'gone.html' }, { withTemplate: false });
      const res = await fetch(`${baseUrl}/api/library/import`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: PARAMETRIC_ID, at: 1 }),
      });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe('library_template_missing');
    });

    // The manifest and the template are two files an agent writes separately;
    // import is the first moment the Studio can see them disagree.
    it('refuses to import when template placeholders and declared variables diverge', async () => {
      for (const variables of [
        [{ name: 'HEADLINE', default: 'só um dos dois' }],
        [
          { name: 'HEADLINE', default: 'a' },
          { name: 'PRICE', default: 'b' },
          { name: 'GHOST', default: 'declarada mas ausente' },
        ],
      ]) {
        await writeParametricItem({ variables });
        const res = await fetch(`${baseUrl}/api/library/import`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ id: PARAMETRIC_ID, at: 1 }),
        });
        expect(res.status, JSON.stringify(variables)).toBe(422);
        expect(((await res.json()) as { error: string }).error).toBe('library_template_mismatch');
      }
    });

    it('refuses to import a template that puts a placeholder where escaping breaks it', async () => {
      await writeParametricItem(
        {},
        { templateBody: '<p>{{HEADLINE}}</p><script>track("{{PRICE}}")</script>' },
      );
      const res = await fetch(`${baseUrl}/api/library/import`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: PARAMETRIC_ID, at: 1 }),
      });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe('library_template_unsafe');
    });

    it("rejects a re-bake whose variable set is not exactly the block's own", async () => {
      const target = await importParametric();
      for (const variables of [
        {},
        { HEADLINE: 'nova' },
        { HEADLINE: 'nova', PRICE: 'R$ 1', GHOST: 'x' },
      ]) {
        const res = await fetch(`${baseUrl}/api/jobs/library-overlay`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ ...target, variables }),
        });
        expect(res.status, JSON.stringify(variables)).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe('variables_mismatch');
      }
    });

    it('rejects a re-bake body with a malformed variable name', async () => {
      const target = await importParametric();
      const res = await fetch(`${baseUrl}/api/jobs/library-overlay`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...target, variables: { headline: 'nova', PRICE: 'x' } }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
    });

    it('returns 404 when the block at that index is not the one the caller saw', async () => {
      const target = await importParametric();
      const stale = await fetch(`${baseUrl}/api/jobs/library-overlay`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          ...target,
          file: 'edit/assets/library/other/gone.webm',
          variables: { HEADLINE: 'x', PRICE: 'y' },
        }),
      });
      expect(stale.status).toBe(404);
      expect(((await stale.json()) as { error: string }).error).toBe('library_block_not_found');

      const plain = await fetch(`${baseUrl}/api/jobs/library-overlay`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          trackId: target.trackId,
          blockIndex: 0,
          file: `edit/assets/library/${savedItem.id}/${savedItem.file}`,
          variables: { HEADLINE: 'x', PRICE: 'y' },
        }),
      });
      expect(plain.status).toBe(404);
      expect(((await plain.json()) as { error: string }).error).toBe('library_block_not_found');
    });

    it('leaves the document untouched when a re-bake is rejected', async () => {
      const target = await importParametric();
      const before = await currentEditHash();
      await fetch(`${baseUrl}/api/jobs/library-overlay`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...target, variables: {} }),
      });
      expect(await currentEditHash()).toBe(before);
    });

    it('re-bakes the block in place, changing only its file and variables', async () => {
      const target = await importParametric();
      const before = (await overlayBlocks())[target.blockIndex];
      const probesBefore = libraryOverlayProbePaths.length;
      const baked = `edit/assets/library/${PARAMETRIC_ID}/bake-0000feedbeef.webm`;
      renderLibraryOverlayMock.mockResolvedValue(ok(baked));

      const variables = { HEADLINE: 'Última chance', PRICE: 'R$ 49' };
      const res = await fetch(`${baseUrl}/api/jobs/library-overlay`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...target, variables }),
      });
      expect(res.status).toBe(200);

      await expect
        .poll(async () => (await overlayBlocks())[target.blockIndex]?.file, { timeout: 5000 })
        .toBe(baked);
      expect((await overlayBlocks())[target.blockIndex]).toEqual({
        ...before,
        file: baked,
        library: { item: PARAMETRIC_ID, variables },
      });
      expect(libraryOverlayProbePaths).toHaveLength(probesBefore);
    });

    it('measures a duration-parametric bake and commits that duration with its file and variables', async () => {
      const itemId = 'duration-valid-a1b2';
      const target = await importParametric(
        { variables: DURATION_VARIABLES },
        { itemId, templateBody: DURATION_TEMPLATE },
      );
      const before = (await overlayBlocks())[target.blockIndex];
      const baked = `edit/assets/library/${itemId}/bake-1111feedbeef.webm`;
      const probesBefore = libraryOverlayProbePaths.length;
      measuredLibraryOverlayDurationS = 3.267;
      renderLibraryOverlayMock.mockResolvedValueOnce(ok(baked));

      const variables = {
        HEADLINE: 'Agora vai',
        PRICE: 'R$ 39',
        DURATION_SECONDS: '3.2',
      };
      const res = await fetch(`${baseUrl}/api/jobs/library-overlay`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...target, variables }),
      });
      expect(res.status).toBe(200);

      await expect
        .poll(async () => (await overlayBlocks())[target.blockIndex]?.file, { timeout: 5000 })
        .toBe(baked);
      expect((await overlayBlocks())[target.blockIndex]).toEqual({
        ...before,
        file: baked,
        duration: 3.267,
        library: { item: itemId, variables },
      });
      expect(libraryOverlayProbePaths.slice(probesBefore)).toEqual([join(projectDir, baked)]);
    });

    it.each([
      ['not-finite', 'NaN'],
      ['below-minimum', '1.79'],
      ['above-maximum', '5.01'],
    ])('rejects an invalid DURATION_SECONDS before starting a bake: %s', async (suffix, value) => {
      const itemId = `duration-${suffix}-a1b2`;
      const target = await importParametric(
        { variables: DURATION_VARIABLES },
        { itemId, templateBody: DURATION_TEMPLATE },
      );
      const editHashBefore = await currentEditHash();
      const rendersBefore = renderLibraryOverlayMock.mock.calls.length;
      const probesBefore = libraryOverlayProbePaths.length;

      const res = await fetch(`${baseUrl}/api/jobs/library-overlay`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          ...target,
          variables: { HEADLINE: 'Inválida', PRICE: 'R$ 0', DURATION_SECONDS: value },
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('timing_out_of_range');
      expect(body.message).toContain('DURATION_SECONDS');
      expect(body.message).toContain('1.8');
      expect(body.message).toContain('5');
      expect(renderLibraryOverlayMock).toHaveBeenCalledTimes(rendersBefore);
      expect(libraryOverlayProbePaths).toHaveLength(probesBefore);
      expect(await currentEditHash()).toBe(editHashBefore);
    });

    it('accepts HOLD_SECONDS and synchronizes the measured animation duration', async () => {
      const itemId = 'hold-valid-a1b2';
      const target = await importParametric(
        { variables: HOLD_VARIABLES },
        { itemId, templateBody: '<p>{{HEADLINE}}</p><i>{{HOLD_SECONDS}}</i>' },
      );
      const before = (await overlayBlocks())[target.blockIndex];
      const baked = `edit/assets/library/${itemId}/bake-holdfeedbeef.webm`;
      measuredLibraryOverlayDurationS = 4.267;
      renderLibraryOverlayMock.mockResolvedValueOnce(ok(baked));

      const variables = { HEADLINE: 'Pergunta', HOLD_SECONDS: '3' };
      const res = await fetch(`${baseUrl}/api/jobs/library-overlay`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...target, variables }),
      });
      expect(res.status).toBe(200);

      await expect
        .poll(async () => (await overlayBlocks())[target.blockIndex]?.file, { timeout: 5000 })
        .toBe(baked);
      expect((await overlayBlocks())[target.blockIndex]).toEqual({
        ...before,
        file: baked,
        duration: 4.267,
        library: { item: itemId, variables },
      });
    });

    it.each([
      ['below-minimum', '0.79'],
      ['above-maximum', '8.01'],
    ])('rejects an invalid HOLD_SECONDS before starting a bake: %s', async (suffix, value) => {
      const itemId = `hold-${suffix}-a1b2`;
      const target = await importParametric(
        { variables: HOLD_VARIABLES },
        { itemId, templateBody: '<p>{{HEADLINE}}</p><i>{{HOLD_SECONDS}}</i>' },
      );
      const rendersBefore = renderLibraryOverlayMock.mock.calls.length;
      const res = await fetch(`${baseUrl}/api/jobs/library-overlay`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          ...target,
          variables: { HEADLINE: 'Inválida', HOLD_SECONDS: value },
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('timing_out_of_range');
      expect(body.message).toContain('HOLD_SECONDS');
      expect(body.message).toContain('0.8');
      expect(body.message).toContain('8');
      expect(renderLibraryOverlayMock).toHaveBeenCalledTimes(rendersBefore);
    });

    // A bake runs for minutes; deleting or adding an element meanwhile shifts
    // every index. The block's content-addressed file re-locates it when it is
    // unique — the strict index+file failure stays for ambiguous cases.
    it('re-locates the edited block by its unique file when its index shifts mid-render', async () => {
      const target = await importParametric();

      // First bake gives the block a file no other block shares.
      const uniqueFile = `edit/assets/library/${PARAMETRIC_ID}/bake-0000aaaa1111.webm`;
      renderLibraryOverlayMock.mockResolvedValueOnce(ok(uniqueFile));
      const first = await fetch(`${baseUrl}/api/jobs/library-overlay`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...target, variables: { HEADLINE: 'Base', PRICE: 'R$ 9' } }),
      });
      expect(first.status).toBe(200);
      await expect
        .poll(async () => (await overlayBlocks())[target.blockIndex]?.file, { timeout: 5000 })
        .toBe(uniqueFile);

      // A second library block with a DIFFERENT file on the same track: the
      // relocation must key on the file, not on "any library block".
      const bystanderImport = await fetch(`${baseUrl}/api/library/import`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: PARAMETRIC_ID, at: 9 }),
      });
      expect(bystanderImport.status).toBe(200);
      const bystanderIndex = (await overlayBlocks()).findLastIndex(
        (block) => block.library?.item === PARAMETRIC_ID && block.at === 9,
      );
      const bystanderFile = `edit/assets/library/${PARAMETRIC_ID}/bake-0000ffff9999.webm`;
      renderLibraryOverlayMock.mockResolvedValueOnce(ok(bystanderFile));
      const bystanderBake = await fetch(`${baseUrl}/api/jobs/library-overlay`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          trackId: target.trackId,
          blockIndex: bystanderIndex,
          file: (await overlayBlocks())[bystanderIndex]?.file,
          at: 9,
          variables: { HEADLINE: 'Vizinha', PRICE: 'R$ 3' },
        }),
      });
      expect(bystanderBake.status).toBe(200);
      await expect
        .poll(async () => (await overlayBlocks())[bystanderIndex]?.file, { timeout: 5000 })
        .toBe(bystanderFile);

      // Second bake: mid-render, a new element lands at the FRONT of the
      // track, shifting the target from blockIndex to blockIndex + 1.
      await writeFile(join(projectDir, 'edit', 'assets', 'decoy.webm'), 'decoy-bytes');
      const baked = `edit/assets/library/${PARAMETRIC_ID}/bake-0000bbbb2222.webm`;
      renderLibraryOverlayMock.mockImplementationOnce(async () => {
        const editRes = await fetch(`${baseUrl}/api/edit`);
        const { doc, hash } = (await editRes.json()) as { doc: EditDoc; hash: string };
        const tracks = doc.tracks.map((track) =>
          track.kind === 'overlay' && track.id === target.trackId
            ? {
                ...track,
                blocks: [{ file: 'edit/assets/decoy.webm', at: 0, duration: 1 }, ...track.blocks],
              }
            : track,
        );
        const putRes = await fetch(`${baseUrl}/api/edit`, {
          method: 'PUT',
          headers: editHeaders(hash),
          body: JSON.stringify({ ...doc, tracks }),
        });
        expect(putRes.status).toBe(200);
        return ok(baked);
      });

      const variables = { HEADLINE: 'Movida', PRICE: 'R$ 2' };
      const res = await fetch(`${baseUrl}/api/jobs/library-overlay`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          trackId: target.trackId,
          blockIndex: target.blockIndex,
          file: uniqueFile,
          variables,
        }),
      });
      expect(res.status).toBe(200);

      await expect
        .poll(async () => (await overlayBlocks())[target.blockIndex + 1]?.file, { timeout: 5000 })
        .toBe(baked);
      const blocks = await overlayBlocks();
      expect(blocks[0]?.file).toBe('edit/assets/decoy.webm');
      expect(blocks[target.blockIndex + 1]?.library).toEqual({
        item: PARAMETRIC_ID,
        variables,
      });
    });

    /**
     * Subscribes to /api/events, fires `post` only after the connection's
     * synchronous jobs-snapshot frame (so no terminal event can slip into the
     * connection gap), and resolves on the bake job's terminal event.
     */
    async function bakeTerminalOf(
      post: () => Promise<Response>,
    ): Promise<{ state: string; error?: string }> {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, 8000);
      try {
        const res = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
        if (res.body === null) throw new Error('SSE stream has no body');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let posted = false;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) throw new Error('SSE stream ended without a terminal bake event');
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data: ')) continue;
              const event = JSON.parse(line.slice(6)) as {
                kind?: string;
                type?: string;
                state?: string;
                error?: string;
              };
              if (event.kind === 'jobs-snapshot' && !posted) {
                posted = true;
                const response = await post();
                expect(response.status).toBe(200);
              }
              if (
                event.kind === 'job' &&
                event.type === 'library-overlay' &&
                (event.state === 'done' || event.state === 'error')
              ) {
                return {
                  state: event.state,
                  ...(event.error !== undefined ? { error: event.error } : {}),
                };
              }
            }
          }
        }
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    }

    it('preserves variables changed by another edit while the bake is rendering', async () => {
      const target = await importParametric();
      const before = (await overlayBlocks())[target.blockIndex];
      expect(before?.library).toBeDefined();
      const concurrentVariables = { HEADLINE: 'Edição concorrente', PRICE: 'R$ 77' };
      const baked = `edit/assets/library/${PARAMETRIC_ID}/bake-concurrent9999.webm`;

      renderLibraryOverlayMock.mockImplementationOnce(async () => {
        const editRes = await fetch(`${baseUrl}/api/edit`);
        const { doc, hash } = (await editRes.json()) as { doc: EditDoc; hash: string };
        const tracks = doc.tracks.map((track) =>
          track.kind === 'overlay' && track.id === target.trackId
            ? {
                ...track,
                blocks: track.blocks.map((block, index) =>
                  index === target.blockIndex && block.library !== undefined
                    ? {
                        ...block,
                        library: { ...block.library, variables: concurrentVariables },
                      }
                    : block,
                ),
              }
            : track,
        );
        const putRes = await fetch(`${baseUrl}/api/edit`, {
          method: 'PUT',
          headers: editHeaders(hash),
          body: JSON.stringify({ ...doc, tracks }),
        });
        expect(putRes.status).toBe(200);
        return ok(baked);
      });

      const terminal = await bakeTerminalOf(() =>
        fetch(`${baseUrl}/api/jobs/library-overlay`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            ...target,
            at: before?.at,
            variables: { HEADLINE: 'Bake atrasado', PRICE: 'R$ 1' },
          }),
        }),
      );

      expect(terminal.state).toBe('error');
      expect(terminal.error).toContain('variables changed while the piece was rendering');
      expect((await overlayBlocks())[target.blockIndex]).toEqual({
        ...before,
        library: { item: PARAMETRIC_ID, variables: concurrentVariables },
      });
    });

    /**
     * Two blocks of the same import sharing one baked file — twins. The
     * digest must be unique PER TEST: a literal shared across tests leaks
     * same-file blocks through the shared project and lets a refusal pass
     * for the wrong reason (ambiguity from leakage instead of the scenario).
     */
    async function bakeTwins(
      digest: string,
      secondAt: number,
    ): Promise<{
      trackId: string;
      sharedFile: string;
      firstIndex: number;
      secondIndex: number;
      variables: Record<string, string>;
    }> {
      const first = await importParametric();
      const importRes = await fetch(`${baseUrl}/api/library/import`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: PARAMETRIC_ID, at: secondAt }),
      });
      expect(importRes.status).toBe(200);
      // Import appends to the first overlay track (index.ts library import).
      const blocksAfterImport = await overlayBlocks();
      const secondIndex = blocksAfterImport.length - 1;
      expect(blocksAfterImport[secondIndex]).toMatchObject({
        at: secondAt,
        library: { item: PARAMETRIC_ID },
      });
      expect(secondIndex).toBeGreaterThan(first.blockIndex);

      // Same values → same digest: both twins end on ONE shared baked file.
      const sharedFile = `edit/assets/library/${PARAMETRIC_ID}/bake-${digest}.webm`;
      const variables = { HEADLINE: 'Gêmeas', PRICE: 'R$ 7' };
      for (const twin of [
        { blockIndex: first.blockIndex, at: 1 },
        { blockIndex: secondIndex, at: secondAt },
      ]) {
        renderLibraryOverlayMock.mockResolvedValueOnce(ok(sharedFile));
        const res = await fetch(`${baseUrl}/api/jobs/library-overlay`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            trackId: first.trackId,
            blockIndex: twin.blockIndex,
            file: (await overlayBlocks())[twin.blockIndex]?.file,
            at: twin.at,
            variables,
          }),
        });
        expect(res.status).toBe(200);
        await expect
          .poll(async () => (await overlayBlocks())[twin.blockIndex]?.file, { timeout: 5000 })
          .toBe(sharedFile);
      }
      return {
        trackId: first.trackId,
        sharedFile,
        firstIndex: first.blockIndex,
        secondIndex,
        variables,
      };
    }

    // The ambiguity refusal IS the safety guard of the fallback: twins at the
    // SAME position (same import placed twice at one playhead) share file AND
    // `at`, so nothing can tell them apart after a shift — the bake must fail
    // rather than "pick the first match" and rewrite one of them.
    it('refuses the bake when the shifted block is a twin — both stay untouched', async () => {
      const twins = await bakeTwins('0000cccc3333', 1);

      await writeFile(join(projectDir, 'edit', 'assets', 'decoy.webm'), 'decoy-bytes');
      renderLibraryOverlayMock.mockImplementationOnce(async () => {
        const editRes = await fetch(`${baseUrl}/api/edit`);
        const { doc, hash } = (await editRes.json()) as { doc: EditDoc; hash: string };
        const tracks = doc.tracks.map((track) =>
          track.kind === 'overlay' && track.id === twins.trackId
            ? {
                ...track,
                blocks: [{ file: 'edit/assets/decoy.webm', at: 0, duration: 1 }, ...track.blocks],
              }
            : track,
        );
        const putRes = await fetch(`${baseUrl}/api/edit`, {
          method: 'PUT',
          headers: editHeaders(hash),
          body: JSON.stringify({ ...doc, tracks }),
        });
        expect(putRes.status).toBe(200);
        return ok(`edit/assets/library/${PARAMETRIC_ID}/bake-0000dddd4444.webm`);
      });

      const terminal = await bakeTerminalOf(() =>
        fetch(`${baseUrl}/api/jobs/library-overlay`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            trackId: twins.trackId,
            blockIndex: twins.firstIndex,
            file: twins.sharedFile,
            at: 1,
            variables: { HEADLINE: 'Não aplica', PRICE: 'R$ 0' },
          }),
        }),
      );
      expect(terminal.state).toBe('error');

      const blocks = await overlayBlocks();
      for (const index of [twins.firstIndex + 1, twins.secondIndex + 1]) {
        expect(blocks[index]).toMatchObject({
          file: twins.sharedFile,
          library: { item: PARAMETRIC_ID, variables: twins.variables },
        });
      }
    });

    // Without `at` in BOTH identity paths, deleting the edited twin
    // mid-render leaves one same-file survivor at another position — and the
    // fallback would silently hand it the bake ("lone survivor retarget").
    it('does not retarget the surviving twin at another position when the edited one is deleted', async () => {
      const twins = await bakeTwins('0000abab6666', 5);

      // Mid-render, the FIRST twin (the one being edited) is deleted and the
      // survivor is placed EXACTLY at the stale index — same file, `at: 5`
      // instead of `at: 1`. This is the strongest identity attack: it defeats
      // a file-only exact match AND a file-only fallback in one move.
      renderLibraryOverlayMock.mockImplementationOnce(async () => {
        const editRes = await fetch(`${baseUrl}/api/edit`);
        const { doc, hash } = (await editRes.json()) as { doc: EditDoc; hash: string };
        const tracks = doc.tracks.map((track) => {
          if (track.kind !== 'overlay' || track.id !== twins.trackId) return track;
          const survivor = track.blocks.find(
            (block) => block.file === twins.sharedFile && block.at === 5,
          );
          expect(survivor).toBeDefined();
          if (survivor === undefined) return track;
          const rest = track.blocks.filter((block) => block.file !== twins.sharedFile);
          return {
            ...track,
            blocks: [...rest.slice(0, twins.firstIndex), survivor, ...rest.slice(twins.firstIndex)],
          };
        });
        const putRes = await fetch(`${baseUrl}/api/edit`, {
          method: 'PUT',
          headers: editHeaders(hash),
          body: JSON.stringify({ ...doc, tracks }),
        });
        expect(putRes.status).toBe(200);
        return ok(`edit/assets/library/${PARAMETRIC_ID}/bake-0000eeee5555.webm`);
      });

      const terminal = await bakeTerminalOf(() =>
        fetch(`${baseUrl}/api/jobs/library-overlay`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            trackId: twins.trackId,
            blockIndex: twins.firstIndex,
            file: twins.sharedFile,
            at: 1,
            variables: { HEADLINE: 'Não retarget', PRICE: 'R$ 0' },
          }),
        }),
      );
      expect(terminal.state).toBe('error');

      // Exactly one survivor with the shared file — untouched, still at 5.
      const survivors = (await overlayBlocks()).filter((block) => block.file === twins.sharedFile);
      expect(survivors).toHaveLength(1);
      expect(survivors[0]).toMatchObject({
        at: 5,
        library: { item: PARAMETRIC_ID, variables: twins.variables },
      });
    });

    // The schema does not forbid two overlay tracks sharing an id; a rewrite
    // keyed on the id alone would edit `blocks[blockIndex]` in both.
    it('leaves a same-id sibling track untouched when re-baking', async () => {
      const target = await importParametric();
      await writeFile(join(projectDir, 'edit', 'assets', 'decoy.webm'), 'decoy-bytes');
      const decoy = { file: 'edit/assets/decoy.webm', at: 0, duration: 2 };

      // The sibling must be as long as the target index: a rewrite keyed on
      // the id edits `blocks[blockIndex]` in every same-id track, so a shorter
      // sibling would make this test pass with the bug present.
      const siblingBlocks = Array.from({ length: target.blockIndex + 1 }, () => decoy);
      const editRes = await fetch(`${baseUrl}/api/edit`);
      const { doc, hash } = (await editRes.json()) as { doc: EditDoc; hash: string };
      const withSibling = {
        ...doc,
        tracks: [
          ...doc.tracks,
          { id: target.trackId, kind: 'overlay' as const, blocks: siblingBlocks },
        ],
      };
      const putRes = await fetch(`${baseUrl}/api/edit`, {
        method: 'PUT',
        headers: editHeaders(hash),
        body: JSON.stringify(withSibling),
      });
      expect(putRes.status).toBe(200);

      const baked = `edit/assets/library/${PARAMETRIC_ID}/bake-0000deadbeef.webm`;
      renderLibraryOverlayMock.mockResolvedValue(ok(baked));
      const res = await fetch(`${baseUrl}/api/jobs/library-overlay`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...target, variables: { HEADLINE: 'Outra', PRICE: 'R$ 1' } }),
      });
      expect(res.status).toBe(200);
      await expect
        .poll(async () => (await overlayBlocks())[target.blockIndex]?.file, { timeout: 5000 })
        .toBe(baked);

      const after = await fetch(`${baseUrl}/api/edit`);
      const { doc: finalDoc } = (await after.json()) as { doc: EditDoc };
      const siblings = finalDoc.tracks.filter(
        (track): track is OverlayTrack => track.kind === 'overlay' && track.id === target.trackId,
      );
      expect(siblings).toHaveLength(2);
      expect(siblings[1]?.blocks).toEqual(siblingBlocks);
    });
  });

  describe('DELETE /api/library/:id', () => {
    it('returns 404 for a traversal id without touching anything', async () => {
      const res = await fetch(`${baseUrl}/api/library/%2e%2e`, { method: 'DELETE' });
      expect(res.status).toBe(404);
    });

    // root ignores directory modes, so the EACCES these two tests rely on never fires there
    it.skipIf(cannotDenyWrites)(
      'shapes an rm failure as a pathless 500 instead of leaking the library path',
      async () => {
        const lockedId = 'trancado-a1b2';
        const lockedDir = join(libraryDir, lockedId);
        await mkdir(lockedDir, { recursive: true });
        await writeFile(join(lockedDir, 'item.json'), '{}');
        // no write bit on the folder → rm of its contents fails with EACCES
        await chmod(lockedDir, 0o555);
        try {
          const res = await fetch(`${baseUrl}/api/library/${lockedId}`, { method: 'DELETE' });
          expect(res.status).toBe(500);
          const text = await res.text();
          expect(text).not.toContain(libraryDir);
          expect(JSON.parse(text)).toEqual({ error: 'internal_error', message: 'internal error' });
        } finally {
          await chmod(lockedDir, 0o755);
          await rm(lockedDir, { recursive: true, force: true });
        }
      },
    );

    it('removes the item, keeps project copies intact, then 404s on repeat', async () => {
      const projectCopy = join(
        projectDir,
        'edit',
        'assets',
        'library',
        savedItem.id,
        savedItem.file,
      );
      expect(existsSync(projectCopy)).toBe(true);

      const res = await fetch(`${baseUrl}/api/library/${savedItem.id}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect((await res.json()) as { removed: boolean }).toEqual({ removed: true });

      const listRes = await fetch(`${baseUrl}/api/library`);
      const listBody = (await listRes.json()) as { items: LibraryItem[] };
      expect(listBody.items.map((entry) => entry.id)).not.toContain(savedItem.id);

      expect(existsSync(projectCopy)).toBe(true);

      const again = await fetch(`${baseUrl}/api/library/${savedItem.id}`, { method: 'DELETE' });
      expect(again.status).toBe(404);
    });
  });

  interface SettingsResponse {
    elevenLabs: {
      present: boolean;
      source: 'env' | 'config' | null;
      maskedTail: string | null;
      configured: boolean;
    };
  }

  describe('framework errors', () => {
    it('answers a URL that is not valid percent-encoding with 400 invalid_request without echoing it', async () => {
      const res = await fetch(`${baseUrl}/api/media/50%desconto.mp4`);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).not.toContain('desconto');
      expect(JSON.parse(text)).toEqual({
        error: 'invalid_request',
        message: 'the request could not be parsed',
      });
    });
  });

  describe('GET /api/settings', () => {
    it('reports no key present before anything is configured', async () => {
      const res = await fetch(`${baseUrl}/api/settings`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as SettingsResponse;
      expect(body.elevenLabs).toEqual({
        present: false,
        source: null,
        maskedTail: null,
        configured: false,
      });
    });
  });

  describe('POST /api/settings', () => {
    it('saves a valid key, GET reflects it, and the full key never appears in either response body', async () => {
      const key = 'sk-testkey1234567890';
      const postRes = await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ elevenLabsApiKey: key }),
      });
      expect(postRes.status).toBe(200);
      const postText = await postRes.text();
      expect(postText).not.toContain(key);
      const postBody = JSON.parse(postText) as SettingsResponse;
      expect(postBody.elevenLabs).toEqual({
        present: true,
        source: 'config',
        maskedTail: `…${key.slice(-4)}`,
        configured: true,
      });

      const getRes = await fetch(`${baseUrl}/api/settings`);
      const getText = await getRes.text();
      expect(getText).not.toContain(key);
      const getBody = JSON.parse(getText) as SettingsResponse;
      expect(getBody.elevenLabs).toEqual({
        present: true,
        source: 'config',
        maskedTail: `…${key.slice(-4)}`,
        configured: true,
      });
    });

    it('clears a previously saved key when posting null', async () => {
      await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ elevenLabsApiKey: 'sk-toclear12345' }),
      });

      const clearRes = await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ elevenLabsApiKey: null }),
      });
      expect(clearRes.status).toBe(200);
      const body = (await clearRes.json()) as SettingsResponse;
      expect(body.elevenLabs).toEqual({
        present: false,
        source: null,
        maskedTail: null,
        configured: false,
      });

      const getRes = await fetch(`${baseUrl}/api/settings`);
      const getBody = (await getRes.json()) as SettingsResponse;
      expect(getBody.elevenLabs.present).toBe(false);
    });

    it('rejects a malformed key with 400 and never echoes the sent value', async () => {
      const badKey = 'bad key with spaces';
      const res = await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ elevenLabsApiKey: badKey }),
      });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).not.toContain(badKey);
      const body = JSON.parse(text) as { error: string; message: string };
      expect(body.error).toBe('invalid_api_key');
      expect(body.message).toMatch(/elevenLabsApiKey/);
    });

    it('rejects a too-short key with 400', async () => {
      const res = await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ elevenLabsApiKey: 'short1' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects a non-string elevenLabsApiKey with 400 invalid_api_key', async () => {
      const res = await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ elevenLabsApiKey: 12345678 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('invalid_api_key');
    });

    it.each([
      ['a string', '"sk-looks-like-a-key"'],
      ['a number', '42'],
      ['null', 'null'],
      ['an array', '[{"elevenLabsApiKey":"sk-inside-array1"}]'],
    ])(
      'rejects %s as the body with 400 invalid_body instead of ignoring it',
      async (_label, raw) => {
        const res = await fetch(`${baseUrl}/api/settings`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: raw,
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string; message: string };
        expect(body.error).toBe('invalid_body');
        expect(body.message).toBe('request body must be a JSON object');
      },
    );

    it('rejects a request without a body with 400 invalid_body', async () => {
      const res = await fetch(`${baseUrl}/api/settings`, { method: 'POST' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('invalid_body');
    });

    it('never echoes the key from a truncated JSON body', async () => {
      const marker = 'sk-truncated-marker-1';
      const res = await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: `{"elevenLabsApiKey": "${marker}`,
      });
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain(marker);
    });

    it.skipIf(cannotDenyWrites)(
      'shapes a config write failure as a pathless 500 instead of leaking the config path',
      async () => {
        const key = 'sk-unwritable-12345';
        await mkdir(configDir, { recursive: true });
        const originalMode = (await stat(configDir)).mode & 0o777;
        // no write bit on the folder → the tmp file cannot be created
        await chmod(configDir, 0o555);
        try {
          const res = await fetch(`${baseUrl}/api/settings`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ elevenLabsApiKey: key }),
          });
          expect(res.status).toBe(500);
          const text = await res.text();
          expect(text).not.toContain(configDir);
          expect(text).not.toContain(key);
          expect(JSON.parse(text)).toEqual({ error: 'internal_error', message: 'internal error' });
        } finally {
          await chmod(configDir, originalMode);
        }
      },
    );

    it('leaves the key untouched on an empty object and ignores unknown fields', async () => {
      const key = 'sk-keepme-1234567';
      await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ elevenLabsApiKey: key, unknownField: true }),
      });

      const res = await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as SettingsResponse;
      expect(body.elevenLabs).toEqual({
        present: true,
        source: 'config',
        maskedTail: `…${key.slice(-4)}`,
        configured: true,
      });
    });

    it('clears a saved key when posting an empty string', async () => {
      await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ elevenLabsApiKey: 'sk-toclear12345' }),
      });

      const res = await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ elevenLabsApiKey: '' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as SettingsResponse;
      expect(body.elevenLabs.configured).toBe(false);
      expect(body.elevenLabs.present).toBe(false);
    });

    it('never round-trips a short env key whole through maskedTail', async () => {
      const previous = process.env.ELEVENLABS_API_KEY;
      process.env.ELEVENLABS_API_KEY = 'abc';
      try {
        const res = await fetch(`${baseUrl}/api/settings`);
        const text = await res.text();
        expect(text).not.toContain('abc');
        const body = JSON.parse(text) as SettingsResponse;
        expect(body.elevenLabs.present).toBe(true);
        expect(body.elevenLabs.maskedTail).toBeNull();
      } finally {
        if (previous === undefined) delete process.env.ELEVENLABS_API_KEY;
        else process.env.ELEVENLABS_API_KEY = previous;
      }
    });

    it('prefers ELEVENLABS_API_KEY from the environment over a saved config key', async () => {
      await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ elevenLabsApiKey: 'sk-configvalue1' }),
      });

      const previous = process.env.ELEVENLABS_API_KEY;
      process.env.ELEVENLABS_API_KEY = 'env-wins-1234';
      try {
        const res = await fetch(`${baseUrl}/api/settings`);
        const body = (await res.json()) as SettingsResponse;
        expect(body.elevenLabs.present).toBe(true);
        expect(body.elevenLabs.source).toBe('env');
      } finally {
        if (previous === undefined) delete process.env.ELEVENLABS_API_KEY;
        else process.env.ELEVENLABS_API_KEY = previous;
      }
    });
  });
});

/**
 * Behaviors the route extraction must preserve — pinned before any handler
 * leaves `startServer`. Each test fails when the corresponding mechanism
 * (watcher self-echo suppression, root-level range streaming, the project
 * payload contract, `onClose` teardown) is broken.
 */
describe('characterization for the route extraction', { concurrent: false }, () => {
  interface EventFrame {
    readonly kind: string;
    readonly hash?: string;
    readonly external?: boolean;
  }

  /**
   * Subscribes to /api/events, runs `trigger` only after the connection's
   * synchronous jobs-snapshot frame, and resolves on the first later event
   * that `matches` accepts. The watcher debounces writes (awaitWriteFinish
   * 250 ms), so the budget is generous but bounded.
   */
  async function eventAfter(
    trigger: () => Promise<void>,
    matches: (event: EventFrame) => boolean,
  ): Promise<EventFrame> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, 8000);
    try {
      const res = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      if (res.body === null) throw new Error('SSE stream has no body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let triggered = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE stream ended before the expected event');
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const event = JSON.parse(line.slice(6)) as EventFrame;
            if (event.kind === 'jobs-snapshot' && !triggered) {
              triggered = true;
              await trigger();
              continue;
            }
            if (triggered && matches(event)) return event;
          }
        }
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async function historyHasAgentEntry(hash: string): Promise<boolean> {
    const deadline = Date.now() + 3000;
    for (;;) {
      const res = await fetch(`${baseUrl}/api/history`);
      const body = (await res.json()) as { entries: { origin: string; hash: string }[] };
      if (body.entries.some((entry) => entry.origin === 'agent' && entry.hash === hash)) {
        return true;
      }
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  describe('GET /api/events + edit.json watcher', () => {
    it('closes the project while an editor SSE connection is still open', async () => {
      const closingServer = await startServer(projectDir);
      const abort = new AbortController();
      let close;
      let deadline;
      try {
        const response = await fetch(`${closingServer.address}/api/events`, {
          signal: abort.signal,
        });
        const reader = response.body!.getReader();
        expect((await reader.read()).done).toBe(false);
        close = closingServer.close();
        await Promise.race([
          close,
          new Promise((_, reject) => {
            deadline = setTimeout(() => {
              reject(new Error('Server waited for the editor to disconnect'));
            }, 1500);
          }),
        ]);
      } finally {
        clearTimeout(deadline);
        abort.abort();
        await (close ?? closingServer.close());
      }
    });

    it('reports an external edit.json write as external and records it as an agent edit', async () => {
      let expected = '';
      const event = await eventAfter(
        async () => {
          await writeFile(editJsonPath(projectDir), JSON.stringify(makeDoc(7), null, 2) + '\n');
          expected = await currentEditHash();
        },
        (candidate) => candidate.kind === 'edit-changed' && candidate.hash === expected,
      );

      expect(event.external).toBe(true);
      expect(await historyHasAgentEntry(expected)).toBe(true);
    });

    it('reports a write made through PUT /api/edit as not external — the server recognises its own hash', async () => {
      let expected = '';
      const event = await eventAfter(
        async () => {
          const response = await fetch(`${baseUrl}/api/edit`, {
            method: 'PUT',
            headers: editHeaders(await currentEditHash()),
            body: JSON.stringify(makeDoc(9)),
          });
          expect(response.status).toBe(200);
          expected = ((await response.json()) as { hash: string }).hash;
        },
        (candidate) => candidate.kind === 'edit-changed' && candidate.hash === expected,
      );

      expect(event.external).toBe(false);
    });

    it('announces an audio receipt written outside the server by an agent', async () => {
      const cacheDir = join(projectDir, 'edit', 'cache');
      await mkdir(cacheDir, { recursive: true });
      const receipt = join(cacheDir, 'audio-preview.inputs.json');
      const event = await eventAfter(
        () => writeFile(receipt, JSON.stringify({ test: 'CLI commit marker' })),
        (candidate) => candidate.kind === 'artifacts-changed',
      );
      expect(event.kind).toBe('artifacts-changed');
    });

    it('broadcasts assets-changed when a file lands under edit/assets', async () => {
      const assetsDir = join(projectDir, 'edit', 'assets');
      const assetPath = join(assetsDir, 'watcher-proof.txt');
      await mkdir(assetsDir, { recursive: true });
      try {
        const event = await eventAfter(
          () => writeFile(assetPath, 'asset'),
          (candidate) => candidate.kind === 'assets-changed',
        );
        expect(event.kind).toBe('assets-changed');
      } finally {
        await rm(assetPath, { force: true });
      }
    });
  });

  describe('GET /api/media/* explicit byte ranges', () => {
    beforeAll(async () => {
      await writeFile(join(projectDir, 'edit', 'range-proof.m4a'), '0123456789');
    });

    it('serves a closed range with 206, content-range and the exact byte count', async () => {
      const response = await fetch(`${baseUrl}/api/media/edit%2Frange-proof.m4a`, {
        headers: { range: 'bytes=2-5' },
      });

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
      expect(response.headers.get('content-length')).toBe('4');
      expect(response.headers.get('accept-ranges')).toBe('bytes');
      expect(await response.text()).toBe('2345');
    });

    it('serves an open-ended range up to the last byte', async () => {
      const response = await fetch(`${baseUrl}/api/media/edit%2Frange-proof.m4a`, {
        headers: { range: 'bytes=8-' },
      });

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe('bytes 8-9/10');
      expect(await response.text()).toBe('89');
    });

    it('serves the whole file and advertises ranges when none is requested', async () => {
      const response = await fetch(`${baseUrl}/api/media/edit%2Frange-proof.m4a`);

      expect(response.status).toBe(200);
      expect(response.headers.get('accept-ranges')).toBe('bytes');
      expect(response.headers.get('content-length')).toBe('10');
      expect(await response.text()).toBe('0123456789');
    });
  });

  describe('GET /api/project payload', () => {
    it('exposes exactly the fields the editor boots from', async () => {
      const res = await fetch(`${baseUrl}/api/project`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;

      expect(Object.keys(body).sort()).toEqual([
        'agents',
        'apiKeyPresent',
        'audioPreviewCurrent',
        'audioPreviewEditHash',
        'doc',
        'editHash',
        'ffmpeg',
        'hasAudioComparison',
        'hasAudioPreview',
        'hasFinal',
        'hasPreview',
        'hasProgram',
        'images',
        'media',
        'previewEditHash',
        'programKey',
        'projectDir',
        'warnings',
      ]);
      expect(body.projectDir).toBe(projectDir);
      expect(body.editHash).toBe(await currentEditHash());
      expect(Array.isArray(body.media)).toBe(true);
      expect(Array.isArray(body.images)).toBe(true);
      expect(Array.isArray(body.warnings)).toBe(true);
      const agents = body.agents as { claude: unknown; codex: unknown };
      expect(typeof agents.claude).toBe('boolean');
      expect(typeof agents.codex).toBe('boolean');
      const ffmpeg = body.ffmpeg as { ok: unknown; message: unknown };
      expect(typeof ffmpeg.ok).toBe('boolean');
      expect(typeof ffmpeg.message).toBe('string');
    });
  });

  describe('close()', () => {
    it('shuts the listener down: the port stops answering and close() resolves', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'leadzy-server-close-'));
      await mkdir(join(dir, 'edit'), { recursive: true });
      await writeFile(editJsonPath(dir), JSON.stringify(BASE_DOC, null, 2) + '\n');
      const second = await startServer(dir);
      try {
        expect((await fetch(`${second.address}/api/edit`)).status).toBe(200);

        await second.close();

        await expect(fetch(`${second.address}/api/edit`)).rejects.toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 20_000);
  });
});
