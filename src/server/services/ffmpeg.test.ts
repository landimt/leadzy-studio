import { beforeEach, describe, expect, it, vi } from 'vitest';

type ExecaLike = (command: string, args: readonly string[]) => Promise<{ stdout: string }>;

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn<ExecaLike>() }));

vi.mock('execa', () => ({
  execa: execaMock,
  ExecaError: class ExecaError extends Error {},
}));

import {
  checkFfmpeg,
  fastVideoEncoder,
  ffmpegBinary,
  MAX_STILL_IMAGE_DIMENSION,
  MAX_STILL_IMAGE_PIXELS,
  parseHwaccels,
  probeStillImage,
  softwareDecodeForced,
  withRenderDefaults,
  type FfmpegCapabilities,
} from './ffmpeg.js';

function ffprobeResult(
  streams: readonly Record<string, unknown>[],
  format?: Record<string, unknown>,
): void {
  execaMock.mockResolvedValueOnce({ stdout: JSON.stringify({ streams, format }) });
}

beforeEach(() => {
  execaMock.mockReset();
});

describe('probeStillImage', () => {
  it.each(['png', 'mjpeg', 'webp'])(
    'accepts one safe %s image without duration metadata',
    async (codec) => {
      ffprobeResult([{ codec_name: codec, codec_type: 'video', width: 1600, height: 900 }]);

      await expect(probeStillImage('/project/upload')).resolves.toEqual({
        ok: true,
        value: { kind: 'image', width: 1600, height: 900, hasAudio: false },
      });
    },
  );

  it.each([
    ['unsupported codec', [{ codec_name: 'gif', codec_type: 'video', width: 100, height: 100 }]],
    [
      'audio stream',
      [
        { codec_name: 'png', codec_type: 'video', width: 100, height: 100 },
        { codec_name: 'aac', codec_type: 'audio' },
      ],
    ],
    [
      'multiple image streams',
      [
        { codec_name: 'png', codec_type: 'video', width: 100, height: 100 },
        { codec_name: 'png', codec_type: 'video', width: 10, height: 10 },
      ],
    ],
    ['zero width', [{ codec_name: 'png', codec_type: 'video', width: 0, height: 100 }]],
    [
      'oversized dimension',
      [
        {
          codec_name: 'png',
          codec_type: 'video',
          width: MAX_STILL_IMAGE_DIMENSION + 1,
          height: 1,
        },
      ],
    ],
    [
      'oversized pixel count',
      [
        {
          codec_name: 'png',
          codec_type: 'video',
          width: 10_001,
          height: Math.floor(MAX_STILL_IMAGE_PIXELS / 10_001) + 1,
        },
      ],
    ],
  ])('rejects an unsafe image: %s', async (_label, streams) => {
    ffprobeResult(streams);

    const result = await probeStillImage('/project/upload');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ffmpeg-failed');
  });

  it('rejects a timed container even when its video codec is image-compatible', async () => {
    ffprobeResult([{ codec_name: 'mjpeg', codec_type: 'video', width: 1600, height: 900 }], {
      duration: '2.5',
    });

    const result = await probeStillImage('/project/upload');
    expect(result.ok).toBe(false);
  });
});

const VERSION_STDOUT = 'ffmpeg version 6.1.1 Copyright (c) 2000-2023 the FFmpeg developers';
const FFPROBE_VERSION_STDOUT =
  'ffprobe version 6.1.1 Copyright (c) 2000-2023 the FFmpeg developers';
const FILTERS_WITH_SUBTITLES_STDOUT = [
  'Filters:',
  '  T.. subtitles          Render subtitles onto input video using the libass library.',
].join('\n');
const FILTERS_WITHOUT_SUBTITLES_STDOUT =
  'Filters:\n  T.. scale              Scale the input video size.';

const HWACCELS_STDOUT = 'Hardware acceleration methods:\nvideotoolbox\n';
const HWACCELS_CUDA_STDOUT = 'Hardware acceleration methods:\ncuda\nd3d11va\n';
const HWACCELS_NONE_STDOUT = 'Hardware acceleration methods:\n';

/**
 * Queues the `execa` responses `checkFfmpeg` awaits, in call order: version,
 * filters, hwaccels, the one-frame VideoToolbox encode probe, the NVENC probe
 * that only runs when VideoToolbox failed, and ffprobe version.
 */
