import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'electron/**/*.test.mjs'],
    environment: 'node',
    pool: 'threads',
    // The suite writes real files and spawns real ffmpeg. On Windows every one
    // of those goes through a much slower filesystem — on-access antivirus
    // scanning included — so under full parallelism the 5s default expires on
    // I/O rather than on a defect. Give that platform the headroom.
    testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
  },
});
