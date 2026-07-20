---
title: CSA Loom — local golden-path (config-only demo profile)
date: 2026-07-20
---

# Local golden-path — one command to a running console

The fastest way for a new contributor to get the **CSA Loom console** running
on their own machine, signed in, and navigable — target: **under 30 minutes**,
most of which is `pnpm install`.

## What this profile is (and honestly is not)

The Loom console is a Next.js BFF that talks to **real Azure backends**
(Synapse, ADX, Cosmos, Purview, Azure OpenAI, …). There is **no local emulator**
that reproduces that estate, so this profile does **not** fake data. Instead it
is an honest **config-only demo profile**:

- `next dev` boots with a locally-generated `SESSION_SECRET`, so the session
  crypto works exactly as in production.
- A `loom_session` cookie is **minted locally** (same HKDF + AES-256-GCM scheme
  as `apps/fiab-console/lib/auth/session.ts`), so you are **signed in** as a
  local dev identity — no Entra/MSAL round-trip.
- Every UI surface — the shell, navigation, catalog, editors, wizards — renders
  and is navigable.
- Panels that need an Azure backend show their **designed, honest "not
  configured" MessageBar gate** (per `.claude/rules/no-vaporware.md`). That is
  the supported unconfigured state, **not** an error or a mock.
- To light up **live data**, add the relevant `LOOM_*` vars to
  `apps/fiab-console/.env.local`; the same UI then calls the real backend.

If you need real data end-to-end, deploy the platform (see
[`docs/fiab/`](./) and the `no-vaporware.md` from-scratch path) and point
`.env.local` at it — the local profile is for **UI / UX / navigation / editor**
development and fast iteration, not for exercising live Azure services.

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | >= 20 | `apps/fiab-console/package.json` `engines.node` |
| pnpm | >= 9 | `npm i -g pnpm@latest` |
| Console dependencies | — | `pnpm install` at the repo root |

Run the validator any time to see exactly what's ready and what's missing:

```bash
node scripts/dev/check-local-profile.mjs
```

It prints `PASS` / `FAIL` / `info` per requirement plus a concrete fix, and
exits non-zero if a **required** prerequisite is missing.

## The one command

```bash
# from the repo root
pnpm install                                   # once — installs console deps
node scripts/dev/local-golden-path.mjs         # prepare, self-test, then `next dev`
```

What it does, in order:

1. **Seeds `apps/fiab-console/.env.local`** (gitignored) if absent — a generated
   `SESSION_SECRET`, `LOOM_CLOUD` / `AZURE_CLOUD` defaults, and a
   `LOOM_TENANT_ADMIN_GROUP_ID` sentinel so the local user is a tenant admin and
   sees the full navigation. It **never overwrites** values you already set.
2. **Mints a local `loom_session` cookie** and **self-tests it** by decoding it
   back with the same secret (the exact operation `getSession()` performs). If
   the round-trip fails it aborts loudly rather than shipping a broken sign-in.
3. **Writes a Playwright storage state** to
   `apps/fiab-console/.auth/loom-local-state.json` (gitignored) so
   Playwright/UAT runs against `http://localhost:3000` start already signed in.
4. **Runs the readiness check** and prints the status.
5. **Starts `next dev`** at <http://localhost:3000> (unless `--prepare-only`).

Flags:

- `--prepare-only` — seed `.env.local`, mint the session, run the check, but do
  **not** start the dev server (useful in CI or when you run `next dev` yourself).
- `--start` — explicit form of the default (prepare, then start).

## Signing a normal browser in

The dev server is running and the storage state signs Playwright in
automatically. To sign your **own** browser in without MSAL, paste the minted
cookie (full value is in `apps/fiab-console/.auth/loom-local-state.json`) at
<http://localhost:3000> via DevTools:

```js
document.cookie = 'loom_session=<value-from-loom-local-state.json>; path=/';
```

Then reload — the top-bar avatar shows the local dev identity and `/api/me`
reports `authenticated: true`.

## Lighting up live data (optional)

Add any of these to `apps/fiab-console/.env.local` and restart `next dev`. Each
unset var simply keeps its surface in the honest "not configured" gate — you can
enable exactly the backends you need:

```bash
LOOM_SUBSCRIPTION_ID=<your-sub-guid>
LOOM_SYNAPSE_WORKSPACE=<workspace-name>
LOOM_COSMOS_ENDPOINT=https://<acct>.documents.azure.com:443/
LOOM_PURVIEW_ACCOUNT=<purview-account>
# …and the per-service vars the surface's gate names.
```

The console authenticates to Azure with `DefaultAzureCredential`, so `az login`
(or a service-principal via the standard `AZURE_*` env vars) must be able to
reach those resources from your machine or VPN. The full catalog of `LOOM_*`
vars each surface reads is enforced by `scripts/ci/check-env-sync.mjs`.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `check-local-profile` says `console-deps` FAIL | Run `pnpm install` at the repo root. |
| Signed out immediately after pasting the cookie | `SESSION_SECRET` in `.env.local` changed after the cookie was minted. Re-run `node scripts/dev/local-golden-path.mjs --prepare-only`. |
| A panel shows a warning MessageBar naming an env var | Expected in demo mode — set that `LOOM_*` var to enable the backend. |
| pnpm version too old | `npm i -g pnpm@latest` (engines require pnpm >= 9). |

## Files

- `scripts/dev/local-golden-path.mjs` — the one-command launcher (J1).
- `scripts/dev/check-local-profile.mjs` — the readiness validator (J2).
- `apps/fiab-console/.env.local` — generated, gitignored local config.
- `apps/fiab-console/.auth/loom-local-state.json` — minted session (gitignored).
