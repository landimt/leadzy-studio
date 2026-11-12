# Changelog

All notable changes to Leadzy Studio are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Video-layer and clip color controls with explicit HLG/PQ-to-SDR conversion,
  six color presets, warmth, and compact effect/speed indicators. Color runs
  before graphics and subtitles; presets preserve the source conversion.
- Agent handoff context with project, selection, cursor, save/conflict state
  and locks, plus updated portable Studio skills for Codex and Claude.
- Processed audio waveforms in base clips and live receipt synchronization for
  CLI renders; silent video sources now produce valid flat waveforms.

- `studio transcript words <folder> --source <id> [--from --to --grep
--block --json]`: word-level source times, and with `--block` the exact
  base-track `{ in, out }` covering the words in the window — 50/80 ms of
  air, clamped so the cut never lands inside a neighbouring word.
- `studio suggest --accept <ids> / --reject <ids> / --accept-all` settles
  recorded suggestions from the CLI as one document change; `suggest` now
  prints each suggestion id and the resulting `editHash` (`--json` too).
- `studio status --json` → `media[]`: every media file in the folder with
  duration, width/height, fps, audio and the `sourceId` that references it (`null`
  when `edit.json` does not declare it); the text status names undeclared
  files. `studio open` now declares every video it finds as a source, not
  only the first one.
- `studio --version`.
- Timeline: a pin toggle next to the magnet keeps the playhead where it is
  while you select blocks, pick cues or nudge an edge, so repeated trims are
  judged against the same frame; the ruler, the arrow keys and the transcript
  still move it. Remembered per browser.
- NVIDIA hardware path, the Windows/Linux counterpart of VideoToolbox: when a
  one-frame probe opens an NVENC session, preview and program renders encode
  with `h264_nvenc` and sources decode on `-hwaccel cuda` (if `ffmpeg
-hwaccels` lists it). Listings alone prove nothing: builds carry NVENC and
  cuda on machines without an NVIDIA card. `studio doctor` names the decoder
  in use.
- `studio render --quality recommended|high|max` and `--encoder
libx264|h264_videotoolbox|h264_nvenc`: the final quality and encoder the
  render engine already supported, now reachable from the CLI; an unknown
  value stops the command instead of falling back to the default.

### Changed

