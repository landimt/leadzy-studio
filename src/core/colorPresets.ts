import type { EditDoc, VideoColor } from './schema.js';

export const COLOR_PRESETS = [
  {
    id: 'natural',
    label: 'Natural',
    description: 'Restaura os ajustes; mantém a conversão HDR.',
    color: {},
  },
  {
    id: 'portrait',
    label: 'Retrato suave',
    description: 'Contraste delicado e cor contida.',
    color: { contrast: 0.97, saturation: 0.94, gamma: 1.03 },
  },
  {
    id: 'contrast',
    label: 'Contraste',
    description: 'Mais definição, sem aumentar a saturação.',
    color: { contrast: 1.12, saturation: 0.98 },
  },
  {
    id: 'warm',
    label: 'Mais quente',
    description: 'Aquece os tons de forma suave.',
    color: { warmth: 0.3, saturation: 0.98 },
  },
  {
    id: 'cool',
    label: 'Mais frio',
    description: 'Resfria os tons de forma suave.',
    color: { warmth: -0.3, saturation: 0.98 },
  },
  {
    id: 'mono',
    label: 'Preto e branco',
    description: 'Remove a cor apenas do vídeo escolhido.',
    color: { saturation: 0, contrast: 1.06 },
  },
] as const satisfies readonly {
  id: string;
  label: string;
  description: string;
  color: VideoColor;
}[];
export type ColorPresetId = (typeof COLOR_PRESETS)[number]['id'];
export const COLOR_PRESET_DRAG_MIME = 'application/x-leadzy-color-preset';
export function isColorPresetId(value: string): value is ColorPresetId {
  return COLOR_PRESETS.some((preset) => preset.id === value);
}
export interface ColorTarget {
  trackId: string;
  blockIndex?: number;
}

/** Presets replace creative adjustments, preserving the technical source conversion. */
export function applyColorPreset(
  doc: EditDoc,
  target: ColorTarget,
  id: ColorPresetId,
): EditDoc | null {
  const preset = COLOR_PRESETS.find((p) => p.id === id);
  const track = doc.tracks.find((t) => t.id === target.trackId);
  if (!preset || track?.kind !== 'video') return null;
  const block = target.blockIndex === undefined ? undefined : track.blocks[target.blockIndex];
  if (target.blockIndex !== undefined && !block) return null;
  const inherited = block?.color ?? track.color;
  const color: VideoColor = {
    ...preset.color,
    ...(inherited?.input ? { input: inherited.input } : {}),
  };
  return {
    ...doc,
    tracks: doc.tracks.map((t) =>
      t !== track
        ? t
        : target.blockIndex === undefined
          ? { ...track, color }
          : {
              ...track,
              blocks: track.blocks.map((b, i) => (i === target.blockIndex ? { ...b, color } : b)),
            },
    ),
  };
}
