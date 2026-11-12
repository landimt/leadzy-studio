import type { MediaSummary } from '../../api.js';
import type { AudioBlock, BlockTransition, EditDoc, OverlayBlock } from '../../../core/schema.js';
import { baseTrackOf, isLayerBlock, SPEED_BOUNDS } from '../../../core/schema.js';
import {
  MIN_TIMED_BLOCK_S,
  outputSegments,
  reorderBlockByDrop,
  splitBlockAt,
  sourceTimeAt,
  type BlockEdge,
} from '../../../core/timeline.js';
import {
  effectDurationBounds,
  isKnownNonVideoMedia,
  sourceKeyForPath,
  withClampedAudioFades,
} from '../docEdits.js';
import type { Selection } from '../storeState.js';
import { mapAudioTrack, mapVideoTrack } from './mapTrack.js';

// Pure block edits on the timeline. Every function returns the next document
// or `null` when the edit is a no-op; the store owns history, validation,
// saving and selection.

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Removes every target across any mix of tracks as ONE document change — one undo step. */
export function deleteBlocks(doc: EditDoc, targets: readonly Selection[]): EditDoc {
  const indicesByTrack = new Map<string, Set<number>>();
  for (const target of targets) {
    const indices = indicesByTrack.get(target.trackId) ?? new Set<number>();
    indices.add(target.blockIndex);
    indicesByTrack.set(target.trackId, indices);
  }
  const tracks = doc.tracks.map((track) => {
    const indices = indicesByTrack.get(track.id);
    if (!indices) return track;
    return { ...track, blocks: track.blocks.filter((_, i) => !indices.has(i)) } as typeof track;
  });
  return { ...doc, tracks };
}

/**
 * Where a playhead action lands: the block under the cursor and the SOURCE time
 * inside it, resolved the way `splitAtPlayhead` and `trimAtPlayhead` resolve
 * their target — selected audio clip, selected layer block, otherwise the base
 * track — so the toolbar's enabled state matches what the click would do.
 */
export interface PlayheadPoint {
  readonly trackId: string;
  readonly blockIndex: number;
  readonly sourceTime: number;
  readonly blockIn: number;
  readonly blockOut: number;
}

export function playheadPointAt(
  doc: EditDoc,
  selection: Selection | null,
  outputTime: number,
): PlayheadPoint | null {
  if (!Number.isFinite(outputTime)) return null;
  const selectedTrack = selection
    ? doc.tracks.find((track) => track.id === selection.trackId)
    : undefined;
  if (selection && selectedTrack?.kind === 'audio') {
    const block = selectedTrack.blocks[selection.blockIndex];
    if (!block) return null;
    const sourceTime = block.in + (outputTime - block.at);
    if (sourceTime <= block.in || sourceTime >= block.out) return null;
    return {
      trackId: selectedTrack.id,
      blockIndex: selection.blockIndex,
      sourceTime,
      blockIn: block.in,
      blockOut: block.out,
    };
  }
  if (selection && selectedTrack?.kind === 'video') {
    const block = selectedTrack.blocks[selection.blockIndex];
    if (block && isLayerBlock(block)) {
      const sourceTime = block.in + (outputTime - block.at);
      if (sourceTime <= block.in || sourceTime >= block.out) return null;
      return {
        trackId: selectedTrack.id,
        blockIndex: selection.blockIndex,
        sourceTime,
        blockIn: block.in,
        blockOut: block.out,
      };
    }
  }
  const point = sourceTimeAt(doc, outputTime);
  if (!point) return null;
  const base = baseTrackOf(doc);
  const block = base.blocks[point.blockIndex];
  if (!block) return null;
  return {
    trackId: base.id,
    blockIndex: point.blockIndex,
    sourceTime: point.time,
    blockIn: block.in,
    blockOut: block.out,
  };
}

/**
 * A cursor sitting exactly on a block edge has nothing to cut on that side, and
 * a cursor past the end of the montage has no block at all. The toolbar asks
 * this so the button greys out instead of swallowing the click.
 */
export function canSplitAtPlayhead(
  doc: EditDoc,
  selection: Selection | null,
  outputTime: number,
): boolean {
  const point = playheadPointAt(doc, selection, outputTime);
  if (!point) return false;
  return point.sourceTime > point.blockIn && point.sourceTime < point.blockOut;
}

