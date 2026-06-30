# Helm Icon v01 Package

Selected source: `../variants/helm-icon-variant-01-clean-reference.png`

This package is ready to drop into Apple app projects:

- `ios/HelmIcon.appiconset/` - iOS/iPadOS Xcode asset catalog icon set
- `macos/HelmIcon.appiconset/` - macOS Xcode asset catalog icon set
- `macos/HelmIcon.iconset/` - macOS iconset PNG source
- `macos/HelmIcon.icns` - macOS `.icns`
- `source/HelmIcon-v01-iOS-1024.png` - opaque iOS master
- `source/HelmIcon-v01-macOS-transparent-1024.png` - transparent macOS master
- `source/HelmIcon-v01-cropped-master-2048.png` - high-resolution cropped source

The iOS package is RGB/opaque. The macOS package keeps transparency outside the icon/shadow.

To use it, copy the relevant `HelmIcon.appiconset` folder into your app target's
`Assets.xcassets`, then set the target's App Icon source to `HelmIcon` in Xcode.
For a non-Xcode macOS bundle, use `macos/HelmIcon.icns`.

Generated crop box from the source image: `(31, 40, 1221, 1230)`.

Regenerate with:

```bash
python3 docs/design/app-icons/package_selected_variant.py
```
