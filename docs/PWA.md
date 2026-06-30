# Helm PWA Installability

`CLIENT-12` makes the web client installable as the boat-screen companion app while keeping the
OpenCPN/C++ engine as the source of live navigation truth.

## Runtime Contract

- `web/index.html` links `web/manifest.webmanifest`, sets `viewport-fit=cover`, and declares
  standalone/mobile metadata for desktop, Android, iOS, and iPadOS launch surfaces.
- `web/manifest.webmanifest` uses `display: "standalone"`, `start_url: "./"`, `scope: "./"`, the
  Helm icon set, and dark `theme_color` / `background_color` values that match the chart shell.
- `web/sw.js` precaches the manifest and icon assets with the app shell. Live endpoints such as
  `/nav`, `/health`, AIS, alarms, weather, and route APIs remain network-only so stale navigation
  state stays explicit.

## iOS And iPadOS Storage Caveat

Treat iOS/iPadOS PWA storage as boat-convenience cache, not safety storage. Cache Storage,
IndexedDB, OPFS, and localStorage share browser-managed origin quota; the OS can evict cached web
data under pressure, and private/sandboxed modes can reduce or deny persistence. Helm must therefore
continue to show visible stale/offline/out-of-coverage states and must not promise that downloaded
packs are permanent unless a later native/offline task has verified the device storage path.

Practical rules for follow-on offline work:

- Keep the installed app shell small and reloadable before any chart or weather pack is present.
- Record pack provenance, size, and last verification time in the UI before marking a pack usable.
- Re-check stored packs at launch and after reconnect instead of trusting a previous successful
  download.
- Surface eviction or quota failures as user-visible warnings; never silently fall back to old data.
