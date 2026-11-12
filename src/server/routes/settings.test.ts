import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_USER_PREFERENCES,
  type UserPreferences,
  type UserPreferencesPatch,
} from '../services/userConfig.js';
import { registerSettingsRoutes, type SettingsRouteDeps } from './settings.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

function preferencesWith(patch: UserPreferencesPatch): UserPreferences {
  return {
    locale: patch.locale ?? DEFAULT_USER_PREFERENCES.locale,
    defaultProjectDir: patch.defaultProjectDir ?? DEFAULT_USER_PREFERENCES.defaultProjectDir,
    exportMode: patch.exportMode ?? DEFAULT_USER_PREFERENCES.exportMode,
    exportDirectory: patch.exportDirectory ?? DEFAULT_USER_PREFERENCES.exportDirectory,
    exportFilenamePattern:
      patch.exportFilenamePattern ?? DEFAULT_USER_PREFERENCES.exportFilenamePattern,
    revealAfterExport: patch.revealAfterExport ?? DEFAULT_USER_PREFERENCES.revealAfterExport,
  };
}

function createDeps() {
  let preferences = { ...DEFAULT_USER_PREFERENCES };
  const userConfig: SettingsRouteDeps['userConfig'] = {
    elevenLabsKey: vi.fn(() => Promise.resolve(undefined)),
    setElevenLabsKey: vi.fn(() => Promise.resolve()),
    preferences: vi.fn(() => Promise.resolve(preferences)),
    setPreferences: vi.fn((patch: UserPreferencesPatch) => {
      preferences = preferencesWith({ ...preferences, ...patch });
      return Promise.resolve(preferences);
    }),
  };
  return { userConfig };
}

describe('settings routes: preferences', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.restoreAllMocks();
  });

  async function createApp() {
    const deps = createDeps();
    app = Fastify({ logger: false });
    registerSettingsRoutes(app, deps);
    await app.ready();
    return { app, ...deps };
  }

  it('returns resolved preference defaults', async () => {
    const { app: server } = await createApp();
    const res = await server.inject({ method: 'GET', url: '/api/settings' });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ preferences: UserPreferences }>().preferences).toEqual(
      DEFAULT_USER_PREFERENCES,
    );
  });

  it('accepts a partial preference patch and returns the merged settings', async () => {
    const { app: server, userConfig } = await createApp();
    const patch = {
      exportMode: 'folder' as const,
      exportDirectory: '/Users/tester/Exports',
      revealAfterExport: false,
    };
    const res = await server.inject({
      method: 'POST',
      url: '/api/settings',
      headers: JSON_HEADERS,
      payload: { preferences: patch },
    });

    expect(res.statusCode).toBe(200);
    expect(userConfig.setPreferences).toHaveBeenCalledWith(patch);
    expect(res.json<{ preferences: UserPreferences }>().preferences).toEqual({
      ...DEFAULT_USER_PREFERENCES,
      ...patch,
    });
  });

  it.each([
    { preferences: { exportDirectory: 'relative/path' } },
    { preferences: { exportFilenamePattern: 'line one\nline two' } },
    { preferences: { revealAfterExport: 'yes' } },
    { preferences: { locale: 'es' } },
  ])('rejects invalid preferences with a safe 400 response', async (payload) => {
    const { app: server, userConfig } = await createApp();
    const res = await server.inject({
      method: 'POST',
      url: '/api/settings',
      headers: JSON_HEADERS,
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'invalid_body',
      message: 'request body must be a JSON object',
    });
    expect(userConfig.setPreferences).not.toHaveBeenCalled();
  });
});
