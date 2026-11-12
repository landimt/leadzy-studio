import { describe, expect, it } from 'vitest';
import type { AudioBlock, BlockTransition, EditDoc } from '../schema.js';
import type { Transcript } from '../transcript.js';
import { outputDuration } from '../timeline.js';
import { resolveAudioBlockFades } from './audio.js';
import { visibleDoc, visibleRenderDoc } from './document.js';
import { NOISE_FLOOR_FALLBACK_DB, NOISE_FLOOR_MIN_DB, renderOutputPath } from './options.js';
import { planRender, type MediaProbe } from './plan.js';
import { type RenderPlan, type RenderStep } from './steps.js';

const camProbe: MediaProbe = {
  kind: 'video',
  durationS: 64.6,
  fps: 25,
  width: 3840,
  height: 2160,
  hasAudio: true,
};
const screenProbe: MediaProbe = {
  kind: 'video',
  durationS: 21,
  fps: 30,
  width: 1920,
  height: 1080,
  hasAudio: false,
};
const musicProbe: MediaProbe = {
  kind: 'audio',
  durationS: 30,
  hasAudio: true,
};

const FINGERPRINTS = new Map([
  ['cam', 'fp-cam-v1'],
  ['screen', 'fp-screen-v1'],
]);
const CAM_FINGERPRINT = new Map([['cam', 'fp-cam-v1']]);

const doc: EditDoc = {
  version: 2,
  fps: 25,
  output: { width: 1080, height: 1920, loudnormLufs: -14 },
  sources: {
    cam: { path: 'camera.mp4', durationS: 64.6 },
    screen: { path: 'screen.mov', durationS: 21 },
  },
  tracks: [
    {
      id: 'base',
      kind: 'video',
      blocks: [
        { source: 'cam', in: 1.51, out: 5.9 },
        { source: 'cam', in: 6.33, out: 10.84 },
      ],
    },
    {
      id: 'demo',
      kind: 'video',
      blocks: [
        {
          source: 'screen',
          in: 4,
          out: 6,
          at: 3,
          mode: 'pip',
          position: 'bottom-left',
          scale: 0.34,
          audio: 'duck',
        },
      ],
    },
    {
      id: 'overlays',
      kind: 'overlay',
      blocks: [{ file: 'edit/assets/cta.webm', at: 5, duration: 2 }],
    },
  ],
  subtitles: { enabled: true, preset: '2p-caps' },
  totalDurationS: 8.9,
};

const audioTrackDoc: EditDoc = {
  version: 2,
  fps: 25,
  output: { width: 1080, height: 1920, loudnormLufs: null, speed: 1.25 },
  sources: {
    cam: { path: 'camera.mp4', durationS: 64.6 },
    music: { path: 'music.m4a', durationS: 30 },
  },
  tracks: [
    {
      id: 'base',
      kind: 'video',
      blocks: [{ source: 'cam', in: 0, out: 4 }],
    },
    {
      id: 'layer',
      kind: 'video',
      blocks: [
        {
          source: 'cam',
          in: 10,
          out: 11,
          at: 0.5,
          mode: 'fullscreen',
          audio: 'duck',
        },
      ],
    },
    {
      id: 'music',
      kind: 'audio',
      blocks: [{ source: 'music', in: 2, out: 3, at: 1.25 }],
    },
  ],
  subtitles: { enabled: false, preset: '2p-caps' },
};

const AUDIO_TRACK_FINGERPRINTS = new Map([
  ['cam', 'fp-cam-v1'],
  ['music', 'fp-music-v1'],
]);

const transcript: Transcript = {
  engine: 'scribe',
  text: 'olá pessoal segundo trecho',
  words: [
    { text: 'olá', start: 1.6, end: 2, type: 'word' },
    { text: 'pessoal', start: 2.1, end: 2.5, type: 'word' },
    { text: 'segundo', start: 6.5, end: 6.9, type: 'word' },
    { text: 'trecho', start: 7, end: 7.4, type: 'word' },
  ],
};

