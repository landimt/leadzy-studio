import { stat } from 'node:fs/promises';
import { containedPath } from '../core/paths.js';
import type { EditDoc } from '../core/schema.js';

export interface ValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

async function isFile(path: string): Promise<boolean> {
  return stat(path)
    .then((info) => info.isFile())
    .catch(() => false);
}

function referencedFiles(doc: EditDoc): { path: string; label: string }[] {
  const files = Object.entries(doc.sources).map(([key, source]) => ({
    path: source.path,
    label: `sources.${key}.path`,
  }));
  doc.tracks.forEach((track, trackIndex) => {
    if (track.kind !== 'overlay') return;
    track.blocks.forEach((block, blockIndex) => {
      files.push({
        path: block.file,
        label: `tracks.${String(trackIndex)}.blocks.${String(blockIndex)}.file`,
      });
    });
  });
  return files;
}

export async function validateEditDocReferences(
  projectDir: string,
  doc: EditDoc,
): Promise<readonly ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  for (const reference of referencedFiles(doc)) {
    const contained = containedPath(projectDir, reference.path);
    if (!contained.ok) {
      issues.push({
        code: contained.error.code,
        path: reference.label,
        message: contained.error.message,
      });
      continue;
    }
    if (!(await isFile(contained.value))) {
      issues.push({
        code: 'missing-media',
        path: reference.label,
        message: `referenced file does not exist: "${reference.path}"`,
      });
    }
  }
  return issues;
}
