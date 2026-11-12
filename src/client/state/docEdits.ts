import { type MediaSummary } from '../api.js';
import type {
  AudioBlock,
  AudioTrack,
  CanvasConfig,
  EditDoc,
  EffectBlock,
  EffectTrack,
  LayerCell,
  VideoTrack,
} from '../../core/schema.js';
import { FLASH_DURATION_BOUNDS, SHAKE_DURATION_BOUNDS } from '../../core/schema.js';
import { MIN_TIMED_BLOCK_S } from '../../core/timeline.js';

export const LIBRARY_DRAG_MIME = 'application/x-leadzy-library-item';

/** DataTransfer MIME type for dragging project media from the bin onto a video track. */
export const PROJECT_MEDIA_DRAG_MIME = 'application/x-leadzy-project-media';

/** DataTransfer MIME type for dragging an effect card onto the timeline; the payload is the EffectBlock type. */
export const EFFECT_DRAG_MIME = 'application/x-leadzy-effect';

/** UI-only key for the generated subtitle row, which has no persisted `tracks[]` entry. */
export const SUBTITLE_EDITOR_TRACK_KEY = 'timeline:subtitles';

/** UI-only key for the canvas/background row, which is persisted outside `tracks[]`. */
export const BACKGROUND_EDITOR_TRACK_KEY = 'timeline:background';

/**
 * Per-type duration bounds for effect blocks — the single source of truth shared by
 * every path that can change an effect's duration (create, inspector edit, edge drag),
 * so an out-of-range value can never reach `applyDoc` and get the whole edit discarded.
 */
export function effectDurationBounds(type: EffectBlock['type']): {
  readonly min: number;
  readonly max: number;
} {
  switch (type) {
    case 'flash':
      return FLASH_DURATION_BOUNDS;
    case 'shake':
      return SHAKE_DURATION_BOUNDS;
    case 'zoom':
      return { min: MIN_TIMED_BLOCK_S, max: Infinity };
    default: {
      const exhaustive: never = type;
      throw new Error(`unhandled effect type: ${String(exhaustive)}`);
    }
  }
}

export function clampEffectDuration(type: EffectBlock['type'], duration: number): number {
  const bounds = effectDurationBounds(type);
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(duration * 100) / 100));
}

/** Seed rect for a layer entering mode "cell" for the first time — a UI decision, not a schema default. */
export const DEFAULT_LAYER_CELL: LayerCell = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };

/** Calm near-black canvas and a centered talking-head window for first-time background setup. */
export const DEFAULT_CANVAS_BACKGROUND_COLOR = '#171416';

export const DEFAULT_CANVAS_BASE_CELL: LayerCell = { x: 0.08, y: 0.22, w: 0.84, h: 0.56 };

export function defaultCanvasConfig(): CanvasConfig {
  return {
    background: { kind: 'color', color: DEFAULT_CANVAS_BACKGROUND_COLOR },
    base: { mode: 'cell', cell: DEFAULT_CANVAS_BASE_CELL },
  };
}

/**
 * UI clamp for mode "cell" — keeps the rect inside the frame and w/h above the
 * schema floor BEFORE parseEditDoc runs, so a stray drag can never trigger the
 * "edit discarded" warning. x/y are clamped against the ALREADY-clamped w/h so
 * x + w <= 1 and y + h <= 1 hold exactly at the 3-decimal precision the schema checks.
 */
export function clampLayerCell(cell: LayerCell): LayerCell {
  const round3 = (value: number): number => Math.round(value * 1000) / 1000;
  const w = round3(Math.min(1, Math.max(0.05, cell.w)));
  const h = round3(Math.min(1, Math.max(0.05, cell.h)));
  const x = round3(Math.min(1 - w, Math.max(0, cell.x)));
  const y = round3(Math.min(1 - h, Math.max(0, cell.y)));
  return { x, y, w, h };
}

export const AUTO_PREVIEW_STORAGE_KEY = 'leadzy-studio-auto-preview';

export const AUDIO_PREVIEW_DEBOUNCE_MS = 700;

/** Guarded for the node test environment, which has no `localStorage` global. */
export function readAutoPreviewDefault(): boolean {
  if (typeof localStorage === 'undefined') return true;
  return localStorage.getItem(AUTO_PREVIEW_STORAGE_KEY) !== 'off';
}