function queueCheckFfmpegResponses(
  options: {
    videotoolbox?: boolean;
    nvenc?: boolean;
    subtitles?: boolean;
    hwDecode?: boolean | 'cuda';
  } = {},
): void {
  execaMock.mockResolvedValueOnce({ stdout: VERSION_STDOUT });
  execaMock.mockResolvedValueOnce({
    stdout:
      options.subtitles === false
        ? FILTERS_WITHOUT_SUBTITLES_STDOUT
        : FILTERS_WITH_SUBTITLES_STDOUT,
  });
  execaMock.mockResolvedValueOnce({
    stdout:
      options.hwDecode === false
        ? HWACCELS_NONE_STDOUT
        : options.hwDecode === 'cuda'
          ? HWACCELS_CUDA_STDOUT
          : HWACCELS_STDOUT,
  });
  if (options.videotoolbox === false) {
    execaMock.mockRejectedValueOnce(new Error('Error while opening encoder for output stream'));
    if (options.nvenc === true) execaMock.mockResolvedValueOnce({ stdout: '' });
    else execaMock.mockRejectedValueOnce(new Error('Cannot load nvcuda.dll'));
  } else {
    execaMock.mockResolvedValueOnce({ stdout: '' });
  }
  execaMock.mockResolvedValueOnce({ stdout: FFPROBE_VERSION_STDOUT });
}

describe('checkFfmpeg', () => {
  it('reports hasVideotoolbox true when a one-frame VideoToolbox encode succeeds', async () => {
    queueCheckFfmpegResponses();

    await expect(checkFfmpeg()).resolves.toEqual({
      ok: true,
      value: {
        version: VERSION_STDOUT,
        hasSubtitlesFilter: true,
        hasVideotoolboxDecode: true,
        hasVideotoolbox: true,
        hasCudaDecode: false,
        hasNvenc: false,
      },
    });
  });

  it('reports the NVIDIA pair on a machine whose ffmpeg lists cuda and opens NVENC', async () => {
    queueCheckFfmpegResponses({ hwDecode: 'cuda', videotoolbox: false, nvenc: true });

    await expect(checkFfmpeg()).resolves.toEqual({
      ok: true,
      value: {
        version: VERSION_STDOUT,
        hasSubtitlesFilter: true,
        hasVideotoolboxDecode: false,
        hasVideotoolbox: false,
        hasCudaDecode: true,
        hasNvenc: true,
      },
    });
  });

  it('trusts neither NVIDIA half when the build lists cuda but no NVIDIA session opens', async () => {
    // a distro ffmpeg on a machine without the card: listing cuda is not decoding with it
    queueCheckFfmpegResponses({ hwDecode: 'cuda', videotoolbox: false, nvenc: false });

    const result = await checkFfmpeg();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hasCudaDecode).toBe(false);
    expect(result.value.hasNvenc).toBe(false);
  });

  it('probes NVENC with a frame above its minimum size, so a working card is not missed', async () => {
    queueCheckFfmpegResponses({ hwDecode: 'cuda', videotoolbox: false, nvenc: true });

    await checkFfmpeg();

    const nvencProbe = execaMock.mock.calls
      .map((call) => call[1])
      .find((args) => args.includes('h264_nvenc'));
    // NVENC rejects frames below 145x49 with EINVAL, even on a working card
    expect(nvencProbe).toContain('color=black:size=256x256:rate=1');
  });

  it('does not spend a probe on NVENC once VideoToolbox has answered', async () => {
    queueCheckFfmpegResponses();

    const result = await checkFfmpeg();
    expect(result.ok).toBe(true);
    const probed = execaMock.mock.calls.map((call) => JSON.stringify(call[1]));
    expect(probed.filter((args) => args.includes('h264_nvenc'))).toHaveLength(0);
  });

  it('reports hasVideotoolboxDecode false when -hwaccels lists no videotoolbox', async () => {
    queueCheckFfmpegResponses({ hwDecode: false });
    const result = await checkFfmpeg();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hasVideotoolboxDecode).toBe(false);
    expect(execaMock.mock.calls[2]?.[1]).toEqual(['-hide_banner', '-hwaccels']);
  });

  it('reports hasVideotoolbox false — not an error — when the encode probe fails to open the encoder', async () => {
    queueCheckFfmpegResponses({ videotoolbox: false });

    await expect(checkFfmpeg()).resolves.toEqual({
      ok: true,
      value: {
        version: VERSION_STDOUT,
        hasSubtitlesFilter: true,
        hasVideotoolboxDecode: true,
        hasVideotoolbox: false,
        hasCudaDecode: false,
        hasNvenc: false,
      },
    });
  });

  it('returns ffmpeg-missing-capability with the spawn failure as cause when the binaries are absent', async () => {
    execaMock.mockRejectedValueOnce(new Error('spawn ffmpeg ENOENT'));

    const result = await checkFfmpeg();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('ffmpeg-missing-capability');
      expect(result.error.cause).toBeInstanceOf(Error);
    }
  });

  it('returns ffmpeg-missing-capability without a cause when the binary lacks libass', async () => {
    queueCheckFfmpegResponses({ subtitles: false });

    const result = await checkFfmpeg();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.cause).toBeUndefined();
  });

  it('probes version, filters, hwaccels, a VideoToolbox encode with the planner flags, then ffprobe, in that order', async () => {
    queueCheckFfmpegResponses();

    await checkFfmpeg();

    const calls = execaMock.mock.calls;
    expect(calls).toHaveLength(5);
    expect(calls.map((call) => call[1])).toEqual([
      ['-hide_banner', '-version'],
      ['-hide_banner', '-filters'],
      ['-hide_banner', '-hwaccels'],
      [
        '-hide_banner',
        '-f',
        'lavfi',
        '-i',
        'color=black:size=64x64:rate=1',
        '-frames:v',
        '1',
        '-c:v',
        'h264_videotoolbox',
        '-q:v',
        '50',
        '-pix_fmt',
        'yuv420p',
        '-f',
        'null',
        '-',
      ],
      ['-version'],
    ]);
    expect(calls[0]?.[0]).toBe(ffmpegBinary());
    expect(calls[1]?.[0]).toBe(ffmpegBinary());
    expect(calls[2]?.[0]).toBe(ffmpegBinary());
    expect(calls[3]?.[0]).toBe(ffmpegBinary());
    expect(calls[4]?.[0]).not.toBe(ffmpegBinary());
  });
});

