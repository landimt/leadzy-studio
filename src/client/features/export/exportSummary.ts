import type { EditDoc } from '../../../core/schema.js';
import { outputDuration } from '../../../core/timeline.js';
import { t } from '../../i18n/index.js';

export const EXPORT_RESOLUTION_TIERS = ['720p', '1080p', '2K', '4K'] as const;

export type ExportResolutionTier = (typeof EXPORT_RESOLUTION_TIERS)[number];
export interface ExportDimensions {
  readonly width: number;
  readonly height: number;
}

const TIER_SHORT_SIDE: Record<ExportResolutionTier, number> = {
  '720p': 720,
  '1080p': 1080,
  '2K': 1440,
  '4K': 2160,
};

const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);

/**
 * CapCut-style resolution tiers scale the authored canvas; they never change
 * its aspect ratio. Thus a 9:16 4K export is 2160x3840, while a 4:5 canvas is
 * 2160x2700 instead of being silently converted to 9:16.
 */
export function exportDimensionsForTier(
  current: ExportDimensions,
  tier: ExportResolutionTier,
): ExportDimensions {
  const scale = TIER_SHORT_SIDE[tier] / Math.min(current.width, current.height);
  return {
    width: even(current.width * scale),
    height: even(current.height * scale),
  };
}

/** Returns null for a custom project size so opening Export never silently changes it. */
export function exportResolutionTierForDimensions(
  dimensions: ExportDimensions,
): ExportResolutionTier | null {
  return (
    EXPORT_RESOLUTION_TIERS.find((tier) => {
      const preset = exportDimensionsForTier(dimensions, tier);
      return preset.width === dimensions.width && preset.height === dimensions.height;
    }) ?? null
  );
}

/** Read-only processing summary used by Export; editing stays in the two tools. */
export function audioSpeedSummary(output: EditDoc['output']): string {
  const denoisePct = Math.round((output.denoise ?? 0) * 100);
  const speedValue = output.speed ?? 1;
  const crossfadeMs = output.joinAudioCrossfadeMs ?? 0;
  const audio = [
    output.loudnormLufs === null
      ? t('export.audioSpeed.summaryOff')
      : `${String(output.loudnormLufs)} LUFS`,
    ...(denoisePct > 0
      ? [`${t('export.audioSpeed.summaryNoiseUnit')} ${String(denoisePct)}%`]
      : []),
  ].join(' · ');
  const parts = [
    `${t('export.audioSpeed.summaryPrefix')} ${audio}`,
    `${t('export.audioSpeed.summarySpeedPrefix')} ${String(speedValue)}×`,
    ...(crossfadeMs > 0
      ? [`${t('export.audioSpeed.summaryJoinsUnit')} ${String(crossfadeMs)}ms`]
      : []),
  ];
  return parts.join(' · ');
}

/** Exact duration emitted after block speed, global speed and frame-grid quantization. */
export function exportDurationSeconds(doc: EditDoc): number {
  const speed = doc.output.speed ?? 1;
  return Math.round((outputDuration(doc) / speed) * doc.fps) / doc.fps;
}
