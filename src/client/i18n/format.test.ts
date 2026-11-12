import { describe, expect, it } from 'vitest';
import { tf } from './index.js';

describe('tf', () => {
  it('fills every placeholder and leaves an unknown one visible', () => {
    expect(tf('player.render.segments', { done: '8', total: '25' })).toBe('8/25 segmentos');
    expect(tf('player.render.steps', { done: '57' })).toBe('passo 57/{total}');
  });
});
