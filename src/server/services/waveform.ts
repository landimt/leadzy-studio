import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { buildPeaks, type WaveformPeaks } from '../../core/peaks.js';
import { err, ok, type Result } from '../../core/result.js';
import { loadPcm, PCM_SAMPLE_RATE } from './audio.js';
import { mediaHash } from './mediaHash.js';
import { probeMedia } from './ffmpeg.js';

interface CachedPeaksFile {
  readonly sourceHash: string;
  readonly peaks: WaveformPeaks;
}

function peaksCachePath(projectDir: string, mediaRelPath: string): string {
  return join(projectDir, 'edit', 'waveforms', `${basename(mediaRelPath)}.peaks.json`);
}

/** Immutable cache by media hash — the PCM is decoded at most once per file. */
export async function getOrBuildPeaks(
  projectDir: string,
  mediaRelPath: string,
): Promise<Result<WaveformPeaks>> {
  const mediaAbs = join(projectDir, mediaRelPath);
  const hash = await mediaHash(mediaAbs);
  if (!hash.ok) return hash;

  const cachePath = peaksCachePath(projectDir, mediaRelPath);
  const cached = await readFile(cachePath, 'utf8')
    .then((text) => JSON.parse(text) as CachedPeaksFile)
    .catch(() => null);
  if (cached?.sourceHash === hash.value) return ok(cached.peaks);

  const probe = await probeMedia(mediaAbs);
  if (!probe.ok) return probe;
  let peaks: WaveformPeaks;
  if (probe.value.hasAudio) {
    const pcm = await loadPcm(mediaAbs);
    if (!pcm.ok) return pcm;
    peaks = buildPeaks(pcm.value, PCM_SAMPLE_RATE);
  } else {
    // Screen captures often have no audio stream at all. Their flat waveform
    // is valid media, not a failed ffmpeg extraction or a failed project load.
    const windows = Math.ceil(probe.value.durationS * 100);
    peaks = {
      version: 1,
      sampleRate: PCM_SAMPLE_RATE,
      windowMs: 10,
      min: new Array<number>(windows).fill(0),
      max: new Array<number>(windows).fill(0),
    };
  }
  try {
    await mkdir(dirname(cachePath), { recursive: true });
    const payload: CachedPeaksFile = { sourceHash: hash.value, peaks };
    await writeFile(cachePath, JSON.stringify(payload));
  } catch (cause) {
    return err('io-failed', `cannot write waveform cache "${cachePath}"`, cause);
  }
  return ok(peaks);
}
