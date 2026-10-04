# Pie

A cross-platform GUI for [Pi](https://github.com/earendil-works/pi), mobile
first.

Built with [Tauri 2](https://tauri.app/) + React + TypeScript.

## Versioning

Pie tracks the Pi version it is built against: the project version always
matches the latest [Pi release](https://github.com/earendil-works/pi/releases).

## Development

The environment is managed with [devenv](https://devenv.sh) and activated
automatically by [direnv](https://direnv.sh) when you enter the project
directory. It provides Rust (stable via rust-overlay, mold linker), pnpm, the
Android SDK/NDK, and all Tauri Linux system dependencies.

```sh
just dev          # desktop app (window + hot reload)
just storybook    # component preview (http://localhost:6006)
just android-dev   # Android on a connected device
just build         # desktop release build
just android-build # android release build
```

Run `just --list` for all recipes. Lint/format hooks run automatically on
commit; `just hooks` runs them manually.