export function canTrimAtPlayhead(
  doc: EditDoc,
  selection: Selection | null,
  side: 'left' | 'right',
  outputTime: number,
): boolean {
  const point = playheadPointAt(doc, selection, outputTime);
  if (!point) return false;
  return side === 'left' ? point.sourceTime > point.blockIn : point.sourceTime < point.blockOut;
}

export interface TrimAtPlayheadResult {
  readonly doc: EditDoc;
  /** A base-track trim can drop a block, so every extra selection index goes stale. */
  readonly clearsExtraSelections: boolean;
}

/** CapCut-style: cut away everything left/right of the cursor inside the block under it. */
export function trimAtPlayhead(
  doc: EditDoc,
  selection: Selection | null,
  side: 'left' | 'right',
  outputTime: number,
): TrimAtPlayheadResult | null {
  if (!Number.isFinite(outputTime)) return null;
  const selectedTrack = selection
    ? doc.tracks.find((track) => track.id === selection.trackId)
    : undefined;
  const selectedAudioBlock =
    selectedTrack?.kind === 'audio' && selection
      ? selectedTrack.blocks[selection.blockIndex]
      : undefined;
  if (selection && selectedTrack?.kind === 'audio' && selectedAudioBlock) {
    const sourceTime = selectedAudioBlock.in + (outputTime - selectedAudioBlock.at);
    if (sourceTime <= selectedAudioBlock.in || sourceTime >= selectedAudioBlock.out) return null;
    const value = round2(sourceTime);
    const next = mapAudioTrack(doc, selectedTrack.id, (track) => ({
      ...track,
      blocks: track.blocks.map((block, i) => {
        if (i !== selection.blockIndex) return block;
        if (side === 'left') {
          const nextIn = Math.min(value, block.out - 0.1);
          return withClampedAudioFades({
            ...block,
            in: nextIn,
            // Preserve the opposite output edge even when the minimum
            // duration clamps a playhead very close to the end.
            at: block.at + (nextIn - block.in),
          });
        }
        return withClampedAudioFades({ ...block, out: Math.max(value, block.in + 0.1) });
      }),
    }));
    return { doc: next, clearsExtraSelections: false };
  }
  const selectedBlock =
    selectedTrack?.kind === 'video' && selection
      ? selectedTrack.blocks[selection.blockIndex]
      : undefined;
  if (
    selection &&
    selectedTrack?.kind === 'video' &&
    selectedBlock &&
    isLayerBlock(selectedBlock)
  ) {
    const sourceTime = selectedBlock.in + (outputTime - selectedBlock.at);
    if (sourceTime <= selectedBlock.in || sourceTime >= selectedBlock.out) return null;
    const value = round2(sourceTime);
    const next = mapVideoTrack(doc, selectedTrack.id, (track) => ({
      ...track,
      blocks: track.blocks.map((block, i) => {
        if (i !== selection.blockIndex || !isLayerBlock(block)) return block;
        return side === 'left'
          ? {
              ...block,
              in: Math.min(value, block.out - 0.1),
              at: Math.max(0, round2(outputTime)),
            }
          : { ...block, out: Math.max(value, block.in + 0.1) };
      }),
    }));
    return { doc: next, clearsExtraSelections: false };
  }
  const point = sourceTimeAt(doc, outputTime);
  if (!point) return null;
  const base = baseTrackOf(doc);
  const next = mapVideoTrack(doc, base.id, (track) => ({
    ...track,
    blocks: track.blocks
      .map((block, i) => {
        if (i !== point.blockIndex) return block;
        const value = round2(point.time);
        if (side === 'left') return { ...block, in: Math.min(value, block.out - 0.1) };
        return { ...block, out: Math.max(value, block.in + 0.1) };
      })
      .filter((block) => block.out - block.in >= 0.1),
  }));
  return { doc: next, clearsExtraSelections: true };
}

