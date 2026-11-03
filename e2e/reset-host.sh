#!/usr/bin/env bash
# Puts the host back to the recorded fixture sessions. The entrypoint stores the
# snapshot once, and every case starts from a copy of it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose=(docker compose -f "$root/compose.yaml")

if ! "${compose[@]}" exec -T host test -d /home/pi/.pi/agent/sessions.seed; then
    echo "e2e: the host has no fixture snapshot; recreate it with:" >&2
    echo "  docker compose -f e2e/compose.yaml up -d --build --force-recreate host" >&2
    exit 1
fi

# A case that left a pi process behind must not answer the next one. The runner
# stops the app before this runs, so no live connection loses its process.
"${compose[@]}" exec -T host bash -c '
    pkill -u pi -f "pi --mode rpc" || true
    rm -rf /home/pi/.pi/agent/sessions
    cp -a /home/pi/.pi/agent/sessions.seed /home/pi/.pi/agent/sessions
'

echo "e2e: host restored to the fixture sessions"
