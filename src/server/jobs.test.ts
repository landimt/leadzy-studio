import { describe, expect, it, vi } from 'vitest';
import { JobManager } from './jobs.js';

describe('JobManager reconnect snapshots', () => {
  it('tracks current progress and removes a job before its terminal broadcast', async () => {
    const jobs = new JobManager();
    let finish: (value: string) => void = () => undefined;
    let report: (message: string) => void = () => undefined;
    const terminalSnapshots: number[] = [];
    jobs.onEvent((event) => {
      if (event.kind === 'job' && event.state === 'done') {
        terminalSnapshots.push(jobs.runningJobs().length);
      }
    });

    jobs.start(
      'audio-preview',
      (progress) =>
        new Promise<string>((resolve) => {
          report = progress;
          finish = resolve;
        }),
    );
    expect(jobs.runningJobs()).toMatchObject([{ type: 'audio-preview', state: 'running' }]);

    report('normalizar áudio');
    expect(jobs.runningJobs()).toMatchObject([
      { type: 'audio-preview', state: 'running', progress: 'normalizar áudio' },
    ]);

    finish('ok');
    await vi.waitFor(() => {
      expect(jobs.runningJobs()).toEqual([]);
    });
    expect(terminalSnapshots).toEqual([0]);

    // A retained callback from a settled worker cannot resurrect the job.
    report('tarde demais');
    expect(jobs.runningJobs()).toEqual([]);

    // Nor may it overwrite a newer job of the same type.
    let finishReplacement: (value: string) => void = () => undefined;
    const replacementId = jobs.start(
      'audio-preview',
      () =>
        new Promise<string>((resolve) => {
          finishReplacement = resolve;
        }),
    );
    expect(replacementId).not.toBeNull();
    report('progresso velho');
    expect(jobs.runningJobs()).toEqual([
      { kind: 'job', id: replacementId, type: 'audio-preview', state: 'running' },
    ]);

    finishReplacement('novo');
    await vi.waitFor(() => {
      expect(jobs.runningJobs()).toEqual([]);
    });
  });
});