/** Splits the block under the playhead; a split shifts every later index, so extras go stale. */
export function splitAtPlayhead(
  doc: EditDoc,
  selection: Selection | null,
  playhead: number,
): EditDoc | null {
  if (!Number.isFinite(playhead)) return null;
  // A cursor resting on a block edge used to rebuild an identical document and
  // hand it to the store as a change. Refuse it here: no phantom history entry,
  // and the toolbar can ask the same question to grey the button out.
  if (!canSplitAtPlayhead(doc, selection, playhead)) return null;
  const selectedTrack = selection
    ? doc.tracks.find((track) => track.id === selection.trackId)
    : undefined;
  const selectedAudioBlock =
    selectedTrack?.kind === 'audio' && selection
      ? selectedTrack.blocks[selection.blockIndex]
      : undefined;
  if (selection && selectedTrack?.kind === 'audio' && selectedAudioBlock) {
    const sourceTime = selectedAudioBlock.in + (playhead - selectedAudioBlock.at);
    if (sourceTime <= selectedAudioBlock.in || sourceTime >= selectedAudioBlock.out) return null;
    const value = round2(sourceTime);
    if (value <= selectedAudioBlock.in || value >= selectedAudioBlock.out) return null;
    const nextAt = Math.max(0, round2(selectedAudioBlock.at + (value - selectedAudioBlock.in)));
    return mapAudioTrack(doc, selectedTrack.id, (track) => ({
      ...track,
      blocks: track.blocks.flatMap((block, i) => {
        if (i !== selection.blockIndex) return [block];
        const { fadeOutS: _leftFadeOut, ...left } = block;
        const { fadeInS: _rightFadeIn, ...right } = block;
        return [
          withClampedAudioFades({ ...left, out: value }),
          withClampedAudioFades({ ...right, in: value, at: nextAt }),
        ];
      }),
    }));
  }
  const selectedBlock =
    selectedTrack?.kind === 'video' && selection
      ? selectedTrack.blocks[selection.blockIndex]
      : undefined;
  if (
    selection &&
    selectedTrack?.kind === 'video' &&
    selectedBlock &&
    isLayerBlock(selectedBlock)
  ) {
    const sourceTime = selectedBlock.in + (playhead - selectedBlock.at);
    return mapVideoTrack(doc, selectedTrack.id, (track) => ({
      ...track,
      blocks: splitBlockAt(track.blocks, selection.blockIndex, sourceTime),
    }));
  }
  const point = sourceTimeAt(doc, playhead);
  if (!point) return null;
  const base = baseTrackOf(doc);
  return mapVideoTrack(doc, base.id, (track) => ({
    ...track,
    blocks: splitBlockAt(track.blocks, point.blockIndex, point.time),
  }));
}

/** Entry transition for a base block's emenda with the previous one; `undefined` clears it. */
export function setBlockTransition(
  doc: EditDoc,
  blockIndex: number,
  transition: BlockTransition | undefined,
): EditDoc {
  const base = baseTrackOf(doc);
  const clamped = transition
    ? { ...transition, durationS: Math.min(1.0, Math.max(0.1, transition.durationS)) }
    : undefined;
  return mapVideoTrack(doc, base.id, (track) => ({
    ...track,
    blocks: track.blocks.map((block, i) => {
      if (i !== blockIndex) return block;
      if (clamped === undefined) {
        const { transition: _removed, ...rest } = block;
        return rest;
      }
      return { ...block, transition: clamped };
    }),
  }));
}

/**
 * Per-block playback speed on the base track — SPEED_BOUNDS clamp, 2-decimal
 * round; speed 1 removes the field. `null` on a non-finite value AND on
 * `speed <= 0`: a cleared number input reads as `Number('') === 0`, which IS
 * finite, so the finite check alone would silently clamp it to SPEED_BOUNDS.min.
 */
export function setBlockSpeed(doc: EditDoc, blockIndex: number, speed: number): EditDoc | null {
  if (!Number.isFinite(speed) || speed <= 0) return null;
  const rounded = round2(Math.min(SPEED_BOUNDS.max, Math.max(SPEED_BOUNDS.min, speed)));
  const base = baseTrackOf(doc);
  return mapVideoTrack(doc, base.id, (track) => ({
    ...track,
    blocks: track.blocks.map((block, i) => {
      if (i !== blockIndex) return block;
      if (rounded === 1) {
        const { speed: _removed, ...rest } = block;
        return rest;
      }
      return { ...block, speed: rounded };
    }),
  }));
}

export interface ReorderResult {
  readonly doc: EditDoc;
  /** Where the dragged block landed, or -1 if it is no longer on the base track. */
  readonly nextIndex: number;
}

/** Drop a base block at a new output position: reorder the cut sequence. */
export function reorderBaseBlock(
  doc: EditDoc,
  blockIndex: number,
  dropOutputStart: number,
): ReorderResult | null {
  const base = baseTrackOf(doc);
  const moved = base.blocks[blockIndex];
  if (!moved) return null;
  const blocks = reorderBlockByDrop(base.blocks, blockIndex, dropOutputStart);
  if (blocks.every((block, i) => block === base.blocks[i])) return null;
  return {
    doc: mapVideoTrack(doc, base.id, (track) => ({ ...track, blocks })),
    nextIndex: blocks.indexOf(moved),
  };
}

