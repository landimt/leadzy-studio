import { describe, expect, it } from 'vitest';
import { containedPath, isInsideEditDir } from './paths.js';
import { buildPeaks, resamplePeaks } from './peaks.js';

describe('containedPath', () => {
  const dir = '/projects/creative';

  it('resolves simple relative paths', () => {
    const result = containedPath(dir, 'edit/edit.json');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('/projects/creative/edit/edit.json');
  });

  it('rejects traversal above the project', () => {
    expect(containedPath(dir, '../secrets.txt').ok).toBe(false);
    expect(containedPath(dir, 'edit/../../other').ok).toBe(false);
  });

  it('normalizes internal .. that stays inside', () => {
    const result = containedPath(dir, 'edit/../camera.mp4');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('/projects/creative/camera.mp4');
  });

  it('splices a Windows project folder with backslashes, not a mongrel path', () => {
    const result = containedPath('C:\\creative', 'edit/edit.json');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('C:\\creative\\edit\\edit.json');
  });

  it('splices a UNC project folder with backslashes', () => {
    const result = containedPath('\\\\server\\share\\creative', 'edit/edit.json');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('\\\\server\\share\\creative\\edit\\edit.json');
  });

  it('drops a trailing separator of either kind before splicing', () => {
    const posix = containedPath('/projects/creative/', 'edit/edit.json');
    expect(posix.ok).toBe(true);
    if (posix.ok) expect(posix.value).toBe('/projects/creative/edit/edit.json');
    const windows = containedPath('C:\\creative\\', 'edit/edit.json');
    expect(windows.ok).toBe(true);
    if (windows.ok) expect(windows.value).toBe('C:\\creative\\edit\\edit.json');
  });

  it('rejects absolute paths and null bytes', () => {
    expect(containedPath(dir, '/etc/passwd').ok).toBe(false);
    expect(containedPath(dir, 'C:\\windows\\system32').ok).toBe(false);
    expect(containedPath(dir, 'edit/\0evil').ok).toBe(false);
  });
});

describe('isInsideEditDir', () => {
  it('accepts only paths under edit/', () => {
    expect(isInsideEditDir('edit/edit.json')).toBe(true);
    expect(isInsideEditDir('edit')).toBe(true);
    expect(isInsideEditDir('camera.mp4')).toBe(false);
    expect(isInsideEditDir('editor/x')).toBe(false);
  });

  it('normalizes before checking — traversal cannot dress up as edit/', () => {
    expect(isInsideEditDir('edit/../camera.mp4')).toBe(false);
    expect(isInsideEditDir('edit/../../etc/passwd')).toBe(false);
    expect(isInsideEditDir('./edit/assets/x.png')).toBe(true);
    expect(isInsideEditDir('edit/assets/../subtitles/master.srt')).toBe(true);
    expect(isInsideEditDir('../edit/x')).toBe(false);
    expect(isInsideEditDir('/edit/x')).toBe(false);
    expect(isInsideEditDir('edit/a\0b')).toBe(false);
  });
});

describe('peaks', () => {
  it('captures min/max per window and resamples for zoom', () => {
    const sampleRate = 1000;
    const samples = new Float32Array(1000);
    samples[5] = 0.9; // spike in the first 10ms window
    samples[995] = -0.7; // dip in the last window
    const peaks = buildPeaks(samples, sampleRate, 10);
    expect(peaks.min).toHaveLength(100);
    expect(peaks.max[0]).toBeCloseTo(0.9, 3);
    expect(peaks.min[99]).toBeCloseTo(-0.7, 3);

    const zoomed = resamplePeaks(peaks, 0, 1, 10);
    expect(zoomed.max[0]).toBeCloseTo(0.9, 3);
    expect(zoomed.min[9]).toBeCloseTo(-0.7, 3);
  });
});
