import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type PointerEvent,
} from 'react';
import { resamplePeaks, type WaveformPeaks } from '../../../core/peaks.js';
import { t } from '../../i18n/index.js';
import {
  clampDenoiseSample,
  moveDenoiseSample,
  resizeDenoiseSample,
  sampleDuration,
  waveformTimeAtFraction,
  type DenoiseSampleInput,
} from './audioSample.js';

type DragMode = 'move' | 'start' | 'end';

interface WaveformDrag {
  readonly mode: DragMode;
  readonly anchorTime: number;
  readonly original: DenoiseSampleInput;
}

function rangeStyle(start: number, end: number, duration: number): CSSProperties {
  const safeDuration = Math.max(0.001, duration);
  return {
    left: `${String((start / safeDuration) * 100)}%`,
    width: `${String(((end - start) / safeDuration) * 100)}%`,
  };
}

function formatClock(time: number): string {
  const minutes = Math.floor(time / 60);
  const seconds = time - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}`;
}

export function peaksDuration(peaks: WaveformPeaks | undefined): number | undefined {
  if (!peaks) return undefined;
  return (peaks.min.length * peaks.windowMs) / 1000;
}

export function RoomToneWaveform({
  peaks,
  duration,
  suggestions,
  selection,
  playhead,
  onSelectionChange,
}: {
  peaks: WaveformPeaks | undefined;
  duration: number;
  suggestions: readonly DenoiseSampleInput[];
  selection: DenoiseSampleInput;
  playhead: number;
  onSelectionChange: (sample: DenoiseSampleInput) => void;
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<WaveformDrag | null>(null);
  const [width, setWidth] = useState(720);

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
    if (!canvas || !peaks) return;
    const height = 154;
    const density = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * density);
    canvas.height = Math.round(height * density);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(density, 0, 0, density, 0, 0);
    context.clearRect(0, 0, width, height);
    const rootStyle = getComputedStyle(document.documentElement);
    const line = rootStyle.getPropertyValue('--chrome-line').trim();
    const audio =
      rootStyle.getPropertyValue('--data-audio').trim() ||
      rootStyle.getPropertyValue('--coral').trim();
    context.fillStyle = line;
    context.fillRect(0, height / 2, width, 1);
    const sampled = resamplePeaks(peaks, 0, duration, width);
    context.fillStyle = audio;
    const mid = height / 2;
    for (let x = 0; x < width; x += 1) {
      const top = mid + (sampled.min[x] ?? 0) * mid * 0.86;
      const bottom = mid + (sampled.max[x] ?? 0) * mid * 0.86;
      context.fillRect(x, Math.min(top, bottom), 1, Math.max(1, Math.abs(bottom - top)));
    }
  }, [duration, peaks, width]);

  const timeFromPointer = (event: PointerEvent<HTMLElement>): number => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return waveformTimeAtFraction((event.clientX - rect.left) / rect.width, duration);
  };

  const beginDrag = (mode: DragMode, event: PointerEvent<HTMLElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { mode, anchorTime: timeFromPointer(event), original: selection };
    rootRef.current?.setPointerCapture(event.pointerId);
  };

  const selectAtPointer = (event: PointerEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-waveform-interactive]')) return;
    const center = timeFromPointer(event);
    const length = sampleDuration(selection);
    const candidate = clampDenoiseSample(
      {
        source: selection.source,
        start: center - length / 2,
        end: center + length / 2,
      },
      duration,
    );
    if (!candidate) return;
    onSelectionChange(candidate);
    dragRef.current = { mode: 'move', anchorTime: center, original: candidate };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updateDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const time = timeFromPointer(event);
    const next =
      drag.mode === 'move'
        ? moveDenoiseSample(drag.original, time - drag.anchorTime, duration)
        : resizeDenoiseSample(drag.original, drag.mode, time, duration);
    onSelectionChange(next);
  };

  const stopDrag = (event: PointerEvent<HTMLDivElement>): void => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="room-tone-waveform-shell">
      <div
        ref={rootRef}
        className="room-tone-waveform"
        role="application"
        aria-label={t('audio.roomTone.waveformAria')}
        onPointerDown={selectAtPointer}
        onPointerMove={updateDrag}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
      >
        {peaks ? (
          <canvas ref={canvasRef} aria-hidden="true" />
        ) : (
          <div className="room-tone-waveform-empty">{t('audio.roomTone.waveformUnavailable')}</div>
        )}

        {suggestions.map((sample, index) => (
          <button
            key={`${sample.source}-${String(sample.start)}-${String(index)}`}
            type="button"
            data-waveform-interactive
            className="room-tone-silence-zone"
            style={rangeStyle(sample.start, sample.end, duration)}
            title={`${t('audio.roomTone.detectedOne')} ${formatClock(sample.start)}–${formatClock(sample.end)}`}
            aria-label={`${t('audio.roomTone.useDetected')} ${formatClock(sample.start)}–${formatClock(sample.end)}`}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onClick={() => {
              onSelectionChange(sample);
            }}
          />
        ))}

        <div
          data-waveform-interactive
          className="room-tone-selection-window"
          style={rangeStyle(selection.start, selection.end, duration)}
          onPointerDown={(event) => {
            beginDrag('move', event);
          }}
        >
          <button
            type="button"
            className="room-tone-selection-handle start"
            aria-label={t('audio.roomTone.handleStart')}
            onPointerDown={(event) => {
              beginDrag('start', event);
            }}
          />
          <button
            type="button"
            className="room-tone-selection-handle end"
            aria-label={t('audio.roomTone.handleEnd')}
            onPointerDown={(event) => {
              beginDrag('end', event);
            }}
          />
        </div>

        <span
          className="room-tone-waveform-playhead"
          style={{
            left: `${String((Math.min(duration, Math.max(0, playhead)) / duration) * 100)}%`,
          }}
          aria-hidden="true"
        />
      </div>

      <div className="room-tone-ruler" aria-hidden="true">
        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
          <span key={fraction}>{formatClock(duration * fraction)}</span>
        ))}
      </div>
      <div className="room-tone-waveform-legend">
        <span>
          <i className="suggested" /> {t('audio.roomTone.legendDetected')}
        </span>
        <span>
          <i className="selected" /> {t('audio.roomTone.legendSelected')}
        </span>
        <strong className="font-mono tabular-nums">
          {formatClock(selection.start)} → {formatClock(selection.end)} ·{' '}
          {sampleDuration(selection).toFixed(2)}s
        </strong>
      </div>
    </div>
  );
}
