# Helm native core

`native/` is the App-Store-clean client-side C++ seam for Helm native clients. It is deliberately
not the OpenCPN engine and deliberately does not include `engine/vendor`, `wxWidgets`, OpenCPN
headers, chart rendering, serial drivers, or networking.

The boat still owns safety-critical navigation in the C++ `helm-server` process. Native Apple
clients link this small core to consume the documented HTTP/WebSocket protocol:

- snapshot/delta nav-state reduction from `docs/STREAMING-API.md`;
- explicit LIVE/LAGGING/STALE/OFFLINE age classification;
- TOFU/pairing trust metadata storage shape from `CONTRACT-14`;
- no transport/channel implementation yet, so NATIVE-1 depends on the core protocol, not channel
  optimization.

That boundary keeps GPL/wx/OpenCPN code out of iOS/iPadOS clients while still letting every client
share the same deterministic reducer and safety-state rules.

## Build

```sh
./native/test-native-core.sh
```

Or directly:

```sh
cmake --preset macos-debug -S native
cmake --build --preset macos-debug
ctest --test-dir native/build/macos-debug --output-on-failure
```

Apple static-library presets are provided for the first native compile gate:

```sh
cmake --preset ios-simulator-release -S native
cmake --build --preset ios-simulator-release
cmake --preset iphoneos-release -S native
cmake --build --preset iphoneos-release
```

The iOS presets build only `libhelm_native_core.a`; tests remain macOS-hosted.

## Native clients

- `ios/` contains the web-first iPad/iPhone proof app. It does not reimplement the chart client and
  does not embed the GPL/OpenCPN engine. It discovers a boat-side `helm-server` advertised as
  `_helm._tcp` over Bonjour, loads the existing Helm web UI in a `WKWebView`, and reports the
  browser/GPU capabilities that decide whether MapLibre GL JS + WebGPU is sufficient before any
  native MapLibre/Metal work is justified.
- `macos/` contains the first SwiftUI/AppKit macOS client. It discovers/connects to a boat-side
  `helm-server` and sends the CONN-9 serial NMEA `conn.upsert` command without linking OpenCPN or
  touching the live `:8080` screen.

Both client build scripts disable signing and do not start any Helm runtime.
