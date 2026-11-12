import type { ApiErrorCode } from '../server/routes/apiError.js';
import { apiErrorMessage, isApiErrorCode } from './i18n/index.js';
import type { EditDoc } from '../core/schema.js';
import type { RenderArtifactKind, RenderLayers, RenderQuality } from '../core/render/options.js';
import type { Transcript } from '../core/transcript.js';
import type { WaveformPeaks } from '../core/peaks.js';
import type { QaReport } from '../core/qaDiff.js';
import type { JobType, ServerEvent } from '../server/jobs.js';
import type { MediaSummary } from '../core/media.js';

export type { MediaSummary } from '../core/media.js';

/** Browser-visible subset of a completed render job's SSE result. */
export interface RenderJobResult {
  readonly outputRel: string;
  readonly durationS: number;
  readonly editHash: string;
  /** False for emergency CLI/API overrides that must remain stale in Studio. */
  readonly canonical: boolean;
  /** Optional collision-safe copy created outside the project for delivery. */
  readonly deliveryPath?: string;
  readonly deliveryName?: string;
  readonly kind: RenderArtifactKind;
  /** Program projection of the rendered snapshot; `programOutdated` compares the live document against it. */
  readonly programKey: string;
}

export type HistoryOrigin = 'ui' | 'title' | 'suggest' | 'restore' | 'agent' | 'startup';

export interface HistoryEntry {
  readonly id: string;
  readonly ts: string;
  readonly origin: HistoryOrigin;
  readonly hash: string;
  readonly totalDurationS: number;
  readonly blocks: number;
}

import { LIBRARY_ITEM_KINDS, type LibraryItemKind } from '../core/libraryKinds.js';

/** The key itself NEVER travels back — only presence, source and a masked tail. */
export interface SettingsInfo {
  readonly elevenLabs: {
    readonly present: boolean;
    readonly source: 'env' | 'config' | null;
    readonly maskedTail: string | null;
    /** The config slot holds a key — even when the env var is shadowing it. */
    readonly configured: boolean;
  };
  readonly preferences: SettingsPreferences;
  readonly tools: {
    readonly hyperframes: { readonly ok: boolean; readonly message: string };
  };
}

export interface SettingsPreferences {
  readonly locale: 'pt-BR' | 'en';
  readonly defaultProjectDir: string | null;
  readonly exportMode: 'project' | 'folder' | 'ask';
  readonly exportDirectory: string | null;
  readonly exportFilenamePattern: string;
  readonly revealAfterExport: boolean;
}

export const DEFAULT_SETTINGS_PREFERENCES: SettingsPreferences = {
  locale: 'pt-BR',
  defaultProjectDir: null,
  exportMode: 'project',
  exportDirectory: null,
  exportFilenamePattern: '{project}',
  revealAfterExport: false,
};

const UNAVAILABLE_SETTINGS_TOOLS: SettingsInfo['tools'] = {
  hyperframes: { ok: false, message: 'reinicie o aplicativo para verificar' },
};

/** Keeps the new client usable while an already-open desktop server restarts. */
function normalizeSettingsInfo(info: SettingsInfo): SettingsInfo {
  const transitional = info as Omit<SettingsInfo, 'preferences' | 'tools'> &
    Partial<Pick<SettingsInfo, 'preferences' | 'tools'>>;
  return {
    ...info,
    preferences: {
      ...DEFAULT_SETTINGS_PREFERENCES,
      ...(transitional.preferences ?? {}),
    },
    tools: transitional.tools ?? UNAVAILABLE_SETTINGS_TOOLS,
  };
}

export { LIBRARY_ITEM_KINDS };
export type { LibraryItemKind };

/** One `{{NAME}}` placeholder a parametric item exposes for editing. */
interface LibraryItemVariable {
  readonly name: string;
  readonly label?: string;
  readonly default: string;
}

export interface LibraryItem {
  readonly id: string;
  readonly name: string;
  readonly kind: LibraryItemKind;
  readonly file: string;
  readonly durationS?: number;
  readonly tags?: readonly string[];
  readonly createdAt: string;
  /** One line of "when to use this piece", written by whoever saved it. */
  readonly description?: string;
  /** Filename of the item's HyperFrames source, present on parametric pieces. */
  readonly template?: string;
  /** Present with `template` on parametric pieces: the values the Studio can re-bake with. */
  readonly variables?: readonly LibraryItemVariable[];
  readonly hasPreview: boolean;
  /** Best preview filename inside the item folder (animated webp > frozen png), or null. */
  readonly preview: string | null;
}

