#!/bin/sh
# Starts sshd for the pi host, after the container's entrypoint.
#
# The image ships no host key and no authorized_keys: both belong to the
# container, not to the image, so that starting the host twice presents two
# different keys - which is what the trust-on-first-use path is for.
set -eu

# Baked in by the image from the build argument: the account exists under this
# name, so a missing value is a broken image rather than something to guess at.
user=${PI_HOST_USER:?set PI_HOST_USER to the account this host runs as}
home=$(getent passwd "$user" | cut -d: -f6)
authorized_keys=${PI_HOST_AUTHORIZED_KEYS:-/run/pi-host/authorized_keys}

if [ ! -f /etc/ssh/ssh_host_ed25519_key ]; then
    ssh-keygen -q -t ed25519 -f /etc/ssh/ssh_host_ed25519_key -N ''
fi

if [ -f "$authorized_keys" ]; then
    # Installed by the caller: the fixture's own keypair, never the user's.
    install -m 0600 -o "$user" -g "$user" \
        "$authorized_keys" "$home/.ssh/authorized_keys"
fi

# Home on the overlay rather than baked into the image, so pi can write.
# The directories are chowned, never the tree: credentials arrive on a read-only
# mount and a recursive chown fails on it.
mkdir -p "$home/.pi/agent"
chown "$user:$user" "$home/.pi" "$home/.pi/agent"

exec "$@"
