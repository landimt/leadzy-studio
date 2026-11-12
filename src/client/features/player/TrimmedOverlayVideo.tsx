import { useEffect, useRef, type JSX } from 'react';
import type { OverlayBlock } from '../../../core/schema.js';
import { api } from '../../api.js';
import { playhead } from '../../state/playhead.js';
import { overlayPlaybackFrame } from './overlayPlayback.js';

/** A source-trimmed overlay must seek with the timeline, not restart an animated image. */
export function TrimmedOverlayVideo({
  block,
  version,
}: {
  block: OverlayBlock;
  version: number;
}): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const sync = (): void => {
      const wanted = (block.sourceIn ?? 0) + Math.max(0, playhead.time - block.at);
      const frame = overlayPlaybackFrame(wanted, video.duration);
      if (
        video.readyState > 0 &&
        Math.abs(video.currentTime - frame.time) > (playhead.playing ? 0.15 : 0.02)
      )
        video.currentTime = frame.time;
      if (playhead.playing && !frame.hold && video.paused) void video.play().catch(() => undefined);
      else if (!playhead.playing || frame.hold) video.pause();
    };
    video.addEventListener('loadedmetadata', sync);
    const unsubscribe = playhead.subscribe(sync);
    sync();
    return () => {
      unsubscribe();
      video.removeEventListener('loadedmetadata', sync);
      video.pause();
    };
  }, [block, version]);
  return (
    <video
      ref={ref}
      className="overlay-media"
      src={`${api.mediaUrl(block.file)}?v=${String(version)}`}
      muted
      playsInline
      preload="auto"
      style={{ height: block.scale === undefined ? '100%' : 'auto', objectFit: 'fill' }}
    />
  );
}
