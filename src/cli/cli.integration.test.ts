import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('runs the installed-style studio entrypoint from outside the repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'leadzy-cli-external-'));
  roots.push(root);
  await mkdir(join(root, 'edit'), { recursive: true });
  await writeFile(join(root, 'camera.mp4'), 'media');
  await writeFile(
    join(root, 'edit', 'edit.json'),
    JSON.stringify({
      version: 2,
      fps: 25,
      output: { width: 1080, height: 1920, loudnormLufs: -14 },
      sources: { cam: { path: 'camera.mp4', durationS: 4 } },
      tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 4 }] }],
      subtitles: { enabled: false, preset: 'pill' },
      totalDurationS: 4,
    }),
  );

  const result = await execa(
    'node',
    [join(repoRoot, 'bin', 'studio.js'), 'status', root, '--json'],
    {
      cwd: tmpdir(),
    },
  );
  const status = JSON.parse(result.stdout) as { projectName: string; validation: { ok: boolean } };
  expect(status.projectName).toBe(basename(root));
  expect(status.validation.ok).toBe(true);
  const compactResult = await execa(
    'node',
    [join(repoRoot, 'bin', 'studio.js'), 'status', root, '--compact', '--json'],
    { cwd: tmpdir() },
  );
  const compact = JSON.parse(compactResult.stdout) as {
    protocol: string;
    editHash: string;
    uiState: string;
    summary: { blocks: number };
    artifacts: { preview: string };
  };
  expect(compact.protocol).toBe('leadzy-studio.status.v1');
  expect(compact.summary.blocks).toBe(1);
  expect(compact.artifacts.preview).toBe('missing');
  expect(compact.uiState).toBe('not-observed');
  expect(compact.editHash).toEqual((JSON.parse(result.stdout) as { editHash: string }).editHash);
});

it('emits stable JSON and labeled human output for the audio A/B comparison', async () => {
  const root = await mkdtemp(join(tmpdir(), 'leadzy-cli-audio-ab-'));
  roots.push(root);
  await mkdir(join(root, 'edit'), { recursive: true });
  try {
    await execa('ffmpeg', [
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=duration=1:size=160x90:rate=25',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      join(root, 'camera.mp4'),
    ]);
  } catch {
    return;
  }
  await writeFile(
    join(root, 'edit', 'edit.json'),
    JSON.stringify({
      version: 2,
      fps: 25,
      output: { width: 160, height: 90, loudnormLufs: null },
      sources: { cam: { path: 'camera.mp4', durationS: 1 } },
      tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 1 }] }],
      subtitles: { enabled: false, preset: 'pill' },
      totalDurationS: 1,
    }),
  );

  const jsonRun = await execa(
    'node',
    [join(repoRoot, 'bin', 'studio.js'), 'audio', 'preview', root, '--json'],
    { cwd: tmpdir() },
  );
  const outcome = JSON.parse(jsonRun.stdout) as {
    beforeOutputRel: string;
    beforeOutputAbs: string;
    outputRel: string;
    outputAbs: string;
  };
  const canonicalRoot = await realpath(root);
  expect(outcome.beforeOutputRel).toBe('edit/audio-preview-before.m4a');
  expect(outcome.outputRel).toBe('edit/audio-preview.m4a');
  expect(await realpath(outcome.beforeOutputAbs)).toBe(
    await realpath(join(canonicalRoot, outcome.beforeOutputRel)),
  );
  expect(await realpath(outcome.outputAbs)).toBe(
    await realpath(join(canonicalRoot, outcome.outputRel)),
  );
  expect((await stat(outcome.beforeOutputAbs)).isFile()).toBe(true);
  expect((await stat(outcome.outputAbs)).isFile()).toBe(true);

  const humanRun = await execa(
    'node',
    [join(repoRoot, 'bin', 'studio.js'), 'audio', 'preview', root],
    { cwd: tmpdir() },
  );
  expect(humanRun.stdout).toContain('before: edit/audio-preview-before.m4a');
  expect(humanRun.stdout).toContain('after: edit/audio-preview.m4a');
}, 30_000);
