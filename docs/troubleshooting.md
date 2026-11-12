# Troubleshooting

Start with the built-in diagnostic:

```bash
pnpm doctor
```

## FFmpeg or subtitle filter missing

Leadzy Studio needs both `ffmpeg` and `ffprobe`, and FFmpeg must expose the
`subtitles` filter (libass).

```bash
ffmpeg -hide_banner -filters | grep subtitles
ffprobe -version
```

On macOS and Windows x64, `pnpm media:setup` installs the tested portable pair
under `bin/`. On Debian/Ubuntu, install the distribution FFmpeg package. A
system installation also works when both executables are on `PATH`.

## `studio` command not found

Inside the checkout, use `pnpm studio`. The global command is optional and is
installed only when you explicitly run:

```bash
make bridge
```

If the global command was installed but the shell cannot find it, check that
your pnpm global bin directory is on `PATH`. On Windows there is no `make`;
see [Windows setup](#windows-setup).

## Windows setup

There is no `make` on Windows; run the underlying scripts directly, from the
checkout, in PowerShell or Git Bash:

```powershell
pnpm install --frozen-lockfile
pnpm media:setup
pnpm build
pnpm studio doctor
```

Node must be 22.x — `doctor` fails the check on any other major.
`pnpm media:setup` prepares FFmpeg and FFprobe with libass for Windows x64.
For a system installation, use a full build with libass and put its `bin`
folder on `PATH`. See the [Windows build and validation guide](windows-distribution.pt-BR.md).

`make bridge` has no Windows equivalent either. Write the global command by
hand as `studio.cmd`, in a folder that is already on `PATH`, pinning the Node
22 that the Studio runs under:

```bat
@echo off
setlocal
set "PATH=C:\path\to\node-22;%PATH%"
node "C:\path\to\leadzy-studio\dist\node\cli\main.js" %*
```

`doctor` looks for `studio`, `claude` and `codex` under the runnable Windows
extensions, so a `.cmd` shim is found the same way a POSIX one is. Name the
file `studio.cmd` and not `studio`: an extensionless file is not a command on
Windows, and `doctor` then reports the bridge as broken.

## Windows desktop app

`pnpm desktop:start` runs the desktop shell from the checkout.
`pnpm desktop:make:win --unsigned` creates a local Windows x64 test installer;
the [Windows build and validation guide](windows-distribution.pt-BR.md) covers
packaged runtime verification and the separate signing and release gates.

## Transcribe or QA is disabled

The visual workflow currently needs an ElevenLabs Scribe key. Add it in the
desktop Settings screen or copy `.env.example` to the ignored `.env` file and
set `ELEVENLABS_API_KEY`.

## HyperFrames is unavailable

Editable library pieces and generated title cards use the pinned HyperFrames
CLI included with the Studio. If Settings reports that the motor is missing,
update or reinstall the Studio: no global npm/pnpm installation is required.
Developers may still set `HYPERFRAMES_BIN=/absolute/path/to/hyperframes` in the
ignored `.env` file to exercise another local build.

## Project does not open

- Use a dedicated folder containing at least one supported video file.
- Avoid choosing a broad folder such as Downloads or your home directory.
- Check that another Studio process is not already editing the same project.
- Read the error shown by `pnpm studio validate <folder> --json`.

## macOS blocks a local build

Only a Developer ID signed and notarized public release is intended for other
machines. A locally generated ad-hoc `.app` is a development artifact. Do not
work around Gatekeeper for a file received from somebody else.

## Stale preview or audio

The live player is an approximation. After changing the edit, regenerate the
preview. For processed audio, compare `edit/audio-preview-before.m4a` with
`edit/audio-preview.m4a`; final delivery still requires a full render and QA.
