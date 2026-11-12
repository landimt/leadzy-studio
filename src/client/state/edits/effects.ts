import type { EditDoc, EffectBlock, EffectTrack } from '../../../core/schema.js';
import {
  FLASH_DURATION_BOUNDS,
  SHAKE_DEFAULT_INTENSITY,
  SHAKE_DURATION_BOUNDS,
  SHAKE_INTENSITY_BOUNDS,
  ZOOM_SCALE_BOUNDS,
} from '../../../core/schema.js';
import { MIN_TIMED_BLOCK_S } from '../../../core/timeline.js';
import { clampEffectDuration } from '../docEdits.js';
import type { Selection } from '../storeState.js';

// Pure effect edits: zoom, flash and shake blocks over the locked cut, on
// their own track. The store owns history, validation, saving and selection.

const round2 = (value: number): number => Math.round(value * 100) / 100;

export interface EffectAddition {
  readonly doc: EditDoc;
  /** The block just appended — the store selects it. */
  readonly selection: Selection;
}

/** Appends a block to the first effect track, creating `effects` at the end of the rows when there is none. */
export function addEffectBlock(doc: EditDoc, block: EffectBlock): EffectAddition {
  const effectTrack = doc.tracks.find((track): track is EffectTrack => track.kind === 'effect');
  const effectTrackId = effectTrack?.id ?? 'effects';
  const blockIndex = effectTrack?.blocks.length ?? 0;
  const tracks = effectTrack
    ? doc.tracks.map((track) =>
        track === effectTrack ? { ...track, blocks: [...track.blocks, block] } : track,
      )
    : [
        ...doc.tracks,
        { id: 'effects', kind: 'effect' as const, label: 'efeitos', blocks: [block] },
      ];
  return { doc: { ...doc, tracks }, selection: { trackId: effectTrackId, blockIndex } };
}

/** Catalog entry point (effects panel): per-type clamps applied, so a library default can never violate the schema bounds. */
export function addEffect(doc: EditDoc, block: EffectBlock): EffectAddition {
  return addEffectBlock(doc, {
    ...block,
    at: round2(block.at),
    duration: clampEffectDuration(block.type, block.duration),
  });
}

export function addZoomEffect(
  doc: EditDoc,
  at: number,
  duration: number,
  scale: number,
): EffectAddition {
  return addEffectBlock(doc, {
    type: 'zoom',
    at: round2(at),
    duration: clampEffectDuration('zoom', duration),
    scale,
  });
}

export function addFlashEffect(doc: EditDoc, at: number, duration: number): EffectAddition {
  return addEffectBlock(doc, {
    type: 'flash',
    at: round2(at),
    duration: clampEffectDuration('flash', duration),
  });
}

export function addShakeEffect(
  doc: EditDoc,
  at: number,
  duration: number,
  intensity: number = SHAKE_DEFAULT_INTENSITY,
): EffectAddition {
  return addEffectBlock(doc, {
    type: 'shake',
    at: round2(at),
    duration: clampEffectDuration('shake', duration),
    intensity,
  });
}

export interface EffectPatch {
  readonly at?: number;
  readonly duration?: number;
  readonly scale?: number;
  readonly intensity?: number;
}

/** Patches one effect block, clamping every field into its type's bounds. */
export function updateEffectBlock(
  doc: EditDoc,
  trackId: string,
  blockIndex: number,
  patch: EffectPatch,
): EditDoc {
  const tracks = doc.tracks.map((track) => {
    if (track.kind !== 'effect' || track.id !== trackId) return track;
    return {
      ...track,
      blocks: track.blocks.map((block, i): EffectBlock => {
        if (i !== blockIndex) return block;
        const at = Math.max(0, round2(patch.at ?? block.at));
        if (block.type === 'zoom') {
          const duration = Math.max(MIN_TIMED_BLOCK_S, round2(patch.duration ?? block.duration));
          const scale = Math.min(
            ZOOM_SCALE_BOUNDS.max,
            Math.max(ZOOM_SCALE_BOUNDS.min, patch.scale ?? block.scale),
          );
          return { ...block, at, duration, scale };
        }
        if (block.type === 'flash') {
          const duration = Math.min(
            FLASH_DURATION_BOUNDS.max,
            Math.max(FLASH_DURATION_BOUNDS.min, round2(patch.duration ?? block.duration)),
          );
          return { ...block, at, duration };
        }
        const duration = Math.min(
          SHAKE_DURATION_BOUNDS.max,
          Math.max(SHAKE_DURATION_BOUNDS.min, round2(patch.duration ?? block.duration)),
        );
        const intensity = Math.min(
          SHAKE_INTENSITY_BOUNDS.max,
          Math.max(
            SHAKE_INTENSITY_BOUNDS.min,
            Math.round(patch.intensity ?? block.intensity ?? SHAKE_DEFAULT_INTENSITY),
          ),
        );
        return { ...block, at, duration, intensity };
      }),
    };
  });
  return { ...doc, tracks };
}
