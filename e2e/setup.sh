#!/usr/bin/env bash
# Creates the throwaway SSH credentials of the test host. No secret leaves
# `.testenv/`, which git ignores.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dir="$root/.testenv/ssh"

mkdir -p "$dir"
umask 077

keygen() {
    local path="$1" passphrase="$2" comment="$3"
    if [ ! -f "$path" ]; then
        ssh-keygen -q -t ed25519 -N "$passphrase" -C "$comment" -f "$path"
    fi
}

keygen "$dir/host_ed25519" "" "pie-e2e-host"
keygen "$dir/id_ed25519" "" "pie-e2e-client"
keygen "$dir/id_ed25519_wrong" "" "pie-e2e-wrong"
keygen "$dir/id_ed25519_passphrase" "pie-test-passphrase" "pie-e2e-client-passphrase"

# The prompt shows the SHA256 fingerprint of the key the host offers.
ssh-keygen -lf "$dir/host_ed25519.pub" | awk '{ print $2 }' > "$dir/host_fingerprint"

rm -f "$dir/known_hosts"

echo "e2e: credentials under $dir"
echo "e2e: host key $(cat "$dir/host_fingerprint")"
