# Leadzy Studio roadmap

This roadmap communicates direction, not guaranteed dates. Open an issue before
starting a large item so design and licensing constraints can be agreed first.

## Now — public beta foundation

- Make the repository, contributor workflow, privacy boundaries, and release
  process ready for public participation.
- Ship a signed and notarized Apple Silicon installer.
- Keep transcript-first editing, local project files, render parity, history,
  and QA reliable as the feature surface grows.

## Now — single-engine preview

What the player shows must be what the export produces. ffmpeg stays the one
engine; the browser only composes what the user manipulates. In order:

0. Hardware encoding on the fast path: `h264_videotoolbox` for previews,
   proxies and the program render on Apple Silicon, `libx264` kept for the
   final file, software fallback when the encoder is absent.
1. A `program` render profile (`core/render`): cuts, joints, speed, camera
   effects and the whole audio chain, with overlays, titles, library pieces,
   layers and subtitles omitted — `edit/program.mp4` at preview resolution.
2. A program receipt keyed on the base projection of the document, so moving
   an overlay or editing a caption does not invalidate it.
3. Background program rendering through the existing auto-preview gate,
   debounced after save, serialized by the job manager.
4. The player in three explicit states: simulation (originals with block
   jumps, while nothing is rendered), engine (program.mp4 plus live DOM layers
   — the working default; gizmos keep working), and proof (everything burned,
   the old preview.mp4, for the final check). The state is always visible.
5. Parity tests: overlay geometry between the DOM compositor and ffmpeg's
   `overlay` filter; subtitle timing from the same plan; audio/video sync with
   speed ≠ 1.
6. Incremental program rendering: one cached clip per base block (hash of
   source, in/out, camera effects and the local audio chain), one cached step
   per joint, denoise per clip, a single-pass loudness measure for the
   program (two-pass stays on export), and a remux concat — so cutting a word
   re-renders two clips and one joint, and layer or caption edits render
   nothing. The queue starts at the playhead and works outward.

Then the render adjustments that stop being blocked by the above: the
`filter_complex` split into cacheable steps, the audio proof folded into the
program render (kept as an A/B tool), and audio processing shown as track
effects (see Next).

## Next — local intelligence and editorial control

- Speaker-aware editing and diarization across both cloud and local engines.
- Manual word-timing adjustment with validation and history.
- Filler-word detection and reviewable removal suggestions.
- Local speech cleanup evaluation, including DeepFilterNet, with audible A/B
  proof and no automatic destructive processing.
- Reusable, sanitized demo project and a guided first-edit experience.
- Audio processing as visible track effects: denoise, loudness, de-click,
  joint crossfades and per-clip gain/fades move from global output settings to
  effects on the audio track, shown as chips and markers on the timeline;
  gain, fades, ducking and crossfades become audible in the player through
  Web Audio, while denoise and two-pass loudness keep the rendered audio proof.
- An effect registry: each effect (schema, defaults, ffmpeg filter, inspector
  fields, labels) declared in one place instead of across eight files, so a
  built-in effect is one module. Once the single-engine preview lands, an
  effect no longer needs a browser reimplementation to be seen, which is what
  makes user-defined effects possible: a definition file per effect — video or
  audio, e.g. a colour tone or a voice treatment — that an agent can write,
  loaded from `~/.leadzy-studio/effects/` or the project, under an allowlist of
  ffmpeg filters with numeric, bounded parameters (never a raw filtergraph) and
  files confined to the effect's own folder; the overlay library is the
  precedent for no-code pieces.

## Later — interchange, automation, and platforms

- Timeline interchange for DaVinci Resolve, Premiere Pro, Final Cut Pro, and
  AAF after one internal timeline contract can represent each target safely.
- Assisted short-form extraction that proposes clips, hooks, and aspect-ratio
  variants without silently changing the source edit.
- Windows and Linux desktop packaging after the CLI/browser paths and bundled
  media toolchain are reproducible on those platforms.
- Optional agent/provider integrations for Ollama, OpenAI, and Claude behind a
  provider-neutral contract, explicit consent, and clear data-flow labeling.

## Architecture work that should stay incremental

- Done in the pre-release restructure: the application layer, routes with
  explicit dependencies, the store split into pure document edits, the
  stylesheet and render-planner splits, and Zod-validated requests with a
  shared `{ error, message }` contract.
- Still to do: split `Timeline.tsx` and `Player.tsx` by lane/hook, break
  `planRender` into phases, and share response and event schemas between server
  and UI (requests are already validated on the server).
