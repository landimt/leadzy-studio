import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type MouseEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StudioDialogError } from '@/components/StudioDialog';
import { api } from '../../api.js';
import { t } from '../../i18n/index.js';
import { store } from '../../state/store.js';
import { useStore } from '../../state/hooks.js';
import {
  audioComparisonDuration,
  audioTimeAtFraction,
  audioTimeFromSliderKey,
  boundedAudioTime,
  buildAudioWaveformEnvelope,
  formatAudioClock,
  formatAudioPosition,
  sharedAudioWaveformPeak,
  type AudioWaveformEnvelope,
} from './processedAudioWaveform.js';
import { AudioComparisonTransport, type AudioPreviewVariant } from './processedAudioTransport.js';

type AudioVariant = AudioPreviewVariant;
type DecodedWaveform =
  | { readonly src: string; readonly state: 'ready'; readonly envelope: AudioWaveformEnvelope }
  | { readonly src: string; readonly state: 'error' };
type WaveformState =
  | { readonly state: 'loading' }
  | { readonly state: 'error' }
  | { readonly state: 'ready'; readonly envelope: AudioWaveformEnvelope };

function useDecodedWaveform(src: string): WaveformState {
  const [decoded, setDecoded] = useState<DecodedWaveform | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const load = async (): Promise<void> => {
      let context: AudioContext | null = null;
      try {
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok) throw new Error(`audio preview ${String(response.status)}`);
        if (typeof AudioContext === 'undefined') throw new Error('Web Audio unavailable');
        context = new AudioContext();
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
          buffer.getChannelData(channel),
        );
        const envelope = buildAudioWaveformEnvelope(channels, 900);
        if (!disposed) setDecoded({ src, state: 'ready', envelope });
      } catch (error) {
        if (!disposed && !(error instanceof DOMException && error.name === 'AbortError')) {
          setDecoded({ src, state: 'error' });
        }
      } finally {
        if (context) void context.close();
      }
    };
    void load();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [src]);

  if (decoded?.src !== src) return { state: 'loading' };
  return decoded.state === 'ready'
    ? { state: 'ready', envelope: decoded.envelope }
    : { state: 'error' };
}

