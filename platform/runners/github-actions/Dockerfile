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
# libatomic1: @pnpm/exe's native binary (installed below via corepack) dlopens
# libatomic.so.1 at startup. Ubuntu 22.04 does not pull it in as a dependency
# of anything else here, so every pnpm invocation fails closed with "error
# while loading shared libraries" until it's installed explicitly (observed
# live 2026-08-15: every job on this image that shells to pnpm, including the
# base loom-ui-verify smoke suite, failed within seconds of Setup pnpm).
#
# The second group (make .. python3-dev) was added 2026-09-12 when the repo's CI
# started moving onto this runner. MEASURED by
# .github/workflows/loom-aca-runner-capability-probe.yml on the live job, not
# guessed: `make`, `pip3`, `pwsh`, `dotnet`, `go`, `dbt` and `docker` were all
# absent, and `make` alone breaks every gate in the repo, because `make validate`
# IS the entry point (CLAUDE.md: "make validate runs dev-loop/gates/validate-all.ps1").
RUN set -euo pipefail; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl jq git unzip gnupg lsb-release apt-transport-https \
        sudo libicu70 liblttng-ust1 libssl3 zlib1g libatomic1 acl \
        software-properties-common \
        make build-essential python3-pip python3-venv python3-dev \
        zip rsync openssh-client; \
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
    rm -rf /var/lib/apt/lists/*

# --- bicep, on the PATH, not inside somebody's home -------------------------
# `az bicep install` writes the binary under $AZURE_CONFIG_DIR, which defaults
# to the invoking user's ~/.azure. Installed as root during the build it lands
# in /root/.azure, which the non-root `runner` user cannot read — so the image
# SHIPPED a bicep the runner could not execute, and the live capability probe
# returned, on a step it nonetheless labelled PRESENT:
#
#     bicep  ERROR: Bicep CLI not found. Install it now by running "az bicep install".
#
# That is the Playwright/PLAYWRIGHT_BROWSERS_PATH mistake one tool along.
#
# THE OBVIOUS FIX IS A TRAP, AND IT WAS MEASURED, NOT REASONED ABOUT. Pinning
# `ENV AZURE_CONFIG_DIR=/opt/azure` + `chmod -R a+rX` makes the directory
# READABLE but not WRITABLE, and `az` WRITES there on every invocation
# (telemetry, command index, logs). The next probe run came back with `az`
# itself broken — "The command failed with an unexpected error" — i.e. the
# remedy was strictly worse than the defect: bicep missing became the whole
# Azure CLI missing.
#
# So the binary goes somewhere a PATH lookup finds it and nobody needs write
# access to, and AZURE_CONFIG_DIR is left alone at its per-user default.
# AZURE_BICEP_USE_BINARY_FROM_PATH is the documented switch for exactly this.
ENV AZURE_BICEP_USE_BINARY_FROM_PATH=true
RUN set -euo pipefail; \
    BICEP_VER="$(curl -fsSL https://api.github.com/repos/Azure/bicep/releases/latest | jq -r .tag_name)"; \
    test -n "$BICEP_VER" -a "$BICEP_VER" != "null"; \
    curl -fsSL -o /usr/local/bin/bicep \
        "https://github.com/Azure/bicep/releases/download/${BICEP_VER}/bicep-linux-x64"; \
    chmod a+rx /usr/local/bin/bicep; \
    bicep --version

# --- PowerShell (pwsh) ------------------------------------------------------
# `PowerShell Lint` is one of the 15 REQUIRED status contexts, and
# dev-loop/gates/validate-all.ps1 — the program behind `make validate` — is
# PowerShell. A runner without pwsh cannot carry either.
RUN set -euo pipefail; \
    AZ_DIST="$(lsb_release -cs)"; \
    curl -fsSL -o /tmp/pmc.deb \
        "https://packages.microsoft.com/config/ubuntu/$(lsb_release -rs)/packages-microsoft-prod.deb"; \
    dpkg -i /tmp/pmc.deb; \
    rm -f /tmp/pmc.deb; \
    apt-get update; \
    apt-get install -y --no-install-recommends powershell; \
    rm -rf /var/lib/apt/lists/*; \
    pwsh --version

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
#
# PARITY WITH ubuntu-latest, and it is not cosmetic. A GitHub-hosted runner's
# `runner` user has PASSWORDLESS SUDO and a WRITABLE /usr/local/bin, and
# workflows across this repo assume both. Measured on the first migrated CI run:
#
#     Secret Scan / Install gitleaks -> failure
#     curl ... | tar -xz -C /usr/local/bin gitleaks
#
# `Secret Scan` is one of the fifteen REQUIRED contexts, so without this the
# migration blocks every PR in the repo. The alternative -- editing ~100
# workflows to install into $HOME -- is the same fix written a hundred times and
# would diverge from the hosted runner the moment anyone adds a step.
#
# This is not a privilege escalation worth worrying about -- but NOT for the
# reason this comment used to give. It said "the job's own code already runs as
# `runner`". It does not: this image never sets `USER runner`, the last two
# USER instructions are both `root`, and RUNNER_ALLOW_RUNASROOT=1 is set below.
# JOB CODE RUNS AS ROOT. The conclusion survives -- the container is EPHEMERAL
# and destroyed after one job, and job code already has full control of it --
# but the premise was false in the reassuring direction, and one consequence is
# load-bearing: /proc/1/environ is root-readable ONLY, so under the ACTUAL uid
# it IS readable, which is exactly why the secret-hygiene probe checks it and
# why the remedy had to be `exec env -u` rather than `unset`.
# The real boundary is the container and the fork-PR approval policy, not this.
RUN set -euo pipefail; \
    useradd -m -d /home/runner -s /bin/bash runner; \
    mkdir -p /home/runner/actions-runner; \
    chown -R runner:runner /home/runner; \
    echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner; \
    chmod 0440 /etc/sudoers.d/runner; \
    visudo -c; \
    chown root:runner /usr/local/bin /usr/local/lib; \
    chmod 0775 /usr/local/bin /usr/local/lib

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
# Playwright layer (UAT) — browsers + OS deps baked into the runner image so
# `loom-ui-verify` / Playwright specs run without a per-job `npx playwright
# install`. Adds ~600MB. Pinned to the repo's @playwright/test.
#
# THE STATED REASON USED TO BE "the in-VNet runner's egress is
# firewall-restricted, so the runtime CDN download fails". That is FALSE and was
# measured so on 2026-09-13: `nsg-snet-container-platform` carries ZERO outbound
# security rules (only the defaults AllowVnetOutBound 65000 and
# AllowInternetOutBound 65001), the subnet has NO route table so nothing
# transits the AzureFirewallSubnet in the same VNet, and the capability probe
# reached github.com, registry.npmjs.org, nodejs.org, pypi.org,
# files.pythonhosted.org, packages.microsoft.com, mcr.microsoft.com and
# proxy.golang.org with HTTP 200 from inside the fleet. Whatever made a runtime
# download fail when this layer was added, it was not an egress restriction, and
# a security argument resting on a false premise does not survive the next
# reader.
#
# BAKING THE BROWSERS IN IS STILL RIGHT, on the honest reasons: ~600MB pulled
# per job is wall-clock and egress cost on every UAT run, and an image-time pin
# is reproducible where a job-time CDN fetch is not.
#
# PLAYWRIGHT_BROWSERS_PATH puts the browsers in a shared, world-readable path —
# installing as root without it lands them under /root/.cache where a non-root
# user could not see them at job time. (Job code in fact runs as root here; the
# shared path is kept because it does not depend on that, and because the
# uid this image runs as should not be a thing a later reader has to know.)
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN set -euo pipefail; \
    # 1.60.0 = the lockfile's RESOLVED @playwright/test (package.json says ^1.48.0
    # but pnpm-lock resolves 1.60.0). The baked chromium build revision must match
    # the tests' playwright or it errors "Executable doesn't exist" at run time.
    npx --yes playwright@1.60.0 install --with-deps chromium; \
    chmod -R a+rX /ms-playwright
# ---------------------------------------------------------------------------

# --- Rust toolchain --------------------------------------------------------
# `ubuntu-latest` ships rustup preinstalled and three jobs assume it:
# `cargo build + test (engine-only)`, `(default (engine + azure))` and
# `cargo build --release (the profile the image ships)`. Measured on the first
# migrated run: `rustup: command not found`, rc=127.
#
# Installed to a SHARED location, not $HOME, for the same reason bicep is: a
# root-time install under /root/.cargo is invisible to the job user.
ENV RUSTUP_HOME=/opt/rust CARGO_HOME=/opt/cargo
ENV PATH=/opt/cargo/bin:$PATH
RUN set -euo pipefail; \
    curl -fsSL https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path; \
    chmod -R a+rX "$RUSTUP_HOME" "$CARGO_HOME"; \
    rustup --version; \
    cargo --version

# --- tell self-sizing tools the CGROUP's size, not the NODE's ---------------
#
# THE ROOT CAUSE OF THE TIMEOUT CANCELLATIONS, and it is not obvious from the
# symptom. This PR's own capability probe, run inside the job, reports:
#
#     cpus   : 8       <- the D8 NODE
#     memory : 31Gi    <- the D8 NODE
#
# while the container's cgroup is 4 vCPU / 16 GiB. `nproc`, libuv, jest, vitest,
# pnpm, cargo and Next.js all size their worker pools from what they observe, so
# every one of them span up 8 workers onto 4 cores. The fleet came out 2-3x
# slower than ubuntu-latest and four REQUIRED contexts were CANCELLED at exactly
# their `timeout-minutes` -- `next build` missed by 35 seconds.
#
# Raising `replicaTimeout` (done, 9600s) stops ACA killing the replica; it does
# NOT stop GitHub cancelling the job at its own cap, and it does not make the
# over-subscription go away. These variables do, by telling each toolchain the
# number it should have measured.
#
# Keep in step with the `cpu` param of gh-runner-job.bicep. Wrong-way drift here
# is silent: too high re-creates the over-subscription, too low wastes cores.
# EVERY VARIABLE BELOW IS ONE A REAL TOOL READS. The first draft of this block
# also set `JEST_WORKERS` and `LOOM_RUNNER_VCPU` -- Jest has no such variable
# (it takes `--maxWorkers`), and nothing anywhere reads the second. Shipping
# them would have been the unconsulted-key defect this repo keeps finding, in
# the fix for a different one. Jest's worker count must be passed at the call
# site; it is not settable from here.
ENV UV_THREADPOOL_SIZE=4
ENV NODE_OPTIONS="--max-old-space-size=12288"
ENV VITEST_MAX_THREADS=4
ENV VITEST_MIN_THREADS=1
ENV CARGO_BUILD_JOBS=4
ENV MAKEFLAGS="-j4"
ENV PYTEST_XDIST_AUTO_NUM_WORKERS=4

COPY --chown=runner:runner entrypoint.sh /home/runner/actions-runner/entrypoint.sh
# Strip CRLF: a Windows checkout (core.autocrlf) can hand the build context an
# entrypoint.sh with \r\n line endings — the container then dies at start with
# `/usr/bin/env: 'bash\r': No such file or directory` (seen live: KEDA retry
# loop of Failed executions). Normalizing here makes the image immune to the
# build host's line-ending config.
RUN sed -i 's/\r$//' /home/runner/actions-runner/entrypoint.sh; \
    chmod +x /home/runner/actions-runner/entrypoint.sh

USER root
# RUN AS ROOT, DELIBERATELY, AND THIS IS NOT THE CONVENIENT CHOICE -- it is the
# only one the platform allows. Operator decision 2026-09-12, on this
# measurement from the first migrated CI run:
#
#     sudo: The "no new privileges" flag is set, which prevents sudo from
#     running as root.
#
# Azure Container Apps sets `no_new_privs` on the container, so a setuid binary
# can NEVER elevate there. `sudo` is therefore structurally impossible on these
# runners -- a platform limit like the absent Docker daemon, not a missing
# package -- and 13 `sudo apt-get` calls across 7 workflows depend on it
# (unixodbc for the dbt/transform runners, the Rust toolchain, the Bicep CLI).
#
# When the process is ALREADY root, sudo does not need to change uid, so it
# succeeds and every one of those workflows runs unmodified and identically to
# `ubuntu-latest`. The alternative -- rewriting 13 call sites -- diverges from
# the hosted runner permanently, and the next person to add a `sudo` step
# breaks CI with a confusing error.
#
# WHY THIS IS AN ACCEPTABLE POSTURE, stated rather than assumed -- and restated
# 2026-09-25 because the previous version was wrong in the reassuring direction.
# It said "the job's code already has full control of this container as
# `runner` … Root here reaches nothing `runner` could not already reach", which
# presupposes job code runs as `runner`. It does not: this image never sets
# `USER runner`, and RUNNER_ALLOW_RUNASROOT=1 below is exactly the admission
# that it runs as root.
#
# The posture is acceptable on the reasons that are actually true: job code has
# full control of this container WHATEVER uid it holds, the replica is EPHEMERAL
# (one job, then destroyed), and the security boundary is the container plus the
# fork-PR approval policy -- tightened to `all_external_contributors` as part of
# this migration -- not the in-container uid. A reviewer put the same point
# independently: RUNNER_ALLOW_RUNASROOT "barely moves the blast radius -- job
# code already ran as the same uid as the runner".
#
# The difference the old wording hid is narrow and real: /proc/1/environ is
# root-readable ONLY. Under the claimed uid a leaked PID-1 environment would be
# unreadable from job code; under the ACTUAL uid it is readable. That is the
# path the secret-hygiene probe checks second, and the reason the PAT remedy
# had to replace the process image (`exec env -u`) rather than `unset`.
#
# The runner agent refuses to run as root unless this is set, and that refusal
# exists for the bare-metal case it does not apply to here.
ENV RUNNER_ALLOW_RUNASROOT=1
ENTRYPOINT ["/home/runner/actions-runner/entrypoint.sh"]
