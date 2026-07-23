# Workspace-identity migration — shadow → enforce (I7 runbook)

> loom-next-level **I7** (ws-identity-cloudmatrix). The operator play for moving
> a workspace from the shared Console UAMI to its own per-workspace managed
> identity (`uami-ws-<id>`), safely, one workspace at a time, with an **instant
> rollback**. Enforcement stays **operator-gated** — nothing in this runbook is
> auto-flipped.

## Preconditions

- **I9 threat-model sign-off is recorded.** The confused-deputy / least-privilege
  threat model for per-workspace identity must be signed off before ANY
  workspace is flipped to enforce. Enforce is a security-posture change; do not
  proceed without it.
- The workspace-identity ARM config is set: `LOOM_WS_IDENTITY_SUB` (or
  `LOOM_SUBSCRIPTION_ID`) **and** `LOOM_WS_IDENTITY_RG` (or `LOOM_DLZ_RG`). The
  preflight refuses to certify readiness without them.
- The I2 grants have been provisioned for the workspace (they are, by default,
  at workspace create when the mode is not `off`; see
  `workspace-identity-grants.md`).

## The identity modes (I1)

`LOOM_WORKSPACE_IDENTITY_MODE` on the Loom Console container app:

| Mode | Behavior | Who governs |
|---|---|---|
| `off` (default) | Every call runs as the **shared Console UAMI**. Zero cost, no ARM lookup. | — |
| `shadow` | Calls STILL run as the shared UAMI (unchanged); the I3 hook records `identity.shadow` divergence rows. | global |
| `enforce` | Workspace-scoped calls run as `uami-ws-<id>` (LRU-cached), **fail-safing to the shared UAMI** when the UAMI is missing / ARM is unreachable. | global mode **AND** the per-workspace I6 flag |

The global mode is the floor; the **per-workspace I6 enforce flag** (data on the
workspace doc, admin-flippable) is what turns enforce on for one workspace. This
runbook flips that per-workspace flag — never a blanket global enforce.

## The 7 steps

### 1. Set global shadow mode

Set `LOOM_WORKSPACE_IDENTITY_MODE=shadow` on the `loom-console` container app and
roll a new revision. Behavior is byte-for-byte unchanged (calls still run as the
shared UAMI); the credential factory now records divergence observations.

Optional RU lever: `LOOM_WS_IDENTITY_SHADOW_SAMPLE` (0..1, default 1.0) samples
the shadow writes for hot estates.

### 2. Shadow for N days

Let real traffic flow. Aim for a window that exercises every workspace's
data-plane paths (lake reads/writes, warehouse queries, ADX, Cosmos, Event
Hubs). A workspace with **no** observed calls has no evidence — the preflight
warns on `observedCalls === 0`.

### 3. Review the I4 report per workspace

Open **Admin → Workspace identity** (the I4 divergence report; tenant-admin
gated). For each candidate workspace, read the `identity.shadow` rollup:

- `divergences` = the shared UAMI succeeded where `uami-ws-<id>` would have been
  **DENIED**. Every divergence is a grant that must be fixed before enforce.
- Drill into the divergent backends and re-run grant provisioning
  (`ensureWorkspaceGrants`) or fix the underlying scope (see
  `workspace-identity-grants.md`).

Do NOT proceed to enforce while a workspace shows divergences.

### 4. Run the grant-check preflight

The preflight verifies, from **live** ARM + data-plane + the shadow rollup, that
a workspace is ready:

```bash
# Dry-run readiness for every workspace (no changes made):
SESSION_SECRET=<loom-session-secret> \
  node scripts/csa-loom/workspace-identity-enforce.mjs
```

It prints, per workspace: `ready`, `uamiProvisioned`, `missingGrants[]`,
`divergences`, `observedCalls`, and the blocking `reasons[]`. A workspace is
**READY** only when the UAMI is provisioned, `missingGrants` is empty, and
`divergences` is `0`. The same verdict is served by
`GET /api/admin/workspaces/[id]/identity` (I6) — the script calls it when
present and degrades gracefully if the route is absent (older console image).

