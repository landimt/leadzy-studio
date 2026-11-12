import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { editJsonPath, loadEditDoc, resolveProjectFile } from './project.js';

const roots: string[] = [];

async function root(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('project file containment', () => {
  it('rejects lexical traversal before probing', async () => {
    const projectDir = await root('leadzy-project-');
    const result = await resolveProjectFile(projectDir, '../outside.mp4');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('path-outside-project');
  });
});

describe('edit document load failures', () => {
  it('reports truncated JSON as invalid, never as a new project', async () => {
    const projectDir = await root('leadzy-project-corrupt-');
    await mkdir(join(projectDir, 'edit'));
    await writeFile(editJsonPath(projectDir), '{"version":2,"tracks":[');
    expect(await loadEditDoc(projectDir)).toMatchObject({
      ok: false,
      error: { code: 'invalid-edit-json' },
    });
  });

  it('reports existing unreadable document paths as I/O failures', async () => {
    const projectDir = await root('leadzy-project-read-failed-');
    await mkdir(editJsonPath(projectDir), { recursive: true });
    expect(await loadEditDoc(projectDir)).toMatchObject({
      ok: false,
      error: { code: 'io-failed' },
    });
  });

  it('reserves not-found for an absent document', async () => {
    const projectDir = await root('leadzy-project-new-');
    expect(await loadEditDoc(projectDir)).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
  });
});
