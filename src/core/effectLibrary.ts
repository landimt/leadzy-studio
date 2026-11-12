import { SHAKE_DEFAULT_INTENSITY, type EffectBlock } from './schema.js';

/**
 * The built-in effect catalog: one entry per effect type, each producing a
 * sensible starting block at a given output time. The effects panel renders
 * whatever is listed here — adding an effect later is one schema variant plus
 * one entry, never a new UI branch.
 *
 * Labels, descriptions and icons are client concerns (i18n / UiIcon); this
 * module holds only data and defaults.
 */
export interface EffectLibraryEntry {
  readonly type: EffectBlock['type'];
  /** Starting block dropped at the playhead — the inspector tunes it from there. */
  readonly create: (at: number) => EffectBlock;
}

export const EFFECT_LIBRARY: readonly EffectLibraryEntry[] = [
  // punch-in de ênfase: perceptível sem parecer corte
  {
    type: 'zoom',
    create: (at) => ({ type: 'zoom', at, duration: 1.2, scale: 1.15 }),
  },
  // clarão de uma batida — dentro de FLASH_DURATION_BOUNDS
  {
    type: 'flash',
    create: (at) => ({ type: 'flash', at, duration: 0.25 }),
  },
  // tremida curta — dentro de SHAKE_DURATION_BOUNDS
  {
    type: 'shake',
    create: (at) => ({ type: 'shake', at, duration: 0.5, intensity: SHAKE_DEFAULT_INTENSITY }),
  },
] as const;
