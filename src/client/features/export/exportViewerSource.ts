import type { MessageKey } from '../../i18n/index.js';

export type ExportViewerKind = 'final' | 'proof' | 'engine';

export interface ExportViewerInput {
  /** A final export finished during this dialog session. */
  readonly finalJustExported: boolean;
  readonly previewFresh: boolean;
  readonly programFresh: boolean;
  readonly finalVersion: number;
  readonly previewVersion: number;
  readonly programVersion: number;
}

export interface ExportViewerSource {
  readonly kind: ExportViewerKind;
  readonly relPath: string;
  readonly version: number;
  readonly labelKey: MessageKey;
}

/**
 * What the delivery viewer plays: the file just exported, else the burned
 * preview when it matches the document, else the engine's program (no
 * captions or overlays — the label says so). Nothing fresh → null.
 */
export function exportViewerSource(input: ExportViewerInput): ExportViewerSource | null {
  if (input.finalJustExported) {
    return {
      kind: 'final',
      relPath: 'edit/final.mp4',
      version: input.finalVersion,
      labelKey: 'export.viewer.final',
    };
  }
  if (input.previewFresh) {
    return {
      kind: 'proof',
      relPath: 'edit/preview.mp4',
      version: input.previewVersion,
      labelKey: 'export.viewer.proof',
    };
  }
  if (input.programFresh) {
    return {
      kind: 'engine',
      relPath: 'edit/program.mp4',
      version: input.programVersion,
      labelKey: 'export.viewer.engine',
    };
  }
  return null;
}