export interface ProjectInfo {
  readonly projectDir: string;
  readonly media: readonly MediaSummary[];
  readonly images: readonly string[];
  readonly doc: EditDoc | null;
  readonly editHash: string | null;
  /** Hash of the edit snapshot that produced edit/preview.mp4, or null when absent/unknown. */
  readonly previewEditHash: string | null;
  /** Hash of the edit snapshot that produced edit/audio-preview.m4a. */
  readonly audioPreviewEditHash: string | null;
  /** Whether the validated A/B receipt still matches the document's audible projection. */
  readonly audioPreviewCurrent: boolean;
  readonly warnings: readonly string[];
  readonly apiKeyPresent: boolean;
  readonly ffmpeg: { readonly ok: boolean; readonly message: string };
  readonly hasPreview: boolean;
  readonly hasAudioPreview: boolean;
  /** Both the untreated and processed audio proofs exist for a real A/B comparison. */
  readonly hasAudioComparison: boolean;
  readonly hasFinal: boolean;
  /** `edit/program.mp4` exists (the player's engine-mode source). */
  readonly hasProgram: boolean;
  /** `programKey(doc)` of the snapshot that produced program.mp4; null without a valid receipt. */
  readonly programKey: string | null;
  readonly agents: { readonly claude: boolean; readonly codex: boolean };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly currentHash: string | undefined,
    readonly code?: ApiErrorCode,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorResponseBody {
  error?: string;
  message?: string;
  currentHash?: string;
}

/**
 * Localizes a failed response. A known `error` code maps to the dictionary;
 * otherwise the server's own text is shown (routes not yet migrated still
 * send a sentence in `error`).
 */
export function toApiError(
  body: ErrorResponseBody | null,
  status: number,
  statusText: string,
): ApiError {
  const code = isApiErrorCode(body?.error) ? body.error : undefined;
  const fallback = body?.message ?? body?.error ?? `${String(status)} ${statusText}`;
  return new ApiError(
    code === undefined ? fallback : apiErrorMessage(code, fallback),
    status,
    body?.currentHash,
    code,
  );
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorResponseBody | null;
    throw toApiError(body, response.status, response.statusText);
  }
  return response.json() as Promise<T>;
}

type MediaImportProgress = (uploadedBytes: number, totalBytes: number) => void;

function importMedia(
  file: File,
  onProgress?: MediaImportProgress,
): Promise<{ item: MediaSummary }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `/api/media/import?filename=${encodeURIComponent(file.name)}`);
    request.responseType = 'json';
    request.setRequestHeader('content-type', 'application/octet-stream');
    if (onProgress !== undefined) {
      request.upload.addEventListener('progress', (event) => {
        onProgress(event.loaded, event.lengthComputable ? event.total : file.size);
      });
    }
    request.addEventListener('load', () => {
      const body = request.response as ({ item?: MediaSummary } & ErrorResponseBody) | null;
      if (request.status >= 200 && request.status < 300 && body?.item !== undefined) {
        resolve({ item: body.item });
        return;
      }
      reject(toApiError(body, request.status, request.statusText));
    });
    request.addEventListener('error', () => {
      reject(new ApiError('não foi possível enviar a mídia', 0, undefined));
    });
    request.addEventListener('abort', () => {
      reject(new ApiError('importação cancelada', 0, undefined));
    });
    request.send(file);
  });
}

