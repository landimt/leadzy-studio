import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ELEVEN_LABS_API_KEY_SCHEMA,
  resolveElevenLabsApiKey,
  USER_PREFERENCES_PATCH_SCHEMA,
  type UserPreferences,
  type UserConfig,
} from '../services/userConfig.js';
import { sendApiError } from './apiError.js';

export interface SettingsRouteDeps {
  readonly userConfig: Pick<
    UserConfig,
    'elevenLabsKey' | 'setElevenLabsKey' | 'preferences' | 'setPreferences'
  >;
  readonly inspectTools?: () => Promise<{
    readonly hyperframes: { readonly ok: boolean; readonly message: string };
  }>;
}

interface SettingsResponse {
  elevenLabs: {
    present: boolean;
    source: 'env' | 'config' | null;
    maskedTail: string | null;
    /** The config slot holds a key — even when an env var is shadowing it. */
    configured: boolean;
  };
  preferences: UserPreferences;
  tools: {
    hyperframes: { ok: boolean; message: string };
  };
}

const settingsBodySchema = z.object({
  // `null` and '' both clear the stored key; an absent field leaves it as is
  elevenLabsApiKey: z.union([ELEVEN_LABS_API_KEY_SCHEMA, z.literal(''), z.null()]).optional(),
  preferences: USER_PREFERENCES_PATCH_SCHEMA.optional(),
});

const INVALID_API_KEY_MESSAGE =
  'elevenLabsApiKey must be a string of 8–200 characters without whitespace or control characters, or null to clear it';

export function registerSettingsRoutes(app: FastifyInstance, deps: SettingsRouteDeps): void {
  const { userConfig } = deps;

  async function currentSettings(): Promise<SettingsResponse> {
    const { key, source } = await resolveElevenLabsApiKey();
    const configured = (await userConfig.elevenLabsKey()) !== undefined;
    const tools = deps.inspectTools
      ? await deps.inspectTools()
      : {
          hyperframes: { ok: false, message: 'não verificado' },
        };
    return {
      elevenLabs: {
        present: key !== undefined,
        source,
        // an env key can be arbitrarily short — masking a 4-char key would
        // round-trip it whole, so only mask when the tail is a real fragment
        maskedTail: key !== undefined && key.length >= 8 ? `…${key.slice(-4)}` : null,
        configured,
      },
      preferences: await userConfig.preferences(),
      tools,
    };
  }

  app.get('/api/settings', async () => currentSettings());

  app.post('/api/settings', async (request, reply) => {
    const parsed = settingsBodySchema.safeParse(request.body);
    if (!parsed.success) {
      const keyRejected = parsed.error.issues.some((issue) => issue.path[0] === 'elevenLabsApiKey');
      return keyRejected
        ? sendApiError(reply, 400, 'invalid_api_key', INVALID_API_KEY_MESSAGE)
        : sendApiError(reply, 400, 'invalid_body', 'request body must be a JSON object');
    }
    const { elevenLabsApiKey, preferences } = parsed.data;
    // a write failure carries the config path; the error handler keeps it off the wire and reports it
    if (elevenLabsApiKey !== undefined) await userConfig.setElevenLabsKey(elevenLabsApiKey);
    if (preferences !== undefined) await userConfig.setPreferences(preferences);
    return currentSettings();
  });
}
