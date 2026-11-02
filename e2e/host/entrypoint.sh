#!/usr/bin/env bash
# Starts the test host: the host key comes from the checkout, and two real pi
# sessions are recorded so the app has conversations to read. The real profile
# replaces pi's provider configuration; the mock profile keeps the one in the
# image.
set -euo pipefail

port="${PIE_E2E_SSH_PORT:-22}"
profile="${PIE_E2E_PROFILE:-mock}"

install -m 600 -o root -g root /run/pie-e2e/host_ed25519 /etc/ssh/ssh_host_ed25519_key
# The image ships its own host key pair. A stale .pub makes sshd refuse the
# key above, so the public half comes from the same source.
install -m 644 -o root -g root /run/pie-e2e/host_ed25519.pub /etc/ssh/ssh_host_ed25519_key.pub

mkdir -p /home/pi/.ssh
cp /run/pie-e2e/id_ed25519.pub /home/pi/.ssh/authorized_keys
cat /run/pie-e2e/id_ed25519_passphrase.pub >> /home/pi/.ssh/authorized_keys
chown -R pi:pi /home/pi/.ssh
chmod 700 /home/pi/.ssh
chmod 600 /home/pi/.ssh/authorized_keys

mkdir -p /home/pi/work
chown pi:pi /home/pi/work

if [ "$profile" = "real" ]; then
    echo "pie-e2e: writing the real provider configuration"
    # The secret belongs to root and the host user. A copy owned by pi lets the
    # provider read it, and lives only as long as this container.
    install -m 400 -o pi -g pi /run/secrets/pie_e2e_key /home/pi/.pi/agent/real.key
    node /usr/local/bin/pie-e2e-configure
    chown pi:pi /home/pi/.pi/agent/settings.json /home/pi/.pi/agent/real.key
    for file in auth.json models.json; do
        if [ -f "/home/pi/.pi/agent/$file" ]; then
            chown pi:pi "/home/pi/.pi/agent/$file"
        fi
    done
    if [ -f /home/pi/.pi/agent/auth.json ]; then
        chmod 600 /home/pi/.pi/agent/auth.json
    fi
    if [ -n "${PIE_E2E_BASE_URL:-}" ]; then
        if ! su pi -c 'test -r /home/pi/.pi/agent/real.key'; then
            echo "pie-e2e: the API key is not readable" >&2
            exit 1
        fi
    elif ! su pi -c "pi auth print-api-key --provider '${PIE_E2E_PROVIDER}' >/dev/null"; then
        echo "pie-e2e: the API key did not resolve" >&2
        exit 1
    fi
fi

if [ "${PIE_E2E_SEED:-1}" != "0" ] && [ ! -d /home/pi/.pi/agent/sessions ]; then
    echo "pie-e2e: recording fixture sessions"
    if ! su - pi -c 'cd /home/pi/work && pi -n hello -p "hello" >/dev/null'; then
        echo "pie-e2e: the first fixture session failed" >&2
    fi
    sleep 1
    second="tool"
    if [ "$profile" = "real" ]; then
        second='Use the bash tool to run `echo mock-tool-output` and then answer with the output.'
    fi
    if ! su - pi -c "cd /home/pi/work && pi -n tool -p $(printf '%q' "$second") >/dev/null"; then
        echo "pie-e2e: the second fixture session failed" >&2
    fi
fi

exec /usr/sbin/sshd -D -e -p "$port"
