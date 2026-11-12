import type { VideoTrack } from '../../../core/schema.js';
import { resolvedVideoColor, videoColorCss } from '../../../core/videoColor.js';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type PointerEvent,
} from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { api } from '../../api.js';
import { t, tf } from '../../i18n/index.js';
import { UI_ICON, UiIcon } from '../../components/UiIcon.js';
import {
  baseTrackOf,
  isLayerBlock,
  SHAKE_DEFAULT_INTENSITY,
  type AudioBlock,
  type EffectBlock,
  type LayerBlock,
  type LayerCell,
  type OverlayBlock,
} from '../../../core/schema.js';
import {
  outputDuration,
  outputSegments,
  segmentOutputTime,
  sourceTimeAt,
} from '../../../core/timeline.js';
import { buildSubtitleCues, subtitleSettingsFor, subtitleThemeFor } from '../../../core/srt.js';
import { OVERLAY_MARGIN_FRACTION, PIP_DEFAULT_SCALE } from '../../../core/overlayPlacement.js';
import { store } from '../../state/store.js';
import {
  BACKGROUND_EDITOR_TRACK_KEY,
  DEFAULT_LAYER_CELL,
  SUBTITLE_EDITOR_TRACK_KEY,
} from '../../state/docEdits.js';
import { playhead } from '../../state/playhead.js';
import { CROSSFADE_MIN_OVERLAP_S, crossfadeOverlapS } from './crossfadePreview.js';
import { playerAudioController, playerAudioFrame, syncPlayerAudioElement } from './playerAudio.js';
import { layerZ, overlayZ, pipPlace, swappedMiniStyle } from './playerStacking.js';
import { TrimmedOverlayVideo } from './TrimmedOverlayVideo.js';
import { effectivePlayerLayerAudio, isPlayerTrackVisible } from './playerTrackSemantics.js';
import { playbackSourceUrl, resolvePlaybackMode } from './playbackSource.js';
import { summarizeRenderProgress } from './renderProgress.js';
import { togglePlayerFullscreen } from './fullscreen.js';
import { engineClockStep, PLAYING_TOLERANCE_S, SCRUB_TOLERANCE_S } from './engineClock.js';
import { type LayerInstance, layerVideoKey, syncLayerVideos } from './layerSync.js';
import {
  subtitleGraphicPreviewKey,
  subtitleGraphicPreviewSvg,
} from '../inspector/subtitleGraphicPreview.js';
import { usePlayheadTime, usePlaying, useStore } from '../../state/hooks.js';

/** How far ahead of a crossfade window the ghost element seeks into place (still opacity 0, but decoding — see CROSSFADE_READY_STATE) so the window-open frame is already decoded instead of a mid-seek stall. */
const CROSSFADE_PRESEEK_LEAD_S = 0.3;
/** Tighter than PLAYING_TOLERANCE_S: the ghost element is a cosmetic overlay, not the clock, so drift is corrected quickly instead of accumulating for a whole tolerance window. */
const CROSSFADE_RESYNC_TOLERANCE_S = 0.08;
/** How long after a fresh `play()` call the ghost keeps PLAYING_TOLERANCE_S's looser slack instead of CROSSFADE_RESYNC_TOLERANCE_S's — a video just past a seek needs a moment to actually present a frame; resyncing against it too eagerly cancels the in-flight decode and never lets it catch up. */
const CROSSFADE_PLAY_SETTLE_MS = 150;
/** HTMLMediaElement.HAVE_CURRENT_DATA — numeric literal so this doesn't depend on the DOM lib being loaded in every consumer of this file (e.g. tests). */
const CROSSFADE_READY_STATE = 2;
const PLAYER_BACKGROUND_Z_INDEX = 0;
const PLAYER_BASE_Z_INDEX = 1;
const PLAYER_CROSSFADE_Z_INDEX = 2;
const PLAYER_EFFECT_Z_INDEX = 3;

interface AudioInstance {
  readonly trackId: string;
  readonly blockIndex: number;
  readonly block: AudioBlock;
  readonly muted: boolean;
}

function PlayerAudioElement({
  audioKey,
  src,
  register,
}: {
  readonly audioKey: string;
  readonly src: string | undefined;
  readonly register: (key: string, element: HTMLAudioElement | null) => void;
}): JSX.Element {
  const elementRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    register(audioKey, element);
    return () => {
      register(audioKey, null);
    };
  }, [audioKey, register]);

  return <audio ref={elementRef} src={src} preload="auto" aria-hidden="true" />;
}

type PipDrag = { layer: LayerInstance; kind: 'move' | 'resize' } | null;

/**
 * `kind: 'move'` uses grabDX/grabDY (pointer offset from the cell's x/y at
 * drag start); `kind: 'resize'` uses anchorX/anchorY (the opposite corner,
 * which stays fixed while the dragged corner follows the pointer).
 */
type CellDrag = {
  layer: LayerInstance;
  kind: 'move' | 'resize';
  grabDX: number;
  grabDY: number;
  anchorX: number;
  anchorY: number;
} | null;

type CanvasCellDrag = {
  kind: 'move' | 'resize';
  grabDX: number;
  grabDY: number;
  anchorX: number;
  anchorY: number;
} | null;

/**
 * Mirrors the store's `clampLayerCell` (not exported) so the on-canvas rect
 * never visibly escapes the stage between a drag frame and the store's
 * commit — the store re-clamps and rounds on write regardless.
 */
function clampCellPreview(cell: LayerCell): LayerCell {
  const w = Math.min(1, Math.max(0.05, cell.w));
  const h = Math.min(1, Math.max(0.05, cell.h));
  const x = Math.min(1 - w, Math.max(0, cell.x));
  const y = Math.min(1 - h, Math.max(0, cell.y));
  return { x, y, w, h };
}

function transformStyle(block: {
  transform?: { scale: number; x: number; y: number } | undefined;
}): string {
  const t = block.transform;
  if (!t) return '';
  return `translate(${String(t.x * 100)}%, ${String(t.y * 100)}%) scale(${String(t.scale)})`;
}

interface CrossfadeWindow {
  /** Output-time boundary between the two base blocks (segment B's outputStart). */
  readonly outputStart: number;
  readonly durationS: number;
  readonly source: string;
  readonly sourceIn: number;
  readonly blockIndex: number;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m)}:${s.toFixed(1).padStart(4, '0')}`;
}

function hexToRgba(hex: string, opacity: number): string {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${String(red)}, ${String(green)}, ${String(blue)}, ${String(opacity)})`;
}

function subtitlePreviewHtml(text: string): string {
  return text
    .replace(/<font color="(#[0-9a-f]{6})">/gi, '<span style="color:$1">')
    .replace(/<\/font>/gi, '</span>');
}

/**
 * ASS's \bord grows outward from the glyph edge with ROUND joins. A centered
 * text-stroke (doubled width, fill on top) matches that while thin, but its
 * miter joins grow spikes on sharp corners once the width passes a few pixels
 * — Arial Black's "A" apex shoots a triangle upward. Past that point the
 * outline becomes a dense ring of hard text-shadows: the union of glyph
 * copies displaced around a circle is a circular dilation, which is exactly
 * a round-joined outline. (The old 4-corner shadow version of this read as a
 * doubled black copy of the text instead.)
 */
function outlineStyle(color: string, width: number): CSSProperties {
  if (width <= 0) return {};
  if (width < 3) {
    return {
      WebkitTextStroke: `${String(Math.round(width * 2 * 10) / 10)}px ${color}`,
      paintOrder: 'stroke fill',
    };
  }
  const shadows: string[] = [];
  const ring = (radius: number, steps: number, phase: number): void => {
    for (let i = 0; i < steps; i++) {
      const angle = (2 * Math.PI * (i + phase)) / steps;
      const x = (Math.cos(angle) * radius).toFixed(1);
      const y = (Math.sin(angle) * radius).toFixed(1);
      shadows.push(`${x}px ${y}px 0 ${color}`);
    }
  };
  // adjacent copies must overlap: arc gap 2πr/steps stays under ~2px
  ring(width, Math.max(16, Math.ceil(width * Math.PI)), 0);
  ring(width * 0.6, 8, 0.5);
  return { textShadow: shadows.join(',') };
}

/**
 * Honest live approximation: proxy videos chased by (or driving) the output
 * clock, split/PiP in CSS. The ffmpeg render is the truth — hence the badge.
 */
