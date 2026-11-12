/** Paused: the video follows the playhead once it drifts past a scrub's worth. */
export const SCRUB_TOLERANCE_S = 0.05;
/** While playing, the VIDEO is the clock — only hard-seek on real jumps. */
export const PLAYING_TOLERANCE_S = 0.3;
/** How close to the end still counts as "reached the end". */
export const END_EPSILON_S = 0.02;

export interface EngineClockInput {
  readonly playing: boolean;
  /** Where the timeline says we are, in the document's natural output time. */
  readonly playhead: number;
  /** Where the rendered file actually is, in FILE time. */
  readonly position: number;
  /** The file's own duration in file time; `Infinity` until metadata loads. */
  readonly fileEnd: number;
  readonly ended: boolean;
  /** Output duration of the document (natural time, not the file's). */
  readonly duration: number;
  readonly loop: boolean;
  /**
   * `output.speed`: the rendered file already runs at it, while the playhead
   * and the timeline stay in natural time like the simulation (the Speed tool
   * proves the pace on its own).
   */
  readonly speed: number;
}

export type EngineClockAction =
  /** `to` is in FILE time — assign it to `video.currentTime` as is. */
  | { readonly kind: 'seek-video'; readonly to: number }
  | { readonly kind: 'loop' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'follow'; readonly time: number }
  | { readonly kind: 'hold' };

/**
 * One frame of the engine/proof clock. The rendered file drives the playhead
 * ('follow'); the playhead only wins on a real jump ('seek-video'), so the
 * two never fight over sub-frame differences.
 */
export function engineClockStep(input: EngineClockInput): EngineClockAction {
  // an encoded file can end a few ms before the document does; never chase
  // a playhead the file cannot reach
  const playhead = Math.min(input.playhead, input.fileEnd * input.speed);
  const position = input.position * input.speed;
  const drift = Math.abs(position - playhead);
  const seek = { kind: 'seek-video', to: playhead / input.speed } as const;
  if (!input.playing) return drift > SCRUB_TOLERANCE_S ? seek : { kind: 'hold' };
  if (drift > PLAYING_TOLERANCE_S) return seek;
  if (input.ended || position >= input.duration - END_EPSILON_S) {
    return input.loop ? { kind: 'loop' } : { kind: 'stop' };
  }
  return { kind: 'follow', time: position };
}