/** Move any output-positioned block on the timeline with one shared contract. */
export function moveTimedBlock(
  doc: EditDoc,
  trackId: string,
  blockIndex: number,
  at: number,
): EditDoc | null {
  if (!Number.isFinite(at)) return null;
  const nextAt = Math.max(0, round2(at));
  const targetTrack = doc.tracks.find((track) => track.id === trackId);
  let currentAt: number | null | undefined;
  if (targetTrack?.kind === 'video') {
    const targetBlock = targetTrack.blocks[blockIndex];
    currentAt = targetBlock && isLayerBlock(targetBlock) ? targetBlock.at : null;
  } else if (
    targetTrack?.kind === 'audio' ||
    targetTrack?.kind === 'overlay' ||
    targetTrack?.kind === 'effect'
  ) {
    currentAt = targetTrack.blocks[blockIndex]?.at;
  }
  if (currentAt === null || currentAt === undefined || currentAt === nextAt) return null;
  const tracks = doc.tracks.map((track) => {
    if (track.id !== trackId) return track;
    if (track.kind === 'video') {
      return {
        ...track,
        blocks: track.blocks.map((block, i) =>
          i === blockIndex && isLayerBlock(block) ? { ...block, at: nextAt } : block,
        ),
      };
    }
    if (track.kind === 'overlay') {
      return {
        ...track,
        blocks: track.blocks.map((block, i) =>
          i === blockIndex ? { ...block, at: nextAt } : block,
        ),
      };
    }
    if (track.kind === 'audio') {
      return {
        ...track,
        blocks: track.blocks.map((block, i) =>
          i === blockIndex ? { ...block, at: nextAt } : block,
        ),
      };
    }
    return {
      ...track,
      blocks: track.blocks.map((block, i) => (i === blockIndex ? { ...block, at: nextAt } : block)),
    };
  });
  return { ...doc, tracks };
}

/** Resize an output-positioned block while keeping its opposite edge anchored. */
export function resizeTimedBlock(
  doc: EditDoc,
  trackId: string,
  blockIndex: number,
  edge: BlockEdge,
  rawTime: number,
): EditDoc | null {
  if (!Number.isFinite(rawTime)) return null;
  const track = doc.tracks.find((candidate) => candidate.id === trackId);
  if (track?.kind === 'audio') {
    const target = track.blocks[blockIndex];
    if (!target) return null;
    const time = Math.max(0, round2(rawTime));
    const currentDuration = target.out - target.in;
    const minimumDuration = Math.min(MIN_TIMED_BLOCK_S, currentDuration);
    const outputEnd = target.at + currentDuration;
    let next: AudioBlock;
    if (edge === 'in') {
      const earliest = Math.max(0, target.at - target.in);
      const nextAt = Math.min(outputEnd - minimumDuration, Math.max(earliest, time));
      next = {
        ...target,
        at: round2(nextAt),
        in: round2(target.in + (nextAt - target.at)),
      };
    } else {
      const sourceDuration = doc.sources[target.source]?.durationS;
      const latest =
        sourceDuration === undefined || sourceDuration < target.out
          ? Number.POSITIVE_INFINITY
          : target.at + (sourceDuration - target.in);
      const nextEnd = Math.min(latest, Math.max(target.at + minimumDuration, time));
      next = {
        ...target,
        out: round2(target.in + (nextEnd - target.at)),
      };
    }
    next = withClampedAudioFades(next);
    if (
      next.at === target.at &&
      next.in === target.in &&
      next.out === target.out &&
      next.fadeInS === target.fadeInS &&
      next.fadeOutS === target.fadeOutS
    ) {
      return null;
    }
    return mapAudioTrack(doc, trackId, (current) => ({
      ...current,
      blocks: current.blocks.map((block, i) => (i === blockIndex ? next : block)),
    }));
  }
  if (track?.kind !== 'overlay' && track?.kind !== 'effect') return null;
  const target = track.blocks[blockIndex];
  if (!target) return null;
  const bounds =
    'type' in target
      ? effectDurationBounds(target.type)
      : { min: MIN_TIMED_BLOCK_S, max: Infinity };
  const end = target.at + (target.duration ?? 2);
  const time = Math.max(0, round2(rawTime));
  const patch =
    edge === 'in'
      ? (() => {
          const duration = Math.min(bounds.max, Math.max(bounds.min, round2(end - time)));
          return { at: round2(end - duration), duration };
        })()
      : {
          at: target.at,
          duration: Math.min(bounds.max, Math.max(bounds.min, round2(time - target.at))),
        };
  const tracks = doc.tracks.map((candidate) => {
    if (candidate.id !== trackId) return candidate;
    if (candidate.kind === 'overlay') {
      return {
        ...candidate,
        blocks: candidate.blocks.map((block, i) =>
          i === blockIndex ? { ...block, ...patch } : block,
        ),
      };
    }
    if (candidate.kind === 'effect') {
      return {
        ...candidate,
        blocks: candidate.blocks.map((block, i) =>
          i === blockIndex ? { ...block, ...patch } : block,
        ),
      };
    }
    return candidate;
  });
  return { ...doc, tracks };
}

