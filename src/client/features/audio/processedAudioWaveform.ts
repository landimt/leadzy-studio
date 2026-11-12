export interface AudioWaveformEnvelope {
  readonly min: readonly number[];
  readonly max: readonly number[];
}

/** Peak in source amplitude units; callers can share it across multiple envelopes. */
export function audioWaveformEnvelopePeak(envelope: AudioWaveformEnvelope): number {
  let peak = 0;
  for (const sample of envelope.min) peak = Math.max(peak, Math.abs(sample));
  for (const sample of envelope.max) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

/**
 * One visual gain for A/B: a quieter file must look quieter instead of each
 * waveform being independently inflated to fill its row.
 */
export function sharedAudioWaveformPeak(
  envelopes: readonly AudioWaveformEnvelope[],
  floor = 0.04,
): number {
  return Math.max(floor, ...envelopes.map(audioWaveformEnvelopePeak));
}

/**
 * Synchronized A/B playback can only seek through the shorter decoded file.
 * The document duration is a loading fallback only: global speed can make the
 * rendered audio substantially shorter than `doc.totalDurationS`.
 */
export function audioComparisonDuration(
  measuredDurations: readonly (number | null)[],
  fallbackDurationS: number,
): number {
  const measured = measuredDurations.filter(
    (duration): duration is number =>
      typeof duration === 'number' && Number.isFinite(duration) && duration > 0,
  );
  if (measured.length > 0) return Math.min(...measured);
  return Number.isFinite(fallbackDurationS) ? Math.max(0, fallbackDurationS) : 0;
}

/**
 * Reduces decoded PCM into a browser-sized mono envelope. This is only a visual
 * representation of the rendered file; playback always uses the file itself.
 */
export function buildAudioWaveformEnvelope(
  channels: readonly Float32Array[],
  bucketCount: number,
): AudioWaveformEnvelope {
  const buckets = Math.max(1, Math.floor(bucketCount));
  const sampleCount = channels.reduce((largest, channel) => Math.max(largest, channel.length), 0);
  if (channels.length === 0 || sampleCount === 0) {
    return { min: new Array<number>(buckets).fill(0), max: new Array<number>(buckets).fill(0) };
  }

  const min = new Array<number>(buckets).fill(0);
  const max = new Array<number>(buckets).fill(0);
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const from = Math.floor((bucket * sampleCount) / buckets);
    const to = Math.max(from + 1, Math.floor(((bucket + 1) * sampleCount) / buckets));
    let lo = 0;
    let hi = 0;
    for (let sample = from; sample < to && sample < sampleCount; sample += 1) {
      let mono = 0;
      for (const channel of channels) mono += channel[sample] ?? 0;
      mono /= channels.length;
      lo = Math.min(lo, mono);
      hi = Math.max(hi, mono);
    }
    min[bucket] = lo;
    max[bucket] = hi;
  }
  return { min, max };
}

export function audioTimeAtFraction(fraction: number, durationS: number): number {
  if (!Number.isFinite(fraction) || !Number.isFinite(durationS) || durationS <= 0) return 0;
  return Math.min(1, Math.max(0, fraction)) * durationS;
}

export function audioTimeFromSliderKey(
  key: string,
  currentTimeS: number,
  durationS: number,
  stepS = 5,
): number | null {
  if (key === 'Home') return 0;
  if (key === 'End') return Math.max(0, durationS);
  const direction =
    key === 'ArrowLeft' || key === 'ArrowDown'
      ? -1
      : key === 'ArrowRight' || key === 'ArrowUp'
        ? 1
        : 0;
  if (direction === 0) return null;
  const safeStep = Number.isFinite(stepS) ? Math.max(0, stepS) : 0;
  return boundedAudioTime(currentTimeS + direction * safeStep, durationS);
}

/** Keeps media and accessibility values inside the comparison's common range. */
export function boundedAudioTime(timeS: number, durationS: number): number {
  if (!Number.isFinite(timeS) || !Number.isFinite(durationS) || durationS <= 0) return 0;
  return Math.min(durationS, Math.max(0, timeS));
}

export function formatAudioClock(timeS: number): string {
  const safe = Number.isFinite(timeS) ? Math.max(0, timeS) : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = Math.floor(safe - minutes * 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatAudioPosition(timeS: number, durationS: number): string {
  return `${formatAudioClock(boundedAudioTime(timeS, durationS))} / ${formatAudioClock(durationS)}`;
}
