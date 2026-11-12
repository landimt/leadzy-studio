import { describe, expect, it } from 'vitest';
import { transcriptionExtractArgs } from './audio.js';

describe('transcriptionExtractArgs', () => {
  it('extracts 16 kHz mono AAC without a tempo filter at natural speed', () => {
    const args = transcriptionExtractArgs('/p/take.mp4', '/p/edit/transcripts/take.mp4.json.m4a');
    expect(args).not.toContain('-af');
    expect(args.slice(-8)).toEqual(
      [
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'aac',
        '-b:a',
        '64k',
        '/p/edit/transcripts/take.mp4.json.m4a',
      ].slice(-8),
    );
    expect(args).toEqual(expect.arrayContaining(['-vn', '-i', '/p/take.mp4']));
  });

  it('slows a sped-up final back down with one atempo filter', () => {
    const args = transcriptionExtractArgs('/p/final.mp4', '/p/out.m4a', { tempo: 1 / 1.1 });
    const at = args.indexOf('-af');
    expect(args[at + 1]).toBe('atempo=0.909091');
  });

  it('refuses a tempo a single atempo cannot express', () => {
    expect(() => transcriptionExtractArgs('/p/a', '/p/b', { tempo: 0.4 })).toThrow(RangeError);
    expect(() => transcriptionExtractArgs('/p/a', '/p/b', { tempo: 2.5 })).toThrow(RangeError);
  });
});
