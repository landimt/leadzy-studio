import type { MediaSummary } from '../../api.js';
import type { CanvasConfig, EditDoc, LayerCell } from '../../../core/schema.js';
import { isLayerBlock } from '../../../core/schema.js';
import {
  clampLayerCell,
  DEFAULT_CANVAS_BASE_CELL,
  defaultCanvasConfig,
  isKnownNonVideoMedia,
  sourceKeyForPath,
  withReplacedBackgroundSourcePruned,
} from '../docEdits.js';
import type { BackgroundFit } from '../storeState.js';
import { mapVideoTrack } from './mapTrack.js';

// Pure canvas edits: the first-class background and the base window. Every
// function returns the next document, or `null` when nothing would change;
// the store owns history, validation, saving, the background lock and the
// inspector state.

/**
 * Applies `update` to the canvas (the restrained default when the document has
 * none). `null` when an existing canvas would come out identical, so a no-op
 * never records history. Replacing a video background prunes its source if
 * nothing else references it.
 */
function updateCanvas(
  doc: EditDoc,
  update: (canvas: CanvasConfig) => CanvasConfig,
): EditDoc | null {
  const canvas = update(doc.canvas ?? defaultCanvasConfig());
  if (doc.canvas !== undefined && JSON.stringify(canvas) === JSON.stringify(doc.canvas))
    return null;
  return withReplacedBackgroundSourcePruned(doc, { ...doc, canvas });
}

/** Enables the first-class canvas using the restrained talking-head default. */
export function ensureBackground(doc: EditDoc): EditDoc | null {
  if (doc.canvas !== undefined) return null;
  return { ...doc, canvas: defaultCanvasConfig() };
}

/** Returns to the legacy full-frame composition without leaving partial canvas state behind. */
export function removeBackground(doc: EditDoc): EditDoc | null {
  if (!doc.canvas) return null;
  const { canvas: _removed, ...withoutCanvas } = doc;
  return withReplacedBackgroundSourcePruned(doc, withoutCanvas);
}

export function setBackgroundColor(doc: EditDoc, color: string): EditDoc | null {
  return updateCanvas(doc, (canvas) => ({ ...canvas, background: { kind: 'color', color } }));
}

/** An image background keeps the previous background's color as the letterbox fallback. */
export function setBackgroundImage(
  doc: EditDoc,
  file: string,
  fit: BackgroundFit = 'cover',
): EditDoc | null {
  return updateCanvas(doc, (canvas) => {
    const fallbackColor = canvas.background.color;
    return {
      ...canvas,
      background: {
        kind: 'image',
        file,
        fit,
        ...(fallbackColor !== undefined ? { color: fallbackColor } : {}),
      },
    };
  });
}

/** Picks an already-registered video source (useful for agent-authored edit.json). */
export function setBackgroundVideoSource(
  doc: EditDoc,
  media: MediaSummary | undefined,
  source: string,
  fit: BackgroundFit = 'cover',
): EditDoc | null {
  if (!doc.sources[source]) return null;
  if (isKnownNonVideoMedia(media)) return null;
  return updateCanvas(doc, (canvas) => {
    const fallbackColor = canvas.background.color;
    return {
      ...canvas,
      background: {
        kind: 'video',
        source,
        fit,
        ...(fallbackColor !== undefined ? { color: fallbackColor } : {}),
      },
    };
  });
}

/** Registers a project video path collision-safely and makes it the canvas background. */
export function setBackgroundVideo(
  doc: EditDoc,
  media: MediaSummary | undefined,
  relPath: string,
  fit: BackgroundFit = 'cover',
): EditDoc | null {
  if (isKnownNonVideoMedia(media)) return null;
  const { key, exists } = sourceKeyForPath(doc, relPath);
  if (!exists && media?.kind !== 'video') return null;
  const canvas = doc.canvas ?? defaultCanvasConfig();
  const fallbackColor = canvas.background.color;
  const currentSource = doc.sources[key];
  const durationS = media?.kind === 'video' ? media.durationS : undefined;
  const sources = exists
    ? durationS === undefined || currentSource === undefined
      ? doc.sources
      : { ...doc.sources, [key]: { ...currentSource, durationS } }
    : {
        ...doc.sources,
        [key]: durationS === undefined ? { path: relPath } : { path: relPath, durationS },
      };
  const next = withReplacedBackgroundSourcePruned(doc, {
    ...doc,
    sources,
    canvas: {
      ...canvas,
      background: {
        kind: 'video',
        source: key,
        fit,
        ...(fallbackColor !== undefined ? { color: fallbackColor } : {}),
      },
    },
  });
  if (JSON.stringify(next) === JSON.stringify(doc)) return null;
  return next;
}

/** Fit only applies to media backgrounds; a color background has nothing to fit. */
export function setBackgroundFit(doc: EditDoc, fit: BackgroundFit): EditDoc | null {
  const background = doc.canvas?.background;
  if (!background || background.kind === 'color') return null;
  return updateCanvas(doc, (canvas) =>
    canvas.background.kind === 'color'
      ? canvas
      : { ...canvas, background: { ...canvas.background, fit } },
  );
}

export function setCanvasBaseMode(
  doc: EditDoc,
  mode: CanvasConfig['base']['mode'],
): EditDoc | null {
  return updateCanvas(doc, (canvas) => ({
    ...canvas,
    base:
      mode === 'fill'
        ? { mode: 'fill' }
        : {
            mode: 'cell',
            cell: canvas.base.mode === 'cell' ? canvas.base.cell : { ...DEFAULT_CANVAS_BASE_CELL },
          },
  }));
}

/** `null` on any non-finite component — a zero-width drag or a cleared input hands us NaN. */
export function setCanvasBaseCell(doc: EditDoc, cell: LayerCell): EditDoc | null {
  if (![cell.x, cell.y, cell.w, cell.h].every(Number.isFinite)) return null;
  const clamped = clampLayerCell(cell);
  return updateCanvas(doc, (canvas) => ({ ...canvas, base: { mode: 'cell', cell: clamped } }));
}

export function setOutputSize(doc: EditDoc, width: number, height: number): EditDoc {
  return { ...doc, output: { ...doc.output, width, height } };
}

/**
 * Free editor-style rect for mode "cell" — applies only when the target block is a layer block.
 * `null` if any component is non-finite: Math.min/max would propagate NaN straight through the
 * clamp into a rejected doc otherwise.
 */
export function updateLayerCell(
  doc: EditDoc,
  trackId: string,
  blockIndex: number,
  cell: LayerCell,
): EditDoc | null {
  if (![cell.x, cell.y, cell.w, cell.h].every(Number.isFinite)) return null;
  const clamped = clampLayerCell(cell);
  return mapVideoTrack(doc, trackId, (track) => ({
    ...track,
    blocks: track.blocks.map((block, i) =>
      i === blockIndex && isLayerBlock(block) ? { ...block, cell: clamped } : block,
    ),
  }));
}
