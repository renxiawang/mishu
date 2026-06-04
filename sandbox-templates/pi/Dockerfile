# Sandbox template for MISHU_AGENT=pi.
FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    gh \
    git \
    gzip \
    jq \
    make \
    openssh-client \
    python3 \
    python3-pip \
    ripgrep \
    sudo \
    tar \
    unzip \
    wget \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

RUN useradd --create-home --shell /bin/bash agent \
  && printf '%s\n' "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent \
  && chmod 0440 /etc/sudoers.d/agent

USER agent
ENV HOME=/home/agent
WORKDIR /workspace
