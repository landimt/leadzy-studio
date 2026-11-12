# Third-party notices

Leadzy Studio distributes separate `ffmpeg` and `ffprobe` command-line
executables in its official desktop packages. They are not linked into the
Leadzy Studio executable.

The current macOS media-tool build is provided by
[Martin Riedl](https://ffmpeg.martin-riedl.de/) and reports FFmpeg 9.0.1 with GPL
and version 3 components enabled. FFmpeg is a trademark of Fabrice Bellard and
the FFmpeg project is licensed under the LGPL 2.1 or later, with optional GPL
components that make a particular build GPL-covered.

The setup script uses immutable provider URLs and verifies these SHA-256
digests before extraction:

| macOS architecture      | Artifact      | SHA-256                                                            |
| ----------------------- | ------------- | ------------------------------------------------------------------ |
| Apple Silicon (`arm64`) | `ffmpeg.zip`  | `8287a1b2229e05eb41859f073e18e6c52c60a778f2f5e6881070fe51b79407fe` |
| Apple Silicon (`arm64`) | `ffprobe.zip` | `102a26b8940a053298d9929bfaae71e4b6ef65ba5f19a99a88c433108560741a` |
| Intel (`amd64`)         | `ffmpeg.zip`  | `5bdead62ff504ab9b447cc72b212c4fb481e3f7de5877d427a51bee8136dda40` |
| Intel (`amd64`)         | `ffprobe.zip` | `34511bbcf1988ad2886023bf5ace4f44cf62e6defeb3d194d6f7619e5b061f7f` |

- FFmpeg legal information: <https://ffmpeg.org/legal.html>
- FFmpeg source: <https://ffmpeg.org/download.html#get-sources>
- Build scripts used by the binary provider:
  <https://git.martin-riedl.de/ffmpeg/build-script>

When publishing an installer, keep this notice with the application and host
the exact corresponding FFmpeg source/build information alongside the binary
download. This file is informational and is not legal advice.

## Windows media tools and embedded browser

Windows packages include FFmpeg/FFprobe 9.0.1 essentials from
[Gyan Doshi's official archive](https://github.com/GyanD/codexffmpeg/releases/tag/9.0.1), with its `LICENSE` copied to
`FFMPEG-LICENSE.txt`. The versioned archive is
`ffmpeg-9.0.1-essentials_build.zip`; its verified SHA-256 is
`fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9`.
The provider identifies corresponding FFmpeg source at
[bf1b838f2a](https://github.com/FFmpeg/FFmpeg/commit/bf1b838f2a).
Retain its corresponding source and build information with the release as above.

Desktop packages also include the Chrome Headless Shell revision pinned by
HyperFrames (currently 152.0.7977.30), copied with its full accompanying license
and notice files under `resources/browser`. This avoids a browser download
for the first local composition render. Content that references CDN assets
still requires network access.

## Fonts

Leadzy Studio bundles the Inter and Arimo font families through Fontsource.
Both font families are licensed under the SIL Open Font License 1.1.

- Inter: <https://github.com/rsms/inter>
- Arimo: <https://github.com/googlefonts/Arimo>
- SIL Open Font License 1.1: <https://openfontlicense.org/open-font-license-official-text/>

## MPL-licensed rendering components

Leadzy Studio uses unmodified releases of `@resvg/resvg-js` and `satori`, both
published under the Mozilla Public License 2.0. Their exact versions are
recorded in `pnpm-lock.yaml`; corresponding source and license texts are
available from their upstream repositories below.

- resvg-js: <https://github.com/yisibl/resvg-js>
- Satori: <https://github.com/vercel/satori>
- Mozilla Public License 2.0: <https://www.mozilla.org/MPL/2.0/>

## Other packaged dependencies

Electron and the packaged production dependencies retain their own license and
notice files in the application bundle. Most direct JavaScript dependencies
are MIT-licensed; their authoritative package manifests and license files
govern. This notice highlights non-MIT components but does not replace those
files.

The built-in title-card template currently fetches GSAP 3.14.2 from jsDelivr
when that optional template is rendered. GSAP remains under its own license:
<https://gsap.com/licensing/>. This external runtime dependency is planned to
be removed or vendored only after its distribution terms are reviewed.
