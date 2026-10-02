#!/usr/bin/env bash
# The SSH host the transport tests talk to.
#
# Builds and runs `tests/pi-host/Dockerfile` - a Debian userland with a real
# sshd and a real pi - and prints the environment `tests/ssh.rs` reads. Nothing
# of the machine's own sshd or ~/.ssh is involved: the fixture keeps its own key
# under /tmp and its own port.
#
#   tests/scripts/ssh-fixture.sh start    # prints the exports to eval
#   tests/scripts/ssh-fixture.sh stop
#
# `start` rebuilds the image (docker's cache makes that cheap when nothing
# changed) and is otherwise idempotent. Sizing and credentials come from
# PIE_SSH_* variables; every one of them has a default that works locally, and
# they are the only place the host's account is decided - the image is built
# with the account and keeps its name for its own entrypoint.
set -euo pipefail

container=${PIE_SSH_CONTAINER:-pie-ssh-fixture}
image=${PIE_SSH_IMAGE:-pie-pi-host}
port=${PIE_SSH_PORT:-2222}
user=${PIE_SSH_USER:-pie}
password=${PIE_SSH_PASSWORD:-pie-test-password}
state=${PIE_SSH_STATE:-/tmp/pie-ssh-fixture}
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
context="$here/../pi-host"
key="$state/id_ed25519"

# pi refuses to build a session without credentials for its model. The
# container reads the host's, read-only and only for as long as it exists,
# rather than a copy of them sitting in an image or a volume.
auth_json=${PIE_SSH_AUTH_JSON:-$HOME/.pi/agent/auth.json}

die() { echo "ssh-fixture: $*" >&2; exit 1; }

running() {
    [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" = "true" ]
}

# sshd is the container's last process, and its log is what says it is up.
listening() {
    docker logs "$container" 2>&1 | grep -q "Server listening"
}

start() {
    mkdir -p "$state"
    if [ ! -f "$key" ]; then
        # A key of its own, so the fixture never depends on the user's ~/.ssh.
        ssh-keygen -q -t ed25519 -f "$key" -N '' -C "pie ssh fixture"
    fi
    [ -f "$auth_json" ] || die "no credentials at $auth_json; pi cannot start a session without them"

    docker build \
        --build-arg "PI_HOST_USER=$user" \
        --build-arg "PI_HOST_PASSWORD=$password" \
        --tag "$image" \
        --quiet \
        "$context" >&2

    docker rm -f "$container" >/dev/null 2>&1 || true

    # Published on the loopback only: the host answers to a published password
    # and reads pi credentials, so binding it to every interface would put both
    # on the network this machine happens to be on.
    docker run -d --name "$container" \
        -p "127.0.0.1:$port:22" \
        -v "$key.pub:/run/pi-host/authorized_keys:ro" \
        -v "$auth_json:/home/$user/.pi/agent/auth.json:ro" \
        "$image" >/dev/null

    for _ in $(seq 1 100); do
        listening && break
        running || die "the container exited: $(docker logs "$container" 2>&1)"
        sleep 0.1
    done
    listening || die "sshd did not start: $(docker logs "$container" 2>&1)"

    # `export`, so `eval "$(ssh-fixture.sh start)"` is enough at a shell.
    cat <<EOF
export PIE_SSH_TEST_ADDR=127.0.0.1:$port
export PIE_SSH_TEST_USER=$user
export PIE_SSH_TEST_PASSWORD=$password
export PIE_SSH_TEST_KEY=$key
EOF
}

stop() {
    docker rm -f "$container" >/dev/null 2>&1 || true
    echo "ssh-fixture: stopped"
}

case "${1:-start}" in
    start) start ;;
    stop) stop ;;
    *) die "usage: $0 [start|stop]" ;;
esac
