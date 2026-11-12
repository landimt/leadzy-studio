import { describe, expect, it } from 'vitest';
import { exportViewerSource, type ExportViewerInput } from './exportViewerSource.js';

function input(overrides: Partial<ExportViewerInput> = {}): ExportViewerInput {
  return {
    finalJustExported: false,
    previewFresh: false,
    programFresh: false,
    finalVersion: 3,
    previewVersion: 5,
    programVersion: 7,
    ...overrides,
  };
}

describe('exportViewerSource', () => {
  it.each([
    [
      'the file just exported, above everything',
      input({ finalJustExported: true, previewFresh: true, programFresh: true }),
      'final',
      3,
    ],
    [
      'the burned preview when it is fresh',
      input({ previewFresh: true, programFresh: true }),
      'proof',
      5,
    ],
    ['the program when only it is fresh', input({ programFresh: true }), 'engine', 7],
  ] as const)('plays %s', (_label, source, kind, version) => {
    expect(exportViewerSource(source)).toMatchObject({ kind, version });
  });

  it('plays nothing when nothing rendered matches the document', () => {
    expect(exportViewerSource(input())).toBeNull();
  });
});
