import { useEffect, useMemo, useRef, useState, type JSX, type PointerEvent } from 'react';
import { resamplePeaks } from '../../../core/peaks.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StudioDialog, StudioDialogError, StudioDialogFooter } from '@/components/StudioDialog';
import { api } from '../../api.js';
import { t } from '../../i18n/index.js';
import { store } from '../../state/store.js';
import { useStore } from '../../state/hooks.js';
import { playhead } from '../../state/playhead.js';
import {
  clipRangeInfo,
  clipRangeLimit,
  dragClipRange,
  type ClipRange,
  type ClipEditorSession,
  type ClipRangeInfo,
} from './clipRange.js';
import { useThumbnails } from './thumbnails.js';
import '../../styles/clip-range.css';

function clock(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${(value % 60).toFixed(2).padStart(5, '0')}`;
}

function ClipRangeEditor({
  session,
  info,
}: {
  session: ClipEditorSession;
  info: ClipRangeInfo;
}): JSX.Element {
  const state = useStore();
  const [range, setRange] = useState<ClipRange>(info.range);
  const [duration, setDuration] = useState(info.duration);
  const [cursor, setCursor] = useState(info.range.start);
  const [error, setError] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState(false);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ mode: 'start' | 'end' | 'move'; x: number; range: ClipRange } | null>(
    null,
  );
  const total = duration === null ? Math.max(1, info.range.end) : clipRangeLimit(info, duration);
  const [zoomWindow, setZoomWindow] = useState<ClipRange | null>(null);
  const visibleStart = zoomWindow?.start ?? 0;
  const visibleEnd = zoomWindow?.end ?? total;
  const visibleDuration = visibleEnd - visibleStart;
  const peaks = info.source ? state.peaks.get(info.source) : undefined;
  const waveform = useMemo(() => {
    if (!peaks) return '';
    const sampled = resamplePeaks(peaks, visibleStart, visibleEnd, 336);
    return Array.from(
      { length: 336 },
      (_, i) =>
        `${String(i * 2)},${String(38 + (sampled.min[i] ?? 0) * 34)} ${String(i * 2)},${String(38 + (sampled.max[i] ?? 0) * 34)}`,
    ).join(' ');
  }, [peaks, visibleStart, visibleEnd]);
  const url = info.path === undefined ? undefined : api.mediaUrl(info.path);
  const thumbs = useThumbnails(
    info.mediaKind === 'video' && duration !== null ? url : undefined,
    visibleStart,
    visibleEnd,
    672,
  );
  const stale = state.doc !== session.doc || state.lockedTrackKeys.has(session.selection.trackId);
  const valid =
    duration !== null &&
    Number.isFinite(range.start) &&
    Number.isFinite(range.end) &&
    range.start >= 0 &&
    range.end <= total + 1e-6 &&
    (info.mode !== 'source' || range.start < duration) &&
    range.end - range.start >= info.minLength - 1e-6 &&
    range.end - range.start <= info.maxLength + 1e-6;
  const displayRange = valid ? range : info.range;
  const step = 1 / session.doc.fps;

  useEffect(() => {
    playhead.setPlaying(false);
  }, []);

  const seek = (time: number): void => {
    const value = Math.max(0, Math.min(total, time));
    setCursor(value);
    if (value < visibleStart || value > visibleEnd) setZoomWindow(null);
    if (mediaRef.current) {
      mediaRef.current.pause();
      mediaRef.current.currentTime = value;
    }
  };
  const change = (next: ClipRange, edge: 'start' | 'end' = 'start'): void => {
    setRange(next);
    setError(null);
    seek(next[edge]);
  };
  const begin = (event: PointerEvent<HTMLElement>, mode: 'start' | 'end' | 'move'): void => {
    if (event.button !== 0 || duration === null) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { mode, x: event.clientX, range: displayRange };
    railRef.current?.setPointerCapture(event.pointerId);
  };
  const moveBy = (mode: 'start' | 'end' | 'move', delta: number): void => {
    change(
      dragClipRange(displayRange, mode, delta, total, info.minLength, info.maxLength),
      mode === 'end' ? 'end' : 'start',
    );
  };
  const loaded = (): void => {
    const media = mediaRef.current;
    if (!media) return;
    if (Number.isFinite(media.duration) && media.duration > 0) {
      setDuration(media.duration);
      const block = session.doc.tracks.find((track) => track.id === session.selection.trackId)
        ?.blocks[session.selection.blockIndex];
      if (block && 'file' in block && block.duration === undefined)
        setRange({ start: info.range.start, end: media.duration });
    }
    media.currentTime = info.range.start;
  };

  return (
    <StudioDialog
      open
      onOpenChange={(open) => {
        if (!open) store.closeClipEditor();
      }}
      size="lg"
      title={t('clipRange.title')}
      description={t(info.mode === 'source' ? 'clipRange.sourceHint' : 'clipRange.timedHint')}
      className="clip-range-dialog"
    >
      <p className="clip-range-name" title={info.label}>
        {info.label}
      </p>
      <div className="clip-range-preview">
        {info.mediaKind === 'video' && (
          <video
            ref={(element) => {
              mediaRef.current = element;
            }}
            src={url}
            controls
            preload="metadata"
            onLoadedMetadata={loaded}
            onTimeUpdate={() => {
              setCursor(mediaRef.current?.currentTime ?? 0);
            }}
            onError={() => {
              setMediaError(true);
            }}
          />
        )}
        {info.mediaKind === 'audio' && (
          <audio
            ref={(element) => {
              mediaRef.current = element;
            }}
            src={url}
            controls
            preload="metadata"
            onLoadedMetadata={loaded}
            onTimeUpdate={() => {
              setCursor(mediaRef.current?.currentTime ?? 0);
            }}
            onError={() => {
              setMediaError(true);
            }}
          />
        )}
        {info.mediaKind === 'image' && <img src={url} alt={info.label} />}
        {info.mediaKind === 'effect' && <p>{info.label}</p>}
      </div>
      <div className="clip-range-zoom">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!valid}
          onClick={() => {
            const width = Math.min(total, Math.max((range.end - range.start) * 3, 1));
            const start = Math.max(
              0,
              Math.min(total - width, (range.start + range.end - width) / 2),
            );
            setZoomWindow({ start, end: start + width });
          }}
        >
          {t('clipRange.zoom')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setZoomWindow(null);
          }}
        >
          {t('clipRange.full')}
        </Button>
      </div>
      <div className="clip-range-ruler">
        <span>{clock(visibleStart)}</span>
        <span>{clock((visibleStart + visibleEnd) / 2)}</span>
        <span>{clock(visibleEnd)}</span>
      </div>
      <div
        ref={railRef}
        className="clip-range-rail"
        onPointerDown={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          seek(visibleStart + ((event.clientX - rect.left) / rect.width) * visibleDuration);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          const rect = railRef.current?.getBoundingClientRect();
          if (!drag || !rect || duration === null) return;
          const delta =
            Math.round((((event.clientX - drag.x) / rect.width) * visibleDuration) / step) * step;
          change(
            dragClipRange(drag.range, drag.mode, delta, total, info.minLength, info.maxLength),
            drag.mode === 'end' ? 'end' : 'start',
          );
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        onLostPointerCapture={() => {
          dragRef.current = null;
        }}
      >
        {waveform && (
          <svg
            className="clip-range-waveform"
            viewBox="0 0 672 76"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <polyline points={waveform} />
          </svg>
        )}
        <div className="clip-range-film" aria-hidden="true">
          {thumbs.map((src, index) =>
            src ? <img key={index} src={src} alt="" draggable={false} /> : <span key={index} />,
          )}
        </div>
        <div
          className="clip-range-window"
          style={{
            left: `${String(((displayRange.start - visibleStart) / visibleDuration) * 100)}%`,
            width: `${String(((displayRange.end - displayRange.start) / visibleDuration) * 100)}%`,
          }}
        >
          <button
            type="button"
            className="clip-range-move"
            aria-label={t('clipRange.move')}
            onPointerDown={(event) => {
              begin(event, 'move');
            }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              moveBy('move', (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : step));
            }}
          />
          {(['start', 'end'] as const).map((edge) => (
            <button
              key={edge}
              type="button"
              role="slider"
              aria-label={t(edge === 'start' ? 'clipRange.start' : 'clipRange.end')}
              aria-valuenow={displayRange[edge]}
              aria-valuemin={
                edge === 'start'
                  ? Math.max(0, displayRange.end - info.maxLength)
                  : displayRange.start + info.minLength
              }
              aria-valuemax={
                edge === 'start'
                  ? displayRange.end - info.minLength
                  : Math.min(total, displayRange.start + info.maxLength)
              }
              aria-valuetext={clock(displayRange[edge])}
              className={`clip-range-handle ${edge}`}
              onPointerDown={(event) => {
                begin(event, edge);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                moveBy(edge, (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : step));
              }}
            >
              {edge === 'start' ? '❮' : '❯'}
            </button>
          ))}
        </div>
        {duration !== null && total > duration && (
          <span
            className="clip-range-source-end"
            style={{ left: `${String(((duration - visibleStart) / visibleDuration) * 100)}%` }}
          />
        )}
        <span
          className="clip-range-cursor"
          style={{ left: `${String(((cursor - visibleStart) / visibleDuration) * 100)}%` }}
        />
      </div>
      {duration !== null && total > duration && (
        <p className="clip-range-hint">
          {t('clipRange.hold')} {clock(duration)}
        </p>
      )}
      <div className="clip-range-fields">
        {(['start', 'end'] as const).map((edge) => (
          <label key={edge}>
            {t(edge === 'start' ? 'clipRange.start' : 'clipRange.end')}
            <Input
              type="number"
              min={0}
              max={total}
              step={step}
              value={Number.isFinite(range[edge]) ? Number(range[edge].toFixed(3)) : ''}
              onChange={(event) => {
                const value = event.currentTarget.valueAsNumber;
                setRange({ ...range, [edge]: value });
                if (Number.isFinite(value)) seek(value);
              }}
            />
          </label>
        ))}
        <div>
          <span>{t('clipRange.duration')}</span>
          <strong>
            {Number.isFinite(range.end - range.start)
              ? clock((range.end - range.start) / info.speed)
              : '—'}
          </strong>
        </div>
      </div>
      <p className="clip-range-hint">
        {t(info.mode === 'source' ? 'clipRange.positionHint' : 'clipRange.timedPositionHint')}{' '}
        {info.mode === 'source' ? clock(info.at) : ''}
      </p>
      {info.mode === 'source' && <p className="clip-range-hint">{t('clipRange.baseRipple')}</p>}
      <StudioDialogError>
        {stale
          ? t('clipRange.stale')
          : (error ??
            (mediaError
              ? t('clipRange.mediaError')
              : duration === null
                ? t('clipRange.loading')
                : !valid
                  ? t('clipRange.invalid')
                  : null))}
      </StudioDialogError>
      <StudioDialogFooter>
        <Button
          variant="outline"
          onClick={() => {
            store.closeClipEditor();
          }}
        >
          {t('common.cancel')}
        </Button>
        <Button
          disabled={!valid || stale}
          onClick={() => {
            if (duration !== null && store.commitClipRange(session, range, duration)) return;
            setError(t('clipRange.stale'));
          }}
        >
          {t('clipRange.apply')}
        </Button>
      </StudioDialogFooter>
    </StudioDialog>
  );
}

export function ClipRangeDialog(): JSX.Element | null {
  const state = useStore();
  const session = state.clipEditor;
  if (!session) return null;
  const info = clipRangeInfo(session.doc, session.selection, state.project?.media);
  if (!info) return null;
  return <ClipRangeEditor session={session} info={info} />;
}
