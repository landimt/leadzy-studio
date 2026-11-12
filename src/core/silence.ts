export interface SilenceInterval {
  readonly start: number;
  readonly end: number;
}

export interface SilenceOptions {
  readonly windowMs?: number;
  readonly thresholdDb?: number;
  readonly minSilenceS?: number;
}

const DEFAULT_SILENCE_OPTIONS: Required<SilenceOptions> = {
  windowMs: 10,
  thresholdDb: -35,
  minSilenceS: 0.5,
};

/**
 * RMS-based silence detection over mono PCM. Works offline on the extracted
 * audio — no API involved.
 */
export function detectSilences(
  samples: Float32Array,
  sampleRate: number,
  options: SilenceOptions = {},
): SilenceInterval[] {
  const { windowMs, thresholdDb, minSilenceS } = { ...DEFAULT_SILENCE_OPTIONS, ...options };
  const windowSize = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  const threshold = Math.pow(10, thresholdDb / 20);
  const windowCount = Math.ceil(samples.length / windowSize);

  const silences: SilenceInterval[] = [];
  let silenceStart: number | null = null;

  for (let w = 0; w < windowCount; w += 1) {
    const begin = w * windowSize;
    const end = Math.min(begin + windowSize, samples.length);
    let sumSquares = 0;
    for (let i = begin; i < end; i += 1) {
      const sample = samples[i] ?? 0;
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / (end - begin));
    const time = begin / sampleRate;

    if (rms < threshold) {
      silenceStart ??= time;
    } else if (silenceStart !== null) {
      if (time - silenceStart >= minSilenceS) {
        silences.push({ start: silenceStart, end: time });
      }
      silenceStart = null;
    }
  }

  if (silenceStart !== null) {
    const totalDuration = samples.length / sampleRate;
    if (totalDuration - silenceStart >= minSilenceS) {
      silences.push({ start: silenceStart, end: totalDuration });
    }
  }
  return silences;
}

export function int16ToFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) {
    out[i] = (pcm[i] ?? 0) / 32768;
  }
  return out;
}
