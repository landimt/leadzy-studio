import type { Listener } from './storeState.js';

/** Playhead lives in its own store — it updates at 60fps and must not re-render the app. */
class PlayheadStore {
  private timeValue = 0;
  private playingValue = false;
  private readonly listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get time(): number {
    return this.timeValue;
  }

  get playing(): boolean {
    return this.playingValue;
  }

  seek(time: number): void {
    this.timeValue = Math.max(0, time);
    this.notify();
  }

  setPlaying(playing: boolean): void {
    this.playingValue = playing;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const playhead = new PlayheadStore();