- Previews (and the player's program render) read video from the 540p
  proxy the player already uses whenever it is fresh; audio still comes
  from the original, and the final never touches the proxy. `studio open`
  now halves high source frame rates in the new document (59.94 → 29.97,
  60 → 30) — every encode did twice the work for no visible gain on a
  talking head; `fps` stays editable. The UI no longer auto-renders the
  program on a freshly opened project until the first edit (from the UI
  or the agent) or an existing program.
- Renders decode the source on the hardware decoder (`-hwaccel
videotoolbox`) whenever `ffmpeg -hwaccels` offers it — frames are
  bit-identical for H.264/HEVC 4:2:0 and 4:2:2 (ProRes and 4:4:4 differ
  only below ~70 dB PSNR), and on a 4K60 HEVC take the segment stage runs
  2.3× faster (software decode alone was slower than real time and
  dominated every render). CLI previews now use the fast encoder like the
  UI's. `LEADZY_STUDIO_SOFTWARE_DECODE=1` keeps the CPU decoder;
  `studio doctor` reports which decoder renders will use.

### Fixed

- Audio crossfades between short blocks no longer depend on the FFmpeg
  version. FFmpeg 7.1 mishandles a chain of `acrossfade` filters when the
  clips are under ~0.4s: the joined audio came out a different length on
  each run, truncated or with no stream at all, and the render then failed
  at the concat step. The run is now built from per-clip triangular fades
  placed in samples and summed with `amix`, which matches the chain within
  rounding (max 3/32768 on a 20-cut run against FFmpeg 9.0).
- The desktop app's `~/.local/bin/studio` bridge fed its own entry script
  to the first command (`open` got `main.js` as a folder), so every command
  failed: Commander switches to Electron argv parsing whenever
  `process.versions.electron` exists, even under `ELECTRON_RUN_AS_NODE`.
  The CLI now parses argv explicitly as node. `studio doctor` runs the
  bridge on PATH (`--version`) instead of trusting that the file exists, and
  reports a bridge that does not answer as an error.
- An `edit.json` still carrying `subtitles.corrections[].wordIndex` fails
  with a hint that says what to rewrite (`{ source, at, text }`) instead of
  only the raw schema issue.
- The split and trim-at-playhead buttons grey out where they have nothing to
  cut (the playhead on a block edge or past the end), and splitting on an
  edge no longer records an identical document as an undoable change.
- Windows: the Studio now runs end to end from source (CLI, browser UI,
  render, `electron-forge start`). Media and waveforms no longer answer 403
  (path containment compared against a hard-coded `/`); copying a source no
  longer reports tampering (`fs.stat` by path reports `dev` 0 there);
  publishing a render no longer fails with `EPERM` (Windows only flushes a
  writable handle); `bin/studio.js` runs tsx through Node instead of spawning
  its `.cmd` shim; "reveal in folder" selects the file in Explorer; agent,
  ffmpeg and bridge lookup find `.cmd`/`.exe` commands instead of shelling out
  to `which`; `studio open` no longer drops a URL with `&` on `cmd start`.
  `better-sqlite3` is no longer compiled on install, nor rebuilt for Electron
  on Windows: it ships Node-API prebuilds for every platform, and compiling
  needed a C++ toolchain that a Windows machine usually lacks. See [Windows setup](docs/troubleshooting.md#windows-setup).

### Removed

- Local Whisper transcription (`studio transcribe --whisper`, `studio qa
--whisper`, the `transcriptionEngine` preference, `WHISPER_MODEL` and the
  Whisper entries in Settings and in the Transcribe workspace). ElevenLabs
  Scribe is the only engine: the editor cuts by word and needs verbatim text
  with word timestamps, which Whisper does not give. `POST /api/jobs/transcribe`
  and `/api/jobs/qa` no longer take an `engine`; a transcript cache written by
  Whisper is ignored and the media is transcribed again.

### Changed

- **Existing transcript caches are retired.** The cache is now
  `edit/transcripts/<media file name>.json` (the extension is part of the
  name, so `take.mp4` and `take.m4a` no longer share one file) and carries
  the Scribe model plus the media and keyterms fingerprints; anything older
  is ignored, the media shows as untranscribed and the next `studio
transcribe` bills it again. Dev phase: no migration.

### Changed

- `subtitles.corrections[]` address the word by a source time inside it
  (`at`) instead of `wordIndex`; a correction now survives a
  re-transcription and can be written straight from the transcript pack.
  Existing `wordIndex` corrections are rejected by the schema (dev phase,
  no migration). The pack header is in English and the pack ends with a
  `# corrections:` line when the source has any.

### Fixed

- `studio qa` hears a final rendered with `output.speed ≠ 1` slowed back to
  natural speed before comparing it with the sources (the engine misread
  homophones in sped-up speech: "atendido" came back as "entendido" and
  failed `block-edges-intact` for weeks), and a block-edge word that came
  back one letter off, or with its onset swapped, is reported as a
  homophone instead of a missing word. A render snapshot
  (`edit/cache/final.edit.json`) this version cannot read now fails QA
  with a clear message instead of silently comparing the final against the
  current document.

### Added

- `studio library list | add | import | bake`: the personal overlay library
  from the terminal, so an agent never has to POST to the local server.
  `import` appends the overlay block and `bake` re-renders a parametric
  piece with new values; both print the new `editHash` with `--json`. The
  HTTP routes and the CLI share one implementation
  (`src/application/library.ts`).
- `studio suggest` and the cuts tab record `false-start` candidates: a word
  Scribe cut off mid-way (`me--`) followed within 4 s by the phrase
  restarting, from the first repeated word up to the restart. A repetition
  that lies inside a false start is not listed twice. Spoken director notes
  stay a judgment call for the agent — the guide now makes scanning for
  them a mandatory step.
- Transcription runs on Scribe v2 with verbatim output made explicit and
  `transcription.keyterms` from
  `edit.json` (brand, product and people names the transcript must spell
  right; billed as a 20% surcharge). The cache records the model, the
  keyterms fingerprint and the time; a cache whose media file or keyterms
  changed since is refreshed by `studio transcribe`, `--force` (or
  `{ "force": true }` on `POST /api/jobs/transcribe`) redoes every media,
  and replaced source caches are kept under `edit/history/transcripts/` (the
  five most recent per media). The media identity for this cache is its
  content (size plus a sample of the first and last MiB), so copying or
  syncing a project never triggers a re-transcription. A media that lost its
  audio has its old transcript retired to the same folder and forgotten by
  the search index. `studio status --json` gains
  `keyterms` and `transcripts[]`; `GET /api/project` media entries gain
  `transcriptState`. The upload is 16 kHz AAC through the bundled ffmpeg
  (it used to be a WAV read whole into memory through whatever `ffmpeg` was
  on the PATH), with a timeout, retries on 429/5xx, and a 401 reported as
  an invalid key instead of the raw response. The pre-flight estimate uses
  the current list price (US$ 0.22/h) and appears in the Transcribe
  workspace. A 401 caused by an account without credits is reported as
  such instead of as an invalid key; a spoken word Scribe leaves without
  timing keeps its place by borrowing its neighbours' gap instead of being
  dropped. No language hint is sent: Scribe detects the spoken language.

- Hardware H.264 encoding (`h264_videotoolbox`) for previews and the program
  whenever ffmpeg offers it; the final export keeps libx264.
- A render profile for the program (`edit/program.mp4`; `layers: 'omit'` on
  `POST /api/jobs/render`): the base cut with camera effects, canvas and the
  export's audio chain, without overlays, subtitles or layer video. Its receipt
  keys on the program projection, so browser-composed edits never make it
  stale; `GET /api/project` reports `hasProgram` and `programKey`.
- The automatic preview now renders the program in the background, and never
  retries a document whose render failed until its program projection changes.
- Player modes: simulation, engine (the program drives playback while layers,
  overlays and subtitles stay live) and proof (the burned preview, identical to
  the export), with a badge and a proof toggle in the transport.
- Desktop: the cause of any `500 internal_error` answered by the local server
  is written to `server.log` in the app's log folder (next to `updates.log`).

### Removed

- The migration of the pre-release v1 cut list (`edit/edl.json`, `"version": 1`).
  It was never shipped; a folder still carrying one is opened as a new project.

### Changed

- Errors that escape a route now answer `500 { "error": "internal_error", "message": "internal error" }`
  instead of Fastify's default body, which embedded the underlying error
  message (and with it, on file-system failures, an absolute path). Fastify's
  own request errors keep their status under `invalid_request` (400),
  `payload_too_large` (413) or `unsupported_media_type` (415) — including a
  URL that is not valid percent-encoding, which Fastify used to answer with
  its own body echoing the URL — and the cause of a 500 is printed to the
  server's stderr. Cross-origin requests refused by the local
  API answer `403 forbidden` with a message.
- HTTP error responses are moving to `{ "error": "<code>", "message": "<english>" }`,
  one route at a time; the client translates the code, and `message` is the
  fallback for agents and scripts. Routes not yet migrated still answer with a
  Portuguese sentence in `error`. Migrated so far: `POST /api/settings`,
  `GET|PUT /api/edit`, `POST /api/history/restore`, `POST /api/reveal`,
  `POST /api/jobs/render`, `POST /api/jobs/audio-preview`, `GET /api/transcript/*`,
  `POST /api/jobs/transcribe|qa|suggest`, `GET /api/search`, `POST /api/media/import`,
  `GET /api/media/*`, `GET /api/peaks/*`, and every `/api/library*` and
  `/api/jobs/title|library-overlay` route.
- `PUT /api/edit` answers `422 invalid_edit_document` (message carries the
  validation detail), `428 if_match_required`, `409 edit_conflict` (with
  `currentHash`) or `409 project_busy`. `GET /api/edit` answers
  `404 edit_document_missing` without the project path. The conflict message
  is now in English.
- `POST /api/history/restore` rejects a body without a non-empty string `id`
  with `400 invalid_body` (it used to answer 404); an unknown id answers
  `404 history_entry_not_found`, a corrupt snapshot `422 invalid_history_entry`,
  and a project locked by another process `409 project_busy` (it used to be a
  500).
- `POST /api/reveal` answers `400 invalid_body` for a body without a
  non-empty string `path` and `400 path_outside_project` for a path that
  escapes the project or does not exist (both were a bare 400); a
  file-manager failure answers `500 reveal_failed`.
- `POST /api/jobs/render` answers `400 invalid_render_options`,
  `409 render_in_progress`, and — for a project without an `edit.json` —
  `404 edit_document_missing` instead of 422 (a project whose `edit.json` is
  not parseable JSON is reported the same way); a document that fails the
  schema still answers 422 (`invalid_edit_document`). `POST /api/jobs/audio-preview`
  answers `409 audio_preview_in_progress`.
- `POST /api/jobs/transcribe` and `/api/jobs/qa` reject an `engine` other than
  `scribe` or `whisper` with `400 invalid_body` (it used to be passed through);
  `POST /api/jobs/suggest` rejects a non-numeric `thresholdDb` or a
  non-positive `minSilenceS` the same way (a numeric string used to be
  coerced silently and a non-numeric one reached the analysis as `NaN`). All
  three reject a JSON `null` body. `GET /api/search` rejects a repeated `q`
  with `400 invalid_query`. Running jobs answer `409 transcription_in_progress`,
  `qa_in_progress` or `analysis_in_progress`; a missing transcript answers
  `404 transcript_not_found`. The media name is looked up as the router
  decoded it; it used to be decoded a second time, which failed the request
  for a lone `%` and misrouted names containing `%XX`.
- `POST /api/media/import` answers `ambiguous_filename`, `invalid_filename`,
  `unsupported_extension` (415), `invalid_upload_size`, `upload_too_large`
  (413), `empty_upload`, `incomplete_upload` or `invalid_media` (422); a
  server-side import failure is a content-free 500 instead of a Portuguese
  sentence, and an upload sent with a content type other than
  `application/octet-stream` answers `415 unsupported_media_type` (it used to
  crash the handler). `GET /api/media/*` and `GET /api/peaks/*` answer
  `403 path_outside_project`; a waveform build failure is a content-free 500
  (its ffmpeg output used to be sent to the client). The media path is used
  as the router decoded it instead of being decoded a second time.
- Library routes: `POST /api/jobs/title`, `/api/library/import` and
  `/api/library/save` parse their bodies with Zod and answer `400 invalid_body`
  on a wrong shape: an unknown title style or a non-string name used to be
  coerced silently, and a title card with a zero duration, a negative start,
  a negative or fractional block index or an empty track id used to fail
  later inside the job or land on the wrong track. Codes: `title_in_progress`, `regeneration_in_progress`,
  `library_block_not_found`, `library_item_not_found`, `variables_mismatch`,
  `timing_variable_conflict`, `timing_out_of_range`, `file_outside_edit_dir`,
  `path_outside_project`, `invalid_library_item`, `library_template_missing`,
  `library_template_mismatch`, `library_template_unsafe` (messages keep the
  detail). A library file name is served as the router decoded it.
  `POST /api/jobs/library-overlay` on a project without an `edit.json` answers
  404 instead of 400. Server-side failures (removing an item, copying an
  asset, a failed commit) are content-free 500s reported through the error
  handler.
- `POST /api/settings` rejects a non-object JSON body (a string, number,
  `null` or array) and a request without a body with `400 invalid_body`; it
  used to treat them as `{}` and answer 200. A rejected key answers
  `400 invalid_api_key`, and a failure to write the config file is a
  content-free `500 internal_error` reported through the error handler. Malformed JSON is still
  rejected by the framework before the route runs.