/** BRIDGE (temporary — remove once wave 2 migrates components to read `track.hidden` directly): recomputes the derived `hiddenTracks` set from the doc on every `set()`. */
export function hiddenTracksOf(doc: EditDoc | null): ReadonlySet<string> {
  if (!doc) return new Set();
  return new Set(
    doc.tracks
      .filter((track) => 'hidden' in track && track.hidden === true)
      .map((track) => track.id),
  );
}

/** Removes stale editor locks whenever the authoritative document changes. */
export function lockedTrackKeysForDoc(
  keys: ReadonlySet<string>,
  doc: EditDoc | null,
): ReadonlySet<string> {
  if (!doc) return new Set();
  const trackIds = new Set(doc.tracks.map((track) => track.id));
  return new Set(
    [...keys].filter((key) => {
      if (key === SUBTITLE_EDITOR_TRACK_KEY) return true;
      if (key === BACKGROUND_EDITOR_TRACK_KEY) return doc.canvas !== undefined;
      return trackIds.has(key);
    }),
  );
}

/** A track lock protects editorial content, not its persisted header visibility/audio switches. */
function lockedTrackContentKey(track: EditDoc['tracks'][number] | undefined): string | null {
  if (!track) return null;
  if (track.kind === 'video') {
    const { hidden: _hidden, muted: _muted, ...content } = track;
    return JSON.stringify(content);
  }
  if (track.kind === 'audio') {
    const { muted: _muted, ...content } = track;
    return JSON.stringify(content);
  }
  const { hidden: _hidden, ...content } = track;
  return JSON.stringify(content);
}

/**
 * Position of a track among same-kind peers that survive in both documents.
 * Adding/removing a sibling may shift an absolute index without moving a locked
 * track relative to any surviving peer; an actual reorder across it still changes
 * this shared-peer index and remains blocked.
 */
function sharedSameKindTrackIndex(
  doc: EditDoc,
  other: EditDoc,
  track: EditDoc['tracks'][number],
): number {
  const sharedIds = new Set(
    other.tracks
      .filter((candidate) => candidate.kind === track.kind)
      .map((candidate) => candidate.id),
  );
  return doc.tracks
    .filter((candidate) => candidate.kind === track.kind && sharedIds.has(candidate.id))
    .findIndex((candidate) => candidate.id === track.id);
}