describe('ffmpegCapabilities', () => {
  it('probes ffmpeg once and reuses the resolved capabilities for a later caller', async () => {
    // A fresh module instance so this test's memoized `capabilitiesOnce` cannot
    // have been primed by an earlier test that imported the module statically.
    vi.resetModules();
    const fresh = await import('./ffmpeg.js');
    queueCheckFfmpegResponses();

    const first = await fresh.ffmpegCapabilities();
    const second = await fresh.ffmpegCapabilities();

    expect(second).toBe(first);
    expect(execaMock).toHaveBeenCalledTimes(5);
  });

  it('keeps a libass-less answer memoized: the binary will not grow the filter without a restart', async () => {
    vi.resetModules();
    const fresh = await import('./ffmpeg.js');
    queueCheckFfmpegResponses({ subtitles: false });

    const first = await fresh.ffmpegCapabilities();
    const second = await fresh.ffmpegCapabilities();

    expect(first.ok).toBe(false);
    expect(second).toBe(first);
    expect(execaMock).toHaveBeenCalledTimes(5);
  });

  it('retries after a failed probe instead of memoizing the error', async () => {
    vi.resetModules();
    const fresh = await import('./ffmpeg.js');
    execaMock.mockRejectedValueOnce(new Error('spawn ffmpeg ENOENT'));

    const first = await fresh.ffmpegCapabilities();

    expect(first.ok).toBe(false);

    queueCheckFfmpegResponses();
    const second = await fresh.ffmpegCapabilities();

    expect(second).toEqual({
      ok: true,
      value: {
        version: VERSION_STDOUT,
        hasSubtitlesFilter: true,
        hasVideotoolboxDecode: true,
        hasVideotoolbox: true,
        hasCudaDecode: false,
        hasNvenc: false,
      },
    });
    expect(execaMock).toHaveBeenCalledTimes(1 + 5);
  });
});

describe('fastVideoEncoder', () => {
  const base: FfmpegCapabilities = {
    version: VERSION_STDOUT,
    hasSubtitlesFilter: true,
    hasVideotoolboxDecode: true,
    hasVideotoolbox: false,
    hasCudaDecode: false,
    hasNvenc: false,
  };

  it.each([
    ['h264_videotoolbox', true],
    ['libx264', false],
  ] as const)('returns %s when hasVideotoolbox is %s', (expected, hasVideotoolbox) => {
    expect(fastVideoEncoder({ ...base, hasVideotoolbox })).toBe(expected);
  });

  it('falls to NVENC where there is no VideoToolbox', () => {
    expect(fastVideoEncoder({ ...base, hasNvenc: true })).toBe('h264_nvenc');
  });

  it('keeps VideoToolbox ahead of NVENC when a machine somehow has both', () => {
    expect(fastVideoEncoder({ ...base, hasVideotoolbox: true, hasNvenc: true })).toBe(
      'h264_videotoolbox',
    );
  });

  it('stays on libx264 when neither hardware encoder opened', () => {
    expect(fastVideoEncoder(base)).toBe('libx264');
  });
});

