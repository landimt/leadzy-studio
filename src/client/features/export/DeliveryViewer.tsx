import type { CSSProperties, JSX } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '../../api.js';
import { t } from '../../i18n/index.js';
import type { ExportViewerSource } from './exportViewerSource.js';

/**
 * The left half of the export dialog: what will ship, playable, with one
 * plain line saying whether it is the burned proof, the engine's preview
 * or the file just written — and the way to get the proof when it is not.
 */
export function DeliveryViewer({
  source,
  frame,
  renderRunning,
  onRenderPreview,
}: {
  readonly source: ExportViewerSource | null;
  /** Output size of the document — the stage keeps this shape before and after the video loads. */
  readonly frame: { readonly width: number; readonly height: number };
  readonly renderRunning: boolean;
  readonly onRenderPreview: () => void;
}): JSX.Element {
  const exact = source?.kind === 'proof' || source?.kind === 'final';
  return (
    <div
      className="export-viewer"
      style={
        { '--stage-w': String(frame.width), '--stage-h': String(frame.height) } as CSSProperties
      }
    >
      <div className="export-stage">
        {source === null ? (
          <div className="export-stage-empty">{t('export.viewer.none')}</div>
        ) : (
          <video
            key={`${source.kind}:${String(source.version)}`}
            controls
            preload="metadata"
            src={`${api.mediaUrl(source.relPath)}?v=${String(source.version)}`}
          />
        )}
      </div>
      <p className="export-caption" data-exact={exact ? '' : undefined}>
        {source === null ? t('export.viewer.noneHint') : t(source.labelKey)}
      </p>
      {!exact && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={renderRunning}
          onClick={onRenderPreview}
        >
          {renderRunning ? t('audio.preview.rendering') : t('export.viewer.render')}
        </Button>
      )}
    </div>
  );
}