/** Allocate persisted row ids from the first free positive suffix, across every track kind. */
export function nextTrackId(doc: EditDoc, prefix: 'layer' | 'audio' | 'effect'): string {
  const ids = new Set(doc.tracks.map((track) => track.id));
  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${prefix}-${String(suffix)}`;
    if (!ids.has(candidate)) return candidate;
  }
}

/** Resolve an existing source path or create a collision-safe, readable source id. */
export function sourceKeyForPath(doc: EditDoc, relPath: string): { key: string; exists: boolean } {
  const existing = Object.entries(doc.sources).find(([, source]) => source.path === relPath)?.[0];
  if (existing !== undefined) return { key: existing, exists: true };

  const stem =
    relPath
      .replace(/^.*[\\/]/, '')
      .replace(/\.[^.]+$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'source';
  let key = stem;
  for (let suffix = 2; key in doc.sources; suffix += 1) key = `${stem}_${String(suffix)}`;
  return { key, exists: false };
}

/**
 * Sources whose media-derived data or registry entry is still needed outside
 * the silent canvas background. Keeping this projection in one place prevents
 * background-only video from triggering transcript/waveform work and lets
 * canvas removal garbage-collect only a genuinely orphaned source.
 */
export function sourceKeysReferencedOutsideCanvas(doc: EditDoc): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const track of doc.tracks) {
    if (track.kind !== 'video' && track.kind !== 'audio') continue;
    for (const block of track.blocks) keys.add(block.source);
  }
  if (doc.output.denoiseSample) keys.add(doc.output.denoiseSample.source);
  for (const range of doc.subtitles.hiddenRanges ?? []) keys.add(range.source);
  for (const correction of doc.subtitles.corrections ?? []) keys.add(correction.source);
  for (const suggestion of doc.suggestions ?? []) keys.add(suggestion.source);
  return keys;
}

/**
 * Replacing/removing a video background must not leak its registry entry, but
 * the source may still be shared by a video/audio track or another editorial
 * contract. The next background also counts as ownership when it reuses the
 * exact same key.
 */
export function withReplacedBackgroundSourcePruned(current: EditDoc, next: EditDoc): EditDoc {
  const previousBackground = current.canvas?.background;
  if (previousBackground?.kind !== 'video') return next;
  const nextBackground = next.canvas?.background;
  if (nextBackground?.kind === 'video' && nextBackground.source === previousBackground.source) {
    return next;
  }
  if (sourceKeysReferencedOutsideCanvas(next).has(previousBackground.source)) return next;
  if (!(previousBackground.source in next.sources)) return next;
  return {
    ...next,
    sources: Object.fromEntries(
      Object.entries(next.sources).filter(([key]) => key !== previousBackground.source),
    ),
  };
}

/** Keep persisted row groups stable: video, then audio, then every visual/metadata kind. */
export function insertTrackAtKindBoundary(
  tracks: EditDoc['tracks'],
  track: VideoTrack | AudioTrack | EffectTrack,
): EditDoc['tracks'] {
  if (track.kind === 'video') {
    return [
      ...tracks.filter((candidate) => candidate.kind === 'video'),
      track,
      ...tracks.filter((candidate) => candidate.kind !== 'video'),
    ];
  }
  if (track.kind === 'audio') {
    return [
      ...tracks.filter((candidate) => candidate.kind === 'video' || candidate.kind === 'audio'),
      track,
      ...tracks.filter((candidate) => candidate.kind !== 'video' && candidate.kind !== 'audio'),
    ];
  }
  return [
    ...tracks.filter(
      (candidate) =>
        candidate.kind === 'video' || candidate.kind === 'audio' || candidate.kind === 'effect',
    ),
    track,
    ...tracks.filter((candidate) => candidate.kind === 'overlay'),
  ];
}

/** Known non-video assets (audio or still images) can never enter a video lane/base. */
export function isKnownNonVideoMedia(media: MediaSummary | undefined): boolean {
  return media !== undefined && media.kind !== 'video';
}

/** Keep a persisted user envelope valid when a trim shortens its audio block. */
export function withClampedAudioFades(block: AudioBlock): AudioBlock {
  const duration = block.out - block.in;
  const fadeInS = Math.min(duration, Math.max(0, block.fadeInS ?? 0));
  const fadeOutS = Math.min(Math.max(0, duration - fadeInS), Math.max(0, block.fadeOutS ?? 0));
  const { fadeInS: _oldIn, fadeOutS: _oldOut, ...rest } = block;
  return {
    ...rest,
    ...(fadeInS > 0 ? { fadeInS } : {}),
    ...(fadeOutS > 0 ? { fadeOutS } : {}),
  };
}

/** Subtitle enable/disable remains available from the row header while its settings are locked. */
function lockedSubtitleContentKey(subtitles: EditDoc['subtitles']): string {
  const { enabled: _enabled, ...content } = subtitles;
  return JSON.stringify(content);
}

function lockedBackgroundContentKey(doc: EditDoc): string {
  const background = doc.canvas?.background;
  const source = background?.kind === 'video' ? (doc.sources[background.source] ?? null) : null;
  return JSON.stringify({ canvas: doc.canvas ?? null, source });
}

export function changesLockedTimelineContent(
  current: EditDoc,
  next: EditDoc,
  lockedTrackKeys: ReadonlySet<string>,
): boolean {
  if (
    lockedTrackKeys.has(SUBTITLE_EDITOR_TRACK_KEY) &&
    lockedSubtitleContentKey(current.subtitles) !== lockedSubtitleContentKey(next.subtitles)
  ) {
    return true;
  }
  if (
    lockedTrackKeys.has(BACKGROUND_EDITOR_TRACK_KEY) &&
    lockedBackgroundContentKey(current) !== lockedBackgroundContentKey(next)
  ) {
    return true;
  }
  for (const trackId of lockedTrackKeys) {
    if (trackId === SUBTITLE_EDITOR_TRACK_KEY || trackId === BACKGROUND_EDITOR_TRACK_KEY) continue;
    const currentTrack = current.tracks.find((track) => track.id === trackId);
    const nextTrack = next.tracks.find((track) => track.id === trackId);
    if (lockedTrackContentKey(currentTrack) !== lockedTrackContentKey(nextTrack)) return true;
    if (currentTrack === undefined || nextTrack === undefined) continue;
    if (
      currentTrack.kind === nextTrack.kind &&
      sharedSameKindTrackIndex(current, next, currentTrack) !==
        sharedSameKindTrackIndex(next, current, nextTrack)
    ) {
      return true;
    }
  }
  return false;
}
