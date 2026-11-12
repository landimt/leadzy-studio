import { describe, expect, it } from 'vitest';
import { planAudioPreview } from './audioPreviewPlan.js';
import type { MediaProbe } from './render/plan.js';
import type { EditDoc } from './schema.js';

const probe = (durationS = 20, hasAudio = true): Extract<MediaProbe, { kind: 'video' }> => ({
  kind: 'video',
  durationS,
  fps: 30,
  width: 1080,
  height: 1920,
  hasAudio,
});

const doc: EditDoc = {
  version: 2,
  fps: 30,
  output: {
    width: 1080,
    height: 1920,
    loudnormLufs: -14,
    denoise: 0.5,
    joinAudioFadeMs: 20,
    joinAudioCrossfadeMs: 80,
    speed: 1.25,
  },
  sources: {
    camera: { path: 'camera.mp4' },
    broll: { path: 'broll.mp4' },
  },
  tracks: [
    {
      id: 'base',
      kind: 'video',
      blocks: [
        { source: 'camera', in: 1, out: 4 },
        { source: 'camera', in: 6, out: 9 },
      ],
    },
    {
      id: 'layers',
      kind: 'video',
      blocks: [
        {
          source: 'broll',
          in: 2,
          out: 2.21,
          at: 1,
          mode: 'fullscreen',
          audio: 'duck',
        },
      ],
    },
  ],
  subtitles: { enabled: true, preset: '2p-caps' },
};

