#!/usr/bin/env bash
# Checks the test host before the app connects to it. Every failure names the
# case that did not hold.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sshdir="$root/.testenv/ssh"
key="$sshdir/id_ed25519"
known="$sshdir/known_hosts"
host="127.0.0.1"
port="2222"
failed=0

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

if [ ! -f "$key" ]; then
    echo "e2e: run e2e/setup.sh first" >&2
    exit 2
fi

if curl --fail --silent --show-error http://127.0.0.1:18080/health >/dev/null; then
    pass ENV-01 "mock answers /health"
else
    fail ENV-01 "mock is not healthy"
fi

version="$(ssh_run 'pi --version' 2>/dev/null | tr -d '\r')"
if [ "$version" = "1.1.0" ]; then
    pass ENV-02 "pi --version is $version over a non-interactive SSH command"
else
    fail ENV-02 "pi --version over SSH returned '$version'"
fi

if ssh_run 'true' 2>/dev/null; then
    pass ENV-03 "the test key is accepted"
else
    fail ENV-03 "the test key is rejected"
fi
if ssh -p "$port" -i "$sshdir/id_ed25519_wrong" \
    -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=5 -o "UserKnownHostsFile=$known" \
    "pi@$host" 'true' 2>/dev/null; then
    fail ENV-03 "a key outside authorized_keys was accepted"
fi

offered="$(ssh -p "$port" -o PreferredAuthentications=password -o PubkeyAuthentication=no \
    -o BatchMode=yes -o ConnectTimeout=5 -o "UserKnownHostsFile=$known" \
    "pi@$host" 'true' 2>&1)"
case "$offered" in
    *"password"*) pass ENV-02 "sshd offers password authentication" ;;
    *) fail ENV-02 "sshd does not offer password authentication: $offered" ;;
esac

fingerprint="$(ssh-keyscan -p "$port" "$host" 2>/dev/null | ssh-keygen -lf - 2>/dev/null | awk '{ print $2 }' | head -1)"
if [ "$fingerprint" = "$(cat "$sshdir/host_fingerprint")" ]; then
    pass ENV-04 "host key is stable: $fingerprint"
else
    fail ENV-04 "host key is '$fingerprint', expected '$(cat "$sshdir/host_fingerprint")'"
fi

if node "$root/lib/rpc-check.mjs" "$host" "$port" "$key" "$known"; then
    :
else
    fail ENV-05/06 "the RPC startup check failed"
fi

packages="$(ssh_run 'pi list' 2>/dev/null)"
for package in pi-ask-user pi-permission-system; do
    case "$packages" in
        *"$package"*) pass ENV-07 "$package is installed" ;;
        *) fail ENV-07 "$package is missing from pi list" ;;
    esac
done

sessions="$(ssh_run 'ls -1 ~/.pi/agent/sessions/--home-pi-work--/*.jsonl 2>/dev/null' | wc -l)"
if [ "$sessions" -ge 2 ]; then
    pass ENV-08 "$sessions session fixtures are on the host"
else
    fail ENV-08 "expected at least 2 session fixtures, found $sessions"
fi
if ssh_run 'head -c 200 ~/.pi/agent/sessions/--home-pi-work--/*.jsonl | grep -q "\"cwd\":\"/home/pi/work\""'; then
    pass ENV-08 "session headers name /home/pi/work"
else
    fail ENV-08 "session headers do not name /home/pi/work"
fi

if node "$root/lib/mock-check.mjs" http://127.0.0.1:18080; then
    :
else
    fail ENV-09 "the mock determinism check failed"
fi

if [ "$failed" -ne 0 ]; then
    printf 'e2e: %d environment checks failed\n' "$failed" >&2
    exit 1
fi
echo "e2e: environment is ready"