function ComparisonWaveform({
  variant,
  label,
  detail,
  waveform,
  amplitudePeak,
  durationS,
  currentTimeS,
  active,
  onSeek,
}: {
  variant: AudioVariant;
  label: string;
  detail: string;
  waveform: WaveformState;
  amplitudePeak: number;
  durationS: number;
  currentTimeS: number;
  active: boolean;
  onSeek: (timeS: number) => void;
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(420);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const update = (): void => {
      setWidth(Math.max(2, Math.round(root.getBoundingClientRect().width)));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || waveform.state !== 'ready') return;
    const height = 72;
    const density = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * density);
    canvas.height = Math.round(height * density);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(density, 0, 0, density, 0, 0);
    context.clearRect(0, 0, width, height);

    const rootStyle = getComputedStyle(document.documentElement);
    const centerLine = rootStyle.getPropertyValue('--chrome-line').trim();
    const audioColor = rootStyle.getPropertyValue(active ? '--data-audio' : '--ink-muted').trim();
    context.fillStyle = centerLine;
    context.fillRect(0, height / 2, width, 1);

    const { min, max } = waveform.envelope;
    const mid = height / 2;
    context.fillStyle = audioColor;
    for (let x = 0; x < width; x += 1) {
      const bucket = Math.min(min.length - 1, Math.floor((x * min.length) / width));
      const top = mid + ((min[bucket] ?? 0) / amplitudePeak) * mid * 0.8;
      const bottom = mid + ((max[bucket] ?? 0) / amplitudePeak) * mid * 0.8;
      context.fillRect(x, Math.min(top, bottom), 1, Math.max(1, Math.abs(bottom - top)));
    }
  }, [active, amplitudePeak, waveform, width]);

  const seekFromPointer = (event: MouseEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    onSeek(audioTimeAtFraction((event.clientX - rect.left) / rect.width, durationS));
  };

  const seekFromKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    const nextTimeS = audioTimeFromSliderKey(event.key, currentTimeS, durationS);
    if (nextTimeS === null) return;
    event.preventDefault();
    onSeek(nextTimeS);
  };

  const progress = durationS > 0 ? Math.min(1, Math.max(0, currentTimeS / durationS)) : 0;
  const accessibleTimeS = boundedAudioTime(currentTimeS, durationS);
  return (
    <div className={`audio-comparison-row ${active ? 'is-active' : ''}`}>
      <div className="audio-comparison-row-heading">
        <span className="audio-comparison-letter" aria-hidden="true">
          {variant === 'before' ? 'A' : 'B'}
        </span>
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
      <div
        ref={rootRef}
        className="processed-audio-waveform"
        role="slider"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={durationS}
        aria-valuenow={accessibleTimeS}
        aria-valuetext={formatAudioPosition(accessibleTimeS, durationS)}
        aria-label={
          variant === 'before'
            ? t('audio.audioPreview.waveformAriaBefore')
            : t('audio.audioPreview.waveformAriaAfter')
        }
        onClick={seekFromPointer}
        onKeyDown={seekFromKeyboard}
      >
        <canvas ref={canvasRef} aria-hidden="true" />
        <span
          className="processed-audio-waveform-progress"
          style={{ width: `${String(progress * 100)}%` }}
          aria-hidden="true"
        />
        <span
          className="processed-audio-waveform-playhead"
          style={{ left: `${String(progress * 100)}%` }}
          aria-hidden="true"
        />
        {waveform.state === 'loading' ? (
          <span className="processed-audio-waveform-state">
            {t('audio.audioPreview.waveformLoading')}
          </span>
        ) : null}
        {waveform.state === 'error' ? (
          <span className="processed-audio-waveform-state">
            {t('audio.audioPreview.waveformUnavailable')}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function AudioComparison({
  beforeSrc,
  afterSrc,
  fallbackDurationS,
}: {
  beforeSrc: string;
  afterSrc: string;
  fallbackDurationS: number;
}): JSX.Element {
  const beforeRef = useRef<HTMLAudioElement>(null);
  const afterRef = useRef<HTMLAudioElement>(null);
  const [activeVariant, setActiveVariant] = useState<AudioVariant>('after');
  const [playing, setPlaying] = useState(false);
  const [currentTimeS, setCurrentTimeS] = useState(0);
  const [durationS, setDurationS] = useState(() =>
    audioComparisonDuration([null, null], fallbackDurationS),
  );
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [transport] = useState(
    () =>
      new AudioComparisonTransport({
        fallbackDurationS,
        getMedia: (variant) => (variant === 'before' ? beforeRef.current : afterRef.current),
        onActiveVariant: setActiveVariant,
        onPlaying: setPlaying,
        onTime: setCurrentTimeS,
        onDuration: setDurationS,
        onError: setPlaybackError,
      }),
  );
  const beforeWaveform = useDecodedWaveform(beforeSrc);
  const afterWaveform = useDecodedWaveform(afterSrc);
  const envelopes: AudioWaveformEnvelope[] = [];
  if (beforeWaveform.state === 'ready') envelopes.push(beforeWaveform.envelope);
  if (afterWaveform.state === 'ready') envelopes.push(afterWaveform.envelope);
  const amplitudePeak = sharedAudioWaveformPeak(envelopes);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const update = (): void => {
      transport.syncFromActiveMedia();
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [playing, transport]);

  useEffect(
    () => () => {
      transport.dispose();
    },
    [transport],
  );

  return (
    <div className="processed-audio-artifact">
      <audio
        ref={beforeRef}
        preload="auto"
        src={beforeSrc}
        onLoadedMetadata={(event) => {
          transport.loadedMetadata('before', event.currentTarget);
        }}
        onPlay={(event) => {
          transport.played('before', event.currentTarget);
        }}
        onPause={(event) => {
          transport.paused('before', event.currentTarget);
        }}
        onEnded={() => {
          transport.ended('before');
        }}
      />
      <audio
        ref={afterRef}
        preload="auto"
        src={afterSrc}
        onLoadedMetadata={(event) => {
          transport.loadedMetadata('after', event.currentTarget);
        }}
        onPlay={(event) => {
          transport.played('after', event.currentTarget);
        }}
        onPause={(event) => {
          transport.paused('after', event.currentTarget);
        }}
        onEnded={() => {
          transport.ended('after');
        }}
      />

      <div className="audio-comparison-waveforms">
        <ComparisonWaveform
          variant="before"
          label={t('audio.audioPreview.before')}
          detail={t('audio.audioPreview.beforeDetail')}
          waveform={beforeWaveform}
          amplitudePeak={amplitudePeak}
          durationS={durationS}
          currentTimeS={currentTimeS}
          active={activeVariant === 'before'}
          onSeek={(timeS) => {
            transport.seek(timeS);
          }}
        />
        <ComparisonWaveform
          variant="after"
          label={t('audio.audioPreview.after')}
          detail={t('audio.audioPreview.afterDetail')}
          waveform={afterWaveform}
          amplitudePeak={amplitudePeak}
          durationS={durationS}
          currentTimeS={currentTimeS}
          active={activeVariant === 'after'}
          onSeek={(timeS) => {
            transport.seek(timeS);
          }}
        />
      </div>

      <div className="processed-audio-transport">
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          aria-label={playing ? t('audio.audioPreview.pause') : t('audio.audioPreview.play')}
          onClick={() => {
            transport.togglePlayback();
          }}
        >
          <span aria-hidden="true">{playing ? 'Ⅱ' : '▶'}</span>
        </Button>
        <span className="font-mono tabular-nums">
          {formatAudioClock(currentTimeS)} / {formatAudioClock(durationS)}
        </span>
        <span className="audio-comparison-listen-label">{t('audio.audioPreview.listenTo')}</span>
        <div
          className="audio-comparison-switch"
          role="group"
          aria-label={t('audio.audioPreview.ab')}
        >
          <Button
            type="button"
            size="xs"
            variant={activeVariant === 'before' ? 'secondary' : 'ghost'}
            aria-pressed={activeVariant === 'before'}
            onClick={() => {
              transport.switchVariant('before');
            }}
          >
            A · {t('audio.audioPreview.before')}
          </Button>
          <Button
            type="button"
            size="xs"
            variant={activeVariant === 'after' ? 'secondary' : 'ghost'}
            aria-pressed={activeVariant === 'after'}
            onClick={() => {
              transport.switchVariant('after');
            }}
          >
            B · {t('audio.audioPreview.after')}
          </Button>
        </div>
      </div>
      <StudioDialogError>{playbackError}</StudioDialogError>
    </div>
  );
}

/** Two rendered proofs from one snapshot: untreated montage versus the saved audio chain. */
export function ProcessedAudioPreviewPanel(): JSX.Element {
  const state = useStore();
  const job = state.activeJobs.get('audio-preview');
  const running = job !== undefined;
  const refresh = state.audioPreviewRefreshState;
  const starting = refresh === 'saving';
  const hasComparison = state.project?.hasAudioComparison === true;
  const status = running
    ? refresh === 'queued'
      ? t('audio.audioPreview.renderingQueued')
      : t('audio.audioPreview.rendering')
    : refresh === 'saving'
      ? t('audio.audioPreview.starting')
      : refresh === 'debouncing'
        ? t('audio.audioPreview.debouncing')
        : refresh === 'queued'
          ? t('audio.audioPreview.queued')
          : !hasComparison
            ? t('audio.audioPreview.missing')
            : state.audioPreviewOutdated
              ? t('audio.audioPreview.outdated')
              : t('audio.audioPreview.current');
  const version = String(state.audioPreviewVersion);
  const beforeSrc = `${api.mediaUrl('edit/audio-preview-before.m4a')}?v=${version}`;
  const afterSrc = `${api.mediaUrl('edit/audio-preview.m4a')}?v=${version}`;
  const busy = running || starting;

  return (
    <section className="processed-audio-panel">
      <div className="processed-audio-heading">
        <div>
          <strong>{t('audio.audioPreview.title')}</strong>
          <p>{t('audio.audioPreview.description')}</p>
        </div>
        <Badge
          variant="outline"
          className={state.audioPreviewOutdated || !hasComparison ? 'audio-preview-stale' : ''}
          aria-live="polite"
        >
          {status}
        </Badge>
      </div>

      {hasComparison ? (
        <AudioComparison
          key={state.audioPreviewVersion}
          beforeSrc={beforeSrc}
          afterSrc={afterSrc}
          fallbackDurationS={state.lastAudioPreview?.durationS ?? state.doc?.totalDurationS ?? 0}
        />
      ) : (
        <div className="processed-audio-empty">
          <span aria-hidden="true">A/B</span>
          <strong>{t('audio.audioPreview.emptyTitle')}</strong>
          <p>{t('audio.audioPreview.emptyDetail')}</p>
        </div>
      )}

      {running || refresh !== 'idle' ? (
        <div className="processed-audio-activity" role="status" aria-live="polite">
          <i aria-hidden="true" />
          <span className="font-mono tabular-nums">{job?.progress ?? status}</span>
        </div>
      ) : null}
      <p className="processed-audio-proof-note">{t('audio.audioPreview.parity')}</p>
      <Button
        type="button"
        size="lg"
        className="w-full"
        disabled={busy}
        onClick={() => {
          void store.requestAudioPreview();
        }}
      >
        {running
          ? t('audio.audioPreview.rendering')
          : starting
            ? t('audio.audioPreview.starting')
            : state.audioPreviewError
              ? t('audio.audioPreview.retry')
              : t('audio.audioPreview.update')}
      </Button>
      <StudioDialogError>{state.audioPreviewError}</StudioDialogError>
    </section>
  );
}
