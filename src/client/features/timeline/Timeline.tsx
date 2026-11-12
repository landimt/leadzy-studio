import { COLOR_PRESET_DRAG_MIME, isColorPresetId } from '../../../core/colorPresets.js';
import { resolveColorDrop } from './colorDrop.js';
import { videoColorFilter } from '../../../core/videoColor.js';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { ChevronDownIcon, LockIcon, LockOpenIcon, MagnetIcon, PinIcon } from 'lucide-react';
import { Hint } from '../../components/Hint.js';
import { Toggle } from '@/components/ui/toggle';
import { api } from '../../api.js';
import { t } from '../../i18n/index.js';
import {
  isLayerBlock,
  SHAKE_DEFAULT_INTENSITY,
  SPEED_BOUNDS,
  type BlockTransition,
  type AudioTrack,
  type EffectTrack,
  type OverlayTrack,
  type VideoBlock,
  type VideoTrack,
} from '../../../core/schema.js';
import { EFFECT_LIBRARY } from '../../../core/effectLibrary.js';
import { spokenWords } from '../../../core/transcript.js';
import {
  outputDuration,
  outputSegments,
  segmentOutputTime,
  snapEdge,
  MIN_TIMED_BLOCK_S,
  type OutputSegment,
  type SnapResult,
} from '../../../core/timeline.js';
import { buildSubtitleCues } from '../../../core/srt.js';
import { resamplePeaks, type WaveformPeaks } from '../../../core/peaks.js';
import { useThumbnails } from './thumbnails.js';
import { assignOverlayLanes } from './timelineLanes.js';
import { useProcessedTimelineAudio } from './useProcessedTimelineAudio.js';
import { baseHasEntireAudioMix, processedSegmentWindow } from './processedTimelineAudio.js';
import { UI_ICON, UiIcon } from '../../components/UiIcon.js';
import { canSplitAtPlayhead, canTrimAtPlayhead } from '../../state/edits/blocks.js';
import { store } from '../../state/store.js';
import { type SelectedCue } from '../../state/storeState.js';
import {
  BACKGROUND_EDITOR_TRACK_KEY,
  EFFECT_DRAG_MIME,
  LIBRARY_DRAG_MIME,
  PROJECT_MEDIA_DRAG_MIME,
  SUBTITLE_EDITOR_TRACK_KEY,
  effectDurationBounds,
} from '../../state/docEdits.js';
import { playhead } from '../../state/playhead.js';
import { usePlayheadTime, useStore } from '../../state/hooks.js';
import { silenceCutOutputRanges, suggestionOutputRanges } from './cutSuggestionReview.js';

interface DragState {
  readonly trackId: string;
  readonly blockIndex: number;
  readonly kind: 'edge-in' | 'edge-out' | 'move';
  readonly pointerStartX: number;
  readonly originalValue: number;
  value: number;
  snap: SnapResult | null;
  clientX: number;
  clientY: number;
}

interface MediaDropTarget {
  readonly kind: 'base' | 'layer' | 'audio';
  readonly trackId: string | null;
  readonly time: number;
}

type ContextMenuKind = 'base' | 'layer' | 'audio' | 'overlay' | 'effect';

interface AudioEnvelopeDragState {
  readonly trackId: string;
  readonly blockIndex: number;
  readonly kind: 'gain' | 'fade-in' | 'fade-out';
  readonly pointerStartX: number;
  readonly pointerStartY: number;
  readonly blockTop: number;
  readonly blockHeight: number;
  readonly durationS: number;
  readonly otherFadeS: number;
  readonly initialValue: number;
  value: number;
}

const TRACK_REORDER_MIME = 'application/x-leadzy-track-reorder';

const round2 = (value: number): number => Math.round(value * 100) / 100;
const startsAtTimelineOrigin = (seconds: number): boolean => Math.abs(seconds) <= 0.0001;

function audioBlockPreview(
  block: AudioTrack['blocks'][number],
  preview: Pick<DragState, 'kind' | 'value'> | null,
  sourceDurationS: number | undefined,
): { readonly at: number; readonly inValue: number; readonly outValue: number } {
  if (!preview) return { at: block.at, inValue: block.in, outValue: block.out };
  if (preview.kind === 'move') {
    return { at: preview.value, inValue: block.in, outValue: block.out };
  }

  const durationS = block.out - block.in;
  const minimumDurationS = Math.min(MIN_TIMED_BLOCK_S, durationS);
  const time = round2(preview.value);
  if (preview.kind === 'edge-in') {
    const outputEnd = block.at + durationS;
    const earliestAt = Math.max(0, block.at - block.in);
    const nextAt = Math.min(outputEnd - minimumDurationS, Math.max(earliestAt, time));
    return {
      at: round2(nextAt),
      inValue: round2(block.in + (nextAt - block.at)),
      outValue: block.out,
    };
  }

  const latestOutputEnd =
    sourceDurationS === undefined || sourceDurationS < block.out
      ? Number.POSITIVE_INFINITY
      : block.at + (sourceDurationS - block.in);
  const outputEnd = Math.min(latestOutputEnd, Math.max(block.at + minimumDurationS, time));
  return {
    at: block.at,
    inValue: block.in,
    outValue: round2(block.in + (outputEnd - block.at)),
  };
}

function transitionTypeLabel(type: BlockTransition['type']): string {
  if (type === 'fade-black') return t('timeline.transition.fadeBlack');
  if (type === 'fade-white') return t('timeline.transition.fadeWhite');
  return t('timeline.transition.crossfade');
}

function BlockWaveform(props: {
  peaks: WaveformPeaks | undefined;
  waveformFrom?: number | undefined;
  waveformTo?: number | undefined;
  thumbUrl?: string | undefined;
  from: number;
  to: number;
  widthPx: number;
}): JSX.Element | null {
  const thumbs = useThumbnails(props.thumbUrl, props.from, props.to, props.widthPx);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !props.peaks) return;
    const width = Math.max(2, Math.floor(props.widthPx));
    const height = 44;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return;
    const { min, max } = resamplePeaks(
      props.peaks,
      props.waveformFrom ?? props.from,
      props.waveformTo ?? props.to,
      width,
    );
    context.clearRect(0, 0, width, height);
    // Canvas cannot resolve var(), so the token has to be read as a string.
    // Both reads come from the palette — no literal duplicated here.
    const rootStyle = getComputedStyle(document.documentElement);
    context.fillStyle =
      rootStyle.getPropertyValue('--data-audio').trim() || rootStyle.getPropertyValue('--coral');
    const mid = height / 2;
    for (let x = 0; x < width; x += 1) {
      const top = mid + (min[x] ?? 0) * mid * 0.9;
      const bottom = mid + (max[x] ?? 0) * mid * 0.9;
      context.fillRect(x, Math.min(top, bottom), 1, Math.max(1, Math.abs(bottom - top)));
    }
  }, [props.peaks, props.from, props.to, props.waveformFrom, props.waveformTo, props.widthPx]);
  if (!props.peaks && thumbs.length === 0) return null;
  return (
    <>
      {thumbs.length > 0 && (
        <span className="thumbs">
          {thumbs.map((src, i) =>
            src ? <img key={i} src={src} alt="" draggable={false} /> : <span key={i} />,
          )}
        </span>
      )}
      <canvas ref={canvasRef} />
    </>
  );
}

// the edge MOVES in the arrow's direction — position beside the edge gives context
const ICON_CHEVRON_L = 'M9.5 3.5 5 8l4.5 4.5';
const ICON_CHEVRON_R = 'M6.5 3.5 11 8l-4.5 4.5';
// not in UiIcon's shared set — the effect track is the only consumer
const ICON_FLASH = 'M8.7 1.3 2 9.3h6l-.7 5.4L14 6.7H8l.7-5.4z';
const ICON_SHAKE =
  'M5 5h6v6H5z M2.5 2.5l1.5 1.5 M2.5 13.5l1.5-1.5 M13.5 2.5l-1.5 1.5 M13.5 13.5l-1.5-1.5';
// not in UiIcon's shared set — the base-block context menu is the only consumer
const ICON_SPEED = 'M3 4l4 4-4 4 M9 4l4 4-4 4';
const SUBTITLE_TRACK_COLLAPSE_KEY = 'timeline:subtitles';
const trackCollapseKey = (trackId: string): string => `timeline:track:${trackId}`;

function readTimelineCssLength(element: HTMLElement | null, property: string): number {
  if (!element) return 0;
  const rawValue = getComputedStyle(element).getPropertyValue(property).trim();
  if (!rawValue) return 0;
  if (rawValue.endsWith('px')) {
    const pixels = Number.parseFloat(rawValue);
    return Number.isFinite(pixels) ? pixels : 0;
  }
  // Computed custom properties preserve authored units (`8.5rem`, `calc(...)`)
  // instead of resolving to pixels. Measure a hidden inherited probe so zoom
  // math follows the same used value as the grid itself.
  const probe = document.createElement('span');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  probe.style.width = `var(${property})`;
  probe.style.height = '0';
  probe.style.padding = '0';
  probe.style.border = '0';
  element.append(probe);
  const pixels = probe.getBoundingClientRect().width;
  probe.remove();
  return Number.isFinite(pixels) ? pixels : 0;
}

function TrackCollapseButton({
  collapsed,
  label,
  onToggle,
}: {
  collapsed: boolean;
  label: string;
  onToggle: () => void;
}): JSX.Element {
  const action = collapsed ? t('timeline.track.expand') : t('timeline.track.collapse');
  const accessibleLabel = `${action} ${label}`;
  return (
    <button
      type="button"
      className="track-collapse-button track-control"
      aria-expanded={!collapsed}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      onClick={onToggle}
    >
      <ChevronDownIcon size={12} strokeWidth={1.75} />
    </button>
  );
}

function TrackHeader({
  collapsed,
  label,
  locked,
  actions,
  onToggleCollapsed,
  onToggleLocked,
}: {
  collapsed: boolean;
  label: string;
  locked: boolean;
  actions?: ReactNode;
  onToggleCollapsed: () => void;
  onToggleLocked: () => void;
}): JSX.Element {
  const lockAction = locked ? t('timeline.track.unlock') : t('timeline.track.lock');
  const accessibleLockLabel = `${lockAction} ${label}`;
  return (
    <div className="track-label">
      <TrackCollapseButton collapsed={collapsed} label={label} onToggle={onToggleCollapsed} />
      <button
        type="button"
        className="track-control"
        aria-label={accessibleLockLabel}
        aria-pressed={locked}
        title={accessibleLockLabel}
        onClick={onToggleLocked}
      >
        {locked ? <LockIcon /> : <LockOpenIcon />}
      </button>
      {actions}
    </div>
  );
}

function TrackLaneName({
  disabled,
  icon,
  label,
  onClick,
  reorder,
  accessory,
  title,
}: {
  accessory?: ReactNode;
  title?: string;
  disabled?: boolean;
  icon: string;
  label: string;
  onClick?: () => void;
  reorder?: {
    readonly label: string;
    readonly onDragStart: (event: ReactDragEvent<HTMLButtonElement>) => void;
    readonly onDragEnd: () => void;
    readonly onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  };
}): JSX.Element {
  const content = (
    <>
      <UiIcon d={icon} size={11} />
      <span className="track-lane-name-text">{label}</span>
    </>
  );
  const name =
    onClick || reorder ? (
      <button
        type="button"
        className={`track-lane-name ${reorder ? 'is-reorder-handle' : ''}`}
        disabled={disabled}
        aria-disabled={disabled}
        aria-label={reorder?.label}
        title={title ?? reorder?.label}
        draggable={reorder !== undefined && !disabled}
        onClick={onClick}
        onDragStart={reorder?.onDragStart}
        onDragEnd={reorder?.onDragEnd}
        onKeyDown={reorder?.onKeyDown}
      >
        {content}
      </button>
    ) : (
      <span className="track-lane-name" title={title}>
        {content}
      </span>
    );
  return accessory ? (
    <span className="track-lane-heading">
      {name}
      <span className="track-lane-indicators">{accessory}</span>
    </span>
  ) : (
    name
  );
}

/**
 * Transition picker for one cut. Anchored to its own chip via Popover, so
 * viewport clamping, Escape and outside-click come from Radix instead of the
 * hand-rolled positioning and window listeners this replaced.
 */
function TransitionMenu({
  blockIndex,
  transition,
  crossfadeUnavailable,
}: {
  blockIndex: number;
  transition: BlockTransition | undefined;
  /** Either side of this cut has a block speed override — the renderer silently degrades a crossfade to fade-black there, so offering it here would be a promise the render can't keep. */
  crossfadeUnavailable: boolean;
}): JSX.Element {
  const options: readonly {
    key: string;
    label: string;
    type: BlockTransition['type'] | null;
    defaultDurationS: number;
  }[] = [
    { key: 'none', label: t('timeline.transition.none'), type: null, defaultDurationS: 0.3 },
    {
      key: 'crossfade',
      label: t('timeline.transition.crossfade'),
      type: 'crossfade',
      defaultDurationS: 0.4,
    },
    {
      key: 'fade-black',
      label: t('timeline.transition.fadeBlack'),
      type: 'fade-black',
      defaultDurationS: 0.3,
    },
    {
      key: 'fade-white',
      label: t('timeline.transition.fadeWhite'),
      type: 'fade-white',
      defaultDurationS: 0.3,
    },
  ];
  return (
    <PopoverContent align="start" className="w-[220px] gap-2 p-2.5">
      <div className="text-[10px] font-bold tracking-[0.08em] uppercase text-muted-foreground">
        {t('timeline.transition.title')}
      </div>
      <div className="flex flex-col gap-0.5">
        {options.map((option) => {
          const active = option.type === null ? !transition : transition?.type === option.type;
          const disabled = option.type === 'crossfade' && crossfadeUnavailable;
          return (
            <Button
              key={option.key}
              type="button"
              size="xs"
              variant={active ? 'secondary' : 'ghost'}
              className="justify-start"
              disabled={disabled}
              title={disabled ? t('timeline.transition.crossfadeUnavailable') : undefined}
              onClick={() => {
                store.setBlockTransition(
                  blockIndex,
                  option.type === null
                    ? undefined
                    : {
                        type: option.type,
                        durationS: transition?.durationS ?? option.defaultDurationS,
                      },
                );
              }}
            >
              {option.label}
            </Button>
          );
        })}
      </div>
      {transition && (
        <div className="flex flex-col gap-1.5 text-[11px] text-muted-foreground">
          <span>
            {t('timeline.transition.duration')}{' '}
            <strong className="font-mono tabular-nums">{transition.durationS.toFixed(2)}s</strong>
          </span>
          <Slider
            min={0.1}
            max={1}
            step={0.05}
            value={[transition.durationS]}
            aria-label={t('timeline.transition.duration')}
            onValueChange={([next]) => {
              if (next === undefined) return;
              store.setBlockTransition(
                blockIndex,
                { type: transition.type, durationS: next },
                `transition-duration:${String(blockIndex)}`,
              );
            }}
          />
        </div>
      )}
    </PopoverContent>
  );
}

const EDGE_CLUSTER_W = 58;
const CENTER_CLUSTER_W = 58;
const MERGED_TOOLBAR_W = 196;
const SPEED_PRESETS = [0.75, 1, 1.25, 1.5, 2] as const;

