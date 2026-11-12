#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Resolves tsx's own JS entry instead of the `node_modules/.bin` shim. That
 * shim is a shell script on POSIX and a `.cmd` on Windows, and Node refuses to
 * spawn a `.cmd` without a shell — going through the module keeps a single
 * code path, and no shell quoting, on every platform.
 */
function resolveTsxCli() {
  try {
    const require = createRequire(join(root, 'package.json'));
    const manifestPath = require.resolve('tsx/package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.tsx;
    return entry ? join(dirname(manifestPath), entry) : null;
  } catch {
    return null;
  }
}

const tsxCli = resolveTsxCli();
if (tsxCli === null) {
  console.error(`✗ dependências ausentes — rode "pnpm install" em ${root}`);
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [tsxCli, join(root, 'src', 'cli', 'main.ts'), ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
child.on('exit', (code, signal) => {
  process.exit(signal !== null ? 1 : (code ?? 0));
});
