import { describe, expect, it } from 'vitest';
import { integrationReadiness } from '../agentIntegration.js';
import { bridgeCheck, diagnoseInstallation, probeBridge, studioVersion } from './doctor.js';

type Runner = (
  path: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

const answering =
  (stdout: string): Runner =>
  () =>
    Promise.resolve({ stdout, stderr: '' });

describe('studioVersion', () => {
  it('reads the semver from the package manifest', () => {
    expect(studioVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('probeBridge', () => {
  it('accepts a bridge that answers --version with this Studio version', async () => {
    const calls: string[][] = [];
    const runner: Runner = (path, args) => {
      calls.push([path, ...args]);
      return Promise.resolve({ stdout: '0.1.0\n', stderr: '' });
    };
    const probe = await probeBridge('/bin/studio', '0.1.0', runner);
    expect(probe).toStrictEqual({ ok: true, version: '0.1.0' });
    expect(calls).toEqual([['/bin/studio', '--version']]);
  });

  it('flags the Electron bridge that fed its own script path to the first command', async () => {
    const failing: Runner = () =>
      Promise.reject(
        Object.assign(new Error('Command failed with exit code 1'), {
          stderr: "error: unknown option '--version'\n(Did you mean --verbose?)",
        }),
      );
    const probe = await probeBridge('/bin/studio', '0.1.0', failing);
    expect(probe).toStrictEqual({ ok: false, detail: "error: unknown option '--version'" });
  });

  it('names a hang for what it is when the bridge is killed by the timeout', async () => {
    const hanging: Runner = () =>
      Promise.reject(Object.assign(new Error('Command failed'), { killed: true, stderr: '' }));
    expect(await probeBridge('/bin/studio', '0.1.0', hanging)).toStrictEqual({
      ok: false,
      detail: 'did not answer --version within 15s',
    });
  });

  it('flags a bridge that runs another Studio version or prints nothing', async () => {
    expect(await probeBridge('/bin/studio', '0.2.0', answering('0.1.0\n'))).toStrictEqual({
      ok: false,
      detail: 'answers "0.1.0" to --version, this Studio is 0.2.0',
    });
    expect(await probeBridge('/bin/studio', '0.2.0', answering(''))).toStrictEqual({
      ok: false,
      detail: 'prints nothing for --version',
    });
  });
});

describe('bridgeCheck', () => {
  it('warns when no bridge is on PATH', () => {
    expect(bridgeCheck(null, null)).toMatchObject({ id: 'bridge', status: 'warning' });
    expect(bridgeCheck(null, null).message).toContain('global command missing');
  });

  it('passes a bridge that answered with its version', () => {
    expect(bridgeCheck('/bin/studio', { ok: true, version: '0.1.0' })).toStrictEqual({
      id: 'bridge',
      status: 'ok',
      label: 'Studio CLI',
      message: '/bin/studio (0.1.0)',
    });
  });

  it('fails a bridge that exists but does not run — a file on PATH is not a working CLI', () => {
    const check = bridgeCheck('/bin/studio', { ok: false, detail: "unknown option '--version'" });
    expect(check.status).toBe('error');
    expect(check.message).toBe(
      "/bin/studio is broken — unknown option '--version'; reinstall it from the Home screen or run pnpm link --global in the clone",
    );
  });
});

describe('diagnoseInstallation', () => {
  it('never reports the bridge as missing while one is on PATH', async () => {
    const integration = await integrationReadiness();
    if (integration.bridgePath === null) return;
    const bridge = (await diagnoseInstallation()).find((check) => check.id === 'bridge');
    expect(bridge?.status).not.toBe('warning');
    expect(bridge?.message).toContain(integration.bridgePath);
  });
});
