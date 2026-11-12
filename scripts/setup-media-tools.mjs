import { chmod, copyFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const binDir = join(root, 'bin');
const force = process.argv.includes('--force');
const executableName = (name) => (process.platform === 'win32' ? `${name}.exe` : name);
const WINDOWS_RELEASE = {
  version: '9.0.1',
  url: 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.1/ffmpeg-9.0.1-essentials_build.zip',
  sha256: 'fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9',
};

const MAC_RELEASE = {
  version: '9.0.1',
  amd64: {
    baseUrl: 'https://ffmpeg.martin-riedl.de/download/macos/amd64/1787081194_9.0.1',
    sha256: {
      ffmpeg: '5bdead62ff504ab9b447cc72b212c4fb481e3f7de5877d427a51bee8136dda40',
      ffprobe: '34511bbcf1988ad2886023bf5ace4f44cf62e6defeb3d194d6f7619e5b061f7f',
    },
  },
  arm64: {
    baseUrl: 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1787073674_9.0.1',
    sha256: {
      ffmpeg: '8287a1b2229e05eb41859f073e18e6c52c60a778f2f5e6881070fe51b79407fe',
      ffprobe: '102a26b8940a053298d9929bfaae71e4b6ef65ba5f19a99a88c433108560741a',
    },
  },
};

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'pipe', ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr?.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolveRun({ stdout, stderr })
        : reject(new Error(`${command} falhou (${String(code)}): ${stderr.trim()}`)),
    );
  });
}

async function healthy(ffmpegCommand, ffprobeCommand, expectedVersion) {
  try {
    if (process.platform === 'darwin') {
      const expected = process.arch === 'x64' ? 'x86_64' : process.arch;
      for (const command of [ffmpegCommand, ffprobeCommand]) {
        const architecture = await run('/usr/bin/lipo', ['-archs', command]);
        if (!architecture.stdout.trim().split(/\s+/).includes(expected)) return false;
      }
    }
    const ffmpeg = await run(ffmpegCommand, ['-hide_banner', '-filters']);
    const ffprobe = await run(ffprobeCommand, ['-hide_banner', '-version']);
    if (expectedVersion) {
      const ffmpegVersion = await run(ffmpegCommand, ['-hide_banner', '-version']);
      for (const output of [ffmpegVersion.stdout, ffprobe.stdout]) {
        const actual = /version\s+([^\s-]+)/.exec(output)?.[1];
        if (actual !== expectedVersion) return false;
      }
    }
    return /\bsubtitles\b/.test(ffmpeg.stdout);
  } catch {
    return false;
  }
}

async function download(url, destination, expectedSha256) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`download falhou (${String(response.status)}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `integridade inválida para ${url}: esperado ${expectedSha256}, recebido ${actualSha256}`,
    );
  }
  await writeFile(destination, bytes);
}

async function installMacTool(tool, arch, workDir) {
  const archive = join(workDir, `${tool}.zip`);
  const extracted = join(workDir, tool);
  const release = MAC_RELEASE[arch];
  const url = `${release.baseUrl}/${tool}.zip`;
  process.stdout.write(`  baixando ${tool} ${MAC_RELEASE.version} (${arch})… `);
  await download(url, archive, release.sha256[tool]);
  await run('ditto', ['-xk', archive, workDir]);
  await copyFile(extracted, join(binDir, tool));
  await chmod(join(binDir, tool), 0o755);
  console.log('ok');
}

await mkdir(binDir, { recursive: true });
if (
  !force &&
  (await healthy(
    join(binDir, executableName('ffmpeg')),
    join(binDir, executableName('ffprobe')),
    process.platform === 'win32' ? WINDOWS_RELEASE.version : MAC_RELEASE.version,
  ))
) {
  console.log('✓ FFmpeg e FFprobe portáteis já estão prontos (libass disponível).');
  process.exit(0);
}

if (process.platform === 'win32') {
  if (process.arch !== 'x64') throw new Error('O setup Windows requer Node.js x64.');
  const workDir = await mkdtemp(join(tmpdir(), 'leadzy-media-tools-'));
  try {
    const archive = join(workDir, 'ffmpeg.zip');
    console.log(`Baixando FFmpeg ${WINDOWS_RELEASE.version} Windows x64…`);
    await download(WINDOWS_RELEASE.url, archive, WINDOWS_RELEASE.sha256);
    // Windows includes bsdtar; arguments are passed directly, with no shell interpolation.
    await run('tar.exe', ['-xf', archive, '-C', workDir]);
    const extracted = join(workDir, `ffmpeg-${WINDOWS_RELEASE.version}-essentials_build`);
    for (const tool of ['ffmpeg', 'ffprobe']) {
      await copyFile(join(extracted, 'bin', `${tool}.exe`), join(binDir, `${tool}.exe`));
    }
    await cp(join(extracted, 'LICENSE'), join(binDir, 'FFMPEG-LICENSE.txt'));
    if (
      !(await healthy(
        join(binDir, 'ffmpeg.exe'),
        join(binDir, 'ffprobe.exe'),
        WINDOWS_RELEASE.version,
      ))
    ) {
      throw new Error('Os binários Windows não expõem subtitles/libass.');
    }
    console.log('✓ FFmpeg e FFprobe Windows instalados em bin/.');
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  process.exit(0);
}

if (process.platform !== 'darwin') {
  if (await healthy('ffmpeg', 'ffprobe')) {
    console.log('✓ FFmpeg e FFprobe do sistema detectados (libass disponível).');
    process.exit(0);
  }
  throw new Error(
    'instale ffmpeg/ffprobe com libass no PATH e rode novamente; o download portátil automático está disponível apenas no macOS',
  );
}

if (process.arch !== 'arm64' && process.arch !== 'x64') {
  throw new Error(`arquitetura macOS sem binário verificado: ${process.arch}`);
}
const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
const workDir = await mkdtemp(join(tmpdir(), 'leadzy-media-tools-'));
try {
  await installMacTool('ffmpeg', arch, workDir);
  await installMacTool('ffprobe', arch, workDir);
  if (!(await healthy(join(binDir, 'ffmpeg'), join(binDir, 'ffprobe'), MAC_RELEASE.version)))
    throw new Error('os binários baixados não expõem o filtro subtitles/libass');
  console.log('✓ Ferramentas de mídia instaladas em bin/.');
  console.log('  Avisos e código-fonte: docs/legal/THIRD_PARTY_NOTICES.md');
} finally {
  await rm(workDir, { recursive: true, force: true });
}
