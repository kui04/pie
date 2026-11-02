#!/usr/bin/env bash
# Puts the host back to the two recorded fixture sessions, so a run of the suite
# starts from the same list every time.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
key="$root/.testenv/ssh/id_ed25519"
known="$root/.testenv/ssh/known_hosts"
compose=(docker compose -f "$root/compose.yaml")

"${compose[@]}" exec -T host rm -rf /home/pi/.pi/agent/sessions
"${compose[@]}" restart host >/dev/null

for _ in $(seq 1 40); do
    if ssh -p 2222 -i "$key" \
        -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=3 \
        -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$known" \
        pi@127.0.0.1 'true' 2>/dev/null; then
        echo "e2e: host reset to the fixture sessions"
        exit 0
    fi
    sleep 0.5
done

echo "e2e: the host did not answer after the reset" >&2
exit 1
