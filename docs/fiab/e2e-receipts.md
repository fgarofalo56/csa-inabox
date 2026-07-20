# CSA Loom — the repeatable browser-E2E receipt path

> **Why this exists.** Die-hard rule **G1** (`.claude/rules/ux-baseline.md` §Platform
> standards; `docs/fiab/ux-standards.md` §9) and `no-vaporware.md`: **no surface is
> "done" / "A grade" until a full in-browser E2E proves it works against the LIVE
> console with REAL data and a MINTED session.** `tsc` + `vitest` + DOM-string checks
> are NOT completion evidence — on 2026-07-15 a change passed every CI gate and still
> hard-froze the renderer live, and Browse pages rendered fine with 0-counts because
> the data path was dead. Only the browser catches both. This page is the **one
> sanctioned way to produce that evidence**: a screenshot (light + dark) + a Playwright
> trace of a target route, captured against the live console with a pre-minted
> `loom_session` cookie (no MSAL, no MFA, no user credentials).

---

## TL;DR

```bash
# 1. Offline self-test — proves the session mint round-trips (no live target needed)
SESSION_SECRET=any-nonempty node scripts/csa-loom/e2e-receipt.mjs --route /catalog --dry-run

# 2. Real receipt — LOCAL, over the P2S VPN, with the real secret from Key Vault
export LOOM_URL=https://<your-console-hostname>
export SESSION_SECRET=$(az keyvault secret show --vault-name <loom-kv> --name session-secret --query value -o tsv)
node scripts/csa-loom/e2e-receipt.mjs --route /admin/readiness

# 3. Real receipt — CI, the AUTHORITATIVE in-VNet path (no VPN, no secret on your box)
gh workflow run loom-ui-verify.yml -f target_route=/admin/readiness
#   → artifact: loom-ui-verify-report-<run_id>  (contains test-results/receipts/)
```

Receipts land in **`apps/fiab-console/test-results/receipts/`** (gitignored):

| File | What it is |
|------|------------|
| `receipt-<slug>-light.png` | Full-page screenshot, light theme |
| `receipt-<slug>-dark.png`  | Full-page screenshot, dark theme |
| `trace-<slug>-<theme>.zip` | Playwright trace (open with `pnpm exec playwright show-trace <zip>`) |
| `receipt-<slug>.json`      | Metadata: target URL, HTTP status, page title, body-char count, timings |

`<slug>` defaults to the route with slashes → dashes (`/admin/readiness` → `admin-readiness`); override with `--slug`.

---

## How it works

The console session is an AES-256-GCM cookie (`loom_session`) whose key is
`HKDF-SHA-256(SESSION_SECRET, …, 'loom-session-v1')`. Given `SESSION_SECRET`
(from the loom Key Vault) the harness mints a valid cookie entirely in Node —
no browser login, no MFA. The receipt driver:

1. **Mints** the cookie via the shared minter
   `apps/fiab-console/e2e/auth/mint-cookie.mjs` — the SINGLE source of the mint
   algorithm for `.mjs` tooling, byte-identical to `lib/auth/session.ts` and
   `e2e/auth/mint-session.ts`. **It does not reinvent the crypto.**
2. **Launches** headless Chromium (resolved from the `apps/fiab-console`
   package) with that cookie as Playwright `storageState`.
3. **Navigates** to the target route, waits for the page to settle
   (`networkidle` + optional `--wait-selector` / `--wait-text` + a settle delay)
   so real data has landed, and captures the screenshot + trace **twice** —
   once with `colorScheme: light` and once `dark` (it also seeds
   `localStorage['loom.theme']`, which the console's theme context prefers, so
   the captured surface is unambiguously in the requested theme).

### Honest failure — it never fabricates a receipt

