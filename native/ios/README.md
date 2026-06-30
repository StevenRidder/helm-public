# Helm iOS WKWebView proof

`HelmWebViewProof` is the web-first iPad/iPhone proof shell. It is intentionally small:

- discovers the boat-side `helm-server` with Bonjour service type `_helm._tcp`;
- resolves the service host/port and reads `tls`, `name`, and `fp`/`fingerprint` TXT values when
  present;
- loads the existing Helm web UI in `WKWebView`;
- reports whether the loaded web client sees WebGPU, WebGL2/WebGL, MapLibre, service worker support,
  viewport size, device scale, and safe-area insets;
- keeps the GPL/OpenCPN engine off the iPad/iPhone and speaks only HTTP/WebSocket through the web UI.

This is not a SwiftUI/Metal chart rewrite. `NATIVE-5` uses this shell as the decision gate: keep
MapLibre GL JS + WebGPU in the shared web client unless the capability report proves a hard iPad
limit that justifies native MapLibre/Metal later.

## Build

```sh
native/ios/build-ios-proof.sh
```

The script builds the app for an iOS Simulator SDK with signing disabled. It does not start or touch
the live Helm server on `:8080`.

## Run manually

1. Start a private Helm server, for example:

   ```sh
   scripts/start-helm.sh --port 9001
   ```

2. Open `native/ios/HelmWebViewProof.xcodeproj` in Xcode.
3. Run the `HelmWebViewProof` scheme on an iPad or iPhone simulator/device.
4. Use Bonjour discovery when a `_helm._tcp` service is visible, or the manual fallback
   `http://127.0.0.1:9001/` in Simulator.
5. Check the "Web renderer gate" section. A passing web-first path shows MapLibre loaded and either
   WebGPU available or an explicit WebGL fallback for the current Helm layer set.

The Info.plist scopes local-network permissions to Bonjour/local-network use. Plain HTTP is allowed
only for local-network development via `NSAllowsLocalNetworking`; the production path remains the
pinned-TLS/TOFU flow described in `docs/STREAMING-API.md`.
