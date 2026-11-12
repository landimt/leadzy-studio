/** Pin held overlays to the last decodable frame instead of restarting an ended video. */
export function overlayPlaybackFrame(
  sourceTime: number,
  duration: number,
): { time: number; hold: boolean } {
  const knownEnd = Number.isFinite(duration) && duration > 0;
  return {
    time: knownEnd ? Math.min(sourceTime, Math.max(0, duration - 0.001)) : sourceTime,
    hold: knownEnd && sourceTime >= duration - 0.001,
  };
}
