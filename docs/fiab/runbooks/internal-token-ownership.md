# `LOOM_INTERNAL_TOKEN` — ownership, rotation, drift

**Status: normative.** This document exists because the same defect broke the
estate three separate times in two days. Read it before you touch anything that
writes, derives, or mirrors the shared internal trust token.

**One sentence: the LIVE ESTATE owns the value; a deploy ADOPTS it and must
never mint a new one on an estate that already has a console.**

---

## 1. What the token is, and who holds it

`LOOM_INTERNAL_TOKEN` gates the VNet-internal, non-cookie-authenticated
service-to-service callbacks — the MAF → Console tool dispatch, the setup
orchestrator, topology `register-domain`, the scheduled jobs, and the CI-side
maintenance calls. `isValidInternalToken()`
(`apps/fiab-console/lib/auth/internal-token.ts`) compares it in constant time and
**fails closed when the expected value is empty**.

It is held in four places:

| Holder | Written by | Read by |
|---|---|---|
| `loom-console` Container Apps secret `loom-internal-token` | **the deploy (adopting the live value)** | the console's `LOOM_INTERNAL_TOKEN` env |
| `loom-internal-token` on each consumer **job** (`loom-copilot-evaluator`, `loom-asset-reconciler`, `loom-cost-anomaly-monitor`) | the same deploy, same value, same run | each job's `LOOM_INTERNAL_TOKEN` env |
| `LOOM_INTERNAL_TOKEN` **GitHub Actions secret** | an operator, once | `loom-docs-reindex`, `copilot-quality-evals`, `csa-loom-skill-learner`, `csa-loom-memory-consolidate`, `csa-loom-spark-keepwarm` |
| opt-in sibling apps (`loom-copilot-maf`, setup orchestrator) | the same deploy | their own env |

---

## 2. What went wrong (recorded so it is not repeated)

`platform/fiab/bicep/modules/admin-plane/main.bicep` computed:

```bicep
var loomInternalToken = guid(loomGeneratedSecretSeed, 'loom-maf-internal-token-v1')
```

and its comment claimed the value was *"deterministic … so the two match"*.

**That claim was false across deployments.** `loomGeneratedSecretSeed` defaults
to `newGuid()`, and the compiled template carries it verbatim:

```console
$ az bicep build --file platform/fiab/bicep/modules/admin-plane/main.bicep --outfile /tmp/a.json
$ jq -r '.parameters.loomGeneratedSecretSeed.defaultValue' /tmp/a.json
[newGuid()]
```

ARM re-evaluates `newGuid()` on **every deployment**. So the value was
deterministic only *within* one deployment: the console and the jobs matched each
other, and **every holder outside that deployment was silently invalidated by
every single admin-plane deploy.** bicep was not "a writer" — it was an
unannounced rotator that ran on every deploy.

Meanwhile out-of-band rotations (an operator or an agent writing the console
secret directly) wrote a different, longer value. **Two writers, no owner.**
Whichever ran last won and the other side mismatched.

The failure is nasty because **Container Apps does not restart replicas on a
secret write.** The mismatch sits latent — sometimes for a day — and detonates
when the console revision happens to cycle:

* **2026-08-06** — console rotated to a 64-char value; the evaluator job and the
  GitHub secret still held the 36-char guid. Everything worked until the replica
  cycled at ~15:20, then execution `loom-copilot-evaluator-e2uo78c` failed
  **153/153 eval probes in 37 s**.
* **2026-08-07/08** — it re-detonated exactly as predicted. Deploys re-minted the
  36-char guid onto the console (`len=36 sha256=209954d26026`) while the GitHub
  secret held the rotated value. That ONE mismatch was the common root of three
  separate failures: the eval gate's zero-row 401 sweeps, **#2929**
  `reindex rejected (HTTP 401) — LOOM_INTERNAL_TOKEN is missing or does not match
  the console env`, and the residual red the #3090 lane could not clear.
* **Stopgap (not a fix)** — the GitHub secret was re-synced from the console's
  live value; `loom-docs-reindex` run 31236715059 went SUCCESS immediately after.

