import { useMemo, useRef, useState, type JSX } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { StudioDialog, StudioDialogBody, StudioDialogFooter } from '@/components/StudioDialog';
import { api } from '../../api.js';
import { t, type MessageKey } from '../../i18n/index.js';
import type { EditDoc } from '../../../core/schema.js';
import { store } from '../../state/store.js';
import { type StoreState } from '../../state/storeState.js';
import { useStore } from '../../state/hooks.js';
import {
  clampDenoiseSample,
  denoiseReductionDb,
  roomToneSuggestions,
  type DenoiseSampleInput,
} from './audioSample.js';
import { ProcessedAudioPreviewPanel } from './ProcessedAudioPreviewPanel.js';
import { peaksDuration, RoomToneWaveform } from './RoomToneWaveform.js';

const VOLUME_PRESETS: readonly { readonly lufs: number; readonly labelKey: MessageKey }[] = [
  { lufs: -14, labelKey: 'audio.volume.presetStandard' },
  { lufs: -12, labelKey: 'audio.volume.presetLoud' },
  { lufs: -16, labelKey: 'audio.volume.presetSoft' },
];

function ControlScale({
  start,
  middle,
  middleAt = 50,
  middleBelow = false,
  end,
}: {
  start: string;
  middle?: string;
  middleAt?: number;
  middleBelow?: boolean;
  end: string;
}): JSX.Element {
  return (
    <div className={`audio-slider-scale${middleBelow ? ' middle-below' : ''}`} aria-hidden="true">
      <span>{start}</span>
      {middle ? <span style={{ left: `${String(middleAt)}%` }}>{middle}</span> : null}
      <span>{end}</span>
    </div>
  );
}

function sourceLabel(doc: EditDoc, source: string): string {
  const path = doc.sources[source]?.path ?? source;
  return `${source} · ${path.split('/').pop() ?? path}`;
}

function sourceDuration(state: StoreState, doc: EditDoc, source: string): number | undefined {
  const descriptor = doc.sources[source];
  if (!descriptor) return undefined;
  const media = state.project?.media.find((candidate) => candidate.relPath === descriptor.path);
  return descriptor.durationS ?? (media?.kind === 'image' ? undefined : media?.durationS);
}

function defaultSample(
  doc: EditDoc,
  suggestions: readonly DenoiseSampleInput[],
): DenoiseSampleInput {
  const configured = doc.output.denoiseSample;
  if (configured) return configured;
  const suggested = suggestions[0];
  if (suggested) return suggested;
  return { source: Object.keys(doc.sources)[0] ?? '', start: 0, end: 0.75 };
}