/**
 * Chip icon/label/title for one effect block: the icon carries the type
 * (zoom keeps its lupa), the on-chip label stays a bare value like zoom's
 * always has, and the title tooltip spells the type out.
 */
function effectChipContent(block: EffectTrack['blocks'][number]): {
  icon: string;
  label: string;
  title: string;
} {
  if (block.type === 'flash') {
    const label = `${block.duration.toFixed(2)}s`;
    return { icon: ICON_FLASH, label, title: `flash ${label}` };
  }
  if (block.type === 'shake') {
    const label = String(block.intensity ?? SHAKE_DEFAULT_INTENSITY);
    return { icon: ICON_SHAKE, label, title: `shake ${label}` };
  }
  const label = `${String(Math.round(block.scale * 100))}%`;
  return { icon: UI_ICON.zoom, label, title: `zoom ${label}` };
}

/**
 * Frame-accurate trim controls docked to the selected block: −/+ at each edge
 * (right where they act), split/delete centered. A narrow block collapses
 * everything into one centered cluster.
 */
function BlockToolbar(props: {
  startX: number;
  endX: number;
  outputStart: number;
  outputEnd: number;
  frameS: number;
  maxX: number;
  playheadPinned: boolean;
}): JSX.Element {
  // With the playhead pinned, trimming an edge no longer drags the needle along:
  // the frame under it stays put, so repeated nudges are judged against one image.
  const followEdge = (time: number): void => {
    if (props.playheadPinned) return;
    playhead.seek(time);
  };
  const stop = (event: ReactPointerEvent): void => {
    event.stopPropagation();
  };
  const clamp = (left: number, width: number): number =>
    Math.max(0, Math.min(left, props.maxX - width));
  const leftEdgeButtons = (
    <>
      <Hint label={t('inspector.edge.leftExtendTitle')}>
        <button
          aria-label={t('inspector.edge.leftExtendTitle')}
          onClick={() => {
            store.trimSelectedEdge('in', -props.frameS);
            followEdge(props.outputStart);
          }}
        >
          <UiIcon d={ICON_CHEVRON_L} size={12} />
        </button>
      </Hint>
      <Hint label={t('inspector.edge.leftTrimTitle')}>
        <button
          aria-label={t('inspector.edge.leftTrimTitle')}
          onClick={() => {
            store.trimSelectedEdge('in', props.frameS);
            followEdge(props.outputStart);
          }}
        >
          <UiIcon d={ICON_CHEVRON_R} size={12} />
        </button>
      </Hint>
    </>
  );
  const rightEdgeButtons = (
    <>
      <Hint label={t('inspector.edge.rightTrimTitle')}>
        <button
          aria-label={t('inspector.edge.rightTrimTitle')}
          onClick={() => {
            store.trimSelectedEdge('out', -props.frameS);
            followEdge(Math.max(props.outputStart, props.outputEnd - props.frameS));
          }}
        >
          <UiIcon d={ICON_CHEVRON_L} size={12} />
        </button>
      </Hint>
      <Hint label={t('inspector.edge.rightExtendTitle')}>
        <button
          aria-label={t('inspector.edge.rightExtendTitle')}
          onClick={() => {
            store.trimSelectedEdge('out', props.frameS);
            followEdge(props.outputEnd + props.frameS);
          }}
        >
          <UiIcon d={ICON_CHEVRON_R} size={12} />
        </button>
      </Hint>
    </>
  );
  const centerButtons = (
    <>
      <Hint label={t('timeline.tool.splitTitle')}>
        <button
          aria-label={t('timeline.tool.splitTitle')}
          onClick={() => {
            store.splitAtPlayhead(playhead.time);
          }}
        >
          <UiIcon d={UI_ICON.split} size={12} />
        </button>
      </Hint>
      <Hint label={t('timeline.tool.deleteTitle')}>
        <button
          aria-label={t('timeline.tool.deleteTitle')}
          onClick={() => {
            store.deleteSelectedBlock();
          }}
        >
          <UiIcon d={UI_ICON.trash} size={12} />
        </button>
      </Hint>
    </>
  );

  if (props.endX - props.startX < MERGED_TOOLBAR_W + 24) {
    const center = (props.startX + props.endX) / 2;
    return (
      <div
        className="block-toolbar"
        style={{ left: clamp(center - MERGED_TOOLBAR_W / 2, MERGED_TOOLBAR_W) }}
        onPointerDown={stop}
      >
        {leftEdgeButtons}
        <span className="block-toolbar-sep" />
        {centerButtons}
        <span className="block-toolbar-sep" />
        {rightEdgeButtons}
      </div>
    );
  }
  return (
    <>
      <div
        className="block-toolbar"
        style={{ left: clamp(props.startX, EDGE_CLUSTER_W) }}
        onPointerDown={stop}
      >
        {leftEdgeButtons}
      </div>
      <div
        className="block-toolbar"
        style={{
          left: clamp((props.startX + props.endX - CENTER_CLUSTER_W) / 2, CENTER_CLUSTER_W),
        }}
        onPointerDown={stop}
      >
        {centerButtons}
      </div>
      <div
        className="block-toolbar"
        style={{ left: clamp(props.endX - EDGE_CLUSTER_W, EDGE_CLUSTER_W) }}
        onPointerDown={stop}
      >
        {rightEdgeButtons}
      </div>
    </>
  );
}

