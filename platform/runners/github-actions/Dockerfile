# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# CSA Loom — self-hosted GitHub Actions runner for Azure Container Apps Jobs
# ---------------------------------------------------------------------------
# Image: acrloomk6mvh5sm6z7do.azurecr.io/gh-aca-runner:latest
#
# WHAT this carries (so build/roll/UAT run on it, in-VNet):
#   - GitHub Actions runner agent (pinned + checksum-verified, ephemeral)
#   - azure-cli + `az bicep` (server-side `az acr build`, `az containerapp update`)
#   - Node 20 + pnpm (corepack)            -> Next.js console build
#   - gh CLI, git, curl, jq, ca-certificates
#
# WHY Ubuntu (glibc), NOT the Alpine azure-cli image:
#   The official GitHub Actions runner binaries are glibc-linked and will not
#   run on musl (Alpine). Ubuntu 22.04 (jammy) is the supported base.
#
# WHY no Docker layer:
#   Container Apps jobs do NOT support Docker-in-container. Any workflow step
#   that shells out to `docker ...` will fail here. Our roll uses server-side
#   `az acr build` (ACR Tasks), so we never need a local Docker daemon.
# ---------------------------------------------------------------------------
FROM ubuntu:22.04

# --- pinned runner version + checksum -------------------------------------
# Bump RUNNER_VERSION and RUNNER_SHA256 together. The SHA256 is the value
# published on the release page (verified against the GitHub releases API):
#   https://github.com/actions/runner/releases/tag/v${RUNNER_VERSION}
# The default below is the linux-x64 (amd64) hash for
#   actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz
# The build FAILS loudly via `sha256sum -c` if the downloaded tarball does not
# match. Both are overridable at build time, e.g.:
#   az acr build --build-arg RUNNER_VERSION=2.x.y --build-arg RUNNER_SHA256=<hex> ...
# For an arm64 build, pass the matching linux-arm64 hash, e.g. v2.328.0:
#   RUNNER_SHA256=b801b9809c4d9301932bccadf57ca13533073b2aa9fa9b8e625a8db905b5d8eb
ARG RUNNER_VERSION=2.328.0
ARG RUNNER_SHA256=01066fad3a2893e63e6ca880ae3a1fad5bf9329d60e77ee15f2b97c148c3cd4e
ARG TARGETARCH=amd64

ENV DEBIAN_FRONTEND=noninteractive \
    RUNNER_MANUALLY_TRAP_SIG=1 \
    ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT=1 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1

# Use bash with pipefail for every RUN. Ubuntu's default /bin/sh is dash, which
# does NOT support `set -o pipefail` — without this each `set -euo pipefail`
# below would abort the build ("Illegal option -o pipefail"). bash ships in the
# ubuntu:22.04 base image. ENTRYPOINT stays exec-form, so it is unaffected.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# --- base OS deps + toolchain repos ---------------------------------------
RUN set -euo pipefail; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl jq git unzip gnupg lsb-release apt-transport-https \
        sudo libicu70 liblttng-ust1 libssl3 zlib1g acl \
        software-properties-common; \
    rm -rf /var/lib/apt/lists/*

# --- Azure CLI (Microsoft apt repo) + az bicep ----------------------------
RUN set -euo pipefail; \
    mkdir -p /etc/apt/keyrings; \
    curl -sLS https://packages.microsoft.com/keys/microsoft.asc \
        | gpg --dearmor -o /etc/apt/keyrings/microsoft.gpg; \
    chmod a+r /etc/apt/keyrings/microsoft.gpg; \
    AZ_DIST="$(lsb_release -cs)"; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ ${AZ_DIST} main" \
        > /etc/apt/sources.list.d/azure-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends azure-cli; \
    rm -rf /var/lib/apt/lists/*; \
    # Pre-install the bicep CLI into the image so `az bicep build` works offline.
    az bicep install; \
    az bicep version

# --- gh CLI (GitHub apt repo) ---------------------------------------------
RUN set -euo pipefail; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh; \
    rm -rf /var/lib/apt/lists/*

# --- Node 20 (NodeSource) + pnpm via corepack -----------------------------
RUN set -euo pipefail; \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -; \
    apt-get install -y --no-install-recommends nodejs; \
    rm -rf /var/lib/apt/lists/*; \
    corepack enable; \
    corepack prepare pnpm@9.12.3 --activate; \
    node --version; pnpm --version

# --- non-root runner user --------------------------------------------------
RUN set -euo pipefail; \
    useradd -m -d /home/runner -s /bin/bash runner; \
    mkdir -p /home/runner/actions-runner; \
    chown -R runner:runner /home/runner

WORKDIR /home/runner/actions-runner

# --- GitHub Actions runner agent (pinned + checksum-verified) --------------
RUN set -euo pipefail; \
    case "${TARGETARCH}" in \
        amd64) RUNNER_ARCH=x64 ;; \
        arm64) RUNNER_ARCH=arm64 ;; \
        *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o actions-runner.tar.gz \
        "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz"; \
    echo "${RUNNER_SHA256}  actions-runner.tar.gz" | sha256sum -c -; \
    tar xzf actions-runner.tar.gz; \
    rm -f actions-runner.tar.gz; \
    # Runner-declared native deps (libicu etc.) — run as root before dropping user.
    ./bin/installdependencies.sh; \
    chown -R runner:runner /home/runner/actions-runner

# ---------------------------------------------------------------------------
# OPTIONAL — Playwright layer (UAT). Uncomment to bake browsers + OS deps into
# the runner image so `pnpm uat` / Playwright specs run without per-job
# `npx playwright install`. Adds ~600MB; leave commented unless this runner is
# the UAT runner. Pin the version to the repo's @playwright/test.
# USER root
# RUN set -euo pipefail; \
#     npx --yes playwright@1.48.0 install --with-deps chromium
# ---------------------------------------------------------------------------

COPY --chown=runner:runner entrypoint.sh /home/runner/actions-runner/entrypoint.sh
RUN chmod +x /home/runner/actions-runner/entrypoint.sh

USER runner
ENTRYPOINT ["/home/runner/actions-runner/entrypoint.sh"]