function RoomToneModal({
  state,
  doc,
  onClose,
}: {
  state: StoreState;
  doc: EditDoc;
  onClose: () => void;
}): JSX.Element {
  const suggestions = useMemo(
    () =>
      roomToneSuggestions(
        Object.keys(doc.sources).map((source) => ({
          source,
          intervals: state.silences.get(source) ?? [],
        })),
      ),
    [doc.sources, state.silences],
  );
  const [draft, setDraft] = useState<DenoiseSampleInput>(() => defaultSample(doc, suggestions));
  const [measuredDuration, setMeasuredDuration] = useState<number | undefined>();
  const [auditioning, setAuditioning] = useState(false);
  const [playheadTime, setPlayheadTime] = useState(draft.start);
  const audioRef = useRef<HTMLAudioElement>(null);
  const sources = Object.keys(doc.sources);
  const peaks = state.peaks.get(draft.source);
  const duration =
    measuredDuration ??
    sourceDuration(state, doc, draft.source) ??
    peaksDuration(peaks) ??
    Math.max(draft.end, 2);
  const selectedSuggestions = suggestions.filter((sample) => sample.source === draft.source);
  const sourcePath = doc.sources[draft.source]?.path;

  const updateDraft = (sample: DenoiseSampleInput): void => {
    const clamped = clampDenoiseSample(sample, duration);
    if (!clamped) return;
    setDraft(clamped);
    setPlayheadTime(clamped.start);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = clamped.start;
    }
  };

  const chooseSource = (source: string): void => {
    setMeasuredDuration(undefined);
    const suggestion = suggestions.find((sample) => sample.source === source);
    const candidate = suggestion ?? { source, start: 0, end: 0.75 };
    const knownDuration = sourceDuration(state, doc, source);
    const next = clampDenoiseSample(candidate, knownDuration) ?? candidate;
    setDraft(next);
    setPlayheadTime(next.start);
    setAuditioning(false);
  };

  const audition = (): void => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = draft.start;
    setPlayheadTime(draft.start);
    setAuditioning(true);
    void audio.play().catch(() => {
      setAuditioning(false);
    });
  };

  return (
    <StudioDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('audio.roomTone.title')}
      description={t('audio.roomTone.description')}
      size="lg"
      className="room-tone-dialog max-h-[calc(100vh-24px)] sm:max-w-[900px]"
    >
      <StudioDialogBody className="room-tone-body grid">
        <div className="room-tone-toolbar">
          <label className="room-tone-field">
            <span>{t('audio.roomTone.source')}</span>
            <Select value={draft.source} onValueChange={chooseSource}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sources.map((source) => (
                  <SelectItem key={source} value={source}>
                    {sourceLabel(doc, source)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <Button
            type="button"
            size="sm"
            variant={auditioning ? 'secondary' : 'outline'}
            disabled={!sourcePath}
            onClick={audition}
          >
            {auditioning ? t('audio.roomTone.listening') : t('audio.roomTone.listen')}
          </Button>
        </div>

        {sourcePath ? (
          <audio
            ref={audioRef}
            key={sourcePath}
            preload="metadata"
            src={api.mediaUrl(sourcePath)}
            onLoadedMetadata={(event) => {
              const nextDuration = event.currentTarget.duration;
              if (Number.isFinite(nextDuration)) setMeasuredDuration(nextDuration);
            }}
            onTimeUpdate={(event) => {
              const time = event.currentTarget.currentTime;
              setPlayheadTime(time);
              if (auditioning && time >= draft.end) {
                event.currentTarget.pause();
                event.currentTarget.currentTime = draft.start;
                setPlayheadTime(draft.start);
                setAuditioning(false);
              }
            }}
            onPause={() => {
              setAuditioning(false);
            }}
          />
        ) : null}

        <RoomToneWaveform
          peaks={peaks}
          duration={duration}
          suggestions={selectedSuggestions}
          selection={draft}
          playhead={playheadTime}
          onSelectionChange={updateDraft}
        />
        <p className="room-tone-direct-hint">
          {selectedSuggestions.length > 0
            ? t('audio.roomTone.waveformHint')
            : t('audio.roomTone.noDetected')}
        </p>
      </StudioDialogBody>
      <StudioDialogFooter className="sm:justify-between">
        <Button
          type="button"
          variant="ghost"
          size="lg"
          onClick={() => {
            store.setDenoiseSample(null);
            onClose();
          }}
        >
          {t('audio.roomTone.useAutomatic')}
        </Button>
        <span className="flex-1" />
        <Button type="button" variant="outline" size="lg" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          type="button"
          size="lg"
          disabled={draft.source.length === 0}
          onClick={() => {
            store.setDenoiseSample(draft);
            onClose();
          }}
        >
          {t('audio.roomTone.confirm')}
        </Button>
      </StudioDialogFooter>
    </StudioDialog>
  );
}

/** Project output processing, proven against the rendered preview beside it. */
export function AudioModal(): JSX.Element | null {
  const state = useStore();
  const [roomToneOpen, setRoomToneOpen] = useState(false);
  const doc = state.doc;
  if (!doc) return null;
  const output = doc.output;
  const normalized = output.loudnormLufs !== null;
  const lufs = output.loudnormLufs ?? -14;
  const denoiseValue = output.denoise ?? 0;
  const crossfadeMs = output.joinAudioCrossfadeMs ?? 0;

  return (
    <>
      <StudioDialog
        open={state.audioOpen && !roomToneOpen}
        onOpenChange={(open) => {
          if (!open) store.setAudioOpen(false);
        }}
        title={t('audio.title')}
        description={t('audio.stationDescription')}
        size="lg"
        className="audio-station-dialog max-h-[calc(100vh-24px)] sm:max-w-[940px]"
      >
        <StudioDialogBody maxHeight={590} className="audio-station-body grid">
          <ProcessedAudioPreviewPanel />

          <section className="audio-controls-panel">
            <div className="audio-control-section">
              <div className="audio-control-heading">
                <div>
                  <strong>{t('audio.denoise.label')}</strong>
                  <p>{t('audio.denoise.explanation')}</p>
                </div>
                <span className="font-mono tabular-nums">
                  {denoiseValue === 0
                    ? t('audio.off')
                    : `${String(Math.round(denoiseValue * 100))}% · ${String(denoiseReductionDb(denoiseValue))} dB`}
                </span>
              </div>
              <Slider
                min={0}
                max={1}
                step={0.05}
                value={[denoiseValue]}
                aria-label={t('audio.denoise.label')}
                onValueChange={([next]) => {
                  if (next !== undefined) store.setDenoise(next);
                }}
              />
              <ControlScale
                start={t('audio.denoise.scaleOff')}
                middle={t('audio.denoise.scaleMedium')}
                end={t('audio.denoise.scaleStrong')}
              />
              <p className="audio-control-note">{t('audio.denoise.hint')}</p>
              <div className="audio-room-tone-row">
                <div>
                  <span>{t('audio.roomTone.label')}</span>
                  <strong>
                    {output.denoiseSample
                      ? `${sourceLabel(doc, output.denoiseSample.source)} · ${output.denoiseSample.start.toFixed(2)}–${output.denoiseSample.end.toFixed(2)}s`
                      : t('audio.roomTone.automatic')}
                  </strong>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setRoomToneOpen(true);
                  }}
                >
                  {t('audio.roomTone.choose')}
                </Button>
              </div>
            </div>

            <div className="audio-control-section">
              <label className="audio-control-heading">
                <div>
                  <strong>{t('audio.normalize')}</strong>
                  <p>{t('audio.normalize.explanation')}</p>
                </div>
                <Checkbox
                  checked={normalized}
                  onCheckedChange={(next) => {
                    store.setLoudnormEnabled(next === true);
                  }}
                />
              </label>
              {normalized ? (
                <>
                  <div className="audio-value-row">
                    <span>{t('audio.volume.label')}</span>
                    <span className="font-mono tabular-nums">{lufs} LUFS</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {VOLUME_PRESETS.map((preset) => (
                      <Button
                        key={preset.lufs}
                        type="button"
                        size="xs"
                        variant={lufs === preset.lufs ? 'secondary' : 'ghost'}
                        onClick={() => {
                          store.setLoudnormLufs(preset.lufs);
                        }}
                      >
                        {t(preset.labelKey)}
                      </Button>
                    ))}
                  </div>
                  <Slider
                    min={-24}
                    max={-9}
                    step={1}
                    value={[lufs]}
                    aria-label={t('audio.volume.label')}
                    onValueChange={([next]) => {
                      if (next !== undefined) store.setLoudnormLufs(next);
                    }}
                  />
                  <ControlScale
                    start={t('audio.volume.scaleSoft')}
                    middle={t('audio.volume.scaleSocial')}
                    middleAt={66.67}
                    end={t('audio.volume.scaleStrong')}
                  />
                </>
              ) : null}
            </div>

            <div className="audio-control-section">
              <div className="audio-control-heading">
                <div>
                  <strong>{t('audio.crossfade.label')}</strong>
                  <p>{t('audio.crossfade.explanation')}</p>
                </div>
                <span className="font-mono tabular-nums">{crossfadeMs}ms</span>
              </div>
              <Slider
                min={0}
                max={200}
                step={10}
                value={[crossfadeMs]}
                aria-label={t('audio.crossfade.label')}
                onValueChange={([next]) => {
                  if (next !== undefined) store.setJoinAudioCrossfadeMs(next);
                }}
              />
              <ControlScale
                start={t('audio.crossfade.scaleDry')}
                middle={t('audio.crossfade.scaleSuggested')}
                middleAt={10}
                middleBelow
                end={t('audio.crossfade.scaleSmooth')}
              />
            </div>
          </section>
        </StudioDialogBody>
      </StudioDialog>

      {roomToneOpen ? (
        <RoomToneModal
          state={state}
          doc={doc}
          onClose={() => {
            setRoomToneOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
