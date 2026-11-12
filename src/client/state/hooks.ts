import { useSyncExternalStore } from 'react';
import { store } from './store.js';
import { type StoreState } from './storeState.js';
import { playhead } from './playhead.js';

export function useStore(): StoreState {
  return useSyncExternalStore(store.subscribe, store.getState);
}

export function usePlayheadTime(): number {
  return useSyncExternalStore(playhead.subscribe, () => playhead.time);
}

export function usePlaying(): boolean {
  return useSyncExternalStore(playhead.subscribe, () => playhead.playing);
}
