import { access, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const [input] = process.argv.slice(2);
if (!input)
  throw new Error('Uso: node scripts/verify-desktop-package.mjs <pasta do aplicativo ou .app>');
const appPath = resolve(input);
const mac = appPath.endsWith('.app');
const executable = mac
  ? join(appPath, 'Contents', 'MacOS', 'Leadzy Studio')
  : join(appPath, 'Leadzy Studio.exe');
const resources = mac ? join(appPath, 'Contents', 'Resources') : join(appPath, 'resources');
const appRoot = join(resources, 'app.asar');
const portable = join(resources, 'resources');
const extension = mac ? '' : '.exe';
const run = promisify(execFile);
const temp = await mkdtemp(join(tmpdir(), 'leadzy-package-smoke-'));
try {
  for (const file of ['dist/client/index.html', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    await access(join(portable, file));
  }
  const { stdout } = await run(
    executable,
    [
      '--input-type=module',
      '-e',
      `
    import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    import { join } from 'node:path';
    import { existsSync } from 'node:fs';
    const root = ${JSON.stringify(appRoot)};
    const require = createRequire(pathToFileURL(join(root, 'package.json')));
    for (const file of ['electron/main.mjs', 'electron/preload.cjs', 'electron/updateNotice.mjs']) {
      if (!existsSync(join(root, file))) throw new Error('Missing packaged module: ' + file);
    }
    const Database = require('better-sqlite3');
    const database = new Database(':memory:');
    if (database.prepare('SELECT 42 AS answer').get().answer !== 42) throw new Error('SQLite smoke failed');
    database.close();
    await import(pathToFileURL(join(root, 'dist/node/server/index.js')).href);
    await import(pathToFileURL(join(root, 'electron/updateNotice.mjs')).href);
    console.log('Packaged module graph and Electron SQLite ABI: OK');
  `,
    ],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LEADZY_STUDIO_ROOT: portable },
      cwd: temp,
      timeout: 30_000,
    },
  );
  process.stdout.write(stdout);
  const filters = await run(
    join(portable, 'bin', `ffmpeg${extension}`),
    ['-hide_banner', '-filters'],
    { timeout: 30_000 },
  );
  if (!/\bsubtitles\b/.test(filters.stdout))
    throw new Error('Packaged FFmpeg lacks subtitles/libass');
  await run(join(portable, 'bin', `ffprobe${extension}`), ['-version'], { timeout: 30_000 });
  const browser = await run(
    join(portable, 'browser', `chrome-headless-shell${extension}`),
    ['--version'],
    { timeout: 30_000 },
  );
  console.log(`Portable FFmpeg/FFprobe and browser: OK (${browser.stdout.trim()})`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
