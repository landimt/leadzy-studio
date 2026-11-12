import { useEffect, useRef, useState, type JSX } from 'react';
import { LoaderCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StudioDialog } from '@/components/StudioDialog';
import { api } from '../../api.js';
import { desktopBridge } from '../../lib/desktop.js';
import { t } from '../../i18n/index.js';
import { store } from '../../state/store.js';
import { useStore } from '../../state/hooks.js';
import { AudioModal } from '../audio/AudioModal.js';
import { ExportDialog } from '../export/ExportDialog.js';
import { ClipRangeDialog } from '../timeline/ClipRangeDialog.js';
import { HistoryModal } from '../history/HistoryModal.js';
import { DebugPanel } from '../debug/DebugPanel.js';
import { SettingsModal } from '../settings/SettingsModal.js';
import { TranscriptionModal } from '../transcription/TranscriptionModal.js';
import { SpeedModal } from '../audio/SpeedModal.js';
import { formatEditorDuration } from './statusFormat.js';

/**
 * The rendered `edit/preview.mp4` — opens automatically once a user-requested
 * preview render finishes while playback is paused (see `store.requestPreviewRender`);
 * otherwise the caller shows the "ready" banner in `StatusBar` and this stays a click away.
 * Keyed on `previewVersion` (not just the `src` query string) so a second preview
 * render while the dialog is already closed always mounts a fresh, re-fetched element.
 */
function PreviewViewerModal(): JSX.Element | null {
  const state = useStore();
  if (state.project?.hasPreview !== true) return null;
  const durationS = state.lastPreviewRender?.durationS ?? state.doc?.totalDurationS;
  const output = state.doc?.output;
  const landscape = output !== undefined && output.width >= output.height;
  return (
    <StudioDialog
      open={state.previewViewerOpen}
      onOpenChange={(open) => {
        store.setPreviewViewerOpen(open);
      }}
      title={t('preview.viewer.title')}
      description={t('review.preview.detail')}
      size={landscape ? 'lg' : 'sm'}
      className="preview-viewer-modal"
    >
      <div className="grid place-items-center overflow-hidden rounded-[var(--r-md)] bg-black">
        <video
          key={state.previewVersion}
          className="block max-h-[72svh] w-full bg-black object-contain"
          controls
          autoPlay
          playsInline
          style={{
            aspectRatio:
              output === undefined
                ? '9 / 16'
                : `${String(output.width)} / ${String(output.height)}`,
          }}
          src={`/api/media/${encodeURIComponent('edit/preview.mp4')}?v=${String(state.previewVersion)}`}
        />
      </div>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>
          {output === undefined ? '—' : `${String(output.width)} × ${String(output.height)}`}
        </span>
        <span className="font-mono tabular-nums">
          {durationS === undefined ? '—' : formatEditorDuration(durationS)}
        </span>
      </div>
    </StudioDialog>
  );
}

/** Transient feedback only: the rendered artifact stays in the store after this toast leaves. */
function PreviewReadyToast(): JSX.Element | null {
  const state = useStore();
  const [open, setOpen] = useState(false);
  const announcedVersion = useRef(-1);

  useEffect(() => {
    if (!state.lastPreviewRender || state.previewOutdated) {
      setOpen(false);
      return;
    }
    if (state.previewViewerOpen || announcedVersion.current === state.previewVersion) return;
    announcedVersion.current = state.previewVersion;
    setOpen(true);
    const timer = setTimeout(() => {
      setOpen(false);
    }, 5200);
    return () => {
      clearTimeout(timer);
    };
  }, [
    state.lastPreviewRender,
    state.previewOutdated,
    state.previewVersion,
    state.previewViewerOpen,
  ]);

  if (!open || !state.lastPreviewRender) return null;
  return (
    <div className="preview-ready-toast" role="status" aria-live="polite" aria-atomic="true">
      <span className="preview-ready-mark" aria-hidden="true">
        ✓
      </span>
      <div>
        <strong>{t('preview.ready.shortLabel')}</strong>
        <span>{t('preview.ready.detail')}</span>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          setOpen(false);
          store.setPreviewViewerOpen(true);
        }}
      >
        {t('preview.ready.watch')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t('common.close')}
        title={t('common.close')}
        onClick={() => {
          setOpen(false);
        }}
      >
        ✕
      </Button>
    </div>
  );
}

export function StatusBar(): JSX.Element | null {
  const state = useStore();
  const bridge = desktopBridge();
  // the render job owns the bar when present; anything else shows in insertion order
  const job = state.activeJobs.get('render') ?? [...state.activeJobs.values()][0] ?? null;
  const lastRender = state.lastRender;

  const jobLabel =
    job?.type === 'render'
      ? t('jobs.rendering')
      : job?.type === 'transcribe'
        ? t('jobs.transcribing')
        : job?.type === 'qa'
          ? t('jobs.qa')
          : job?.type === 'suggest'
            ? t('jobs.suggest')
            : job?.type === 'title'
              ? t('jobs.title')
              : job?.type === 'library-overlay'
                ? t('jobs.libraryOverlay')
                : null;

  return (
    <div>
      {state.renderError !== null && (
        <div className="banner error">
          <span>{t('jobs.renderError')}</span>
          <pre>{state.renderError}</pre>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={() => {
              store.dismissError();
            }}
          >
            ✕
          </Button>
        </div>
      )}
      {lastRender !== null && (
        <div className="banner success">
          <span>
            ✓ {lastRender.deliveryName ?? lastRender.outputRel} {t('export.success.generated')} —{' '}
            <span className="font-mono tabular-nums">{lastRender.durationS.toFixed(1)}s</span>
          </span>
          <span className="flex-1" />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={lastRender.deliveryPath !== undefined && bridge === null}
            onClick={() => {
              const reveal = lastRender.deliveryPath
                ? bridge?.revealExternalPath(lastRender.deliveryPath)
                : api.revealPath(lastRender.outputRel);
              void reveal?.catch((cause: unknown) => {
                store.showError(cause instanceof Error ? cause.message : String(cause));
              });
            }}
          >
            {t('export.success.reveal')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={() => {
              store.dismissLastRender();
            }}
          >
            ✕
          </Button>
        </div>
      )}
      <PreviewReadyToast />
      {jobLabel && (
        <div className="statusbar" role="status" aria-live="polite" aria-atomic="true">
          <span className="statusbar-indicator" aria-hidden="true">
            <LoaderCircleIcon />
          </span>
          <div className="statusbar-copy">
            <strong>{jobLabel}</strong>
            {job?.progress ? <span className="progress">{job.progress}</span> : null}
          </div>
        </div>
      )}
      <ExportDialog />
      <ClipRangeDialog />
      <PreviewViewerModal />
      <HistoryModal />
      <SettingsModal />
      <DebugPanel />
      <TranscriptionModal />
      <AudioModal />
      <SpeedModal />
    </div>
  );
}
