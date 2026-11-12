import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deliverFinalExport, exportDeliveryFilename } from './exportDelivery.js';

describe('export delivery', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('expands the supported placeholders and strips path-like characters', () => {
    expect(
      exportDeliveryFilename(
        '../{project}:{date}-{time}.mp4',
        '/projects/Campanha A',
        new Date(2026, 7, 26, 9, 7),
      ),
    ).toBe('Campanha A-2026-08-26-0907.mp4');
  });

  it('copies the canonical final without overwriting an earlier delivery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leadzy-delivery-'));
    roots.push(root);
    const projectDir = join(root, 'Meu Projeto');
    const destination = join(root, 'exports');
    await mkdir(join(projectDir, 'edit'), { recursive: true });
    await mkdir(destination);
    await writeFile(join(projectDir, 'edit', 'final.mp4'), 'video');

    const first = await deliverFinalExport(projectDir, destination, '{project}');
    const second = await deliverFinalExport(projectDir, destination, '{project}');

    expect(first.deliveryName).toBe('Meu Projeto.mp4');
    expect(second.deliveryName).toBe('Meu Projeto-2.mp4');
    expect(await readFile(first.deliveryPath, 'utf8')).toBe('video');
    expect(await readFile(second.deliveryPath, 'utf8')).toBe('video');
  });
});
