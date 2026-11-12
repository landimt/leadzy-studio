import { access, chmod, cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = resolve(import.meta.dirname, '..');
const resources = join(root, 'build', 'resources');
const binDir = join(root, 'bin');
const executableName = (name) => (process.platform === 'win32' ? `${name}.exe` : name);
const run = promisify(execFile);

async function requireFile(path, hint) {
  try {
    await access(path);
  } catch {
    throw new Error(`${hint}: ${path}`);
  }
}

await requireFile(join(binDir, executableName('ffmpeg')), 'FFmpeg portátil ausente');
await requireFile(join(binDir, executableName('ffprobe')), 'FFprobe portátil ausente');
await requireFile(join(root, 'dist', 'client', 'index.html'), 'Build do cliente ausente');

// Download on the build machine, never while a customer renders their first piece.
// HyperFrames pins the compatible Chrome Headless Shell revision in its locked package.
const browserEnv = { ...process.env, NO_UPDATE_NOTIFIER: '1' };
delete browserEnv.HYPERFRAMES_BROWSER_PATH;
const cli = join(root, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs');
await run(process.execPath, [cli, 'browser', 'ensure'], { env: browserEnv, timeout: 300_000 });
const { stdout } = await run(process.execPath, [cli, 'browser', 'path'], {
  env: browserEnv,
  timeout: 30_000,
});
const browserPath = stdout.trim();
await requireFile(browserPath, 'Chrome Headless Shell ausente');
if (!browserPath.endsWith(executableName('chrome-headless-shell'))) {
  throw new Error(`O navegador de distribuição precisa ser Chrome Headless Shell: ${browserPath}`);
}

await rm(resources, { recursive: true, force: true });
await mkdir(join(resources, 'bin'), { recursive: true });
await cp(join(root, 'dist', 'client'), join(resources, 'dist', 'client'), { recursive: true });
await cp(join(root, 'templates'), join(resources, 'templates'), { recursive: true });
await cp(dirname(browserPath), join(resources, 'browser'), { recursive: true });
await cp(
  join(root, '.claude', 'skills', 'leadzy-studio'),
  join(resources, 'skills', 'leadzy-studio'),
  { recursive: true },
);
for (const [source, destination] of [
  ['LICENSE', 'LICENSE'],
  ['docs/legal/NOTICE.md', 'NOTICE'],
  ['docs/legal/THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ['docs/legal/TRADEMARKS.md', 'TRADEMARKS.md'],
  ['docs/legal/PRIVACY.md', 'PRIVACY.md'],
  ['docs/legal/COMMERCIAL-LICENSING.md', 'COMMERCIAL-LICENSING.md'],
]) {
  await cp(join(root, source), join(resources, destination));
}
for (const tool of ['ffmpeg', 'ffprobe']) {
  const name = executableName(tool);
  await cp(join(binDir, name), join(resources, 'bin', name));
  await chmod(join(resources, 'bin', name), 0o755);
}
if (process.platform === 'win32') {
  await cp(join(binDir, 'FFMPEG-LICENSE.txt'), join(resources, 'FFMPEG-LICENSE.txt'));
}

console.log(`Recursos desktop preparados em ${resources}`);