describe('planAudioPreview', () => {
  it('rejects an audio-only source used by a video row', () => {
    const result = planAudioPreview({
      doc,
      probes: new Map<string, MediaProbe>([
        ['camera', { kind: 'audio', durationS: 20, hasAudio: true }],
        ['broll', probe()],
      ]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain(
      'video track "base" source "camera" has no video stream',
    );
  });

  it('plans the audible export chain without any video encoding', () => {
    const result = planAudioPreview({
      doc,
      probes: new Map<string, MediaProbe>([
        ['camera', probe()],
        ['broll', probe()],
      ]),
      noiseFloorDb: -42,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const beforeMontage = result.value.steps.find(
      (step) => step.kind === 'ffmpeg' && step.output === result.value.beforeComposedPath,
    );
    const afterMontage = result.value.steps.find(
      (step) => step.kind === 'ffmpeg' && step.output === result.value.composedPath,
    );
    expect(beforeMontage?.kind).toBe('ffmpeg');
    expect(afterMontage?.kind).toBe('ffmpeg');
    if (beforeMontage?.kind !== 'ffmpeg' || afterMontage?.kind !== 'ffmpeg') return;
    const beforeGraph = beforeMontage.args[beforeMontage.args.indexOf('-filter_complex') + 1] ?? '';
    const afterGraph = afterMontage.args[afterMontage.args.indexOf('-filter_complex') + 1] ?? '';
    expect(beforeGraph).not.toContain('acrossfade=');
    expect(afterGraph).toContain('acrossfade=');
    for (const graph of [beforeGraph, afterGraph]) {
      expect(graph).toContain('volume=enable=');
      expect(graph).toContain('amix=inputs=2');
      expect(graph).toContain('atrim=duration=0.200000');
      expect(graph).toContain('atempo=1.250000');
    }
    expect(beforeMontage.args).toContain('-vn');
    expect(afterMontage.args).not.toContain('-c:v');

    const beforeEncode = result.value.steps.find(
      (step) => step.kind === 'ffmpeg' && step.output === result.value.beforeOutputPath,
    );
    expect(beforeEncode?.kind === 'ffmpeg' ? beforeEncode.args.join(' ') : '').not.toContain(
      'afftdn=',
    );
    expect(beforeEncode?.kind === 'ffmpeg' ? beforeEncode.args.join(' ') : '').not.toContain(
      'loudnorm=',
    );
    expect(beforeEncode?.kind === 'ffmpeg' ? beforeEncode.args.join(' ') : '').toContain(
      'aresample=48000,apad,atrim=end_sample=230400,asetpts=PTS-STARTPTS',
    );

    const measure = result.value.steps.find((step) => step.kind === 'loudnorm-measure');
    expect(measure?.kind === 'loudnorm-measure' ? measure.args.join(' ') : '').toContain(
      'afftdn=nf=-42.0:nr=15.0,loudnorm=',
    );
    const apply = result.value.steps.find((step) => step.kind === 'loudnorm-apply');
    expect(apply?.kind === 'loudnorm-apply' ? apply.argsTemplate.join(' ') : '').toContain(
      'linear=true -c:a pcm_f32le -ar 48000',
    );
    const afterEncode = result.value.steps.find(
      (step) => step.kind === 'ffmpeg' && step.output === result.value.outputPath,
    );
    expect(afterEncode?.kind === 'ffmpeg' ? afterEncode.args.join(' ') : '').toContain(
      'aresample=48000,apad,atrim=end_sample=230400,asetpts=PTS-STARTPTS',
    );
    expect(result.value.outputPath).toBe('edit/audio-preview.m4a');
    expect(result.value.beforeOutputPath).toBe('edit/audio-preview-before.m4a');
    expect(result.value.expectedDurationS).toBeCloseTo(4.8, 2);
  });

  it('keeps denoise active when normalization is disabled and synthesizes missing audio', () => {
    const silentDoc: EditDoc = {
      ...doc,
      output: { ...doc.output, loudnormLufs: null, joinAudioCrossfadeMs: 0 },
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [{ source: 'camera', in: 1, out: 2 }],
        },
      ],
    };
    const result = planAudioPreview({
      doc: silentDoc,
      probes: new Map([
        ['camera', probe(20, false)],
        ['broll', probe()],
      ]),
      noiseFloorDb: -50,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const montages = result.value.steps.filter(
      (step) =>
        step.kind === 'ffmpeg' &&
        (step.output === result.value.beforeComposedPath ||
          step.output === result.value.composedPath),
    );
    expect(montages).toHaveLength(2);
    expect(
      montages.every(
        (montage) => montage.kind === 'ffmpeg' && montage.args.join(' ').includes('anullsrc='),
      ),
    ).toBe(true);
    expect(result.value.steps.some((step) => step.kind === 'loudnorm-measure')).toBe(false);
    const beforeEncode = result.value.steps.find(
      (step) => step.kind === 'ffmpeg' && step.output === result.value.beforeOutputPath,
    );
    expect(beforeEncode?.kind === 'ffmpeg' ? beforeEncode.args.join(' ') : '').not.toContain(
      'afftdn=',
    );
    const treatment = result.value.steps.find(
      (step) => step.kind === 'ffmpeg' && step.args.join(' ').includes('afftdn='),
    );
    expect(treatment?.kind).toBe('ffmpeg');
    expect(treatment?.kind === 'ffmpeg' ? treatment.args.join(' ') : '').toContain(
      '-c:a pcm_f32le',
    );
    const apply = result.value.steps.at(-1);
    expect(apply?.kind === 'ffmpeg' ? apply.args.join(' ') : '').toContain(
      'aresample=48000,apad,atrim=end_sample=38400,asetpts=PTS-STARTPTS',
    );
  });

  it('quantizes extended crossfade handles to the same frame grid as the final render', () => {
    const offGrid: EditDoc = {
      ...doc,
      fps: 25,
      output: {
        ...doc.output,
        loudnormLufs: null,
        denoise: 0,
        speed: 1,
        joinAudioCrossfadeMs: 80,
      },
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'camera', in: 0, out: 1.01 },
            { source: 'camera', in: 2, out: 3.01 },
          ],
        },
      ],
    };
    const result = planAudioPreview({
      doc: offGrid,
      probes: new Map([
        ['camera', probe()],
        ['broll', probe()],
      ]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const montage = result.value.steps.find(
      (step) => step.kind === 'ffmpeg' && step.output === result.value.composedPath,
    );
    expect(montage?.kind).toBe('ffmpeg');
    if (montage?.kind !== 'ffmpeg') return;

    const inputDurations = montage.args.filter(
      (arg, index, args) => args[index - 1] === '-t' && !arg.startsWith('edit/'),
    );
    expect(inputDurations.slice(0, 2)).toEqual(['1.040000', '1.040000']);
  });

  it('includes an audio-only track in extraction, delay and mix for both audible projections', () => {
    const withAudioTrack: EditDoc = {
      ...doc,
      sources: {
        ...doc.sources,
        music: { path: 'music.m4a' },
      },
      tracks: [
        ...doc.tracks,
        {
          id: 'music',
          kind: 'audio',
          blocks: [
            {
              source: 'music',
              in: 3,
              out: 4,
              at: 2,
              gainDb: -4.5,
              fadeInS: 0.15,
              fadeOutS: 0.3,
            },
          ],
        },
      ],
    };
    const result = planAudioPreview({
      doc: withAudioTrack,
      probes: new Map<string, MediaProbe>([
        ['camera', probe()],
        ['broll', probe()],
        ['music', { kind: 'audio' as const, durationS: 30, hasAudio: true as const }],
      ]),
      noiseFloorDb: -42,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const montages = result.value.steps.filter(
      (step): step is Extract<(typeof result.value.steps)[number], { kind: 'ffmpeg' }> =>
        step.kind === 'ffmpeg' &&
        (step.output === result.value.beforeComposedPath ||
          step.output === result.value.composedPath),
    );
    expect(montages).toHaveLength(2);
    for (const montage of montages) {
      const sourceIndex = montage.args.indexOf('music.m4a');
      expect(montage.args.slice(sourceIndex - 5, sourceIndex + 1)).toEqual([
        '-ss',
        '3.000000',
        '-t',
        '1.000000',
        '-i',
        'music.m4a',
      ]);
      const graph = montage.args[montage.args.indexOf('-filter_complex') + 1] ?? '';
      expect(graph).toContain('[3:a]atrim=duration=1.000000');
      expect(graph).toContain('volume=-4.5dB');
      expect(graph).toContain('afade=t=in:st=0:d=0.150000');
      expect(graph).toContain('afade=t=out:st=0.700000:d=0.300000');
      expect(graph).toContain('adelay=2000:all=1');
      expect(graph).toContain('amix=inputs=3:duration=longest:normalize=0');
      expect(graph.indexOf('amix=inputs=3')).toBeLessThan(graph.indexOf('atempo=1.250000'));
    }

    const invalid = planAudioPreview({
      doc: withAudioTrack,
      probes: new Map([
        ['camera', probe()],
        ['broll', probe()],
        ['music', probe(30, false)],
      ]),
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.message).toContain('has no audio stream');

    const mutedDoc: EditDoc = {
      ...withAudioTrack,
      tracks: withAudioTrack.tracks.map((track) =>
        track.kind === 'audio' ? { ...track, muted: true } : track,
      ),
    };
    const muted = planAudioPreview({
      doc: mutedDoc,
      probes: new Map([
        ['camera', probe()],
        ['broll', probe()],
      ]),
    });
    expect(muted.ok).toBe(true);
    if (!muted.ok) return;
    const mutedMontages = muted.value.steps.filter(
      (step) =>
        step.kind === 'ffmpeg' &&
        (step.output === muted.value.beforeComposedPath ||
          step.output === muted.value.composedPath),
    );
    expect(mutedMontages).toHaveLength(2);
    for (const montage of mutedMontages) {
      if (montage.kind !== 'ffmpeg') continue;
      expect(montage.args).not.toContain('music.m4a');
      const graph = montage.args[montage.args.indexOf('-filter_complex') + 1] ?? '';
      expect(graph).not.toContain('[audio_0]');
      expect(graph).toContain('amix=inputs=2:duration=longest:normalize=0');
    }
  });
});
