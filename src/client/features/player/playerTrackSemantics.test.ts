import { describe, expect, it } from 'vitest';
import { effectivePlayerLayerAudio, isPlayerTrackVisible } from './playerTrackSemantics.js';

describe('Player track semantics', () => {
  it('omits only tracks explicitly persisted as hidden', () => {
    expect(isPlayerTrackVisible({})).toBe(true);
    expect(isPlayerTrackVisible({ hidden: false })).toBe(true);
    expect(isPlayerTrackVisible({ hidden: true })).toBe(false);
  });

  it('lets track mute override every block audio mode', () => {
    expect(effectivePlayerLayerAudio(true, 'mute')).toBe('mute');
    expect(effectivePlayerLayerAudio(true, 'duck')).toBe('mute');
    expect(effectivePlayerLayerAudio(true, 'solo')).toBe('mute');
  });

  it('preserves block audio mode on an unmuted track', () => {
    expect(effectivePlayerLayerAudio(false, 'mute')).toBe('mute');
    expect(effectivePlayerLayerAudio(false, 'duck')).toBe('duck');
    expect(effectivePlayerLayerAudio(false, 'solo')).toBe('solo');
  });
});
