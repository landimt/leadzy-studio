import { isLayerBlock, parseEditDoc, type EditDoc } from '../../../core/schema.js';
import { outputDuration, outputSegments, MIN_TIMED_BLOCK_S } from '../../../core/timeline.js';
import type { MediaSummary } from '../../api.js';
import { effectDurationBounds, withClampedAudioFades } from '../../state/docEdits.js';
import type { Selection } from '../../state/storeState.js';

export interface ClipRange {
  start: number;
  end: number;
}
export interface ClipEditorSession {
  readonly doc: EditDoc;
  readonly selection: Selection;
}
export interface ClipRangeInfo {
  readonly range: ClipRange;
  readonly duration: number | null;
  readonly minLength: number;
  readonly maxLength: number;
  readonly mode: 'source' | 'timeline';
  readonly holdLastFrame?: boolean;
  readonly mediaKind: 'video' | 'audio' | 'image' | 'effect';
  readonly path?: string;
  readonly source?: string;
  readonly label: string;
  readonly at: number;
  readonly speed: number;
}

export function clipRangeInfo(
  doc: EditDoc,
  selection: Selection,
  media: readonly MediaSummary[] = [],
): ClipRangeInfo | null {
  const track = doc.tracks.find((t) => t.id === selection.trackId);
  if (!track) return null;
  const block = track.blocks[selection.blockIndex];
  if (!block) return null;
  const defaults = { minLength: MIN_TIMED_BLOCK_S, maxLength: Infinity, speed: 1 };
  if ('source' in block) {
    const source = doc.sources[block.source];
    if (!source) return null;
    const asset = media.find((m) => m.relPath === source.path);
    const duration = asset && 'durationS' in asset ? asset.durationS : (source.durationS ?? null);
    const segment = outputSegments(doc).find((s) => s.blockIndex === selection.blockIndex);
    return {
      ...defaults,
      minLength: Math.min(1 / doc.fps, block.out - block.in),
      range: { start: block.in, end: block.out },
      duration,
      mode: 'source',
      mediaKind: track.kind === 'audio' ? 'audio' : 'video',
      source: block.source,
      path: asset?.proxyRelPath ?? source.path,
      label: source.path,
      at: 'at' in block ? block.at : (segment?.outputStart ?? 0),
      speed: track.kind === 'video' && !isLayerBlock(block) ? (segment?.speed ?? 1) : 1,
    };
  }
  if ('file' in block) {
    const image = /\.(png|jpe?g|webp|gif|svg)$/i.test(block.file);
    const asset = media.find((m) => m.relPath === block.file);
    const duration = asset && 'durationS' in asset ? asset.durationS : null;
    const start = image ? block.at : (block.sourceIn ?? 0);
    const length = block.duration ?? (duration === null ? 2 : duration - start);
    return {
      ...defaults,
      range: { start, end: start + length },
      duration: image ? Math.max(outputDuration(doc), start + length) : duration,
      mode: image ? 'timeline' : 'source',
      holdLastFrame: !image,
      mediaKind: image ? 'image' : 'video',
      path: block.file,
      label: block.title?.text ?? block.file,
      at: block.at,
    };
  }
  const bounds = effectDurationBounds(block.type);
  return {
    ...defaults,
    range: { start: block.at, end: block.at + block.duration },
    duration: Math.max(outputDuration(doc), block.at + block.duration),
    minLength: bounds.min,
    maxLength: bounds.max,
    mode: 'timeline',
    mediaKind: 'effect',
    label: track.label ?? block.type,
    at: block.at,
  };
}

/** Existing animated overlays can intentionally hold their last frame after EOF. */
export function clipRangeLimit(info: ClipRangeInfo, sourceDuration: number): number {
  return info.holdLastFrame === true ? Math.max(sourceDuration, info.range.end) : sourceDuration;
}

/** Moving the window preserves its length; resizing one edge never crosses the other. */
export function dragClipRange(
  range: ClipRange,
  mode: 'move' | 'start' | 'end',
  delta: number,
  duration: number,
  minLength: number,
  maxLength: number,
): ClipRange {
  if (![delta, duration, range.start, range.end].every(Number.isFinite)) return range;
  if (mode === 'move') {
    const shift = Math.max(-range.start, Math.min(duration - range.end, delta));
    return { start: range.start + shift, end: range.end + shift };
  }
  if (mode === 'start')
    return {
      start: Math.max(
        0,
        range.end - maxLength,
        Math.min(range.end - minLength, range.start + delta),
      ),
      end: range.end,
    };
  return {
    start: range.start,
    end: Math.min(
      duration,
      range.start + maxLength,
      Math.max(range.start + minLength, range.end + delta),
    ),
  };
}

export function applyClipRange(
  doc: EditDoc,
  selection: Selection,
  range: ClipRange,
  duration: number,
): EditDoc | null {
  const info = clipRangeInfo(doc, selection);
  const length = range.end - range.start;
  if (
    !info ||
    ![range.start, range.end, duration].every(Number.isFinite) ||
    duration <= 0 ||
    range.start < 0 ||
    range.end > clipRangeLimit(info, duration) + 1e-6 ||
    (info.mode === 'source' && range.start >= duration) ||
    length < info.minLength - 1e-6 ||
    length > info.maxLength + 1e-6
  )
    return null;
  const tracks = doc.tracks.map((track) =>
    track.id !== selection.trackId
      ? track
      : {
          ...track,
          blocks: track.blocks.map((block, i) => {
            if (i !== selection.blockIndex) return block;
            if ('source' in block) {
              const updated = { ...block, in: range.start, out: range.end };
              return track.kind === 'audio' && 'at' in updated
                ? withClampedAudioFades(updated)
                : updated;
            }
            if ('file' in block)
              return info.mode === 'source'
                ? { ...block, sourceIn: range.start, duration: length }
                : { ...block, at: range.start, duration: length };
            return { ...block, at: range.start, duration: length };
          }),
        },
  );
  const parsed = parseEditDoc({ ...doc, tracks });
  return parsed.ok ? parsed.value : null;
}
