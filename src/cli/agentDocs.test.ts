import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const documents = [
  '.claude/skills/leadzy-studio/SKILL.md',
  'templates/creative-agent-guide.md',
] as const;

describe('portable agent contract', () => {
  it.each(documents)('%s uses only the globally available, reproducible workflow', async (path) => {
    const content = await readFile(join(repoRoot, path), 'utf8');
    expect(content).not.toContain('pnpm studio');
    expect(content).not.toMatch(/~\/dev\//);
    expect(content).not.toContain('npx --yes');
    expect(content).not.toContain('leadzy-outro-hf');
    expect(content).toContain('studio status');
    expect(content).toContain('studio edit apply');
    expect(content).toContain('studio validate');
    expect(content).toContain('studio audio preview');
    expect(content).toContain('edit/audio-preview-before.m4a');
    expect(content).toContain('edit/audio-preview.m4a');
  });
});
