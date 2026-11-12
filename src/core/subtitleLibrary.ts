import type { SubtitlePreset, SubtitleTheme } from './schema.js';

/**
 * One named look from the built-in catalog: a preset plus the theme/rhythm
 * overrides that make it recognizable. Applying a style is a client concern
 * (`store.updateSubtitleSettings`) — this module only holds the data.
 *
 * The catalog is deliberately tiny: three starting points, not a gallery.
 * Every other look is the agent's job — it writes `subtitles.theme` directly,
 * and the inspector's custom controls cover the quick human tweaks (colors,
 * font, weight).
 */
export interface SubtitleLibraryStyle {
  readonly id: string;
  readonly label: string;
  readonly preset: SubtitlePreset;
  readonly theme?: SubtitleTheme;
  readonly fontSize?: number;
  readonly marginV?: number;
  readonly minWordsPerCue?: number;
  readonly maxWordsPerCue?: number;
}

// NOTE: only the 'pill' preset colors the currently-spoken word with
// `highlightFill` (see buildSubtitleCues in srt.ts) — '2p-caps' and
// '3p-natural' render every word in `fill`. Styles built on those two
// presets must carry their accent color on `fill`, never on an inert
// `highlightFill`.
export const SUBTITLE_LIBRARY: readonly SubtitleLibraryStyle[] = [
  // O default do Studio: pílula escura, palavra falada em rosa — é o preset
  // 'pill' puro, então um projeto recém-aberto já mostra este card ativo.
  {
    id: 'pilula-escura',
    label: 'Pílula Escura',
    preset: 'pill',
  },
  // CAIXA ALTA, 1-2 palavras, contorno grosso — legenda de impacto, sem fundo.
  {
    id: 'impacto',
    label: 'Impacto',
    preset: '2p-caps',
    theme: {
      fontFamily: 'Arial Black',
      fontWeight: 900,
      outlineWidth: 6,
    },
  },
  // Natural, sem fundo, contorno fino — legenda discreta e limpa.
  {
    id: 'minimal-branco',
    label: 'Minimal',
    preset: '3p-natural',
  },
] as const;
