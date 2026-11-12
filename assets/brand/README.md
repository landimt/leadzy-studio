# Leadzy Studio brand assets

The names and marks Leadzy and Leadzy Studio belong to Leadzy. Their use is
governed by the repository's [trademark policy](../../docs/legal/TRADEMARKS.md); the AGPL
software license does not grant permission to present a fork or derivative as
an official Leadzy product.

`leadzy-studio-mark-4096.png` is the approved canonical mark. Keep its
transparency, proportions and gradient unchanged. `leadzy-studio-mark.svg` is
the faithful vector derivative used by the in-app navigation, startup screen
and scalable browser surfaces.

Run `node scripts/build-logo.mjs` on macOS after replacing the canonical mark.
The generator updates every product-icon surface:

- `src/client/assets/icon-leadzy-studio.png` — 512 px raster compatibility asset;
- `public/` — favicon, PWA, Apple touch, Safari mask and Windows tile assets;
- `build/icon.icns` — Electron/macOS application icon;
- `build/desktop-icon.png` — desktop-icon preview.

The dark square exists only for maskable/install surfaces that require an
opaque safe area. The regular mark remains transparent everywhere else.
