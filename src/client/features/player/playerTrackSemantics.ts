import type { LayerBlock } from '../../../core/schema.js';

interface PlayerTrackState {
  readonly hidden?: boolean | undefined;
}

export function isPlayerTrackVisible(track: PlayerTrackState): boolean {
  return track.hidden !== true;
}

export function effectivePlayerLayerAudio(
  trackMuted: boolean,
  blockAudio: LayerBlock['audio'],
): LayerBlock['audio'] {
  return trackMuted ? 'mute' : blockAudio;
}
