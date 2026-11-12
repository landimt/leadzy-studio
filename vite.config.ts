import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { version } = JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8')) as {
  version: string;
};

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  root: join(import.meta.dirname, 'src', 'client'),
  publicDir: join(import.meta.dirname, 'public'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': join(import.meta.dirname, 'src', 'client') },
  },
  build: {
    outDir: join(import.meta.dirname, 'dist', 'client'),
    emptyOutDir: true,
  },
});