function plan(overrides: Partial<Parameters<typeof planRender>[0]['options']> = {}) {
  const result = planRender({
    doc,
    transcripts: new Map([['cam', transcript]]),
    probes: new Map([
      ['cam', camProbe],
      ['screen', screenProbe],
    ]),
    sourceFingerprints: FINGERPRINTS,
    options: { preview: false, subtitles: true, loudnorm: true, ...overrides },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('plan failed');
  return result.value;
}

type FfmpegStep = Extract<RenderStep, { kind: 'ffmpeg' | 'ffmpeg-cacheable' }>;

function ffmpegSteps(steps: readonly RenderStep[]): FfmpegStep[] {
  return steps.filter((s): s is FfmpegStep => s.kind === 'ffmpeg' || s.kind === 'ffmpeg-cacheable');
}

function expectArgPair(args: readonly string[], option: string, value: string): void {
  // Input-specific codec hints (for example VP9 to preserve overlay alpha)
  // may use the same option earlier; the delivery contract is the final
  // output option immediately before the published path.
  const index = args.lastIndexOf(option);
  expect(index, `missing ${option} ${value}`).toBeGreaterThanOrEqual(0);
  expect(args[index + 1]).toBe(value);
}

function expectDeliveryAudio(args: readonly string[]): void {
  expectArgPair(args, '-c:a', 'aac');
  expectArgPair(args, '-b:a', '192k');
  expectArgPair(args, '-ar', '48000');
  expectArgPair(args, '-ac', '2');
}

function expectFaststart(args: readonly string[]): void {
  expectArgPair(args, '-movflags', '+faststart');
}

function expectNoUnconvertedBt709Tags(args: readonly string[]): void {
  expect(args.join(' ')).not.toMatch(/(?:bt709|-color_primaries|-color_trc|-colorspace)/i);
}

describe('planRender — preview video sources', () => {
  function planWithProxies(previewVideoSources: ReadonlyMap<string, string>) {
    const result = planRender({
      doc,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: true, subtitles: true, loudnorm: true },
      previewVideoSources,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('plan failed');
    return result.value;
  }

  it('reads segment video from the proxy and audio from the original when a proxy is listed', () => {
    const proxies = new Map([['cam', 'edit/cache/proxy/camera.mp4.proxy.mp4']]);
    const segments = ffmpegSteps(planWithProxies(proxies).steps).filter((s) =>
      s.label.startsWith('segment'),
    );
    expect(segments.length).toBeGreaterThan(0);
    for (const step of segments) {
      const inputs = step.args.filter((_, index) => step.args[index - 1] === '-i');
      expect(inputs[0]).toBe('edit/cache/proxy/camera.mp4.proxy.mp4');
      expect(inputs[1]).toBe(doc.sources.cam?.path);
      expect(step.args).toContain('0:v:0');
    }
  });

  it('leaves every source alone when no proxy is listed', () => {
    const segments = ffmpegSteps(planWithProxies(new Map()).steps).filter((s) =>
      s.label.startsWith('segment'),
    );
    for (const step of segments) {
      const inputs = step.args.filter((_, index) => step.args[index - 1] === '-i');
      expect(inputs).toEqual([doc.sources.cam?.path]);
    }
  });
});

describe('planRender — source decoding', () => {
  it('asks for the hardware decoder on every segment when the option names one', () => {
    const segments = ffmpegSteps(plan({ hwaccel: 'videotoolbox' }).steps).filter((s) =>
      s.label.startsWith('segment'),
    );
    expect(segments).toHaveLength(2);
    for (const step of segments) {
      const hwIndex = step.args.indexOf('-hwaccel');
      expect(hwIndex).toBeGreaterThanOrEqual(0);
      expect(step.args[hwIndex + 1]).toBe('videotoolbox');
      expect(hwIndex).toBeLessThan(step.args.indexOf('-ss'));
    }
  });

  it('decodes on the CPU by default', () => {
    const segments = ffmpegSteps(plan().steps).filter((s) => s.label.startsWith('segment'));
    for (const step of segments) expect(step.args).not.toContain('-hwaccel');
  });
});

describe('planRender — hard rules', () => {
  it('extracts segments with -ss BEFORE -i and 30ms fades on both edges', () => {
    const segments = ffmpegSteps(plan().steps).filter((s) => s.label.startsWith('segment'));
    expect(segments).toHaveLength(2);
    for (const step of segments) {
      const ssIndex = step.args.indexOf('-ss');
      const inputIndex = step.args.indexOf('-i');
      expect(ssIndex).toBeGreaterThanOrEqual(0);
      expect(ssIndex).toBeLessThan(inputIndex);
      const af = step.args[step.args.indexOf('-af') + 1] ?? '';
      expect(af).toContain('afade=t=in:st=0:d=0.03');
      expect(af).toContain('afade=t=out:st=');
    }
    const firstAf = segments[0]!.args[segments[0]!.args.indexOf('-af') + 1] ?? '';
    // segment 1 lasts 4.39s → quantized to 4.40 (110 frames) → fade-out at 4.37
    expect(firstAf).toContain('st=4.370');
  });

  it('defaults joinAudioFadeMs to 30ms and fades every base-segment joint exactly', () => {
    const segments = ffmpegSteps(plan().steps).filter((s) => s.label.startsWith('segment'));
    expect(segments).toHaveLength(2);
    for (const step of segments) {
      const duration = Number(step.args[step.args.indexOf('-t') + 1]);
      const af = step.args[step.args.indexOf('-af') + 1] ?? '';
      const expectedOutStart = (duration - 0.03).toFixed(3);
      expect(af).toBe(
        `aresample=48000:first_pts=0,afade=t=in:st=0:d=0.030,afade=t=out:st=${expectedOutStart}:d=0.030`,
      );
    }
  });

  it('honors a custom joinAudioFadeMs for base-segment joints', () => {
    const withFade: EditDoc = { ...doc, output: { ...doc.output, joinAudioFadeMs: 10 } };
    const result = planRender({
      doc: withFade,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: true, loudnorm: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const segments = ffmpegSteps(result.value.steps).filter((s) => s.label.startsWith('segment'));
    for (const step of segments) {
      const af = step.args[step.args.indexOf('-af') + 1] ?? '';
      expect(af).toContain('afade=t=in:st=0:d=0.010');
      expect(af).toContain('d=0.010');
    }
  });

  it('disables the base-segment join fade when joinAudioFadeMs is 0, but keeps layer-clip edge fades', () => {
    const noFade: EditDoc = { ...doc, output: { ...doc.output, joinAudioFadeMs: 0 } };
    const result = planRender({
      doc: noFade,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: true, loudnorm: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const segments = ffmpegSteps(result.value.steps).filter((s) => s.label.startsWith('segment'));
    expect(segments).toHaveLength(2);
    for (const step of segments) {
      expect(step.args[step.args.indexOf('-af') + 1]).toBe('aresample=48000:first_pts=0');
    }
    const layer = ffmpegSteps(result.value.steps).find((s) => s.label.startsWith('layer clip'));
    expect(layer!.args).toContain('-af');
    const layerAf = layer!.args[layer!.args.indexOf('-af') + 1] ?? '';
    expect(layerAf).toContain('afade=t=in:st=0:d=0.030');
  });

  it('clamps the join fade to half the segment when the segment is shorter than 2×fade', () => {
    const shortDoc: EditDoc = {
      version: 2,
      fps: 25,
      output: { width: 1080, height: 1920, loudnormLufs: -14, joinAudioFadeMs: 30 },
      sources: { cam: { path: 'camera.mp4', durationS: 64.6 } },
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            // 1 frame at 25fps = 0.04s — shorter than 2×30ms, so the 30ms
            // fade must clamp to half the segment (0.02s) on each edge.
            { source: 'cam', in: 0, out: 0.04 },
            { source: 'cam', in: 1, out: 3 },
          ],
        },
      ],
      subtitles: { enabled: false, preset: '2p-caps' },
    };
    const result = planRender({
      doc: shortDoc,
      transcripts: new Map(),
      probes: new Map([['cam', camProbe]]),
      sourceFingerprints: CAM_FINGERPRINT,
      options: { preview: false, subtitles: false, loudnorm: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const segments = ffmpegSteps(result.value.steps).filter((s) => s.label.startsWith('segment'));
    const shortSegment = segments[0]!;
    const af = shortSegment.args[shortSegment.args.indexOf('-af') + 1] ?? '';
    expect(af).toBe(
      'aresample=48000:first_pts=0,afade=t=in:st=0:d=0.020,afade=t=out:st=0.020:d=0.020',
    );
  });

  it('concats segments losslessly with -c copy', () => {
    const concat = ffmpegSteps(plan().steps).find((s) => s.label === 'concat base line');
    expect(concat).toBeDefined();
    expect(concat!.args.join(' ')).toContain('-f concat');
    expect(concat!.args.join(' ')).toContain('-c copy');
  });

  it('shifts layers with setpts=PTS-STARTPTS+at/TB and windows them with enable', () => {
    const compose = ffmpegSteps(plan().steps).find((s) => s.label === 'compose');
    const graph = compose!.args[compose!.args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).toContain('setpts=PTS-STARTPTS+3.000/TB');
    expect(graph).toContain("enable='between(t,3.000,5.000)'");
  });

  it('applies zoom effects BEFORE layers/overlays and after the locked cut', () => {
    const withZoom: EditDoc = {
      ...doc,
      tracks: [
        ...doc.tracks,
        {
          id: 'effects',
          kind: 'effect',
          blocks: [{ type: 'zoom', at: 1, duration: 2, scale: 1.2 }],
        },
      ],
    };
    const result = planRender({
      doc: withZoom,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: true, loudnorm: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const compose = ffmpegSteps(result.value.steps).find((s) => s.label === 'compose');
    const graph = compose!.args[compose!.args.indexOf('-filter_complex') + 1] ?? '';
    const zoomIndex = graph.indexOf('crop=');
    expect(zoomIndex).toBeGreaterThan(-1);
    expect(graph).toContain("enable='between(t,1.000,3.000)'");
    // zoom chain comes before the first layer overlay and before subtitles
    expect(zoomIndex).toBeLessThan(graph.indexOf('setpts='));
    expect(zoomIndex).toBeLessThan(graph.indexOf('subtitles='));
  });

  it('applies a flash effect as a bounded-duration white geq layer, windowed and timeshifted onto its `at`', () => {
    const withFlash: EditDoc = {
      ...doc,
      tracks: [
        ...doc.tracks,
        {
          id: 'effects',
          kind: 'effect',
          blocks: [{ type: 'flash', at: 1, duration: 0.25 }],
        },
      ],
    };
    const result = planRender({
      doc: withFlash,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: true, loudnorm: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const compose = ffmpegSteps(result.value.steps).find((s) => s.label === 'compose');
    const graph = compose!.args[compose!.args.indexOf('-filter_complex') + 1] ?? '';
    // bounded to the effect's own duration — NOT the output/timeline duration —
    // this is what keeps the per-pixel geq cost to the flash itself
    expect(graph).toContain('color=c=white:s=1080x1920:d=0.250:r=25');
    expect(graph).toContain('geq=');
    expect(graph).toContain('setpts=PTS+1.000/TB');
    expect(graph).toContain("enable='between(t,1.000,1.250)'");
    const flashIndex = graph.indexOf('color=c=white');
    expect(flashIndex).toBeGreaterThan(-1);
    // flash chain comes before the first layer overlay and before subtitles
    expect(flashIndex).toBeLessThan(graph.indexOf('setpts=PTS-STARTPTS'));
    expect(flashIndex).toBeLessThan(graph.indexOf('subtitles='));
  });

  it('applies a shake effect as a jittered crop, windowed over the locked cut', () => {
    const withShake: EditDoc = {
      ...doc,
      tracks: [
        ...doc.tracks,
        {
          id: 'effects',
          kind: 'effect',
          blocks: [{ type: 'shake', at: 1, duration: 0.5, intensity: 8 }],
        },
      ],
    };
    const result = planRender({
      doc: withShake,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: true, loudnorm: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const compose = ffmpegSteps(result.value.steps).find((s) => s.label === 'compose');
    const graph = compose!.args[compose!.args.indexOf('-filter_complex') + 1] ?? '';
    const cropIndex = graph.indexOf('crop=');
    expect(cropIndex).toBeGreaterThan(-1);
    expect(graph).toContain('sin((t-1.000)*37)');
    expect(graph).toContain('sin((t-1.000)*53');
    expect(graph).toContain('sin((t-1.000)*41)');
    expect(graph).toContain('sin((t-1.000)*59');
    expect(graph).toContain("enable='between(t,1.000,1.500)'");
    // shake chain comes before the first layer overlay and before subtitles
    expect(cropIndex).toBeLessThan(graph.indexOf('setpts=PTS-STARTPTS'));
    expect(cropIndex).toBeLessThan(graph.indexOf('subtitles='));
  });

  it('defaults shake intensity to 5 when the block omits it (schema-legal — intensity is optional)', () => {
    const withShake: EditDoc = {
      ...doc,
      tracks: [
        ...doc.tracks,
        { id: 'effects', kind: 'effect', blocks: [{ type: 'shake', at: 1, duration: 0.5 }] },
      ],
    };
    const result = planRender({
      doc: withShake,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: false, loudnorm: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const compose = ffmpegSteps(result.value.steps).find((s) => s.label === 'compose');
    const graph = compose!.args[compose!.args.indexOf('-filter_complex') + 1] ?? '';
    // intensity 5 -> zoomFactor 1.04 -> crop 1038x1846 for a 1080x1920 output
    expect(graph).toContain('crop=1038:1846');
  });

  it('chains multiple effects in track order, each compositing on top of the previous one', () => {
    const withThreeEffects: EditDoc = {
      ...doc,
      tracks: [
        ...doc.tracks,
        {
          id: 'effects',
          kind: 'effect',
          blocks: [
            { type: 'zoom', at: 0.5, duration: 0.5, scale: 1.1 },
            { type: 'flash', at: 1.2, duration: 0.2 },
            { type: 'shake', at: 2, duration: 0.5, intensity: 5 },
          ],
        },
      ],
    };
    const result = planRender({
      doc: withThreeEffects,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: false, loudnorm: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const compose = ffmpegSteps(result.value.steps).find((s) => s.label === 'compose');
    const graph = compose!.args[compose!.args.indexOf('-filter_complex') + 1] ?? '';
    // each stage reads the PREVIOUS stage's output label — [0:v] only feeds the first
    expect(graph).toContain('[0:v]split=2[ea0][eb0]');
    expect(graph).toContain('[v1][ef1]overlay=');
    expect(graph).toContain('[v2]split=2[sa2][sb2]');
  });

  it('places the subtitles filter LAST in the graph, after every overlay', () => {
    const compose = ffmpegSteps(plan().steps).find((s) => s.label === 'compose');
    const graph = compose!.args[compose!.args.indexOf('-filter_complex') + 1] ?? '';
    const subtitleIndex = graph.indexOf('subtitles=');
    expect(subtitleIndex).toBeGreaterThan(-1);
    expect(graph.lastIndexOf('overlay=')).toBeLessThan(subtitleIndex);
    // and nothing consumes the subtitle output — it is the mapped video
    const outLabel = graph.slice(graph.lastIndexOf('['));
    expect(compose!.args).toContain(outLabel);
  });

  it('uses the shared vector caption input for pills instead of libass', () => {
    const result = planRender({
      doc: { ...doc, subtitles: { ...doc.subtitles, preset: 'pill' } },
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: true, loudnorm: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const graphic = result.value.steps.find(
      (step): step is Extract<RenderStep, { kind: 'subtitle-graphics' }> =>
        step.kind === 'subtitle-graphics',
    );
    const compose = ffmpegSteps(result.value.steps).find((step) => step.label === 'compose');
    const graph = compose!.args[compose!.args.indexOf('-filter_complex') + 1] ?? '';

    expect(graphic).toMatchObject({ width: 1080, height: 1920, fps: 25 });
    expect(graphic?.manifestPath).toMatch(
      /^edit\/cache\/subtitles\/vector-[a-f0-9]{24}\/overlay\.ffconcat$/u,
    );
    expect(compose!.args).toContain(graphic?.manifestPath);
    expect(graph).not.toContain('subtitles=');
    expect(graph).toContain('format=rgba');
    expect(graph).toContain('overlay=eof_action=pass:repeatlast=0:shortest=0');
    expect(
      result.value.steps.some(
        (step) => step.kind === 'write-file' && step.path === 'edit/subtitles/master.srt',
      ),
    ).toBe(false);
  });

  it('reuses the authored caption layout for preview and final without reflowing it', () => {
    const planPill = (preview: boolean): RenderPlan => {
      const result = planRender({
        doc: { ...doc, subtitles: { ...doc.subtitles, preset: 'pill' } },
        transcripts: new Map([['cam', transcript]]),
        probes: new Map([
          ['cam', camProbe],
          ['screen', screenProbe],
        ]),
        sourceFingerprints: FINGERPRINTS,
        options: { preview, subtitles: true, loudnorm: false },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('pill plan failed');
      return result.value;
    };
    const preview = planPill(true);
    const final = planPill(false);
    const graphic = (value: RenderPlan) =>
      value.steps.find(
        (step): step is Extract<RenderStep, { kind: 'subtitle-graphics' }> =>
          step.kind === 'subtitle-graphics',
      );
    const previewGraphic = graphic(preview);
    const finalGraphic = graphic(final);
    const previewCompose = ffmpegSteps(preview.steps).find((step) => step.label === 'compose');
    const previewGraph =
      previewCompose!.args[previewCompose!.args.indexOf('-filter_complex') + 1] ?? '';

    expect(previewGraphic?.manifestPath).toBe(finalGraphic?.manifestPath);
    expect(previewGraphic).toMatchObject({ width: 1080, height: 1920 });
    expect(finalGraphic).toMatchObject({ width: 1080, height: 1920 });
    expect(previewGraph).toContain('scale=720:1280');
  });

  it('keeps explicit ASS styling on the legacy subtitle renderer', () => {
    const result = planRender({
      doc: {
        ...doc,
        subtitles: {
          ...doc.subtitles,
          preset: 'pill',
          forceStyle: 'FontName=Arial,FontSize=19,BorderStyle=3,Outline=4,MarginV=80',
        },
      },
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: true, loudnorm: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const compose = ffmpegSteps(result.value.steps).find((step) => step.label === 'compose');
    const graph = compose!.args[compose!.args.indexOf('-filter_complex') + 1] ?? '';
    expect(result.value.steps.some((step) => step.kind === 'subtitle-graphics')).toBe(false);
    expect(graph).toContain('subtitles=');
  });

  it('fails instead of silently publishing without subtitles when no cue can be generated', () => {
    const emptyTranscript: Transcript = { engine: 'scribe', text: '', words: [] };
    const result = planRender({
      doc,
      transcripts: new Map([['cam', emptyTranscript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: true, loudnorm: false },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-transcript');
    expect(result.error.message).toContain('no subtitle cues');
  });

  it('rejects partial subtitles when a later base source has no transcript', () => {
    const multiSourceDoc: EditDoc = {
      ...doc,
      sources: {
        cam: doc.sources.cam!,
        guest: { path: 'guest.mp4', durationS: 20 },
      },
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 1.51, out: 5.9 },
            { source: 'guest', in: 1, out: 4 },
          ],
        },
      ],
    };
    const result = planRender({
      doc: multiSourceDoc,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['guest', { ...camProbe, durationS: 20 }],
      ]),
      sourceFingerprints: new Map([
        ['cam', 'fp-cam-v1'],
        ['guest', 'fp-guest-v1'],
      ]),
      options: { preview: false, subtitles: true, loudnorm: false },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-transcript');
    expect(result.error.message).toContain('base source');
    expect(result.error.message).toContain('guest');
    expect(result.error.message).toContain('no transcript');
  });

  it('allows an intentionally silent later window when its base source transcript is loaded', () => {
    const uncoveredWindowDoc: EditDoc = {
      ...doc,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 1.51, out: 5.9 },
            { source: 'cam', in: 20, out: 22 },
          ],
        },
      ],
    };
    const result = planRender({
      doc: uncoveredWindowDoc,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([['cam', camProbe]]),
      sourceFingerprints: CAM_FINGERPRINT,
      options: { preview: false, subtitles: true, loudnorm: false },
    });

    expect(result.ok).toBe(true);
  });

  it('ducks base audio in the layer window and mixes without renormalizing', () => {
    const compose = ffmpegSteps(plan().steps).find((s) => s.label === 'compose');
    const graph = compose!.args[compose!.args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).toContain("volume=enable='between(t,3.000,5.000)':volume=0.25");
    expect(graph).toContain('adelay=3000|3000');
    expect(graph).toContain('normalize=0');
  });

  it('feeds webm overlays through libvpx-vp9 to keep alpha', () => {
    const compose = ffmpegSteps(plan().steps).find((s) => s.label === 'compose');
    const joined = compose!.args.join(' ');
    expect(joined).toContain('-c:v libvpx-vp9 -i edit/assets/cta.webm');
  });

  // The live player anchors {x,y} as fractions of the FULL frame and gives
  // corners a 3% margin PER AXIS (CSS resolves top/bottom % against height).
  // Anchoring on the leftover space instead shifted every dragged overlay
  // toward the top-left in the export, the larger the piece the further.
  it('places overlays exactly where the live player draws them', () => {
    const cornerCompose = ffmpegSteps(plan().steps).find((s) => s.label === 'compose');
    const cornerGraph = cornerCompose!.args[cornerCompose!.args.indexOf('-filter_complex') + 1];
    expect(cornerGraph).toContain('overlay=main_w*0.03:main_h-overlay_h-main_h*0.03');
    // Scale-less overlay: the player stretches it full-frame and ignores its
    // position — the plan must do the same.
    expect(cornerGraph).toContain('scale=1080:1920');
    expect(cornerGraph).toContain('overlay=0:0');

    const dragged: EditDoc = {
      ...doc,
      tracks: doc.tracks.map((track) =>
        track.kind === 'overlay'
          ? {
              ...track,
              blocks: track.blocks.map((block) => ({
                ...block,
                position: { x: 0.07, y: 0.02 },
                scale: 0.5,
              })),
            }
          : track,
      ),
    };
    const result = planRender({
      doc: dragged,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: true, loudnorm: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('plan failed');
    const compose = ffmpegSteps(result.value.steps).find((s) => s.label === 'compose');
    const graph = compose!.args[compose!.args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('overlay=main_w*0.07:main_h*0.02');
  });

  // Swapped PiP inverts the roles: the layer covers the frame while the
  // composed base shrinks into the PiP corner. Both overlays are gated on the
  // block window so the base passes through untouched outside it.
  it('shrinks the base into the corner under a fullscreen layer when the pip is swapped', () => {
    const swapped: EditDoc = {
      ...doc,
      tracks: doc.tracks.map((track) =>
        track.id === 'demo' && track.kind === 'video'
          ? {
              ...track,
              blocks: track.blocks.map((block) => ({ ...block, swapped: true })),
            }
          : track,
      ),
    };
    const result = planRender({
      doc: swapped,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: true, loudnorm: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('plan failed');
    const compose = ffmpegSteps(result.value.steps).find((s) => s.label === 'compose');
    const graph = compose!.args[compose!.args.indexOf('-filter_complex') + 1] ?? '';

    expect(graph).toContain('split=2[ls0a][ls0b]');
    expect(graph).toContain('[ls0b]scale=368:-2[ls0c]');
    expect(graph).toContain(
      '[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setpts=PTS-STARTPTS+3.000/TB[l0]',
    );
    const layerFull = graph.indexOf("[l0]overlay=0:0:enable='between(t,3.000,5.000)'");
    const basePip = graph.indexOf(
      "[ls0c]overlay=main_w*0.03:main_h-overlay_h-main_h*0.03:enable='between(t,3.000,5.000)'",
    );
    expect(layerFull).toBeGreaterThan(-1);
    expect(basePip).toBeGreaterThan(layerFull);
    expect(graph).not.toContain('[1:v]scale=368:-2');
  });

  // `library` is editor metadata for re-baking the piece, exactly like `title`:
  // the planner composites the file it points at and nothing else.
  it('plans an overlay carrying library metadata identically', () => {
    const withLibrary: EditDoc = {
      ...doc,
      tracks: doc.tracks.map((track) =>
        track.kind === 'overlay'
          ? {
              ...track,
              blocks: track.blocks.map((block) => ({
                ...block,
                library: { item: 'cta-verde-a1b2', variables: { HEADLINE: 'Compre agora' } },
              })),
            }
          : track,
      ),
    };
    const result = planRender({
      doc: withLibrary,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: true, loudnorm: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('plan failed');
    expect(result.value).toEqual(plan());
  });

  it('runs two-pass loudnorm with measured placeholders', () => {
    const steps = plan().steps;
    const measure = steps.find((s) => s.kind === 'loudnorm-measure');
    const apply = steps.find(
      (s): s is Extract<RenderStep, { kind: 'loudnorm-apply' }> => s.kind === 'loudnorm-apply',
    );
    expect(measure).toBeDefined();
    expect(apply).toBeDefined();
    const template = apply!.argsTemplate.join(' ');
    expect(template).toContain('I=-14:TP=-1:LRA=11');
    expect(template).toContain('{{MEASURED_I}}');
    expect(template).toContain('-c:v copy');
  });

  it('keeps output fps equal to the doc fps (never forces 24)', () => {
    const segments = ffmpegSteps(plan().steps).filter((s) => s.label.startsWith('segment'));
    const vf = segments[0]!.args[segments[0]!.args.indexOf('-vf') + 1] ?? '';
    expect(vf).toContain('fps=25');
  });

  it('generates silent audio for sources without an audio stream', () => {
    const layer = ffmpegSteps(plan().steps).find((s) => s.label.startsWith('layer clip'));
    expect(layer!.args.join(' ')).toContain('anullsrc');
  });

  it('preview halves the resolution and switches to ultrafast', () => {
    const preview = plan({ preview: true });
    expect(preview.outputPath).toBe('edit/preview.mp4');
    expect(preview.width).toBe(720);
    expect(preview.height).toBe(1280);
    const seg = ffmpegSteps(preview.steps).find((s) => s.label.startsWith('segment'));
    expect(seg!.args.join(' ')).toContain('ultrafast');
  });

  it('the options.loudnorm override still forces it off even though the doc has a numeric target', () => {
    const noNorm = plan({ loudnorm: false });
    expect(noNorm.steps.some((s) => s.kind === 'loudnorm-measure')).toBe(false);
    const compose = ffmpegSteps(noNorm.steps).find((s) => s.label === 'compose');
    expect(compose!.output).toBe('edit/final.mp4');
  });

  it('skips loudnorm when the doc has it off (loudnormLufs: null), even though options.loudnorm defaults true', () => {
    const off: EditDoc = { ...doc, output: { ...doc.output, loudnormLufs: null } };
    const result = planRender({
      doc: off,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: true, loudnorm: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.steps.some((s) => s.kind === 'loudnorm-measure')).toBe(false);
    expect(result.value.steps.some((s) => s.kind === 'loudnorm-apply')).toBe(false);
    const compose = ffmpegSteps(result.value.steps).find((s) => s.label === 'compose');
    expect(compose!.output).toBe('edit/final.mp4');
  });

  it('runs the loudnorm chain in preview too when the doc has a target — the whole point of moving the decision to the doc', () => {
    const preview = plan({ preview: true });
    expect(preview.steps.some((s) => s.kind === 'loudnorm-measure')).toBe(true);
    expect(preview.steps.some((s) => s.kind === 'loudnorm-apply')).toBe(true);
  });

  it('fails clearly when a source was never probed', () => {
    const result = planRender({
      doc,
      transcripts: new Map(),
      probes: new Map([['cam', camProbe]]),
      sourceFingerprints: CAM_FINGERPRINT,
      options: { preview: false, subtitles: false, loudnorm: false },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('screen');
  });
});

describe('planRender — published MP4 contract', () => {
  const bareDoc: EditDoc = {
    version: 2,
    fps: 25,
    output: { width: 1080, height: 1920, loudnormLufs: null },
    sources: { cam: { path: 'camera.mp4', durationS: 64.6 } },
    tracks: [
      {
        id: 'base',
        kind: 'video',
        blocks: [
          { source: 'cam', in: 1.51, out: 5.9 },
          { source: 'cam', in: 6.33, out: 10.84 },
        ],
      },
    ],
    subtitles: { enabled: false, preset: '2p-caps' },
  };

  function planBare(preview: boolean): RenderPlan {
    const result = planRender({
      doc: bareDoc,
      transcripts: new Map(),
      probes: new Map([['cam', camProbe]]),
      sourceFingerprints: CAM_FINGERPRINT,
      options: { preview, subtitles: false, loudnorm: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }

  function planDenoise(): RenderPlan {
    const denoiseDoc: EditDoc = {
      ...doc,
      output: { ...doc.output, loudnormLufs: null, denoise: 0.4 },
    };
    const result = planRender({
      doc: denoiseDoc,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: true, loudnorm: true },
      noiseFloorDb: -42,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }

  it.each([
    { preview: false, output: 'edit/final.mp4' },
    { preview: true, output: 'edit/preview.mp4' },
  ])(
    'direct compose publishes $output with the complete delivery profile',
    ({ preview, output }) => {
      const render = plan({ preview, loudnorm: false });
      const compose = ffmpegSteps(render.steps).find((step) => step.label === 'compose');
      expect(compose?.output).toBe(output);
      if (!compose) return;

      expectArgPair(compose.args, '-c:v', 'libx264');
      expectArgPair(compose.args, '-pix_fmt', 'yuv420p');
      expectDeliveryAudio(compose.args);
      expectFaststart(compose.args);
      expectNoUnconvertedBt709Tags(compose.args);
    },
  );

  it.each([
    { preview: false, output: 'edit/final.mp4' },
    { preview: true, output: 'edit/preview.mp4' },
  ])('direct remux publishes $output with AAC and faststart', ({ preview, output }) => {
    const render = planBare(preview);
    const remux = ffmpegSteps(render.steps).find((step) => step.label === 'remux');
    expect(remux?.output).toBe(output);
    if (!remux) return;

    expectArgPair(remux.args, '-c:v', 'copy');
    expectDeliveryAudio(remux.args);
    expectFaststart(remux.args);
    expectNoUnconvertedBt709Tags(remux.args);

    const segment = ffmpegSteps(render.steps).find((step) => step.label.startsWith('segment'));
    expectArgPair(segment?.args ?? [], '-c:v', 'libx264');
    expectArgPair(segment?.args ?? [], '-pix_fmt', 'yuv420p');
  });

  it('publishes the loudnorm apply pass with AAC and faststart, leaving composed.mov untouched', () => {
    const render = plan();
    const compose = ffmpegSteps(render.steps).find((step) => step.label === 'compose');
    const apply = render.steps.find(
      (step): step is Extract<RenderStep, { kind: 'loudnorm-apply' }> =>
        step.kind === 'loudnorm-apply',
    );
    expect(compose?.output).toBe('edit/cache/composed.mov');
    expect(compose?.args).not.toContain('-movflags');
    expectArgPair(compose?.args ?? [], '-c:v', 'libx264');
    expectArgPair(compose?.args ?? [], '-pix_fmt', 'yuv420p');
    expect(apply?.output).toBe('edit/final.mp4');
    if (!apply) return;

    expectArgPair(apply.argsTemplate, '-c:v', 'copy');
    expectDeliveryAudio(apply.argsTemplate);
    expectFaststart(apply.argsTemplate);
    expectNoUnconvertedBt709Tags(apply.argsTemplate);
  });

  it('publishes the denoise apply pass with AAC and faststart, leaving composed.mov untouched', () => {
    const render = planDenoise();
    const compose = ffmpegSteps(render.steps).find((step) => step.label === 'compose');
    const denoise = ffmpegSteps(render.steps).find((step) => step.label === 'apply denoise');
    expect(compose?.output).toBe('edit/cache/composed.mov');
    expect(compose?.args).not.toContain('-movflags');
    expect(denoise?.output).toBe('edit/final.mp4');
    if (!denoise) return;

    expectArgPair(denoise.args, '-c:v', 'copy');
    expectDeliveryAudio(denoise.args);
    expectFaststart(denoise.args);
    expectNoUnconvertedBt709Tags(denoise.args);
  });

  it('never attaches MP4 faststart flags to any intermediate .mov writer', () => {
    const renders = [plan(), planDenoise(), planBare(false)];
    const movSteps = renders
      .flatMap((render) => ffmpegSteps(render.steps))
      .filter((step) => step.output?.endsWith('.mov') === true);
    expect(movSteps.length).toBeGreaterThan(0);
    for (const step of movSteps) expect(step.args).not.toContain('-movflags');
  });
});

describe('planRender — block transitions', () => {
  const camOnly = {
    version: 2 as const,
    fps: 25,
    output: { width: 1080, height: 1920, loudnormLufs: -14 },
    sources: { cam: { path: 'camera.mp4', durationS: 64.6 } },
    subtitles: { enabled: false as const, preset: '2p-caps' as const },
  };

  function planTransitionDoc(transitionOnBlock1?: BlockTransition) {
    const withTransition: EditDoc = {
      ...camOnly,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 0, out: 4.4 },
            {
              source: 'cam',
              in: 10,
              out: 14.52,
              ...(transitionOnBlock1 ? { transition: transitionOnBlock1 } : {}),
            },
          ],
        },
      ],
    };
    const result = planRender({
      doc: withTransition,
      transcripts: new Map(),
      probes: new Map([['cam', camProbe]]),
      sourceFingerprints: CAM_FINGERPRINT,
      options: { preview: false, subtitles: false, loudnorm: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('plan failed');
    return ffmpegSteps(result.value.steps).filter((s) => s.label.startsWith('segment'));
  }

  it('bakes a fade-black dip into both sides of the emenda: fade-out on the previous tail, fade-in on the transitioned head', () => {
    const segments = planTransitionDoc({ type: 'fade-black', durationS: 0.3 });
    expect(segments).toHaveLength(2);
    const vf0 = segments[0]!.args[segments[0]!.args.indexOf('-vf') + 1] ?? '';
    const vf1 = segments[1]!.args[segments[1]!.args.indexOf('-vf') + 1] ?? '';
    // segment 0 is exactly 4.4s (already on the frame grid) → half-duration fade lands at 4.25
    expect(vf0).toContain('fade=t=out:st=4.250:d=0.150');
    expect(vf0).not.toContain('color=white');
    expect(vf1).toContain('fade=t=in:st=0.000:d=0.150');
    expect(vf1).not.toContain('color=white');
  });

  it('bakes a fade-white dip with :color=white on both sides', () => {
    const segments = planTransitionDoc({ type: 'fade-white', durationS: 0.3 });
    const vf0 = segments[0]!.args[segments[0]!.args.indexOf('-vf') + 1] ?? '';
    const vf1 = segments[1]!.args[segments[1]!.args.indexOf('-vf') + 1] ?? '';
    expect(vf0).toContain('fade=t=out:st=4.250:d=0.150:color=white');
    expect(vf1).toContain('fade=t=in:st=0.000:d=0.150:color=white');
  });

  it('clamps the transition fade to half of a segment shorter than the requested duration', () => {
    const withTransition: EditDoc = {
      ...camOnly,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 0, out: 0.2 }, // 0.2s segment — half is 0.1s
            { source: 'cam', in: 10, out: 14, transition: { type: 'fade-black', durationS: 1.0 } },
          ],
        },
      ],
    };
    const result = planRender({
      doc: withTransition,
      transcripts: new Map(),
      probes: new Map([['cam', camProbe]]),
      sourceFingerprints: CAM_FINGERPRINT,
      options: { preview: false, subtitles: false, loudnorm: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const segments = ffmpegSteps(result.value.steps).filter((s) => s.label.startsWith('segment'));
    const vf0 = segments[0]!.args[segments[0]!.args.indexOf('-vf') + 1] ?? '';
    // requested half-duration (0.5s) exceeds the segment's own half (0.1s) — clamp wins
    expect(vf0).toContain('fade=t=out:st=0.100:d=0.100');
  });

  it('omits the dip filter entirely for a segment that quantizes to zero duration (schema-legal but degenerate)', () => {
    const withTransition: EditDoc = {
      ...camOnly,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 0, out: 0.005 }, // rounds to 0 frames at 25fps
            { source: 'cam', in: 10, out: 14, transition: { type: 'fade-black', durationS: 0.3 } },
          ],
        },
      ],
    };
    const result = planRender({
      doc: withTransition,
      transcripts: new Map(),
      probes: new Map([['cam', camProbe]]),
      sourceFingerprints: CAM_FINGERPRINT,
      options: { preview: false, subtitles: false, loudnorm: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const segments = ffmpegSteps(result.value.steps).filter((s) => s.label.startsWith('segment'));
    const vf0 = segments[0]!.args[segments[0]!.args.indexOf('-vf') + 1] ?? '';
    expect(vf0).not.toContain('fade=');
  });

  it('ignores a transition declared on the first base block', () => {
    const withTransition: EditDoc = {
      ...camOnly,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 0, out: 4.4, transition: { type: 'fade-black', durationS: 0.3 } },
            { source: 'cam', in: 10, out: 14.52 },
          ],
        },
      ],
    };
    const result = planRender({
      doc: withTransition,
      transcripts: new Map(),
      probes: new Map([['cam', camProbe]]),
      sourceFingerprints: CAM_FINGERPRINT,
      options: { preview: false, subtitles: false, loudnorm: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const segments = ffmpegSteps(result.value.steps).filter((s) => s.label.startsWith('segment'));
    for (const step of segments) {
      const vf = step.args[step.args.indexOf('-vf') + 1] ?? '';
      expect(vf).not.toContain('fade=');
    }
  });

  it('leaves the extraction filter unchanged when no block declares a transition (zero regression)', () => {
    const segments = planTransitionDoc();
    for (const step of segments) {
      const vf = step.args[step.args.indexOf('-vf') + 1] ?? '';
      expect(vf).not.toContain('fade=');
    }
  });
});

describe('planRender — crossfade transitions', () => {
  const camOnly = {
    version: 2 as const,
    fps: 25,
    output: { width: 1080, height: 1920, loudnormLufs: -14 },
    sources: { cam: { path: 'camera.mp4', durationS: 64.6 } },
    subtitles: { enabled: false as const, preset: '2p-caps' as const },
  };

  function runPlan(doc: EditDoc) {
    const result = planRender({
      doc,
      transcripts: new Map(),
      probes: new Map([['cam', camProbe]]),
      sourceFingerprints: CAM_FINGERPRINT,
      options: { preview: false, subtitles: false, loudnorm: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('plan failed');
    return result.value;
  }

  function concatEntryCount(steps: readonly RenderStep[]): number {
    const list = steps.find(
      (s): s is Extract<RenderStep, { kind: 'write-file' }> => s.kind === 'write-file',
    );
    if (!list) throw new Error('no concat list step');
    return list.content.trim().split('\n').filter(Boolean).length;
  }

  it('merges a real crossfade into ONE re-encoded step, replacing both segments in the concat list', () => {
    const doc: EditDoc = {
      ...camOnly,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 0, out: 4.4 },
            {
              source: 'cam',
              in: 10,
              out: 14.52,
              transition: { type: 'crossfade', durationS: 0.3 },
            },
          ],
        },
      ],
    };
    const plan = runPlan(doc);
    const steps = ffmpegSteps(plan.steps);

    // both plain per-block extractions still run (their audio feeds the merge)
    expect(steps.filter((s) => s.label.startsWith('segment'))).toHaveLength(2);
    // both segments need extra source frames on the crossfading side
    const extended = steps.filter((s) => s.label.startsWith('crossfade extend'));
    expect(extended).toHaveLength(2);

    const merge = steps.find((s) => s.label.startsWith('crossfade join'));
    expect(merge).toBeDefined();
    expect(merge!.kind).toBe('ffmpeg-cacheable');
    // block 0 extends 0.15s past its own out (114 frames @25fps instead of 110),
    // block 1 extends 0.15s before its own in — xfade duration is their sum,
    // offset is where that blend starts inside the extended-block-0 stream.
    const joined = merge!.args.join(' ');
    expect(joined).toContain('xfade=transition=fade:duration=0.300:offset=4.260');
    expect(joined).toContain('concat=n=2:v=0:a=1');
    expect(joined).toContain('-t 8.920');
    expect(merge!.args.filter((a) => a === '-i')).toHaveLength(4);

    // total output duration is unaffected — the extension is fully consumed by the blend
    expect(plan.expectedDurationS).toBeCloseTo(8.92, 5);
    // 2 base blocks collapse into ONE concat entry
    expect(concatEntryCount(plan.steps)).toBe(1);
  });

  it('preserves the args = [...argsWithoutOutput, output] cache invariant on the merge step', () => {
    const doc: EditDoc = {
      ...camOnly,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 0, out: 4.4 },
            {
              source: 'cam',
              in: 10,
              out: 14.52,
              transition: { type: 'crossfade', durationS: 0.3 },
            },
          ],
        },
      ],
    };
    const plan = runPlan(doc);
    const merge = ffmpegSteps(plan.steps).find(
      (s): s is Extract<RenderStep, { kind: 'ffmpeg-cacheable' }> =>
        s.kind === 'ffmpeg-cacheable' && s.label.startsWith('crossfade join'),
    );
    expect(merge).toBeDefined();
    expect(merge!.args).toEqual([...merge!.argsWithoutOutput, merge!.output]);
  });

  it('chains three consecutive real crossfades into ONE merged run', () => {
    const doc: EditDoc = {
      ...camOnly,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 0, out: 4 },
            { source: 'cam', in: 5, out: 9, transition: { type: 'crossfade', durationS: 0.3 } },
            { source: 'cam', in: 10, out: 14, transition: { type: 'crossfade', durationS: 0.2 } },
          ],
        },
      ],
    };
    const plan = runPlan(doc);
    const steps = ffmpegSteps(plan.steps);
    const merges = steps.filter((s) => s.label.startsWith('crossfade join'));
    expect(merges).toHaveLength(1);
    expect(merges[0]!.label).toContain('segments 1-3/3');
    expect(concatEntryCount(plan.steps)).toBe(1);
    expect(plan.expectedDurationS).toBeCloseTo(12, 5);
  });

  it('degrades a crossfade with too little source material to EXACTLY the fade-black dip', () => {
    // block 0 ends flush with the source's own duration (no frames past `out`
    // to extend into); block 1 starts 0.05s into the source (barely enough
    // before `in`) — the clamped overlap (0.05s) is below the usable minimum.
    const makeDoc = (transition: BlockTransition): EditDoc => ({
      ...camOnly,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 60, out: 64.6 },
            { source: 'cam', in: 0.05, out: 4.5, transition },
          ],
        },
      ],
    });
    const runFor = (transition: BlockTransition) => ffmpegSteps(runPlan(makeDoc(transition)).steps);

    const degraded = runFor({ type: 'crossfade', durationS: 0.3 });
    const explicit = runFor({ type: 'fade-black', durationS: 0.3 });

    expect(degraded.some((s) => s.label.startsWith('crossfade'))).toBe(false);
    const degradedSegments = degraded.filter((s) => s.label.startsWith('segment'));
    const explicitSegments = explicit.filter((s) => s.label.startsWith('segment'));
    expect(degradedSegments).toHaveLength(2);
    degradedSegments.forEach((step, i) => {
      const vf = step.args[step.args.indexOf('-vf') + 1];
      expect(vf).toBe(explicitSegments[i]!.args[explicitSegments[i]!.args.indexOf('-vf') + 1]);
    });
  });

  it('keeps the adjacent fade-black dip when a crossfade extends the segment that also carries it: entry-crossfade, exit-dip', () => {
    // [0] --crossfade--> [1] --fade-black--> [2]. Block 1's head is extended
    // (crossfade toward block 0) while its tail is dipped (fade-out toward
    // block 2) — the extension must not swallow the dip.
    const doc: EditDoc = {
      ...camOnly,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 0, out: 4 },
            { source: 'cam', in: 5, out: 9, transition: { type: 'crossfade', durationS: 0.4 } },
            { source: 'cam', in: 10, out: 14, transition: { type: 'fade-black', durationS: 0.4 } },
          ],
        },
      ],
    };
    const plan = runPlan(doc);
    const steps = ffmpegSteps(plan.steps);
    const extendedSeg2 = steps.find((s) => s.label === 'crossfade extend segment 2/3');
    expect(extendedSeg2).toBeDefined();
    const vf = extendedSeg2!.args[extendedSeg2!.args.indexOf('-vf') + 1] ?? '';
    // segment 1 (index 1) is extended 0.2s before its own `in` (half of the
    // 0.4s crossfade) by the boundary with block 0, so its own fade-out dip
    // toward block 2 — originally at st=3.8 (segmentDuration 4.0 − fade 0.2) —
    // shifts right by that same 0.2s extension: st=4.0.
    expect(vf).toContain('fade=t=out:st=4.000:d=0.200');
    expect(vf).not.toContain('color=white');
  });

  it('keeps the adjacent fade-black dip when a crossfade extends the segment that also carries it: entry-dip, exit-crossfade', () => {
    // [0] --fade-black--> [1] --crossfade--> [2]. Block 1's head is dipped
    // (fade-in from block 0) while its tail is extended toward block 2 —
    // the extension must not swallow the dip.
    const doc: EditDoc = {
      ...camOnly,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 0, out: 4 },
            { source: 'cam', in: 5, out: 9, transition: { type: 'fade-black', durationS: 0.4 } },
            { source: 'cam', in: 10, out: 14, transition: { type: 'crossfade', durationS: 0.4 } },
          ],
        },
      ],
    };
    const plan = runPlan(doc);
    const steps = ffmpegSteps(plan.steps);
    const extendedSeg2 = steps.find((s) => s.label === 'crossfade extend segment 2/3');
    expect(extendedSeg2).toBeDefined();
    const vf = extendedSeg2!.args[extendedSeg2!.args.indexOf('-vf') + 1] ?? '';
    // segment 1 (index 1) is the run's start: nothing is extended before it
    // (extendBeforeS=0), so its own leading dip stays at st=0, unshifted.
    expect(vf).toContain('fade=t=in:st=0.000:d=0.200');
    expect(vf).not.toContain('color=white');
  });

  it('ignores a crossfade declared on the first base block, same as fade-black', () => {
    const doc: EditDoc = {
      ...camOnly,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 0, out: 4.4, transition: { type: 'crossfade', durationS: 0.3 } },
            { source: 'cam', in: 10, out: 14.52 },
          ],
        },
      ],
    };
    const plan = runPlan(doc);
    const steps = ffmpegSteps(plan.steps);
    expect(steps.some((s) => s.label.startsWith('crossfade'))).toBe(false);
    expect(concatEntryCount(plan.steps)).toBe(2);
  });
});

describe('planRender — content-addressed segment cache', () => {
  function segmentSteps(
    steps: readonly RenderStep[],
  ): Extract<RenderStep, { kind: 'ffmpeg-cacheable' }>[] {
    return steps.filter(
      (s): s is Extract<RenderStep, { kind: 'ffmpeg-cacheable' }> =>
        s.kind === 'ffmpeg-cacheable' && s.label.startsWith('segment'),
    );
  }

  function segmentNames(steps: readonly RenderStep[]): string[] {
    return segmentSteps(steps).map((s) => s.output);
  }

  it('names segments deterministically — replanning the same doc yields the same cache keys', () => {
    const first = segmentNames(plan().steps);
    const second = segmentNames(plan().steps);
    expect(first).toHaveLength(2);
    expect(second).toEqual(first);
  });

  it("changes only the touched segment's cache key when one block's `in` changes", () => {
    const baseline = segmentNames(plan().steps);
    const changedDoc: EditDoc = {
      ...doc,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 1.6, out: 5.9 },
            { source: 'cam', in: 6.33, out: 10.84 },
          ],
        },
        ...doc.tracks.slice(1),
      ],
    };
    const result = planRender({
      doc: changedDoc,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: true, loudnorm: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const changed = segmentNames(result.value.steps);
    expect(changed[0]).not.toBe(baseline[0]);
    expect(changed[1]).toBe(baseline[1]);
  });

  it("changes every segment's cache key when joinAudioFadeMs changes (a global setting)", () => {
    const baseline = segmentNames(plan().steps);
    const withFade: EditDoc = { ...doc, output: { ...doc.output, joinAudioFadeMs: 10 } };
    const result = planRender({
      doc: withFade,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: true, loudnorm: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const changed = segmentNames(result.value.steps);
    expect(changed).toHaveLength(baseline.length);
    changed.forEach((name, i) => {
      expect(name).not.toBe(baseline[i]);
    });
  });

  it("changes every segment's cache key when switching between preview and final", () => {
    const final = segmentNames(plan({ preview: false }).steps);
    const preview = segmentNames(plan({ preview: true }).steps);
    expect(preview).toHaveLength(final.length);
    preview.forEach((name, i) => {
      expect(name).not.toBe(final[i]);
    });
  });

  it("invalidates a segment's cache key when its source file changes (fingerprint differs)", () => {
    const baseline = segmentNames(plan().steps);
    const rehashed = new Map(FINGERPRINTS);
    rehashed.set('cam', 'fp-cam-v2');
    const result = planRender({
      doc,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: rehashed,
      options: { preview: false, subtitles: true, loudnorm: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // both base-track segments are cut from "cam" — both invalidate
    const changed = segmentNames(result.value.steps);
    changed.forEach((name, i) => {
      expect(name).not.toBe(baseline[i]);
    });
  });

  it('changes the cache key only for segments touching a newly-declared transition', () => {
    const baseBlocks = [
      { source: 'cam', in: 0, out: 4 },
      { source: 'cam', in: 5, out: 9 },
      { source: 'cam', in: 10, out: 14 },
    ];
    const threeBlockDoc: EditDoc = {
      version: 2,
      fps: 25,
      output: { width: 1080, height: 1920, loudnormLufs: -14 },
      sources: { cam: { path: 'camera.mp4', durationS: 64.6 } },
      tracks: [{ id: 'base', kind: 'video', blocks: baseBlocks }],
      subtitles: { enabled: false, preset: '2p-caps' },
    };
    const withTransition: EditDoc = {
      ...threeBlockDoc,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: baseBlocks.map((b, i) =>
            i === 2 ? { ...b, transition: { type: 'fade-black' as const, durationS: 0.3 } } : b,
          ),
        },
      ],
    };
    const plainResult = planRender({
      doc: threeBlockDoc,
      transcripts: new Map(),
      probes: new Map([['cam', camProbe]]),
      sourceFingerprints: CAM_FINGERPRINT,
      options: { preview: false, subtitles: false, loudnorm: false },
    });
    const transitionResult = planRender({
      doc: withTransition,
      transcripts: new Map(),
      probes: new Map([['cam', camProbe]]),
      sourceFingerprints: CAM_FINGERPRINT,
      options: { preview: false, subtitles: false, loudnorm: false },
    });
    expect(plainResult.ok).toBe(true);
    expect(transitionResult.ok).toBe(true);
    if (!plainResult.ok || !transitionResult.ok) return;
    const plainNames = segmentNames(plainResult.value.steps);
    const transitionNames = segmentNames(transitionResult.value.steps);
    expect(plainNames).toHaveLength(3);
    // block 0 (index 0) is untouched by a transition declared on block 2
    expect(transitionNames[0]).toBe(plainNames[0]);
    // block 1's tail gets the fade-out dip, block 2's head gets the fade-in dip
    expect(transitionNames[1]).not.toBe(plainNames[1]);
    expect(transitionNames[2]).not.toBe(plainNames[2]);
  });
});

describe('planRender — canvas background', () => {
  const backgroundProbe: MediaProbe = {
    kind: 'video',
    durationS: 2,
    fps: 30,
    width: 1920,
    height: 1080,
    hasAudio: true,
  };

  function renderCanvas(
    canvas: NonNullable<EditDoc['canvas']>,
    overrides: Partial<EditDoc> = {},
    optionOverrides: Partial<Parameters<typeof planRender>[0]['options']> = {},
  ): ReturnType<typeof planRender> {
    const canvasDoc: EditDoc = {
      ...doc,
      ...overrides,
      output: { ...doc.output, loudnormLufs: null, ...(overrides.output ?? {}) },
      sources: { ...doc.sources, ...(overrides.sources ?? {}) },
      tracks: overrides.tracks ?? doc.tracks,
      subtitles: { ...doc.subtitles, enabled: false },
      canvas,
    };
    return planRender({
      doc: canvasDoc,
      transcripts: new Map(),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
        ['background', backgroundProbe],
      ]),
      sourceFingerprints: new Map([...FINGERPRINTS, ['background', 'fp-background-v1']]),
      options: { preview: false, subtitles: false, loudnorm: true, ...optionOverrides },
      noiseFloorDb: -44,
    });
  }

  it('preserves the legacy plan byte-for-byte when canvas is absent', () => {
    const input = {
      doc,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: false, loudnorm: false },
    } as const;
    const absent = planRender(input);
    const explicitUndefined = planRender({ ...input, doc: { ...doc, canvas: undefined } });

    expect(absent).toEqual(explicitUndefined);
    expect(absent.ok).toBe(true);
    if (!absent.ok) return;
    expect(absent.value.steps.map((step) => ('label' in step ? step.label : ''))).not.toContain(
      'canvas',
    );
  });

  it('builds a solid output-sized canvas, effects the cell-sized base once, then adds layers', () => {
    const tracks: EditDoc['tracks'] = [
      doc.tracks[0]!,
      {
        id: 'effects',
        kind: 'effect',
        blocks: [{ type: 'flash', at: 1, duration: 0.2 }],
      },
      doc.tracks[1]!,
    ];
    const result = renderCanvas(
      {
        background: { kind: 'color', color: '#123456' },
        base: { mode: 'cell', cell: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 } },
      },
      { tracks },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const firstSegment = ffmpegSteps(result.value.steps).find(
      (step) => step.label === 'segment 1/2',
    );
    const firstSegmentVfIndex = firstSegment?.args.indexOf('-vf') ?? -1;
    const firstSegmentFilter = firstSegment?.args[firstSegmentVfIndex + 1] ?? '';
    expect(firstSegmentFilter).toContain(
      'scale=540:768:force_original_aspect_ratio=increase,crop=540:768',
    );
    const compose = ffmpegSteps(result.value.steps).find((step) => step.label === 'compose');
    const graph = compose?.args[compose.args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).toContain('color=c=0x123456:s=1080x1920:r=25:d=8.920[canvasbg]');
    expect(graph).toContain('[v1]setpts=PTS-STARTPTS[canvasbase]');
    expect(graph).not.toContain('scale=540:768:force_original_aspect_ratio=increase,crop=540:768');
    expect(graph).toContain('[canvasbg][canvasbase]overlay=108:384:shortest=1');
    expect(graph.indexOf('color=c=0x123456')).toBeGreaterThan(graph.indexOf('color=white'));
    expect(graph.indexOf('[canvasbg][canvasbase]overlay=')).toBeLessThan(
      graph.indexOf('[1:v]scale=368:-2'),
    );
  });

  it('reframes the original base directly to the presenter cell in preview and export without a second cover crop', () => {
    const base = doc.tracks[0];
    if (base?.kind !== 'video') throw new Error('fixture base track is not video');
    const tracks: EditDoc['tracks'] = [
      {
        ...base,
        blocks: base.blocks.map((block) => ({
          ...block,
          transform: { scale: 1.2, x: 0.1, y: 0.1 },
        })),
      },
    ];
    const canvas = {
      background: { kind: 'color' as const, color: '#171416' },
      base: { mode: 'cell' as const, cell: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 } },
    };

    const final = renderCanvas(canvas, { tracks });
    const preview = renderCanvas(canvas, { tracks }, { preview: true });
    expect(final.ok).toBe(true);
    expect(preview.ok).toBe(true);
    if (!final.ok || !preview.ok) return;

    const cases = [
      { plan: final.value, scaled: 'scale=648:922', width: 540, height: 768, at: '108:384' },
      {
        plan: preview.value,
        scaled: 'scale=432:614',
        width: 360,
        height: 512,
        at: '72:256',
      },
    ];
    for (const expected of cases) {
      const segment = ffmpegSteps(expected.plan.steps).find((step) => step.label === 'segment 1/2');
      const vfIndex = segment?.args.indexOf('-vf') ?? -1;
      const segmentFilter = segment?.args[vfIndex + 1] ?? '';
      expect(segmentFilter).toContain(expected.scaled);
      expect(segmentFilter).toContain(`'min(iw,${String(expected.width)})'`);
      expect(segmentFilter).toContain(`'min(ih,${String(expected.height)})'`);
      expect(segmentFilter.match(/crop=/g)).toHaveLength(1);

      const compose = ffmpegSteps(expected.plan.steps).find((step) => step.label === 'compose');
      const graph = compose?.args[compose.args.indexOf('-filter_complex') + 1] ?? '';
      expect(graph).toContain('[0:v]setpts=PTS-STARTPTS[canvasbase]');
      expect(graph).toContain(`[canvasbg][canvasbase]overlay=${expected.at}:shortest=1`);
      expect(graph).not.toContain(`crop=${String(expected.width)}:${String(expected.height)}`);
    }
  });

  it('pins an image input for the full montage and honors contain plus its matte color', () => {
    const result = renderCanvas({
      background: {
        kind: 'image',
        file: 'edit/assets/background.png',
        fit: 'contain',
        color: '#ABCDEF',
      },
      base: { mode: 'fill' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const compose = ffmpegSteps(result.value.steps).find((step) => step.label === 'compose');
    expect(compose).toBeDefined();
    if (!compose) return;
    const imageIndex = compose.args.indexOf('edit/assets/background.png');
    expect(compose.args.slice(imageIndex - 5, imageIndex + 1)).toEqual([
      '-loop',
      '1',
      '-t',
      '8.920',
      '-i',
      'edit/assets/background.png',
    ]);
    const graph = compose.args[compose.args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).toContain('color=c=0xABCDEF:s=1080x1920:r=25:d=8.920[canvasmatte]');
    expect(graph).toContain(
      '[1:v]scale=1080:1920:force_original_aspect_ratio=decrease,fps=25,setpts=PTS-STARTPTS[canvasmedia]',
    );
    expect(graph).toContain(
      '[canvasmatte][canvasmedia]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2:shortest=1[canvasbg]',
    );
    expect(graph.indexOf('[canvasmatte][canvasmedia]overlay=')).toBeLessThan(
      graph.indexOf('[canvasbg][canvasbase]overlay='),
    );
  });

  it('loops a video background, validates it as visual media and never maps its audio', () => {
    const result = renderCanvas(
      {
        background: { kind: 'video', source: 'background', fit: 'cover' },
        base: { mode: 'cell', cell: { x: 0, y: 0.5, w: 1, h: 0.5 } },
      },
      { sources: { background: { path: 'background.mp4', durationS: 2 } } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const compose = ffmpegSteps(result.value.steps).find((step) => step.label === 'compose');
    expect(compose).toBeDefined();
    if (!compose) return;
    const backgroundIndex = compose.args.indexOf('background.mp4');
    expect(compose.args.slice(backgroundIndex - 5, backgroundIndex + 1)).toEqual([
      '-stream_loop',
      '-1',
      '-t',
      '8.920',
      '-i',
      'background.mp4',
    ]);
    const graph = compose.args[compose.args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).toContain('color=c=0x000000:s=1080x1920:r=25:d=8.920[canvasmatte]');
    expect(graph).toContain(
      '[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=25,setpts=PTS-STARTPTS[canvasmedia]',
    );
    expect(graph).toContain(
      '[canvasmatte][canvasmedia]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2:shortest=1[canvasbg]',
    );
    expect(graph).not.toContain('[1:a]');
  });

  it('decodes a looping video background on the hardware decoder when asked', () => {
    const result = renderCanvas(
      {
        background: { kind: 'video', source: 'background', fit: 'cover' },
        base: { mode: 'cell', cell: { x: 0, y: 0.5, w: 1, h: 0.5 } },
      },
      { sources: { background: { path: 'background.mp4', durationS: 2 } } },
      { hwaccel: 'videotoolbox' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const compose = ffmpegSteps(result.value.steps).find((step) => step.label === 'compose');
    if (!compose) throw new Error('expected a compose step');
    const backgroundIndex = compose.args.indexOf('background.mp4');
    expect(compose.args.slice(backgroundIndex - 7, backgroundIndex - 5)).toEqual([
      '-hwaccel',
      'videotoolbox',
    ]);
  });

  it('clamps a tiny presenter cell to an even 2x2 base stream', () => {
    const result = renderCanvas(
      {
        background: { kind: 'color', color: '#171416' },
        base: { mode: 'cell', cell: { x: 0, y: 0, w: 0.05, h: 0.05 } },
      },
      { output: { width: 2, height: 2, loudnormLufs: null }, tracks: [doc.tracks[0]!] },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const segment = ffmpegSteps(result.value.steps).find((step) => step.label === 'segment 1/2');
    const vfIndex = segment?.args.indexOf('-vf') ?? -1;
    const segmentFilter = segment?.args[vfIndex + 1] ?? '';
    expect(segmentFilter).toContain('scale=2:2:force_original_aspect_ratio=increase,crop=2:2');
    expect(segmentFilter).not.toMatch(/(?:scale|crop)=0(?::|,)/);
    const compose = ffmpegSteps(result.value.steps).find((step) => step.label === 'compose');
    const graph = compose?.args[compose.args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).toContain('[canvasbg][canvasbase]overlay=0:0:shortest=1');
  });

  it('keeps a transformed tiny presenter stream at least 2x2', () => {
    const base = doc.tracks[0];
    if (base?.kind !== 'video') throw new Error('fixture base track is not video');
    const result = renderCanvas(
      {
        background: { kind: 'color', color: '#171416' },
        base: { mode: 'cell', cell: { x: 0, y: 0, w: 0.05, h: 0.05 } },
      },
      {
        output: { width: 2, height: 2, loudnormLufs: null },
        tracks: [
          {
            ...base,
            blocks: base.blocks.map((block) => ({
              ...block,
              transform: { scale: 0.2, x: 0, y: 0 },
            })),
          },
        ],
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const segment = ffmpegSteps(result.value.steps).find((step) => step.label === 'segment 1/2');
    const segmentFilter =
      segment === undefined ? '' : (segment.args[segment.args.indexOf('-vf') + 1] ?? '');
    expect(segmentFilter).toContain('scale=2:2:force_original_aspect_ratio=increase');
    expect(segmentFilter).not.toMatch(/(?:scale|crop)=0(?::|,)/);
  });

  it('rejects an audio-only source selected as a video background', () => {
    const canvasDoc: EditDoc = {
      ...doc,
      sources: { ...doc.sources, background: { path: 'music.m4a' } },
      canvas: {
        background: { kind: 'video', source: 'background', fit: 'cover' },
        base: { mode: 'fill' },
      },
    };
    const result = planRender({
      doc: canvasDoc,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map<string, MediaProbe>([
        ['cam', camProbe],
        ['screen', screenProbe],
        ['background', musicProbe],
      ]),
      sourceFingerprints: new Map([...FINGERPRINTS, ['background', 'fp-music']]),
      options: { preview: false, subtitles: true, loudnorm: false },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-edit-json');
    expect(result.error.message).toContain('has no video stream');
  });

  it('retains a video background only for visual rendering and keeps denoise after composition', () => {
    const canvasDoc: EditDoc = {
      ...doc,
      output: { ...doc.output, loudnormLufs: null, denoise: 0.4 },
      sources: { ...doc.sources, background: { path: 'background.mp4' } },
      canvas: {
        background: { kind: 'video', source: 'background', fit: 'cover' },
        base: { mode: 'cell', cell: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } },
      },
    };
    expect(Object.keys(visibleDoc(canvasDoc).sources).sort()).toEqual(['cam', 'screen']);
    expect(visibleDoc(canvasDoc).canvas).toBeUndefined();
    expect(Object.keys(visibleRenderDoc(canvasDoc).sources).sort()).toEqual([
      'background',
      'cam',
      'screen',
    ]);

    const result = renderCanvas(canvasDoc.canvas!, canvasDoc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const compose = ffmpegSteps(result.value.steps).find((step) => step.label === 'compose');
    const denoise = ffmpegSteps(result.value.steps).find((step) => step.label === 'apply denoise');
    expect(compose?.output).toBe('edit/cache/composed.mov');
    expect(denoise?.args[denoise.args.indexOf('-af') + 1]).toBe('afftdn=nf=-44.0:nr=13.2');
    expect(denoise?.args).toContain('-c:v');
    expect(denoise?.args).toContain('copy');
  });
});

describe('planRender — cell mode', () => {
  function withCellLayer(
    cell: { x: number; y: number; w: number; h: number },
    transform?: { scale: number; x: number; y: number },
  ): EditDoc {
    return {
      ...doc,
      tracks: [
        doc.tracks[0]!,
        {
          id: 'demo',
          kind: 'video',
          blocks: [
            {
              source: 'screen',
              in: 4,
              out: 6,
              at: 3,
              mode: 'cell',
              cell,
              audio: 'mute',
              ...(transform === undefined ? {} : { transform }),
            },
          ],
        },
        doc.tracks[2]!,
      ],
    };
  }

  function planCell(
    cell: { x: number; y: number; w: number; h: number },
    output: EditDoc['output'] = doc.output,
    transform?: { scale: number; x: number; y: number },
  ) {
    const result = planRender({
      doc: { ...withCellLayer(cell, transform), output },
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: false, loudnorm: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('plan failed');
    return result.value;
  }

  it("scales the layer to the cell window's own pixel size and offsets the overlay to (round(x*W), round(y*H))", () => {
    const plan = planCell({ x: 0.2, y: 0.3, w: 0.51, h: 0.29 });
    const compose = ffmpegSteps(plan.steps).find((s) => s.label === 'compose');
    const graph = compose!.args[compose!.args.indexOf('-filter_complex') + 1] ?? '';
    // 1080*0.51=550.8 -> /2=275.4 -> round 275 -> *2=550; 1920*0.29=556.8 -> /2=278.4 -> round 278 -> *2=556
    expect(graph).toContain('scale=550:556:force_original_aspect_ratio=increase,crop=550:556');
    // x=round(0.2*1080)=216, y=round(0.3*1920)=576
    expect(graph).toContain('overlay=216:576:');
  });

  it('rounds cell dimensions to even pixels (yuv420p requirement) off a fraction that would otherwise land odd', () => {
    const plan = planCell({ x: 0, y: 0, w: 0.101, h: 0.101 });
    const compose = ffmpegSteps(plan.steps).find((s) => s.label === 'compose');
    const graph = compose!.args[compose!.args.indexOf('-filter_complex') + 1] ?? '';
    // 1080*0.101=109.08 -> /2=54.54 -> round 55 -> *2=110; 1920*0.101=193.92 -> /2=96.96 -> round 97 -> *2=194
    expect(graph).toContain('scale=110:194:force_original_aspect_ratio=increase,crop=110:194');
    expect(graph).toContain('overlay=0:0:');
  });

  it('keeps a minimum even 2px layer cell for schema-valid tiny outputs', () => {
    const plan = planCell(
      { x: 0, y: 0, w: 0.05, h: 0.05 },
      { width: 2, height: 2, loudnormLufs: null },
    );
    const compose = ffmpegSteps(plan.steps).find((s) => s.label === 'compose');
    const graph = compose?.args[compose.args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).toContain('scale=2:2:force_original_aspect_ratio=increase,crop=2:2');
    expect(graph).not.toMatch(/(?:scale|crop)=0:0/);
  });

  it('keeps a transformed tiny layer cell at least 2x2', () => {
    const plan = planCell(
      { x: 0, y: 0, w: 0.05, h: 0.05 },
      { width: 2, height: 2, loudnormLufs: null },
      { scale: 0.2, x: 0, y: 0 },
    );
    const compose = ffmpegSteps(plan.steps).find((s) => s.label === 'compose');
    const graph =
      compose === undefined
        ? ''
        : (compose.args[compose.args.indexOf('-filter_complex') + 1] ?? '');
    expect(graph).toContain('scale=2:2:force_original_aspect_ratio=increase');
    expect(graph).not.toMatch(/(?:scale|crop)=0(?::|,)/);
  });

  it('clamps the overlay position so a cell meant to reach the right/bottom edge never spills past outputDims (independent x/width rounding can otherwise overflow by 1px)', () => {
    // x=0.41,w=0.59 -> x+w=1 (schema-legal, touches the right edge exactly in
    // fraction space) but width rounds to 638 while x rounds to 443 —
    // 443+638=1081 > 1080 without the clamp.
    const plan = planCell({ x: 0.41, y: 0, w: 0.59, h: 1 });
    const compose = ffmpegSteps(plan.steps).find((s) => s.label === 'compose');
    const graph = compose!.args[compose!.args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).toContain('scale=638:1920:force_original_aspect_ratio=increase,crop=638:1920');
    // clamped to 1080 - 638 = 442, not the naively-rounded 443
    expect(graph).toContain('overlay=442:0:');
  });
});

describe('planRender — split left/right', () => {
  function withSplitLayer(arrangement: 'left' | 'right', ratio = 0.4): EditDoc {
    return {
      ...doc,
      tracks: [
        doc.tracks[0]!,
        {
          id: 'demo',
          kind: 'video',
          blocks: [
            {
              source: 'screen',
              in: 4,
              out: 6,
              at: 3,
              mode: 'split',
              split: { ratio, arrangement },
              audio: 'mute',
            },
          ],
        },
        doc.tracks[2]!,
      ],
    };
  }

  function planSplit(arrangement: 'left' | 'right', ratio = 0.4) {
    const result = planRender({
      doc: withSplitLayer(arrangement, ratio),
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: false, loudnorm: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('plan failed');
    return result.value;
  }

  it('mirrors top/bottom: left puts the layer in the left ratio*W slice (full height), overlaid at x=0', () => {
    const plan = planSplit('left', 0.4);
    const compose = ffmpegSteps(plan.steps).find((s) => s.label === 'compose');
    const graph = compose!.args[compose!.args.indexOf('-filter_complex') + 1] ?? '';
    // 1080*0.4=432 (already even)
    expect(graph).toContain('scale=432:1920:force_original_aspect_ratio=increase,crop=432:1920');
    expect(graph).toContain('overlay=0:0:');
  });

  it('right puts the layer in the right ratio*W slice, overlaid at x = W - sliceWidth', () => {
    const plan = planSplit('right', 0.4);
    const compose = ffmpegSteps(plan.steps).find((s) => s.label === 'compose');
    const graph = compose!.args[compose!.args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).toContain('scale=432:1920:force_original_aspect_ratio=increase,crop=432:1920');
    // 1080 - 432 = 648
    expect(graph).toContain('overlay=648:0:');
  });
});

describe('visibleDoc', () => {
  it('drops tracks marked hidden, preserving order and the base track', () => {
    const withHidden: EditDoc = {
      ...doc,
      tracks: doc.tracks.map((track) => (track.id === 'demo' ? { ...track, hidden: true } : track)),
    };

    const result = visibleDoc(withHidden);

    expect(result.tracks.map((t) => t.id)).toEqual(['base', 'overlays']);
  });

  it('prunes sources down to only the ones a visible video track still references', () => {
    const withHiddenLayer: EditDoc = {
      ...doc,
      tracks: doc.tracks.map((track) => (track.id === 'demo' ? { ...track, hidden: true } : track)),
    };

    const result = visibleDoc(withHiddenLayer);

    expect(Object.keys(result.sources)).toEqual(['cam']);
  });

  it('keeps a source referenced by a still-visible video track', () => {
    const result = visibleDoc(doc);

    expect(Object.keys(result.sources).sort()).toEqual(['cam', 'screen']);
  });

  it('keeps a source referenced only by an audio track', () => {
    expect(Object.keys(visibleDoc(audioTrackDoc).sources).sort()).toEqual(['cam', 'music']);
  });

  it('drops a muted audio track and its otherwise-unused source before media resolution', () => {
    const muted = {
      ...audioTrackDoc,
      tracks: audioTrackDoc.tracks.map((track) =>
        track.kind === 'audio' ? { ...track, muted: true } : track,
      ),
    };

    const result = visibleDoc(muted);
    expect(result.tracks.some((track) => track.kind === 'audio')).toBe(false);
    expect(Object.keys(result.sources)).toEqual(['cam']);
  });

  it('does not prune sources based on overlay tracks — overlay blocks reference a file, never doc.sources', () => {
    const withHiddenOverlay: EditDoc = {
      ...doc,
      tracks: doc.tracks.map((track) =>
        track.id === 'overlays' ? { ...track, hidden: true } : track,
      ),
    };

    const result = visibleDoc(withHiddenOverlay);

    expect(Object.keys(result.sources).sort()).toEqual(['cam', 'screen']);
  });

  it('ignores a saved room-tone source while denoise is disabled', () => {
    const withDisabledSample: EditDoc = {
      ...doc,
      sources: { ...doc.sources, room: { path: 'missing-room-tone.mp4', durationS: 10 } },
      output: {
        ...doc.output,
        denoise: 0,
        denoiseSample: { source: 'room', start: 1, end: 2 },
      },
    };

    expect(Object.keys(visibleDoc(withDisabledSample).sources).sort()).toEqual(['cam', 'screen']);
  });

  it('keeps a non-visible room-tone source while denoise is active', () => {
    const withActiveSample: EditDoc = {
      ...doc,
      sources: { ...doc.sources, room: { path: 'room-tone.mp4', durationS: 10 } },
      output: {
        ...doc.output,
        denoise: 0.3,
        denoiseSample: { source: 'room', start: 1, end: 2 },
      },
    };

    expect(Object.keys(visibleDoc(withActiveSample).sources).sort()).toEqual([
      'cam',
      'room',
      'screen',
    ]);
  });

  it('is idempotent — filtering an already-filtered doc changes nothing', () => {
    const once = visibleDoc(doc);
    const twice = visibleDoc(once);

    expect(twice).toEqual(once);
  });
});

describe('planRender — hidden tracks', () => {
  function withHidden(...hiddenIds: string[]): EditDoc {
    return {
      ...doc,
      tracks: doc.tracks.map((track) =>
        hiddenIds.includes(track.id) ? { ...track, hidden: true } : track,
      ),
    };
  }

  function planHidden(...hiddenIds: string[]) {
    const result = planRender({
      doc: withHidden(...hiddenIds),
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: true, loudnorm: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('plan failed');
    return result.value;
  }

  it('drops a hidden layer track entirely: no clip extraction step, no trace of its source in the compose graph', () => {
    const hiddenPlan = planHidden('demo');
    expect(ffmpegSteps(hiddenPlan.steps).some((s) => s.label.startsWith('layer clip'))).toBe(false);
    const compose = ffmpegSteps(hiddenPlan.steps).find((s) => s.label === 'compose');
    expect(compose!.args.join(' ')).not.toContain('screen.mov');
  });

  it('drops a hidden overlay track: no -i input for its file in the compose step', () => {
    const hiddenPlan = planHidden('overlays');
    const compose = ffmpegSteps(hiddenPlan.steps).find((s) => s.label === 'compose');
    expect(compose!.args.join(' ')).not.toContain('cta.webm');
  });

  it('drops a hidden effect track from the filter graph', () => {
    const withEffect: EditDoc = {
      ...doc,
      tracks: [
        ...doc.tracks,
        {
          id: 'fx',
          kind: 'effect',
          hidden: true,
          blocks: [{ type: 'flash', at: 1, duration: 0.25 }],
        },
      ],
    };
    const result = planRender({
      doc: withEffect,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: false, loudnorm: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const compose = ffmpegSteps(result.value.steps).find((s) => s.label === 'compose');
    const graph = compose!.args[compose!.args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).not.toContain('color=c=white');
  });

  it('leaves base segment cache keys unchanged when a sibling layer/overlay track is hidden — base segments never read other tracks', () => {
    const baselineNames = ffmpegSteps(plan().steps)
      .filter(
        (s): s is Extract<RenderStep, { kind: 'ffmpeg-cacheable' }> =>
          s.kind === 'ffmpeg-cacheable' && s.label.startsWith('segment'),
      )
      .map((s) => s.output);
    const hiddenPlan = planHidden('demo', 'overlays');
    const hiddenNames = ffmpegSteps(hiddenPlan.steps)
      .filter(
        (s): s is Extract<RenderStep, { kind: 'ffmpeg-cacheable' }> =>
          s.kind === 'ffmpeg-cacheable' && s.label.startsWith('segment'),
      )
      .map((s) => s.output);
    expect(hiddenNames).toEqual(baselineNames);
  });
});

describe('planRender — muted tracks', () => {
  it('silences the base track via the anullsrc no-audio path and changes the segment cache key (unlike hidden, muted DOES touch the base extraction args)', () => {
    const baselineNames = ffmpegSteps(plan().steps)
      .filter(
        (s): s is Extract<RenderStep, { kind: 'ffmpeg-cacheable' }> =>
          s.kind === 'ffmpeg-cacheable' && s.label.startsWith('segment'),
      )
      .map((s) => s.output);
    const base = doc.tracks[0]!;
    if (base.kind !== 'video') throw new Error('expected a video base track');
    const mutedDoc: EditDoc = {
      ...doc,
      tracks: [{ ...base, muted: true }, ...doc.tracks.slice(1)],
    };
    const result = planRender({
      doc: mutedDoc,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: true, loudnorm: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const segments = ffmpegSteps(result.value.steps).filter(
      (s): s is Extract<RenderStep, { kind: 'ffmpeg-cacheable' }> =>
        s.kind === 'ffmpeg-cacheable' && s.label.startsWith('segment'),
    );
    expect(segments).toHaveLength(2);
    for (const step of segments) {
      expect(step.args.join(' ')).toContain('anullsrc');
      expect(step.args).toContain('0:v:0');
      expect(step.args).toContain('1:a:0');
    }
    segments.forEach((step, i) => {
      expect(step.output).not.toBe(baselineNames[i]);
    });
  });

  it("overrides a muted layer track's blocks to audio:'mute' regardless of the block's own field, dropping it from the audio mix", () => {
    const mutedLayerDoc: EditDoc = {
      ...doc,
      tracks: doc.tracks.map((track) =>
        track.kind === 'video' && track.id === 'demo' ? { ...track, muted: true } : track,
      ),
    };
    const result = planRender({
      doc: mutedLayerDoc,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: false, loudnorm: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const compose = ffmpegSteps(result.value.steps).find((s) => s.label === 'compose');
    const graph = compose!.args[compose!.args.indexOf('-filter_complex') + 1] ?? '';
    // block audio:'duck' would normally produce these — muted must suppress both
    expect(graph).not.toContain('adelay=3000|3000');
    expect(graph).not.toContain("volume=enable='between(t,3.000,5.000)'");
  });
});

describe('planRender — audio tracks', () => {
  function withAudioBlock(overrides: Partial<AudioBlock>): EditDoc {
    return {
      ...audioTrackDoc,
      tracks: audioTrackDoc.tracks.map((track) =>
        track.kind === 'audio'
          ? { ...track, blocks: track.blocks.map((block) => ({ ...block, ...overrides })) }
          : track,
      ),
    };
  }

  function planAudioTrack(inputDoc: EditDoc = audioTrackDoc): RenderPlan {
    const result = planRender({
      doc: inputDoc,
      transcripts: new Map(),
      probes: new Map<string, MediaProbe>([
        ['cam', camProbe],
        ['music', musicProbe],
      ]),
      sourceFingerprints: AUDIO_TRACK_FINGERPRINTS,
      options: { preview: false, subtitles: false, loudnorm: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }

  it('accepts an audio-only source, extracts its window, then delays and mixes before global speed', () => {
    const render = planAudioTrack();
    const compose = ffmpegSteps(render.steps).find((step) => step.label === 'compose');
    expect(compose).toBeDefined();
    if (!compose) return;

    const sourceIndex = compose.args.indexOf('music.m4a');
    expect(compose.args.slice(sourceIndex - 5, sourceIndex + 1)).toEqual([
      '-ss',
      '2.000',
      '-t',
      '1.000',
      '-i',
      'music.m4a',
    ]);
    const graph = compose.args[compose.args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).toContain('[2:a]atrim=duration=1.000');
    expect(graph).toContain('afade=t=in:st=0:d=0.030');
    expect(graph).toContain('adelay=1250|1250');
    expect(graph).toContain("volume=enable='between(t,0.500,1.500)':volume=0.25");
    expect(graph).toContain('amix=inputs=3:normalize=0');
    expect(graph).not.toContain('[2:v]');
    expect(graph.indexOf('amix=inputs=3')).toBeLessThan(graph.indexOf('atempo=1.250'));
  });

  it('rejects an audio block that quantizes to zero frames before planning ffmpeg inputs', () => {
    const result = planRender({
      doc: withAudioBlock({ in: 2, out: 2.01 }),
      transcripts: new Map(),
      probes: new Map<string, MediaProbe>([
        ['cam', camProbe],
        ['music', musicProbe],
      ]),
      sourceFingerprints: AUDIO_TRACK_FINGERPRINTS,
      options: { preview: false, subtitles: false, loudnorm: false },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-edit-json');
    expect(result.error.message).toContain('quantizes to zero frames at 25 fps');
  });

  it('rejects an audio-only probe when the same source is used by a video track', () => {
    const result = planRender({
      doc: audioTrackDoc,
      transcripts: new Map(),
      probes: new Map([
        ['cam', { ...musicProbe, durationS: camProbe.durationS }],
        ['music', musicProbe],
      ]),
      sourceFingerprints: AUDIO_TRACK_FINGERPRINTS,
      options: { preview: false, subtitles: false, loudnorm: false },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('video track "base" source "cam" has no video stream');
  });

  it('omits every input and filter for a muted audio track', () => {
    const muted: EditDoc = {
      ...audioTrackDoc,
      tracks: audioTrackDoc.tracks.map((track) =>
        track.kind === 'audio' ? { ...track, muted: true } : track,
      ),
    };
    const render = planAudioTrack(muted);
    const allArgs = ffmpegSteps(render.steps).flatMap((step) => step.args);
    expect(allArgs).not.toContain('music.m4a');
    const compose = ffmpegSteps(render.steps).find((step) => step.label === 'compose');
    const graph = compose?.args[compose.args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).not.toContain('adelay=1250|1250');
    expect(graph).not.toContain('[aa0]');
    expect(graph).toContain('amix=inputs=2:normalize=0');
  });

  it('applies gain and user ramps once, using them instead of duplicate edge de-click fades', () => {
    const render = planAudioTrack(withAudioBlock({ gainDb: -6, fadeInS: 0.2, fadeOutS: 0.35 }));
    const compose = ffmpegSteps(render.steps).find((step) => step.label === 'compose');
    const graph = compose?.args[compose.args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).toContain('volume=-6dB');
    expect(graph).toContain('afade=t=in:st=0:d=0.200');
    expect(graph).toContain('afade=t=out:st=0.650:d=0.350');
    expect(graph.match(/\[2:a\][^;]+afade=t=in/g)).toHaveLength(1);
    expect(graph.match(/\[2:a\][^;]+afade=t=out/g)).toHaveLength(1);
  });

  it('rejects an unmuted audio block whose probed source has no audio stream', () => {
    const result = planRender({
      doc: audioTrackDoc,
      transcripts: new Map(),
      probes: new Map([
        ['cam', camProbe],
        ['music', { ...camProbe, durationS: 30, hasAudio: false }],
      ]),
      sourceFingerprints: AUDIO_TRACK_FINGERPRINTS,
      options: { preview: false, subtitles: false, loudnorm: false },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-edit-json');
    expect(result.error.message).toContain('has no audio stream');
  });

  it('keeps requested ramps primary when the de-click minimum would make them overlap', () => {
    const fades = resolveAudioBlockFades(1, 0.99, 0);
    expect(fades.fadeInS).toBeCloseTo(0.99, 6);
    expect(fades.fadeOutS).toBeCloseTo(0.01, 6);
  });
});

describe('planRender — denoise (afftdn before loudnorm)', () => {
  function planWithDenoise(
    denoise: number | undefined,
    opts: {
      loudnorm?: boolean;
      noiseFloorDb?: number;
      noiseProfileBands?: readonly number[];
      lufs?: number | null;
    } = {},
  ) {
    const denoiseDoc: EditDoc = {
      ...doc,
      output: {
        ...doc.output,
        ...(denoise !== undefined ? { denoise } : {}),
        ...(opts.lufs !== undefined ? { loudnormLufs: opts.lufs } : {}),
      },
    };
    const result = planRender({
      doc: denoiseDoc,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: false, subtitles: false, loudnorm: opts.loudnorm ?? true },
      ...(opts.noiseFloorDb !== undefined ? { noiseFloorDb: opts.noiseFloorDb } : {}),
      ...(opts.noiseProfileBands !== undefined
        ? { noiseProfileBands: opts.noiseProfileBands }
        : {}),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('plan failed');
    return result.value;
  }

  function loudnormAf(plan: ReturnType<typeof planWithDenoise>): {
    measure: string;
    apply: string;
  } {
    const measure = plan.steps.find(
      (s): s is Extract<RenderStep, { kind: 'loudnorm-measure' }> => s.kind === 'loudnorm-measure',
    );
    const apply = plan.steps.find(
      (s): s is Extract<RenderStep, { kind: 'loudnorm-apply' }> => s.kind === 'loudnorm-apply',
    );
    return {
      measure: measure!.args[measure!.args.indexOf('-af') + 1] ?? '',
      apply: apply!.argsTemplate[apply!.argsTemplate.indexOf('-af') + 1] ?? '',
    };
  }

  it('omits afftdn entirely when denoise is unset — zero regression on the pre-denoise loudnorm chain', () => {
    const { measure, apply } = loudnormAf(planWithDenoise(undefined));
    expect(measure).not.toContain('afftdn');
    expect(apply).not.toContain('afftdn');
    expect(measure.startsWith('loudnorm=')).toBe(true);
  });

  it('omits afftdn when denoise is 0', () => {
    const { measure } = loudnormAf(planWithDenoise(0));
    expect(measure).not.toContain('afftdn');
  });

  it('inserts afftdn with the measured floor and mapped nr BEFORE loudnorm, in both passes', () => {
    const { measure, apply } = loudnormAf(planWithDenoise(0.5, { noiseFloorDb: -42.3 }));
    // nr = 6 + 0.5*18 = 15.0
    expect(measure.startsWith('afftdn=nf=-42.3:nr=15.0,loudnorm=')).toBe(true);
    expect(apply.startsWith('afftdn=nf=-42.3:nr=15.0,loudnorm=')).toBe(true);
  });

  it('falls back to the shared -50dBFS default when denoise is on but no noiseFloorDb was supplied', () => {
    const { measure } = loudnormAf(planWithDenoise(0.3));
    expect(measure).toContain(`afftdn=nf=${NOISE_FLOOR_FALLBACK_DB.toFixed(1)}:nr=11.4,`);
  });

  it('clamps an out-of-range noiseFloorDb before interpolating it into the filtergraph', () => {
    const { measure } = loudnormAf(planWithDenoise(0.5, { noiseFloorDb: -200 }));
    expect(measure).toContain(`afftdn=nf=${NOISE_FLOOR_MIN_DB.toFixed(1)}:nr=`);
  });

  it('uses an explicit 15-band custom profile in both loudnorm passes', () => {
    const bands = Array.from({ length: 15 }, (_, i) => i - 7.25);
    const { measure, apply } = loudnormAf(
      planWithDenoise(0.5, { noiseFloorDb: -44, noiseProfileBands: bands }),
    );
    const expected = `nt=c:bn='${bands.map((band) => band.toFixed(6)).join(' ')}'`;
    expect(measure).toContain(expected);
    expect(apply).toContain(expected);
  });

  it('ignores a malformed custom profile and safely falls back to scalar nf/nr', () => {
    const { measure } = loudnormAf(
      planWithDenoise(0.5, { noiseFloorDb: -44, noiseProfileBands: [1, 2, 3] }),
    );
    expect(measure).toContain('afftdn=nf=-44.0:nr=15.0,loudnorm=');
    expect(measure).not.toContain('nt=c');
  });

  it('still applies denoise when the options.loudnorm override disables normalization', () => {
    const noLoudnorm = planWithDenoise(0.5, { loudnorm: false, noiseFloorDb: -40 });
    expect(noLoudnorm.steps.some((s) => s.kind === 'loudnorm-measure')).toBe(false);
    expect(noLoudnorm.steps.some((s) => s.kind === 'loudnorm-apply')).toBe(false);
    const denoise = ffmpegSteps(noLoudnorm.steps).find((s) => s.label === 'apply denoise');
    expect(denoise).toBeDefined();
    expect(denoise!.args[denoise!.args.indexOf('-af') + 1]).toBe('afftdn=nf=-40.0:nr=15.0');
  });

  it('still applies denoise when the doc has loudnormLufs: null', () => {
    const noLoudnorm = planWithDenoise(0.5, { lufs: null, noiseFloorDb: -40 });
    expect(noLoudnorm.steps.some((s) => s.kind === 'loudnorm-measure')).toBe(false);
    expect(noLoudnorm.steps.some((s) => s.kind === 'loudnorm-apply')).toBe(false);
    expect(ffmpegSteps(noLoudnorm.steps).some((s) => s.label === 'apply denoise')).toBe(true);
  });
});

describe('planRender — preview/final audio parity', () => {
  function audioSemantics(steps: readonly RenderStep[]): readonly string[] {
    const signature: string[] = [];
    for (const step of steps) {
      if (step.kind === 'loudnorm-measure') {
        signature.push(`loudnorm-measure:${step.args[step.args.indexOf('-af') + 1] ?? ''}`);
        continue;
      }
      if (step.kind === 'loudnorm-apply') {
        signature.push(
          `loudnorm-apply:${step.argsTemplate[step.argsTemplate.indexOf('-af') + 1] ?? ''}`,
        );
        continue;
      }
      if (step.kind !== 'ffmpeg' && step.kind !== 'ffmpeg-cacheable') continue;
      const af = step.args[step.args.indexOf('-af') + 1];
      if (step.args.includes('-af') && af !== undefined) signature.push(`${step.label}:af:${af}`);
      const graph = step.args[step.args.indexOf('-filter_complex') + 1];
      if (!step.args.includes('-filter_complex') || graph === undefined) continue;
      const audioParts = graph
        .split(';')
        .filter((part) => /(?:acrossfade|afade|atempo|adelay|amix|volume=)/.test(part));
      if (audioParts.length > 0) signature.push(`${step.label}:graph:${audioParts.join(';')}`);
    }
    return signature;
  }

  it('keeps every audio filter identical; preview changes only video resolution/codec/path', () => {
    const parityDoc: EditDoc = {
      ...doc,
      output: { ...doc.output, denoise: 0.55, joinAudioCrossfadeMs: 60 },
    };
    const shared = {
      doc: parityDoc,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      noiseFloorDb: -43.2,
      noiseProfileBands: Array.from({ length: 15 }, (_, i) => 4 - i / 2),
    };
    const final = planRender({
      ...shared,
      options: { preview: false, subtitles: true, loudnorm: true },
    });
    const preview = planRender({
      ...shared,
      options: { preview: true, subtitles: true, loudnorm: true },
    });
    expect(final.ok).toBe(true);
    expect(preview.ok).toBe(true);
    if (!final.ok || !preview.ok) return;

    expect(audioSemantics(preview.value.steps)).toEqual(audioSemantics(final.value.steps));
    expect(preview.value.width).not.toBe(final.value.width);
    expect(preview.value.outputPath).not.toBe(final.value.outputPath);
  });
});

describe('planRender — block speed', () => {
  const camOnly = {
    version: 2 as const,
    fps: 25,
    output: { width: 1080, height: 1920, loudnormLufs: -14 },
    sources: { cam: { path: 'camera.mp4', durationS: 64.6 } },
    subtitles: { enabled: false as const, preset: '2p-caps' as const },
  };

  function runPlan(doc: EditDoc) {
    const result = planRender({
      doc,
      transcripts: new Map(),
      probes: new Map([['cam', camProbe]]),
      sourceFingerprints: CAM_FINGERPRINT,
      options: { preview: false, subtitles: false, loudnorm: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('plan failed');
    return result.value;
  }

  it('applies setpts=PTS/speed and atempo=speed, halving the output -t bound for a 2x block', () => {
    const doc: EditDoc = {
      ...camOnly,
      tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 4, speed: 2 }] }],
    };
    const plan = runPlan(doc);
    const [segment] = ffmpegSteps(plan.steps).filter((s) => s.label.startsWith('segment'));
    expect(segment).toBeDefined();
    const vf = segment!.args[segment!.args.indexOf('-vf') + 1] ?? '';
    const af = segment!.args[segment!.args.indexOf('-af') + 1] ?? '';
    expect(vf).toContain('setpts=PTS/2.000');
    expect(vf.indexOf('setpts=PTS/2.000')).toBeLessThan(vf.indexOf('fps='));
    expect(af).toContain('atempo=2.000');
    expect(segment!.args[segment!.args.indexOf('-t') + 1]).toBe('2.000'); // 4s source / 2 = 2s output
    expect(plan.expectedDurationS).toBeCloseTo(2, 5);
  });

  it('places setpts BEFORE the dip fade filters, whose st= values are already expressed in post-speed output time', () => {
    const doc: EditDoc = {
      ...camOnly,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 0, out: 4, speed: 2 },
            { source: 'cam', in: 10, out: 14, transition: { type: 'fade-black', durationS: 0.4 } },
          ],
        },
      ],
    };
    const plan = runPlan(doc);
    const seg0 = ffmpegSteps(plan.steps).find((s) => s.label === 'segment 1/2');
    const vf = seg0!.args[seg0!.args.indexOf('-vf') + 1] ?? '';
    // segment 0's OWN output duration is 4s/2=2s; its fade-out dip toward
    // block 1 sits at st = 2 - 0.2 = 1.8 in the post-speed output timeline —
    // wrong if setpts landed after this filter instead of before it.
    expect(vf).toContain('fade=t=out:st=1.800:d=0.200');
    expect(vf.indexOf('setpts=PTS/2.000')).toBeLessThan(vf.indexOf('fade=t=out'));
  });

  it('keeps a 1x block byte-identical to a doc that never used the speed field', () => {
    const base: EditDoc = {
      ...camOnly,
      tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 4 }] }],
    };
    const explicit: EditDoc = {
      ...camOnly,
      tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 4, speed: 1 }] }],
    };
    const baseSteps = ffmpegSteps(runPlan(base).steps).filter((s) => s.label.startsWith('segment'));
    const explicitSteps = ffmpegSteps(runPlan(explicit).steps).filter((s) =>
      s.label.startsWith('segment'),
    );
    expect(explicitSteps).toEqual(baseSteps);
  });

  it('degrades a crossfade to fade-black when either side has speed != 1, preserving exact total duration', () => {
    const speedDoc: EditDoc = {
      ...camOnly,
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 0, out: 4 },
            {
              source: 'cam',
              in: 10,
              out: 14,
              speed: 1.5,
              transition: { type: 'crossfade', durationS: 0.3 },
            },
          ],
        },
      ],
    };
    const plan = runPlan(speedDoc);
    const steps = ffmpegSteps(plan.steps);
    expect(steps.some((s) => s.label.startsWith('crossfade'))).toBe(false);
    const seg1 = steps.find((s) => s.label === 'segment 2/2')!;
    const vf = seg1.args[seg1.args.indexOf('-vf') + 1] ?? '';
    expect(vf).toContain('setpts=PTS/1.500');
    expect(vf).toContain('fade=t=in:st=0.000');
    expect(vf).not.toContain('color=white');
    // block 0: 4s @1x = 4s; block 1: 4s(14-10) @1.5x = 2.667s -> quantized 2.68s (67 frames @25fps)
    expect(plan.expectedDurationS).toBeCloseTo(6.68, 5);
  });
});

describe('planRender — global output speed (doc.output.speed)', () => {
  function runFullPlan(speedDoc: EditDoc, opts: { subtitles?: boolean; loudnorm?: boolean } = {}) {
    const result = planRender({
      doc: speedDoc,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: {
        preview: false,
        subtitles: opts.subtitles ?? true,
        loudnorm: opts.loudnorm ?? false,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('plan failed');
    return result.value;
  }

  it('folds setpts=PTS/S and atempo=S into the compose graph, applied AFTER subtitles are burned', () => {
    const speedDoc: EditDoc = { ...doc, output: { ...doc.output, speed: 1.5 } };
    const result = runFullPlan(speedDoc);
    const compose = ffmpegSteps(result.steps).find((s) => s.label === 'compose')!;
    const graph = compose.args[compose.args.indexOf('-filter_complex') + 1] ?? '';
    const subtitlesIndex = graph.indexOf('subtitles=filename=');
    const setptsIndex = graph.indexOf('setpts=PTS/1.500');
    expect(subtitlesIndex).toBeGreaterThan(-1);
    expect(setptsIndex).toBeGreaterThan(subtitlesIndex);
    expect(graph).toContain('atempo=1.500');
  });

  it('quantizes and divides both the compose -t bound and the returned expectedDurationS by S', () => {
    const natural = runFullPlan(doc);
    const sped = runFullPlan({ ...doc, output: { ...doc.output, speed: 2 } });
    const expected = Math.round((natural.expectedDurationS / 2) * doc.fps) / doc.fps;
    expect(sped.expectedDurationS).toBeCloseTo(expected, 5);
    // the player's clock stays in natural output time and maps to the file by
    // output.speed — so the natural plan must match outputDuration exactly
    expect(natural.expectedDurationS).toBeCloseTo(outputDuration(doc), 5);
    expect(sped.expectedDurationS).toBeCloseTo(
      Math.round((outputDuration(doc) / 2) * doc.fps) / doc.fps,
      5,
    );
    const compose = ffmpegSteps(sped.steps).find((s) => s.label === 'compose')!;
    expect(compose.args[compose.args.indexOf('-t') + 1]).toBe(sped.expectedDurationS.toFixed(3));
  });

  it('is inert when output.speed is absent or explicitly 1 — identical compose graph either way', () => {
    const natural = runFullPlan(doc, { loudnorm: true });
    const explicit = runFullPlan(
      { ...doc, output: { ...doc.output, speed: 1 } },
      { loudnorm: true },
    );
    const naturalCompose = ffmpegSteps(natural.steps).find((s) => s.label === 'compose')!;
    const explicitCompose = ffmpegSteps(explicit.steps).find((s) => s.label === 'compose')!;
    expect(explicitCompose.args).toEqual(naturalCompose.args);
  });

  it('forces the compose path (never remux) once global speed is active, even with no other filters', () => {
    const minimalDoc: EditDoc = {
      version: 2,
      fps: 25,
      output: { width: 1080, height: 1920, loudnormLufs: null, speed: 1.2 },
      sources: { cam: { path: 'camera.mp4', durationS: 64.6 } },
      tracks: [{ id: 'base', kind: 'video', blocks: [{ source: 'cam', in: 0, out: 4 }] }],
      subtitles: { enabled: false, preset: '2p-caps' },
    };
    const result = planRender({
      doc: minimalDoc,
      transcripts: new Map(),
      probes: new Map([['cam', camProbe]]),
      sourceFingerprints: CAM_FINGERPRINT,
      options: { preview: false, subtitles: false, loudnorm: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const steps = ffmpegSteps(result.value.steps);
    expect(steps.some((s) => s.label === 'compose')).toBe(true);
    expect(steps.some((s) => s.label === 'remux')).toBe(false);
  });
});

describe('planRender — audio join crossfade (doc.output.joinAudioCrossfadeMs)', () => {
  const camOnly = {
    version: 2 as const,
    fps: 25,
    output: { width: 1080, height: 1920, loudnormLufs: -14 },
    sources: { cam: { path: 'camera.mp4', durationS: 64.6 } },
    subtitles: { enabled: false as const, preset: '2p-caps' as const },
  };

  function runPlan(doc: EditDoc, probeOverride?: MediaProbe) {
    const result = planRender({
      doc,
      transcripts: new Map(),
      probes: new Map([['cam', probeOverride ?? camProbe]]),
      sourceFingerprints: CAM_FINGERPRINT,
      options: { preview: false, subtitles: false, loudnorm: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('plan failed');
    return result.value;
  }

  const twoBlockDoc: EditDoc = {
    ...camOnly,
    tracks: [
      {
        id: 'base',
        kind: 'video',
        blocks: [
          { source: 'cam', in: 0, out: 4 },
          { source: 'cam', in: 10, out: 14 },
        ],
      },
    ],
  };

  it('builds a parallel audio-only pipeline that crossfades at the join, leaving the video pipeline byte-identical', () => {
    const withoutCrossfade = runPlan(twoBlockDoc);
    const crossfadeDoc: EditDoc = {
      ...twoBlockDoc,
      output: { ...twoBlockDoc.output, joinAudioCrossfadeMs: 60 },
    };
    const withCrossfade = runPlan(crossfadeDoc);

    const videoSegmentsBefore = ffmpegSteps(withoutCrossfade.steps).filter((s) =>
      s.label.startsWith('segment '),
    );
    const videoSegmentsAfter = ffmpegSteps(withCrossfade.steps).filter((s) =>
      s.label.startsWith('segment '),
    );
    expect(videoSegmentsAfter).toEqual(videoSegmentsBefore);

    const steps = ffmpegSteps(withCrossfade.steps);
    expect(steps.some((s) => s.label.startsWith('audio crossfade extend'))).toBe(true);
    const merge = steps.find((s) => s.label.startsWith('audio crossfade join'));
    expect(merge).toBeDefined();
    const joined = merge!.args.join(' ');
    // 60ms = 2880 samples at 48kHz: the outgoing clip ramps down exactly where
    // the incoming one, delayed to that same sample, ramps up
    expect(joined).toContain('afade=t=out:curve=tri:ss=191040:ns=2880');
    expect(joined).toContain('afade=t=in:curve=tri:ss=0:ns=2880,adelay=delays=191040S:all=1');
    expect(joined).toContain('amix=inputs=2:normalize=0:duration=longest');
    // a chained acrossfade is nondeterministic on FFmpeg 7.1 with short clips
    expect(joined).not.toContain('acrossfade');
    expect(steps.some((s) => s.label === 'remux base with crossfaded audio')).toBe(true);
    // both segments are fully covered by the single run — no wasted standalone declick extraction
    expect(steps.some((s) => s.label.startsWith('audio segment'))).toBe(false);
  });

  it('preserves exact total duration with the audio crossfade active', () => {
    const withoutCrossfade = runPlan(twoBlockDoc);
    const crossfadeDoc: EditDoc = {
      ...twoBlockDoc,
      output: { ...twoBlockDoc.output, joinAudioCrossfadeMs: 60 },
    };
    const withCrossfade = runPlan(crossfadeDoc);
    expect(withCrossfade.expectedDurationS).toBeCloseTo(withoutCrossfade.expectedDurationS, 5);
  });

  it('merges three consecutive real audio crossfades into ONE run with two crossfaded joins', () => {
    const threeBlockDoc: EditDoc = {
      ...camOnly,
      output: { ...camOnly.output, joinAudioCrossfadeMs: 60 },
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 0, out: 4 },
            { source: 'cam', in: 10, out: 14 },
            { source: 'cam', in: 20, out: 24 },
          ],
        },
      ],
    };
    const plan = runPlan(threeBlockDoc);
    const steps = ffmpegSteps(plan.steps);

    const merges = steps.filter((s) => s.label.startsWith('audio crossfade join'));
    expect(merges).toHaveLength(1);
    expect(merges[0]!.label).toContain('segments 1-3/3');
    const joined = merges[0]!.args.join(' ');
    expect(joined.match(/afade=t=in:curve=tri:ss=0:ns=2880/g)).toHaveLength(2);
    expect(joined.match(/afade=t=out:curve=tri:ss=\d+:ns=2880/g)).toHaveLength(2);
    expect(joined).toContain('amix=inputs=3:normalize=0:duration=longest');
    expect(steps.some((s) => s.label.startsWith('audio segment'))).toBe(false);

    // three 4s source blocks, no speed -> total unaffected by the crossfade chain
    expect(plan.expectedDurationS).toBeCloseTo(12, 5);
  });

  it('clamps the crossfade against the accumulated stream length when an early block is too short to supply the full overlap', () => {
    // block 0 is only 80ms — its own extended length (plain 0.08s + the
    // 0.1s tail extension the first join wants) is SHORTER than the raw
    // extendAS+extendBS (0.1+0.1=0.2) that join would otherwise request.
    // Without the cumulativeS clamp, the overlap would be longer than the
    // left-hand clip actually is.
    const threeBlockDoc: EditDoc = {
      ...camOnly,
      output: { ...camOnly.output, joinAudioCrossfadeMs: 200 },
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 10, out: 10.08 },
            { source: 'cam', in: 20, out: 24 },
            { source: 'cam', in: 30, out: 34 },
          ],
        },
      ],
    };
    const plan = runPlan(threeBlockDoc);
    const merge = ffmpegSteps(plan.steps).find((s) => s.label.startsWith('audio crossfade join'))!;
    const joined = merge.args.join(' ');
    const firstFadeIn = /afade=t=in:curve=tri:ss=0:ns=(\d+)/.exec(joined);
    // 0.160s at 48kHz
    expect(firstFadeIn?.[1]).toBe('7680');
    // strictly below the raw, unclamped extendAS+extendBS (0.1+0.1=0.2s) —
    // proof the clamp actually reduced it, not a coincidence of the inputs.
    expect(Number(firstFadeIn?.[1])).toBeLessThan(0.2 * 48_000);
  });

  it("keeps the declick fade only at a run's own outer edges, on the extended clips actually used downstream", () => {
    const crossfadeDoc: EditDoc = {
      ...twoBlockDoc,
      output: { ...twoBlockDoc.output, joinAudioCrossfadeMs: 60 },
    };
    const plan = runPlan(crossfadeDoc);
    const extended = ffmpegSteps(plan.steps).filter((s) =>
      s.label.startsWith('audio crossfade extend'),
    );
    expect(extended).toHaveLength(2);
    const [ext0, ext1] = extended;
    const af0 = ext0!.args[ext0!.args.indexOf('-af') + 1] ?? '';
    const af1 = ext1!.args[ext1!.args.indexOf('-af') + 1] ?? '';
    // segment 0 is the run's start: keeps its own leading declick fade; no trailing one (covered by the blend)
    expect(af0).toContain('afade=t=in');
    expect(af0).not.toContain('afade=t=out');
    // segment 1 is the run's end: keeps its own trailing declick fade; no leading one
    expect(af1).not.toContain('afade=t=in');
    expect(af1).toContain('afade=t=out');
  });

  it('behaves exactly like today when the setting is 0 or absent (zero regression)', () => {
    const absent = runPlan(twoBlockDoc);
    const zeroPlan = runPlan({
      ...twoBlockDoc,
      output: { ...twoBlockDoc.output, joinAudioCrossfadeMs: 0 },
    });
    expect(zeroPlan.steps).toEqual(absent.steps);
    expect(ffmpegSteps(absent.steps).some((s) => s.label.includes('crossfaded audio'))).toBe(false);
  });

  it('skips the feature entirely when the base is muted', () => {
    const mutedDoc: EditDoc = {
      ...twoBlockDoc,
      output: { ...twoBlockDoc.output, joinAudioCrossfadeMs: 60 },
      tracks: [
        {
          id: 'base',
          kind: 'video',
          muted: true,
          blocks: [
            { source: 'cam', in: 0, out: 4 },
            { source: 'cam', in: 10, out: 14 },
          ],
        },
      ],
    };
    const plan = runPlan(mutedDoc);
    const steps = ffmpegSteps(plan.steps);
    expect(steps.some((s) => s.label.startsWith('audio segment'))).toBe(false);
    expect(steps.some((s) => s.label.includes('crossfaded audio'))).toBe(false);
  });

  it('skips the feature when a base source has no audio stream', () => {
    const silentDoc: EditDoc = {
      ...twoBlockDoc,
      output: { ...twoBlockDoc.output, joinAudioCrossfadeMs: 60 },
    };
    const plan = runPlan(silentDoc, screenProbe); // hasAudio: false
    expect(ffmpegSteps(plan.steps).some((s) => s.label.startsWith('audio segment'))).toBe(false);
  });

  it('degrades a join to declick when a neighbouring block has speed != 1', () => {
    const speedDoc: EditDoc = {
      ...camOnly,
      output: { ...camOnly.output, joinAudioCrossfadeMs: 60 },
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 0, out: 4 },
            { source: 'cam', in: 10, out: 14, speed: 1.5 },
          ],
        },
      ],
    };
    const plan = runPlan(speedDoc);
    expect(ffmpegSteps(plan.steps).some((s) => s.label.startsWith('audio crossfade'))).toBe(false);
  });

  it('degrades only joins adjacent to a sped block while preserving independent crossfades', () => {
    // Join 0→1 degrades because block 0 is 2x, but join 1→2 remains a valid
    // crossfade. The standalone audio extraction for block 0 must carry the
    // same atempo and 2s output bound as the video extraction, so the later
    // crossfade stays synchronized instead of disabling the global feature.
    const speedDoc: EditDoc = {
      ...camOnly,
      output: { ...camOnly.output, joinAudioCrossfadeMs: 60 },
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            { source: 'cam', in: 0, out: 4, speed: 2 },
            { source: 'cam', in: 10, out: 14 },
            { source: 'cam', in: 20, out: 24 },
          ],
        },
      ],
    };
    const plan = runPlan(speedDoc);
    const steps = ffmpegSteps(plan.steps);
    const spedAudio = steps.find((s) => s.label === 'audio segment 1/3');
    expect(spedAudio).toBeDefined();
    expect(spedAudio!.args[spedAudio!.args.indexOf('-t') + 1]).toBe('2.000');
    expect(spedAudio!.args[spedAudio!.args.indexOf('-af') + 1]).toContain('atempo=2.000');
    const crossfade = steps.find((s) => s.label.startsWith('audio crossfade join'));
    expect(crossfade?.label).toContain('segments 2-3/3');
    expect(steps.some((s) => s.label === 'remux base with crossfaded audio')).toBe(true);
    expect(plan.expectedDurationS).toBeCloseTo(10, 5);
  });

  it('content-addresses a retimed declick extraction by its atempo and output duration', () => {
    const withFirstSpeed = (speed?: number): EditDoc => ({
      ...camOnly,
      output: { ...camOnly.output, joinAudioCrossfadeMs: 60 },
      tracks: [
        {
          id: 'base',
          kind: 'video',
          blocks: [
            // No tail material + only 10ms before block 1: this first join
            // remains declick at either speed, making the cache comparison
            // isolate retiming rather than a changed join decision.
            { source: 'cam', in: 60, out: 64.6, ...(speed === undefined ? {} : { speed }) },
            { source: 'cam', in: 0.01, out: 4 },
            { source: 'cam', in: 10, out: 14 },
          ],
        },
      ],
    });
    const natural = runPlan(withFirstSpeed());
    const retimed = runPlan(withFirstSpeed(2));
    const declick = (plan: RenderPlan) =>
      plan.steps.find(
        (step): step is Extract<RenderStep, { kind: 'ffmpeg-cacheable' }> =>
          step.kind === 'ffmpeg-cacheable' && step.label === 'audio segment 1/3',
      );
    const naturalStep = declick(natural);
    const retimedStep = declick(retimed);
    expect(naturalStep).toBeDefined();
    expect(retimedStep).toBeDefined();
    expect(naturalStep!.args[naturalStep!.args.indexOf('-t') + 1]).toBe('4.600');
    expect(retimedStep!.args[retimedStep!.args.indexOf('-t') + 1]).toBe('2.280');
    expect(retimedStep!.args[retimedStep!.args.indexOf('-af') + 1]).toContain('atempo=2.000');
    expect(retimedStep!.output).not.toBe(naturalStep!.output);
    expect(retimedStep!.args).toEqual([...retimedStep!.argsWithoutOutput, retimedStep!.output]);
  });

  it('crossfades only the SECOND join of three blocks when the first lacks enough source material, leaving segment 0 on the plain declick fade', () => {
    const threeBlockDoc: EditDoc = {
      ...camOnly,
      output: { ...camOnly.output, joinAudioCrossfadeMs: 60 },
      tracks: [
        {
          id: 'base',
          kind: 'video',
          // block 0 ends flush with the source's own duration (nothing to
          // extend past `out`) and block 1 starts 0.01s into the source
          // (barely anything before `in`) — join 1's clamped overlap (0.01s)
          // is below MIN_AUDIO_CROSSFADE_OVERLAP_S, so it degrades to
          // declick while join 2 (plenty of material both sides) crossfades.
          blocks: [
            { source: 'cam', in: 60, out: 64.6 },
            { source: 'cam', in: 0.01, out: 4 },
            { source: 'cam', in: 10, out: 14 },
          ],
        },
      ],
    };
    const plan = runPlan(threeBlockDoc);
    const steps = ffmpegSteps(plan.steps);

    const merge = steps.find((s) => s.label.startsWith('audio crossfade join'));
    expect(merge).toBeDefined();
    expect(merge!.label).toContain('segments 2-3/3');

    // segment 0 sits outside the run (join 1 degraded) — its own standalone
    // declick step keeps BOTH edges (the timeline start and the degraded join).
    const declickSegments = steps.filter((s) => s.label.startsWith('audio segment'));
    expect(declickSegments).toHaveLength(1);
    expect(declickSegments[0]!.label).toBe('audio segment 1/3');
    const af0 = declickSegments[0]!.args[declickSegments[0]!.args.indexOf('-af') + 1] ?? '';
    expect(af0).toContain('afade=t=in');
    expect(af0).toContain('afade=t=out');

    // segments 1 and 2 are fully covered by the run — only the extended
    // clips exist, each keeping the declick fade at its own OUTER edge only.
    const extended = steps.filter((s) => s.label.startsWith('audio crossfade extend'));
    expect(extended).toHaveLength(2);
    const ext1 = extended.find((s) => s.label.includes('segment 2/3'))!;
    const ext2 = extended.find((s) => s.label.includes('segment 3/3'))!;
    const af1 = ext1.args[ext1.args.indexOf('-af') + 1] ?? '';
    const af2 = ext2.args[ext2.args.indexOf('-af') + 1] ?? '';
    expect(af1).toContain('afade=t=in');
    expect(af1).not.toContain('afade=t=out');
    expect(af2).not.toContain('afade=t=in');
    expect(af2).toContain('afade=t=out');

    // block 0: 4.6s (exact); block 1: 3.99s -> quantized 100 frames = 4.0s; block 2: 4.0s
    expect(plan.expectedDurationS).toBeCloseTo(12.6, 5);
  });
});

describe('planRender — duration exactness matrix (speed × video crossfade × audio crossfade)', () => {
  const camOnly = {
    version: 2 as const,
    fps: 25,
    output: { width: 1080, height: 1920, loudnormLufs: -14 },
    sources: { cam: { path: 'camera.mp4', durationS: 64.6 } },
    subtitles: { enabled: false as const, preset: '2p-caps' as const },
  };

  function runPlan(doc: EditDoc) {
    const result = planRender({
      doc,
      transcripts: new Map(),
      probes: new Map([['cam', camProbe]]),
      sourceFingerprints: CAM_FINGERPRINT,
      options: { preview: false, subtitles: false, loudnorm: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('plan failed');
    return result.value;
  }

  // Two 4s-source blocks; expected total is the sum of each block's own
  // quantized OUTPUT duration — neither crossfade feature may change the
  // total (every extension is fully consumed by its blend).
  function expectedTotal(speedA: number, speedB: number): number {
    const a = Math.round((4 / speedA) * 25) / 25;
    const b = Math.round((4 / speedB) * 25) / 25;
    return a + b;
  }

  const cases: {
    readonly name: string;
    readonly speedB?: number;
    readonly videoCrossfade?: boolean;
    readonly audioCrossfadeMs?: number;
  }[] = [
    { name: 'no speed, no crossfade' },
    { name: 'block speed only', speedB: 1.5 },
    { name: 'video crossfade only' },
    { name: 'audio crossfade only', audioCrossfadeMs: 60 },
    { name: 'video and audio crossfade together', audioCrossfadeMs: 60 },
    {
      name: 'speed degrades both crossfade kinds to declick/dip',
      speedB: 1.5,
      audioCrossfadeMs: 60,
    },
  ].map((c, i) => ({ ...c, videoCrossfade: i === 2 || i === 4 || i === 5 }));

  it.each(cases)(
    'preserves exact total duration: $name',
    ({ speedB, videoCrossfade, audioCrossfadeMs }) => {
      const testDoc: EditDoc = {
        ...camOnly,
        output: {
          ...camOnly.output,
          ...(audioCrossfadeMs !== undefined ? { joinAudioCrossfadeMs: audioCrossfadeMs } : {}),
        },
        tracks: [
          {
            id: 'base',
            kind: 'video',
            blocks: [
              { source: 'cam', in: 0, out: 4 },
              {
                source: 'cam',
                in: 10,
                out: 14,
                ...(speedB !== undefined ? { speed: speedB } : {}),
                ...(videoCrossfade
                  ? { transition: { type: 'crossfade' as const, durationS: 0.3 } }
                  : {}),
              },
            ],
          },
        ],
      };
      const plan = runPlan(testDoc);
      expect(plan.expectedDurationS).toBeCloseTo(expectedTotal(1, speedB ?? 1), 5);
    },
  );
});

describe('planRender — program profile (layers: omit)', () => {
  function graphOf(steps: readonly RenderStep[]): string {
    const compose = ffmpegSteps(steps).find((s) => s.label === 'compose');
    return compose?.args[compose.args.indexOf('-filter_complex') + 1] ?? '';
  }

  it('drops layer video, overlays and subtitles, keeps the ducked layer audio, and lands in edit/program.mp4', () => {
    const program = plan({ preview: true, layers: 'omit' });
    const serialized = JSON.stringify(program.steps);
    const graph = graphOf(program.steps);

    expect(serialized).toContain('edit/program.mp4');
    expect(serialized).not.toContain('edit/preview.mp4');
    expect(serialized).not.toContain('cta.webm');
    expect(serialized).not.toContain('subtitles=');
    expect(program.steps.some((s) => s.kind === 'subtitle-graphics')).toBe(false);
    // the ducked screen layer is still extracted for its audio (input 1)…
    expect(program.steps.some((s) => 'label' in s && s.label.startsWith('layer clip'))).toBe(true);
    expect(graph).toContain("volume=enable='between(t,3.000,5.000)':volume=0.25");
    expect(graph).toContain('[1:a]');
    // …but its picture never enters the graph
    expect(graph).not.toContain('[1:v]');
    expect(graph).not.toContain('overlay=');
  });

  it('remuxes the base stream untouched when nothing but the cut and the audio chain remain', () => {
    const silentLayers: EditDoc = {
      ...doc,
      tracks: doc.tracks.map((track) =>
        track.id === 'demo' && track.kind === 'video' ? { ...track, muted: true } : track,
      ),
    };
    const result = planRender({
      doc: silentLayers,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: true, subtitles: true, loudnorm: false, layers: 'omit' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.steps.some((s) => 'label' in s && s.label.startsWith('layer clip'))).toBe(
      false,
    );
    expect(ffmpegSteps(result.value.steps).find((s) => s.label === 'compose')).toBeUndefined();
    const remux = ffmpegSteps(result.value.steps).at(-1);
    expectArgPair(remux?.args ?? [], '-c:v', 'copy');
    expect(remux?.args.at(-1)).toBe('edit/program.mp4');
  });

  it('still burns camera effects into the program', () => {
    const withZoom: EditDoc = {
      ...doc,
      tracks: [
        ...doc.tracks,
        {
          id: 'effects',
          kind: 'effect',
          blocks: [{ type: 'zoom', at: 1, duration: 2, scale: 1.2 }],
        },
      ],
    };
    const result = planRender({
      doc: withZoom,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      options: { preview: true, subtitles: true, loudnorm: true, layers: 'omit' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(graphOf(result.value.steps)).toContain('crop=');
  });

  it.each([
    [{ preview: true, layers: 'omit' }, 'edit/program.mp4'],
    [{ preview: false, layers: 'omit' }, 'edit/program.mp4'],
    [{ preview: true, layers: 'burn' }, 'edit/preview.mp4'],
    [{ preview: true }, 'edit/preview.mp4'],
    [{ preview: false }, 'edit/final.mp4'],
  ] as const)('renderOutputPath(%o) is %s', (options, expected) => {
    expect(renderOutputPath({ subtitles: true, loudnorm: true, ...options })).toBe(expected);
  });
});

describe('video color isolation', () => {
  function gradedPlan() {
    const graded: EditDoc = {
      ...doc,
      tracks: doc.tracks.map((track, i) =>
        i === 0 && track.kind === 'video'
          ? { ...track, color: { input: 'hlg', saturation: 0.8 } }
          : track,
      ),
    };
    const result = planRender({
      doc: graded,
      transcripts: new Map([['cam', transcript]]),
      probes: new Map([
        ['cam', camProbe],
        ['screen', screenProbe],
      ]),
      sourceFingerprints: FINGERPRINTS,
      previewVideoSources: new Map([['cam', 'proxy.mp4']]),
      options: { preview: true, subtitles: true, loudnorm: false },
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }
  it('grades source extractions, never the finished composite, and bypasses ambiguous HDR proxies', () => {
    const steps = ffmpegSteps(gradedPlan().steps);
    const graded = steps.filter((step) => step.args.join(' ').includes('tonemap='));
    expect(graded.length).toBeGreaterThan(0);
    for (const step of graded) {
      expect(step.args).toContain('camera.mp4');
      expect(step.args).not.toContain('proxy.mp4');
      expect(step.args).toContain('-vf');
      expect(step.args).not.toContain('-filter_complex');
    }
    for (const step of steps.filter((step) => step.args.includes('-filter_complex'))) {
      expect(step.args.join(' ')).not.toContain('saturation=0.8');
      expect(step.args.join(' ')).not.toContain('tonemap=');
    }
  });
});

describe('source-trimmed overlays', () => {
  function overlayPlan(sourceIn: number, duration?: number) {
    const next: EditDoc = {
      ...doc,
      tracks: [
        doc.tracks[0]!,
        {
          id: 'trimmed',
          kind: 'overlay',
          blocks: [
            { file: 'card.webm', at: 1, sourceIn, ...(duration === undefined ? {} : { duration }) },
          ],
        },
      ],
    };
    return planRender({
      doc: next,
      transcripts: new Map(),
      probes: new Map([
        ['cam', camProbe],
        ['card.webm', { ...screenProbe, durationS: 5 }],
      ]),
      sourceFingerprints: CAM_FINGERPRINT,
      options: { preview: false, subtitles: false, loudnorm: false },
    });
  }
  it('seeks the overlay source and preserves its output placement', () => {
    const result = overlayPlan(2, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const step = ffmpegSteps(result.value.steps).find((s) => s.label === 'compose')!;
    expect(step.args.join(' ')).toContain('-c:v libvpx-vp9 -ss 2.000 -i card.webm');
    expect(step.args.join(' ')).toContain('setpts=PTS-STARTPTS+1.000/TB');
    expect(step.args.join(' ')).toContain('between(t,1.000,3.000)');
  });
  it('uses only the remaining source duration when the end is implicit', () => {
    const result = overlayPlan(2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const step = ffmpegSteps(result.value.steps).find((s) => s.label === 'compose')!;
    expect(step.args.join(' ')).toContain('between(t,1.000,4.000)');
  });
  it('rejects an offset beyond the media', () => {
    expect(overlayPlan(5).ok).toBe(false);
    expect(overlayPlan(6, 2).ok).toBe(false);
  });
});
