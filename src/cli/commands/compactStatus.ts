import type { ProjectStatus, ProjectValidation } from './inspect.js';
import { isPendingTranscript } from './inspect.js';

export interface CompactProjectStatus {
  protocol: 'leadzy-studio.status.v1';
  ok: boolean;
  projectDir: string;
  editHash: string | null;
  summary: { durationS: number; sources: number; tracks: number; blocks: number } | null;
  validation: { ok: boolean; issues: { code: string; path: string }[]; omitted: number };
  transcripts: { pending: number; unreadable: number } | null;
  artifacts: Record<'preview' | 'audio' | 'final', 'current' | 'stale' | 'missing'> | null;
  next: { action: 'repair-project' | 'inspect-media' | 'read-edit'; read: string[] };
  workflow: readonly [
    'read',
    'apply-with-hash',
    'validate',
    'render-preview',
    'visual-review',
    'final-qa',
  ];
  uiState: 'not-observed';
}

/** A bounded read-only projection. Full status remains available for diagnostics/media inventory. */
export function compactProjectStatus(
  status: ProjectStatus | ProjectValidation,
): CompactProjectStatus {
  const project = 'validation' in status ? status : null;
  const validation = project?.validation ?? (status as ProjectValidation);
  const artifact = (exists: boolean, current: boolean): 'current' | 'stale' | 'missing' =>
    current ? 'current' : exists ? 'stale' : 'missing';
  const unreadable = project?.transcripts.filter((item) => item.state === 'unreadable').length ?? 0;
  return {
    protocol: 'leadzy-studio.status.v1',
    ok: validation.ok,
    projectDir: status.projectDir,
    editHash: status.editHash,
    summary: project
      ? {
          durationS: project.renderedDurationS,
          sources: project.sources,
          tracks: project.tracks,
          blocks: project.blocks,
        }
      : null,
    validation: {
      ok: validation.ok,
      issues: validation.issues.slice(0, 8).map(({ code, path }) => ({ code, path })),
      omitted: Math.max(0, validation.issues.length - 8),
    },
    transcripts: project
      ? { pending: project.transcripts.filter(isPendingTranscript).length, unreadable }
      : null,
    artifacts: project
      ? {
          preview: artifact(project.previewExists, project.previewCurrent),
          audio: artifact(project.audioComparisonExists, project.audioComparisonCurrent),
          final: artifact(project.finalExists, project.finalCurrent),
        }
      : null,
    next: {
      action: !validation.ok ? 'repair-project' : unreadable ? 'inspect-media' : 'read-edit',
      read: ['edit/edit.json'],
    },
    workflow: [
      'read',
      'apply-with-hash',
      'validate',
      'render-preview',
      'visual-review',
      'final-qa',
    ],
    // The CLI sees disk, never unsaved browser edits or a user's current selection.
    uiState: 'not-observed',
  };
}