export function updateOverlayBlock(
  doc: EditDoc,
  trackId: string,
  blockIndex: number,
  patch: Partial<Pick<OverlayBlock, 'at' | 'duration' | 'position' | 'scale'>>,
): EditDoc {
  const clampFraction = (value: number): number => Math.min(0.98, Math.max(0, round2(value)));
  const tracks = doc.tracks.map((track) => {
    if (track.kind !== 'overlay' || track.id !== trackId) return track;
    return {
      ...track,
      blocks: track.blocks.map((block, i) => {
        if (i !== blockIndex) return block;
        const position =
          patch.position === undefined
            ? block.position
            : typeof patch.position === 'string'
              ? patch.position
              : { x: clampFraction(patch.position.x), y: clampFraction(patch.position.y) };
        const scale =
          patch.scale === undefined
            ? block.scale
            : Math.min(1, Math.max(0.05, round2(patch.scale)));
        return {
          ...block,
          at: Math.max(0, round2(patch.at ?? block.at)),
          duration: Math.max(MIN_TIMED_BLOCK_S, round2(patch.duration ?? block.duration ?? 2)),
          ...(position !== undefined ? { position } : {}),
          ...(scale !== undefined ? { scale } : {}),
        };
      }),
    };
  });
  return { ...doc, tracks };
}

/** An `undefined` patch value REMOVES the key — the doc stays JSON-clean. */
export function updateSelectedLayerBlock(
  doc: EditDoc,
  selection: Selection,
  patch: Record<string, unknown>,
): EditDoc {
  return mapVideoTrack(doc, selection.trackId, (track) => ({
    ...track,
    blocks: track.blocks.map((block, i) => {
      if (i !== selection.blockIndex) return block;
      const merged: Record<string, unknown> = { ...block, ...patch };
      return Object.fromEntries(
        Object.entries(merged).filter(([, value]) => value !== undefined),
      ) as typeof block;
    }),
  }));
}

export function setSelectedTransform(
  doc: EditDoc,
  selection: Selection,
  patch: Partial<{ scale: number; x: number; y: number }>,
): EditDoc {
  return mapVideoTrack(doc, selection.trackId, (track) => ({
    ...track,
    blocks: track.blocks.map((block, i) => {
      if (i !== selection.blockIndex) return block;
      const current = block.transform ?? { scale: 1, x: 0, y: 0 };
      const next = {
        scale: Math.min(4, Math.max(0.2, patch.scale ?? current.scale)),
        x: Math.min(1, Math.max(-1, patch.x ?? current.x)),
        y: Math.min(1, Math.max(-1, patch.y ?? current.y)),
      };
      if (next.scale === 1 && next.x === 0 && next.y === 0) {
        const { transform: _removed, ...rest } = block;
        return rest;
      }
      return { ...block, transform: next };
    }),
  }));
}

export function nudgeSelectedBlock(
  doc: EditDoc,
  selection: Selection,
  deltaS: number,
): EditDoc | null {
  if (!Number.isFinite(deltaS)) return null;
  const selectedTrack = doc.tracks.find((track) => track.id === selection.trackId);
  if (selectedTrack?.kind === 'audio') {
    return mapAudioTrack(doc, selection.trackId, (track) => ({
      ...track,
      blocks: track.blocks.map((block, i) =>
        i === selection.blockIndex
          ? { ...block, at: Math.max(0, round2(block.at + deltaS)) }
          : block,
      ),
    }));
  }
  return mapVideoTrack(doc, selection.trackId, (track) => ({
    ...track,
    blocks: track.blocks.map((block, i) => {
      if (i !== selection.blockIndex) return block;
      if (isLayerBlock(block)) {
        return { ...block, at: Math.max(0, round2(block.at + deltaS)) };
      }
      return {
        ...block,
        in: Math.max(0, round2(block.in + deltaS)),
        out: round2(block.out + deltaS),
      };
    }),
  }));
}

