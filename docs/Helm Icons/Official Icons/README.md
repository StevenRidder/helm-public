# Helm App Icon Direction

Status: first design pass

## Product Signal

Helm should not look like a generic boating app or a Kubernetes-adjacent wheel mark. The
strongest visual claim in the codebase is the fused chart: S-52/ENC truth, satellite-aware
context, weather, AIS, routing, and instruments on one offline-first screen.

The icon therefore uses the chart itself as the brand object:

- dark S-52 water and depth contours from the canonical Helm night/dusk palette
- a route-magenta passage line, matching Helm's route styling (`#d6219a` in the mockups)
- a cyan own-ship arrow, matching Helm's live position/source accent
- mint weather streamlines, echoing the own-GRIB weather layer
- a small tan land/shoal signal so it reads as marine navigation rather than generic maps

## Competitive Read

The nearby product category leans heavily on blue rounded squares, compass ticks, waves,
sails, initials, and literal map pins. Helm should borrow only the instant marine read:
blue/cyan water, navigation geometry, and high contrast. It should avoid the common
wave/compass/sail vocabulary and avoid copying any existing mark.

## Platform Treatments

### iOS / iPadOS

Use `ios.appiconset/` for Xcode. The source is a square, opaque PNG; iOS applies the mask.
The composition is deliberately simple enough to survive at SpringBoard sizes:

- route line and own-ship arrow are the dominant read
- contours and streamlines stay secondary
- no text, numbers, or app-name lettering
- generous safe area around the own-ship arrow

### macOS

Use `HelmAppIcon.icns` or the generated `macos.iconset/` source. The macOS variant keeps
the same mark, but presents it as a lifted chart tile with a bevel and soft shadow so it
has Dock presence without becoming skeuomorphic.

## Generated Files

Run:

```bash
python3 docs/design/app-icons/generate_app_icons.py
```

Outputs:

- `helm-ios-app-icon-1024.png` - master iOS source, square and opaque
- `helm-ios-app-icon-preview.png` - rounded preview only
- `helm-macos-app-icon-1024.png` - master macOS transparent PNG
- `helm-app-icon-size-test.png` - small-size preview sheet
- `ios.appiconset/` - Xcode iOS app icon asset catalog contents
- `macos.iconset/` - macOS iconset PNGs
- `HelmAppIcon.icns` - macOS `.icns`, generated with `iconutil` or the Pillow fallback

## Next Pass

The likely next refinement is to test the mark at 16, 20, 29, 40, 60, and 128 px against
real macOS and iOS home-screen backgrounds. If the route line dominates too much at the
smallest sizes, thin the magenta stroke by 10-15 percent and enlarge the own-ship arrow.
