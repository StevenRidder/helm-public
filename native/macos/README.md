# Helm macOS native client

`HelmMac` is the first NATIVE-4 macOS client slice. It is a SwiftUI/AppKit app that speaks the
documented Helm boat-server protocol over the local network:

- discovers `_helm._tcp` Bonjour services and supports a manual `127.0.0.1:9001` fallback;
- opens `/nav` with `URLSessionWebSocketTask`;
- sends `hello`, `conn.list`, and `conn.upsert`;
- configures a macOS serial/USB NMEA input using the CONN-9 contract:
  `type="serial"`, `address="/dev/cu.*"`, and `port=<baud>`.

The app does not link OpenCPN, wxWidgets, `engine/vendor`, or the GPL engine. The boat-side
`helm-server` remains the safety core and owns persisted connections at `~/.helm/connections.json`.

## Build

```sh
native/macos/build-macos-client.sh
```

The script builds on a private DerivedData path under `native/macos/build`, with signing disabled.
It does not start a Helm server and never touches the shared live `:8080` screen.

For an end-to-end manual check, start a private server first:

```sh
scripts/start-helm.sh --port 9001
```

Then run the `HelmMac` scheme in Xcode or open the built app from
`native/macos/build/Build/Products/Debug/HelmMac.app`.
