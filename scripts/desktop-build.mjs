import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { copyFile } from 'node:fs/promises';

const root = resolve(import.meta.dirname, '..');
const [command = 'package', ...flags] = process.argv.slice(2);
if (!['package', 'make', 'publish'].includes(command)) throw new Error('Comando desktop inválido.');
const unsigned = flags.includes('--unsigned');
if (unsigned && command === 'publish') throw new Error('Um build de teste não pode ser publicado.');
for (const name of ['arch', 'platform', 'out']) {
  if (
    flags.includes(`--${name}`) ||
    flags.filter((flag) => flag.startsWith(`--${name}=`)).length > 1
  ) {
    throw new Error(
      `Use --${name}=valor exatamente uma vez; opções duplicadas ou separadas não são aceitas.`,
    );
  }
}
for (const flag of flags) {
  if (
    !['--unsigned', '--dry-run', '--from-dry-run'].includes(flag) &&
    !/^--(?:arch|platform|out)=.+$/.test(flag)
  ) {
    throw new Error(`Opção desktop não suportada: ${flag}. Use --arch=valor e --platform=valor.`);
  }
}
const out = flags.find((flag) => flag.startsWith('--out='))?.slice(6);
const forgeFlags = flags.filter((flag) => flag !== '--unsigned' && !flag.startsWith('--out='));
const arch = forgeFlags.find((flag) => flag.startsWith('--arch='))?.slice(7) ?? process.arch;
const platform =
  forgeFlags.find((flag) => flag.startsWith('--platform='))?.slice(11) ?? process.platform;
if (platform !== process.platform || arch !== process.arch) {
  throw new Error(
    'Execute o build com Node da plataforma e arquitetura de destino; FFmpeg, Chrome e módulos nativos precisam corresponder ao aplicativo.',
  );
}
if (
  !['darwin', 'win32'].includes(platform) ||
  !['arm64', 'x64'].includes(arch) ||
  (platform === 'win32' && arch !== 'x64')
) {
  throw new Error(
    `Destino desktop não suportado: ${platform}/${arch}. Windows requer Node x64, inclusive em Windows ARM com emulação.`,
  );
}
const env = {
  ...process.env,
  ...(out ? { LEADZY_DESKTOP_OUT: resolve(root, out) } : {}),
  ...(unsigned
    ? { MACOS_SIGN_IDENTITY: '', ALLOW_UNNOTARIZED: '1', WINDOWS_CERTIFICATE_FILE: '' }
    : {}),
};

async function run(file, args) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolveRun() : reject(new Error(`${file} falhou (${code}).`)),
    );
  });
}

if (!forgeFlags.includes('--from-dry-run')) {
  await run('scripts/setup-media-tools.mjs', []);
  await run('scripts/build-logo.mjs', []);
  await run('node_modules/typescript/bin/tsc', ['-p', 'tsconfig.node.json']);
  await run('node_modules/vite/bin/vite.js', ['build']);
  await run('scripts/prepare-desktop-resources.mjs', []);
  if (platform === 'darwin' && command !== 'package') await run('scripts/setup-dmg-native.mjs', []);
  if (platform === 'win32' && command !== 'package') {
    // pnpm blocks installer lifecycle scripts. Select the bundled 7-Zip
    // explicitly, without enabling arbitrary dependency install scripts.
    for (const extension of ['exe', 'dll']) {
      await copyFile(
        resolve(root, `node_modules/electron-winstaller/vendor/7z-${arch}.${extension}`),
        resolve(root, `node_modules/electron-winstaller/vendor/7z.${extension}`),
      );
    }
  }
}
await run('node_modules/@electron-forge/cli/dist/electron-forge.js', [command, ...forgeFlags]);
