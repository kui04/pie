# desktop app dev (window + hot reload)
dev:
    pnpm tauri dev

# frontend dev server only (http://localhost:1420)
web:
    pnpm dev

# release build
build:
    pnpm tauri build

# android dev on a connected device
android-dev:
    pnpm tauri android dev

# android release build
android-build:
    pnpm tauri android build

# eslint
lint:
    pnpm lint

# prettier --write .
format:
    pnpm format

# cargo check
check:
    cd src-tauri && cargo check

# cargo clippy (warnings are errors)
clippy:
    cd src-tauri && cargo clippy -- -D warnings

# run all git hooks on all files
hooks:
    prek run --all-files