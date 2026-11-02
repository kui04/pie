#!/usr/bin/env bash
# Checks the real test host before the app connects to it. The environment
# (PIE_E2E_PROVIDER, PIE_E2E_MODEL, PIE_E2E_THINKING) comes from run.sh, which
# reads e2e/.testenv/real.env.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sshdir="$root/.testenv/ssh"
key="$sshdir/id_ed25519"
known="$sshdir/known_hosts"
host="127.0.0.1"
port="2223"
failed=0

: "${PIE_E2E_PROVIDER:?run this through e2e/run.sh real}"
: "${PIE_E2E_MODEL:?run this through e2e/run.sh real}"
: "${PIE_E2E_THINKING:=low}"
export PIE_E2E_PROVIDER PIE_E2E_MODEL PIE_E2E_THINKING

pass() { printf 'PASS %s %s\n' "$1" "$2"; }
fail() {
    printf 'FAIL %s %s\n' "$1" "$2"
    failed=$((failed + 1))
}

ssh_run() {
    ssh -p "$port" -i "$key" \
        -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=5 \
        -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$known" \
        "pi@$host" "$@"
}

version="$(ssh_run 'pi --version' 2>/dev/null | tr -d '\r')"
if [ "$version" = "1.1.0" ]; then
    pass REAL-01 "pi --version is $version over a non-interactive SSH command"
else
    fail REAL-01 "pi --version over SSH returned '$version'"
fi

if [ -n "${PIE_E2E_BASE_URL:-}" ]; then
    if ssh_run 'test -r /home/pi/.pi/agent/real.key'; then
        pass REAL-01 "the key file is readable for the custom provider"
    else
        fail REAL-01 "the key file is not readable for the custom provider"
    fi
elif ssh_run "pi auth print-api-key --provider '$PIE_E2E_PROVIDER' >/dev/null" 2>/dev/null; then
    pass REAL-01 "the key resolves for $PIE_E2E_PROVIDER"
else
    fail REAL-01 "the key does not resolve for $PIE_E2E_PROVIDER"
fi

if node "$root/lib/rpc-real.mjs" "$host" "$port" "$key" "$known" \
    "$PIE_E2E_PROVIDER" "$PIE_E2E_MODEL" "$PIE_E2E_THINKING"; then
    :
else
    fail REAL-01 "the provider, model, or level check failed"
fi

sessions="$(ssh_run 'ls -1 ~/.pi/agent/sessions/--home-pi-work--/*.jsonl 2>/dev/null' | wc -l)"
if [ "$sessions" -ge 2 ]; then
    pass REAL-01 "$sessions fixture sessions are on the host"
else
    fail REAL-01 "expected at least 2 fixture sessions, found $sessions"
fi

answered="$(ssh_run 'grep -l "\"role\":\"assistant\".*\"type\":\"text\"" ~/.pi/agent/sessions/--home-pi-work--/*.jsonl 2>/dev/null' | wc -l)"
if [ "$answered" -ge 2 ]; then
    pass REAL-01 "$answered fixtures hold an assistant answer"
else
    fail REAL-01 "only $answered fixtures hold an assistant answer; the first call failed"
fi

if [ "$failed" -ne 0 ]; then
    printf 'e2e: %d real host checks failed\n' "$failed" >&2
    exit 1
fi
echo "e2e: the real host is ready"
