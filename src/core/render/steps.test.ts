import { describe, expect, it } from 'vitest';
import { decodeArgs, encodeArgs, extractClipStep } from './steps.js';

describe('encodeArgs', () => {
  it.each([
    [
      'libx264 preview',
      { preview: true, videoEncoder: 'libx264', subtitles: true, loudnorm: true },
      ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p'],
    ],
    [
      'libx264 final',
      { preview: false, videoEncoder: 'libx264', subtitles: true, loudnorm: true },
      ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p'],
    ],
    [
      'h264_videotoolbox preview',
      { preview: true, videoEncoder: 'h264_videotoolbox', subtitles: true, loudnorm: true },
      ['-c:v', 'h264_videotoolbox', '-q:v', '50', '-pix_fmt', 'yuv420p'],
    ],
    [
      'h264_videotoolbox final',
      { preview: false, videoEncoder: 'h264_videotoolbox', subtitles: true, loudnorm: true },
      ['-c:v', 'h264_videotoolbox', '-q:v', '70', '-pix_fmt', 'yuv420p'],
    ],
    [
      'libx264 final at high quality',
      { preview: false, videoEncoder: 'libx264', quality: 'high', subtitles: true, loudnorm: true },
      ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p'],
    ],
    [
      'h264_videotoolbox final at max quality',
      {
        preview: false,
        videoEncoder: 'h264_videotoolbox',
        quality: 'max',
        subtitles: true,
        loudnorm: true,
      },
      ['-c:v', 'h264_videotoolbox', '-q:v', '86', '-pix_fmt', 'yuv420p'],
    ],
    [
      'libx264 final at max quality',
      { preview: false, videoEncoder: 'libx264', quality: 'max', subtitles: true, loudnorm: true },
      ['-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-pix_fmt', 'yuv420p'],
    ],
    [
      'h264_videotoolbox final at high quality',
      {
        preview: false,
        videoEncoder: 'h264_videotoolbox',
        quality: 'high',
        subtitles: true,
        loudnorm: true,
      },
      ['-c:v', 'h264_videotoolbox', '-q:v', '78', '-pix_fmt', 'yuv420p'],
    ],
    [
      'a preview ignores the quality knob',
      { preview: true, videoEncoder: 'libx264', quality: 'max', subtitles: true, loudnorm: true },
      ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p'],
    ],
    [
      'videoEncoder omitted, defaulting to libx264',
      { preview: false, subtitles: true, loudnorm: true },
      ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p'],
    ],
    [
      'h264_nvenc preview',
      { preview: true, videoEncoder: 'h264_nvenc', subtitles: true, loudnorm: true },
      [
        '-c:v',
        'h264_nvenc',
        '-preset',
        'p1',
        '-rc',
        'vbr',
        '-cq',
        '30',
        '-b:v',
        '0',
        '-pix_fmt',
        'yuv420p',
      ],
    ],
    [
      'h264_nvenc final',
      { preview: false, videoEncoder: 'h264_nvenc', subtitles: true, loudnorm: true },
      [
        '-c:v',
        'h264_nvenc',
        '-preset',
        'p5',
        '-rc',
        'vbr',
        '-cq',
        '21',
        '-b:v',
        '0',
        '-pix_fmt',
        'yuv420p',
      ],
    ],
    [
      'h264_nvenc final at max quality',
      {
        preview: false,
        videoEncoder: 'h264_nvenc',
        quality: 'max',
        subtitles: true,
        loudnorm: true,
      },
      [
        '-c:v',
        'h264_nvenc',
        '-preset',
        'p5',
        '-rc',
        'vbr',
        '-cq',
        '17',
        '-b:v',
        '0',
        '-pix_fmt',
        'yuv420p',
      ],
    ],
  ] as const)('returns the exact args for %s', (_label, options, expected) => {
    expect(encodeArgs(options)).toEqual(expected);
  });
});

describe('decodeArgs', () => {
  it('asks for the hardware decoder only when the option names one', () => {
    expect(decodeArgs({})).toEqual([]);
    expect(decodeArgs({ hwaccel: 'videotoolbox' })).toEqual(['-hwaccel', 'videotoolbox']);
    expect(decodeArgs({ hwaccel: 'cuda' })).toEqual(['-hwaccel', 'cuda']);
  });
});

describe('extractClipStep decoding', () => {
  const input = {
    label: 'segment 1',
    outputPath: 'edit/cache/segments/a.mov',
    sourcePath: 'camera.mp4',
    inS: 1,
    outS: 3,
    fps: 25,
    videoFilter: 'scale=1080:1920',
    hasAudio: true,
    audioFadeS: 0.03,
  };

  it('puts -hwaccel before -ss and -i, so it applies to the source input', () => {
    const step = extractClipStep({
      ...input,
      options: { preview: false, subtitles: true, loudnorm: true, hwaccel: 'videotoolbox' },
    });
    expect(step.args.slice(0, 7)).toEqual([
      '-y',
      '-hwaccel',
      'videotoolbox',
      '-ss',
      '1.000',
      '-i',
      'camera.mp4',
    ]);
  });

  it('emits no decoder flag by default', () => {
    const step = extractClipStep({
      ...input,
      options: { preview: false, subtitles: true, loudnorm: true },
    });
    expect(step.args).not.toContain('-hwaccel');
    expect(step.args.slice(0, 5)).toEqual(['-y', '-ss', '1.000', '-i', 'camera.mp4']);
  });
});

describe('extractClipStep with a separate video source', () => {
  const input = {
    label: 'segment 1',
    outputPath: 'edit/cache/segments/a.mov',
    sourcePath: 'camera.mp4',
    inS: 1,
    outS: 3,
    fps: 25,
    videoFilter: 'scale=1080:1920',
    audioFadeS: 0.03,
    options: { preview: true, subtitles: true, loudnorm: true } as const,
  };

  it('reads video from the proxy and audio from the original, seeking both to the same time', () => {
    const step = extractClipStep({
      ...input,
      hasAudio: true,
      videoSourcePath: 'edit/cache/proxy/camera.mp4.proxy.mp4',
    });
    expect(step.args.slice(0, 9)).toEqual([
      '-y',
      '-ss',
      '1.000',
      '-i',
      'edit/cache/proxy/camera.mp4.proxy.mp4',
      '-ss',
      '1.000',
      '-i',
      'camera.mp4',
    ]);
    const mapIndex = step.args.indexOf('-map');
    expect(step.args.slice(mapIndex, mapIndex + 4)).toEqual(['-map', '0:v:0', '-map', '1:a:0']);
    expect(step.args).not.toContain('anullsrc=channel_layout=stereo:sample_rate=48000');
  });

  it('keeps the silence generator, not a second input, when the source has no audio', () => {
    const step = extractClipStep({
      ...input,
      hasAudio: false,
      videoSourcePath: 'edit/cache/proxy/camera.mp4.proxy.mp4',
    });
    expect(step.args.filter((arg) => arg === '-i')).toHaveLength(2);
    expect(step.args).toContain('anullsrc=channel_layout=stereo:sample_rate=48000');
    expect(step.args).not.toContain('camera.mp4');
  });

  it('is a plain single-input extraction when the video source is the original', () => {
    const step = extractClipStep({ ...input, hasAudio: true, videoSourcePath: 'camera.mp4' });
    expect(step.args.filter((arg) => arg === '-i')).toHaveLength(1);
    expect(step.args).not.toContain('-map');
  });
});
