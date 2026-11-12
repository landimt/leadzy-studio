import { describe, expect, it, vi } from 'vitest';
import type { AudioBlock } from '../../../core/schema.js';
import {
  createPlayerAudioController,
  dbToPlayerLinearGain,
  playerAudioFrame,
  resolvePlayerAudioFades,
  syncPlayerAudioElement,
  type PlayerAudioController,
  type PlayerAudioFrame,
} from './playerAudio.js';

const block: AudioBlock = {
  source: 'music',
  in: 5,
  out: 9,
  at: 10,
  gainDb: 12,
  fadeInS: 1,
  fadeOutS: 2,
};

function makeAudioContextHarness(): {
  readonly context: AudioContext;
  readonly createSource: ReturnType<typeof vi.fn>;
  readonly createGain: ReturnType<typeof vi.fn>;
  readonly sourceConnect: ReturnType<typeof vi.fn>;
  readonly sourceDisconnect: ReturnType<typeof vi.fn>;
  readonly gainConnect: ReturnType<typeof vi.fn>;
  readonly gainDisconnect: ReturnType<typeof vi.fn>;
  readonly gainParam: { value: number };
  readonly resume: ReturnType<typeof vi.fn>;
} {
  const sourceConnect = vi.fn();
  const sourceDisconnect = vi.fn();
  const gainConnect = vi.fn();
  const gainDisconnect = vi.fn();
  const gainParam = { value: 1 };
  const createSource = vi.fn(() => ({ connect: sourceConnect, disconnect: sourceDisconnect }));
  const createGain = vi.fn(() => ({
    connect: gainConnect,
    disconnect: gainDisconnect,
    gain: gainParam,
  }));
  let state: AudioContextState = 'suspended';
  const resume = vi.fn(() => {
    state = 'running';
    return Promise.resolve();
  });
  const context = {
    get state(): AudioContextState {
      return state;
    },
    destination: {},
    createMediaElementSource: createSource,
    createGain,
    resume,
  } as unknown as AudioContext;
  return {
    context,
    createSource,
    createGain,
    sourceConnect,
    sourceDisconnect,
    gainConnect,
    gainDisconnect,
    gainParam,
    resume,
  };
}

function makeAudioElement(currentTime = 0): {
  readonly element: HTMLAudioElement;
  readonly play: ReturnType<typeof vi.fn>;
  readonly pause: ReturnType<typeof vi.fn>;
} {
  let paused = true;
  const play = vi.fn(() => {
    paused = false;
    return Promise.resolve();
  });
  const pause = vi.fn(() => {
    paused = true;
  });
  const element = {
    currentTime,
    playbackRate: 1,
    muted: false,
    volume: 1,
    get paused(): boolean {
      return paused;
    },
    play,
    pause,
  } as unknown as HTMLAudioElement;
  return { element, play, pause };
}

function makeController(): {
  readonly controller: PlayerAudioController;
  readonly setGain: ReturnType<typeof vi.fn>;
} {
  const setGain = vi.fn();
  return {
    controller: {
      attach: vi.fn(),
      detach: vi.fn(),
      setGain,
      resume: vi.fn(() => Promise.resolve()),
    },
    setGain,
  };
}

describe('player audio envelope', () => {
  it('converts dB to linear gain without clipping positive gain', () => {
    expect(dbToPlayerLinearGain(0)).toBe(1);
    expect(dbToPlayerLinearGain(-60)).toBeCloseTo(0.001, 8);
    expect(dbToPlayerLinearGain(12)).toBeCloseTo(3.981_071_706, 8);
  });

  it('matches the export edge de-click and preserves longer user fades', () => {
    expect(resolvePlayerAudioFades(4)).toEqual({ fadeInS: 0.03, fadeOutS: 0.03 });
    expect(resolvePlayerAudioFades(4, 1, 2)).toEqual({ fadeInS: 1, fadeOutS: 2 });
    expect(resolvePlayerAudioFades(0.04)).toEqual({ fadeInS: 0.02, fadeOutS: 0.02 });
  });

  it('derives source seek, positive gain and both fades from the output playhead', () => {
    expect(playerAudioFrame(block, 9.99, false, 25)).toEqual({
      active: false,
      audible: false,
      sourceTime: null,
      linearGain: 0,
    });

    const fadeIn = playerAudioFrame(block, 10.5, false, 25);
    expect(fadeIn).toMatchObject({ active: true, audible: true, sourceTime: 5.5 });
    expect(fadeIn.linearGain).toBeCloseTo(dbToPlayerLinearGain(12) * 0.5, 8);

    const fadeOut = playerAudioFrame(block, 13, false, 25);
    expect(fadeOut.sourceTime).toBe(8);
    expect(fadeOut.linearGain).toBeCloseTo(dbToPlayerLinearGain(12) * 0.5, 8);

    expect(playerAudioFrame(block, 14, false, 25).active).toBe(false);
  });

  it('ends off-grid blocks on the same whole frame as export', () => {
    const offGridBlock: AudioBlock = {
      source: 'music',
      in: 0,
      out: 1.01,
      at: 2,
    };

    const lastAudibleFrame = playerAudioFrame(offGridBlock, 2.999, false, 25);
    expect(lastAudibleFrame.active).toBe(true);
    expect(lastAudibleFrame.sourceTime).toBeCloseTo(0.999, 8);
    expect(playerAudioFrame(offGridBlock, 3, false, 25)).toEqual({
      active: false,
      audible: false,
      sourceTime: null,
      linearGain: 0,
    });
    expect(playerAudioFrame(offGridBlock, 3.005, false, 25).active).toBe(false);
  });

  it('keeps a muted track windowed and seekable while making it inaudible', () => {
    expect(playerAudioFrame(block, 12, true, 25)).toEqual({
      active: true,
      audible: false,
      sourceTime: 7,
      linearGain: 0,
    });
  });
});

