import { execa } from 'execa';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EditDoc } from '../../core/schema.js';
import { ffmpegBinary } from './ffmpeg.js';
import { renderProject } from './render.js';

let projectDir = '';
const ffprobe = ffmpegBinary().replace(/ffmpeg(?=\.exe$|$)/u, 'ffprobe');

interface StreamTiming {
  readonly codec_type: string;
  readonly duration: string;
  readonly start_time: string;
  readonly nb_frames: string;
  readonly avg_frame_rate: string;
}

async function timings(path: string): Promise<readonly StreamTiming[]> {
  const result = await execa(ffprobe, [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,duration,start_time,nb_frames,avg_frame_rate',
    '-of',
    'json',
    path,
  ]);
  return (JSON.parse(result.stdout) as { streams: StreamTiming[] }).streams;
}

async function generateSource(filename: string, delayS = 0): Promise<void> {
  await execa(ffmpegBinary(), [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=duration=3:size=64x64:rate=25',
    '-itsoffset',
    String(delayS),
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=3:sample_rate=44100',
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    '-t',
    '3',
    join(projectDir, filename),
  ]);
}

function document(source: string, speed = 1, crossfadeMs = 0, mixedSpeed = false): EditDoc {
  return {
    version: 2,
    fps: 25,
    output: { width: 64, height: 64, loudnormLufs: -14, joinAudioCrossfadeMs: crossfadeMs },
    sources: { camera: { path: source } },
    tracks: [
      {
        id: 'base',
        kind: 'video',
        blocks: Array.from({ length: 20 }, (_, index) => {
          const blockSpeed = mixedSpeed && index % 3 === 2 ? 2 : speed;
          return { source: 'camera', in: 0, out: 0.12 * blockSpeed, speed: blockSpeed };
        }),
      },
    ],
    subtitles: { enabled: false, preset: 'pill' },
    totalDurationS: 2.4,
  };
}

beforeAll(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'leadzy-render-timing-'));
  await mkdir(join(projectDir, 'edit'));
  await generateSource('source.mp4');
  await generateSource('delayed.mp4', 0.5);
}, 20_000);

afterAll(async () => {
  if (projectDir !== '') await rm(projectDir, { recursive: true, force: true });
});

describe('render segment timing', () => {
  it.each([
    { speed: 1, crossfadeMs: 0, mixedSpeed: false },
    { speed: 2, crossfadeMs: 0, mixedSpeed: false },
    { speed: 1, crossfadeMs: 60, mixedSpeed: false },
    { speed: 1, crossfadeMs: 60, mixedSpeed: true },
  ])(
    'keeps twenty short AAC-source cuts on the frame grid (%j)',
    async ({ speed, crossfadeMs, mixedSpeed }) => {
      const result = await renderProject(
        projectDir,
        document('source.mp4', speed, crossfadeMs, mixedSpeed),
        {
          preview: false,
          subtitles: true,
          loudnorm: true,
          videoEncoder: 'libx264',
        },
      );
      expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
      if (!result.ok) return;
      const streams = await timings(result.value.outputAbs);
      const video = streams.find((stream) => stream.codec_type === 'video');
      const audio = streams.find((stream) => stream.codec_type === 'audio');
      expect(video).toBeDefined();
      expect(audio).toBeDefined();
      expect(Number(video?.duration)).toBeCloseTo(2.4, 3);
      expect(video?.nb_frames).toBe('60');
      expect(video?.avg_frame_rate).toBe('25/1');
      expect(Math.abs(Number(audio?.duration) - 2.4)).toBeLessThan(0.025);
      expect(Number(audio?.start_time)).toBeCloseTo(0, 3);
    },
    60_000,
  );

  it.each([
    { speed: 1, inS: 0, expectedStart: 0.5 },
    { speed: 2, inS: 0, expectedStart: 0.25 },
    { speed: 1, inS: 0.24, expectedStart: 0.26 },
  ])(
    'preserves source audio delay as silence with seek/speed (%j)',
    async ({ speed, inS, expectedStart }) => {
      const delayed: EditDoc = {
        ...document('delayed.mp4'),
        tracks: [
          {
            id: 'base',
            kind: 'video',
            blocks: [{ source: 'camera', in: inS, out: inS + speed, speed }],
          },
        ],
        totalDurationS: 1,
      };
      const result = await renderProject(projectDir, delayed, {
        preview: false,
        subtitles: true,
        loudnorm: false,
        videoEncoder: 'libx264',
      });
      expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
      if (!result.ok) return;
      const pcm = await execa(
        ffmpegBinary(),
        [
          '-v',
          'error',
          '-i',
          result.value.outputAbs,
          '-vn',
          '-af',
          'aresample=48000:first_pts=0',
          '-ar',
          '48000',
          '-ac',
          '1',
          '-f',
          'f32le',
          'pipe:1',
        ],
        { encoding: 'buffer' },
      );
      const audio = Buffer.from(pcm.stdout);
      const rms = (startS: number, endS: number): number => {
        let sum = 0;
        let count = 0;
        for (let index = Math.round(startS * 48000); index < Math.round(endS * 48000); index += 1) {
          const sample = audio.readFloatLE(index * 4);
          sum += sample * sample;
          count += 1;
        }
        return Math.sqrt(sum / count);
      };
      expect(rms(expectedStart * 0.2, expectedStart * 0.8)).toBeLessThan(0.001);
      expect(rms(expectedStart + 0.1, expectedStart + 0.3)).toBeGreaterThan(0.02);
      const streams = await timings(result.value.outputAbs);
      expect(Number(streams.find((stream) => stream.codec_type === 'video')?.duration)).toBeCloseTo(
        1,
        3,
      );
      expect(
        Number(streams.find((stream) => stream.codec_type === 'audio')?.start_time),
      ).toBeCloseTo(0, 3);
    },
    20_000,
  );
});
