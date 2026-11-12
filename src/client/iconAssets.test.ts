import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const publicDir = join(root, 'public');

function pngSize(path: string): { width: number; height: number } {
  const image = readFileSync(path);
  expect(image.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

describe('brand icon assets', () => {
  it('keeps every web icon reference backed by a public asset', () => {
    const html = readFileSync(join(root, 'src/client/index.html'), 'utf8');
    const hrefs = [...html.matchAll(/href="(?:\.\/|\/)(.*?)"/g)].map((match) => match[1]);

    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).toBeDefined();
      expect(existsSync(join(publicDir, href ?? ''))).toBe(true);
    }
  });

  it('ships correctly sized PWA icons for any and maskable surfaces', () => {
    const manifest = JSON.parse(readFileSync(join(publicDir, 'site.webmanifest'), 'utf8')) as {
      readonly name: string;
      readonly icons: readonly {
        readonly src: string;
        readonly sizes: string;
        readonly purpose: string;
      }[];
    };

    expect(manifest.name).toBe('Leadzy Studio');
    expect(new Set(manifest.icons.map((icon) => icon.purpose))).toEqual(
      new Set(['any', 'maskable']),
    );
    for (const icon of manifest.icons) {
      const size = Number(icon.sizes.split('x')[0]);
      expect(pngSize(join(publicDir, icon.src.replace(/^\//, '')))).toEqual({
        width: size,
        height: size,
      });
    }
  });

  it('keeps the 512px transparent raster compatibility asset', () => {
    expect(pngSize(join(root, 'src/client/assets/icon-leadzy-studio.png'))).toEqual({
      width: 512,
      height: 512,
    });
  });

  it('uses the published vector mark throughout the application UI', () => {
    const mark = readFileSync(join(root, 'assets/brand/leadzy-studio-mark.svg'), 'utf8');
    const favicon = readFileSync(join(publicDir, 'favicon.svg'), 'utf8');
    expect(mark).toContain('viewBox="0 0 1254 1254"');
    expect(favicon).toBe(mark);

    for (const component of [
      'features/home/HomeScreen.tsx',
      'features/shell/MenuBar.tsx',
      'features/startup/StartupScreen.tsx',
    ]) {
      const source = readFileSync(join(root, 'src/client', component), 'utf8');
      expect(source).toContain('assets/brand/leadzy-studio-mark.svg');
    }
  });
});
