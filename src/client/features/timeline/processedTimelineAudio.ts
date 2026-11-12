import { baseTrackOf, isLayerBlock, type EditDoc } from '../../../core/schema.js';
import type { OutputSegment } from '../../../core/timeline.js';
import type { WaveformPeaks } from '../../../core/peaks.js';
import { buildAudioWaveformEnvelope } from '../audio/processedAudioWaveform.js';

/** The timeline is before global speed; the exported audio is after it. */
export function processedAudioEnd(timelineDurationS: number, globalSpeed = 1): number {
  return Math.max(0, timelineDurationS) / globalSpeed;
}

/** Keep real amplitude and a time-based envelope even at high timeline zoom. */
export function processedTimelinePeaks(
  channels: readonly Float32Array[],
  sampleRate: number,
): WaveformPeaks {
  const length = channels.reduce((max, channel) => Math.max(max, channel.length), 0);
  const durationS = length / sampleRate;
  const buckets = Math.max(1, Math.ceil(durationS * 100));
  const envelope = buildAudioWaveformEnvelope(channels, buckets);
  return {
    version: 1,
    sampleRate,
    windowMs: durationS > 0 ? (durationS * 1000) / buckets : 10,
    ...envelope,
  };
}

/** Never draw an old mix against new cuts, including while local edits save. */
export function processedTimelineSource(
  hasComparison: boolean,
  outdated: boolean,
  version: number,
  mediaUrl: (path: string) => string,
): string | null {
  return hasComparison && !outdated
    ? `${mediaUrl('edit/audio-preview.m4a')}?v=${String(version)}`
    : null;
}

/** Do not pretend a music/SFX mix is the isolated camera waveform. */
export function baseHasEntireAudioMix(doc: EditDoc): boolean {
  const base = baseTrackOf(doc);
  if (base.muted === true) return false;
  return !doc.tracks.some((track) => {
    if (track === base) return false;
    if (track.kind === 'audio') return track.muted !== true && track.blocks.length > 0;
    if (track.kind !== 'video' || track.hidden === true || track.muted === true) return false;
    return track.blocks.some((block) => isLayerBlock(block) && block.audio !== 'mute');
  });
}

/** Per-block speed and frame rounding are already in outputSegments. */
export function processedSegmentWindow(
  segment: OutputSegment,
  globalSpeed = 1,
): { from: number; to: number } {
  return {
    from: processedAudioEnd(segment.outputStart, globalSpeed),
    to: processedAudioEnd(segment.outputEnd, globalSpeed),
  };
}
