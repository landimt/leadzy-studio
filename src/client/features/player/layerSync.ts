import type { LayerBlock } from '../../../core/schema.js';
import { PLAYING_TOLERANCE_S, SCRUB_TOLERANCE_S } from './engineClock.js';

export interface LayerInstance {
  readonly trackId: string;
  readonly blockIndex: number;
  readonly block: LayerBlock;
  readonly audio: LayerBlock['audio'];
}

/** The slice of `HTMLVideoElement` the sync touches — tests hand in fakes. */
export interface LayerVideo {
  currentTime: number;
  playbackRate: number;
  readonly paused: boolean;
  muted: boolean;
  readonly parentElement: { readonly style: { display: string } } | null;
  play(): Promise<void>;
  pause(): void;
}

export function layerVideoKey(layer: Pick<LayerInstance, 'trackId' | 'blockIndex'>): string {
  return `layer:${layer.trackId}:${String(layer.blockIndex)}`;
}

/**
 * Shows and seeks the DOM layer videos for `current`. Returns the base volume
 * their audio semantics ask for; in engine mode the program already carries
 * their audio, so every layer stays muted and the volume is irrelevant.
 * `playbackRate` is the pace the playhead advances at — the user's rate, times
 * `output.speed` in engine mode — so a layer keeps up instead of being
 * re-seeked every time it drifts past the tolerance.
 */
export function syncLayerVideos(
  layers: readonly LayerInstance[],
  videos: ReadonlyMap<string, LayerVideo>,
  current: number,
  playing: boolean,
  playbackRate: number,
  engine: boolean,
): number {
  let baseVolume = 1;
  for (const layer of layers) {
    const { block } = layer;
    const video = videos.get(layerVideoKey(layer));
    if (!video) continue;
    const wrapper = video.parentElement;
    const start = block.at;
    const end = block.at + (block.out - block.in);
    const visible = current >= start && current < end;
    if (wrapper) wrapper.style.display = visible ? 'block' : 'none';
    if (visible) {
      const want = block.in + (current - start);
      const tolerance = playing ? PLAYING_TOLERANCE_S : SCRUB_TOLERANCE_S;
      if (Math.abs(video.currentTime - want) > tolerance) video.currentTime = want;
      video.muted = engine || layer.audio === 'mute';
      if (video.playbackRate !== playbackRate) video.playbackRate = playbackRate;
      if (playing && video.paused) void video.play().catch(() => undefined);
      if (!playing && !video.paused) video.pause();
      if (layer.audio === 'solo') baseVolume = 0;
      if (layer.audio === 'duck') baseVolume = Math.min(baseVolume, 0.25);
    } else if (!video.paused) {
      video.pause();
    }
  }
  return baseVolume;
}