describe('parseHwaccels', () => {
  it('drops the header and blank lines, keeps one method per line', () => {
    expect(parseHwaccels('Hardware acceleration methods:\nvideotoolbox\n\n')).toEqual([
      'videotoolbox',
    ]);
    expect(parseHwaccels('Hardware acceleration methods:\ncuda\nvaapi\n')).toEqual([
      'cuda',
      'vaapi',
    ]);
    expect(parseHwaccels('Hardware acceleration methods:\n')).toEqual([]);
  });
});

describe('softwareDecodeForced', () => {
  it('is on only for 1 or true, so "false"/"off" never disable the hardware decoder by accident', () => {
    expect(softwareDecodeForced({})).toBe(false);
    expect(softwareDecodeForced({ LEADZY_STUDIO_SOFTWARE_DECODE: '' })).toBe(false);
    expect(softwareDecodeForced({ LEADZY_STUDIO_SOFTWARE_DECODE: '0' })).toBe(false);
    expect(softwareDecodeForced({ LEADZY_STUDIO_SOFTWARE_DECODE: '1' })).toBe(true);
    expect(softwareDecodeForced({ LEADZY_STUDIO_SOFTWARE_DECODE: 'TRUE' })).toBe(true);
    expect(softwareDecodeForced({ LEADZY_STUDIO_SOFTWARE_DECODE: 'false' })).toBe(false);
    expect(softwareDecodeForced({ LEADZY_STUDIO_SOFTWARE_DECODE: 'off' })).toBe(false);
  });
});

describe('withRenderDefaults', () => {
  const capable: FfmpegCapabilities = {
    version: 'ffmpeg 7',
    hasSubtitlesFilter: true,
    hasVideotoolboxDecode: true,
    hasVideotoolbox: true,
    hasCudaDecode: false,
    hasNvenc: false,
  };
  const base = { preview: false, subtitles: true, loudnorm: true } as const;

  it('turns the hardware decoder on when ffmpeg has it and nothing forces software', () => {
    expect(withRenderDefaults(base, capable, {})).toEqual({
      ...base,
      videoEncoder: 'libx264',
      hwaccel: 'videotoolbox',
    });
  });

  it('asks for cuda on a machine that has the NVIDIA decoder and no videotoolbox', () => {
    expect(
      withRenderDefaults(
        base,
        { ...capable, hasVideotoolboxDecode: false, hasCudaDecode: true },
        {},
      ),
    ).toMatchObject({ hwaccel: 'cuda' });
  });

  it('honors LEADZY_STUDIO_SOFTWARE_DECODE for cuda too', () => {
    expect(
      withRenderDefaults(
        base,
        { ...capable, hasVideotoolboxDecode: false, hasCudaDecode: true },
        { LEADZY_STUDIO_SOFTWARE_DECODE: '1' },
      ),
    ).not.toHaveProperty('hwaccel');
  });

  it('leaves the decoder off without the capability, without capabilities, or when forced', () => {
    expect(
      withRenderDefaults(base, { ...capable, hasVideotoolboxDecode: false }, {}),
    ).not.toHaveProperty('hwaccel');
    expect(withRenderDefaults(base, null, {})).not.toHaveProperty('hwaccel');
    expect(
      withRenderDefaults(base, capable, { LEADZY_STUDIO_SOFTWARE_DECODE: '1' }),
    ).not.toHaveProperty('hwaccel');
  });

  it('gives previews the fast encoder and keeps an explicit choice', () => {
    expect(withRenderDefaults({ ...base, preview: true }, capable, {}).videoEncoder).toBe(
      'h264_videotoolbox',
    );
    expect(withRenderDefaults({ ...base, preview: true }, null, {}).videoEncoder).toBe('libx264');
    expect(
      withRenderDefaults({ ...base, preview: true, videoEncoder: 'libx264' }, capable, {})
        .videoEncoder,
    ).toBe('libx264');
    expect(withRenderDefaults({ ...base, hwaccel: 'videotoolbox' }, null, {}).hwaccel).toBe(
      'videotoolbox',
    );
  });
});