A related, separate defect (#3089, fixed): the `loom-internal-token` *secret* was
declared **conditionally** on `copilotMafActive || loomIqMcpEnabled ||
loomPipelineCiEnabled` while bicep handed `LOOM_INTERNAL_TOKEN=secretref:…` to
five always-deployed jobs **unconditionally**. With all three flags false the
consumers got a secretRef to a secret that was never declared, and
`isValidInternalToken()`'s `if (!expected) return false` made every callback fail
closed on a healthy estate. Both the env and the secret are now declared
unconditionally.

---

## 3. The ownership model, and why the alternatives were rejected

### Chosen: **the live estate owns the value; bicep adopts it**

```bicep
@secure() param loomInternalTokenValue string = ''

var loomInternalToken = empty(loomInternalTokenValue)
  ? guid(loomGeneratedSecretSeed, 'loom-maf-internal-token-v1')   // greenfield ONLY
  : loomInternalTokenValue                                        // adopt what is live
```

Every deploy lane runs `scripts/csa-loom/resolve-internal-token.sh --export`
before `az deployment sub create` and passes the result as
`loomInternalTokenValue`. The lookup is an **ARM control-plane read of the
running console's Container Apps secret**, which needs no VNet and no Key Vault
data plane — so it works from a GitHub-hosted runner, from the in-VNet
self-hosted runner, in Commercial and in Gov, with no extra hop.

Consequences:

* A redeploy re-applies the value the estate already had → **a deploy cannot
  invalidate a working estate.**
* Greenfield (no console to read) resolves empty → bicep mints → **day-one stays
  zero-touch, no operator action.**
* The consumer jobs are stamped in the same deployment with the same value →
  they can never drift from the console via a deploy.

### Rejected: **Key Vault as the single source of truth**

1. **The vault is unreachable from the runners that need the value.** The Loom
   Key Vault is created `publicNetworkAccess: 'Disabled'` with
   `networkAcls.defaultAction: 'Deny'`. That is precisely why
   `ops-kv-secret-sync.yml` exists and why it must run on `[self-hosted, loom-aca]`.
   The GitHub-hosted runners that run the deploys and the five consuming
   workflows have no route to its data plane, so KV could not serve the GitHub
   holder without an extra in-VNet hop. The Container Apps secret is reachable
   from anywhere with RBAC on the app.
2. **It would not stop the clobber by itself.** A bicep-written KV secret writes
   a **new version** on every deploy, and consumers resolve the versionless URI
   at revision/execution start — so the value still changes on every deploy and
   the replica-restart detonation is unchanged.
3. **ARM has no create-if-absent for a KV secret,** so making the value survive a
   redeploy would need a VNet-injected `deploymentScript` (not default-on here),
   and a `keyVaultUrl` secretRef pointing at a secret that does not exist yet
   fails the **whole console revision** — the hazard already documented at
   `admin-plane/main.bicep`'s risingwave note.

KV-backed ACA secrets *are* proven on this estate (`session-secret`,
`loom-msal-client-secret`, `loom-risingwave-password`, `loom-azure-maps-key`,
`loom-ducklake-catalog-url` all resolve `keyVaultUrl` live), so the pattern
works — it is the wrong instrument for *this* secret, not a broken one.

### Rejected: **bicep owns it, rotation removed**

bicep's value is `guid(newGuid(), …)` — non-deterministic **by construction**. So
"bicep owns it + a post-deploy sync of the GitHub secret" still leaves a
mandatory mismatch window on **every** deploy: ARM writes the new value to the
jobs immediately, while the console's running replicas keep serving the OLD value
until the revision cycles. That is exactly the latent detonation #3056 measured.

Making bicep's value stable enough to fix that requires either an
offline-derivable `guid(resourceGroup().id, <public-const>)` — a forgery vector
the repo explicitly forbids (`loomGeneratedSecretSeed`'s own `@description`
documents why: `/api/internal/*` is publicly routable and token-gated) — or a
persisted store, at which point it collapses into one of the other two options.

---

## 4. How to rotate (the ONLY supported path)

Rotation is a write to **the owner**, not to bicep:

```bash
# 1. Write a new value to the owner of record. Prints a fingerprint, never the value.
scripts/csa-loom/resolve-internal-token.sh --rotate

# 2. Redeploy (or run the deploy workflow). bicep ADOPTS the new value and
#    re-stamps every consumer job in the same deployment.

# 3. Update the LOOM_INTERNAL_TOKEN GitHub Actions secret to the same value.
#    GitHub secrets are write-only, so this step is an operator action; the drift
#    guard tells you when it is owed.

# 4. Restart the console revision so replicas stop serving the OLD value.
#    Container Apps does NOT restart on a secret write — skipping this is what
#    made 2026-08-06 detonate hours after the change.

# 5. Confirm convergence.
gh workflow run loom-internal-token-drift.yml
```

**Never** "rotate" by passing a fresh `loomInternalTokenValue` to a deploy, and
never leave it empty on an estate that already has a console — that re-mints the
token and strands every other holder.

---

## 5. The guards

| Guard | Where | Catches |
|---|---|---|
| `check-internal-token-single-writer.mjs` | `loom-guardrails.yml` (required) | the **change** that would re-introduce a second writer: a bicep revert to a bare mint, or a deploy lane that does not resolve + pass the value |
| `loom-internal-token-drift.yml` | scheduled every 6 h, `workflow_dispatch`, `workflow_call` | **live divergence** across console / jobs / GitHub secret, by fingerprint |

Both are mutation-proved (`scripts/ci/__tests__/internal-token-single-writer.test.mjs`,
`scripts/ci/__tests__/internal-token-drift-verdict.test.mjs`): diverge a holder
or revert the bicep and the verdict flips. They are complements — the static one
cannot see a hand-run `az deployment sub create`, and the live one cannot run on
a PR.

The drift verdict separates three failure classes and fails on all three:

* `drift` — two holders disagree (the outage).
* `missing` — a declared consumer holds no token at all (the #3089 fail-closed class).
* `unknown` — a holder could not be **read**. A read that did not happen is not
  evidence that the value matches, so it never collapses into a pass.

**Fingerprints only.** Every comparison is `sha256 | cut -c1-12`. No holder's
value reaches a log, an output, or an artifact.

---

## 6. Cloud parity — honest status

| Estate | Adopt wired | Drift guard | Verified |
|---|---|---|---|
| Commercial (Container Apps) | yes — `deploy-fiab-commercial.yml` | console + jobs + GitHub secret | **live**: resolver, collector and verdict run against `rg-csa-loom-admin-centralus`; mutation cycle green → red → green |
| GCC (Container Apps) | yes — `deploy-fiab-gcc.yml` | console + jobs | **not run** — no Gov access from a workstation; Actions-only |
| GCC-High / IL5 (AKS) | step wired, `deploy-fiab-gcch.yml` / `deploy-fiab-il5.yml` | console + jobs | **not run**, and on an AKS boundary the console is not a Container App, so the resolver honestly reports greenfield and warns rather than inventing a value. Wiring the AKS-side holder is open work. |

The `LOOM_INTERNAL_TOKEN` GitHub secret addresses the **Commercial** console (see
`console-bluegreen-roll.yml`), so the Gov lane of the drift guard deliberately
does **not** compare it — doing so would manufacture a drift that does not exist.
The Gov lane says so in its own log rather than implying coverage it lacks.

---

## 7. Triage — "something 401s with `bad_internal_token`"

```bash
# 1. Fingerprint every holder. Values never printed.
ADMIN_RG=rg-csa-loom-admin-centralus \
  scripts/csa-loom/collect-internal-token-fingerprints.sh > holders.json
node scripts/ci/internal-token-drift-verdict.mjs holders.json

# 2. If a JOB is off-reference: redeploy, or stamp it from the owner.
# 3. If the GITHUB SECRET is off-reference: update the repo secret from the
#    console's live value (operator action — GitHub secrets are write-only).
# 4. If the CONSOLE is off-reference from what the replicas are serving:
#    restart the revision. A secret write alone does not restart replicas.
```

Related: #3056 (this), #3089 (conditional declaration → fail-closed consumers),
#2929 (reindex 401), #3090, `.claude/rules/deploy-integrity.md` R2/R6/R7,
`docs/fiab/runbooks/copilot-evaluator.md` (triage row "eval-probe 401").