Backing logic: `apps/fiab-console/lib/azure/workspace-identity-preflight.ts`
(`preflightWorkspaceEnforce`).

### 5. Flip per-workspace enforce (I6)

For each **READY** workspace, flip its enforce flag — in **Admin → Workspace
identity** (the "Enforce" toggle), or:

```bash
# Flip ONLY the ready workspaces (idempotent). --apply is GATED behind --confirm:
SESSION_SECRET=<loom-session-secret> \
  node scripts/csa-loom/workspace-identity-enforce.mjs --apply --confirm
```

`--apply` without `--confirm` refuses (prints the plan and exits). Not-ready
workspaces are skipped and listed with their blockers.

### 6. Smoke-test

Exercise the workspace's primary surfaces (open a lakehouse table preview, run a
warehouse query, open an ADX/eventhouse tile). Watch for `403`/token errors — if
one appears, the credential factory has already fail-safed to the shared UAMI
(the call still succeeds), but the mis-grant must be fixed. Confirm the
`identity.shadow` divergence count stays at 0.

### 7. Rollback (instant)

Rollback is flipping the per-workspace enforce flag back to **false** (I6). It is
**instant**: the I5 credential factory resolves the mode/flag at `getToken` time
and fail-safes to the shared UAMI. There is **no redeploy** and no ARM change.

- **Max rollback latency = the credential LRU TTL.** The factory caches the
  per-workspace credential for `WS_CRED_TTL_MS` (5 minutes —
  `workspace-credential-factory.ts`). An in-flight request holding a cached
  workspace credential keeps using it until the entry expires; the next
  resolution after the flag flip picks up the shared UAMI. So a workspace fully
  returns to shared-UAMI behavior **within 5 minutes** of the flip, with no
  restart.
- Because `getWorkspaceCredential` already fail-safes to the shared UAMI on a
  missing/unreachable UAMI, a bad flip can never hard-break a request — the
  worst case is a call that quietly runs as the shared UAMI.

## Per-cloud appendix

The preflight and the enforce flip are **cloud-neutral** — every ARM /
data-plane host resolves through `cloud-endpoints` (`armBase()`,
`kustoClusterUri()`, …). Only the operator tooling differs:

### Commercial

- Portal: **Admin → Workspace identity** for the report + per-workspace toggle.
- CLI: the `workspace-identity-enforce.mjs` script against the public Front Door
  URL (`LOOM_URL`), authenticated with a minted session cookie
  (`SESSION_SECRET` from the container app's session secret / KV
  `loom-session-secret`).

### GCC-High

- Same script; point `LOOM_URL` at the **gov** Front Door and use the gov
  Console's session secret. ARM hosts resolve to the gov endpoints automatically
  (`isGovCloud()` in cloud-endpoints); no code change.
- If direct browser/CLI reach is restricted, run the script from an **ACA job
  exec** on the in-boundary Console (the gov CI recipe — `az containerapp exec`),
  so the call originates in-VNet.

### IL5 / IL5-DoD (air-gapped)

- **No public ARM egress.** Run the enforce script **in-boundary only** — from
  an ACA job exec on the Console container app inside the VNet. The preflight's
  ARM/data-plane probes run as the Console UAMI, which is already in-boundary; no
  new egress path is introduced.
- The per-workspace flag is Cosmos data, read/written in-boundary. Rollback (flag
  false) works identically and needs no external connectivity.

## Related

- `workspace-identity-grants.md` — the I2 grant matrix + verify commands.
- `apps/fiab-console/lib/azure/workspace-identity-preflight.ts` — I7 preflight.
- `apps/fiab-console/lib/azure/workspace-credential-factory.ts` — I5 factory +
  the LRU TTL that bounds rollback latency.
- `apps/fiab-console/lib/azure/workspace-identity-shadow.ts` — I3 shadow audit.
- `scripts/csa-loom/workspace-identity-enforce.mjs` — the enumerate/preflight/
  apply script.
