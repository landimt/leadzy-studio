import type { EditDoc } from '../../../core/schema.js';
import type { ColorTarget } from '../../../core/colorPresets.js';
export function resolveColorDrop(
  doc: EditDoc,
  trackId: string | undefined,
  index: string | undefined,
  locked: ReadonlySet<string>,
): ColorTarget | null {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (track?.kind !== 'video' || locked.has(track.id)) return null;
  if (index === undefined) return { trackId: track.id };
  if (!/^\d+$/.test(index)) return null;
  const blockIndex = Number(index);
  return Number.isSafeInteger(blockIndex) && track.blocks[blockIndex]
    ? { trackId: track.id, blockIndex }
    : null;
}
