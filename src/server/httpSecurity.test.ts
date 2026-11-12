import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EditDoc } from '../core/schema.js';
import { isAllowedLocalApiRequest, startServer, type StartedServer } from './index.js';
import { editJsonPath } from './services/project.js';

const BASE_DOC: EditDoc = {
  version: 2,
  fps: 25,
  output: { width: 1080, height: 1920, loudnormLufs: -14 },
  sources: { camera: { path: 'camera.mp4' } },
  tracks: [
    {
      id: 'base',
      kind: 'video',
      blocks: [{ source: 'camera', in: 0, out: 1 }],
    },
  ],
  subtitles: { enabled: false, preset: '2p-caps' },
  totalDurationS: 1,
};

function rawGet(
  url: string,
  headers: Readonly<Record<string, string>>,
): Promise<{ readonly body: string; readonly status: number }> {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          body: Buffer.concat(chunks).toString('utf8'),
          status: response.statusCode ?? 0,
        });
      });
    });
    request.on('error', reject);
  });
}

describe('isAllowedLocalApiRequest', () => {
  it.each([
    ['127.0.0.1:52740', undefined],
    ['localhost:52740', 'http://localhost:52740'],
    ['[::1]:52740', 'http://[::1]:52740'],
    ['127.0.0.2:52740', 'http://127.0.0.2:52740'],
  ])('accepts a loopback Host with an absent or matching Origin', (host, origin) => {
    expect(isAllowedLocalApiRequest(host, origin)).toBe(true);
  });

  it.each([
    [undefined, undefined],
    ['studio.example:52740', undefined],
    ['localhost.evil.example:52740', undefined],
    ['127.0.0.1.evil.example:52740', undefined],
    ['127.0.0.1:52740', 'https://attacker.example'],
    ['127.0.0.1:52740', 'http://127.0.0.1:52741'],
    ['127.0.0.1:52740', 'http://localhost:52740'],
    ['127.0.0.1:52740', 'null'],
  ])('rejects a non-local or cross-origin authority', (host, origin) => {
    expect(isAllowedLocalApiRequest(host, origin)).toBe(false);
  });

  it('rejects an explicitly cross-site browser request', () => {
    expect(
      isAllowedLocalApiRequest('127.0.0.1:52740', 'http://127.0.0.1:52740', 'cross-site'),
    ).toBe(false);
  });
});

describe('local HTTP request boundary', () => {
  let projectDir: string;
  let libraryDir: string;
  let configDir: string;
  let server: StartedServer | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'leadzy-http-security-'));
    libraryDir = mkdtempSync(join(tmpdir(), 'leadzy-http-security-library-'));
    configDir = mkdtempSync(join(tmpdir(), 'leadzy-http-security-config-'));
    process.env.LEADZY_LIBRARY_DIR = libraryDir;
    process.env.LEADZY_CONFIG_DIR = configDir;
    await mkdir(join(projectDir, 'edit'), { recursive: true });
    await writeFile(editJsonPath(projectDir), JSON.stringify(BASE_DOC, null, 2) + '\n');
    server = await startServer(projectDir);
    baseUrl = server.address;
  }, 20_000);

  afterAll(async () => {
    await server?.close();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(libraryDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
    delete process.env.LEADZY_LIBRARY_DIR;
    delete process.env.LEADZY_CONFIG_DIR;
  });

  it('rejects a hostile Host without returning project data', async () => {
    const response = await rawGet(`${baseUrl}/api/edit`, { host: 'attacker.example' });

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      error: 'forbidden',
      message: 'cross-origin requests to the local API are not allowed',
    });
  });

  it('rejects an external Origin even when Host is local', async () => {
    const response = await fetch(`${baseUrl}/api/edit`, {
      headers: { origin: 'https://attacker.example' },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'forbidden',
      message: 'cross-origin requests to the local API are not allowed',
    });
  });

  it('accepts the exact local Origin used by the editor', async () => {
    const response = await fetch(`${baseUrl}/api/edit`, { headers: { origin: baseUrl } });
    expect(response.status).toBe(200);
  });

  it('rejects a browser request marked cross-site even without Origin', async () => {
    const response = await fetch(`${baseUrl}/api/edit`, {
      headers: { 'sec-fetch-site': 'cross-site' },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'forbidden',
      message: 'cross-origin requests to the local API are not allowed',
    });
  });

  it('sets anti-framing and content-sniffing headers on every response', async () => {
    for (const path of ['/api/edit', '/']) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });
});
