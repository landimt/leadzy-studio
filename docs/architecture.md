# Architecture

Leadzy Studio is one local application with several adapters around the same
file-based edit model. It is intentionally not a monorepo.

```text
React UI ──HTTP/SSE──> Fastify server ──> application services ──> FFmpeg/files
   │                         │                       │
   └──────── edit.json <─────┴──── CLI / AI agent ──┘
                                   │
                              SQLite search index

Electron = desktop launcher + protected IPC + packaged local server
```

## Directory map

| Path               | Responsibility                                                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/`        | Edit schema, timeline math, render planning, subtitles, migrations, and other reusable rules.                                                                                                              |
| `src/application/` | Use cases shared by the HTTP server and the CLI (transcribe, suggest cuts, apply an edit document).                                                                                                        |
| `src/server/`      | Local Fastify API, jobs, filesystem/media services, rendering, history, and project locking.                                                                                                               |
| `src/client/`      | React editor: `features/` (one folder per area: player, timeline, inspector…), `components/` (reusable only: the `ui/` kit, `Hint`, `UiIcon`, `StudioDialog`), `state/`, `i18n/`, and the HTTP/SSE client. |
| `src/cli/`         | Command-line adapter and agent-facing workflows.                                                                                                                                                           |
| `src/db/`          | Rebuildable SQLite index for projects and transcript search.                                                                                                                                               |
| `electron/`        | Desktop lifecycle, launcher, restricted preload bridge, updates, and native dialogs.                                                                                                                       |
| `templates/`       | Runtime templates copied or rendered by the application.                                                                                                                                                   |
| `scripts/`         | Build, icon, portable-media-tool, signing, and notarization helpers.                                                                                                                                       |
| `example/`         | Generator for synthetic local demo media. No real footage belongs here.                                                                                                                                    |
| `docs/`            | Contributor and distribution documentation, not runtime code.                                                                                                                                              |

## Source of truth

Each creative owns an `edit/edit.json`. The UI, CLI, and agents all operate on
that document. Writes are validated, atomic, history-backed, and protected by
an optimistic edit hash. Original media is immutable; derived files belong in
`edit/` unless the user explicitly imports new media.

SQLite is an index, not the edit source of truth. It must always be possible to
rebuild it from project files.

## Render kinds and player modes

ffmpeg is the only engine for what defines the result. `src/core/render` plans
three artifacts from the same document: the **program** (`edit/program.mp4`,
`layers: 'omit'`) — base cuts, joints, speed, camera effects, canvas and the
full audio chain, rendered in the background a few seconds after edits settle;
the **preview** (`edit/preview.mp4`) — everything burned, on demand; and the
**final** (`edit/final.mp4`). Preview and program use the hardware H.264
encoder when ffmpeg offers one; the final always uses libx264.

Each artifact carries a receipt. The program's freshness is a projection, not
a hash: `programKey(doc)` (`src/core/render/freshness.ts`) covers only what
the program reads, so overlay, subtitle and layer-geometry edits never
invalidate it.

The player (`src/client/features/player`) has three states, decided by
`resolvePlaybackMode`: **simulation** (nothing fresh rendered — the browser
imitates the edit), **engine** (the program is the clock and the picture;
layers, overlays and subtitles stay in the DOM so their gizmos keep working)
and **proof** (the burned preview, identical to the export, with every DOM
layer off). In engine and proof the rendered file drives the playhead
(`engineClock.ts`); the playhead only wins on a real seek. What the browser
still composes reads the same rules as the plan (`src/core/overlayPlacement.ts`,
`buildSubtitleCues`), so the simulation cannot drift from the export.

## Dependency direction

New reusable rules should enter `src/core`. Platform work belongs in server
services; HTTP and CLI should remain adapters around those services. Avoid
adding new imports from `src/server` into `src/core`, or from React components
into server modules.

Use cases that both the CLI and the HTTP server run live in `src/application`.
`src/server` and `src/application` never import `src/cli`; the CLI may depend on
server services. The lint configuration enforces that direction
(`no-restricted-imports`).

## UI contract

Anything visual follows [`docs/design.md`](design.md): theme roles instead of
color literals, the density scale, the contrast floor and the known CSS traps.
Change the document first, then the component.

## HTTP errors

Error responses carry a stable code and an English message:
`{ "error": "invalid_api_key", "message": "…" }`. Codes live in
`src/server/routes/apiError.ts`; the client maps each code to a localized
string in `src/client/i18n/index.ts` (`toApiError` in `src/client/api.ts`), so
adding a code means adding its translation. Messages never echo request input.
Routes still answering with a Portuguese sentence in `error` are being migrated
one per commit (see `CHANGELOG.md`).

## Large modules

`Timeline.tsx`, `store.ts`, and `server/routes/library.ts`
are established hotspots. Refactor them incrementally along existing domain
boundaries, with behavior-preserving tests, instead of combining their split
with unrelated features.
