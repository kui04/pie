#!/usr/bin/env bash
# The fixed end-to-end flow: bring the host up, check it, install the debug APK,
# run the cases, and write the report under e2e/.artifacts/.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$root/.." && pwd)"
mode="${1:-all}"
shift || true

serial="${PIE_ANDROID_SERIAL:-192.168.240.112:5555}"
apk="${PIE_APK:-$repo/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk}"

bash "$root/setup.sh"

if [ "$mode" = "real" ]; then
    envfile="$root/.testenv/real.env"
    if [ ! -f "$envfile" ]; then
        echo "e2e: copy e2e/real.env.example to $envfile and fill it in" >&2
        exit 2
    fi
    set -a
    # shellcheck disable=SC1090
    . "$envfile"
    set +a
    : "${PIE_E2E_PROVIDER:?PIE_E2E_PROVIDER is empty}"
    : "${PIE_E2E_MODEL:?PIE_E2E_MODEL is empty}"
    if [ -n "${PIE_E2E_BASE_URL:-}" ]; then
        # A local OpenAI-compatible endpoint may take no key; pi still needs a
        # value to make the model available.
        export PIE_E2E_API_KEY="${PIE_E2E_API_KEY:-none}"
    else
        : "${PIE_E2E_API_KEY:?PIE_E2E_API_KEY is empty}"
    fi
    export PIE_E2E_THINKING="${PIE_E2E_THINKING:-low}"

    # The key is mounted as a secret. It has no trailing newline, so pi can
    # read it with a plain `cat` command.
    printf '%s' "$PIE_E2E_API_KEY" > "$root/.testenv/real.key"
    chmod 600 "$root/.testenv/real.key"

    docker compose -f "$root/compose.yaml" -f "$root/compose.real.yaml" \
        up -d --build --wait --force-recreate host-real
    bash "$root/verify-real.sh"

    case "$serial" in
        *:*) adb connect "$serial" >/dev/null ;;
    esac
    if [ ! -f "$apk" ]; then
        echo "e2e: no debug APK at $apk. Build it with:" >&2
        echo "  devenv shell -- bash -lc 'pnpm tauri android build --target x86_64 --debug --apk'" >&2
        exit 2
    fi
    adb -s "$serial" install -r -t "$apk" >/dev/null
    node "$root/runners/android/run.mjs" --profile real --serial "$serial" \
        --address "pi@192.168.240.1:2223" "$@"
    exit
fi

docker compose -f "$root/compose.yaml" up -d --build --wait
bash "$root/verify-host.sh"

if [ "$mode" = "env" ]; then
    exit 0
fi

if [ "$mode" = "linux" ]; then
    for tool in tauri-driver WebKitWebDriver Xvfb; do
        if ! command -v "$tool" >/dev/null; then
            echo "e2e: $tool is missing; see e2e/README.md (Linux prerequisites)" >&2
            exit 2
        fi
    done
    (cd "$repo" && pnpm tauri build --debug --no-bundle)
    (cd "$repo" && pnpm exec wdio run "$root/runners/linux/wdio.conf.mjs" "$@")
    exit
fi

if [ "$mode" != "android" ] && [ "$mode" != "all" ]; then
    echo "usage: e2e/run.sh [env|android|linux|all|real] [-- wdio options]" >&2
    exit 2
fi

case "$serial" in
    *:*) adb connect "$serial" >/dev/null ;;
esac

if [ ! -f "$apk" ]; then
    echo "e2e: no debug APK at $apk. Build it with:" >&2
    echo "  devenv shell -- bash -lc 'pnpm tauri android build --target x86_64 --debug --apk'" >&2
    exit 2
fi

adb -s "$serial" install -r -t "$apk" >/dev/null

# The runner resets the host itself unless --no-reset is passed through.
node "$root/runners/android/run.mjs" --serial "$serial" "$@"
