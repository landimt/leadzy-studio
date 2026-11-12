import type { MediaSummary } from '../../api.js';
import { PIP_DEFAULT_SCALE } from '../../../core/overlayPlacement.js';
import type {
  AudioBlock,
  AudioTrack,
  EditDoc,
  EffectTrack,
  VideoTrack,
} from '../../../core/schema.js';
import { baseTrackOf } from '../../../core/schema.js';
import {
  insertTrackAtKindBoundary,
  isKnownNonVideoMedia,
  nextTrackId,
  sourceKeyForPath,
} from '../docEdits.js';
import type { Selection } from '../storeState.js';
import { mapAudioTrack, mapVideoTrack } from './mapTrack.js';

// Pure track edits: rows are added, reordered, removed, hidden and muted here.
// Every function returns the next document (plus what the store must select),
// or `null` when nothing would change; the store owns history, validation,
// saving, the lock set and selection state.

const round2 = (value: number): number => Math.round(value * 100) / 100;

export interface TrackAddition {
  readonly doc: EditDoc;
  readonly trackId: string;
}

/** Creates an empty first-class media row with a collision-safe id, at its kind's boundary. */
export function addEmptyTrack(doc: EditDoc, kind: 'video' | 'audio' | 'effect'): TrackAddition {
  const prefix = kind === 'video' ? 'layer' : kind;
  const id = nextTrackId(doc, prefix);
  const track: VideoTrack | AudioTrack | EffectTrack = { id, kind, blocks: [] };
  return { doc: { ...doc, tracks: insertTrackAtKindBoundary(doc.tracks, track) }, trackId: id };
}

/** Reorders within one kind while leaving every other kind in its existing persisted slot. */
export function reorderTrack(
  doc: EditDoc,
  lockedTrackKeys: ReadonlySet<string>,
  trackId: string,
  targetTrackId: string,
): EditDoc | null {
  if (trackId === targetTrackId) return null;
  const track = doc.tracks.find((candidate) => candidate.id === trackId);
  const target = doc.tracks.find((candidate) => candidate.id === targetTrackId);
  if (!track || track.kind !== target?.kind) return null;
  const baseId = baseTrackOf(doc).id;
  if (track.id === baseId || target.id === baseId) return null;

  const sameKind = doc.tracks.filter((candidate) => candidate.kind === track.kind);
  const fromIndex = sameKind.indexOf(track);
  const targetIndex = sameKind.indexOf(target);
  if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) return null;
  const firstAffected = Math.min(fromIndex, targetIndex);
  const lastAffected = Math.max(fromIndex, targetIndex);
  if (
    sameKind
      .slice(firstAffected, lastAffected + 1)
      .some((candidate) => lockedTrackKeys.has(candidate.id))
  ) {
    return null;
  }

  const reordered = [...sameKind];
  const [moved] = reordered.splice(fromIndex, 1);
  if (!moved) return null;
  reordered.splice(targetIndex, 0, moved);
  let projectionIndex = 0;
  const tracks = doc.tracks.map((candidate) =>
    candidate.kind === track.kind ? (reordered[projectionIndex++] ?? candidate) : candidate,
  );
  return { ...doc, tracks };
}

export interface ClipAddition {
  readonly doc: EditDoc;
  /** Source key the asset was registered under (new or reused). */
  readonly key: string;
  readonly selection: Selection;
}

/** Places the full audio stream on a requested/empty row, creating one when necessary. */
export function addAudioClip(
  doc: EditDoc,
  lockedTrackKeys: ReadonlySet<string>,
  media: MediaSummary | undefined,
  relPath: string,
  at: number,
  targetTrackId?: string,
): ClipAddition | null {
  if (!Number.isFinite(at)) return null;
  if (
    !media ||
    media.kind === 'image' ||
    !media.hasAudio ||
    !Number.isFinite(media.durationS) ||
    media.durationS <= 0
  ) {
    return null;
  }

  const requestedTrack = targetTrackId
    ? doc.tracks.find(
        (track): track is AudioTrack => track.kind === 'audio' && track.id === targetTrackId,
      )
    : undefined;
  if (targetTrackId && !requestedTrack) return null;
  if (requestedTrack && lockedTrackKeys.has(requestedTrack.id)) return null;
  const destination =
    requestedTrack ??
    doc.tracks.find(
      (track): track is AudioTrack =>
        track.kind === 'audio' && track.blocks.length === 0 && !lockedTrackKeys.has(track.id),
    );

  const { key, exists } = sourceKeyForPath(doc, relPath);
  const durationS = media.durationS;
  const block: AudioBlock = {
    source: key,
    in: 0,
    out: durationS,
    at: Math.max(0, round2(at)),
  };
  const trackId = destination?.id ?? nextTrackId(doc, 'audio');
  const blockIndex = destination?.blocks.length ?? 0;
  const tracks = destination
    ? doc.tracks.map((track) =>
        track.kind === 'audio' && track.id === destination.id
          ? { ...track, blocks: [...track.blocks, block] }
          : track,
      )
    : insertTrackAtKindBoundary(doc.tracks, {
        id: trackId,
        kind: 'audio',
        label: key,
        blocks: [block],
      });
  const existingSource = exists ? doc.sources[key] : undefined;
  return {
    doc: {
      ...doc,
      sources: {
        ...doc.sources,
        [key]: existingSource ? { ...existingSource, durationS } : { path: relPath, durationS },
      },
      tracks,
    },
    key,
    selection: { trackId, blockIndex },
  };
}