export const api = {
  getProject: (): Promise<ProjectInfo> => fetch('/api/project').then((r) => json<ProjectInfo>(r)),

  importMedia,

  getEdit: (): Promise<{ doc: EditDoc; hash: string }> =>
    fetch('/api/edit').then((r) => json<{ doc: EditDoc; hash: string }>(r)),

  putEdit: (doc: EditDoc, expectHash: string): Promise<{ hash: string }> =>
    fetch('/api/edit', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': expectHash },
      body: JSON.stringify(doc),
    }).then((r) => json<{ hash: string }>(r)),

  getTranscript: (relPath: string): Promise<Transcript | null> =>
    fetch(`/api/transcript/${encodeURIComponent(relPath)}`).then((r) =>
      r.ok ? (r.json() as Promise<Transcript>) : null,
    ),

  getPeaks: (relPath: string): Promise<WaveformPeaks> =>
    fetch(`/api/peaks/${encodeURIComponent(relPath)}`).then((r) => json<WaveformPeaks>(r)),

  mediaUrl: (relPath: string): string => `/api/media/${encodeURIComponent(relPath)}`,

  // No loudnorm flag: normalization is the doc's decision (output.loudnormLufs);
  // the emergency override lives in the CLI only (--no-loudnorm).
  // Browser renders are always canonical: composition choices (including
  // captions and audio) come from edit.json. Emergency overrides stay CLI-only.
  startRender: (options: {
    preview: boolean;
    /** `null` keeps the final inside the project even when the preferences deliver to a folder. */
    deliveryDirectory?: string | null;
    layers?: RenderLayers;
    quality?: RenderQuality;
    subtitles?: boolean;
    reveal?: boolean;
    filenamePattern?: string;
  }): Promise<{ id: number }> =>
    fetch('/api/jobs/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(options),
    }).then((r) => json<{ id: number }>(r)),

  startAudioPreview: (): Promise<{ id: number }> =>
    fetch('/api/jobs/audio-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then((r) => json<{ id: number }>(r)),

  startTranscribe: (): Promise<{ id: number }> =>
    fetch('/api/jobs/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then((r) => json<{ id: number }>(r)),

  startTitle: (body: {
    text: string;
    style: 'dark' | 'paper' | 'plain';
    pos: 'top' | 'center';
    at: number;
    durationS: number;
    trackId?: string;
    blockIndex?: number;
  }): Promise<{ id: number }> =>
    fetch('/api/jobs/title', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<{ id: number }>(r)),

  startLibraryOverlay: (body: {
    trackId: string;
    blockIndex: number;
    /** The block's current file, so a shifted index cannot retarget the bake. */
    file: string;
    /** The block's current `at` — twins share the file, the position tells them apart. */
    at: number;
    variables: Readonly<Record<string, string>>;
  }): Promise<{ id: number }> =>
    fetch('/api/jobs/library-overlay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<{ id: number }>(r)),

  startSuggest: (): Promise<{ id: number }> =>
    fetch('/api/jobs/suggest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then((r) => json<{ id: number }>(r)),

  getHistory: (): Promise<{ entries: HistoryEntry[] }> =>
    fetch('/api/history').then((r) => json<{ entries: HistoryEntry[] }>(r)),

  restoreHistory: (id: string): Promise<{ hash: string }> =>
    fetch('/api/history/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    }).then((r) => json<{ hash: string }>(r)),

  getSettings: (): Promise<SettingsInfo> =>
    fetch('/api/settings')
      .then((r) => json<SettingsInfo>(r))
      .then(normalizeSettingsInfo),

  saveSettings: (payload: {
    elevenLabsApiKey?: string | null;
    preferences?: Partial<SettingsPreferences>;
  }): Promise<SettingsInfo> =>
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then((r) => json<SettingsInfo>(r))
      .then(normalizeSettingsInfo),

  getLibrary: (): Promise<{ items: LibraryItem[] }> =>
    fetch('/api/library').then((r) => json<{ items: LibraryItem[] }>(r)),

  libraryFileUrl: (id: string, filename: string): string =>
    `/api/library/file/${encodeURIComponent(id)}/${encodeURIComponent(filename)}`,

  deleteLibraryItem: (id: string): Promise<void> =>
    fetch(`/api/library/${encodeURIComponent(id)}`, { method: 'DELETE' })
      .then((r) => json<{ removed: true }>(r))
      .then(() => undefined),

  importLibraryItem: (id: string, at: number): Promise<{ hash: string }> =>
    fetch('/api/library/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, at }),
    }).then((r) => json<{ hash: string }>(r)),

  saveToLibrary: (payload: {
    file: string;
    name: string;
    kind: LibraryItemKind;
    durationS?: number;
  }): Promise<{ item: LibraryItem }> =>
    fetch('/api/library/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((r) => json<{ item: LibraryItem }>(r)),

  revealPath: (path: string): Promise<void> =>
    fetch('/api/reveal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    })
      .then((r) => json<{ ok: true }>(r))
      .then(() => undefined),

  subscribe: (onEvent: (event: ServerEvent) => void): (() => void) => {
    const source = new EventSource('/api/events');
    source.onmessage = (message: MessageEvent<string>) => {
      onEvent(JSON.parse(message.data) as ServerEvent);
    };
    return () => {
      source.close();
    };
  },
};

export type { JobType, QaReport, ServerEvent };
