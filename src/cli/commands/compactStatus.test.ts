import { describe, expect, it } from 'vitest';
import type { ProjectStatus } from './inspect.js';
import { compactProjectStatus } from './compactStatus.js';

// A projection deliberately accepts the full status, but must not copy media/transcript payloads.
const status: ProjectStatus = {
  ok: true,
  projectDir: '/project',
  projectName: 'project',
  editHash: 'hash',
  schemaVersion: 2,
  sources: 1,
  tracks: 1,
  blocks: 1,
  baseBlocks: 1,
  editorialDurationS: 10,
  renderedDurationS: 10,
  outputSpeed: 1,
  previewExists: true,
  previewEditHash: 'old',
  previewCurrent: false,
  audioPreviewExists: false,
  audioComparisonExists: false,
  audioPreviewEditHash: null,
  audioPreviewCurrent: false,
  audioComparisonCurrent: false,
  finalExists: true,
  finalEditHash: 'hash',
  finalCurrent: true,
  keyterms: ['private-term'],
  media: [
    {
      relPath: 'private-media.mov',
      sourceId: 'cam',
      durationS: 10,
      width: 100,
      height: 100,
      fps: 30,
      hasAudio: true,
    },
  ],
  transcripts: [
    { relPath: 'private-media.mov', model: null, transcribedAt: null, state: 'missing' },
  ],
  validation: { ok: true, projectDir: '/project', editHash: 'hash', issues: [] },
};

describe('compact agent status', () => {
  it('keeps freshness, pending counts and concurrency hash without copying the inventory', () => {
    const compact = compactProjectStatus(status);
    expect(compact.editHash).toBe('hash');
    expect(compact.artifacts).toEqual({ preview: 'stale', audio: 'missing', final: 'current' });
    expect(compact.transcripts).toEqual({ pending: 1, unreadable: 0 });
    expect(compact.uiState).toBe('not-observed');
    expect(JSON.stringify(compact)).not.toContain('private-');
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(status).length);
  });
  it('prioritizes invalid edits and reports truncated diagnostics explicitly', () => {
    const compact = compactProjectStatus({
      ok: false,
      projectDir: '/bad',
      editHash: null,
      issues: Array.from({ length: 12 }, () => ({
        code: 'bad',
        path: 'tracks',
        message: 'detail',
      })),
    });
    expect(compact.ok).toBe(false);
    expect(compact.editHash).toBeNull();
    expect(compact.next.action).toBe('repair-project');
    expect(compact.validation.issues).toHaveLength(8);
    expect(compact.validation.omitted).toBe(4);
    expect(compact.summary).toBeNull();
  });
});