export function Timeline(): JSX.Element | null {
  const state = useStore();
  const processedAudio = useProcessedTimelineAudio();
  const time = usePlayheadTime();
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const timeCanvasRef = useRef<HTMLDivElement>(null);
  const scrubbingRef = useRef(false);
  const [pxPerSecond, setPxPerSecond] = useState(24);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [audioEnvelopeDrag, setAudioEnvelopeDrag] = useState<AudioEnvelopeDragState | null>(null);
  const [trackReorder, setTrackReorder] = useState<{
    readonly sourceId: string;
    readonly targetId: string | null;
  } | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [transitionMenuFor, setTransitionMenuFor] = useState<number | null>(null);
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const [trackHeight, setTrackHeight] = useState(56);
  const [collapsedTrackKeys, setCollapsedTrackKeys] = useState<Set<string>>(() => {
    const currentDoc = state.doc;
    const initial = new Set<string>();
    if (!currentDoc) return initial;
    const baseId = currentDoc.tracks.find((track) => track.kind === 'video')?.id;
    if (!currentDoc.subtitles.enabled) initial.add(SUBTITLE_TRACK_COLLAPSE_KEY);
    for (const track of currentDoc.tracks) {
      if (track.id !== baseId && track.blocks.length === 0) {
        initial.add(trackCollapseKey(track.id));
      }
    }
    return initial;
  });
  const previousTrackBlockCountsRef = useRef(
    new Map(
      state.doc?.tracks.map((track) => [trackCollapseKey(track.id), track.blocks.length]) ?? [],
    ),
  );
  const [snapOff, setSnapOff] = useState(
    () => localStorage.getItem('leadzy-studio-snap') === 'off',
  );
  const [playheadPinned, setPlayheadPinned] = useState(
    () => localStorage.getItem('leadzy-studio-playhead') === 'pinned',
  );
  const [libraryDropTime, setLibraryDropTime] = useState<number | null>(null);
  const [effectDropTime, setEffectDropTime] = useState<number | null>(null);
  const colorDropElement = useRef<HTMLElement | null>(null);
  const clearColorDrop = (): void => {
    colorDropElement.current?.classList.remove('is-color-drop-target');
    colorDropElement.current = null;
  };
  useEffect(() => {
    window.addEventListener('dragend', clearColorDrop);
    return () => {
      window.removeEventListener('dragend', clearColorDrop);
      clearColorDrop();
    };
  }, []);

  const [mediaDropTarget, setMediaDropTarget] = useState<MediaDropTarget | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    trackId: string;
    blockIndex: number;
    outputTime: number;
    kind: ContextMenuKind;
  } | null>(null);
  // Empty auxiliary tracks start compact. When content is added later, reveal
  // the lane automatically so a newly-created block never appears to vanish.
  useEffect(() => {
    const nextCounts = new Map(
      state.doc?.tracks.map((track) => [trackCollapseKey(track.id), track.blocks.length]) ?? [],
    );
    const keysToExpand: string[] = [];
    for (const [key, count] of nextCounts) {
      if (count > (previousTrackBlockCountsRef.current.get(key) ?? 0)) keysToExpand.push(key);
    }
    previousTrackBlockCountsRef.current = nextCounts;
    if (keysToExpand.length === 0) return;
    setCollapsedTrackKeys((current) => {
      if (!keysToExpand.some((key) => current.has(key))) return current;
      const next = new Set(current);
      for (const key of keysToExpand) next.delete(key);
      return next;
    });
  }, [state.doc]);

  // Commands that create/select a block can originate outside the timeline.
  // Selecting it is an explicit request to see that track.
  useEffect(() => {
    const selectedTrackId = state.selection?.trackId;
    if (!selectedTrackId) return;
    const key = trackCollapseKey(selectedTrackId);
    setCollapsedTrackKeys((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, [state.selection?.trackId]);

  useEffect(() => {
    if (!state.subtitleInspectorOpen) return;
    setCollapsedTrackKeys((current) => {
      if (!current.has(SUBTITLE_TRACK_COLLAPSE_KEY)) return current;
      const next = new Set(current);
      next.delete(SUBTITLE_TRACK_COLLAPSE_KEY);
      return next;
    });
  }, [state.subtitleInspectorOpen]);

  const doc = state.doc;
  const baseOwnsMix = doc !== null && baseHasEntireAudioMix(doc);
  const showProcessedBase = baseOwnsMix && processedAudio.peaks !== null && drag === null;
  const effectsBase = doc?.tracks[0]?.kind === 'video' ? doc.tracks[0] : undefined;
  const baseEffects =
    (effectsBase?.color && videoColorFilter(effectsBase.color)) ||
    effectsBase?.blocks.some((b) => b.color && videoColorFilter(b.color))
      ? ' · Cor aplicada'
      : '';
  const baseSpeed = effectsBase?.blocks.some((b) => (b.speed ?? 1) !== 1)
    ? ' · Velocidade ajustada'
    : '';
  const baseAudioLabel = t('timeline.baseLabel');
  const baseAudioTitle = baseOwnsMix ? processedAudio.status : t('timeline.baseAudio.original');
  const baseSpeeds = [...new Set(effectsBase?.blocks.map((b) => b.speed ?? 1) ?? [])];
  const baseSpeedLabel =
    baseSpeeds.length === 1 ? `${(baseSpeeds[0] ?? 1).toLocaleString('pt-BR')}×` : '≠×';
  const duration = useMemo(() => (doc ? Math.max(outputDuration(doc), 1) : 1), [doc]);
  const segments = useMemo(() => (doc ? outputSegments(doc) : []), [doc]);
  const cues = useMemo(
    () => (doc?.subtitles.enabled ? buildSubtitleCues(doc, state.transcripts) : []),
    [doc, state.transcripts],
  );
  // `rangeSelectCue` needs the visible cues in display order to compute a span — it isn't indexed anywhere in
  // the doc. The pill preset renders one div per word but reuses one (source, wordStart, wordEnd) triple per
  // chunk (see buildSubtitleCues), so dedupe — otherwise a range spanning a chunk collects repeated extras.
  const orderedCueSelections = useMemo<SelectedCue[]>(() => {
    const seen = new Set<string>();
    const result: SelectedCue[] = [];
    for (const cue of cues) {
      const key = `${cue.source}:${String(cue.wordStart)}:${String(cue.wordEnd)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ source: cue.source, wordStart: cue.wordStart, wordEnd: cue.wordEnd });
    }
    return result;
  }, [cues]);
  // Magnetic-snap candidates (output-time boundaries): base-track joints, plus
  // every overlay/effect/layer block edge, excluding whichever block is
  // currently being dragged — a block must never snap to its own edge.
  const snapCandidates = useMemo<number[]>(() => {
    if (!doc) return [];
    const candidates = new Set<number>([0, round2(Math.max(outputDuration(doc), 1))]);
    for (const segment of outputSegments(doc)) {
      candidates.add(round2(segment.outputStart));
      candidates.add(round2(segment.outputEnd));
    }
    for (const track of doc.tracks) {
      const isDragged = (blockIndex: number): boolean =>
        drag?.trackId === track.id && drag.blockIndex === blockIndex;
      if (track.kind === 'video') {
        track.blocks.forEach((block, blockIndex) => {
          if (!isLayerBlock(block) || isDragged(blockIndex)) return;
          candidates.add(round2(block.at));
          candidates.add(round2(block.at + (block.out - block.in)));
        });
      } else if (track.kind === 'audio') {
        track.blocks.forEach((block, blockIndex) => {
          if (isDragged(blockIndex)) return;
          candidates.add(round2(block.at));
          candidates.add(round2(block.at + (block.out - block.in)));
        });
      } else if (track.kind === 'overlay') {
        track.blocks.forEach((block, blockIndex) => {
          if (isDragged(blockIndex)) return;
          candidates.add(round2(block.at));
          candidates.add(round2(block.at + (block.duration ?? 2)));
        });
      } else {
        track.blocks.forEach((block, blockIndex) => {
          if (isDragged(blockIndex)) return;
          candidates.add(round2(block.at));
          candidates.add(round2(block.at + block.duration));
        });
      }
    }
    return Array.from(candidates).sort((a, b) => a - b);
  }, [doc, drag?.trackId, drag?.blockIndex]);
  if (!doc) return null;

  const isExtraSelected = (trackId: string, blockIndex: number): boolean =>
    state.extraSelections.some((s) => s.trackId === trackId && s.blockIndex === blockIndex);
  const isExtraCue = (cue: { source: string; wordStart: number; wordEnd: number }): boolean =>
    state.extraCues.some(
      (c) => c.source === cue.source && c.wordStart === cue.wordStart && c.wordEnd === cue.wordEnd,
    );

  const toX = (seconds: number): number => seconds * pxPerSecond;
  const totalWidth = toX(duration) + 120;
  const frameS = 1 / (doc.fps > 0 ? doc.fps : 25);
  // The cursor tools act on the block under the needle. When there is nothing to
  // cut there — the needle on a block edge, or past the end of the montage — the
  // button greys out instead of eating the click.
  const canSplit = canSplitAtPlayhead(doc, state.selection, time);
  const canTrimLeft = canTrimAtPlayhead(doc, state.selection, 'left', time);
  const canTrimRight = canTrimAtPlayhead(doc, state.selection, 'right', time);
  // the magnet button turns snapping off for good; Alt keeps the momentary override
  const snapInactive = snapOff || state.snapDisabled;
  const snapLabel = t(
    snapOff
      ? 'timeline.tool.snapOff'
      : state.snapDisabled
        ? 'timeline.tool.snapPaused'
        : 'timeline.tool.snapOn',
  );
  const toggleSnap = (): void => {
    const next = !snapOff;
    setSnapOff(next);
    localStorage.setItem('leadzy-studio-snap', next ? 'off' : 'on');
  };
  // Pinning only silences the incidental seeks — selecting a block, picking a
  // cue, nudging an edge. Scrubbing the ruler, the arrows and the transcript
  // still move the needle, because there the move IS the intent.
  const togglePlayheadPinned = (): void => {
    const next = !playheadPinned;
    setPlayheadPinned(next);
    localStorage.setItem('leadzy-studio-playhead', next ? 'pinned' : 'free');
  };
  const scrubSeek = (clientX: number): void => {
    const raw = timeAtClientX(clientX);
    if (snapInactive) {
      playhead.seek(raw);
      return;
    }
    playhead.seek(nearestSnapCandidate(raw, 8 / pxPerSecond) ?? raw);
  };

  const fitZoom = (): void => {
    const width = scrollRef.current?.clientWidth ?? 900;
    const headerWidth = readTimelineCssLength(innerRef.current, '--timeline-track-header-w');
    const zeroGutter = readTimelineCssLength(innerRef.current, '--timeline-zero-gutter');
    setPxPerSecond(Math.max(4, (width - headerWidth - zeroGutter - 120) / duration));
  };

  /**
   * Zoom without losing the playhead: anchor on its current screen position
   * (or the viewport center if it is scrolled out of view), then re-derive
   * scrollLeft from that anchor once the new scale has committed.
   */
  const zoomAnchorRef = useRef<{ time: number; screenX: number } | null>(null);
  const applyZoom = (nextPps: number): void => {
    const clamped = Math.min(300, Math.max(4, nextPps));
    const scroller = scrollRef.current;
    if (scroller && clamped !== pxPerSecond) {
      const headerWidth = readTimelineCssLength(innerRef.current, '--timeline-track-header-w');
      const zeroGutter = readTimelineCssLength(innerRef.current, '--timeline-zero-gutter');
      const timeOriginX = headerWidth + zeroGutter;
      const playheadX = timeOriginX + time * pxPerSecond;
      const canvasCenterX = headerWidth + (scroller.clientWidth - headerWidth) / 2;
      const visible =
        playheadX >= scroller.scrollLeft + headerWidth &&
        playheadX <= scroller.scrollLeft + scroller.clientWidth;
      zoomAnchorRef.current = visible
        ? { time, screenX: playheadX - scroller.scrollLeft }
        : {
            time: Math.max(0, (scroller.scrollLeft + canvasCenterX - timeOriginX) / pxPerSecond),
            screenX: canvasCenterX,
          };
    }
    setPxPerSecond(clamped);
  };
  const applyZoomRef = useRef(applyZoom);
  applyZoomRef.current = applyZoom;
  const pxPerSecondRef = useRef(pxPerSecond);
  pxPerSecondRef.current = pxPerSecond;

  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    const scroller = scrollRef.current;
    zoomAnchorRef.current = null;
    if (!anchor || !scroller) return;
    const headerWidth = readTimelineCssLength(innerRef.current, '--timeline-track-header-w');
    const zeroGutter = readTimelineCssLength(innerRef.current, '--timeline-zero-gutter');
    scroller.scrollLeft = Math.max(
      0,
      headerWidth + zeroGutter + anchor.time * pxPerSecond - anchor.screenX,
    );
  }, [pxPerSecond]);

  // React's onWheel is passive — preventDefault needs a real listener, or the
  // pinch gesture zooms the whole page instead of the timeline.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
      applyZoomRef.current(pxPerSecondRef.current * factor);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      element.removeEventListener('wheel', onWheel);
    };
  }, []);

  useEffect(() => {
    if (!menu) return;
    const closeOutside = (event: PointerEvent): void => {
      if (!(event.target as Element).closest('.context-menu')) setMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null);
    };
    window.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [menu]);

  const importLibraryItemAt = async (id: string, at: number): Promise<void> => {
    try {
      if (!(await store.flushSave())) return;
      await api.importLibraryItem(id, at);
      await store.reloadFromServer(false);
    } catch (cause) {
      store.showError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const snapFor = (block: VideoBlock, edge: 'in' | 'out', rawTime: number): SnapResult => {
    if (snapInactive) return { time: rawTime, snapped: false };
    const transcript = state.transcripts.get(block.source);
    const words = transcript ? spokenWords(transcript) : [];
    const silences = state.silences.get(block.source) ?? [];
    return snapEdge(rawTime, edge, words, silences);
  };

  const nearestSnapCandidate = (
    value: number,
    thresholdS: number,
    extras: readonly number[] = [],
  ): number | null => {
    let best: number | null = null;
    let bestDistance = thresholdS;
    for (const candidate of [...snapCandidates, ...extras]) {
      const distance = Math.abs(candidate - value);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    return best;
  };

  /**
   * Magnetic move-snap: test both edges of the dragged block against the
   * candidate set and snap whichever edge lands closer. A trailing-edge snap
   * shifts `value` back by `blockDuration` so the block still ends up flush
   * against the candidate, not its leading edge.
   */
  const snapMoveEdges = (
    raw: number,
    blockDuration: number,
    thresholdS: number,
  ): { value: number; snap: SnapResult | null } => {
    const leading = nearestSnapCandidate(raw, thresholdS, [time]);
    const trailing = nearestSnapCandidate(raw + blockDuration, thresholdS, [time]);
    const leadingDistance = leading === null ? Number.POSITIVE_INFINITY : Math.abs(leading - raw);
    const trailingDistance =
      trailing === null ? Number.POSITIVE_INFINITY : Math.abs(trailing - (raw + blockDuration));
    if (leading !== null && leadingDistance <= trailingDistance) {
      return { value: leading, snap: { time: leading, snapped: true } };
    }
    if (trailing !== null) {
      return { value: trailing - blockDuration, snap: { time: trailing, snapped: true } };
    }
    return { value: raw, snap: null };
  };

  // ⌘/Ctrl toggles membership, Shift extends the range — either way the pointer
  // action is a pure selection change, never the start of a drag.
  const beginDrag = (
    event: ReactPointerEvent,
    trackId: string,
    blockIndex: number,
    kind: DragState['kind'],
    originalValue: number,
  ): void => {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (state.lockedTrackKeys.has(trackId)) return;
    if (event.metaKey || event.ctrlKey) {
      store.toggleSelect({ trackId, blockIndex });
      return;
    }
    if (event.shiftKey) {
      store.rangeSelect({ trackId, blockIndex });
      return;
    }
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    store.select({ trackId, blockIndex });
    if (!playheadPinned) playhead.seek(timeAtClientX(event.clientX));
    setDrag({
      trackId,
      blockIndex,
      kind,
      pointerStartX: event.clientX,
      originalValue,
      value: originalValue,
      snap: null,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  };

  const beginAudioEnvelopeDrag = (
    event: ReactPointerEvent<HTMLElement>,
    trackId: string,
    blockIndex: number,
    kind: AudioEnvelopeDragState['kind'],
    value: number,
    durationS: number,
    otherFadeS: number,
  ): void => {
    if (event.button !== 0 || state.lockedTrackKeys.has(trackId)) return;
    event.preventDefault();
    event.stopPropagation();
    const block = event.currentTarget.closest<HTMLElement>('.block.audio-layer');
    if (!block) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    store.select({ trackId, blockIndex });
    const rect = block.getBoundingClientRect();
    setAudioEnvelopeDrag({
      trackId,
      blockIndex,
      kind,
      pointerStartX: event.clientX,
      pointerStartY: event.clientY,
      blockTop: rect.top,
      blockHeight: rect.height,
      durationS,
      otherFadeS,
      initialValue: value,
      value,
    });
  };

  const onAudioEnvelopeMove = (event: ReactPointerEvent): void => {
    if (!audioEnvelopeDrag) return;
    let value = audioEnvelopeDrag.value;
    if (audioEnvelopeDrag.kind === 'gain') {
      const usableHeight = Math.max(1, audioEnvelopeDrag.blockHeight - 8);
      const ratio = Math.min(
        1,
        Math.max(0, (event.clientY - audioEnvelopeDrag.blockTop - 4) / usableHeight),
      );
      value = Math.round((12 - ratio * 72) * 10) / 10;
    } else {
      const deltaS = (event.clientX - audioEnvelopeDrag.pointerStartX) / pxPerSecond;
      const raw =
        audioEnvelopeDrag.kind === 'fade-in'
          ? audioEnvelopeDrag.initialValue + deltaS
          : audioEnvelopeDrag.initialValue - deltaS;
      value =
        Math.round(
          Math.min(audioEnvelopeDrag.durationS - audioEnvelopeDrag.otherFadeS, Math.max(0, raw)) *
            100,
        ) / 100;
    }
    setAudioEnvelopeDrag({ ...audioEnvelopeDrag, value });
  };

  const endAudioEnvelopeDrag = (): void => {
    if (!audioEnvelopeDrag) return;
    const { trackId, blockIndex, kind, value } = audioEnvelopeDrag;
    const track = doc.tracks.find(
      (candidate): candidate is AudioTrack =>
        candidate.kind === 'audio' && candidate.id === trackId,
    );
    const block = track?.blocks[blockIndex];
    if (block) {
      if (kind === 'gain') store.setAudioBlockGain(trackId, blockIndex, value);
      else if (kind === 'fade-in') {
        store.setAudioBlockFades(trackId, blockIndex, {
          fadeInS: value,
          fadeOutS: block.fadeOutS ?? 0,
        });
      } else {
        store.setAudioBlockFades(trackId, blockIndex, {
          fadeInS: block.fadeInS ?? 0,
          fadeOutS: value,
        });
      }
    }
    setAudioEnvelopeDrag(null);
  };

  const audioEnvelopePreview = (
    trackId: string,
    blockIndex: number,
  ): AudioEnvelopeDragState | null =>
    audioEnvelopeDrag?.trackId === trackId && audioEnvelopeDrag.blockIndex === blockIndex
      ? audioEnvelopeDrag
      : null;

  const onDragMove = (event: ReactPointerEvent): void => {
    if (!drag) return;
    const deltaS = (event.clientX - drag.pointerStartX) / pxPerSecond;
    const track = doc.tracks.find((candidate) => candidate.id === drag.trackId);
    const block = track?.kind === 'video' ? track.blocks[drag.blockIndex] : undefined;
    const audioBlock = track?.kind === 'audio' ? track.blocks[drag.blockIndex] : undefined;
    // A base-track block dragged as 'move' is a reorder, not a repositioning — it has
    // its own drop-index preview (dragReorderPreview) and must not fight it with a snap.
    const isBaseReorderDrag = drag.kind === 'move' && block !== undefined && !isLayerBlock(block);
    let raw = Math.max(0, drag.originalValue + deltaS);
    let blockDuration = 0;
    if (drag.kind === 'move') {
      blockDuration =
        track?.kind === 'video' && block
          ? block.out - block.in
          : track?.kind === 'audio' && audioBlock
            ? audioBlock.out - audioBlock.in
            : track?.kind === 'overlay'
              ? (track.blocks[drag.blockIndex]?.duration ?? 2)
              : track?.kind === 'effect'
                ? (track.blocks[drag.blockIndex]?.duration ?? 0)
                : 0;
      if (blockDuration < duration) raw = Math.min(raw, duration - blockDuration);
    }
    let snap: SnapResult | null = null;
    let value = raw;
    if (block && (drag.kind === 'edge-in' || drag.kind === 'edge-out')) {
      snap = snapFor(block, drag.kind === 'edge-in' ? 'in' : 'out', raw);
      value = snap.time;
    } else if (!snapInactive) {
      const thresholdS = 8 / pxPerSecond;
      if (drag.kind === 'move' && !isBaseReorderDrag) {
        const snapped = snapMoveEdges(raw, blockDuration, thresholdS);
        value = snapped.value;
        snap = snapped.snap;
      } else if (
        (drag.kind === 'edge-in' || drag.kind === 'edge-out') &&
        (track?.kind === 'audio' || track?.kind === 'overlay' || track?.kind === 'effect')
      ) {
        const candidate = nearestSnapCandidate(raw, thresholdS, [time]);
        if (candidate !== null) {
          value = candidate;
          snap = { time: candidate, snapped: true };
        }
      }
    }
    // Mirror the store's per-type duration clamp so the ghost stops at the
    // limit instead of promising a size the commit will snap back from.
    if ((drag.kind === 'edge-in' || drag.kind === 'edge-out') && track?.kind === 'effect') {
      const effectBlock = track.blocks[drag.blockIndex];
      if (effectBlock) {
        const bounds = effectDurationBounds(effectBlock.type);
        const endS = effectBlock.at + effectBlock.duration;
        value =
          drag.kind === 'edge-out'
            ? Math.min(effectBlock.at + bounds.max, Math.max(effectBlock.at + bounds.min, value))
            : Math.min(endS - bounds.min, Math.max(endS - bounds.max, value));
        if (snap && snap.time !== value) snap = null;
      }
    }
    setDrag({ ...drag, value, snap, clientX: event.clientX, clientY: event.clientY });
  };

  const onDragEnd = (): void => {
    if (!drag) return;
    // A normal click has a little pointer jitter; do not turn it into a timeline edit.
    if (Math.abs(drag.clientX - drag.pointerStartX) < 3) {
      setDrag(null);
      return;
    }
    const dragTrack = doc.tracks.find((candidate) => candidate.id === drag.trackId);
    if (drag.kind === 'move') {
      const dragBlock = dragTrack?.kind === 'video' ? dragTrack.blocks[drag.blockIndex] : undefined;
      if (dragBlock && !isLayerBlock(dragBlock)) {
        store.reorderBaseBlock(drag.blockIndex, drag.value);
      } else {
        store.moveTimedBlock(drag.trackId, drag.blockIndex, drag.value);
      }
    } else if (
      dragTrack?.kind === 'audio' ||
      dragTrack?.kind === 'overlay' ||
      dragTrack?.kind === 'effect'
    ) {
      store.resizeTimedBlock(
        drag.trackId,
        drag.blockIndex,
        drag.kind === 'edge-in' ? 'in' : 'out',
        drag.value,
      );
    } else {
      store.resizeBlock(
        drag.trackId,
        drag.blockIndex,
        drag.kind === 'edge-in' ? 'in' : 'out',
        drag.value,
      );
    }
    setDrag(null);
  };

  const previewValue = (trackId: string, blockIndex: number): DragState | null =>
    drag?.trackId === trackId && drag.blockIndex === blockIndex ? drag : null;

  const timeAtClientX = (clientX: number): number => {
    // The lane's rect already includes the sticky header and zero gutter, and
    // shifts with horizontal scrolling. Never add scrollLeft on top.
    const rect = timeCanvasRef.current?.getBoundingClientRect();
    if (!rect) return time;
    return Math.min(duration, Math.max(0, (clientX - rect.left) / pxPerSecond));
  };

  const baseBoundaryAt = (outputTime: number): number => {
    const insertIndex = segments.filter((segment) => {
      const midpoint = segment.outputStart + (segment.outputEnd - segment.outputStart) / 2;
      return midpoint <= outputTime;
    }).length;
    return segments[insertIndex]?.outputStart ?? segments.at(-1)?.outputEnd ?? 0;
  };

  const updateMediaDropTarget = (
    event: ReactDragEvent<HTMLDivElement>,
    kind: MediaDropTarget['kind'],
    trackId: string,
  ): void => {
    if (!event.dataTransfer.types.includes(PROJECT_MEDIA_DRAG_MIME)) return;
    const relPath = event.dataTransfer.getData(PROJECT_MEDIA_DRAG_MIME);
    const media = state.project?.media.find((candidate) => candidate.relPath === relPath);
    const acceptsMedia =
      media === undefined || (kind === 'audio' ? media.hasAudio : media.kind === 'video');
    if (!acceptsMedia) {
      setMediaDropTarget(null);
      return;
    }
    if (isTrackLocked(trackId)) {
      setMediaDropTarget(null);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    const rawTime = timeAtClientX(event.clientX);
    setMediaDropTarget({
      kind,
      trackId,
      time: kind === 'base' ? baseBoundaryAt(rawTime) : round2(rawTime),
    });
  };

  const leaveMediaDropTarget = (event: ReactDragEvent<HTMLDivElement>): void => {
    const related = event.relatedTarget;
    if (related instanceof Node && event.currentTarget.contains(related)) return;
    setMediaDropTarget(null);
  };

  const dropProjectMedia = (
    event: ReactDragEvent<HTMLDivElement>,
    kind: MediaDropTarget['kind'],
    trackId: string,
  ): void => {
    if (!event.dataTransfer.types.includes(PROJECT_MEDIA_DRAG_MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    const relPath = event.dataTransfer.getData(PROJECT_MEDIA_DRAG_MIME);
    const rawTime = timeAtClientX(event.clientX);
    setMediaDropTarget(null);
    if (!relPath || isTrackLocked(trackId)) return;
    if (kind === 'base') {
      store.insertIntoBase(relPath, baseBoundaryAt(rawTime));
      return;
    }
    if (kind === 'audio') {
      store.addAudioClip(relPath, round2(rawTime), trackId);
      return;
    }
    store.addLayer(relPath, round2(rawTime), trackId);
  };

  const beginScrub = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || drag) return;
    const target = event.target as HTMLElement;
    if (target.closest('.block, .track-label, .track-lane-name, button, input')) return;
    setMenu(null);
    store.select(null);
    // Pinned, the needle answers to the ruler alone. This handler covers the
    // WHOLE canvas — the empty room under the tracks included — so without this
    // guard a click anywhere in the timeline drags the needle off the frame
    // being judged, which is the one thing pinning is meant to stop.
    if (playheadPinned && !target.closest('.ruler-lane')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    scrubbingRef.current = true;
    setScrubbing(true);
    scrubSeek(event.clientX);
  };

  const isBlockSelected = (trackId: string, blockIndex: number): boolean =>
    (state.selection?.trackId === trackId && state.selection.blockIndex === blockIndex) ||
    state.extraSelections.some((s) => s.trackId === trackId && s.blockIndex === blockIndex);

  const showContextMenu = (
    kind: ContextMenuKind,
    trackId: string,
    blockIndex: number,
    clientX: number,
    clientY: number,
  ): void => {
    if (state.lockedTrackKeys.has(trackId)) return;
    // Right-clicking inside an existing multi-selection keeps it (so "Remover
    // bloco" deletes all of it); right-clicking elsewhere replaces it.
    if (!isBlockSelected(trackId, blockIndex)) store.select({ trackId, blockIndex });
    setSpeedMenuOpen(false);
    const menuHeight = kind === 'base' ? 192 : kind === 'layer' ? 156 : 84;
    setMenu({
      x: Math.max(8, Math.min(clientX, window.innerWidth - 220)),
      y: Math.max(8, Math.min(clientY, window.innerHeight - menuHeight - 8)),
      trackId,
      blockIndex,
      outputTime: timeAtClientX(clientX),
      kind,
    });
  };

  const openContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    kind: ContextMenuKind,
    trackId: string,
    blockIndex: number,
  ): void => {
    event.preventDefault();
    // On macOS, Ctrl+click is emulated as a right-click by the browser itself —
    // its contextmenu event carries ctrlKey — so it also fires here on top of
    // the toggle-select the pointerdown handler already ran. Swallow that one;
    // a real right-click (or ⌘+click, which macOS does NOT treat as secondary
    // click) never sets ctrlKey.
    if (event.ctrlKey) return;
    event.stopPropagation();
    showContextMenu(kind, trackId, blockIndex, event.clientX, event.clientY);
  };

  // live preview of where the scissors will land, driven by the slider
  const silenceCandidates = useMemo(() => {
    if (!state.cutReviewOpen || state.cutReviewMode !== 'silences') return [];
    return store
      .computeSilenceCuts(state.silenceReview.minSilenceS, {
        interior: state.silenceReview.interior,
        edges: state.silenceReview.edges,
      })
      .flatMap((cut) =>
        silenceCutOutputRanges(doc, cut).map((range, rangeIndex) => ({
          id: `${cut.source}:${String(cut.from)}:${String(cut.to)}:${String(rangeIndex)}`,
          outputStart: range.at,
          length: range.durationS,
        })),
      );
  }, [
    doc,
    state.cutReviewMode,
    state.cutReviewOpen,
    state.dismissedSilenceCutKeys,
    state.peaks,
    state.silenceReview,
  ]);
  const locatedSuggestionMarkers = useMemo(() => {
    return (doc.suggestions ?? [])
      .filter((suggestion) => state.suggestionReview[suggestion.type])
      .flatMap((suggestion) => {
        return suggestionOutputRanges(doc, suggestion).map((range, rangeIndex) => ({
          suggestion,
          rangeIndex,
          ...range,
        }));
      });
  }, [doc, state.suggestionReview]);
  const suggestionMarkers =
    state.cutReviewOpen && state.cutReviewMode === 'suggestions' ? locatedSuggestionMarkers : [];

  const videoTracks = doc.tracks.filter((track): track is VideoTrack => track.kind === 'video');
  const audioTracks = doc.tracks.filter((track): track is AudioTrack => track.kind === 'audio');
  const overlayTracks = doc.tracks.filter(
    (track): track is OverlayTrack => track.kind === 'overlay',
  );
  const effectTracks = doc.tracks.filter((track): track is EffectTrack => track.kind === 'effect');
  // Persisted order is back-to-front. Display it top-to-bottom so the upper
  // row is also the visually upper layer, matching professional editors.
  const visualVideoTracks = [...videoTracks.slice(1)].reverse();
  const visualAudioTracks = [...audioTracks].reverse();
  const visualOverlayTracks = [...overlayTracks].reverse();
  const visualEffectTracks = [...effectTracks].reverse();
  const visualTracksOfKind = (
    kind: AudioTrack['kind'] | VideoTrack['kind'] | OverlayTrack['kind'] | EffectTrack['kind'],
  ): readonly (AudioTrack | VideoTrack | OverlayTrack | EffectTrack)[] => {
    if (kind === 'video') return visualVideoTracks;
    if (kind === 'audio') return visualAudioTracks;
    if (kind === 'overlay') return visualOverlayTracks;
    return visualEffectTracks;
  };

  const beginTrackReorder = (event: ReactDragEvent<HTMLButtonElement>, trackId: string): void => {
    if (isTrackLocked(trackId)) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    event.dataTransfer.setData(TRACK_REORDER_MIME, trackId);
    event.dataTransfer.effectAllowed = 'move';
    setTrackReorder({ sourceId: trackId, targetId: null });
  };

  const hoverTrackReorder = (event: ReactDragEvent<HTMLDivElement>, targetId: string): void => {
    if (!event.dataTransfer.types.includes(TRACK_REORDER_MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    const sourceId = trackReorder?.sourceId ?? event.dataTransfer.getData(TRACK_REORDER_MIME);
    const source = doc.tracks.find((track) => track.id === sourceId);
    const target = doc.tracks.find((track) => track.id === targetId);
    if (source?.kind !== target?.kind || isTrackLocked(targetId)) {
      event.dataTransfer.dropEffect = 'none';
      return;
    }
    event.dataTransfer.dropEffect = 'move';
    setTrackReorder({ sourceId, targetId });
  };

  const dropTrackReorder = (event: ReactDragEvent<HTMLDivElement>, targetId: string): void => {
    if (!event.dataTransfer.types.includes(TRACK_REORDER_MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    const sourceId = trackReorder?.sourceId ?? event.dataTransfer.getData(TRACK_REORDER_MIME);
    if (sourceId) store.reorderTrack(sourceId, targetId);
    setTrackReorder(null);
  };

  const moveTrackByKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    trackId: string,
  ): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const track = doc.tracks.find((candidate) => candidate.id === trackId);
    if (!track || isTrackLocked(trackId)) return;
    const tracks = visualTracksOfKind(track.kind);
    const current = tracks.findIndex((candidate) => candidate.id === trackId);
    const target = tracks[current + (event.key === 'ArrowUp' ? -1 : 1)];
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    store.reorderTrack(trackId, target.id);
  };

  const trackReorderProps = (
    track: AudioTrack | VideoTrack | OverlayTrack | EffectTrack,
    displayLabel?: string,
  ) => ({
    label: `${t('timeline.track.reorder')} ${displayLabel ?? track.label?.trim() ?? track.id}`,
    onDragStart: (event: ReactDragEvent<HTMLButtonElement>) => {
      beginTrackReorder(event, track.id);
    },
    onDragEnd: () => {
      setTrackReorder(null);
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      moveTrackByKeyboard(event, track.id);
    },
  });
  const audioTrackLabel = (track: AudioTrack): string => {
    const explicitLabel = track.label?.trim();
    if (explicitLabel) return explicitLabel;
    const persistedIndex = audioTracks.findIndex((candidate) => candidate.id === track.id);
    return `${t('timeline.audio')} ${String(Math.max(1, persistedIndex + 1))}`;
  };
  const availableMedia = state.project?.media ?? [];
  const addTitleAtPlayhead = async (): Promise<void> => {
    try {
      if (!(await store.flushSave())) return;
      await api.startTitle({
        text: 'Seu texto',
        style: 'dark',
        pos: 'top',
        at: Math.round(time * 100) / 100,
        durationS: 4,
      });
    } catch (cause) {
      store.showError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const thumbUrlFor = (sourceKey: string): string | undefined => {
    const path = doc.sources[sourceKey]?.path;
    const media = availableMedia.find((m) => m.relPath === path);
    const rel = media?.proxyRelPath ?? path;
    return rel ? `/api/media/${encodeURIComponent(rel)}` : undefined;
  };

  const menuBaseBlock = menu?.kind === 'base' ? videoTracks[0]?.blocks[menu.blockIndex] : undefined;
  const menuBaseSpeed =
    menuBaseBlock && !isLayerBlock(menuBaseBlock) ? (menuBaseBlock.speed ?? 1) : 1;

  const zoomWindowForMenu = (): { at: number; duration: number } | null => {
    if (!menu || (menu.kind !== 'base' && menu.kind !== 'layer')) return null;
    let start = 0;
    let end = 0;
    if (menu.kind === 'base') {
      const segment = segments.find((candidate) => candidate.blockIndex === menu.blockIndex);
      if (!segment) return null;
      start = segment.outputStart;
      end = segment.outputEnd;
    } else {
      const track = doc.tracks.find((candidate) => candidate.id === menu.trackId);
      const block = track?.kind === 'video' ? track.blocks[menu.blockIndex] : undefined;
      if (!block || !isLayerBlock(block)) return null;
      start = block.at;
      end = block.at + (block.out - block.in);
    }
    const effectDuration = Math.min(1.5, end - start);
    if (effectDuration < 0.1) return null;
    return {
      at: Math.min(Math.max(menu.outputTime, start), end - effectDuration),
      duration: effectDuration,
    };
  };

  const baseTrackId = videoTracks[0]?.id ?? 'base';
  const isTrackLocked = (key: string): boolean => state.lockedTrackKeys.has(key);
  const subtitleTrackLocked = isTrackLocked(SUBTITLE_EDITOR_TRACK_KEY);
  const backgroundTrackLocked = isTrackLocked(BACKGROUND_EDITOR_TRACK_KEY);
  const libraryImportTargetLocked = overlayTracks[0] ? isTrackLocked(overlayTracks[0].id) : false;
  const isTrackCollapsed = (key: string): boolean => collapsedTrackKeys.has(key);
  const toggleTrackCollapsed = (key: string): void => {
    setCollapsedTrackKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  // Every non-base track is removable (undo restores it); locked tracks keep
  // the button visible but inert, so the affordance teaches the lock.
  const trackRemoveButton = (
    track: VideoTrack | AudioTrack | OverlayTrack | EffectTrack,
  ): JSX.Element | null => {
    const locked = isTrackLocked(track.id);
    const label = locked
      ? t('timeline.contextMenu.unlockToRemoveLayer')
      : t('timeline.contextMenu.removeLayer');
    return (
      <button
        type="button"
        className="track-control"
        title={label}
        aria-label={label}
        disabled={locked}
        onClick={() => {
          store.removeTrack(track.id);
          setCollapsedTrackKeys((current) => {
            const next = new Set(current);
            next.delete(trackCollapseKey(track.id));
            return next;
          });
        }}
      >
        <UiIcon d={UI_ICON.trash} />
      </button>
    );
  };

  /**
   * Where a base reorder-drag would drop the block: same asymmetric rule as
   * `reorderBlockByDrop` in core/timeline.ts (moving right crosses a
   * neighbour's midpoint with the dragged block's trailing edge; moving left,
   * with its leading edge), computed live against the CURRENT segments so it
   * matches the outcome `store.reorderBaseBlock` would actually produce.
   */
  const dragReorderPreview = (): {
    insertIndex: number;
    fromIndex: number;
    movedLength: number;
    others: OutputSegment[];
  } | null => {
    if (drag?.kind !== 'move' || drag.trackId !== baseTrackId) return null;
    const moved = segments.find((segment) => segment.blockIndex === drag.blockIndex);
    if (!moved) return null;
    const movedLength = moved.out - moved.in;
    const origin = moved.outputStart;
    const drop = Math.max(0, drag.value);
    const others = segments.filter((segment) => segment.blockIndex !== drag.blockIndex);
    const midpointOf = (segment: OutputSegment): number =>
      segment.outputStart + (segment.outputEnd - segment.outputStart) / 2;
    const insertIndex =
      drop > origin
        ? others.filter((segment) => midpointOf(segment) <= drop + movedLength).length
        : others.filter((segment) => midpointOf(segment) < drop).length;
    return { insertIndex, fromIndex: drag.blockIndex, movedLength, others };
  };

  const reorderPreview = dragReorderPreview();

  /** Live "open a gap" layout for the other base blocks while a reorder-drag is active. */
  const reorderShiftedLeft = new Map<number, number>();
  if (reorderPreview && reorderPreview.insertIndex !== reorderPreview.fromIndex) {
    let cursor = 0;
    reorderPreview.others.forEach((segment, index) => {
      if (index === reorderPreview.insertIndex) cursor += reorderPreview.movedLength;
      reorderShiftedLeft.set(segment.blockIndex, cursor);
      cursor += segment.outputEnd - segment.outputStart;
    });
  }

  const baseDropIndicatorX = (): number | null => {
    if (!reorderPreview || reorderPreview.insertIndex === reorderPreview.fromIndex) return null;
    const before = reorderPreview.others[reorderPreview.insertIndex - 1];
    const gapStart = before
      ? (reorderShiftedLeft.get(before.blockIndex) ?? before.outputStart) +
        (before.outputEnd - before.outputStart)
      : 0;
    return toX(gapStart);
  };

  const baseBlockToolbar = (): JSX.Element | null => {
    if (isTrackLocked(baseTrackId)) return null;
    const selection = state.selection;
    if (selection?.trackId !== baseTrackId) return null;
    const selectedSegment = segments.find(
      (candidate) => candidate.blockIndex === selection.blockIndex,
    );
    if (!selectedSegment) return null;
    return (
      <BlockToolbar
        startX={toX(selectedSegment.outputStart)}
        endX={toX(selectedSegment.outputEnd)}
        outputStart={selectedSegment.outputStart}
        outputEnd={selectedSegment.outputEnd}
        frameS={frameS}
        maxX={totalWidth}
        playheadPinned={playheadPinned}
      />
    );
  };

  const layerBlockToolbar = (track: VideoTrack): JSX.Element | null => {
    if (isTrackLocked(track.id)) return null;
    const selection = state.selection;
    if (selection?.trackId !== track.id) return null;
    const block = track.blocks[selection.blockIndex];
    if (!block || !isLayerBlock(block)) return null;
    return (
      <BlockToolbar
        startX={toX(block.at)}
        endX={toX(block.at + (block.out - block.in))}
        outputStart={block.at}
        outputEnd={block.at + (block.out - block.in)}
        frameS={frameS}
        maxX={totalWidth}
        playheadPinned={playheadPinned}
      />
    );
  };

  /** Floating "hide N segments" action, docked under the primary cue while extras are selected. */
  const cueBatchToolbar = (): JSX.Element | null => {
    if (subtitleTrackLocked) return null;
    if (state.extraCues.length === 0 || !state.selectedCue) return null;
    const primary = state.selectedCue;
    const primaryCue = cues.find(
      (cue) =>
        cue.source === primary.source &&
        cue.wordStart === primary.wordStart &&
        cue.wordEnd === primary.wordEnd,
    );
    if (!primaryCue) return null;
    const count = state.extraCues.length + 1;
    return (
      <div
        className="block-toolbar"
        style={{ left: Math.max(0, Math.min(toX(primaryCue.start), totalWidth - 170)) }}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
      >
        <button
          onClick={() => {
            const targets = [primary, ...state.extraCues];
            store.hideCues(targets, state.transcripts);
            store.selectSubtitles();
          }}
        >
          {t('timeline.multiSelect.hideCues')} ({String(count)})
        </button>
      </div>
    );
  };

  return (
    <div
      onDoubleClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest('button, input')) return;
        // The first click moves the playhead over the clip. The second may hit
        // that needle, so resolve the actual clip beneath it as well.
        const selector = '[data-clip-track][data-clip-index]';
        const block =
          target.closest<HTMLElement>(selector) ??
          document
            .elementsFromPoint(event.clientX, event.clientY)
            .map((element) => element.closest<HTMLElement>(selector))
            .find((element) => element !== null);
        if (!block?.dataset.clipTrack) return;
        event.stopPropagation();
        setDrag(null);
        scrubbingRef.current = false;
        setScrubbing(false);
        store.openClipEditor({
          trackId: block.dataset.clipTrack,
          blockIndex: Number(block.dataset.clipIndex),
        });
      }}
    >
      <div className="timeline-toolbar flex h-8 items-center gap-2 px-3 py-0">
        <div className="flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!state.selection || isTrackLocked(state.selection.trackId)}
            onClick={() => {
              if (state.selection) store.openClipEditor(state.selection);
            }}
          >
            {t('clipRange.title')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="border-0"
                aria-label={t('timeline.add.title')}
                title={t('timeline.add.title')}
              >
                <UiIcon d="M8 3v10 M3 8h10" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={6} className="min-w-44 p-1">
              <DropdownMenuItem
                className="type-compact h-7"
                onSelect={() => {
                  store.addEmptyTrack('video');
                }}
              >
                <UiIcon d={UI_ICON.media} size={13} />
                <span>{t('timeline.add.videoTrack')}</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="type-compact h-7"
                onSelect={() => {
                  store.addEmptyTrack('audio');
                }}
              >
                <UiIcon d={UI_ICON.volume} size={13} />
                <span>{t('timeline.add.audioTrack')}</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="type-compact h-7"
                onSelect={() => {
                  store.addEmptyTrack('effect');
                }}
              >
                <UiIcon d={ICON_FLASH} size={13} />
                <span>{t('timeline.add.effectTrack')}</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="type-compact h-7"
                onSelect={() => {
                  store.ensureBackground();
                  store.selectBackground();
                }}
              >
                <UiIcon d={UI_ICON.image} size={13} />
                <span>{t('timeline.add.backgroundTrack')}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="type-compact h-7"
                disabled={state.activeJobs.has('title')}
                onSelect={() => {
                  void addTitleAtPlayhead();
                }}
              >
                <UiIcon d={UI_ICON.captions} size={13} />
                <span>
                  {state.activeJobs.has('title')
                    ? t('inspector.overlay.generating')
                    : t('timeline.add.textAtCursor')}
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Hint label={t('timeline.tool.undoTitle')}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('timeline.tool.undoTitle')}
            disabled={state.undoDepth === 0}
            onClick={() => {
              store.undo();
            }}
          >
            <UiIcon d="M6.5 3.5 3 7l3.5 3.5 M3 7h6a4 4 0 0 1 0 8H7" />
          </Button>
        </Hint>
        <Hint label={t('timeline.tool.redoTitle')}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('timeline.tool.redoTitle')}
            disabled={state.redoDepth === 0}
            onClick={() => {
              store.redo();
            }}
          >
            <UiIcon d="M9.5 3.5 13 7l-3.5 3.5 M13 7H7a4 4 0 0 0 0 8h2" />
          </Button>
        </Hint>
        <Separator orientation="vertical" className="h-4" />
        <div className="flex items-center gap-0.5">
          <Hint label={t('timeline.tool.splitTitle')}>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('timeline.tool.splitTitle')}
              disabled={!canSplit}
              onClick={() => {
                store.splitAtPlayhead(time);
              }}
            >
              <UiIcon d={UI_ICON.split} />
            </Button>
          </Hint>
          <Hint label={t('timeline.tool.trimLeftTitle')}>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('timeline.tool.trimLeftTitle')}
              disabled={!canTrimLeft}
              onClick={() => {
                store.trimAtPlayhead('left', time);
              }}
            >
              <UiIcon d={UI_ICON.trimLeft} />
            </Button>
          </Hint>
          <Hint label={t('timeline.tool.trimRightTitle')}>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('timeline.tool.trimRightTitle')}
              disabled={!canTrimRight}
              onClick={() => {
                store.trimAtPlayhead('right', time);
              }}
            >
              <UiIcon d={UI_ICON.trimRight} />
            </Button>
          </Hint>
          <Hint label={t('timeline.tool.deleteTitle')}>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('timeline.tool.deleteTitle')}
              disabled={state.selection === null}
              onClick={() => {
                store.deleteSelectedBlock();
              }}
            >
              <UiIcon d={UI_ICON.trash} />
            </Button>
          </Hint>
        </div>
        <span className="flex-1" />
        <span className="shrink-0 font-mono text-xs tabular-nums whitespace-nowrap text-muted-foreground">
          {time.toFixed(2).padStart(6, '0')}s · {duration.toFixed(2)}s
        </span>
        <Separator orientation="vertical" className="h-4" />
        <Slider
          min={48}
          max={140}
          step={4}
          value={[trackHeight]}
          aria-label={t('timeline.trackHeight.title')}
          title={t('timeline.trackHeight.title')}
          className="w-[70px]"
          onValueChange={([next]) => {
            if (next !== undefined) setTrackHeight(next);
          }}
        />
        <Separator orientation="vertical" className="h-4" />
        <Hint label={`${snapLabel} · ${t('timeline.tool.snapTitle')}`}>
          <Toggle
            pressed={!snapInactive}
            onPressedChange={toggleSnap}
            aria-label={snapLabel}
            className="timeline-snap h-6 w-6 min-w-0 rounded-sm px-0"
          >
            <MagnetIcon />
          </Toggle>
        </Hint>
        <Hint label={t('timeline.tool.pinPlayheadTitle')}>
          <Toggle
            pressed={playheadPinned}
            onPressedChange={togglePlayheadPinned}
            aria-label={t('timeline.tool.pinPlayheadTitle')}
            className="h-6 w-6 min-w-0 rounded-sm px-0 hover:bg-accent hover:text-accent-foreground data-[state=on]:bg-transparent data-[state=on]:text-brand"
          >
            <PinIcon />
          </Toggle>
        </Hint>
        <Separator orientation="vertical" className="h-4" />
        <Hint label={t('timeline.zoom.fitTitle')}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('timeline.zoom.fitTitle')}
            onClick={fitZoom}
          >
            <UiIcon d={UI_ICON.fit} />
          </Button>
        </Hint>
        <div className="flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              applyZoom(pxPerSecond / 1.4);
            }}
          >
            −
          </Button>
          <span className="w-9 text-center font-mono text-[11px] tabular-nums text-muted-foreground">
            {Math.round((pxPerSecond / 24) * 100)}%
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              applyZoom(pxPerSecond * 1.4);
            }}
          >
            +
          </Button>
        </div>
      </div>
      <div className="timeline" ref={scrollRef}>
        <div
          ref={innerRef}
          className={`timeline-inner ${scrubbing ? 'is-scrubbing' : ''} ${
            drag?.kind === 'move' && drag.trackId === baseTrackId ? 'is-reordering' : ''
          }`}
          style={{
            ['--timeline-canvas-w' as string]: `${String(totalWidth)}px`,
            ['--track-h' as string]: `${String(trackHeight)}px`,
          }}
          onPointerDown={beginScrub}
          onPointerMove={(event) => {
            if (scrubbingRef.current) {
              scrubSeek(event.clientX);
              return;
            }
            if (audioEnvelopeDrag) {
              onAudioEnvelopeMove(event);
              return;
            }
            onDragMove(event);
          }}
          onPointerUp={() => {
            if (scrubbingRef.current) {
              scrubbingRef.current = false;
              setScrubbing(false);
            } else if (audioEnvelopeDrag) endAudioEnvelopeDrag();
            else onDragEnd();
          }}
          onPointerCancel={() => {
            scrubbingRef.current = false;
            setScrubbing(false);
            setDrag(null);
            setAudioEnvelopeDrag(null);
          }}
          onDragOverCapture={(event) => {
            if (!event.dataTransfer.types.includes(COLOR_PRESET_DRAG_MIME)) return;
            event.preventDefault();
            event.stopPropagation();
            clearColorDrop();
            const element =
              event.target instanceof Element
                ? event.target.closest<HTMLElement>('[data-color-track]')
                : null;
            const target = element
              ? resolveColorDrop(
                  doc,
                  element.dataset.colorTrack,
                  element.dataset.colorBlock,
                  state.lockedTrackKeys,
                )
              : null;
            event.dataTransfer.dropEffect = target ? 'copy' : 'none';
            if (target && element) {
              element.classList.add('is-color-drop-target');
              colorDropElement.current = element;
            }
          }}
          onDragLeaveCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clearColorDrop();
          }}
          onDropCapture={(event) => {
            if (!event.dataTransfer.types.includes(COLOR_PRESET_DRAG_MIME)) return;
            event.preventDefault();
            event.stopPropagation();
            clearColorDrop();
            const element =
              event.target instanceof Element
                ? event.target.closest<HTMLElement>('[data-color-track]')
                : null;
            const current = store.getState();
            const target =
              current.doc && element
                ? resolveColorDrop(
                    current.doc,
                    element.dataset.colorTrack,
                    element.dataset.colorBlock,
                    current.lockedTrackKeys,
                  )
                : null;
            const preset = event.dataTransfer.getData(COLOR_PRESET_DRAG_MIME);
            if (target && preset === 'color') store.addVideoColorEffect(target);
            else if (target && isColorPresetId(preset)) store.applyVideoColorPreset(target, preset);
          }}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes(TRACK_REORDER_MIME)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'none';
              return;
            }
            if (event.dataTransfer.types.includes(PROJECT_MEDIA_DRAG_MIME)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
              const relPath = event.dataTransfer.getData(PROJECT_MEDIA_DRAG_MIME);
              const media = state.project?.media.find((candidate) => candidate.relPath === relPath);
              setMediaDropTarget({
                kind: media?.kind === 'audio' ? 'audio' : 'layer',
                trackId: null,
                time: round2(timeAtClientX(event.clientX)),
              });
              return;
            }
            if (event.dataTransfer.types.includes(EFFECT_DRAG_MIME)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
              setEffectDropTime(timeAtClientX(event.clientX));
              return;
            }
            if (!event.dataTransfer.types.includes(LIBRARY_DRAG_MIME)) return;
            if (libraryImportTargetLocked) {
              setLibraryDropTime(null);
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            setLibraryDropTime(timeAtClientX(event.clientX));
          }}
          onDragLeave={(event) => {
            const related = event.relatedTarget;
            if (related instanceof Node && event.currentTarget.contains(related)) return;
            setLibraryDropTime(null);
            setEffectDropTime(null);
            setMediaDropTarget(null);
          }}
          onDrop={(event) => {
            if (event.dataTransfer.types.includes(TRACK_REORDER_MIME)) {
              event.preventDefault();
              setTrackReorder(null);
              return;
            }
            if (event.dataTransfer.types.includes(PROJECT_MEDIA_DRAG_MIME)) {
              event.preventDefault();
              const relPath = event.dataTransfer.getData(PROJECT_MEDIA_DRAG_MIME);
              const at = round2(timeAtClientX(event.clientX));
              setMediaDropTarget(null);
              const media = state.project?.media.find((candidate) => candidate.relPath === relPath);
              if (relPath && media?.kind === 'audio') store.addAudioClip(relPath, at);
              else if (relPath) store.addLayer(relPath, at);
              return;
            }
            if (event.dataTransfer.types.includes(EFFECT_DRAG_MIME)) {
              event.preventDefault();
              setEffectDropTime(null);
              const type = event.dataTransfer.getData(EFFECT_DRAG_MIME);
              const entry = EFFECT_LIBRARY.find((candidate) => candidate.type === type);
              if (entry) store.addEffect(entry.create(round2(timeAtClientX(event.clientX))));
              return;
            }
            event.preventDefault();
            setLibraryDropTime(null);
            if (libraryImportTargetLocked) return;
            const id = event.dataTransfer.getData(LIBRARY_DRAG_MIME);
            if (!id) return;
            const at = Math.round(timeAtClientX(event.clientX) * 100) / 100;
            void importLibraryItemAt(id, at);
          }}
        >
          <div className="ruler">
            <div className="timeline-ruler-corner" />
            <div className="ruler-lane" ref={timeCanvasRef}>
              {Array.from({ length: Math.ceil(duration / 5) + 1 }, (_, i) => (
                <span className="tick" key={i} style={{ left: toX(i * 5) }}>
                  {String(i * 5)}s
                </span>
              ))}
            </div>
          </div>

          {/* always rendered: the label is the only way back into the subtitle inspector */}
          <div
            className={`track subtitle-track ${state.subtitleInspectorOpen ? 'selected' : ''} ${
              doc.subtitles.enabled ? '' : 'is-preview-hidden'
            } ${isTrackCollapsed(SUBTITLE_TRACK_COLLAPSE_KEY) ? 'is-collapsed' : ''} ${
              subtitleTrackLocked ? 'is-locked' : ''
            }`}
          >
            <TrackHeader
              collapsed={isTrackCollapsed(SUBTITLE_TRACK_COLLAPSE_KEY)}
              label={t('timeline.subtitles')}
              locked={subtitleTrackLocked}
              actions={
                <button
                  type="button"
                  className="track-control eye"
                  title={
                    doc.subtitles.enabled ? t('timeline.track.hide') : t('timeline.track.show')
                  }
                  aria-label={
                    doc.subtitles.enabled ? t('timeline.track.hide') : t('timeline.track.show')
                  }
                  aria-pressed={!doc.subtitles.enabled}
                  onClick={() => {
                    store.updateSubtitleSettings({ enabled: !doc.subtitles.enabled });
                  }}
                >
                  <UiIcon d={doc.subtitles.enabled ? UI_ICON.eye : UI_ICON.eyeOff} />
                </button>
              }
              onToggleCollapsed={() => {
                toggleTrackCollapsed(SUBTITLE_TRACK_COLLAPSE_KEY);
              }}
              onToggleLocked={() => {
                store.toggleTrackLocked(SUBTITLE_EDITOR_TRACK_KEY);
              }}
            />
            <div className="track-lane">
              <TrackLaneName
                disabled={subtitleTrackLocked}
                icon={UI_ICON.captions}
                label={t('timeline.subtitles')}
                onClick={() => {
                  store.selectSubtitles();
                }}
              />
              {cues.map((cue, i) => {
                const isSelectedCue =
                  state.selectedCue?.source === cue.source &&
                  state.selectedCue.wordStart === cue.wordStart &&
                  state.selectedCue.wordEnd === cue.wordEnd;
                return (
                  <div
                    key={i}
                    className={`block subtitle-cue ${startsAtTimelineOrigin(cue.start) ? 'starts-at-zero' : ''} ${isSelectedCue ? 'selected' : ''} ${isExtraCue(cue) ? 'selected-extra' : ''}`}
                    style={{ left: toX(cue.start), width: Math.max(2, toX(cue.end - cue.start)) }}
                    title={cue.text}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      if (subtitleTrackLocked) return;
                      const target = {
                        source: cue.source,
                        wordStart: cue.wordStart,
                        wordEnd: cue.wordEnd,
                      };
                      if (event.metaKey || event.ctrlKey) {
                        store.toggleSelectCue(target);
                        return;
                      }
                      if (event.shiftKey) {
                        store.rangeSelectCue(target, orderedCueSelections);
                        return;
                      }
                      store.selectCue(target);
                      if (!playheadPinned) playhead.seek(timeAtClientX(event.clientX));
                    }}
                  />
                );
              })}
              {!drag && !scrubbing && cueBatchToolbar()}
              {(doc.subtitles.hiddenRanges ?? []).flatMap((range, rangeIndex) =>
                segments
                  .filter((segment) => segment.source === range.source)
                  .map((segment) => {
                    const overlapStart = Math.max(range.start, segment.in);
                    const overlapEnd = Math.min(range.end, segment.out);
                    if (overlapEnd <= overlapStart) return null;
                    const left = toX(segmentOutputTime(segment, overlapStart));
                    const width = Math.max(2, toX((overlapEnd - overlapStart) / segment.speed));
                    return (
                      <button
                        key={`hidden-${String(rangeIndex)}-${String(segment.blockIndex)}`}
                        type="button"
                        className="subtitle-hidden"
                        style={{ left, width }}
                        disabled={subtitleTrackLocked}
                        title={t('timeline.subtitleHidden.title')}
                        aria-label={t('timeline.subtitleHidden.title')}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          store.unhideSubtitleRange(rangeIndex);
                        }}
                      />
                    );
                  })
                  .filter((element): element is JSX.Element => element !== null),
              )}
            </div>
          </div>

          {visualOverlayTracks.map((track) => {
            // Overlapping elements split into stacked lanes so none hides
            // another; the higher row is the block that composites on top.
            const spans = track.blocks.map((block, blockIndex) => {
              const preview = previewValue(track.id, blockIndex);
              const blockDuration = block.duration ?? 2;
              const at = preview?.kind === 'move' ? preview.value : block.at;
              const start =
                preview?.kind === 'edge-in'
                  ? Math.min(preview.value, block.at + blockDuration - 0.2)
                  : at;
              const end =
                preview?.kind === 'edge-out'
                  ? Math.max(preview.value, block.at + 0.2)
                  : at + blockDuration;
              return { start, end };
            });
            const { lanes, laneCount } = assignOverlayLanes(spans);
            const collapsed = isTrackCollapsed(trackCollapseKey(track.id));
            const stacked = laneCount > 1 && !collapsed;
            return (
              <div
                className={`track overlay-track element-track ${stacked ? 'is-stacked' : ''} ${
                  state.hiddenTracks.has(track.id) ? 'is-preview-hidden' : ''
                } ${collapsed ? 'is-collapsed' : ''} ${
                  isTrackLocked(track.id) ? 'is-locked' : ''
                } ${trackReorder?.sourceId === track.id ? 'is-track-dragging' : ''} ${
                  trackReorder?.targetId === track.id ? 'is-track-drop-target' : ''
                }`}
                key={track.id}
                style={
                  stacked
                    ? {
                        height: `calc(var(--track-head-h) + (var(--h-xs) - 3px) * ${String(laneCount)} + 3px)`,
                      }
                    : undefined
                }
                onDragOver={(event) => {
                  hoverTrackReorder(event, track.id);
                }}
                onDrop={(event) => {
                  dropTrackReorder(event, track.id);
                }}
              >
                <TrackHeader
                  collapsed={isTrackCollapsed(trackCollapseKey(track.id))}
                  label={track.label ?? t('timeline.overlays')}
                  locked={isTrackLocked(track.id)}
                  actions={
                    <>
                      <button
                        type="button"
                        className="track-control eye"
                        title={
                          state.hiddenTracks.has(track.id)
                            ? t('timeline.track.show')
                            : t('timeline.track.hide')
                        }
                        aria-label={
                          state.hiddenTracks.has(track.id)
                            ? t('timeline.track.show')
                            : t('timeline.track.hide')
                        }
                        aria-pressed={state.hiddenTracks.has(track.id)}
                        onClick={() => {
                          store.toggleTrackVisibility(track.id);
                        }}
                      >
                        <UiIcon
                          d={state.hiddenTracks.has(track.id) ? UI_ICON.eyeOff : UI_ICON.eye}
                        />
                      </button>
                      {trackRemoveButton(track)}
                    </>
                  }
                  onToggleCollapsed={() => {
                    toggleTrackCollapsed(trackCollapseKey(track.id));
                  }}
                  onToggleLocked={() => {
                    store.toggleTrackLocked(track.id);
                  }}
                />
                <div className="track-lane">
                  <TrackLaneName
                    icon={UI_ICON.overlay}
                    label={track.label ?? t('timeline.overlays')}
                    reorder={trackReorderProps(track)}
                  />
                  {track.blocks.map((block, blockIndex) => {
                    const preview = previewValue(track.id, blockIndex);
                    const blockDuration = block.duration ?? 2;
                    const { start, end } = spans[blockIndex] ?? {
                      start: block.at,
                      end: block.at + blockDuration,
                    };
                    const row = laneCount - 1 - (lanes[blockIndex] ?? 0);
                    const isSelected =
                      state.selection?.trackId === track.id &&
                      state.selection.blockIndex === blockIndex;
                    return (
                      <div
                        key={blockIndex}
                        data-clip-track={track.id}
                        data-clip-index={blockIndex}
                        className={`block overlay-block ${startsAtTimelineOrigin(start) ? 'starts-at-zero' : ''} ${isSelected ? 'selected' : ''} ${isExtraSelected(track.id, blockIndex) ? 'selected-extra' : ''} ${preview ? 'is-dragging' : ''}`}
                        style={{
                          left: toX(start),
                          width: Math.max(6, toX(end - start)),
                          ...(stacked ? { '--lane-row': String(row) } : {}),
                        }}
                        title={block.title?.text ?? block.file}
                        onPointerDown={(event) => {
                          beginDrag(event, track.id, blockIndex, 'move', block.at);
                        }}
                        onContextMenu={(event) => {
                          openContextMenu(event, 'overlay', track.id, blockIndex);
                        }}
                      >
                        <span className="effect-label">
                          {block.title ? (
                            `T ${block.title.text.slice(0, 22)}`
                          ) : (
                            <UiIcon d={UI_ICON.overlay} size={12} />
                          )}
                        </span>
                        <span
                          className="edge left"
                          onPointerDown={(event) => {
                            beginDrag(event, track.id, blockIndex, 'edge-in', block.at);
                          }}
                        />
                        <span
                          className="edge right"
                          onPointerDown={(event) => {
                            beginDrag(
                              event,
                              track.id,
                              blockIndex,
                              'edge-out',
                              block.at + blockDuration,
                            );
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* upper layers: positioned by `at` on the output timeline */}
          {visualVideoTracks.map((track) => (
            <ContextMenu key={track.id}>
              <ContextMenuTrigger asChild>
                <div
                  className={`track video-layer-track ${state.hiddenTracks.has(track.id) ? 'is-preview-hidden' : ''} ${
                    isTrackCollapsed(trackCollapseKey(track.id)) ? 'is-collapsed' : ''
                  } ${isTrackLocked(track.id) ? 'is-locked' : ''} ${
                    mediaDropTarget?.kind === 'layer' && mediaDropTarget.trackId === track.id
                      ? 'is-media-drop-target'
                      : ''
                  } ${trackReorder?.sourceId === track.id ? 'is-track-dragging' : ''} ${
                    trackReorder?.targetId === track.id ? 'is-track-drop-target' : ''
                  }`}
                  onDragOver={(event) => {
                    hoverTrackReorder(event, track.id);
                  }}
                  onDrop={(event) => {
                    dropTrackReorder(event, track.id);
                  }}
                >
                  <TrackHeader
                    collapsed={isTrackCollapsed(trackCollapseKey(track.id))}
                    label={track.label?.trim() ?? track.id}
                    locked={isTrackLocked(track.id)}
                    actions={
                      <>
                        <button
                          type="button"
                          className="track-control eye"
                          title={
                            state.hiddenTracks.has(track.id)
                              ? t('timeline.track.show')
                              : t('timeline.track.hide')
                          }
                          aria-label={
                            state.hiddenTracks.has(track.id)
                              ? t('timeline.track.show')
                              : t('timeline.track.hide')
                          }
                          aria-pressed={state.hiddenTracks.has(track.id)}
                          onClick={() => {
                            store.toggleTrackVisibility(track.id);
                          }}
                        >
                          <UiIcon
                            d={state.hiddenTracks.has(track.id) ? UI_ICON.eyeOff : UI_ICON.eye}
                          />
                        </button>
                        <button
                          type="button"
                          className="track-control"
                          title={
                            track.muted === true
                              ? t('timeline.track.unmute')
                              : t('timeline.track.mute')
                          }
                          aria-label={
                            track.muted === true
                              ? t('timeline.track.unmute')
                              : t('timeline.track.mute')
                          }
                          aria-pressed={track.muted === true}
                          onClick={() => {
                            store.setTrackMuted(track.id, track.muted !== true);
                          }}
                        >
                          <UiIcon d={track.muted === true ? UI_ICON.volumeOff : UI_ICON.volume} />
                        </button>
                        {trackRemoveButton(track)}
                      </>
                    }
                    onToggleCollapsed={() => {
                      toggleTrackCollapsed(trackCollapseKey(track.id));
                    }}
                    onToggleLocked={() => {
                      store.toggleTrackLocked(track.id);
                    }}
                  />
                  <div
                    className="track-lane"
                    data-color-track={track.id}
                    onDragOver={(event) => {
                      updateMediaDropTarget(event, 'layer', track.id);
                    }}
                    onDragLeave={leaveMediaDropTarget}
                    onDrop={(event) => {
                      dropProjectMedia(event, 'layer', track.id);
                    }}
                  >
                    <TrackLaneName
                      icon={UI_ICON.media}
                      label={track.label ?? track.id}
                      accessory={
                        track.color && videoColorFilter(track.color) ? (
                          <button
                            type="button"
                            className="track-indicator is-active"
                            aria-label={`Efeitos da camada ${track.label ?? track.id}`}
                            title="Cor aplicada · abrir efeitos"
                            onClick={() => {
                              store.openColorInspector({ trackId: track.id });
                            }}
                          >
                            fx
                          </button>
                        ) : undefined
                      }
                      reorder={trackReorderProps(track)}
                    />
                    {mediaDropTarget?.kind === 'layer' && mediaDropTarget.trackId === track.id && (
                      <span
                        className="media-drop-preview"
                        style={{ left: toX(mediaDropTarget.time) }}
                      >
                        <span>{t('media.dropLayer')}</span>
                      </span>
                    )}
                    {track.blocks.map((block, blockIndex) => {
                      if (!isLayerBlock(block)) return null;
                      const preview = previewValue(track.id, blockIndex);
                      const at = preview?.kind === 'move' ? preview.value : block.at;
                      const inValue = preview?.kind === 'edge-in' ? preview.value : block.in;
                      const outValue = preview?.kind === 'edge-out' ? preview.value : block.out;
                      const width = toX(outValue - inValue);
                      const isSelected =
                        state.selection?.trackId === track.id &&
                        state.selection.blockIndex === blockIndex;
                      return (
                        <div
                          key={blockIndex}
                          data-color-track={track.id}
                          data-color-block={blockIndex}
                          data-clip-track={track.id}
                          data-clip-index={blockIndex}
                          className={`block layer ${startsAtTimelineOrigin(at) ? 'starts-at-zero' : ''} ${isSelected ? 'selected' : ''} ${isExtraSelected(track.id, blockIndex) ? 'selected-extra' : ''} ${preview ? 'is-dragging' : ''}`}
                          style={{ left: toX(at), width }}
                          onPointerDown={(event) => {
                            beginDrag(event, track.id, blockIndex, 'move', block.at);
                          }}
                          onContextMenu={(event) => {
                            openContextMenu(event, 'layer', track.id, blockIndex);
                          }}
                        >
                          <BlockWaveform
                            peaks={state.peaks.get(block.source)}
                            thumbUrl={thumbUrlFor(block.source)}
                            from={inValue}
                            to={outValue}
                            widthPx={width}
                          />
                          {block.color && (
                            <button
                              type="button"
                              className="clip-color-indicator"
                              title="Cor deste clipe · abrir ajustes"
                              aria-label="Ajustar cor deste clipe"
                              onPointerDown={(e) => {
                                e.stopPropagation();
                              }}
                              onClick={() => {
                                store.openColorInspector({ trackId: track.id, blockIndex });
                              }}
                            >
                              fx
                            </button>
                          )}
                          <span
                            className="edge left"
                            onPointerDown={(event) => {
                              beginDrag(event, track.id, blockIndex, 'edge-in', block.in);
                            }}
                          />
                          <span
                            className="edge right"
                            onPointerDown={(event) => {
                              beginDrag(event, track.id, blockIndex, 'edge-out', block.out);
                            }}
                          />
                        </div>
                      );
                    })}
                    {!drag && !scrubbing && layerBlockToolbar(track)}
                  </div>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent
                className="w-[190px]"
                aria-label={t('timeline.contextMenu.layerActions')}
              >
                <ContextMenuLabel className="truncate font-[var(--font-data)] text-[10px] font-normal text-muted-foreground">
                  {track.label?.trim() ?? track.id}
                </ContextMenuLabel>
                <ContextMenuItem
                  variant="destructive"
                  disabled={isTrackLocked(track.id)}
                  onSelect={() => {
                    store.removeTrack(track.id);
                    setCollapsedTrackKeys((current) => {
                      const next = new Set(current);
                      next.delete(trackCollapseKey(track.id));
                      return next;
                    });
                  }}
                >
                  {isTrackLocked(track.id)
                    ? t('timeline.contextMenu.unlockToRemoveLayer')
                    : t('timeline.contextMenu.removeLayer')}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}

          {visualAudioTracks.map((track) => (
            <div
              className={`track audio-track ${
                isTrackCollapsed(trackCollapseKey(track.id)) ? 'is-collapsed' : ''
              } ${isTrackLocked(track.id) ? 'is-locked' : ''} ${
                mediaDropTarget?.kind === 'audio' && mediaDropTarget.trackId === track.id
                  ? 'is-media-drop-target'
                  : ''
              } ${trackReorder?.sourceId === track.id ? 'is-track-dragging' : ''} ${
                trackReorder?.targetId === track.id ? 'is-track-drop-target' : ''
              }`}
              key={track.id}
              onDragOver={(event) => {
                hoverTrackReorder(event, track.id);
              }}
              onDrop={(event) => {
                dropTrackReorder(event, track.id);
              }}
            >
              <TrackHeader
                collapsed={isTrackCollapsed(trackCollapseKey(track.id))}
                label={audioTrackLabel(track)}
                locked={isTrackLocked(track.id)}
                actions={
                  <>
                    <button
                      type="button"
                      className="track-control"
                      title={
                        track.muted === true ? t('timeline.track.unmute') : t('timeline.track.mute')
                      }
                      aria-label={
                        track.muted === true ? t('timeline.track.unmute') : t('timeline.track.mute')
                      }
                      aria-pressed={track.muted === true}
                      onClick={() => {
                        store.setTrackMuted(track.id, track.muted !== true);
                      }}
                    >
                      <UiIcon d={track.muted === true ? UI_ICON.volumeOff : UI_ICON.volume} />
                    </button>
                    {trackRemoveButton(track)}
                  </>
                }
                onToggleCollapsed={() => {
                  toggleTrackCollapsed(trackCollapseKey(track.id));
                }}
                onToggleLocked={() => {
                  store.toggleTrackLocked(track.id);
                }}
              />
              <div
                className="track-lane"
                onDragOver={(event) => {
                  updateMediaDropTarget(event, 'audio', track.id);
                }}
                onDragLeave={leaveMediaDropTarget}
                onDrop={(event) => {
                  dropProjectMedia(event, 'audio', track.id);
                }}
              >
                <TrackLaneName
                  icon={UI_ICON.volume}
                  label={audioTrackLabel(track)}
                  reorder={trackReorderProps(track, audioTrackLabel(track))}
                />
                {mediaDropTarget?.kind === 'audio' && mediaDropTarget.trackId === track.id && (
                  <span className="media-drop-preview" style={{ left: toX(mediaDropTarget.time) }}>
                    <span>{t('media.dropAudio')}</span>
                  </span>
                )}
                {track.blocks.map((block, blockIndex) => {
                  const preview = previewValue(track.id, blockIndex);
                  const envelopePreview = audioEnvelopePreview(track.id, blockIndex);
                  const { at, inValue, outValue } = audioBlockPreview(
                    block,
                    preview,
                    doc.sources[block.source]?.durationS,
                  );
                  const blockDuration = Math.max(0.01, outValue - inValue);
                  const width = Math.max(6, toX(blockDuration));
                  const gainDb =
                    envelopePreview?.kind === 'gain' ? envelopePreview.value : (block.gainDb ?? 0);
                  const fadeInS =
                    envelopePreview?.kind === 'fade-in'
                      ? envelopePreview.value
                      : (block.fadeInS ?? 0);
                  const fadeOutS =
                    envelopePreview?.kind === 'fade-out'
                      ? envelopePreview.value
                      : (block.fadeOutS ?? 0);
                  const envelopeHeight = 44;
                  const gainY = 4 + ((12 - gainDb) / 72) * (envelopeHeight - 8);
                  const fadeInX = Math.min(width, toX(fadeInS));
                  const fadeOutX = Math.min(width, toX(fadeOutS));
                  const isSelected =
                    state.selection?.trackId === track.id &&
                    state.selection.blockIndex === blockIndex;
                  const sourceLabel = doc.sources[block.source]?.path ?? block.source;
                  return (
                    <div
                      key={blockIndex}
                      data-clip-track={track.id}
                      data-clip-index={blockIndex}
                      className={`block audio-layer ${startsAtTimelineOrigin(at) ? 'starts-at-zero' : ''} ${isSelected ? 'selected' : ''} ${isExtraSelected(track.id, blockIndex) ? 'selected-extra' : ''} ${preview ? 'is-dragging' : ''}`}
                      style={{ left: toX(at), width }}
                      title={sourceLabel}
                      role="group"
                      tabIndex={isTrackLocked(track.id) ? -1 : 0}
                      aria-label={sourceLabel}
                      onFocus={(event) => {
                        if (event.target === event.currentTarget) {
                          store.select({ trackId: track.id, blockIndex });
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget || isTrackLocked(track.id)) return;
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          event.stopPropagation();
                          store.select({ trackId: track.id, blockIndex });
                          return;
                        }
                        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                          event.preventDefault();
                          event.stopPropagation();
                          store.select({ trackId: track.id, blockIndex });
                          const direction = event.key === 'ArrowLeft' ? -1 : 1;
                          store.nudgeSelectedBlock(direction * (event.shiftKey ? 1 : frameS));
                          return;
                        }
                        if (
                          event.key === 'ContextMenu' ||
                          (event.shiftKey && event.key === 'F10')
                        ) {
                          event.preventDefault();
                          event.stopPropagation();
                          const rect = event.currentTarget.getBoundingClientRect();
                          showContextMenu(
                            'audio',
                            track.id,
                            blockIndex,
                            rect.left + Math.min(rect.width / 2, 180),
                            rect.top + Math.min(rect.height / 2, 24),
                          );
                        }
                      }}
                      onPointerDown={(event) => {
                        beginDrag(event, track.id, blockIndex, 'move', block.at);
                      }}
                      onContextMenu={(event) => {
                        openContextMenu(event, 'audio', track.id, blockIndex);
                      }}
                    >
                      <BlockWaveform
                        peaks={state.peaks.get(block.source)}
                        from={inValue}
                        to={outValue}
                        widthPx={width}
                      />
                      <span className="audio-clip-name">{sourceLabel}</span>
                      <svg
                        className="audio-envelope-curve"
                        viewBox={`0 0 ${String(width)} ${String(envelopeHeight)}`}
                        preserveAspectRatio="none"
                        aria-hidden="true"
                      >
                        <polyline
                          points={`0,${String(envelopeHeight)} ${String(fadeInX)},${String(gainY)} ${String(Math.max(fadeInX, width - fadeOutX))},${String(gainY)} ${String(width)},${String(envelopeHeight)}`}
                        />
                      </svg>
                      <button
                        type="button"
                        role="slider"
                        className="audio-envelope-gain"
                        style={{ top: gainY }}
                        aria-label={t('timeline.audio.gain')}
                        aria-valuemin={-60}
                        aria-valuemax={12}
                        aria-valuenow={gainDb}
                        title={`${t('timeline.audio.gain')}: ${gainDb.toFixed(1)} dB`}
                        onPointerDown={(event) => {
                          beginAudioEnvelopeDrag(
                            event,
                            track.id,
                            blockIndex,
                            'gain',
                            gainDb,
                            blockDuration,
                            0,
                          );
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                          event.preventDefault();
                          store.setAudioBlockGain(
                            track.id,
                            blockIndex,
                            gainDb + (event.key === 'ArrowUp' ? 1 : -1),
                          );
                        }}
                      />
                      <button
                        type="button"
                        role="slider"
                        className="audio-envelope-handle is-in"
                        style={{ left: fadeInX, top: gainY }}
                        aria-label={t('timeline.audio.fadeIn')}
                        aria-valuemin={0}
                        aria-valuemax={blockDuration - fadeOutS}
                        aria-valuenow={fadeInS}
                        title={`${t('timeline.audio.fadeIn')}: ${fadeInS.toFixed(2)}s`}
                        onPointerDown={(event) => {
                          beginAudioEnvelopeDrag(
                            event,
                            track.id,
                            blockIndex,
                            'fade-in',
                            fadeInS,
                            blockDuration,
                            fadeOutS,
                          );
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                          event.preventDefault();
                          store.setAudioBlockFades(track.id, blockIndex, {
                            fadeInS: fadeInS + (event.key === 'ArrowRight' ? frameS : -frameS),
                            fadeOutS,
                          });
                        }}
                      />
                      <button
                        type="button"
                        role="slider"
                        className="audio-envelope-handle is-out"
                        style={{ left: width - fadeOutX, top: gainY }}
                        aria-label={t('timeline.audio.fadeOut')}
                        aria-valuemin={0}
                        aria-valuemax={blockDuration - fadeInS}
                        aria-valuenow={fadeOutS}
                        title={`${t('timeline.audio.fadeOut')}: ${fadeOutS.toFixed(2)}s`}
                        onPointerDown={(event) => {
                          beginAudioEnvelopeDrag(
                            event,
                            track.id,
                            blockIndex,
                            'fade-out',
                            fadeOutS,
                            blockDuration,
                            fadeInS,
                          );
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                          event.preventDefault();
                          store.setAudioBlockFades(track.id, blockIndex, {
                            fadeInS,
                            fadeOutS: fadeOutS + (event.key === 'ArrowLeft' ? frameS : -frameS),
                          });
                        }}
                      />
                      {isSelected && (
                        <span className="audio-gain-badge">{gainDb.toFixed(1)} dB</span>
                      )}
                      <span
                        className="edge left"
                        onPointerDown={(event) => {
                          beginDrag(event, track.id, blockIndex, 'edge-in', block.at);
                        }}
                      />
                      <span
                        className="edge right"
                        onPointerDown={(event) => {
                          beginDrag(
                            event,
                            track.id,
                            blockIndex,
                            'edge-out',
                            block.at + (block.out - block.in),
                          );
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {visualEffectTracks.map((track) => (
            <div
              className={`track overlay-track effect-track ${
                state.hiddenTracks.has(track.id) ? 'is-preview-hidden' : ''
              } ${isTrackCollapsed(trackCollapseKey(track.id)) ? 'is-collapsed' : ''} ${
                isTrackLocked(track.id) ? 'is-locked' : ''
              } ${trackReorder?.sourceId === track.id ? 'is-track-dragging' : ''} ${
                trackReorder?.targetId === track.id ? 'is-track-drop-target' : ''
              }`}
              key={track.id}
              onDragOver={(event) => {
                hoverTrackReorder(event, track.id);
              }}
              onDrop={(event) => {
                dropTrackReorder(event, track.id);
              }}
            >
              <TrackHeader
                collapsed={isTrackCollapsed(trackCollapseKey(track.id))}
                label={track.label ?? t('timeline.effects')}
                locked={isTrackLocked(track.id)}
                actions={
                  <>
                    <button
                      type="button"
                      className="track-control eye"
                      title={
                        state.hiddenTracks.has(track.id)
                          ? t('timeline.track.show')
                          : t('timeline.track.hide')
                      }
                      aria-label={
                        state.hiddenTracks.has(track.id)
                          ? t('timeline.track.show')
                          : t('timeline.track.hide')
                      }
                      aria-pressed={state.hiddenTracks.has(track.id)}
                      onClick={() => {
                        store.toggleTrackVisibility(track.id);
                      }}
                    >
                      <UiIcon d={state.hiddenTracks.has(track.id) ? UI_ICON.eyeOff : UI_ICON.eye} />
                    </button>
                    {trackRemoveButton(track)}
                  </>
                }
                onToggleCollapsed={() => {
                  toggleTrackCollapsed(trackCollapseKey(track.id));
                }}
                onToggleLocked={() => {
                  store.toggleTrackLocked(track.id);
                }}
              />
              <div className="track-lane">
                <TrackLaneName
                  icon={ICON_FLASH}
                  label={track.label ?? t('timeline.effects')}
                  reorder={trackReorderProps(track)}
                />
                {track.blocks.map((block, blockIndex) => {
                  const preview = previewValue(track.id, blockIndex);
                  const at = preview?.kind === 'move' ? preview.value : block.at;
                  const start =
                    preview?.kind === 'edge-in'
                      ? Math.min(preview.value, block.at + block.duration - 0.2)
                      : at;
                  const end =
                    preview?.kind === 'edge-out'
                      ? Math.max(preview.value, block.at + 0.2)
                      : at + block.duration;
                  const isSelected =
                    state.selection?.trackId === track.id &&
                    state.selection.blockIndex === blockIndex;
                  const chip = effectChipContent(block);
                  return (
                    <div
                      key={blockIndex}
                      data-clip-track={track.id}
                      data-clip-index={blockIndex}
                      className={`block effect-block ${startsAtTimelineOrigin(start) ? 'starts-at-zero' : ''} ${isSelected ? 'selected' : ''} ${isExtraSelected(track.id, blockIndex) ? 'selected-extra' : ''} ${preview ? 'is-dragging' : ''}`}
                      style={{ left: toX(start), width: Math.max(6, toX(end - start)) }}
                      title={chip.title}
                      onPointerDown={(event) => {
                        beginDrag(event, track.id, blockIndex, 'move', block.at);
                      }}
                      onContextMenu={(event) => {
                        openContextMenu(event, 'effect', track.id, blockIndex);
                      }}
                    >
                      <span className="effect-label">
                        <UiIcon d={chip.icon} size={12} />
                        {chip.label}
                      </span>
                      <span
                        className="edge left"
                        onPointerDown={(event) => {
                          beginDrag(event, track.id, blockIndex, 'edge-in', block.at);
                        }}
                      />
                      <span
                        className="edge right"
                        onPointerDown={(event) => {
                          beginDrag(
                            event,
                            track.id,
                            blockIndex,
                            'edge-out',
                            block.at + block.duration,
                          );
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {/* base line: blocks define the output timeline; gaps show cut material */}
          <div
            className={`track base-track ${
              isTrackCollapsed(trackCollapseKey(baseTrackId)) ? 'is-collapsed' : ''
            } ${isTrackLocked(baseTrackId) ? 'is-locked' : ''} ${
              mediaDropTarget?.kind === 'base' ? 'is-media-drop-target' : ''
            }`}
          >
            <TrackHeader
              collapsed={isTrackCollapsed(trackCollapseKey(baseTrackId))}
              label={t('timeline.baseLabel')}
              locked={isTrackLocked(baseTrackId)}
              actions={
                <button
                  type="button"
                  className="track-control"
                  title={
                    videoTracks[0]?.muted === true
                      ? t('timeline.track.unmute')
                      : t('timeline.track.mute')
                  }
                  aria-label={
                    videoTracks[0]?.muted === true
                      ? t('timeline.track.unmute')
                      : t('timeline.track.mute')
                  }
                  aria-pressed={videoTracks[0]?.muted === true}
                  onClick={() => {
                    store.setTrackMuted(baseTrackId, videoTracks[0]?.muted !== true);
                  }}
                >
                  <UiIcon d={videoTracks[0]?.muted === true ? UI_ICON.volumeOff : UI_ICON.volume} />
                </button>
              }
              onToggleCollapsed={() => {
                toggleTrackCollapsed(trackCollapseKey(baseTrackId));
              }}
              onToggleLocked={() => {
                setTransitionMenuFor(null);
                store.toggleTrackLocked(baseTrackId);
              }}
            />
            <div
              className="track-lane"
              data-color-track={baseTrackId}
              onDragOver={(event) => {
                updateMediaDropTarget(event, 'base', baseTrackId);
              }}
              onDragLeave={leaveMediaDropTarget}
              onDrop={(event) => {
                dropProjectMedia(event, 'base', baseTrackId);
              }}
            >
              <TrackLaneName
                icon={UI_ICON.volume}
                label={baseAudioLabel}
                title={`Áudio: ${baseAudioTitle}`}
                onClick={() => {
                  store.setAudioOpen(true);
                }}
                accessory={
                  <>
                    <button
                      type="button"
                      className={`track-indicator ${baseEffects ? 'is-active' : ''}`}
                      aria-label="Efeitos da camada base"
                      title={
                        baseEffects ? 'Cor aplicada · abrir efeitos' : 'Adicionar efeitos à camada'
                      }
                      onClick={() => {
                        store.openColorInspector({ trackId: baseTrackId });
                      }}
                    >
                      fx
                    </button>
                    {baseSpeed && (
                      <button
                        type="button"
                        className="track-indicator is-active"
                        aria-label={`Velocidade da base: ${baseSpeedLabel}`}
                        title="Velocidade aplicada · abrir ajustes"
                        onClick={() => {
                          store.openColorInspector({ trackId: baseTrackId });
                        }}
                      >
                        {baseSpeedLabel}
                      </button>
                    )}
                  </>
                }
              />
              {mediaDropTarget?.kind === 'base' && (
                <span className="media-drop-preview" style={{ left: toX(mediaDropTarget.time) }}>
                  <span>{t('media.dropSequence')}</span>
                </span>
              )}
              {state.cutReviewOpen &&
                state.cutReviewMode === 'silences' &&
                silenceCandidates.map((marker) => (
                  <span
                    key={marker.id}
                    className="suggestion-marker"
                    style={{
                      left: toX(marker.outputStart),
                      width: Math.max(3, toX(marker.length)),
                    }}
                  />
                ))}
              {state.cutReviewOpen &&
                state.cutReviewMode === 'suggestions' &&
                suggestionMarkers.map(({ suggestion, rangeIndex, at, durationS }) => (
                  <button
                    key={`${suggestion.id}:${String(rangeIndex)}`}
                    type="button"
                    data-slot="cut-suggestion-marker"
                    className="suggestion-marker"
                    style={{
                      left: toX(at),
                      width: Math.max(3, toX(durationS)),
                    }}
                    aria-label={`Ir para ${suggestion.reason}`}
                    title={suggestion.reason}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      playhead.seek(at);
                    }}
                  />
                ))}
              {segments.map((segment, i) => {
                const preview = previewValue(videoTracks[0]?.id ?? 'base', segment.blockIndex);
                const inValue = preview?.kind === 'edge-in' ? preview.value : segment.in;
                const outValue = preview?.kind === 'edge-out' ? preview.value : segment.out;
                // outValue/inValue are SOURCE time; the block's speed compresses/stretches that
                // window into a shorter/longer span of OUTPUT time (see segmentOutputTime) — the
                // same divide outputSegments() already applied when it computed outputEnd.
                const width = toX((outValue - inValue) / segment.speed);
                const left =
                  preview?.kind === 'move'
                    ? preview.value
                    : (reorderShiftedLeft.get(segment.blockIndex) ?? segment.outputStart);
                const isSelected =
                  state.selection?.trackId === (videoTracks[0]?.id ?? 'base') &&
                  state.selection.blockIndex === segment.blockIndex;
                const previousSegment = segments[i - 1];
                const transition = previousSegment
                  ? videoTracks[0]?.blocks[segment.blockIndex]?.transition
                  : undefined;
                const segmentBlock = videoTracks[0]?.blocks[segment.blockIndex];
                const segmentSpeed =
                  segmentBlock && !isLayerBlock(segmentBlock) ? segmentBlock.speed : undefined;
                return (
                  <div key={i}>
                    {previousSegment && (
                      <Popover
                        open={
                          !isTrackLocked(baseTrackId) && transitionMenuFor === segment.blockIndex
                        }
                        onOpenChange={(next) => {
                          setTransitionMenuFor(
                            next && !isTrackLocked(baseTrackId) ? segment.blockIndex : null,
                          );
                        }}
                      >
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            disabled={isTrackLocked(baseTrackId)}
                            className={`transition-chip ${transition ? 'has-transition' : ''}`}
                            style={{ left: toX(segment.outputStart) }}
                            title={
                              transition
                                ? `${transitionTypeLabel(transition.type)} · ${transition.durationS.toFixed(2)}s`
                                : t('timeline.transition.chipAddTitle')
                            }
                            aria-label={
                              transition
                                ? `${transitionTypeLabel(transition.type)} · ${transition.durationS.toFixed(2)}s`
                                : t('timeline.transition.chipAddTitle')
                            }
                            onPointerDown={(event) => {
                              event.stopPropagation();
                            }}
                          />
                        </PopoverTrigger>
                        <TransitionMenu
                          blockIndex={segment.blockIndex}
                          transition={transition}
                          crossfadeUnavailable={previousSegment.speed !== 1 || segment.speed !== 1}
                        />
                      </Popover>
                    )}
                    <div
                      data-color-track={baseTrackId}
                      data-color-block={segment.blockIndex}
                      data-clip-track={baseTrackId}
                      data-clip-index={segment.blockIndex}
                      className={`block ${startsAtTimelineOrigin(left) ? 'starts-at-zero' : ''} ${isSelected ? 'selected' : ''} ${isExtraSelected(videoTracks[0]?.id ?? 'base', segment.blockIndex) ? 'selected-extra' : ''} ${preview?.kind === 'move' ? 'is-dragging' : ''}`}
                      style={{ left: toX(left), width }}
                      onPointerDown={(event) => {
                        beginDrag(
                          event,
                          videoTracks[0]?.id ?? 'base',
                          segment.blockIndex,
                          'move',
                          segment.outputStart,
                        );
                      }}
                      onContextMenu={(event) => {
                        openContextMenu(
                          event,
                          'base',
                          videoTracks[0]?.id ?? 'base',
                          segment.blockIndex,
                        );
                      }}
                    >
                      <BlockWaveform
                        peaks={
                          showProcessedBase
                            ? (processedAudio.peaks ?? undefined)
                            : state.peaks.get(segment.source)
                        }
                        waveformFrom={
                          showProcessedBase
                            ? processedSegmentWindow(segment, doc.output.speed ?? 1).from
                            : undefined
                        }
                        waveformTo={
                          showProcessedBase
                            ? processedSegmentWindow(segment, doc.output.speed ?? 1).to
                            : undefined
                        }
                        thumbUrl={thumbUrlFor(segment.source)}
                        from={inValue}
                        to={outValue}
                        widthPx={width}
                      />
                      {segmentBlock?.color && (
                        <button
                          type="button"
                          className="clip-color-indicator"
                          title="Cor deste clipe · abrir ajustes"
                          aria-label="Ajustar cor deste clipe"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                          }}
                          onClick={() => {
                            store.openColorInspector({
                              trackId: baseTrackId,
                              blockIndex: segment.blockIndex,
                            });
                          }}
                        >
                          fx
                        </button>
                      )}
                      {baseSpeeds.length > 1 &&
                        segmentSpeed !== undefined &&
                        segmentSpeed !== 1 && <span className="speed-badge">{segmentSpeed}×</span>}
                      <span
                        className="edge left"
                        onPointerDown={(event) => {
                          beginDrag(
                            event,
                            videoTracks[0]?.id ?? 'base',
                            segment.blockIndex,
                            'edge-in',
                            segment.in,
                          );
                        }}
                      />
                      <span
                        className="edge right"
                        onPointerDown={(event) => {
                          beginDrag(
                            event,
                            videoTracks[0]?.id ?? 'base',
                            segment.blockIndex,
                            'edge-out',
                            segment.out,
                          );
                        }}
                      />
                    </div>
                  </div>
                );
              })}
              {!drag && !scrubbing && baseBlockToolbar()}
              {(() => {
                const indicatorLeft = baseDropIndicatorX();
                return indicatorLeft === null ? null : (
                  <span className="drop-indicator" style={{ left: indicatorLeft }} />
                );
              })()}
            </div>
          </div>

          {doc.canvas && (
            <div
              className={`track overlay-track background-track ${
                isTrackCollapsed(BACKGROUND_EDITOR_TRACK_KEY) ? 'is-collapsed' : ''
              } ${backgroundTrackLocked ? 'is-locked' : ''}`}
            >
              <TrackHeader
                collapsed={isTrackCollapsed(BACKGROUND_EDITOR_TRACK_KEY)}
                label={t('timeline.background')}
                locked={backgroundTrackLocked}
                actions={null}
                onToggleCollapsed={() => {
                  toggleTrackCollapsed(BACKGROUND_EDITOR_TRACK_KEY);
                }}
                onToggleLocked={() => {
                  store.toggleTrackLocked(BACKGROUND_EDITOR_TRACK_KEY);
                }}
              />
              <div className="track-lane">
                <TrackLaneName
                  icon={UI_ICON.image}
                  label={t('timeline.background')}
                  disabled={backgroundTrackLocked}
                  onClick={() => {
                    store.selectBackground();
                  }}
                />
                <button
                  type="button"
                  className={`block background-block ${
                    state.backgroundInspectorOpen ? 'selected' : ''
                  }`}
                  style={{
                    left: 0,
                    width: Math.max(6, toX(duration)),
                    backgroundColor:
                      doc.canvas.background.kind === 'color'
                        ? doc.canvas.background.color
                        : (doc.canvas.background.color ?? 'var(--media-void)'),
                    ...(doc.canvas.background.kind === 'image'
                      ? {
                          backgroundImage: `url(${JSON.stringify(
                            api.mediaUrl(doc.canvas.background.file),
                          )})`,
                          backgroundPosition: 'center',
                          backgroundSize:
                            doc.canvas.background.fit === 'cover' ? 'cover' : 'contain',
                        }
                      : {}),
                  }}
                  disabled={backgroundTrackLocked}
                  aria-label={t('inspector.background.title')}
                  onClick={() => {
                    store.selectBackground();
                  }}
                >
                  <span className="background-block-label">
                    <UiIcon d={UI_ICON.image} size={11} />
                    {doc.canvas.background.kind === 'color'
                      ? doc.canvas.background.color
                      : doc.canvas.background.kind === 'image'
                        ? doc.canvas.background.file.split('/').at(-1)
                        : (doc.sources[doc.canvas.background.source]?.path.split('/').at(-1) ??
                          doc.canvas.background.source)}
                  </span>
                </button>
              </div>
            </div>
          )}

          <div className="timeline-guide-layer">
            {drag?.snap?.snapped && (
              <span className="snap-guide" style={{ left: toX(drag.snap.time) }} />
            )}

            {libraryDropTime !== null && (
              <span className="drop-indicator" style={{ left: toX(libraryDropTime) }} />
            )}

            {effectDropTime !== null && (
              <span className="drop-indicator" style={{ left: toX(effectDropTime) }} />
            )}

            {mediaDropTarget?.kind === 'layer' && mediaDropTarget.trackId === null && (
              <span
                className="media-drop-preview media-drop-preview-global"
                style={{ left: toX(mediaDropTarget.time) }}
              >
                <span>{t('media.dropNewLayer')}</span>
              </span>
            )}
            {mediaDropTarget?.kind === 'audio' && mediaDropTarget.trackId === null && (
              <span
                className="media-drop-preview media-drop-preview-global"
                style={{ left: toX(mediaDropTarget.time) }}
              >
                <span>{t('media.dropNewAudio')}</span>
              </span>
            )}

            <div className="playhead" style={{ left: toX(time) }}>
              <span className="playhead-handle" />
            </div>
          </div>
        </div>
      </div>
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          {(menu.kind === 'base' || menu.kind === 'layer' || menu.kind === 'audio') && (
            <button
              onClick={() => {
                playhead.seek(menu.outputTime);
                store.splitAtPlayhead(menu.outputTime);
                setMenu(null);
              }}
            >
              <UiIcon d={UI_ICON.split} />
              <span>{t('timeline.contextMenu.splitHere')}</span>
            </button>
          )}
          <button
            onClick={() => {
              store.deleteSelectedBlock();
              setMenu(null);
            }}
          >
            <UiIcon d={UI_ICON.remove} />
            <span>{t('timeline.contextMenu.deleteBlock')}</span>
          </button>
          {(menu.kind === 'base' || menu.kind === 'layer') && (
            <button
              onClick={() => {
                const window = zoomWindowForMenu();
                if (window) store.addZoomEffect(window.at, window.duration, 1.15);
                setMenu(null);
              }}
            >
              <UiIcon d={UI_ICON.zoom} />
              <span>{t('timeline.contextMenu.applyZoom')}</span>
            </button>
          )}
          {menu.kind === 'base' && (
            <button
              className={speedMenuOpen ? 'active' : ''}
              onClick={() => {
                setSpeedMenuOpen((open) => !open);
              }}
            >
              <UiIcon d={ICON_SPEED} />
              <span>{t('timeline.contextMenu.speed')}</span>
            </button>
          )}
          {menu.kind === 'base' && speedMenuOpen && (
            <div className="speed-panel">
              <div className="speed-presets">
                {SPEED_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className={`speed-preset ${menuBaseSpeed === preset ? 'active' : ''}`}
                    onClick={() => {
                      store.setBlockSpeed(menu.blockIndex, preset);
                      setMenu(null);
                    }}
                  >
                    {preset}×
                  </button>
                ))}
              </div>
              <label className="speed-custom">
                <span>{t('timeline.contextMenu.speed.custom')}</span>
                <input
                  type="number"
                  min={SPEED_BOUNDS.min}
                  max={SPEED_BOUNDS.max}
                  step={0.05}
                  value={menuBaseSpeed}
                  onChange={(event) => {
                    // Number('') === 0, not NaN — skip the write outright while the field is
                    // empty (mid-clear) instead of letting the store's finite check wave it
                    // through and clamp it to SPEED_BOUNDS.min on every keystroke.
                    if (event.target.value === '') return;
                    store.setBlockSpeed(
                      menu.blockIndex,
                      Number(event.target.value),
                      `speed:${String(menu.blockIndex)}`,
                    );
                  }}
                />
              </label>
            </div>
          )}
          <button
            onClick={() => {
              playhead.seek(menu.outputTime);
              playhead.setPlaying(true);
              setMenu(null);
            }}
          >
            <UiIcon d={UI_ICON.play} filled />
            <span>{t('timeline.contextMenu.playFromHere')}</span>
          </button>
        </div>
      )}
      {drag?.snap?.snapped && (
        <div className="snap-tooltip" style={{ left: drag.clientX + 12, top: drag.clientY - 30 }}>
          {drag.snap.word ? `“${drag.snap.word.text}” · ` : ''}
          {drag.snap.time.toFixed(2)}s
        </div>
      )}
    </div>
  );
}
