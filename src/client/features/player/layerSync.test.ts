import { describe, expect, it } from 'vitest';
import type { LayerBlock } from '../../../core/schema.js';
import {
  type LayerInstance,
  type LayerVideo,
  layerVideoKey,
  syncLayerVideos,
} from './layerSync.js';

interface FakeVideo extends LayerVideo {
  paused: boolean;
  readonly parentElement: { readonly style: { display: string } };
  readonly calls: string[];
}

function fakeVideo(currentTime = 0): FakeVideo {
  const video: FakeVideo = {
    currentTime,
    playbackRate: 1,
    paused: true,
    muted: false,
    parentElement: { style: { display: 'block' } },
    calls: [],
    play: () => {
      video.paused = false;
      video.calls.push('play');
      return Promise.resolve();
    },
    pause: () => {
      video.paused = true;
      video.calls.push('pause');
    },
  };
  return video;
}

function layer(audio: LayerBlock['audio'], overrides: Partial<LayerBlock> = {}): LayerInstance {
  const block = { source: 'pip', in: 2, out: 5, at: 10, audio, ...overrides } as LayerBlock;
  return { trackId: 'layers', blockIndex: 0, block, audio };
}

function rig(instance: LayerInstance, video: FakeVideo): ReadonlyMap<string, LayerVideo> {
  return new Map([[layerVideoKey(instance), video]]);
}

describe('syncLayerVideos', () => {
  it('shows the layer inside its window, seeks into the source and plays', () => {
    const video = fakeVideo();
    const pip = layer('duck');

    const baseVolume = syncLayerVideos([pip], rig(pip, video), 11, true, 1, false);

    expect(video.parentElement.style.display).toBe('block');
    expect(video.currentTime).toBe(3);
    expect(video.muted).toBe(false);
    expect(video.calls).toEqual(['play']);
    expect(baseVolume).toBe(0.25);
  });

  it('hides and pauses the layer outside its window — at the exact end too', () => {
    const video = fakeVideo(3);
    video.paused = false;
    const pip = layer('duck');

    syncLayerVideos([pip], rig(pip, video), 13, true, 1, false);

    expect(video.parentElement.style.display).toBe('none');
    expect(video.calls).toEqual(['pause']);
  });

  it('leaves a small drift alone while playing and pauses when the playhead stops', () => {
    const video = fakeVideo(3.2);
    video.paused = false;
    const pip = layer('duck');

    syncLayerVideos([pip], rig(pip, video), 11, true, 1, false);
    expect(video.currentTime).toBe(3.2);

    syncLayerVideos([pip], rig(pip, video), 11, false, 1, false);
    expect(video.calls).toEqual(['pause']);
    expect(video.currentTime).toBe(3);
  });

  it('honours the audio semantics: mute silences the layer, solo and duck lower the base', () => {
    const muted = fakeVideo();
    const mutedLayer = layer('mute');
    expect(syncLayerVideos([mutedLayer], rig(mutedLayer, muted), 11, false, 1, false)).toBe(1);
    expect(muted.muted).toBe(true);

    const solo = fakeVideo();
    const soloLayer = layer('solo');
    expect(syncLayerVideos([soloLayer], rig(soloLayer, solo), 11, false, 1, false)).toBe(0);

    const duck = fakeVideo();
    const duckLayer = layer('duck');
    expect(syncLayerVideos([duckLayer], rig(duckLayer, duck), 11, false, 1, false)).toBe(0.25);
  });

  it('in engine mode every visible layer is muted and runs at the playhead pace', () => {
    const video = fakeVideo();
    const pip = layer('solo');

    syncLayerVideos([pip], rig(pip, video), 11, true, 2, true);

    expect(video.muted).toBe(true);
    expect(video.playbackRate).toBe(2);
    expect(video.calls).toEqual(['play']);
  });

  it('leaves the rate alone when it already matches and never touches a hidden layer', () => {
    const shown = fakeVideo();
    shown.playbackRate = 1.5;
    const pip = layer('duck');
    syncLayerVideos([pip], rig(pip, shown), 11, true, 1.5, false);
    expect(shown.playbackRate).toBe(1.5);

    const hidden = fakeVideo();
    syncLayerVideos([pip], rig(pip, hidden), 20, true, 2, false);
    expect(hidden.playbackRate).toBe(1);
  });

  it('skips layers without a mounted video', () => {
    expect(syncLayerVideos([layer('solo')], new Map(), 11, true, 1, false)).toBe(1);
  });
});
