import { useState, type JSX } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StudioDialogError } from '@/components/StudioDialog';
import { api } from '../../api.js';
import { t } from '../../i18n/index.js';
import { store } from '../../state/store.js';
import { useStore } from '../../state/hooks.js';

/** The exact rendered proof shared by processing tools, with context-specific copy. */
export function RenderedPreviewPanel({
  emptyDetail,
  parity,
}: {
  emptyDetail: string;
  parity: string;
}): JSX.Element {
  const state = useStore();
  const [renderError, setRenderError] = useState<string | null>(null);
  const renderJob = state.activeJobs.get('render');
  const renderRunning = renderJob !== undefined;
  const hasPreview = state.project?.hasPreview === true;
  const previewStatus = renderRunning
    ? t('audio.preview.rendering')
    : !hasPreview
      ? t('audio.preview.missing')
      : state.previewOutdated
        ? t('audio.preview.outdated')
        : t('audio.preview.current');

  const renderPreview = async (): Promise<void> => {
    setRenderError(null);
    if (!(await store.flushSave())) {
      setRenderError(t('audio.preview.saveFailed'));
      return;
    }
    try {
      await api.startRender({ preview: true });
    } catch (cause) {
      setRenderError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <section className="audio-preview-panel">
      <div className="audio-preview-stage">
        {hasPreview ? (
          <video
            key={state.previewVersion}
            controls
            preload="metadata"
            src={`${api.mediaUrl('edit/preview.mp4')}?v=${String(state.previewVersion)}`}
          />
        ) : (
          <div className="audio-preview-empty">
            <span aria-hidden="true">▶</span>
            <strong>{t('audio.preview.emptyTitle')}</strong>
            <p>{emptyDetail}</p>
          </div>
        )}
      </div>
      <div className="audio-preview-meta">
        <Badge
          variant="outline"
          className={state.previewOutdated || !hasPreview ? 'audio-preview-stale' : ''}
        >
          {previewStatus}
        </Badge>
        {renderJob?.progress ? (
          <span className="font-mono tabular-nums">{renderJob.progress}</span>
        ) : null}
      </div>
      <p>{parity}</p>
      <Button
        type="button"
        size="lg"
        className="w-full"
        disabled={renderRunning}
        onClick={() => {
          void renderPreview();
        }}
      >
        {renderRunning ? t('audio.preview.rendering') : t('audio.preview.update')}
      </Button>
      <StudioDialogError>{renderError}</StudioDialogError>
    </section>
  );
}