describe('player audio Web Audio routing', () => {
  it('creates one MediaElementSource per element across repeated StrictMode attachments', async () => {
    const harness = makeAudioContextHarness();
    const controller = createPlayerAudioController(() => harness.context);
    const { element } = makeAudioElement();

    controller.attach(element);
    controller.detach(element);
    controller.attach(element);
    controller.attach(element);
    controller.setGain(element, dbToPlayerLinearGain(12));
    controller.setGain(element, 100);

    expect(harness.createSource).toHaveBeenCalledTimes(1);
    expect(harness.createGain).toHaveBeenCalledTimes(1);
    expect(harness.sourceConnect).toHaveBeenCalledTimes(2);
    expect(harness.sourceDisconnect).toHaveBeenCalledTimes(1);
    expect(harness.gainConnect).toHaveBeenCalledTimes(2);
    expect(harness.gainDisconnect).toHaveBeenCalledTimes(1);
    expect(harness.gainParam.value).toBeCloseTo(dbToPlayerLinearGain(12), 8);
    expect(element.volume).toBe(1);
    expect(element.muted).toBe(false);

    await controller.resume();
    expect(harness.resume).toHaveBeenCalledTimes(1);
  });

  it('retries AudioContext construction from a user gesture', async () => {
    const harness = makeAudioContextHarness();
    const createContext = vi
      .fn<() => AudioContext>()
      .mockImplementationOnce(() => {
        throw new Error('gesture required');
      })
      .mockReturnValue(harness.context);
    const controller = createPlayerAudioController(createContext);
    const { element } = makeAudioElement();

    controller.attach(element);
    await controller.resume();
    controller.setGain(element, 1);

    expect(createContext).toHaveBeenCalledTimes(2);
    expect(harness.createSource).toHaveBeenCalledTimes(1);
    expect(harness.resume).toHaveBeenCalledTimes(1);
  });
});

describe('player audio media synchronization', () => {
  const activeFrame: PlayerAudioFrame = {
    active: true,
    audible: true,
    sourceTime: 12,
    linearGain: 2,
  };

  it('seeks, follows preview rate and plays without taking over the clock', () => {
    const { controller, setGain } = makeController();
    const { element, play, pause } = makeAudioElement(3);

    syncPlayerAudioElement({
      element,
      frame: activeFrame,
      playing: true,
      playbackRate: 1.5,
      controller,
    });

    expect(element.currentTime).toBe(12);
    expect(element.playbackRate).toBe(1.5);
    expect(setGain).toHaveBeenCalledWith(element, 2);
    expect(play).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
  });

  it('does not fight small playback jitter with repeated hard seeks', () => {
    const { controller } = makeController();
    const { element } = makeAudioElement(11.95);

    syncPlayerAudioElement({
      element,
      frame: activeFrame,
      playing: true,
      playbackRate: 1,
      controller,
    });

    expect(element.currentTime).toBe(11.95);
  });

  it('seeks while paused and pauses immediately outside or muted inside the block window', () => {
    const { controller, setGain } = makeController();
    const { element, play, pause } = makeAudioElement(3);

    syncPlayerAudioElement({
      element,
      frame: activeFrame,
      playing: false,
      playbackRate: 1,
      controller,
    });
    expect(element.currentTime).toBe(12);
    expect(play).not.toHaveBeenCalled();

    void element.play();
    syncPlayerAudioElement({
      element,
      frame: { ...activeFrame, audible: false, linearGain: 0 },
      playing: true,
      playbackRate: 1,
      controller,
    });
    expect(pause).toHaveBeenCalledTimes(1);
    expect(setGain).toHaveBeenLastCalledWith(element, 0);
  });
});