| Situation | Exit code | What you see |
|-----------|-----------|--------------|
| Mint round-trip verified (dry-run) | `0` | `DRY-RUN OK — session mint verified` |
| Receipt captured | `0` | per-theme `HTTP <status> · "<title>" · <n> body chars` + `RECEIPT OK` |
| Console **unreachable** (DNS / conn refused / TLS / nav timeout) | `2` | `UNREACHABLE — could not load <url>` + the exact likely cause (VPN not connected / private-link / wrong `LOOM_URL`). No screenshot is written. |
| Session **rejected** (route bounced to sign-in) | `3` | `SESSION REJECTED — … redirected to a sign-in page` (stale/wrong `SESSION_SECRET`); a sign-in screenshot is still saved as evidence. |
| Missing `SESSION_SECRET` / `LOOM_URL` | `1` | precise message naming the missing var and how to set it |

This is the `no-vaporware.md` contract: a receipt is a screenshot of the live
surface with real data, **or** an honest explanation of exactly what is
unreachable — never a faked image.

---

## Flags

| Flag | Default | Purpose |
|------|---------|---------|
| `--route <path>` | `/` | Target route (e.g. `/catalog`, `/admin/readiness`, `/workspaces`) |
| `--slug <slug>` | derived from route | Artifact filename slug |
| `--url <baseUrl>` | `$LOOM_URL` | Console base URL |
| `--out <dir>` | `apps/fiab-console/test-results/receipts` | Output directory |
| `--themes <list>` | `light,dark` | Comma list; subset of `light,dark` |
| `--wait-selector <css>` | — | Extra selector to wait for before capture |
| `--wait-text <text>` | — | Extra visible text to wait for before capture |
| `--timeout <ms>` | `45000` | Per-navigation timeout |
| `--settle <ms>` | `1200` | Post-`networkidle` settle before screenshot |
| `--dry-run` / `--prepare` | off | Offline mint self-test + reachability probe (no browser) |

Env: `SESSION_SECRET` (required, never logged), `LOOM_URL`,
`LOOM_AUTOMATION_OID` / `LOOM_AUTOMATION_UPN` / `LOOM_AUTOMATION_NAME`
(audit-visible identity baked into the minted session).

---

## Path 1 — Local, over the P2S VPN

The live console origin is **private-link only**; the public vanity host
`https://<your-console-hostname>` reaches it through Azure Front Door. The
**session Key Vault is private-link-locked**, so reading `SESSION_SECRET`
requires being on the network. Connect the admin **P2S VPN**
(`vpngw-loom-centralus`, AAD/OpenVPN — see
[`csa_loom_vpn_access`](../../CLAUDE.md) memory / your admin runbook), then:

```bash
# 1. Resolve the loom Key Vault + read the secret (needs Key Vault Secrets User)
KV=$(az keyvault list -g rg-csa-loom-admin-centralus --query "[0].name" -o tsv)
export SESSION_SECRET=$(az keyvault secret show --vault-name "$KV" --name session-secret --query value -o tsv)

# 2. Point at the console + capture
export LOOM_URL=https://<your-console-hostname>
node scripts/csa-loom/e2e-receipt.mjs --route /catalog
open apps/fiab-console/test-results/receipts/receipt-catalog-light.png
```

> **Secret note.** The console currently stores `SESSION_SECRET` as a
> container-app *literal* that is not yet synced to the KV `session-secret`
> value (tracked desync). If a KV-read cookie is rejected (exit 3), read the
> live literal instead:
> `az containerapp secret show -n loom-console -g rg-csa-loom-admin-centralus --secret-name session-secret --query value -o tsv`.

If you are **not** on the VPN the script exits `2` (`UNREACHABLE`) — that is the
honest signal, not a bug. Use Path 2.

---

## Path 2 — CI, the authoritative in-VNet path (recommended)

Because the KV is private, a public GitHub-hosted runner cannot read
`SESSION_SECRET`. The **`loom-ui-verify`** workflow
(`.github/workflows/loom-ui-verify.yml`) runs on the in-VNet, scale-to-zero
**`gh-aca-runner`** (`runs-on: [self-hosted, loom-aca]`), fetches
`SESSION_SECRET` from Key Vault via **OIDC**, and mints the cookie there. This
is the path that works with **no VPN and no secret on your machine**.

### Capture a receipt

```bash
# Manual dispatch with a target route:
gh workflow run loom-ui-verify.yml \
  -f target_route=/admin/readiness \
  -f target_slug=admin-readiness            # optional; derived from the route if omitted

# or from the GitHub UI: Actions → loom-ui-verify → Run workflow → set "target_route"
```

