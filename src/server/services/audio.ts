import { execa } from 'execa';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { err, ok, type Result } from '../../core/result.js';
import { ffmpegBinary } from './ffmpeg.js';

export const PCM_SAMPLE_RATE = 8000;

/** What the upload is called and typed as; Scribe reads the container, not the name. */
export const TRANSCRIPTION_AUDIO_EXTENSION = '.m4a';
export const TRANSCRIPTION_AUDIO_MIME = 'audio/mp4';

export interface TranscriptionExtractOptions {
  /** Playback-rate factor applied before the engine hears it, e.g. `1 / output.speed` to undo a sped-up final. */
  readonly tempo?: number;
}

/** ffmpeg's single `atempo` covers 0.5–2, the same range the schema allows for `output.speed`. */
const ATEMPO_MIN = 0.5;
const ATEMPO_MAX = 2;

export function transcriptionExtractArgs(
  sourceAbs: string,
  outputAbs: string,
  options: TranscriptionExtractOptions = {},
): string[] {
  const tempo = options.tempo ?? 1;
  if (tempo < ATEMPO_MIN || tempo > ATEMPO_MAX) {
    throw new RangeError(
      `tempo ${String(tempo)} is outside atempo's ${String(ATEMPO_MIN)}–${String(ATEMPO_MAX)}`,
    );
  }
  return [
    '-hide_banner',
    '-y',
    '-i',
    sourceAbs,
    '-vn',
    ...(tempo === 1 ? [] : ['-af', `atempo=${tempo.toFixed(6)}`]),
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    outputAbs,
  ];
}

/** 16 kHz mono AAC: speech-quality for the engine at roughly an eighth of the WAV upload. */
export async function extractAudioForTranscription(
  sourceAbs: string,
  outputAbs: string,
  options: TranscriptionExtractOptions = {},
): Promise<Result<string>> {
  try {
    await mkdir(dirname(outputAbs), { recursive: true });
    await execa(ffmpegBinary(), transcriptionExtractArgs(sourceAbs, outputAbs, options));
    return ok(outputAbs);
  } catch (cause) {
    return err('ffmpeg-failed', `audio extraction failed for "${sourceAbs}"`, cause);
  }
}

/**
 * Mono 8k PCM straight from ffmpeg's stdout — feeds both the waveform peaks
 * and the offline silence detector without any temp file.
 */
export async function loadPcm(sourceAbs: string): Promise<Result<Float32Array>> {
  try {
    const { stdout } = await execa(
      ffmpegBinary(),
      [
        '-hide_banner',
        '-v',
        'error',
        '-i',
        sourceAbs,
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(PCM_SAMPLE_RATE),
        '-f',
        's16le',
        '-',
      ],
      { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 },
    );
    const buffer = Buffer.from(stdout);
    const samples = new Float32Array(Math.floor(buffer.length / 2));
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = buffer.readInt16LE(i * 2) / 32768;
    }
    return ok(samples);
  } catch (cause) {
    return err('ffmpeg-failed', `PCM extraction failed for "${sourceAbs}"`, cause);
  }
}
