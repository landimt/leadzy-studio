import { execa, ExecaError } from 'execa';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { installationRoot } from '../../core/installation.js';
import { err, ok, type Result } from '../../core/result.js';
import type { RenderOptions, VideoDecoder, VideoEncoder } from '../../core/render/options.js';
import type { ImageMediaProbe, TimedMediaProbe, VideoMediaProbe } from '../../core/media.js';

const BIN_DIR = join(installationRoot(import.meta.url, 3), 'bin');
const BUNDLED_FFMPEG = join(BIN_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const BUNDLED_FFPROBE = join(BIN_DIR, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const FFMPEG_BIN = existsSync(BUNDLED_FFMPEG) ? BUNDLED_FFMPEG : 'ffmpeg';
const FFPROBE_BIN = existsSync(BUNDLED_FFPROBE) ? BUNDLED_FFPROBE : 'ffprobe';

export interface FfmpegCapabilities {
  readonly version: string;
  readonly hasSubtitlesFilter: boolean;
  /** `ffmpeg -hwaccels` lists videotoolbox: sources can be decoded on the GPU (see RenderOptions.hwaccel). */
  readonly hasVideotoolboxDecode: boolean;
  /** `true` only when a one-frame encode with the planner's `-q:v` flag succeeded. */
  readonly hasVideotoolbox: boolean;
  /**
   * The NVIDIA decoder, the Windows/Linux counterpart of videotoolbox: `-hwaccels`
   * lists cuda AND an NVENC session opened. The listing alone proves nothing —
   * distro builds list cuda on machines with no NVIDIA card, and every decode
   * then fails — while an open NVENC session proves the card and its driver.
   */
  readonly hasCudaDecode: boolean;
  /** `true` only when a one-frame encode with the planner's NVENC flags succeeded. */
  readonly hasNvenc: boolean;
}

/** The ffmpeg this process runs: the bundled binary when present, else PATH. */
export function ffmpegBinary(): string {
  return FFMPEG_BIN;
}

/** The encoder for renders that must be fast rather than reproducible. */
export function fastVideoEncoder(capabilities: FfmpegCapabilities): VideoEncoder {
  if (capabilities.hasVideotoolbox) return 'h264_videotoolbox';
  if (capabilities.hasNvenc) return 'h264_nvenc';
  return 'libx264';
}

/** The GPU decoder this ffmpeg can actually use, or undefined when there is none. */
export function hardwareDecoder(capabilities: FfmpegCapabilities): VideoDecoder | undefined {
  if (capabilities.hasVideotoolboxDecode) return 'videotoolbox';
  if (capabilities.hasCudaDecode) return 'cuda';
  return undefined;
}

/** Escape hatch: `LEADZY_STUDIO_SOFTWARE_DECODE=1` (or `true`) keeps every render on the CPU decoder; anything else leaves it on. */
export function softwareDecodeForced(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.LEADZY_STUDIO_SOFTWARE_DECODE ?? '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

/**
 * Fills the decoder/encoder an explicit caller left open: the hardware
 * decoder whenever ffmpeg has it (frames are identical, several times faster
 * on 4K sources) and, for previews, the fast encoder — so CLI previews get
 * the same fast path the UI already asks for.
 */
export function withRenderDefaults(
  options: RenderOptions,
  capabilities: FfmpegCapabilities | null,
  env: NodeJS.ProcessEnv = process.env,
): RenderOptions {
  const available = capabilities === null ? undefined : hardwareDecoder(capabilities);
  const hwaccel =
    options.hwaccel ??
    (available !== undefined && !softwareDecodeForced(env) ? available : undefined);
  const videoEncoder =
    options.videoEncoder ??
    (options.preview && capabilities !== null ? fastVideoEncoder(capabilities) : 'libx264');
  return {
    ...options,
    videoEncoder,
    ...(hwaccel !== undefined ? { hwaccel } : {}),
  };
}

const INSTALL_HINTS: Record<string, string> = {
  darwin:
    'macOS: o ffmpeg do Homebrew 8.x vem SEM libass. Baixe um build estático completo em https://ffmpeg.martin-riedl.de/ e coloque no PATH.',
  win32:
    'Windows: baixe o build "full" em https://www.gyan.dev/ffmpeg/builds/ e adicione a pasta bin ao PATH.',
  linux:
    'Linux: instale via gerenciador (apt/dnf install ffmpeg) — as distros principais já incluem libass.',
};

function installHint(): string {
  return INSTALL_HINTS[process.platform] ?? INSTALL_HINTS.linux ?? '';
}

/**
 * `ffmpeg -encoders` lists h264_videotoolbox on every macOS build, including
 * machines whose VideoToolbox session cannot open with the constant-quality
 * flag the planner emits (Intel Macs, VMs). Only an actual one-frame encode
 * with those exact flags proves the fast path works.
 */
const PROBE_TIMEOUT_MS = 10_000;
const NVENC_PROBE_SIZE = '256x256';

async function canEncodeWith(
  encoder: string,
  quality: readonly string[],
  size = '64x64',
): Promise<boolean> {
  try {
    await execa(
      FFMPEG_BIN,
      [
        '-hide_banner',
        '-f',
        'lavfi',
        '-i',
        `color=black:size=${size}:rate=1`,
        '-frames:v',
        '1',
        '-c:v',
        encoder,
        ...quality,
        '-pix_fmt',
        'yuv420p',
        '-f',
        'null',
        '-',
      ],
      { timeout: PROBE_TIMEOUT_MS },
    );
    return true;
  } catch {
    return false;
  }
}

/** `ffmpeg -hwaccels` prints a header line followed by one method per line. */
export function parseHwaccels(stdout: string): readonly string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith(':'));
}

/**
 * Boot check: a capped ffmpeg (Homebrew's, notably) silently lacks the
 * subtitles filter and burning captions fails mid-render — catch it up front.
 */
export async function checkFfmpeg(): Promise<Result<FfmpegCapabilities>> {
  try {
    const version = await execa(FFMPEG_BIN, ['-hide_banner', '-version']);
    const filters = await execa(FFMPEG_BIN, ['-hide_banner', '-filters']);
    const hwaccels = await execa(FFMPEG_BIN, ['-hide_banner', '-hwaccels']);
    const methods = parseHwaccels(hwaccels.stdout);
    const hasVideotoolboxDecode = methods.includes('videotoolbox');
    const hasVideotoolbox = await canEncodeWith('h264_videotoolbox', ['-q:v', '50']);
    // Listing h264_nvenc proves nothing: builds carry it on machines with no
    // NVIDIA card, and the session only fails when it is opened. The frame must
    // clear NVENC's minimum (145x49 for H.264): a 64x64 probe fails with EINVAL
    // on a working card, which would read as "no NVENC" everywhere.
    const hasNvenc = hasVideotoolbox
      ? false
      : await canEncodeWith(
          'h264_nvenc',
          ['-preset', 'p1', '-rc', 'vbr', '-cq', '30', '-b:v', '0'],
          NVENC_PROBE_SIZE,
        );
    const hasCudaDecode = hasNvenc && methods.includes('cuda');
    await execa(FFPROBE_BIN, ['-version']);
    const firstLine = version.stdout.split('\n')[0] ?? 'ffmpeg';
    const hasSubtitlesFilter = /\bsubtitles\b/.test(filters.stdout);
    if (!hasSubtitlesFilter) {
      return err(
        'ffmpeg-missing-capability',
        `seu ffmpeg (${firstLine}) não tem o filtro "subtitles" (libass) — legendas queimadas não funcionam. ${installHint()}`,
      );
    }
    return ok({
      version: firstLine,
      hasSubtitlesFilter,
      hasVideotoolboxDecode,
      hasVideotoolbox,
      hasCudaDecode,
      hasNvenc,
    });
  } catch (cause) {
    return err(
      'ffmpeg-missing-capability',
      `ffmpeg/ffprobe não encontrados no PATH. ${installHint()}`,
      cause,
    );
  }
}

let capabilitiesOnce: Promise<Result<FfmpegCapabilities>> | undefined;

/**
 * `checkFfmpeg` spawns four processes; the answer does not change while the
 * server runs, so callers on request paths share one probe per process.
 */
export function ffmpegCapabilities(): Promise<Result<FfmpegCapabilities>> {
  capabilitiesOnce ??= checkFfmpeg().then((result) => {
    // Not finding the binaries (the error carries the spawn failure as its
    // cause) may be transient — a PATH fixed while the app runs — so it is
    // probed again next time. A binary that lacks libass will keep lacking it
    // until a restart, so that answer sticks like a success does.
    if (!result.ok && result.error.cause !== undefined) capabilitiesOnce = undefined;
    return result;
  });
  return capabilitiesOnce;
}

export interface FfmpegRunOptions {
  readonly cwd: string;
  readonly onProgress?: (line: string) => void;
  readonly timeoutMs?: number;
}

export interface FfmpegRunOutput {
  readonly stderr: string;
}

export async function runFfmpeg(
  args: readonly string[],
  options: FfmpegRunOptions,
): Promise<Result<FfmpegRunOutput>> {
  try {
    const subprocess = execa(FFMPEG_BIN, ['-hide_banner', ...args], {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 30 * 60 * 1000,
      buffer: true,
      stderr: 'pipe',
    });
    if (options.onProgress) {
      subprocess.stderr.on('data', (chunk: Buffer) => {
        options.onProgress?.(chunk.toString());
      });
    }
    const { stderr } = await subprocess;
    return ok({ stderr });
  } catch (cause) {
    const stderr =
      cause instanceof ExecaError && typeof cause.stderr === 'string' ? cause.stderr : '';
    return err(
      'ffmpeg-failed',
      `ffmpeg failed (${args.slice(0, 6).join(' ')}…): ${stderr.split('\n').slice(-8).join('\n')}`,
      cause,
    );
  }
}

interface FfprobeStream {
  codec_name?: string;
  codec_type?: string;
  duration?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  width?: number;
  height?: number;
  disposition?: { attached_pic?: number };
}

export const MAX_STILL_IMAGE_DIMENSION = 16_384;
export const MAX_STILL_IMAGE_PIXELS = 100_000_000;
const STILL_IMAGE_CODECS = new Set(['mjpeg', 'png', 'webp']);

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: FfprobeStream[];
}

function parseFrameRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [num, den] = rate.split('/').map(Number);
  if (!num || !den || Number.isNaN(num) || Number.isNaN(den)) return null;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 100) / 100 : null;
}

async function readMediaProbe(absolutePath: string): Promise<FfprobeOutput> {
  const { stdout } = await execa(FFPROBE_BIN, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    absolutePath,
  ]);
  return JSON.parse(stdout) as FfprobeOutput;
}

function primaryVideoStream(probe: FfprobeOutput): FfprobeStream | undefined {
  // MP3/M4A cover art is exposed by ffprobe as a video stream. It is metadata,
  // not a playable video source, and must not reclassify a song as footage.
  return probe.streams?.find(
    (stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1,
  );
}

function probeDurationSeconds(probe: FfprobeOutput): number | null {
  const candidates = [
    Number(probe.format?.duration ?? 'NaN'),
    ...(probe.streams ?? []).map((stream) => Number(stream.duration ?? 'NaN')),
  ].filter((duration) => Number.isFinite(duration) && duration > 0);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function videoMediaProbe(
  probe: FfprobeOutput,
  video: FfprobeStream,
  durationS: number,
): VideoMediaProbe {
  const nominal = parseFrameRate(video.r_frame_rate);
  const average = parseFrameRate(video.avg_frame_rate);
  const fps = nominal !== null && nominal >= 1 && nominal <= 120 ? nominal : (average ?? 25);
  return {
    kind: 'video',
    durationS,
    fps,
    width: video.width ?? 0,
    height: video.height ?? 0,
    hasAudio: probe.streams?.some((stream) => stream.codec_type === 'audio') ?? false,
  };
}

export async function probeMedia(absolutePath: string): Promise<Result<VideoMediaProbe>> {
  try {
    const probe = await readMediaProbe(absolutePath);
    const video = primaryVideoStream(probe);
    const durationS = probeDurationSeconds(probe);
    if (!video || durationS === null) {
      return err('ffmpeg-failed', `ffprobe could not read "${absolutePath}" as a video`);
    }
    return ok(videoMediaProbe(probe, video, durationS));
  } catch (cause) {
    return err('ffmpeg-failed', `ffprobe failed for "${absolutePath}"`, cause);
  }
}

/**
 * Validates one still image without requiring a duration. Extension checks
 * happen at the importer boundary; codec, geometry and decoded-pixel limits
 * are enforced here from ffprobe's actual stream metadata.
 */
export async function probeStillImage(absolutePath: string): Promise<Result<ImageMediaProbe>> {
  try {
    const probe = await readMediaProbe(absolutePath);
    const image = primaryVideoStream(probe);
    const streams = probe.streams ?? [];
    const width = image?.width ?? 0;
    const height = image?.height ?? 0;
    const hasAudio = streams.some((stream) => stream.codec_type === 'audio');
    if (
      !image ||
      streams.length !== 1 ||
      !STILL_IMAGE_CODECS.has(image.codec_name ?? '') ||
      hasAudio ||
      probeDurationSeconds(probe) !== null ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width > MAX_STILL_IMAGE_DIMENSION ||
      height > MAX_STILL_IMAGE_DIMENSION ||
      width * height > MAX_STILL_IMAGE_PIXELS
    ) {
      return err('ffmpeg-failed', `ffprobe could not read "${absolutePath}" as a safe still image`);
    }
    return ok({ kind: 'image', width, height, hasAudio: false });
  } catch (cause) {
    return err('ffmpeg-failed', `ffprobe failed for "${absolutePath}"`, cause);
  }
}

/** Accepts either a video container or an audio-only file from the media bin. */
export async function probeProjectAsset(absolutePath: string): Promise<Result<TimedMediaProbe>> {
  try {
    const probe = await readMediaProbe(absolutePath);
    const video = primaryVideoStream(probe);
    const hasAudio = probe.streams?.some((stream) => stream.codec_type === 'audio') ?? false;
    const durationS = probeDurationSeconds(probe);
    if (durationS === null || (!video && !hasAudio)) {
      return err('ffmpeg-failed', `ffprobe could not read "${absolutePath}" as media`);
    }
    if (!video) {
      return ok({
        kind: 'audio',
        durationS,
        hasAudio: true,
      });
    }
    return ok(videoMediaProbe(probe, video, durationS));
  } catch (cause) {
    return err('ffmpeg-failed', `ffprobe failed for "${absolutePath}"`, cause);
  }
}

/** Reads container duration for audio-only artifacts (probeMedia deliberately requires video). */
export async function probeDuration(absolutePath: string): Promise<Result<number>> {
  try {
    const { stdout } = await execa(FFPROBE_BIN, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      absolutePath,
    ]);
    const durationS = Number(stdout.trim());
    return Number.isFinite(durationS) && durationS >= 0
      ? ok(durationS)
      : err('ffmpeg-failed', `ffprobe returned no duration for "${absolutePath}"`);
  } catch (cause) {
    return err('ffmpeg-failed', `ffprobe failed for "${absolutePath}"`, cause);
  }
}