When `target_route` is set, the workflow runs the receipt driver after its
standard smoke and uploads everything under
`apps/fiab-console/test-results/receipts/` in the run artifact
**`loom-ui-verify-report-<run_id>`**. Download it and open the `receipt-*.png`
files / `show-trace` the `trace-*.zip`.

The workflow inputs:

| Input | Default | Meaning |
|-------|---------|---------|
| `target_route` | `''` | Route to capture a receipt for. Empty ⇒ smoke-only (no receipt). |
| `target_slug`  | `''` | Optional artifact slug (else derived from the route). |
| `console_url`  | `vars.LOOM_VERIFY_URL` | Console URL to verify. |
| `region` / `admin_rg` / `kv_name` | see workflow | KV auto-discovery inputs. |

Leaving `target_route` blank keeps the original behaviour: the `verify`
Playwright project runs the admin-plane smoke + API probes only.

### In-VNet Container App Job (no GitHub Actions)

For a fully headless capture from inside the estate, the same driver runs in the
`loom-uat` Container App Job path
(`scripts/csa-loom/deploy-loom-uat-job.sh`, image `Dockerfile.uat`). The job
reuses the console image + UAMI (already has AcrPull + KV/Storage). See
`docs/fiab/agent-unattended-access.md` §"Full visual UAT" for deploy/trigger
and blob-upload of results.

---

## Attaching a receipt to a PR

Per `no-vaporware.md` "Validation per merge" and G1, a PR touching any surface
must carry a real-data E2E receipt in the body:

1. Run the receipt (Path 1 or 2) for the route you changed.
2. Drag `receipt-<slug>-light.png` and `receipt-<slug>-dark.png` into the PR
   description (GitHub uploads them).
3. Paste the driver's summary line(s), e.g.
   `light → HTTP 200 · "CSA Loom Console" · 4821 body chars · 3140ms`, and the
   `receipt-<slug>.json` status block.
4. For a CI-captured receipt, link the `loom-ui-verify-report-<run_id>` artifact.

A reviewer **rejects** a PR whose surface has no receipt (or only a `tsc` +
`vitest` green).

---

## What is reachable from where

| From | Reaches Front Door vanity URL | Reaches private KV (`SESSION_SECRET`) | Can capture a real authenticated receipt |
|------|-------------------------------|----------------------------------------|-------------------------------------------|
| Public host / GitHub-hosted runner | ✅ (renders the public shell; data routes gate) | ❌ | ❌ (no secret) |
| Laptop on the P2S VPN | ✅ | ✅ (Key Vault Secrets User) | ✅ (Path 1) |
| In-VNet `gh-aca-runner` / `loom-uat` CA Job | ✅ | ✅ (via OIDC / UAMI) | ✅ (Path 2 — authoritative) |

The public shell renders for anyone (the top-right **Request access** button is
the tell that the session was *not* accepted); **real data + an authenticated
identity require the real `SESSION_SECRET`**, which only the VPN and in-VNet
paths can read.

---

## Files

| Path | Purpose |
|------|---------|
| `scripts/csa-loom/e2e-receipt.mjs` | The receipt driver (this doc's subject) |
| `apps/fiab-console/e2e/auth/mint-cookie.mjs` | Shared pure-Node cookie minter (single source for `.mjs` tooling) |
| `apps/fiab-console/e2e/auth/mint-session.ts` | Playwright-setup minter (TS; used by the `verify`/`uat` projects) |
| `apps/fiab-console/playwright.config.ts` | `mint` / `verify` / `uat` projects |
| `.github/workflows/loom-ui-verify.yml` | In-VNet OIDC verify + receipt capture (Path 2) |
| `docs/fiab/agent-unattended-access.md` | The unattended-auth security model + `loom-uat` job |

Related rules: `.claude/rules/ux-baseline.md` (G1), `.claude/rules/no-vaporware.md`,
`.claude/rules/ui-parity.md`, `docs/fiab/ux-standards.md` §9.