/** Adds a PiP layer of up to five seconds on a requested/empty layer row, creating one when necessary. */
export function addLayer(
  doc: EditDoc,
  lockedTrackKeys: ReadonlySet<string>,
  media: MediaSummary | undefined,
  relPath: string,
  at: number,
  targetTrackId?: string,
): ClipAddition | null {
  if (!Number.isFinite(at)) return null;
  if (isKnownNonVideoMedia(media)) return null;
  const { key, exists } = sourceKeyForPath(doc, relPath);
  const durationS = media?.kind === 'video' ? media.durationS : 5;
  if (!Number.isFinite(durationS) || durationS <= 0) return null;
  const block = {
    source: key,
    in: 0,
    out: round2(Math.min(durationS, 5)),
    at: Math.max(0, round2(at)),
    mode: 'pip' as const,
    position: 'bottom-left' as const,
    scale: PIP_DEFAULT_SCALE,
    audio: 'mute' as const,
  };
  const baseId = baseTrackOf(doc).id;
  const requestedLayer = targetTrackId
    ? doc.tracks.find(
        (track): track is VideoTrack =>
          track.kind === 'video' && track.id === targetTrackId && track.id !== baseId,
      )
    : undefined;
  if (targetTrackId && !requestedLayer) return null;
  if (requestedLayer && lockedTrackKeys.has(requestedLayer.id)) return null;
  const emptyLayer =
    requestedLayer ??
    doc.tracks.find(
      (track): track is VideoTrack =>
        track.kind === 'video' &&
        track.id !== baseId &&
        track.blocks.length === 0 &&
        !lockedTrackKeys.has(track.id),
    );
  const newTrackId = emptyLayer?.id ?? nextTrackId(doc, 'layer');
  const nextBlockIndex = emptyLayer?.blocks.length ?? 0;
  const tracks = emptyLayer
    ? doc.tracks.map((track) =>
        track.id === emptyLayer.id && track.kind === 'video'
          ? { ...track, blocks: [...track.blocks, block] }
          : track,
      )
    : insertTrackAtKindBoundary(doc.tracks, {
        id: newTrackId,
        kind: 'video',
        label: key,
        blocks: [block],
      });
  return {
    doc: {
      ...doc,
      sources: exists
        ? doc.sources
        : {
            ...doc.sources,
            [key]: { path: relPath, durationS: round2(durationS) },
          },
      tracks,
    },
    key,
    selection: { trackId: newTrackId, blockIndex: nextBlockIndex },
  };
}

/** Removes a row. The base line IS the video — never removable; locked and unknown ids are no-ops. */
export function removeTrack(
  doc: EditDoc,
  lockedTrackKeys: ReadonlySet<string>,
  trackId: string,
): EditDoc | null {
  const base = baseTrackOf(doc);
  if (trackId === base.id) return null;
  if (lockedTrackKeys.has(trackId)) return null;
  if (!doc.tracks.some((track) => track.id === trackId)) return null;
  return { ...doc, tracks: doc.tracks.filter((track) => track.id !== trackId) };
}

/** Persisted per-track visibility (honored by the renderer). No-op on the base track, audio rows and unknown ids. */
export function setTrackHidden(doc: EditDoc, trackId: string, hidden: boolean): EditDoc | null {
  const base = baseTrackOf(doc);
  if (trackId === base.id) return null;
  const track = doc.tracks.find((candidate) => candidate.id === trackId);
  if (!track || track.kind === 'audio') return null;
  const tracks = doc.tracks.map((candidate) => {
    if (candidate.id !== trackId || candidate.kind === 'audio') return candidate;
    if (!hidden) {
      const { hidden: _removed, ...rest } = candidate;
      return rest;
    }
    return { ...candidate, hidden: true };
  });
  return { ...doc, tracks };
}

/** Persisted per-track mute for video and audio rows; `null` when already in that state. */
export function setTrackMuted(doc: EditDoc, trackId: string, muted: boolean): EditDoc | null {
  const track = doc.tracks.find((candidate) => candidate.id === trackId);
  if (track?.kind !== 'video' && track?.kind !== 'audio') return null;
  if (muted && track.muted === true) return null;
  if (!muted && track.muted === undefined) return null;
  const update = <T extends VideoTrack | AudioTrack>(current: T): T => {
    if (!muted) {
      const { muted: _removed, ...rest } = current;
      return rest as T;
    }
    return { ...current, muted: true };
  };
  return track.kind === 'video'
    ? mapVideoTrack(doc, trackId, update)
    : mapAudioTrack(doc, trackId, update);
}

/** Appends a still image overlay on the first overlay row, creating `overlays` at the end when there is none. */
export function addOverlayImage(doc: EditDoc, relPath: string, at: number): EditDoc {
  const overlayTrack = doc.tracks.find((track) => track.kind === 'overlay');
  const block = {
    file: relPath,
    at: round2(at),
    duration: 4,
    position: 'bottom-left' as const,
    scale: 0.5,
  };
  const tracks = overlayTrack
    ? doc.tracks.map((track) =>
        track === overlayTrack ? { ...track, blocks: [...track.blocks, block] } : track,
      )
    : [...doc.tracks, { id: 'overlays', kind: 'overlay' as const, blocks: [block] }];
  return { ...doc, tracks };
}
