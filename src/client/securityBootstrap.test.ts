import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('client security bootstrap', () => {
  it('boots only external scripts under a restrictive content policy', () => {
    const html = readFileSync(join(root, 'src/client/index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];

    expect(html).toContain(`script-src 'self'`);
    expect(html).toContain(`object-src 'none'`);
    expect(html).toContain(`connect-src 'self'`);
    expect(html).not.toMatch(/connect-src[^;]*(?:ws:|wss:)/);
    expect(html).not.toMatch(/script-src[^;]*(?:'unsafe-inline'|'unsafe-eval')/);
    expect(html).toContain('src="/theme/themeBootstrap.ts"');
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script[1]).toContain('src=');
      expect(script[2]?.trim()).toBe('');
    }
  });
});
