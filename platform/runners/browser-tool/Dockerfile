# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# CSA Loom — Playwright browser-automation runner for Azure Container Apps Jobs
# ---------------------------------------------------------------------------
# Image: <acr-login-server>/loom-browser-tool:<tag>
# Built server-side with ACR Tasks (NO local Docker daemon), same as the
# script-runner / gh-aca-runner images:
#   az acr build -r <acr> -t loom-browser-tool:<tag> platform/runners/browser-tool
#
# WHAT this carries (single-purpose): a one-shot Node process (runner.mjs) that
# reads a BROWSER_TASK env var, drives a headless Chromium via Playwright, and
# prints the page result JSON to stdout. It is the Azure-native, in-VNet
# substitute for a native browser-automation PaaS — the agent's
# `browser_automation` tool (AIF-18) routes here. NO external browser service is
# contacted (.claude/rules/no-fabric-dependency.md).
#
# THREAT MODEL: this runner navigates operator/agent-supplied URLs. It runs as a
# manual-trigger ACA Job with a DEDICATED least-privilege UAMI (AcrPull only, no
# data-plane roles) so IMDS token minting from inside the browser context can't
# reach Storage/Cosmos/etc. Chromium runs with --no-sandbox (required in the
# unprivileged container); the CONTAINER + the Job's ephemeral execution are the
# isolation boundary. NO SECRETS in this image — code + browser only.
# ---------------------------------------------------------------------------
# Pinned Playwright base image (browsers pre-installed under /ms-playwright).
# Bump the tag in lockstep with the playwright pin in package.json.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# Install ONLY the playwright npm package (the base image already carries the
# browser binaries) so `import { chromium } from 'playwright'` resolves.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY runner.mjs ./

# The base image ships the non-root `pwuser`; run as it (browsers are readable).
USER pwuser

# One-shot job: the container runs the task from BROWSER_TASK and exits.
CMD ["node", "runner.mjs"]
