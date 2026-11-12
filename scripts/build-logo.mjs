#!/usr/bin/env node
/**
 * Builds every application icon from the approved transparent 4096px mark.
 *
 * macOS uses its built-in resizer; Windows uses the pinned Sharp dependency.
 * The ICNS and ICO containers are deterministic and
 * assembled from those PNG sizes. The high-resolution PNG under assets/brand
 * is the canonical source and must never be generated from code.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'assets/brand/leadzy-studio-mark-4096.png');
const VECTOR_SOURCE = path.join(ROOT, 'assets/brand/leadzy-studio-mark.svg');
const UI_ICON = path.join(ROOT, 'src/client/assets/icon-leadzy-studio.png');
const DESKTOP_PREVIEW = path.join(ROOT, 'build/desktop-icon.png');
const ICONSET = path.join(ROOT, 'build/icon.iconset');
const ICNS = path.join(ROOT, 'build/icon.icns');
const ICO = path.join(ROOT, 'build/icon.ico');
const PUBLIC = path.join(ROOT, 'public');
const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const FFMPEG = existsSync(path.join(ROOT, 'bin', ffmpegName))
  ? path.join(ROOT, 'bin', ffmpegName)
  : 'ffmpeg';

function icnsEntry(type, pngPath) {
  const png = readFileSync(pngPath);
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, 'ascii');
  header.writeUInt32BE(png.length + header.length, 4);
  return Buffer.concat([header, png]);
}

function writeIcns(entries) {
  const body = Buffer.concat(entries.map(({ type, path: pngPath }) => icnsEntry(type, pngPath)));
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(body.length + header.length, 4);
  writeFileSync(ICNS, Buffer.concat([header, body]));
}

function writeIco(pngPaths, output) {
  const images = pngPaths.map((pngPath) => {
    const png = readFileSync(pngPath);
    return {
      png,
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
    };
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = header.length + images.length * 16;
  const directory = images.map(({ png, width, height }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(width >= 256 ? 0 : width, 0);
    entry.writeUInt8(height >= 256 ? 0 : height, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  writeFileSync(output, Buffer.concat([header, ...directory, ...images.map(({ png }) => png)]));
}

function renderOnBackground(output, size, scale = 0.9) {
  const markSize = Math.round(size * scale);
  execFileSync(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=0x171126:s=${String(size)}x${String(size)}:d=0.04`,
      '-i',
      SOURCE,
      '-filter_complex',
      `[1:v]scale=${String(markSize)}:${String(markSize)}:flags=lanczos[mark];[0:v][mark]overlay=(W-w)/2:(H-h)/2:format=auto,format=rgba`,
      '-frames:v',
      '1',
      output,
    ],
    { stdio: 'ignore' },
  );
}

async function resize(input, output, size) {
  if (process.platform !== 'darwin') {
    await sharp(input).resize(size, size).png().toFile(output);
    return;
  }
  execFileSync(
    '/usr/bin/sips',
    ['--resampleHeightWidth', String(size), String(size), input, '--out', output],
    { stdio: 'ignore' },
  );
}

async function build() {
  if (!existsSync(SOURCE)) throw new Error(`Logo oficial ausente: ${SOURCE}`);
  if (!existsSync(VECTOR_SOURCE)) throw new Error(`Logo vetorial ausente: ${VECTOR_SOURCE}`);

  mkdirSync(path.dirname(UI_ICON), { recursive: true });
  mkdirSync(path.dirname(DESKTOP_PREVIEW), { recursive: true });
  mkdirSync(PUBLIC, { recursive: true });
  rmSync(ICONSET, { recursive: true, force: true });
  mkdirSync(ICONSET, { recursive: true });

  await resize(SOURCE, UI_ICON, 512);
  await resize(SOURCE, DESKTOP_PREVIEW, 1024);

  const iconFiles = [
    { name: 'icon_16x16.png', size: 16, types: ['icp4'] },
    { name: 'icon_16x16@2x.png', size: 32, types: ['ic11'] },
    { name: 'icon_32x32.png', size: 32, types: ['icp5'] },
    { name: 'icon_32x32@2x.png', size: 64, types: ['ic12', 'icp6'] },
    { name: 'icon_128x128.png', size: 128, types: ['ic07'] },
    { name: 'icon_128x128@2x.png', size: 256, types: ['ic13'] },
    { name: 'icon_256x256.png', size: 256, types: ['ic08'] },
    { name: 'icon_256x256@2x.png', size: 512, types: ['ic14'] },
    { name: 'icon_512x512.png', size: 512, types: ['ic09'] },
    { name: 'icon_512x512@2x.png', size: 1024, types: ['ic10'] },
  ];
  for (const { name, size } of iconFiles) await resize(SOURCE, path.join(ICONSET, name), size);

  writeIcns(
    iconFiles.flatMap(({ name, types }) =>
      types.map((type) => ({ type, path: path.join(ICONSET, name) })),
    ),
  );
  writeIco(
    iconFiles
      .filter(({ size }) => [16, 32, 48, 64, 128, 256].includes(size))
      .filter(({ size }, index, files) => files.findIndex((file) => file.size === size) === index)
      .map(({ name }) => path.join(ICONSET, name)),
    ICO,
  );
  rmSync(ICONSET, { recursive: true, force: true });

  copyFileSync(VECTOR_SOURCE, path.join(PUBLIC, 'favicon.svg'));
  const transparentWebIcons = [
    ['favicon-16x16.png', 16],
    ['favicon-32x32.png', 32],
    ['favicon-48x48.png', 48],
    ['pwa-192x192.png', 192],
    ['pwa-512x512.png', 512],
  ];
  for (const [name, size] of transparentWebIcons) {
    await resize(SOURCE, path.join(PUBLIC, name), size);
  }
  writeIco(
    ['favicon-16x16.png', 'favicon-32x32.png', 'favicon-48x48.png'].map((name) =>
      path.join(PUBLIC, name),
    ),
    path.join(PUBLIC, 'favicon.ico'),
  );

  renderOnBackground(path.join(PUBLIC, 'apple-touch-icon.png'), 180, 0.88);
  renderOnBackground(path.join(PUBLIC, 'pwa-maskable-192x192.png'), 192);
  renderOnBackground(path.join(PUBLIC, 'pwa-maskable-512x512.png'), 512);
  renderOnBackground(path.join(PUBLIC, 'mstile-150x150.png'), 150, 0.86);

  console.log(`Logo oficial: ${path.relative(ROOT, SOURCE)}`);
  console.log(`Interface: ${path.relative(ROOT, UI_ICON)}`);
  console.log(`Web/PWA: ${path.relative(ROOT, PUBLIC)}`);
  console.log(`macOS: ${path.relative(ROOT, ICNS)}`);
  console.log(`Windows: ${path.relative(ROOT, ICO)}`);
}

await build();