export interface BaseInsertion {
  readonly doc: EditDoc;
  /** Source key the asset was registered under (new or reused). */
  readonly key: string;
  readonly insertIndex: number;
}

/** A continuation take: appended to the END of the base line. */
export function appendToBase(
  doc: EditDoc,
  media: MediaSummary | undefined,
  relPath: string,
): BaseInsertion | null {
  if (isKnownNonVideoMedia(media)) return null;
  const { key, exists } = sourceKeyForPath(doc, relPath);
  const durationS = round2(media?.kind === 'video' ? media.durationS : 5);
  if (!Number.isFinite(durationS) || durationS <= 0) return null;
  const base = baseTrackOf(doc);
  const next: EditDoc = {
    ...doc,
    sources: exists ? doc.sources : { ...doc.sources, [key]: { path: relPath, durationS } },
    tracks: [
      { ...base, blocks: [...base.blocks, { source: key, in: 0, out: durationS }] },
      ...doc.tracks.slice(1),
    ],
  };
  return { doc: next, key, insertIndex: base.blocks.length };
}

/** Insert a project asset at the nearest cut boundary in the base sequence. */
export function insertIntoBase(
  doc: EditDoc,
  media: MediaSummary | undefined,
  relPath: string,
  dropOutputTime: number,
): BaseInsertion | null {
  const base = baseTrackOf(doc);
  if (isKnownNonVideoMedia(media)) return null;
  const { key, exists } = sourceKeyForPath(doc, relPath);
  const durationS = round2(media?.kind === 'video' ? media.durationS : 5);
  if (!Number.isFinite(durationS) || durationS <= 0) return null;
  const at = Number.isFinite(dropOutputTime) ? Math.max(0, dropOutputTime) : Infinity;
  const insertIndex = outputSegments(doc).filter((segment) => {
    const midpoint = segment.outputStart + (segment.outputEnd - segment.outputStart) / 2;
    return midpoint <= at;
  }).length;
  const blocks = [...base.blocks];
  blocks.splice(insertIndex, 0, { source: key, in: 0, out: durationS });
  return {
    doc: {
      ...doc,
      sources: exists ? doc.sources : { ...doc.sources, [key]: { path: relPath, durationS } },
      tracks: doc.tracks.map((track) => (track.id === base.id ? { ...base, blocks } : track)),
    },
    key,
    insertIndex,
  };
}

/** Fine trim: move ONE edge of the selected block by deltaS (shave/extend). */
export function trimSelectedEdge(
  doc: EditDoc,
  selection: Selection,
  edge: BlockEdge,
  deltaS: number,
): EditDoc | null {
  if (!Number.isFinite(deltaS)) return null;
  const selectedTrack = doc.tracks.find((track) => track.id === selection.trackId);
  if (selectedTrack?.kind === 'audio') {
    return mapAudioTrack(doc, selection.trackId, (track) => ({
      ...track,
      blocks: track.blocks.map((block, i) => {
        if (i !== selection.blockIndex) return block;
        if (edge === 'in') {
          const earliestDelta = -Math.min(block.in, block.at);
          const latestDelta = block.out - block.in - 0.1;
          const appliedDelta = Math.min(latestDelta, Math.max(earliestDelta, deltaS));
          return withClampedAudioFades({
            ...block,
            in: round2(block.in + appliedDelta),
            at: round2(block.at + appliedDelta),
          });
        }
        const sourceDuration = doc.sources[block.source]?.durationS;
        const requestedOut = block.out + deltaS;
        const out = Math.max(
          block.in + 0.1,
          sourceDuration === undefined ? requestedOut : Math.min(sourceDuration, requestedOut),
        );
        return withClampedAudioFades({ ...block, out: round2(out) });
      }),
    }));
  }
  return mapVideoTrack(doc, selection.trackId, (track) => ({
    ...track,
    blocks: track.blocks.map((block, i) => {
      if (i !== selection.blockIndex) return block;
      const value = round2((edge === 'in' ? block.in : block.out) + deltaS);
      if (edge === 'in') return { ...block, in: Math.max(0, Math.min(value, block.out - 0.1)) };
      return { ...block, out: Math.max(value, block.in + 0.1) };
    }),
  }));
}
