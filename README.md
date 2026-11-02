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
pnpm app:dev       # desktop app (window + hot reload)
pnpm storybook     # component preview (http://localhost:6006)
pnpm android:dev   # Android on a connected device
pnpm app:build     # desktop release build
pnpm android:build # android release build
```

Run `pnpm run` for all scripts. Lint/format hooks run automatically on commit;
`pnpm hooks` runs them manually.

## Testing

```sh
pnpm test          # frontend suites
pnpm rust-test     # Rust suites
pnpm e2e:env       # Docker host for the end-to-end suite
pnpm e2e:android   # Android suite against the mock host
pnpm e2e:real      # the same suite against a real provider
```

The end-to-end suite needs a debug APK and a device; `e2e/README.md` holds the
fixed flow, the cases, and the real-provider key file.
