import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nodeGyp = join(root, 'node_modules', '.bin', 'node-gyp');
const modules = ['macos-alias', 'fs-xattr'];

if (process.platform !== 'darwin') {
  console.log('Dependências do DMG são necessárias apenas no macOS.');
  process.exit(0);
}

if (!existsSync(nodeGyp)) {
  console.error('node-gyp não encontrado. Execute pnpm install antes de gerar o DMG.');
  process.exit(1);
}

const safeEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !/(?:api.?key|token|secret|password|credential)/i.test(name),
  ),
);
safeEnvironment.npm_config_loglevel = 'silent';

for (const moduleName of modules) {
  const moduleDirectory = join(root, 'node_modules', moduleName);
  if (!existsSync(moduleDirectory)) {
    console.error(`Dependência ausente: ${moduleName}. Execute pnpm install.`);
    process.exit(1);
  }

  const result = spawnSync(nodeGyp, ['rebuild', '--directory', moduleDirectory], {
    cwd: root,
    env: safeEnvironment,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const details = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    console.error(`Falha ao preparar ${moduleName} para o DMG.`);
    if (details) console.error(details);
    process.exit(result.status ?? 1);
  }
  console.log(`DMG: ${moduleName} ✓`);
}
