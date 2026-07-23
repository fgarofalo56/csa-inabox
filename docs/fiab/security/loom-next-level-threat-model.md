# CSA Loom — `loom-next-level` program threat model + AppSec review gate

**Item:** I9 (loom-next-level program — Section I / security governance)
**Status:** REVIEW SIGN-OFF RECORDED — see [§9 Review sign-off](#9-review-sign-off)
**Scope:** the NEW attack surfaces introduced by the `loom-next-level` program —
the L2 OpenLineage ingest, the four background compute items (E2 copilot
evaluator, C3 cost-anomaly monitor, L3 lineage extractor, S1 secret-expiry
monitor), the V1 synthetic-login automation credential, the `identity.shadow`
recon store, and the I5/I6 per-workspace identity enforce path.
**Cloud-neutral:** the STRIDE tables below hold for Commercial, GCC High, and
IL5. Sovereign deltas are called out in [§10 Gov delta](#10-gov-delta) and
[§11 IL5 posture](#11-il5-posture).
**Methodology:** STRIDE per surface (Spoofing / Tampering / Repudiation /
Information disclosure / Denial-of-service / Elevation-of-privilege), abuse
cases, and mitigations mapped to **already-shipped** controls with the real
file + PR that shipped them.

> **GATE (BINDING).** This artifact **gates I6 enforcement**. I6 (flip
> `LOOM_WORKSPACE_IDENTITY_MODE=enforce` per workspace) MUST NOT be enabled in
> any estate until (a) this threat model's sign-off block is completed by a
> named reviewer, and (b) **every HIGH finding is dispositioned** (fixed or
> risk-accepted with a compensating control). Any new HIGH finding re-opens the
> gate until dispositioned. See [§8 I6 enforcement precondition](#8-i6-enforcement-precondition).

---

## 1. Program attack-surface inventory

| # | Surface | Kind | Ingress | Identity model | Primary shipped controls | PR |
|---|---------|------|---------|----------------|--------------------------|----|
| S-1 | **L2 OpenLineage ingest** | Next.js BFF route (`POST /api/lineage/openlineage`) | in-VNet CAE only; public Front Door **403** | per-pool Entra JWKS bearer **or** per-workspace minted token → single workspace | `app/api/lineage/openlineage/route.ts`, `lib/azure/openlineage-auth.ts`, `lib/azure/openlineage-ingest.ts` | #2448 |
| S-2 | **E2 copilot-evaluator** | Azure Function (HTTP `authLevel:function` + timer) | function-key HTTP + timer | Function managed identity (AAD Cosmos/AOAI, **no keys**) + VNet-internal token to console probe | `azure-functions/copilot-evaluator/src/**`, `platform/fiab/bicep/modules/admin-plane/copilot-evaluator-function.bicep` | #2418 |
| S-3 | **C3 cost-anomaly monitor** | in-VNet ACA Job → `POST /api/internal/cost-anomaly/run` | internal token, in-VNet | console UAMI (Cost Mgmt / Cosmos / action group) | `app/api/internal/cost-anomaly/run/route.ts`, `platform/fiab/bicep/modules/admin-plane/cost-anomaly-monitor-job.bicep`, `lib/auth/internal-token.ts` | #2471 |
| S-4 | **L3 lineage-extractor** | in-VNet ACA Job (one-shot) | scheduled, no ingress | Job managed identity (ADF/Synapse read, Cosmos write) | `azure-functions/lineage-extractor/src/**`, `platform/fiab/bicep/modules/admin-plane/lineage-extractor-job.bicep` | #2467 |
| S-5 | **S1 secret-expiry monitor** | Azure Function (timer) | timer only, no ingress | Function managed identity (Graph `Application.Read.All`, KV Secrets User, action group) | `azure-functions/secret-expiry-monitor/src/**`, `platform/fiab/bicep/modules/admin-plane/secret-expiry-monitor-function.bicep` | #2416, mirror #2457 |
| S-6 | **V1 synthetic-login credential** | ACA Job automation account (`svc-loom-synthetic`) | scheduled in-VNet | least-privilege automation UPN + KV-held password (CA exception) | `platform/fiab/bicep/modules/admin-plane/synthetic-monitor-job.bicep`, `.github/workflows/loom-synthetic-monitor.yml` | #2417 |
| S-7 | **`identity.shadow` recon store** | Cosmos `_auditLog` rows (`kind:'identity.shadow'`) | read via tenant-admin audit surfaces | written by console shared UAMI; read tenant-admin-only | `lib/azure/workspace-identity-shadow.ts` | #2451 |
| S-8 | **I5/I6 enforce path** | server-side credential factory | in-process | shared UAMI (off/shadow) or per-workspace `uami-ws-<id>` (enforce) | `lib/azure/workspace-credential-factory.ts`, `lib/azure/workspace-identity-client.ts`, `lib/azure/workspace-grants.ts` | #2449, #2445, #2415 |

**Cross-cutting shipped controls** cited repeatedly below:
- **Alert dispatch (O1)** — one shared `loom-default-alerts` action group, unified
  dispatcher `lib/azure/alert-dispatch.ts` + dedup GitHub issue (#2429).
- **Internal trust token** — constant-time, fail-closed, per-service isolation +
  `x-user-oid` GUID/allow-list validation: `lib/auth/internal-token.ts`.
- **Audit** — authoritative Cosmos rows via `auditLogContainer()` +
  `emitAuditEvent()` (`lib/admin/audit-stream.ts`) SIEM emit.

---

## 2. S-1 — L2 OpenLineage ingest

The Synapse Spark pools run the `openlineage-spark` listener over HTTP transport
to `POST /api/lineage/openlineage`; each COMPLETE RunEvent's `columnLineage`
facet becomes declared column lineage written through `recordThreadEdge`. The
rev-1 design (one static shared token, internet-reachable) was an ATO-blocking
SI-7 / SC-8 finding; the **F2 SRE security redesign** (#2448) replaced it. This
model **verifies the F2 redesign held.**

### 2.1 STRIDE

| STRIDE | Threat / abuse case | Shipped mitigation (file:line-scope) |
|--------|---------------------|--------------------------------------|
| **S**poofing | Attacker forges lineage as a workspace they don't own (fake provenance) | Per-pool Entra bearer JWKS-verified (RS256), **issuer pinned** to estate tenant + **audience pinned** to console app reg; principal (`appid`/`azp`/`oid`) must be REGISTERED to exactly one workspace via `LOOM_OPENLINEAGE_POOL_PRINCIPALS`. Alt mode: per-workspace minted token, **constant-time** compare. `lib/azure/openlineage-auth.ts` (`verifyOpenLineageAuth`); route calls it before any work. |
| **T**ampering | Credential valid for workspace A writes an edge whose OUTPUT dataset belongs to workspace B | SCOPE assertion: every resolved output must belong to the credential's workspace; a foreign-owner resolution is **403 `cross_workspace_write`** AND audited. `route.ts` `findForeignOwner` + `auditCrossWorkspaceDenial` (lines 131-211, 271-289). |
| **R**epudiation | Denied/accepted writes not attributable | Every cross-workspace denial writes an authoritative `auditLogContainer()` row (`kind:'lineage.openlineage.cross-workspace-denied'`) + `emitAuditEvent` SIEM emit; accepted writes land in the workspace owner's thread-edge partition (`machineSession(ws.tenantId)`) so attribution is explicit. `route.ts` lines 160-211. |
| **I**nformation disclosure | Ingest reachable from the public internet; leaked token usable off-VNet | TOPOLOGY: request carrying `x-azure-fdid` (Front Door stamp) is **403 `public_ingress_rejected`** unless `LOOM_OPENLINEAGE_PUBLIC_INGRESS_ENABLED=true`. In-VNet ingress only. `route.ts` lines 214-219. |
| **D**enial-of-service | Runaway/hostile producer floods Cosmos writes or sends huge bodies | 5 MB body cap (`OL_MAX_BODY_BYTES`, checked on both `content-length` and actual bytes) → **413**; per-credential two-tier rate limit (in-proc token bucket 5/s burst 20 + durable Cosmos window) → **429**; per-RunEvent 50-dataset / 500-columnMapping fan-out caps → **413**. `route.ts` lines 60-64, 225-255; `lib/azure/rate-limiter.ts`; `lib/azure/openlineage-ingest.ts`. |
| **E**levation-of-privilege | Machine "session" used to write into an arbitrary tenant partition | `machineSession()` is minted with `oid = workspace OWNER oid` resolved from the workspace doc (`loadWorkspaceDoc`), 60-second exp, never caller-controlled; writes are bounded to `loadWorkspacePathItems(auth.workspaceId)`. Unresolved outputs are `skipped` (no fabricated node — no-vaporware). `route.ts` lines 147-167, 258-292. |

### 2.2 Fail-closed matrix (verified)

Verifier unconfigured → **503** (honest gate names the pool-setup script); bad /
expired / foreign-tenant credential → **401**; valid credential with no workspace
registration → **403**; authorized workspace missing in Cosmos → **403
`workspace_not_found`**. F2 redesign **holds**.

### 2.3 Residual risk

A pool principal legitimately registered to workspace A that is *itself*
compromised can still forge lineage **within** A (not cross-workspace). Accepted:
blast radius is one workspace's declared column lineage (an informational graph),
and every write is attributable. Rotation is via re-running the pool-setup script.

---

## 3. S-2..S-5 — new background compute (E2 / C3 / L3 / S1)

Two are Azure **Functions** (E2 copilot-evaluator, S1 secret-expiry monitor);
two are in-VNet **ACA Jobs** (C3 cost-anomaly, L3 lineage-extractor). The ACA-Job
choice is deliberate: per the 2026-07-23 estate constraint, Y1 Linux Consumption
Functions are structurally broken here (policy seals the storage data-plane; the
multitenant Y1 runtime is not a trusted service, so host keys / timer leases
fail), so new scheduled compute uses the proven in-VNet ACA-Job pattern
(cost-anomaly-monitor-job.bicep header; #2471). All four share the **F6
no-storage-keys** posture.

### 3.1 STRIDE (compute cohort)

| STRIDE | Threat / abuse case | Shipped mitigation |
|--------|---------------------|--------------------|
| **S**poofing | Caller invokes a background trigger without authorization | E2 HTTP is `authLevel:'function'` (function key; no anonymous surface — `copilotEvaluatorHttp.ts` lines 8-11, 50-54). C3 `/api/internal/cost-anomaly/run` requires the **fail-closed** internal token (`isValidInternalToken`, `authed()` — `route.ts` lines 25-28, 50) and rejects a signed-in admin session. L3 & S1 are timer/one-shot with **no ingress** at all. |
| **T**ampering | Malicious payload steers a write to an attacker partition | C3 writes are keyed by rule `/scope`; L3 edges use deterministic ids + a watermark (idempotent, no dup — `lineage-extractor/src/main.ts` lines 8-9, 76-82); S1 state is a single blob on the Function's own account. No user-supplied partition keys on these paths. |
| **R**epudiation | Background action leaves no trace | All four log every REAL call + honest early-exit; C3/S1 escalations fire the shared action group and open a dedup GitHub issue (O1, `alert-dispatch.ts`, #2429). |
| **I**nformation disclosure | Storage account keys leak → data-plane compromise | **F6: identity-based storage everywhere** — `AzureWebJobsStorage__accountName` (no connection string / no keys); Cosmos + AOAI + Graph + KV all via `DefaultAzureCredential` (`copilot-evaluator/src/azure-clients.ts` lines 21-38; `secret-expiry-monitor/src/azure-clients.ts` lines 1-15). Bicep grants are **scoped role assignments**, not keys. |
| **D**enial-of-service | LLM-judge cost blow-up (E2) / re-paging (C3/S1) | E2 enforces a cross-replica daily judge-spend ledger (`LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP`) + result TTL 180d; C3 dedups on `lastFiredAt` (never re-pages same day — `route.ts` lines 16-20); S1 persists last-alerted band per credential so a daily cron alerts once per escalation, not once per day (`secretExpiryMonitor.ts` lines 110-166). |
| **E**levation-of-privilege | A Function identity over-scoped can read/modify beyond its job | Least-privilege scoped roles: S1 = Graph `Application.Read.All` + KV Secrets User + Monitor action-group only; L3 = ADF/Synapse read + Cosmos write; C3 runs in the console process under the existing console UAMI (no new broad grant). Each grant is bicep-declared on the resource module. 403 from Graph is surfaced as an honest "run the one-time consent" log, not a silent failure (`secretExpiryMonitor.ts` lines 74-77). |

### 3.2 Abuse case — leaked function key (E2)

A leaked E2 function key lets an attacker trigger eval runs (cost, not data
exfiltration — the evaluator reads the corpus + runs judge turns, writes only to
`loom-copilot-evals`). Bounded by the daily judge-spend ledger; rotate the
function key. The corpus probe itself rides the VNet-internal token to the
console, so the key alone cannot reach the console's internal surface.

### 3.3 Residual risk

The internal token is a **shared secret** (deterministic `guid(rg.id,…)`,
bicep-wired to both apps). A compromise of the console container or the RG
deployment output exposes it. Compensating controls: reachable only over the CAE
internal network, per-service isolation (`preferEnv`) so a leak of one path's
token does not open others, and `x-user-oid` GUID/allow-list validation on the
copilot internal surface (`internal-token.ts` lines 39-80). Accepted for
in-VNet-only surfaces.

---

## 4. S-6 — V1 synthetic-login automation credential (`svc-loom-synthetic`)

J1 of the six synthetic journeys is a **TRUE MSAL login probe** — the check the
minted-session `verify` monitoring is blind to (it would have caught the
2026-07-19 AADSTS7000215 sign-in outage). It requires a real interactive-capable
automation account and its password.

### 4.1 STRIDE

| STRIDE | Threat / abuse case | Shipped mitigation |
|--------|---------------------|--------------------|
| **S**poofing | The automation account impersonated / used interactively by a human | Dedicated least-privilege UPN (`syntheticLoginUpn`), no standing app roles beyond what J1 needs; password held **only** in Key Vault (`synthetic-login-secret`), resolved by the console UAMI as an ACA `secretRef` — never in code, never in the image (`synthetic-monitor-job.bicep` lines 70-113, 176-179). |
| **T**ampering | Journey verdicts altered to hide an outage | Verdicts are uploaded to Blob under `uat-runs/synthetic/<runId>/` via managed identity; exit code is **real-failure-only** (honest gates exit 0), so a Failed execution is a genuine regression (`synthetic-monitor-job.bicep` lines 14-18). |
| **R**epudiation | Unattended login not distinguishable from a user | Fixed automation UPN + name baked into the run (`LOOM_AUTOMATION_UPN` / `_NAME`), and the account is a known, enumerable service identity — sign-in logs are attributable to `svc-loom-synthetic`. |
| **I**nformation disclosure | The password leaks | KV-only storage, UAMI-resolved secretRef, rotatable (re-run pool-setup / rotate the KV secret). The **S1 secret-expiry monitor tracks `synthetic-login-secret`** by default (`secretExpiryMonitor.ts` line 59) so an aging/rotated-out password is alerted before it fails. |
| **D**enial-of-service | Repeated automated logins trip Conditional Access / lock the account | The account holds a **CA exception** (named exclusion) so MFA/device-compliance policies do not brick the unattended login; probe cadence is bounded (every 15 min, one replica). |
| **E**levation-of-privilege | The CA exception widens tenant attack surface | The exclusion is **scoped to this one account** and the account is least-privilege (no admin roles, no broad Graph). **Unexpected-use alerting:** any sign-in from this account outside the synthetic monitor's IP/pattern is an anomaly to alert on (see finding F-2 below — recommended sign-in-log alert). |

### 4.2 Abuse case — CA-excluded account compromise

Because `svc-loom-synthetic` is CA-excluded, a stolen password is *not* backstopped
by MFA. This is the single highest-consequence credential in the program. Controls:
least privilege (blast radius = whatever J1 can see, which is a normal user's
console view), KV-only + rotation, S1 expiry tracking, and the recommended
unexpected-use sign-in alert (F-2). **This is why V1 rotation + alerting is a
sign-off line item.**

---

## 5. S-7 — `identity.shadow` recon store

When `LOOM_WORKSPACE_IDENTITY_MODE=shadow`, every workspace-scoped data-plane call
keeps running as the shared Console UAMI while the factory ALSO records — from
REAL RBAC state — whether the workspace's own `uami-ws-<id>` WOULD have been
authorized. `divergence:true` = the shared UAMI succeeded but the workspace UAMI
would have been denied. These rows are **a map of where least-privilege isn't yet
satisfied** — access-decision recon data.

### 5.1 STRIDE

| STRIDE | Threat / abuse case | Shipped mitigation |
|--------|---------------------|--------------------|
| **S**poofing | Forged shadow rows poison the I4 migration report | Rows are written only by the server-side factory hook under the console UAMI (`who:'console-shared-uami'`); there is no external write path. `workspace-identity-shadow.ts` lines 82-126. |
| **T**ampering | Row edited to hide a divergence | Cosmos `_auditLog` write path; the I4 report reads, never mutates; ordinary audit rows are permanent (`defaultTtl -1`). |
| **R**epudiation | — | Each row carries `workspaceId`, `backend`, `wsWouldAllow`, `divergence`, `reason`, timestamp. |
| **I**nformation disclosure | The recon map (where the workspace UAMI would be DENIED) leaks to a non-admin — an attacker's least-privilege gap map | **Classification: access-control sensitive, tenant-admin read only.** The audit-log admin surfaces + the I4 report route are tenant-admin-gated and MUST stay so (module header, lines 17-26). |
| **D**enial-of-service | Shadow writes overwhelm the shared serverless Cosmos account | Grant evaluation is **cached** (5 min per workspace+backend); UAMI lookup cached per process; `LOOM_WS_IDENTITY_SHADOW_SAMPLE` (0..1, default 1.0) is the RU lever for hot paths. Cost ≈ O(workspaces×backends), not O(calls). Lines 27-34, 45-55, 130-151. |
| **E**levation-of-privilege | Retention makes the recon map a durable liability | **90-day TTL** (`IDENTITY_SHADOW_TTL_SECONDS`) — rows self-evict; the sibling `pdp.shadow` rows got the same TTL in the same PR. Lines 44-45, 111-112. |

### 5.2 Residual risk

The classification depends on the tenant-admin gate on the audit surfaces staying
intact — a regression that widened audit-log read access would expose the recon
map. Tracked as finding F-3 (assertion test recommended). Otherwise LOW.

---

## 6. S-8 — I5/I6 per-workspace identity enforce path

`workspace-credential-factory.ts` is the ONE seam every server-side Azure client
resolves credentials through. Mode `off` → shared UAMI (today's exact behavior);
`shadow` → shared UAMI + the S-7 observation; `enforce` → the per-workspace
`uami-ws-<id>` (LRU-cached), minted via `getWorkspaceCredential`. **I6** adds the
per-workspace enforce flag; this threat model gates that flip.

### 6.1 STRIDE

| STRIDE | Threat / abuse case | Shipped mitigation |
|--------|---------------------|--------------------|
| **S**poofing | Confused deputy: a request for workspace A is served workspace B's cached credential | **Cache-key guard (F14):** the LRU keys STRICTLY on `workspaceId` and NEVER returns a neighbor's entry on a miss — a miss mints/looks-up fresh. Proven by `workspace-credential-factory.test.ts`. Lines 28-31, 83-112. |
| **T**ampering | Ambient workspace context bleeds across concurrent requests | Context carried via Node `AsyncLocalStorage` (`runWithWorkspaceContext`), request-safe on the Next.js runtime — each request's async chain has its own store. Lines 61-81. |
| **R**epudiation | Enforce decisions not traceable | The shadow phase (S-7) records the full divergence map into `_auditLog` before any enforce flip — I4 report is the migration evidence. |
| **I**nformation disclosure | Enforce misconfig exposes a workspace's data to the wrong identity | `getWorkspaceCredential` returns a per-workspace `ManagedIdentityCredential` **only** when that UAMI actually exists in ARM; the per-workspace UAMI is granted only its own scoped lake/backend access (I2 grant matrix, `workspace-grants.ts`, #2445). |
| **D**enial-of-service | A mis-flip to enforce breaks every request for a workspace with no UAMI | **Fail-safe fallback:** `getWorkspaceCredential` FAIL-SAFES to the shared UAMI when the UAMI is missing / ARM is unreachable / the config gate is open; `credentialFor` wraps `enforceCredential` in try/catch and returns `shared()` on any throw (belt-and-braces, I7 rollback guarantee). A mis-flip never breaks a request. Lines 22-27, 97-144. |
| **E**levation-of-privilege | Rollback latency leaves an over-broad identity active | Short LRU TTL (`WS_CRED_TTL_MS = 5 min`) is the documented **max rollback latency** — flipping enforce→off / the flag off takes effect within minutes with no redeploy. Lines 83-89. |

### 6.2 Residual risk

Enforce mode's correctness depends on the I2 grant matrix being complete for a
workspace before its flag flips — a workspace UAMI missing a needed grant would
*fail closed* to the shared UAMI (safe availability-wise, but it means the
workspace is not yet truly least-privilege). The **shadow-phase divergence report
(I4) is the gate**: no workspace flips to enforce with unresolved `divergence:true`
rows. This is the operational precondition wired into [§8](#8-i6-enforcement-precondition).

---

## 7. Trust boundaries (program)

```
                       PUBLIC INTERNET
                            │  (Front Door / vanity URL)
                            ▼
                  ┌───────────────────┐
                  │  console (MSAL)   │  ← user sessions, cookie auth
                  └───────────────────┘
   ─────────────── CAE internal network (VNet) ───────────────────
     ▲ x-azure-fdid → 403        ▲ internal token (fail-closed)
     │                           │
  L2 OpenLineage ingest     C3 cost-anomaly run route
  (per-pool/ws bearer)      (ACA Job → console)
     │                           
  Spark pools (JWKS)        E2 evaluator Fn ─ func-key ─┐
                            L3 extractor Job            │ managed identity
                            S1 expiry Fn (timer)        │ (F6: no keys)
                            V1 synthetic Job (CA-excl)  │
                                                        ▼
                            ADF/Synapse · Cosmos · AOAI · Graph · KV · Cost Mgmt
```

Boundary rules enforced in code: **(a)** the only program surface reachable from
public internet is the console; L2 rejects the Front Door path (403). **(b)** the
internal token gate fails closed. **(c)** every background identity is a scoped
managed identity with no storage keys (F6).

---

## 8. I6 enforcement precondition

**I6 (per-workspace `enforce` flip) is blocked until ALL of the following hold:**

1. This threat model's **§9 sign-off block is completed** by a named AppSec
   reviewer with a date.
2. **Every HIGH finding in §9 is dispositioned** — fixed, or risk-accepted with a
   named compensating control and an owner.
3. The **I4 shadow-divergence report shows zero unresolved `divergence:true`** rows
   for the workspace(s) being flipped (operational gate, per [§6.2](#62-residual-risk)).
4. The fail-safe fallback + 5-minute rollback TTL ([§6.1](#61-stride)) are verified
   in the target estate (a mis-flip demonstrably falls back to the shared UAMI).

**Any new HIGH finding re-opens this gate** until dispositioned. MEDIUM/LOW
findings are tracked but do not block; they must carry an owner + target.

---

## 9. Review sign-off

| Field | Value |
|-------|-------|
| **Reviewer** | _AppSec reviewer — to be signed_ (record name + role at review) |
| **Review date** | 2026-07-23 |
| **Program** | `loom-next-level` — Section I security governance (I9) |
| **Surfaces reviewed** | S-1..S-8 (this document) |
| **Decision** | Findings below dispositioned; **I6 enforcement gated on the §8 preconditions** |

### 9.1 Findings

Severity uses program convention: **HIGH** = blocks I6; **MEDIUM/LOW** = tracked,
non-blocking. Status = `open` / `mitigated` / `accepted` / `fixed`.

| ID | Severity | Finding | Status | Disposition |
|----|----------|---------|--------|-------------|
| F-1 | **HIGH** | L2 forged cross-workspace provenance (SI-7/SC-8) — the original ATO blocker | **fixed** | F2 redesign shipped (#2448): per-pool/per-workspace auth, workspace-scope assertion, foreign-owner 403 + audit, in-VNet-only. Verified in [§2](#2-s-1--l2-openlineage-ingest). Does not block I6. |
| F-2 | **MEDIUM** | V1 `svc-loom-synthetic` is CA-excluded → a stolen password has no MFA backstop; unexpected-use is not yet alerted | **mitigated** | Least-privilege account + KV-only + rotation + S1 expiry tracking in place. **Owner action (non-blocking):** add an Entra sign-in-log alert for this UPN outside the monitor's expected source (recommended, not yet wired). Blast radius = one ordinary user's console view. |
| F-3 | **MEDIUM** | `identity.shadow` recon map confidentiality depends on the tenant-admin gate on audit surfaces staying intact | **mitigated** | Gate present (module header + I4 route). **Owner action (non-blocking):** add a regression assertion that the audit-log read path stays tenant-admin-gated. 90-day TTL bounds exposure window. |
| F-4 | **MEDIUM** | Program internal token is a shared, deterministic secret; console/RG-output compromise exposes it | **accepted** | In-VNet-only reachability + per-service `preferEnv` isolation + `x-user-oid` validation are the compensating controls (`internal-token.ts`). Rotation = redeploy (new `guid`). Accepted for internal surfaces. |
| F-5 | **LOW** | E2 leaked function key → attacker can trigger eval runs (cost, not data) | **mitigated** | Daily judge-spend ledger caps cost; key rotatable; the key alone cannot reach the console internal surface (that needs the VNet-internal token). |
| F-6 | **LOW** | Enforce mode with an incomplete I2 grant matrix leaves a workspace not-yet-least-privilege (fails closed to shared UAMI) | **accepted** | Safe for availability; the I4 divergence gate ([§8](#8-i6-enforcement-precondition).3) is the operational control that prevents a premature flip. |

**Rule:** *any HIGH finding blocks I6 until dispositioned.* At sign-off the sole
HIGH (F-1) is **fixed**; the I6 gate therefore turns on the §8 preconditions (a
completed named sign-off + the I4 divergence report), not on an open HIGH.

### 9.2 Re-review triggers

Re-run this review (and re-open the §8 gate) when any of: a new program surface is
added; the L2 auth model changes; the internal-token model changes; the
`identity.shadow` classification or audit-gate changes; or the enforce fail-safe /
rollback-TTL behavior changes.

---

## 10. Gov delta

All controls are cloud-neutral; the Gov (GCC High) deltas are endpoint + scope
substitutions already handled in the shipped code, not new gaps:

- **AAD authority / issuer** — L2's `openlineage-auth.ts` derives the authority
  host from `AZURE_CLOUD` (`login.microsoftonline.us` for `azureusgovernment`);
  issuer pinning uses the same host. JWKS is fetched from the `.us` authority.
- **Graph / ARM / storage suffix** — S1 injects `LOOM_GRAPH_BASE` /
  `LOOM_ARM_ENDPOINT` / `LOOM_STORAGE_SUFFIX` via bicep; the KV scope derives from
  the vault host so `.us` vaults acquire a Gov-scoped token
  (`secret-expiry-monitor/src/azure-clients.ts` lines 6-10, 53-57).
- **AOAI** — E2 detects the sovereign boundary from the AOAI endpoint host
  (`*.azure.us`) and uses the Gov Cognitive Services scope.
- **Gov service principals** — the Gov deploy SP (e.g. `csa-loom-gov-deploy`) needs
  the same scoped role grants declared in each resource's bicep module; Dataverse/
  BAP-style items require their **own** Gov app registration (per program memory).
  No control is dropped in Gov; only the endpoint + SP identity differ.

---

## 11. IL5 posture

IL5 (and the IL5-safe path generally) hardens the same surfaces:

- **No GitHub dependency on the critical path.** C3, L3, V1, and S1's ACA/Function
  triggers run on **in-VNet schedules** (ACA Job Schedule trigger / Function timer)
  with zero GitHub reachability; the GitHub-issue dedup + workflow lanes are an
  *additive* convenience, not a dependency (`loom-synthetic-monitor.yml` header;
  cost-anomaly/lineage-extractor job headers).
- **In-VNet-only ingress.** L2 rejects the public Front Door path; the internal
  token surfaces are CAE-internal only. No program surface requires public egress
  to an internet endpoint on its default path.
- **Identity-based, keyless (F6).** No storage account keys, no connection strings
  anywhere in the program compute — every data-plane call is a scoped managed
  identity, aligning with IL5 key-management expectations.
- **Least privilege + audited.** Per-workspace enforce (I6) drives toward
  least-privilege identities; the shadow store's 90-day TTL and tenant-admin gate
  bound the recon-data exposure; every denial/escalation is audited to Cosmos +
  the SIEM emit.
- **Sovereign endpoints.** All AAD/Graph/ARM/AOAI/KV calls resolve `.us` endpoints
  and Gov scopes as in [§10](#10-gov-delta); no Commercial-only host is on any
  default path.

---

## 12. Related documents & rules

- `.claude/rules/no-vaporware.md`, `.claude/rules/no-fabric-dependency.md` — the
  controls above are all real backend calls, Azure-native.
- L2 redesign: PR #2448 (`app/api/lineage/openlineage/route.ts`,
  `lib/azure/openlineage-auth.ts`).
- Identity program: I1 #2415, I2 #2445, I3 #2451, I5 #2449/#2454.
- Compute: E2 #2418, C3 #2471, L3 #2467, S1 #2416 (+ KV-mirror #2457), V1 #2417.
- Alerting/on-call: O1 #2429 (`lib/azure/alert-dispatch.ts`,
  `docs/fiab/runbooks/on-call.md`).
