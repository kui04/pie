#!/usr/bin/env bash
# Multi-container Docker cluster for SFTP testing:
# 1. Direct host (port 2223): baseline high concurrency & deduplication
# 2. Severable host (port 2225): network disconnects & resume testing
# 3. Flaky host (port 2226): latency & packet drop testing

set -euo pipefail

image=${PIE_SSH_IMAGE:-pie-pi-host}
user=${PIE_SSH_USER:-pie}
password=${PIE_SSH_PASSWORD:-pie-test-password}
state=${PIE_SSH_STATE:-/tmp/pie-ssh-fixture}
key="$state/id_ed25519"
auth_json=${PIE_SSH_AUTH_JSON:-$HOME/.pi/agent/auth.json}

start_container() {
    local name="$1"
    local port="$2"
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker run -d --name "$name" \
        -p "127.0.0.1:$port:22" \
        -v "$key.pub:/run/pi-host/authorized_keys:ro" \
        -v "$auth_json:/home/$user/.pi/agent/auth.json:ro" \
        "$image" >/dev/null
}

wait_container() {
    local name="$1"
    for _ in $(seq 1 100); do
        if docker logs "$name" 2>&1 | grep -q "Server listening"; then
            return 0
        fi
        sleep 0.1
    done
    echo "container $name failed to start sshd" >&2
    return 1
}

start_cluster() {
    mkdir -p "$state"
    if [ ! -f "$key" ]; then
        ssh-keygen -q -t ed25519 -f "$key" -N '' -C "pie sftp cluster"
    fi
    [ -f "$key.pub" ] || ssh-keygen -y -f "$key" > "$key.pub"
    [ -f "$auth_json" ] || { echo "missing $auth_json" >&2; exit 1; }

    docker rm -f pie-ssh-fixture pie-sftp-direct pie-sftp-severable pie-sftp-flaky >/dev/null 2>&1 || true

    start_container "pie-sftp-direct" 2223
    start_container "pie-sftp-severable" 2225
    start_container "pie-sftp-flaky" 2226

    wait_container "pie-sftp-direct"
    wait_container "pie-sftp-severable"
    wait_container "pie-sftp-flaky"

    cat <<EOF
export PIE_SFTP_DIRECT_ADDR=127.0.0.1:2223
export PIE_SFTP_SEVERABLE_ADDR=127.0.0.1:2225
export PIE_SFTP_FLAKY_ADDR=127.0.0.1:2226
export PIE_SSH_TEST_USER=$user
export PIE_SSH_TEST_PASSWORD=$password
export PIE_SSH_TEST_KEY=$key
EOF
}

stop_cluster() {
    docker rm -f pie-sftp-direct pie-sftp-severable pie-sftp-flaky >/dev/null 2>&1 || true
    echo "sftp-cluster: stopped"
}

case "${1:-start}" in
    start) start_cluster ;;
    stop) stop_cluster ;;
    *) echo "usage: $0 [start|stop]" >&2; exit 1 ;;
esac
