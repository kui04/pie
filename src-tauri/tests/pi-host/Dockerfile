# A host for pi, for the SSH transport tests and for developing pie against
# something that is not this machine.
#
# pi is the release this app pins (see AGENTS.md), taken from its own release
# assets rather than from a package manager, so the host speaks exactly the
# protocol the pi_rpc crate mirrors. A test in tests/ssh.rs compares the
# ARG PI_VERSION below against the app's own version, so a stale one fails the
# default cargo test.
#
# Built by tests/scripts/ssh-fixture.sh, which decides the account below and
# passes it in. To build by hand, pass the two arguments yourself:
#
#   docker build -t pie-pi-host \
#       --build-arg PI_HOST_USER=pie --build-arg PI_HOST_PASSWORD=pie-test-password \
#       src-tauri/tests/pi-host
#
ARG PI_VERSION=1.1.0
# From pi's published SHA256SUMS for that release.
ARG PI_SHA256=3faa94666cd3849d37af320ff749407d0271b07a9b94f420c87e30866e10e289

FROM debian:bookworm-slim

ARG PI_VERSION
ARG PI_SHA256

# openssh-server brings the server side of both authentication branches with it;
# ripgrep and fd are the two tools pi shells out to.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        openssh-server \
        ripgrep \
        fd-find \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# pi itself: the prebuilt binary from the release, checked against the hash pi
# publishes. Nothing is built here - the host runs the same artifact a person
# would download.
RUN set -eux; \
    apt-get update; \
    apt-get install --yes --no-install-recommends curl; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
        amd64) asset=pi-linux-x64.tar.gz ;; \
        arm64) asset=pi-linux-arm64.tar.gz ;; \
        *) echo "no pi release for $arch" >&2; exit 1 ;; \
    esac; \
    curl --fail --location --silent --show-error \
        "https://github.com/earendil-works/pi/releases/download/v${PI_VERSION}/${asset}" \
        --output /tmp/pi.tar.gz; \
    echo "${PI_SHA256}  /tmp/pi.tar.gz" | sha256sum --check --strict; \
    mkdir -p /opt/pi; \
    tar --extract --gzip --file=/tmp/pi.tar.gz --directory=/opt/pi; \
    install -m 0755 /opt/pi/pi/pi /usr/local/bin/pi; \
    rm -rf /opt/pi /tmp/pi.tar.gz; \
    # A host does not need a downloader; the layer that fetched pi is the only
    # place one is wanted.
    apt-get purge --yes --auto-remove curl; \
    rm -rf /var/lib/apt/lists/*; \
    pi --version

# The login account the tests authenticate as. A password as well as a key, so
# both branches of SshTransport::open are exercisable against a real sshd.
# Required rather than defaulted: an image built with different values than the
# tests expect fails as a password error, which is a slow thing to diagnose.
ARG PI_HOST_USER
ARG PI_HOST_PASSWORD
# The entrypoint needs the account's name at run time, where a build argument is
# no longer visible - it would fall back to a guess and then fail on an account
# nobody asked for.
ENV PI_HOST_USER=${PI_HOST_USER}
# The password is deliberately not promoted the same way: an ENV lands in the
# image's own config, and a password does not belong there. Creating the account
# is the only thing it is needed for.
RUN set -eux; \
    test -n "$PI_HOST_USER"; \
    test -n "$PI_HOST_PASSWORD"; \
    useradd --create-home --shell /bin/bash "${PI_HOST_USER}"; \
    echo "${PI_HOST_USER}:${PI_HOST_PASSWORD}" | chpasswd; \
    mkdir -p "/home/${PI_HOST_USER}/.ssh"; \
    chown -R "${PI_HOST_USER}:${PI_HOST_USER}" "/home/${PI_HOST_USER}/.ssh"; \
    chmod 0700 "/home/${PI_HOST_USER}/.ssh"; \
    printf 'pi\n' > /etc/shells

# A release binary reports `0.0.0` for its version: the string is compiled in, so
# only whoever builds pi can set it (see pi's config.ts, `VERSION = pkg.version`).
# Every packaged pi therefore skips the update check, and so does this one.
ENV PI_SKIP_VERSION_CHECK=1

# sshd, configured for an exec-only session: no PTY, both authentication
# branches, and a subsystem for SFTP so the session catalogue has somewhere to
# read from. Host keys are generated per container rather than baked in, so a
# fresh host exercises the trust-on-first-use path every time.
#
# Nothing throttles a source address here (OpenSSH 9.2's PerSourcePenalties is
# off by default), so the tests can authenticate wrongly as often as they like.
RUN set -eux; \
    mkdir -p /run/sshd; \
    printf '%s\n' \
        'Port 22' \
        'AddressFamily any' \
        'UsePAM yes' \
        'PasswordAuthentication yes' \
        'PubkeyAuthentication yes' \
        'PermitRootLogin no' \
        "AllowUsers ${PI_HOST_USER}" \
        'PermitUserEnvironment no' \
        'X11Forwarding no' \
        'PrintMotd no' \
        'AcceptEnv LANG LC_*' \
        'Subsystem sftp /usr/lib/openssh/sftp-server' \
        > /etc/ssh/sshd_config

# The public key of the fixture's own keypair, dropped in by the caller. Without
# it the host still answers with a password.
COPY entrypoint.sh /usr/local/bin/pi-host-entrypoint
RUN chmod 0755 /usr/local/bin/pi-host-entrypoint

EXPOSE 22

ENTRYPOINT ["/usr/local/bin/pi-host-entrypoint"]
# Absolute path: sshd re-execs itself by path to set its privsep child up.
CMD ["/usr/sbin/sshd", "-D", "-e"]
