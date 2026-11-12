import { useEffect, useRef, useState, type JSX } from 'react';
import { FolderOpenIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { StudioDialog, StudioDialogError, StudioDialogFooter } from '@/components/StudioDialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { isValidH264OutputDimensions } from '../../../core/schema.js';
import { resolveExportFilename } from '../../../core/exportFilename.js';
import type { RenderQuality } from '../../../core/render/options.js';
import { api, type SettingsInfo } from '../../api.js';
import { desktopBridge } from '../../lib/desktop.js';
import { t, tf } from '../../i18n/index.js';
import { store } from '../../state/store.js';
import { useStore } from '../../state/hooks.js';
import { requestSpeedTool } from '../shell/toolEvents.js';
import { summarizeRenderProgress } from '../player/renderProgress.js';
import { DeliveryViewer } from './DeliveryViewer.js';
import {
  type ExportDeliveryChoice,
  initialDeliveryChoice,
  rememberDeliveryChoice,
} from './exportPreference.js';
import {
  audioSpeedSummary,
  EXPORT_RESOLUTION_TIERS,
  exportDimensionsForTier,
  exportDurationSeconds,
  exportResolutionTierForDimensions,
  type ExportResolutionTier,
} from './exportSummary.js';
import { exportViewerSource } from './exportViewerSource.js';

const QUALITY_OPTIONS: readonly { value: RenderQuality; label: string; hint: string }[] = [
  { value: 'recommended', label: t('export.quality.recommended'), hint: 'CRF 20' },
  { value: 'high', label: t('export.quality.high'), hint: 'CRF 18' },
  { value: 'max', label: t('export.quality.max'), hint: 'CRF 16' },
];

function projectName(projectDir: string): string {
  return projectDir.split('/').filter(Boolean).at(-1) ?? projectDir;
}

/**
 * Export: what will ship on the left, playable; what decides the delivery on
 * the right. Stays open through the render and then plays the file written.
 */
export function ExportDialog(): JSX.Element | null {
  const state = useStore();
  const bridge = desktopBridge();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [delivery, setDelivery] = useState<ExportDeliveryChoice | null>(null);
  const [quality, setQuality] = useState<RenderQuality>('recommended');
  const [burnSubtitles, setBurnSubtitles] = useState(true);
  const [copied, setCopied] = useState(false);
  const submittedAtRef = useRef<number | null>(null);
  const submittingRef = useRef(false);
  const doc = state.doc;
  const projectDir = state.project?.projectDir ?? '';
  const currentDimensions = doc
    ? { width: doc.output.width, height: doc.output.height }
    : { width: 1080, height: 1920 };
  const currentResolutionTier = exportResolutionTierForDimensions(currentDimensions);
  const currentResolutionValue: ExportResolutionTier | 'current' =
    currentResolutionTier ?? 'current';
  const [resolutionTier, setResolutionTier] = useState<ExportResolutionTier | 'current'>(
    currentResolutionValue,
  );

  useEffect(() => {
    if (!state.exportOpen) return;
    setResolutionTier(currentResolutionValue);
    setQuality('recommended');
    setBurnSubtitles(true);
    setError(null);
    setCopied(false);
    setSettings(null);
    setDelivery(null);
    submittedAtRef.current = null;
    void api
      .getSettings()
      .then((loaded) => {
        setSettings(loaded);
        setDelivery(initialDeliveryChoice(projectDir, loaded.preferences));
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [currentResolutionValue, projectDir, state.exportOpen]);

  if (!doc) return null;

  const renderJob = state.activeJobs.get('render');
  const submittedAt = submittedAtRef.current;
  const exported =
    submittedAt !== null && state.lastExport !== null && state.lastExport.at >= submittedAt;
  const rendering = submittedAt !== null && !exported && renderJob !== undefined;
  const phase: 'form' | 'rendering' | 'done' = exported ? 'done' : rendering ? 'rendering' : 'form';
  const renderFailed = submittedAt !== null && !exported && !rendering && state.renderError;

  const selectedDimensions =
    resolutionTier === 'current'
      ? currentDimensions
      : exportDimensionsForTier(currentDimensions, resolutionTier);
  const selectedDimensionsValid = isValidH264OutputDimensions(selectedDimensions);
  const durationS = exportDurationSeconds(doc);
  const previewFresh = state.project?.hasPreview === true && !state.previewOutdated;
  const programFresh = state.project?.hasProgram === true && !state.programOutdated;
  const source = exportViewerSource({
    finalJustExported: exported,
    previewFresh,
    programFresh,
    finalVersion: state.finalVersion,
    previewVersion: state.previewVersion,
    programVersion: state.programVersion,
  });
  const filename = delivery
    ? resolveExportFilename(delivery.pattern, projectName(projectDir), new Date())
    : null;
  const folderMissing = delivery?.mode === 'folder' && delivery.directory.trim() === '';

  const close = (): void => {
    if (submittingRef.current) return;
    store.setExportOpen(false);
  };
  const patchDelivery = (patch: Partial<ExportDeliveryChoice>): void => {
    setDelivery((current) => (current ? { ...current, ...patch } : current));
  };
  const chooseFolder = async (): Promise<void> => {
    if (bridge === null || delivery === null) return;
    const chosen = await bridge.chooseDirectory({
      title: t('settings.export.folder'),
      ...(delivery.directory ? { defaultPath: delivery.directory } : {}),
    });
    if (chosen) patchDelivery({ directory: chosen });
  };
  const renderPreview = async (): Promise<void> => {
    setError(null);
    if (!(await store.flushSave())) return;
    try {
      store.requestPreviewRender();
      await api.startRender({ preview: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const confirm = async (): Promise<void> => {
    if (submittingRef.current || renderJob !== undefined || delivery === null) return;
    if (!selectedDimensionsValid) {
      setError(t('export.resolution.invalid'));
      return;
    }
    if (folderMissing) {
      if (bridge === null) {
        setError(t('export.folder.missing'));
        return;
      }
      await chooseFolder();
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      if (
        selectedDimensions.width !== doc.output.width ||
        selectedDimensions.height !== doc.output.height
      ) {
        store.setOutputSize(selectedDimensions.width, selectedDimensions.height);
      }
      if (!(await store.flushSave())) return;
      rememberDeliveryChoice(projectDir, delivery);
      submittedAtRef.current = Date.now();
      store.dismissError();
      await api.startRender({
        preview: false,
        quality,
        subtitles: burnSubtitles,
        reveal: delivery.reveal,
        filenamePattern: delivery.pattern,
        deliveryDirectory: delivery.mode === 'folder' ? delivery.directory.trim() : null,
      });
    } catch (cause) {
      submittedAtRef.current = null;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };
  const exportedPath =
    state.lastExport?.deliveryPath ?? `${projectDir}/${state.lastExport?.outputRel ?? ''}`;
  const copyPath = (): void => {
    const write = bridge
      ? bridge.copyText(exportedPath)
      : navigator.clipboard.writeText(exportedPath);
    void write.then(() => {
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 1500);
    });
  };
  const revealExported = (): void => {
    const lastExport = state.lastExport;
    if (!lastExport) return;
    const reveal = lastExport.deliveryPath
      ? bridge?.revealExternalPath(lastExport.deliveryPath)
      : api.revealPath(lastExport.outputRel);
    void reveal?.catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };
  const progress = summarizeRenderProgress(renderJob?.progress);

  return (
    <StudioDialog
      open={state.exportOpen}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={phase === 'done' ? t('export.done.title') : t('export.title')}
      description={phase === 'form' ? t('export.description') : ''}
      className="export-dialog sm:max-w-[960px]"
    >
      <div className="export-body">
        <DeliveryViewer
          source={source}
          frame={{ width: doc.output.width, height: doc.output.height }}
          renderRunning={renderJob !== undefined}
          onRenderPreview={() => {
            void renderPreview();
          }}
        />

        {phase === 'rendering' && (
          <div className="export-form">
            <div className="export-progress" role="status" aria-live="polite">
              <strong>
                {progress === null
                  ? t('export.rendering')
                  : tf(
                      progress.phase === 'segments'
                        ? 'export.rendering.segments'
                        : 'export.rendering.steps',
                      { done: String(progress.done), total: String(progress.total) },
                    )}
              </strong>
              {progress !== null && (
                <span className="export-progress-bar" aria-hidden="true">
                  <span
                    style={{
                      width: `${String(Math.round((progress.done / progress.total) * 100))}%`,
                    }}
                  />
                </span>
              )}
              <p>{t('export.rendering.hint')}</p>
            </div>
          </div>
        )}

        {phase === 'done' && state.lastExport !== null && (
          <div className="export-form">
            <div className="export-group">
              <span className="export-eyebrow">{t('export.done.file')}</span>
              <div className="export-path">
                <span className="export-path-field" title={exportedPath}>
                  {exportedPath}
                </span>
                <Button type="button" variant="outline" size="sm" onClick={copyPath}>
                  {copied ? t('export.done.copied') : t('export.done.copy')}
                </Button>
              </div>
            </div>
            <div className="export-group">
              <span className="export-eyebrow">{t('export.done.summary')}</span>
              <p className="export-techline">
                {String(doc.output.width)} × {String(doc.output.height)} · H.264{' '}
                {QUALITY_OPTIONS.find((option) => option.value === quality)?.hint} ·{' '}
                {String(doc.fps)} fps · AAC 192 kb/s ·{' '}
                {burnSubtitles && doc.subtitles.enabled
                  ? t('export.subtitles.burn')
                  : t('export.subtitles.disabled')}{' '}
                · {state.lastExport.durationS.toFixed(1)}s
              </p>
            </div>
          </div>
        )}

        {phase === 'form' && (
          <div className="export-form">
            <div className="export-group">
              <span className="export-eyebrow">{t('export.videoSection')}</span>
              <div className="export-row">
                <span className="export-key">{t('export.resolution')}</span>
                <div className="flex min-w-0 flex-col gap-1">
                  <Select
                    value={resolutionTier}
                    disabled={submitting}
                    onValueChange={(next) => {
                      setError(null);
                      setResolutionTier(next as ExportResolutionTier | 'current');
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      className="h-8 w-full bg-background"
                      aria-invalid={!selectedDimensionsValid}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {currentResolutionTier === null && (
                        <SelectItem value="current">
                          {t('export.resolution.current')} · {String(currentDimensions.width)} ×{' '}
                          {String(currentDimensions.height)}
                        </SelectItem>
                      )}
                      {EXPORT_RESOLUTION_TIERS.map((tier) => {
                        const dimensions = exportDimensionsForTier(currentDimensions, tier);
                        return (
                          <SelectItem
                            key={tier}
                            value={tier}
                            disabled={!isValidH264OutputDimensions(dimensions)}
                          >
                            {tier} · {String(dimensions.width)} × {String(dimensions.height)}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                  {!selectedDimensionsValid && (
                    <p className="text-[10px] leading-tight text-destructive">
                      {t('export.resolution.invalid')}
                    </p>
                  )}
                </div>
              </div>
              <div className="export-row">
                <span className="export-key">{t('export.quality')}</span>
                <Tabs
                  value={quality}
                  onValueChange={(value) => {
                    setQuality(value as RenderQuality);
                  }}
                >
                  <TabsList
                    className="inline-flex h-8 w-auto p-0.5"
                    aria-label={t('export.quality')}
                  >
                    {QUALITY_OPTIONS.map((option) => (
                      <TabsTrigger
                        key={option.value}
                        value={option.value}
                        title={option.hint}
                        disabled={submitting}
                        className="h-7 px-3 text-[11px]"
                      >
                        {option.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              </div>
              <div className="export-row">
                <span className="export-key">{t('export.subtitles')}</span>
                <label className="export-check">
                  <Checkbox
                    checked={burnSubtitles}
                    disabled={submitting || !doc.subtitles.enabled}
                    onCheckedChange={(checked) => {
                      setBurnSubtitles(checked === true);
                    }}
                  />
                  {doc.subtitles.enabled
                    ? t('export.subtitles.burn')
                    : t('export.subtitles.disabled')}
                </label>
              </div>
              <div className="export-row">
                <span className="export-key" />
                <span className="export-techline">
                  H.264 · MP4 · {String(doc.fps)} fps · AAC 192 kb/s · 48 kHz ·{' '}
                  {t('export.audio.stereo')}
                </span>
              </div>
            </div>

            <div className="export-group">
              <span className="export-eyebrow">{t('export.audioSection')}</span>
              <div className="export-inline">
                <span className="export-techline">{audioSpeedSummary(doc.output)}</span>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  disabled={submitting}
                  onClick={() => {
                    close();
                    store.setAudioOpen(true);
                  }}
                >
                  {t('export.audioSpeed.adjustAudioLink')}
                </Button>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  disabled={submitting}
                  onClick={() => {
                    close();
                    requestSpeedTool();
                  }}
                >
                  {t('export.audioSpeed.adjustSpeedLink')}
                </Button>
              </div>
            </div>

            <div className="export-group">
              <span className="export-eyebrow">{t('export.deliverySection')}</span>
              {delivery === null ? (
                <span className="export-techline">{t('export.loadingPreferences')}</span>
              ) : (
                <>
                  <div className="export-row">
                    <span className="export-key">{t('export.destination')}</span>
                    <Tabs
                      value={delivery.mode}
                      onValueChange={(mode) => {
                        patchDelivery({ mode: mode as ExportDeliveryChoice['mode'] });
                      }}
                    >
                      <TabsList
                        className="inline-flex h-8 w-auto p-0.5"
                        aria-label={t('export.destination')}
                      >
                        <TabsTrigger
                          value="project"
                          disabled={submitting}
                          className="h-7 px-3 text-[11px]"
                        >
                          {t('export.destination.project')}
                        </TabsTrigger>
                        <TabsTrigger
                          value="folder"
                          disabled={submitting}
                          className="h-7 px-3 text-[11px]"
                        >
                          {t('export.destination.folder')}
                        </TabsTrigger>
                      </TabsList>
                    </Tabs>
                  </div>
                  {delivery.mode === 'folder' && (
                    <div className="export-row">
                      <span className="export-key" />
                      <div className="export-path">
                        <Input
                          className="h-8 font-mono text-xs md:text-xs"
                          value={delivery.directory}
                          placeholder={t('settings.export.folder.empty')}
                          spellCheck={false}
                          disabled={submitting}
                          onChange={(event) => {
                            patchDelivery({ directory: event.target.value });
                          }}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={bridge === null || submitting}
                          onClick={() => {
                            void chooseFolder();
                          }}
                        >
                          <FolderOpenIcon />
                          {t('settings.choose')}
                        </Button>
                      </div>
                    </div>
                  )}
                  <div className="export-row">
                    <span className="export-key">{t('export.filename')}</span>
                    <div className="export-path">
                      <Input
                        className="h-8 font-mono text-xs md:text-xs"
                        value={delivery.pattern}
                        spellCheck={false}
                        disabled={submitting || delivery.mode === 'project'}
                        onChange={(event) => {
                          patchDelivery({ pattern: event.target.value });
                        }}
                      />
                      <span className="export-filename-preview" title={filename ?? ''}>
                        {delivery.mode === 'project' ? 'edit/final.mp4' : (filename ?? '')}
                      </span>
                    </div>
                  </div>
                  <div className="export-row">
                    <span className="export-key" />
                    <label className="export-check">
                      <Checkbox
                        checked={delivery.reveal}
                        disabled={submitting}
                        onCheckedChange={(checked) => {
                          patchDelivery({ reveal: checked === true });
                        }}
                      />
                      {t('export.reveal')}
                    </label>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
      <StudioDialogError>{error ?? (renderFailed ? state.renderError : null)}</StudioDialogError>
      <StudioDialogFooter className="export-footer">
        <span className="export-footer-sum">
          {t('export.duration')} <b>{durationS.toFixed(1)}s</b>
          {settings === null && phase === 'form' ? ` · ${t('export.loadingPreferences')}` : ''}
        </span>
        {phase === 'done' ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={() => {
                submittedAtRef.current = null;
                setCopied(false);
              }}
            >
              {t('export.done.again')}
            </Button>
            <Button
              type="button"
              size="lg"
              disabled={state.lastExport?.deliveryPath !== undefined && bridge === null}
              onClick={revealExported}
            >
              {t('export.success.reveal')}
            </Button>
          </>
        ) : phase === 'rendering' ? (
          <Button type="button" variant="outline" size="lg" onClick={close}>
            {t('export.rendering.background')}
          </Button>
        ) : (
          <>
            <Button type="button" variant="outline" size="lg" disabled={submitting} onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="lg"
              disabled={
                submitting ||
                renderJob !== undefined ||
                !selectedDimensionsValid ||
                delivery === null
              }
              onClick={() => {
                void confirm();
              }}
            >
              {submitting ? t('export.submitting') : t('export.confirm')}
            </Button>
          </>
        )}
      </StudioDialogFooter>
    </StudioDialog>
  );
}
