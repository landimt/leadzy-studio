import { useEffect, useState, type JSX } from 'react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { StudioDialog, StudioDialogBody } from '@/components/StudioDialog';
import { SPEED_BOUNDS } from '../../../core/schema.js';
import { outputDuration } from '../../../core/timeline.js';
import { t } from '../../i18n/index.js';
import { store } from '../../state/store.js';
import { useStore } from '../../state/hooks.js';
import { RenderedPreviewPanel } from '../export/RenderedPreviewPanel.js';
import { onSpeedToolRequest } from '../shell/toolEvents.js';

const SPEED_PRESETS = [0.75, 1, 1.05, 1.1, 1.25, 1.5] as const;

export function SpeedModal(): JSX.Element | null {
  const state = useStore();
  const [open, setOpen] = useState(false);
  useEffect(
    () =>
      onSpeedToolRequest(() => {
        setOpen(true);
      }),
    [],
  );
  const doc = state.doc;
  if (!doc) return null;
  const speedValue = doc.output.speed ?? 1;
  const montageDuration = outputDuration(doc);
  const estimatedDuration = montageDuration / speedValue;

  return (
    <StudioDialog
      open={open}
      onOpenChange={setOpen}
      title={t('speed.title')}
      description={t('speed.stationDescription')}
      size="lg"
      className="speed-station-dialog max-h-[calc(100vh-24px)] sm:max-w-[800px]"
    >
      <StudioDialogBody maxHeight={540} className="audio-station-body speed-station-body grid">
        <RenderedPreviewPanel
          emptyDetail={t('speed.preview.emptyDetail')}
          parity={t('speed.preview.parity')}
        />

        <section className="audio-controls-panel speed-controls-panel">
          <div className="audio-control-section speed-primary-section">
            <div className="audio-control-heading">
              <div>
                <strong>{t('speed.globalLabel')}</strong>
                <p>{t('speed.explanation')}</p>
              </div>
              <span className="speed-current-value font-mono tabular-nums">{speedValue}×</span>
            </div>

            <div className="flex flex-wrap gap-1">
              {SPEED_PRESETS.map((preset) => (
                <Button
                  key={preset}
                  type="button"
                  size="xs"
                  variant={speedValue === preset ? 'secondary' : 'ghost'}
                  onClick={() => {
                    store.setOutputSpeed(preset);
                  }}
                >
                  {preset}×
                </Button>
              ))}
            </div>

            <Slider
              min={SPEED_BOUNDS.min}
              max={SPEED_BOUNDS.max}
              step={0.01}
              value={[speedValue]}
              aria-label={t('speed.globalLabel')}
              onValueChange={([next]) => {
                if (next !== undefined) store.setOutputSpeed(next);
              }}
            />
            <div className="speed-scale" aria-hidden="true">
              <span>0.5×</span>
              <span>1×</span>
              <span>2×</span>
            </div>

            <div className="speed-duration-readout">
              <span>{t('speed.durationBefore')}</span>
              <b className="font-mono tabular-nums">{montageDuration.toFixed(1)}s</b>
              <span aria-hidden="true">→</span>
              <span>{t('speed.durationAfter')}</span>
              <b className="font-mono tabular-nums">{estimatedDuration.toFixed(1)}s</b>
            </div>
            <p className="speed-footnote">{t('speed.syncHint')}</p>
          </div>
        </section>
      </StudioDialogBody>
    </StudioDialog>
  );
}
