FROM node:22-bookworm-slim

ARG PI_VERSION=1.1.0

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        curl \
        git \
        openssh-server \
        procps \
        ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && pi --version

RUN useradd --create-home --shell /bin/bash pi \
    && echo 'pi:pie-test' | chpasswd \
    && mkdir -p /run/sshd /home/pi/work

COPY --chown=pi:pi pi/ /home/pi/.pi/agent/
COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/pie-e2e-entrypoint
COPY configure-real.mjs /usr/local/bin/pie-e2e-configure

USER pi

RUN pi install npm:pi-ask-user@0.17.2 \
    && pi install npm:pi-permission-system@0.8.0

# The permission prompts would stop every tool call. This suite tests them
# separately; the default run approves.
RUN printf '%s\n' \
        '{"enabled":true,"debug":false,"yoloMode":true,"forwardedPromptTimeoutSeconds":30}' \
        > /home/pi/.pi/agent/npm/node_modules/pi-permission-system/config.json

USER root

RUN chmod 755 /usr/local/bin/pie-e2e-entrypoint \
    && chown -R pi:pi /home/pi

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/pie-e2e-entrypoint"]
