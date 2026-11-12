# Getting started

This guide gets a contributor from a fresh checkout to a safe synthetic
project. Leadzy Studio is currently a beta: the desktop build targets Apple
Silicon, while the source workflow is tested primarily on macOS and Linux.

## 1. Prepare the checkout

Install Node.js 22.14.0, enable Corepack, and clone the repository:

```bash
corepack enable
git clone https://github.com/landimt/leadzy-studio.git
cd leadzy-studio
make setup
```

`make setup` installs only local dependencies and tools. It does not install a
global command or write agent skills into your home directory. Run
`make bridge` separately if you want those optional integrations.

## 2. Open a synthetic project

The demo generator creates two short test-pattern clips under the ignored
`example/media/` directory:

```bash
pnpm example:build
pnpm studio open example/media
```

No personal footage, API key, or network transcription is needed to inspect
the editor, make manual cuts, or render this example.

## 3. Open your own footage

Point the Studio at a dedicated creative folder containing video files:

```bash
pnpm studio open /absolute/path/to/my-creative
```

Leadzy Studio never overwrites existing source media. Editor state, caches,
previews, history, and final renders live under the creative's `edit/`
directory. An import explicitly requested through the UI may add a new,
collision-safe media file to that creative folder.

## 4. Configure transcription

Transcription uses ElevenLabs Scribe (verbatim, word-level timestamps).
Configure its key in Settings or in the repository's ignored `.env` file, then:

```bash
pnpm studio transcribe /path/to/creative
```

Manual cuts, pause suggestions and rendering work without a key.

## 5. Optional editable pieces and title cards

Parametric library pieces and generated title cards use the pinned HyperFrames
CLI shipped with the Studio. `HYPERFRAMES_BIN` remains available as a
development-only override when testing another local build.

## 6. Verify a contribution

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

See [CONTRIBUTING.md](../.github/CONTRIBUTING.md) before opening a pull request and
[troubleshooting.md](troubleshooting.md) if setup or media probing fails.