export function Player(): JSX.Element | null {
  const state = useStore();
  const time = usePlayheadTime();
  const playing = usePlaying();
  const stageRef = useRef<HTMLDivElement>(null);
  const videosRef = useRef(new Map<string, HTMLVideoElement>());
  const programVideoRef = useRef<HTMLVideoElement>(null);
  const audiosRef = useRef(new Map<string, HTMLAudioElement>());
  const [pipDrag, setPipDrag] = useState<PipDrag>(null);
  const [cellDrag, setCellDrag] = useState<CellDrag>(null);
  const [canvasCellDrag, setCanvasCellDrag] = useState<CanvasCellDrag>(null);
  const [subtitleDrag, setSubtitleDrag] = useState(false);
  const zoomBaseRef = useRef('');
  const zoomTransformRef = useRef('');
  const shakeTransformRef = useRef('');
  /** performance.now() of the crossfade ghost's most recent play() call — null while paused/inactive. Drives the CROSSFADE_PLAY_SETTLE_MS resync grace period. */
  // Keyed per ghost element: a single shared timestamp would be wiped every
  // tick by whichever ghost is INACTIVE, collapsing the settle window to one
  // frame whenever two crossfades with different sources exist.
  const crossfadePlayStartedAtRef = useRef(new Map<string, number>());
  const [reframeDrag, setReframeDrag] = useState<{
    trackId: string;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    mode: 'move' | 'scale';
    baseScale: number;
  } | null>(null);
  const [overlayDrag, setOverlayDrag] = useState<{
    trackId: string;
    blockIndex: number;
    grabDX: number;
    grabDY: number;
  } | null>(null);
  const [overlayResize, setOverlayResize] = useState<{
    trackId: string;
    blockIndex: number;
    leftFraction: number;
    topFraction: number;
  } | null>(null);
  const [stageHeight, setStageHeight] = useState(0);
  const [subtitleGraphic, setSubtitleGraphic] = useState<{
    readonly key: string;
    readonly svg: string;
  } | null>(null);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(false);
  /** 'fit' letterboxes the stage into the viewer; a number is pixels per output pixel. */
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const playerRootRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = (): void => {
      setFullscreen(document.fullscreenElement === playerRootRef.current);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
    };
  }, []);
  const loopRef = useRef(loop);
  loopRef.current = loop;
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const registerAudioElement = useCallback((key: string, element: HTMLAudioElement | null) => {
    if (element) {
      audiosRef.current.set(key, element);
      playerAudioController.attach(element);
      return;
    }
    const previous = audiosRef.current.get(key);
    if (previous) {
      previous.pause();
      playerAudioController.detach(previous);
    }
    audiosRef.current.delete(key);
  }, []);

  const doc = state.doc;
  const isTrackLocked = (trackId: string): boolean => state.lockedTrackKeys.has(trackId);
  const baseMuted = doc ? baseTrackOf(doc).muted === true : false;
  const duration = useMemo(() => (doc ? outputDuration(doc) : 0), [doc]);
  const segments = useMemo(() => (doc ? outputSegments(doc) : []), [doc]);
  const previewFresh = state.project?.hasPreview === true && !state.previewOutdated;
  const mode = resolvePlaybackMode({
    proofRequested: state.proofMode,
    previewFresh,
    // On-stage canvas-cell editing lives in the simulation's base window.
    programFresh:
      state.project?.hasProgram === true &&
      !state.programOutdated &&
      !state.backgroundInspectorOpen,
  });
  const programSource =
    mode === 'simulation'
      ? null
      : playbackSourceUrl(
          mode,
          { programVersion: state.programVersion, previewVersion: state.previewVersion },
          api.mediaUrl,
        );
  const rendering = state.activeJobs.has('render');
  const renderProgress = summarizeRenderProgress(state.activeJobs.get('render')?.progress);

  const hasDoc = doc !== null;
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setStageHeight(entry.contentRect.height);
    });
    observer.observe(stage);
    return () => {
      observer.disconnect();
    };
  }, [hasDoc]);

  /** Playback uses the light proxy when it exists; render always uses originals. */
  const sourceUrl = useMemo(() => {
    const map = new Map<string, string>();
    if (!doc) return map;
    for (const [key, source] of Object.entries(doc.sources)) {
      const media = state.project?.media.find((m) => m.relPath === source.path);
      map.set(key, api.mediaUrl(media?.proxyRelPath ?? source.path));
    }
    return map;
  }, [doc, state.project]);

  /** Real (probed) source durations, for crossfadeOverlapS's A-side clamp — same media lookup as sourceUrl above. */
  const sourceDurationS = useMemo(() => {
    const map = new Map<string, number>();
    if (!doc) return map;
    for (const [key, source] of Object.entries(doc.sources)) {
      const media = state.project?.media.find((m) => m.relPath === source.path);
      if (media?.kind !== 'image' && media !== undefined) map.set(key, media.durationS);
    }
    return map;
  }, [doc, state.project]);

  const layers = useMemo<LayerInstance[]>(() => {
    if (!doc) return [];
    return doc.tracks
      .slice(1)
      .filter((track) => track.kind === 'video')
      .filter(isPlayerTrackVisible)
      .flatMap((track) =>
        track.blocks.flatMap((block, blockIndex): LayerInstance[] =>
          isLayerBlock(block)
            ? [
                {
                  trackId: track.id,
                  blockIndex,
                  block,
                  audio: effectivePlayerLayerAudio(track.muted === true, block.audio),
                },
              ]
            : [],
        ),
      );
  }, [doc]);
  const audioLayers = useMemo<AudioInstance[]>(() => {
    if (!doc) return [];
    return doc.tracks
      .filter((track) => track.kind === 'audio')
      .flatMap((track) =>
        track.blocks.map((block, blockIndex) => ({
          trackId: track.id,
          blockIndex,
          block,
          muted: track.muted === true,
        })),
      );
  }, [doc]);
  const hasAudioLayers = audioLayers.length > 0;
  useEffect(() => {
    if (!hasAudioLayers) return;
    const resumeFromGesture = (): void => {
      void playerAudioController.resume();
    };
    window.addEventListener('pointerdown', resumeFromGesture, { capture: true });
    window.addEventListener('keydown', resumeFromGesture, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', resumeFromGesture, { capture: true });
      window.removeEventListener('keydown', resumeFromGesture, { capture: true });
    };
  }, [hasAudioLayers]);

  useEffect(() => {
    if (hasAudioLayers && playing) void playerAudioController.resume();
  }, [hasAudioLayers, playing]);

  const overlays = useMemo<{ trackId: string; blockIndex: number; block: OverlayBlock }[]>(() => {
    if (!doc) return [];
    return doc.tracks
      .filter((track) => track.kind === 'overlay')
      .filter(isPlayerTrackVisible)
      .flatMap((track) =>
        track.blocks.map((block, blockIndex) => ({ trackId: track.id, blockIndex, block })),
      );
  }, [doc]);
  const effects = useMemo(() => {
    if (!doc) return [];
    return doc.tracks
      .filter((track) => track.kind === 'effect')
      .filter(isPlayerTrackVisible)
      .flatMap((track) => track.blocks);
  }, [doc]);
  const cues = useMemo(
    () => (doc?.subtitles.enabled ? buildSubtitleCues(doc, state.transcripts) : []),
    [doc, state.transcripts],
  );
  const currentCue = cues.find((cue) => time >= cue.start && time < cue.end);
  const currentCueIndex = currentCue === undefined ? -1 : cues.indexOf(currentCue);
  const currentGraphicInput = useMemo(() => {
    if (!doc || !currentCue || doc.subtitles.forceStyle !== undefined) return undefined;
    const theme = subtitleThemeFor(doc);
    if (theme.backgroundStyle !== 'pill') return undefined;
    return {
      cue: currentCue,
      dimensions: { width: doc.output.width, height: doc.output.height },
      settings: subtitleSettingsFor(doc),
      theme,
    } as const;
  }, [currentCue, doc]);
  const currentGraphicKey =
    currentGraphicInput === undefined ? undefined : subtitleGraphicPreviewKey(currentGraphicInput);

  useEffect(() => {
    if (currentGraphicInput === undefined || currentGraphicKey === undefined) return;
    let active = true;
    void subtitleGraphicPreviewSvg(currentGraphicInput)
      .then((svg) => {
        if (active) setSubtitleGraphic({ key: currentGraphicKey, svg });
      })
      .catch(() => {
        // The legacy HTML caption remains visible as an honest fallback if a
        // bundled font cannot be loaded; export will fail rather than publish
        // a mismatched vector caption.
      });

    // Pre-render the next two karaoke states while the current word is on
    // screen, so normal playback swaps already-cached SVGs without flicker.
    for (const cue of cues.slice(currentCueIndex + 1, currentCueIndex + 3)) {
      if (!doc) break;
      void subtitleGraphicPreviewSvg({
        cue,
        dimensions: { width: doc.output.width, height: doc.output.height },
        settings: subtitleSettingsFor(doc),
        theme: subtitleThemeFor(doc),
      }).catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [cues, currentCueIndex, currentGraphicInput, currentGraphicKey, doc]);
  /**
   * Every base-block emenda (segment index >= 1) that carries a renderable
   * dip — includes a crossfade that doesn't clear crossfadeOverlapS's test,
   * since that's exactly when `resolveJoin` degrades it to fade-black at
   * render. `segments[i]` (not `segment.blockIndex - 1`) is deliberate: `i`
   * is this flatMap's own positional index into `segments.slice(1)` shifted
   * back by one, so it doesn't assume blockIndex tracks array position.
   */
  const transitionDips = useMemo(() => {
    if (!doc) return [];
    const base = baseTrackOf(doc);
    return segments.slice(1).flatMap((segment, i) => {
      const transition = base.blocks[segment.blockIndex]?.transition;
      if (!transition) return [];
      if (transition.type === 'crossfade') {
        const overlapS = crossfadeOverlapS(
          segments[i],
          segment,
          transition.durationS,
          sourceDurationS,
        );
        if (overlapS >= CROSSFADE_MIN_OVERLAP_S) return [];
        return [
          {
            outputStart: segment.outputStart,
            durationS: transition.durationS,
            color: 'var(--media-void)',
          },
        ];
      }
      return [
        {
          outputStart: segment.outputStart,
          durationS: transition.durationS,
          color: transition.type === 'fade-black' ? 'var(--media-void)' : 'var(--on-media)',
        },
      ];
    });
  }, [doc, segments, sourceDurationS]);
  /**
   * Real crossfade blends — simulated with a single "ghost" video showing the
   * INCOMING block (B), opacity ramping 0→1 across the FIRST half of the
   * window, then held at 1 through the second half while the ghost tracks
   * the primary's own post-switch B timeline exactly (see the tick loop
   * below). The primary base video hard-cuts A→B at t0 underneath, fully
   * hidden because the ghost is already opaque by then — mirroring both A
   * and B independently proved unstable (seeking A past its own `out` has no
   * guaranteed material), so this single-ghost approximation is the shipped
   * v1: visually a legitimate crossfade.
   */
  const crossfadeWindows = useMemo<CrossfadeWindow[]>(() => {
    if (!doc) return [];
    const base = baseTrackOf(doc);
    return segments.slice(1).flatMap((segment, i) => {
      const transition = base.blocks[segment.blockIndex]?.transition;
      if (transition?.type !== 'crossfade') return [];
      const overlapS = crossfadeOverlapS(
        segments[i],
        segment,
        transition.durationS,
        sourceDurationS,
      );
      if (overlapS < CROSSFADE_MIN_OVERLAP_S) return [];
      return [
        {
          outputStart: segment.outputStart,
          durationS: transition.durationS,
          source: segment.source,
          sourceIn: segment.in,
          blockIndex: segment.blockIndex,
        },
      ];
    });
  }, [doc, segments, sourceDurationS]);
  /** Unique sources actually needed by a crossfade ghost — empty on a doc with no eligible crossfades, so the common case pays zero extra <video> elements (see MAJOR 1). */
  const crossfadeSources = useMemo(
    () => [...new Set(crossfadeWindows.map((w) => w.source))],
    [crossfadeWindows],
  );

  useEffect(() => {
    if (!doc || mode !== 'simulation') return;
    let raf = 0;
    let lastBlockIndex = -1;

    const tick = (): void => {
      const current = playhead.time;
      const active = sourceTimeAt(doc, current);
      const segment = active ? segments[active.blockIndex] : undefined;
      const crossedBlock = active !== null && active.blockIndex !== lastBlockIndex;
      if (active !== null) lastBlockIndex = active.blockIndex;

      const background = doc.canvas?.background;
      const backgroundVideo = videosRef.current.get('background');
      if (backgroundVideo && background?.kind === 'video') {
        const probedDuration = sourceDurationS.get(background.source);
        const mediaDuration = Number.isFinite(backgroundVideo.duration)
          ? backgroundVideo.duration
          : undefined;
        const backgroundDuration = probedDuration ?? mediaDuration;
        const wanted =
          backgroundDuration !== undefined && backgroundDuration > 0
            ? current % backgroundDuration
            : current;
        backgroundVideo.muted = true;
        backgroundVideo.loop = true;
        if (playhead.playing) {
          if (backgroundVideo.playbackRate !== rateRef.current) {
            backgroundVideo.playbackRate = rateRef.current;
          }
          if (Math.abs(backgroundVideo.currentTime - wanted) > PLAYING_TOLERANCE_S) {
            backgroundVideo.currentTime = wanted;
          }
          if (backgroundVideo.paused) void backgroundVideo.play().catch(() => undefined);
        } else {
          if (!backgroundVideo.paused) backgroundVideo.pause();
          if (Math.abs(backgroundVideo.currentTime - wanted) > SCRUB_TOLERANCE_S) {
            backgroundVideo.currentTime = wanted;
          }
        }
      }

      for (const [key, video] of videosRef.current) {
        if (!key.startsWith('base:')) continue;
        const sourceKey = key.slice(5);
        const isActive = active !== null && active.source === sourceKey;
        video.muted = baseMuted;
        video.style.visibility = isActive ? 'visible' : 'hidden';
        if (isActive) {
          const block =
            doc.tracks[0]?.kind === 'video' ? doc.tracks[0].blocks[active.blockIndex] : undefined;
          video.style.filter =
            videoColorCss(resolvedVideoColor(baseTrackOf(doc).color, block?.color)) ?? '';
          const wanted = block ? transformStyle(block) : '';
          if (
            video.style.transform !== wanted &&
            zoomTransformRef.current === '' &&
            shakeTransformRef.current === ''
          ) {
            video.style.transform = wanted;
          }
          zoomBaseRef.current = wanted;
        }
        if (!isActive) {
          if (!video.paused) video.pause();
          continue;
        }

        if (playhead.playing && segment) {
          // The block's own speed (segment.speed, render-honored) stacks with the user's
          // manual preview-rate picker — both compress the SAME source video element.
          const wantedRate = rateRef.current * segment.speed;
          if (video.playbackRate !== wantedRate) video.playbackRate = wantedRate;
          if (video.paused) void video.play().catch(() => undefined);
          const position = video.currentTime;
          // Entering a new block ALWAYS hard-seeks: tiny pause cuts (< tolerance)
          // would otherwise play through the gap and rewind the clock,
          // repeating the boundary word in the preview.
          if (crossedBlock || Math.abs(position - active.time) > PLAYING_TOLERANCE_S) {
            video.currentTime = active.time;
          } else if (position >= segment.out - 0.02) {
            // segment exhausted — hop the clock to the next block
            if (segment.outputEnd >= duration - 0.02) {
              if (loopRef.current) {
                playhead.seek(0);
              } else {
                playhead.seek(duration);
                playhead.setPlaying(false);
              }
            } else {
              playhead.seek(segment.outputEnd + 0.001);
            }
          } else {
            // the video drives the clock: zero fighting, zero stutter — honor the
            // segment's speed the same way segmentOutputTime does for every other caller
            playhead.seek(segmentOutputTime(segment, position));
          }
        } else {
          if (!video.paused) video.pause();
          if (Math.abs(video.currentTime - active.time) > SCRUB_TOLERANCE_S) {
            video.currentTime = active.time;
          }
        }
      }

      const baseVolume = syncLayerVideos(
        layers,
        videosRef.current,
        current,
        playhead.playing,
        rateRef.current,
        false,
      );

      const audioTime = playhead.time;
      for (const audioLayer of audioLayers) {
        const key = `audio:${audioLayer.trackId}:${String(audioLayer.blockIndex)}`;
        const audio = audiosRef.current.get(key);
        if (!audio) continue;
        syncPlayerAudioElement({
          element: audio,
          frame: playerAudioFrame(audioLayer.block, audioTime, audioLayer.muted, doc.fps),
          playing: playhead.playing,
          playbackRate: rateRef.current,
        });
      }
      const activeZoom = effects.find(
        (e): e is Extract<EffectBlock, { type: 'zoom' }> =>
          e.type === 'zoom' && current >= e.at && current < e.at + e.duration,
      );
      zoomTransformRef.current =
        activeZoom && activeZoom.scale > 1 ? ` scale(${String(activeZoom.scale)})` : '';

      // Preview-only approximation of the render's sine-jitter crop (same
      // frequencies, amplitude re-derived in percent since the on-screen
      // video isn't necessarily rendered at output pixel dimensions).
      const activeShake = effects.find(
        (e): e is Extract<EffectBlock, { type: 'shake' }> =>
          e.type === 'shake' && current >= e.at && current < e.at + e.duration,
      );
      if (activeShake) {
        const intensity = activeShake.intensity ?? SHAKE_DEFAULT_INTENSITY;
        const relT = current - activeShake.at;
        const ampXPercent = 1.6 * (intensity / 5);
        const ampYPercent = 1.2 * (intensity / 5);
        const dx =
          (ampXPercent / 2) * Math.sin(relT * 37) + (ampXPercent / 2) * Math.sin(relT * 53 + 1.3);
        const dy =
          (ampYPercent / 2) * Math.sin(relT * 41) + (ampYPercent / 2) * Math.sin(relT * 59 + 0.7);
        shakeTransformRef.current = ` translate(${dx.toFixed(2)}%, ${dy.toFixed(2)}%)`;
      } else {
        shakeTransformRef.current = '';
      }

      // The ghost element seeks into place up to CROSSFADE_PRESEEK_LEAD_S
      // before its window opens, then fades in across ONLY the first half
      // [t0-d/2, t0] (see the opacity formula below) and holds at full
      // opacity through the second half while tracking the primary's own
      // post-switch B timeline exactly — the current match covers both the
      // pre-seek lead and the window itself, so a scrub landing mid-window
      // resolves correctly too.
      const activeCrossfade = crossfadeWindows.find((cf) => {
        const windowStart = cf.outputStart - cf.durationS / 2;
        const windowEnd = cf.outputStart + cf.durationS / 2;
        return current >= windowStart - CROSSFADE_PRESEEK_LEAD_S && current < windowEnd;
      });
      for (const [key, video] of videosRef.current) {
        if (!key.startsWith('xfade:')) continue;
        const sourceKey = key.slice(6);
        if (activeCrossfade?.source !== sourceKey) {
          if (video.style.display !== 'none') video.style.display = 'none';
          if (video.style.opacity !== '0') video.style.opacity = '0';
          if (!video.paused) video.pause();
          crossfadePlayStartedAtRef.current.delete(sourceKey);
          continue;
        }
        // display stays 'block' for the WHOLE near-window range (pre-seek lead
        // included) — opacity alone hides it. display:none can suspend decode,
        // so toggling it on/off right at window-open risks the first visible
        // frame being a mid-seek stall instead of the pre-seeked frame.
        video.style.filter =
          videoColorCss(
            resolvedVideoColor(
              baseTrackOf(doc).color,
              baseTrackOf(doc).blocks[activeCrossfade.blockIndex]?.color,
            ),
          ) ?? '';
        video.style.display = 'block';
        const windowStart = activeCrossfade.outputStart - activeCrossfade.durationS / 2;
        const inWindow = current >= windowStart;
        const block =
          doc.tracks[0]?.kind === 'video'
            ? doc.tracks[0].blocks[activeCrossfade.blockIndex]
            : undefined;
        const combined =
          `${block ? transformStyle(block) : ''}${zoomTransformRef.current}${shakeTransformRef.current}`.trim();
        if (video.style.transform !== combined) video.style.transform = combined;
        // Frozen on B's own `in` frame for [windowStart, t0) — a still frame
        // fading in under A — then tracks the SAME formula the primary uses
        // once it switches to B at t0 (sourceTimeAt's
        // `segment.in + (outputTime - segment.outputStart)` for speed 1).
        // Matching that formula exactly is what makes the full-opacity ghost
        // land on the same frame the primary is already showing underneath
        // by windowEnd, instead of drifting up to d/2 ahead of it.
        const isTracking = current >= activeCrossfade.outputStart;
        const wantedSourceTime =
          activeCrossfade.sourceIn + Math.max(0, current - activeCrossfade.outputStart);
        if (playhead.playing && isTracking) {
          if (video.playbackRate !== rateRef.current) video.playbackRate = rateRef.current;
          if (video.paused) {
            void video.play().catch(() => undefined);
            crossfadePlayStartedAtRef.current.set(sourceKey, performance.now());
          }
          // Right after a fresh play(), the video hasn't necessarily presented
          // a frame yet — resyncing against CROSSFADE_RESYNC_TOLERANCE_S's tight
          // 80ms would cancel that in-flight decode before it ever catches up,
          // so PLAYING_TOLERANCE_S's looser slack applies for the first
          // CROSSFADE_PLAY_SETTLE_MS after each (re)start.
          const startedAt = crossfadePlayStartedAtRef.current.get(sourceKey);
          const settling =
            startedAt !== undefined && performance.now() - startedAt < CROSSFADE_PLAY_SETTLE_MS;
          const tolerance = settling ? PLAYING_TOLERANCE_S : CROSSFADE_RESYNC_TOLERANCE_S;
          if (Math.abs(video.currentTime - wantedSourceTime) > tolerance) {
            video.currentTime = wantedSourceTime;
          }
        } else {
          if (!video.paused) video.pause();
          crossfadePlayStartedAtRef.current.delete(sourceKey);
          if (Math.abs(video.currentTime - wantedSourceTime) > SCRUB_TOLERANCE_S) {
            video.currentTime = wantedSourceTime;
          }
        }
        // Ramps across the FIRST half only ([windowStart, t0]) and holds at 1
        // through the second half — ramping across the WHOLE window instead
        // would leave the ghost at 50% opacity right at t0, the exact instant
        // the primary hard-cuts A→B underneath, so that cut would show through
        // at half strength: the very pop this simulation exists to hide.
        // Gated on readyState so a not-yet-decoded frame never gets revealed —
        // better a held frame at opacity 0 than a flash of stale/black video.
        const ready = video.readyState >= CROSSFADE_READY_STATE;
        const rampOpacity = inWindow
          ? Math.min(1, (current - windowStart) / (activeCrossfade.durationS / 2))
          : 0;
        video.style.opacity = ready ? String(rampOpacity) : '0';
      }

      for (const [key, video] of videosRef.current) {
        if (key.startsWith('base:')) {
          video.volume = baseVolume;
          const combined =
            `${zoomBaseRef.current}${zoomTransformRef.current}${shakeTransformRef.current}`.trim();
          if (video.style.transform !== combined) video.style.transform = combined;
        }
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [
    audioLayers,
    baseMuted,
    doc,
    duration,
    layers,
    segments,
    effects,
    crossfadeWindows,
    sourceDurationS,
    mode,
  ]);

  // Engine/proof: the rendered file is the clock. The playhead only wins on a
  // real seek (a scrub past the tolerance); otherwise the video reports its
  // own position, so the two never fight over sub-frame differences.
  useEffect(() => {
    if (!doc || mode === 'simulation') return;
    const speed = doc.output.speed ?? 1;
    let raf = 0;
    const tick = (): void => {
      const video = programVideoRef.current;
      if (video) {
        const action = engineClockStep({
          playing: playhead.playing,
          playhead: playhead.time,
          position: video.currentTime,
          fileEnd: Number.isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY,
          ended: video.ended,
          duration,
          loop: loopRef.current,
          speed,
        });
        if (action.kind === 'seek-video') {
          video.currentTime = action.to;
        } else if (action.kind === 'loop') {
          video.currentTime = 0;
          playhead.seek(0);
        } else if (action.kind === 'stop') {
          playhead.seek(duration);
          playhead.setPlaying(false);
        } else if (action.kind === 'follow') {
          playhead.seek(action.time);
        }
        // Seek first (above), then play: a freshly mounted element must not
        // leak its first frames at t=0 before the catch-up seek lands.
        if (playhead.playing) {
          if (video.playbackRate !== rateRef.current) video.playbackRate = rateRef.current;
          if (video.paused && !video.ended) void video.play().catch(() => undefined);
        } else if (!video.paused) {
          video.pause();
        }
      }
      if (mode === 'engine') {
        syncLayerVideos(
          layers,
          videosRef.current,
          playhead.time,
          playhead.playing,
          rateRef.current * speed,
          true,
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [doc, duration, layers, mode]);

  if (!doc) return null;

  // at most one dip active at a time — the first emenda whose window contains `time`
  const activeDip = transitionDips.find(
    (dip) => Math.abs(time - dip.outputStart) <= dip.durationS / 2,
  );
  const activeDipOpacity = activeDip
    ? Math.max(0, 1 - Math.abs(time - activeDip.outputStart) / (activeDip.durationS / 2))
    : 0;
  // Same triangular curve as the render's flash alpha ramp (0 → 0.9 → 0 across the window).
  const activeFlash = effects.find(
    (e): e is Extract<EffectBlock, { type: 'flash' }> =>
      e.type === 'flash' && time >= e.at && time < e.at + e.duration,
  );
  const activeFlashOpacity = activeFlash
    ? 0.9 * Math.max(0, 1 - Math.abs((2 * (time - activeFlash.at)) / activeFlash.duration - 1))
    : 0;
  const subtitleSettings = subtitleSettingsFor(doc);
  const subtitleTheme = subtitleThemeFor(doc);
  const subtitleUnitPx = stageHeight > 0 ? stageHeight / 288 : 1;
  const subtitleFillColor =
    subtitleTheme.fill.kind === 'solid' ? subtitleTheme.fill.color : subtitleTheme.fill.from;
  const subtitleHasPill = subtitleTheme.backgroundStyle === 'pill';
  const uniqueBaseSources = [...new Set(segments.map((segment) => segment.source))];
  const overlayZIndex = overlayZ(layers.length);
  const subtitleZIndex = overlayZIndex + overlays.length + 1;
  const editorChromeZIndex = subtitleZIndex + 1;
  const canvasBackground = doc.canvas?.background;
  const canvasBaseCell = doc.canvas?.base.mode === 'cell' ? doc.canvas.base.cell : null;
  const backgroundTrackLocked = isTrackLocked(BACKGROUND_EDITOR_TRACK_KEY);
  // Swapped PiP mirrors the render graph: the layer covers the frame while the
  // COMPOSED base frame (canvas background + base window, dips and crossfades
  // included) shrinks into the PiP rect — above that layer, below later
  // layers/overlays. Editing the canvas cell keeps the full-size frame so the
  // drag gizmo stays usable. Topmost active swapped layer wins. Known preview
  // approximations (the ffmpeg render is the truth — hence the badge): the
  // render composites stacked swapped PiPs cumulatively, and any LOWER layer
  // active in the window is baked into the render's mini while the preview
  // only covers it with the fullscreen layer.
  const editingCanvasCell = canvasBaseCell !== null && state.backgroundInspectorOpen;
  let activeSwappedPipIndex = -1;
  if (!editingCanvasCell) {
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      const block = layers[i]?.block;
      if (
        block?.mode === 'pip' &&
        block.swapped === true &&
        time >= block.at &&
        time < block.at + (block.out - block.in)
      ) {
        activeSwappedPipIndex = i;
        break;
      }
    }
  }
  const activeSwappedPip = activeSwappedPipIndex >= 0 ? layers[activeSwappedPipIndex] : undefined;

  // The composite frame wraps background + base window. It stays pointer-inert
  // (children opt back in) and joins the stage stacking order only while the
  // swap is active — z-auto otherwise, so child z-indexes behave as before.
  const baseCompositeStyle: React.CSSProperties = activeSwappedPip
    ? swappedMiniStyle(activeSwappedPip.block, activeSwappedPipIndex)
    : { position: 'absolute', inset: 0, pointerEvents: 'none' };

  const baseWindowStyle: React.CSSProperties =
    canvasBaseCell === null
      ? { inset: 0, zIndex: PLAYER_BASE_Z_INDEX }
      : {
          left: `${String(canvasBaseCell.x * 100)}%`,
          top: `${String(canvasBaseCell.y * 100)}%`,
          width: `${String(canvasBaseCell.w * 100)}%`,
          height: `${String(canvasBaseCell.h * 100)}%`,
          zIndex: PLAYER_BASE_Z_INDEX,
        };

  const layerWrapperStyle = (block: LayerBlock): React.CSSProperties => {
    if (block.mode === 'fullscreen') return { position: 'absolute', inset: 0 };
    if (block.mode === 'split') {
      const ratio = block.split?.ratio ?? 0.5;
      const arrangement = block.split?.arrangement ?? 'top';
      if (arrangement === 'left' || arrangement === 'right') {
        return {
          position: 'absolute',
          top: 0,
          height: '100%',
          width: `${String(ratio * 100)}%`,
          ...(arrangement === 'left' ? { left: 0 } : { right: 0 }),
        };
      }
      return {
        position: 'absolute',
        left: 0,
        width: '100%',
        height: `${String(ratio * 100)}%`,
        ...(arrangement === 'top' ? { top: 0 } : { bottom: 0 }),
      };
    }
    if (block.mode === 'cell') {
      const cell = block.cell ?? DEFAULT_LAYER_CELL;
      return {
        position: 'absolute',
        left: `${String(cell.x * 100)}%`,
        top: `${String(cell.y * 100)}%`,
        width: `${String(cell.w * 100)}%`,
        height: `${String(cell.h * 100)}%`,
      };
    }
    if (block.swapped === true) return { position: 'absolute', inset: 0 };
    const scale = block.scale ?? PIP_DEFAULT_SCALE;
    return { position: 'absolute', width: `${String(scale * 100)}%`, ...pipPlace(block.position) };
  };

  const startPipDrag =
    (layer: LayerInstance, kind: 'move' | 'resize') => (event: PointerEvent<HTMLElement>) => {
      if (layer.block.mode !== 'pip' || layer.block.swapped === true) return;
      event.stopPropagation();
      if (isTrackLocked(layer.trackId)) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      store.select({ trackId: layer.trackId, blockIndex: layer.blockIndex });
      setPipDrag({ layer, kind });
    };

  /** `corner` picks which handle grabbed the rect — 'move' drags the whole cell. */
  const startCellDrag =
    (layer: LayerInstance, corner: 'move' | 'tl' | 'tr' | 'bl' | 'br') =>
    (event: PointerEvent<HTMLElement>) => {
      if (layer.block.mode !== 'cell') return;
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return;
      event.stopPropagation();
      if (isTrackLocked(layer.trackId)) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      store.select({ trackId: layer.trackId, blockIndex: layer.blockIndex });
      const cell = layer.block.cell ?? DEFAULT_LAYER_CELL;
      if (corner === 'move') {
        setCellDrag({
          layer,
          kind: 'move',
          grabDX: (event.clientX - rect.left) / rect.width - cell.x,
          grabDY: (event.clientY - rect.top) / rect.height - cell.y,
          anchorX: 0,
          anchorY: 0,
        });
        return;
      }
      const isLeftHandle = corner === 'tl' || corner === 'bl';
      const isTopHandle = corner === 'tl' || corner === 'tr';
      setCellDrag({
        layer,
        kind: 'resize',
        grabDX: 0,
        grabDY: 0,
        anchorX: isLeftHandle ? cell.x + cell.w : cell.x,
        anchorY: isTopHandle ? cell.y + cell.h : cell.y,
      });
    };

  const startCanvasCellDrag =
    (corner: 'move' | 'tl' | 'tr' | 'bl' | 'br') =>
    (event: PointerEvent<HTMLElement>): void => {
      if (doc.canvas?.base.mode !== 'cell') return;
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return;
      event.stopPropagation();
      if (isTrackLocked(BACKGROUND_EDITOR_TRACK_KEY)) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      store.selectBackground();
      const { cell } = doc.canvas.base;
      if (corner === 'move') {
        setCanvasCellDrag({
          kind: 'move',
          grabDX: (event.clientX - rect.left) / rect.width - cell.x,
          grabDY: (event.clientY - rect.top) / rect.height - cell.y,
          anchorX: 0,
          anchorY: 0,
        });
        return;
      }
      const isLeftHandle = corner === 'tl' || corner === 'bl';
      const isTopHandle = corner === 'tl' || corner === 'tr';
      setCanvasCellDrag({
        kind: 'resize',
        grabDX: 0,
        grabDY: 0,
        anchorX: isLeftHandle ? cell.x + cell.w : cell.x,
        anchorY: isTopHandle ? cell.y + cell.h : cell.y,
      });
    };

  const onStagePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    if (reframeDrag) {
      if (isTrackLocked(reframeDrag.trackId)) {
        setReframeDrag(null);
        store.endGesture();
        return;
      }
      // a plain click on the stage must not nudge the frame — same 3px jitter rule as the timeline
      if (
        Math.abs(event.clientX - reframeDrag.startX) +
          Math.abs(event.clientY - reframeDrag.startY) <
        3
      ) {
        return;
      }
      const dx = (event.clientX - reframeDrag.startX) / rect.width;
      const dy = (event.clientY - reframeDrag.startY) / rect.height;
      if (reframeDrag.mode === 'scale') {
        store.setSelectedTransform({
          scale: Math.round((reframeDrag.baseScale + dx * 2) * 100) / 100,
        });
      } else {
        store.setSelectedTransform({
          x: Math.round((reframeDrag.baseX + dx) * 100) / 100,
          y: Math.round((reframeDrag.baseY + dy) * 100) / 100,
        });
      }
      return;
    }
    if (subtitleDrag) {
      if (isTrackLocked(SUBTITLE_EDITOR_TRACK_KEY)) {
        setSubtitleDrag(false);
        store.endGesture();
        return;
      }
      store.setSubtitleMargin(
        Math.min(0.85, Math.max(0.03, (rect.bottom - event.clientY) / rect.height)),
      );
      return;
    }
    if (overlayResize) {
      if (isTrackLocked(overlayResize.trackId)) {
        setOverlayResize(null);
        store.endGesture();
        return;
      }
      const scale = Math.min(
        1,
        Math.max(0.05, (event.clientX - rect.left) / rect.width - overlayResize.leftFraction),
      );
      store.updateOverlayBlock(
        overlayResize.trackId,
        overlayResize.blockIndex,
        {
          scale: Math.round(scale * 100) / 100,
          // resizing must not teleport a corner-anchored overlay: pin its
          // measured top-left as the explicit position
          position: {
            x: Math.round(overlayResize.leftFraction * 100) / 100,
            y: Math.round(overlayResize.topFraction * 100) / 100,
          },
        },
        `overlay-resize:${overlayResize.trackId}:${String(overlayResize.blockIndex)}`,
      );
      return;
    }
    if (overlayDrag) {
      if (isTrackLocked(overlayDrag.trackId)) {
        setOverlayDrag(null);
        store.endGesture();
        return;
      }
      const x = Math.min(
        0.95,
        Math.max(0, (event.clientX - rect.left) / rect.width - overlayDrag.grabDX),
      );
      const y = Math.min(
        0.95,
        Math.max(0, (event.clientY - rect.top) / rect.height - overlayDrag.grabDY),
      );
      store.updateOverlayBlock(
        overlayDrag.trackId,
        overlayDrag.blockIndex,
        { position: { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 } },
        `overlay-position:${overlayDrag.trackId}:${String(overlayDrag.blockIndex)}`,
      );
      return;
    }
    if (canvasCellDrag) {
      if (isTrackLocked(BACKGROUND_EDITOR_TRACK_KEY) || doc.canvas?.base.mode !== 'cell') {
        setCanvasCellDrag(null);
        store.endGesture();
        return;
      }
      const { cell } = doc.canvas.base;
      if (canvasCellDrag.kind === 'move') {
        const x = (event.clientX - rect.left) / rect.width - canvasCellDrag.grabDX;
        const y = (event.clientY - rect.top) / rect.height - canvasCellDrag.grabDY;
        store.setCanvasBaseCell(clampCellPreview({ ...cell, x, y }));
        return;
      }
      const pointerX = (event.clientX - rect.left) / rect.width;
      const pointerY = (event.clientY - rect.top) / rect.height;
      store.setCanvasBaseCell(
        clampCellPreview({
          x: Math.min(pointerX, canvasCellDrag.anchorX),
          y: Math.min(pointerY, canvasCellDrag.anchorY),
          w: Math.abs(canvasCellDrag.anchorX - pointerX),
          h: Math.abs(canvasCellDrag.anchorY - pointerY),
        }),
      );
      return;
    }
    if (cellDrag) {
      if (isTrackLocked(cellDrag.layer.trackId)) {
        setCellDrag(null);
        store.endGesture();
        return;
      }
      const cell = cellDrag.layer.block.cell ?? DEFAULT_LAYER_CELL;
      if (cellDrag.kind === 'move') {
        const x = (event.clientX - rect.left) / rect.width - cellDrag.grabDX;
        const y = (event.clientY - rect.top) / rect.height - cellDrag.grabDY;
        store.updateLayerCell(
          cellDrag.layer.trackId,
          cellDrag.layer.blockIndex,
          clampCellPreview({ ...cell, x, y }),
          `cell:${cellDrag.layer.trackId}:${String(cellDrag.layer.blockIndex)}`,
        );
        return;
      }
      const pointerX = (event.clientX - rect.left) / rect.width;
      const pointerY = (event.clientY - rect.top) / rect.height;
      store.updateLayerCell(
        cellDrag.layer.trackId,
        cellDrag.layer.blockIndex,
        clampCellPreview({
          x: Math.min(pointerX, cellDrag.anchorX),
          y: Math.min(pointerY, cellDrag.anchorY),
          w: Math.abs(cellDrag.anchorX - pointerX),
          h: Math.abs(cellDrag.anchorY - pointerY),
        }),
        `cell:${cellDrag.layer.trackId}:${String(cellDrag.layer.blockIndex)}`,
      );
      return;
    }
    if (!pipDrag) return;
    if (isTrackLocked(pipDrag.layer.trackId)) {
      setPipDrag(null);
      store.endGesture();
      return;
    }
    const { block } = pipDrag.layer;
    const pipKey = `pip:${pipDrag.layer.trackId}:${String(pipDrag.layer.blockIndex)}`;
    if (pipDrag.kind === 'move') {
      const scale = block.scale ?? PIP_DEFAULT_SCALE;
      const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width - scale / 2));
      const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height - 0.08));
      store.updateSelectedLayerBlock(
        { position: { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 } },
        pipKey,
      );
      return;
    }
    const position = block.position;
    const leftFraction =
      typeof position === 'object'
        ? position.x
        : position?.includes('right')
          ? 1 - OVERLAY_MARGIN_FRACTION - PIP_DEFAULT_SCALE
          : OVERLAY_MARGIN_FRACTION;
    const scale = Math.min(
      0.9,
      Math.max(0.15, (event.clientX - rect.left) / rect.width - leftFraction),
    );
    store.updateSelectedLayerBlock({ scale: Math.round(scale * 100) / 100 }, pipKey);
  };

  const frameS = 1 / doc.fps;
  const seekClamped = (to: number): void => {
    playhead.seek(Math.max(0, Math.min(duration, to)));
  };
  const transportButton =
    'size-6 border-0 bg-transparent p-0 text-foreground/80 hover:text-foreground';

  return (
    <div className="player-root" ref={playerRootRef}>
      <div
        className="player-viewer"
        data-zoom={zoom === 'fit' ? 'fit' : 'fixed'}
        style={
          {
            '--stage-w': String(doc.output.width),
            '--stage-h': String(doc.output.height),
          } as CSSProperties
        }
      >
        <div
          className="player-stage"
          style={zoom === 'fit' ? undefined : { width: doc.output.width * zoom }}
          ref={stageRef}
          onPointerMove={onStagePointerMove}
          onPointerUp={() => {
            setPipDrag(null);
            setCellDrag(null);
            setCanvasCellDrag(null);
            setSubtitleDrag(false);
            setOverlayDrag(null);
            setOverlayResize(null);
            setReframeDrag(null);
            store.endGesture();
          }}
          onPointerCancel={() => {
            setPipDrag(null);
            setCellDrag(null);
            setCanvasCellDrag(null);
            setSubtitleDrag(false);
            setOverlayDrag(null);
            setOverlayResize(null);
            setReframeDrag(null);
            store.endGesture();
          }}
          onPointerDown={(event) => {
            if (mode === 'proof') return;
            // selected video block → drag anywhere on the canvas repositions it
            const selection = state.selection;
            if (!selection) return;
            const track = doc.tracks.find((candidate) => candidate.id === selection.trackId);
            if (track?.kind !== 'video' || isTrackLocked(track.id)) return;
            const block = track.blocks[selection.blockIndex];
            if (!block) return;
            const current = block.transform ?? { scale: 1, x: 0, y: 0 };
            event.currentTarget.setPointerCapture(event.pointerId);
            setReframeDrag({
              trackId: track.id,
              startX: event.clientX,
              startY: event.clientY,
              baseX: current.x,
              baseY: current.y,
              mode: 'move',
              baseScale: current.scale,
            });
          }}
        >
          {rendering && mode === 'simulation' && (
            <div className="player-render-strip" role="status" aria-live="polite">
              <strong>
                {state.project?.hasProgram === true
                  ? t('player.render.updating')
                  : t('player.render.firstTime')}
              </strong>
              <span className="player-render-detail">
                {renderProgress === null
                  ? t('player.render.keepEditing')
                  : `${tf(
                      renderProgress.phase === 'segments'
                        ? 'player.render.segments'
                        : 'player.render.steps',
                      { done: String(renderProgress.done), total: String(renderProgress.total) },
                    )} · ${t('player.render.keepEditing')}`}
              </span>
              {renderProgress !== null && (
                <span className="player-render-bar" aria-hidden="true">
                  <span
                    style={{
                      width: `${String(Math.round((renderProgress.done / renderProgress.total) * 100))}%`,
                    }}
                  />
                </span>
              )}
            </div>
          )}
          {programSource !== null ? (
            <video
              key={programSource}
              className="program-video"
              src={programSource}
              preload="auto"
              playsInline
              style={{ zIndex: PLAYER_BASE_Z_INDEX }}
              ref={programVideoRef}
            />
          ) : (
            <div
              className={`base-composite ${activeSwappedPip ? 'swapped-pip' : ''}`}
              style={baseCompositeStyle}
            >
              {doc.canvas && (
                <div
                  className="canvas-background-matte"
                  style={{
                    zIndex: PLAYER_BACKGROUND_Z_INDEX,
                    background:
                      canvasBackground?.kind === 'color'
                        ? canvasBackground.color
                        : (canvasBackground?.color ?? 'var(--media-void)'),
                  }}
                />
              )}
              {canvasBackground?.kind === 'image' && (
                <img
                  className="canvas-background-media"
                  src={api.mediaUrl(canvasBackground.file)}
                  alt=""
                  draggable={false}
                  style={{
                    zIndex: PLAYER_BACKGROUND_Z_INDEX,
                    objectFit: canvasBackground.fit,
                  }}
                />
              )}
              {canvasBackground?.kind === 'video' && (
                <video
                  className="canvas-background-media"
                  aria-hidden="true"
                  src={sourceUrl.get(canvasBackground.source)}
                  preload="auto"
                  playsInline
                  muted
                  loop
                  style={{
                    zIndex: PLAYER_BACKGROUND_Z_INDEX,
                    objectFit: canvasBackground.fit,
                    background: 'transparent',
                  }}
                  ref={(element) => {
                    if (element) videosRef.current.set('background', element);
                    else videosRef.current.delete('background');
                  }}
                />
              )}
              <div
                className={`base-window ${
                  canvasBaseCell !== null && state.backgroundInspectorOpen ? 'is-editing' : ''
                }`}
                style={{
                  ...baseWindowStyle,
                  pointerEvents:
                    canvasBaseCell !== null && state.backgroundInspectorOpen ? 'auto' : 'none',
                }}
                onPointerDown={
                  canvasBaseCell !== null && state.backgroundInspectorOpen
                    ? startCanvasCellDrag('move')
                    : undefined
                }
              >
                {uniqueBaseSources.map((sourceKey) => (
                  <video
                    key={sourceKey}
                    className="base-video"
                    src={sourceUrl.get(sourceKey)}
                    preload="auto"
                    playsInline
                    muted={baseMuted}
                    style={{ zIndex: PLAYER_BASE_Z_INDEX }}
                    ref={(element) => {
                      if (element) videosRef.current.set(`base:${sourceKey}`, element);
                      else videosRef.current.delete(`base:${sourceKey}`);
                    }}
                  />
                ))}
                {crossfadeSources.map((sourceKey) => (
                  <video
                    key={`xfade-${sourceKey}`}
                    className="base-video crossfade-video"
                    src={sourceUrl.get(sourceKey)}
                    preload="auto"
                    playsInline
                    muted
                    style={{ zIndex: PLAYER_CROSSFADE_Z_INDEX }}
                    ref={(element) => {
                      if (element) videosRef.current.set(`xfade:${sourceKey}`, element);
                      else videosRef.current.delete(`xfade:${sourceKey}`);
                    }}
                  />
                ))}
                {activeDip && (
                  <div
                    className="transition-dip"
                    style={{
                      zIndex: PLAYER_EFFECT_Z_INDEX,
                      background: activeDip.color,
                      opacity: activeDipOpacity,
                    }}
                  />
                )}
                {activeFlash && (
                  <div
                    className="flash-overlay"
                    style={{ zIndex: PLAYER_EFFECT_Z_INDEX, opacity: activeFlashOpacity }}
                  />
                )}
                {canvasBaseCell !== null &&
                  state.backgroundInspectorOpen &&
                  !backgroundTrackLocked && (
                    <>
                      <span
                        className="cell-resize tl"
                        aria-hidden="true"
                        onPointerDown={startCanvasCellDrag('tl')}
                      />
                      <span
                        className="cell-resize tr"
                        aria-hidden="true"
                        onPointerDown={startCanvasCellDrag('tr')}
                      />
                      <span
                        className="cell-resize bl"
                        aria-hidden="true"
                        onPointerDown={startCanvasCellDrag('bl')}
                      />
                      <span
                        className="cell-resize br"
                        aria-hidden="true"
                        onPointerDown={startCanvasCellDrag('br')}
                      />
                    </>
                  )}
              </div>
            </div>
          )}
          {mode === 'simulation' &&
            audioLayers.map((audioLayer) => {
              const key = `audio:${audioLayer.trackId}:${String(audioLayer.blockIndex)}`;
              return (
                <PlayerAudioElement
                  key={key}
                  audioKey={key}
                  src={sourceUrl.get(audioLayer.block.source)}
                  register={registerAudioElement}
                />
              );
            })}
          {mode !== 'proof' &&
            layers.map((layer, layerIndex) => {
              const key = layerVideoKey(layer);
              const isSwapped = layer.block.mode === 'pip' && layer.block.swapped === true;
              const isPip = layer.block.mode === 'pip' && !isSwapped;
              const isCell = layer.block.mode === 'cell';
              const isLocked = isTrackLocked(layer.trackId);
              return (
                <div
                  key={key}
                  className={isPip ? 'pip-wrap' : isCell ? 'layer-fill cell-wrap' : 'layer-fill'}
                  style={{
                    ...layerWrapperStyle(layer.block),
                    display: 'none',
                    zIndex: layerZ(layerIndex),
                    cursor: isLocked ? 'default' : undefined,
                  }}
                  onPointerDown={
                    isPip
                      ? startPipDrag(layer, 'move')
                      : isCell
                        ? startCellDrag(layer, 'move')
                        : undefined
                  }
                  aria-disabled={isLocked || undefined}
                >
                  <video
                    src={sourceUrl.get(layer.block.source)}
                    preload="auto"
                    playsInline
                    muted={mode === 'engine' || layer.audio === 'mute'}
                    style={{
                      transform: transformStyle(layer.block),
                      filter: videoColorCss(
                        resolvedVideoColor(
                          doc.tracks.find((t) => t.id === layer.trackId && t.kind === 'video')
                            ?.kind === 'video'
                            ? (doc.tracks.find((t) => t.id === layer.trackId) as VideoTrack).color
                            : undefined,
                          layer.block.color,
                        ),
                      ),
                    }}
                    ref={(element) => {
                      if (element) videosRef.current.set(key, element);
                      else videosRef.current.delete(key);
                    }}
                  />
                  {isPip && !isLocked && (
                    <span className="pip-resize" onPointerDown={startPipDrag(layer, 'resize')} />
                  )}
                  {isCell && !isLocked && (
                    <>
                      <span className="cell-resize tl" onPointerDown={startCellDrag(layer, 'tl')} />
                      <span className="cell-resize tr" onPointerDown={startCellDrag(layer, 'tr')} />
                      <span className="cell-resize bl" onPointerDown={startCellDrag(layer, 'bl')} />
                      <span className="cell-resize br" onPointerDown={startCellDrag(layer, 'br')} />
                    </>
                  )}
                </div>
              );
            })}
          {mode !== 'proof' &&
            overlays.map((entry, overlayIndex) => {
              const overlay = entry.block;
              const visible =
                time >= overlay.at &&
                time < overlay.at + (overlay.duration ?? Number.POSITIVE_INFINITY);
              if (!visible) return null;
              const place: React.CSSProperties = pipPlace(overlay.position);
              const style: React.CSSProperties = overlay.scale
                ? { width: `${String(overlay.scale * 100)}%`, ...place }
                : { inset: 0, width: '100%', height: '100%' };
              const isSelected =
                state.selection?.trackId === entry.trackId &&
                state.selection.blockIndex === entry.blockIndex;
              // webm-alpha shows black in <img>/<video>; prefer the ANIMATED webp
              // companion so the motion shows live, falling back to the frozen png
              const src = overlay.file.endsWith('.webm')
                ? `${api.mediaUrl(`${overlay.file}.webp`)}?v=${String(state.assetVersion)}`
                : api.mediaUrl(overlay.file);
              const fallbackSrc = overlay.file.endsWith('.webm')
                ? `${api.mediaUrl(`${overlay.file}.png`)}?v=${String(state.assetVersion)}`
                : null;
              // a full-frame overlay (no scale — title cards) must stay pointer-inert:
              // dragging it would persist a position the render provably ignores, and
              // the stage-sized wrapper would swallow every canvas pointer
              const isFullscreen = overlay.scale === undefined;
              const isLocked = isTrackLocked(entry.trackId);
              return (
                <div
                  key={`overlay-${entry.trackId}-${String(entry.blockIndex)}-${String(state.assetVersion)}`}
                  className={`overlay-wrap ${isFullscreen ? 'fullscreen' : ''} ${isSelected ? 'selected' : ''}`}
                  style={{
                    ...style,
                    zIndex: overlayZIndex + overlayIndex,
                    cursor: isLocked ? 'default' : undefined,
                  }}
                  aria-disabled={isLocked || undefined}
                  onPointerDown={
                    isFullscreen
                      ? undefined
                      : (event) => {
                          event.stopPropagation();
                          if (isLocked) return;
                          event.currentTarget.setPointerCapture(event.pointerId);
                          store.select({ trackId: entry.trackId, blockIndex: entry.blockIndex });
                          const stageRect = stageRef.current?.getBoundingClientRect();
                          const elRect = event.currentTarget.getBoundingClientRect();
                          if (!stageRect) return;
                          setOverlayDrag({
                            trackId: entry.trackId,
                            blockIndex: entry.blockIndex,
                            grabDX: (event.clientX - elRect.left) / stageRect.width,
                            grabDY: (event.clientY - elRect.top) / stageRect.height,
                          });
                        }
                  }
                >
                  {overlay.sourceIn !== undefined && /\.(webm|mp4|mov)$/i.test(overlay.file) ? (
                    <TrimmedOverlayVideo block={overlay} version={state.assetVersion} />
                  ) : (
                    <img
                      className="overlay-media"
                      src={src}
                      alt=""
                      draggable={false}
                      onError={(event) => {
                        const img = event.currentTarget;
                        if (fallbackSrc !== null && img.dataset.fellBack !== '1') {
                          img.dataset.fellBack = '1';
                          img.src = fallbackSrc;
                          return;
                        }
                        img.style.display = 'none';
                      }}
                    />
                  )}
                  {isSelected && !isFullscreen && !isLocked && (
                    <span
                      className="pip-resize"
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        const stageRect = stageRef.current?.getBoundingClientRect();
                        const elRect = event.currentTarget.parentElement?.getBoundingClientRect();
                        if (!stageRect || !elRect) return;
                        setOverlayResize({
                          trackId: entry.trackId,
                          blockIndex: entry.blockIndex,
                          leftFraction: (elRect.left - stageRect.left) / stageRect.width,
                          topFraction: (elRect.top - stageRect.top) / stageRect.height,
                        });
                      }}
                    />
                  )}
                </div>
              );
            })}
          {mode !== 'proof' &&
            (() => {
              const selection = state.selection;
              if (!selection) return null;
              const track = doc.tracks.find((candidate) => candidate.id === selection.trackId);
              if (
                track?.kind !== 'video' ||
                !isPlayerTrackVisible(track) ||
                isTrackLocked(track.id)
              )
                return null;
              const block = track.blocks[selection.blockIndex];
              if (!block) return null;
              let cell: React.CSSProperties = { inset: 0 };
              if (isLayerBlock(block)) {
                const visible = time >= block.at && time < block.at + (block.out - block.in);
                if (!visible) return null;
                if (block.mode === 'split') {
                  const ratio = block.split?.ratio ?? 0.5;
                  const arrangement = block.split?.arrangement ?? 'top';
                  cell =
                    arrangement === 'left' || arrangement === 'right'
                      ? {
                          top: 0,
                          bottom: 0,
                          width: `${String(ratio * 100)}%`,
                          ...(arrangement === 'left' ? { left: 0 } : { right: 0 }),
                        }
                      : {
                          left: 0,
                          right: 0,
                          height: `${String(ratio * 100)}%`,
                          ...(arrangement === 'top' ? { top: 0 } : { bottom: 0 }),
                        };
                } else if (block.mode === 'cell') {
                  const layerCell = block.cell ?? DEFAULT_LAYER_CELL;
                  cell = {
                    left: `${String(layerCell.x * 100)}%`,
                    top: `${String(layerCell.y * 100)}%`,
                    width: `${String(layerCell.w * 100)}%`,
                    height: `${String(layerCell.h * 100)}%`,
                  };
                }
              }
              const current = block.transform ?? { scale: 1, x: 0, y: 0 };
              return (
                <div className="reframe-gizmo" style={{ ...cell, zIndex: editorChromeZIndex }}>
                  <span className="gizmo-hint">
                    {current.scale.toFixed(2)}× · arraste move · alça = zoom
                  </span>
                  <span
                    className="gizmo-corner"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      setReframeDrag({
                        trackId: track.id,
                        startX: event.clientX,
                        startY: event.clientY,
                        baseX: current.x,
                        baseY: current.y,
                        mode: 'scale',
                        baseScale: current.scale,
                      });
                    }}
                  />
                </div>
              );
            })()}
          {mode !== 'proof' &&
            currentCue &&
            (currentGraphicKey !== undefined && subtitleGraphic?.key === currentGraphicKey ? (
              <div
                className="subtitle-graphic"
                style={{ zIndex: subtitleZIndex }}
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: subtitleGraphic.svg }}
              />
            ) : null)}
          {mode !== 'proof' && currentCue && (
            <div
              className={`subtitle draggable ${subtitleHasPill ? 'pill' : ''}`}
              style={{
                cursor: isTrackLocked(SUBTITLE_EDITOR_TRACK_KEY) ? 'default' : undefined,
                zIndex: subtitleZIndex,
                bottom: `${String((subtitleSettings.marginV / 288) * 100)}%`,
                // the render burns at PlayResY 288 — sizes scale by stageHeight/288 to stay faithful
                fontSize: `${String(
                  Math.round(subtitleSettings.fontSize * subtitleUnitPx * 10) / 10,
                )}px`,
                color: subtitleFillColor,
                fontFamily: subtitleTheme.fontFamily,
                fontWeight: subtitleTheme.fontWeight,
                ...(subtitleTheme.backgroundStyle === 'outline'
                  ? outlineStyle(
                      subtitleTheme.outlineColor,
                      subtitleTheme.outlineWidth * subtitleUnitPx,
                    )
                  : {}),
              }}
              onPointerDown={(event) => {
                event.stopPropagation();
                if (isTrackLocked(SUBTITLE_EDITOR_TRACK_KEY)) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                store.selectCue({
                  source: currentCue.source,
                  wordStart: currentCue.wordStart,
                  wordEnd: currentCue.wordEnd,
                });
                setSubtitleDrag(true);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                store.selectSubtitles();
              }}
            >
              <span
                className="subtitle-content"
                style={
                  subtitleHasPill
                    ? {
                        background: hexToRgba(
                          subtitleTheme.backgroundColor,
                          subtitleTheme.backgroundOpacity,
                        ),
                        ...(currentGraphicKey !== undefined &&
                        subtitleGraphic?.key === currentGraphicKey
                          ? { opacity: 0 }
                          : {}),
                      }
                    : undefined
                }
                dangerouslySetInnerHTML={{ __html: subtitlePreviewHtml(currentCue.text) }}
              />
            </div>
          )}
        </div>
      </div>
      <div className="player-transport">
        <span className="player-time">
          {formatTime(time)}
          <span className="player-time-total"> / {formatTime(duration)}</span>
        </span>
        <div className="player-controls">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('player.toStart')}
                className={transportButton}
                onClick={() => {
                  seekClamped(0);
                }}
              >
                <UiIcon d={UI_ICON.toStart} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('player.toStart')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('player.frameBack')}
                className={transportButton}
                onClick={() => {
                  seekClamped(playhead.time - frameS);
                }}
              >
                <UiIcon d={UI_ICON.frameBack} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('player.frameBack')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={playing ? t('player.pause') : t('player.play')}
                className={cn(transportButton, 'size-7 text-foreground')}
                onClick={() => {
                  if (!playing && hasAudioLayers) void playerAudioController.resume();
                  playhead.setPlaying(!playing);
                }}
              >
                {playing ? <UiIcon d={UI_ICON.pause} /> : <UiIcon d={UI_ICON.play} filled />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{playing ? t('player.pause') : t('player.play')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('player.frameForward')}
                className={transportButton}
                onClick={() => {
                  seekClamped(playhead.time + frameS);
                }}
              >
                <UiIcon d={UI_ICON.frameForward} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('player.frameForward')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('player.toEnd')}
                className={transportButton}
                onClick={() => {
                  seekClamped(duration);
                }}
              >
                <UiIcon d={UI_ICON.toEnd} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('player.toEnd')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-pressed={loop}
                aria-label={t('player.loop.title')}
                className={cn(transportButton, loop && 'text-accent hover:text-accent')}
                onClick={() => {
                  setLoop(!loop);
                }}
              >
                <UiIcon d={UI_ICON.loop} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('player.loop.title')}</TooltipContent>
          </Tooltip>
        </div>
        <div className="player-controls justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="player-chip" aria-label={t('player.zoom.title')}>
                {zoom === 'fit' ? t('player.zoom.fit') : `${String(Math.round(zoom * 100))}%`}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-20 p-1">
              <DropdownMenuRadioGroup
                value={zoom === 'fit' ? 'fit' : String(zoom)}
                onValueChange={(value) => {
                  setZoom(value === 'fit' ? 'fit' : Number(value));
                }}
              >
                <DropdownMenuRadioItem value="fit" className="py-1 text-xs">
                  {t('player.zoom.fit')}
                </DropdownMenuRadioItem>
                {[0.25, 0.5, 1, 2].map((option) => (
                  <DropdownMenuRadioItem
                    key={option}
                    value={String(option)}
                    className="py-1 font-mono text-xs tabular-nums"
                  >
                    {String(option * 100)}%
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="player-chip" aria-label={t('player.speed.title')}>
                {String(rate)}x
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-14 p-1">
              <DropdownMenuRadioGroup
                value={String(rate)}
                onValueChange={(value) => {
                  setRate(Number(value));
                }}
              >
                {[0.25, 0.5, 1, 1.5, 2, 4].map((option) => (
                  <DropdownMenuRadioItem
                    key={option}
                    value={String(option)}
                    className="justify-center py-1 font-mono text-xs tabular-nums data-[state=checked]:bg-accent data-[state=checked]:text-accent-foreground"
                  >
                    {String(option)}x
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={fullscreen ? t('player.exitFullscreen') : t('player.fullscreen')}
                className={transportButton}
                onClick={togglePlayerFullscreen}
              >
                {fullscreen ? <UiIcon d={UI_ICON.fullscreenExit} /> : <UiIcon d={UI_ICON.fit} />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {fullscreen ? t('player.exitFullscreen') : t('player.fullscreen')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
