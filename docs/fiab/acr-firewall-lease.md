# ACR firewall lease — ownership + fail-closed re-lock

**Issue:** [#2603](https://github.com/fgarofalo56/csa-inabox/issues/2603)
**Primitive:** `scripts/csa-loom/acr-firewall-lease.sh`
**Safety net:** `.github/workflows/acr-firewall-sweeper.yml`
**Sweeper discovery:** `scripts/csa-loom/acr-firewall-sweep-all.sh` ([#2836](https://github.com/fgarofalo56/csa-inabox/issues/2836))
**Regression tests:** `scripts/ci/test-acr-firewall-lease.sh` and
`scripts/ci/test-acr-firewall-sweep-all.sh` (both in the Loom Guardrails lane)

> **#2836 — why discovery is a script, not inline YAML.** The sweeper used to
> resolve the admin RG and the registry list inline in the workflow, under
> `set -uo pipefail` (no `-e`), and infer "there is nothing to sweep" from an
> empty command substitution. A failing `az` — expired token, ARM throttling, a
> transient 5xx — produced the same empty string as a genuinely empty
> subscription, so the job printed `::notice::… nothing to sweep.` and exited
> **0**. The safety net reported success while protecting nothing, in exactly
> the correlated case (broken credentials) where a build is most likely to have
> died mid-lease. Discovery now lives in `acr-firewall-sweep-all.sh`, which
> captures every `az` exit status explicitly and only treats `rc=0` **with**
> empty output as an empty estate. An admin RG holding zero `acrloom*`
> registries is also an error, not an empty estate — `admin-plane/registry.bicep`
> puts the registry in that RG.


## The problem

Every Loom ACR rests at `publicNetworkAccess=Disabled` +
`networkRuleSet.defaultAction=Deny` (private endpoint only). Anything that
pushes an image from outside the VNet has to open the firewall, work, and close
it again:

- `build-fiab-images-acr-tasks` (the `az acr build` matrix)
- `full-app-deploy-commercial`, `console-bluegreen-roll`, `gov-console-roll`
- `loom-roll-and-validate` (cosign verify-before-roll reads the data plane)
- `gov-provision-{dbt,maps,wrangler,dbx-sql-invnet}`, `gov-uc-purview-wire`
- `scripts/csa-loom/deploy-{copilot-evaluator,lineage-extractor,loom-uat,secret-expiry}-job.sh`
  and `provision-gh-runner.sh`, which a human runs from a laptop

That open/restore pair was a **shared mutex with no ownership check**. Any
process's restore re-locked the registry, including one that had no business
doing so. Observed 2026-07-28: run `61a46c22` of `build-fiab-images-acr-tasks`
was **cancelled**; its `acr_restore` job still executes under `if: always()`, and
GitHub had already released the concurrency slot to the next run, which was
mid-`az acr build` for `a293b805`. The cancelled run's restore closed the
registry underneath it:

```
denied: client with IP '20.29.127.164' is not allowed access
failed to run step ID: push: failed to push images successfully
```

~14 minutes of build thrown away, and it reads like a networking or permissions
problem rather than a self-inflicted race.

The workflow's `concurrency: build-fiab-images-acr-tasks` /
`cancel-in-progress: false` guard only serializes two *running* instances of
*one* workflow. It covers neither a cancelled run's cleanup nor the other ~19
call sites, several of which target the Gov estate or run outside CI entirely.

## The design

A lease recorded as **ARM tags on the ACR resource**:

| tag | meaning |
| --- | --- |
| `loomAcrFwOwner` | opaque holder id (`gha:<repo>:<run_id>:<attempt>` or `cli:<user>@<host>:<pid>`), or `none` |
| `loomAcrFwExpiresEpoch` | unix seconds; the lease is stale at/after this |
| `loomAcrFwSinceUtc` | ISO-8601 claim time (forensics) |
| `loomAcrFwHolderUrl` | GHA run URL (or `local:<host>`) — used to probe holder liveness |

ARM tags rather than a blob lease or an ACR tag marker for one reason: the
control plane is reachable even when the registry's **data** plane is firewalled
off. A marker stored inside the registry is unreadable in exactly the state we
need to read it. `az tag update --operation Merge` patches the tags
sub-resource, so it never rewrites the registry body.

### Invariants

1. **Fail closed.** The registry is never left publicly reachable. Skipping the
   restore on cancellation is *not* a fix on its own — if the surviving holder
   also dies, the door stays open, which is strictly worse than the bug. So
   `release` re-locks whenever there is **no live holder** (not only when this
   process is the holder), and the scheduled sweeper re-locks any registry found
   open with a dead, absent, or expired lease.
2. **Only the holder closes.** The close decision is made from a **fresh read**
   of the owner tag at release time, never from a cached "I won the race" flag.
   There is exactly one owner tag value, so at most one process can conclude "I
   am the holder" at any instant.
3. **Bounded.** `acquire` waits at most `LOOM_ACR_LEASE_WAIT_MINUTES`
   (default 25) then fails loudly, naming the holder and its run URL. No
   unbounded wait-for-lock loop.

### Claim protocol

ARM tags have no compare-and-swap, so `acquire` does
**write → settle → read back → settle → read back**. Two simultaneous claimants
both write; last write wins; each re-reads, so at most one sees itself. Backoff
is jittered (15–30 s) so claimants de-synchronize.

## The re-lock is VERIFIED (C24, 2026-08-07)

`release` and `sweep` do not merely *issue* the re-lock — they read the registry
back and **exit non-zero when they cannot confirm** `publicNetworkAccess=Disabled`
+ `networkRuleSet.defaultAction=Deny`.

That was not always true, and the gap was measured. After run `31143181962` the
`full-app-deploy-commercial` job **"Re-lock ACR (private endpoint only)"
concluded SUCCESS** while `az acr show` read `publicNetworkAccess=Enabled` /
`defaultAction=Allow` on **three probes across a minute** — well past the
documented 30–90 s propagation window. The Commercial ACR was publicly reachable
for an unknown period with CI green, and a human re-locked it by hand. The cause
was `_lease_close_firewall` ending both `az acr update` calls in `|| true` with
no read-back: the function returned 0 whether or not either write landed.

(The reason the registry diverged in the first place — `full-app-deploy`'s
concurrency group keyed on `inputs.region || 'auto'`, so two runs landed in
different groups and raced for the same lease — was fixed separately. It is not
what made the incident *invisible*. A step that writes and never reads back
reports success on a no-op forever, whatever the cause.)

What the close does now, mirroring `kv-firewall-window.sh kvw_close`:

1. write `--default-action Deny`, then `--public-network-enabled false`
   (write errors are **captured**, not discarded — they become the remediation
   hint if the verify also fails, but they are not themselves the verdict:
   another process may have locked it already, in which case a failed write plus
   a clean read is a **pass**);
2. read the registry back;
3. on "still open" or "unreadable", retry up to `LOOM_ACR_CLOSE_ATTEMPTS` times
   with `LOOM_ACR_CLOSE_RETRY_SECONDS` between — 6 × 20 s by default, past the
   30–90 s propagation window;
4. on exhaustion, **fail closed** with the observed state and the exact
   hand-remediation command.

"Unreadable" and "open" are distinct outcomes and neither is ever reported as
"locked" — per `deploy-integrity.md` R7, a message must not assert something the
code did not establish.

**Do not append `|| true` to `release` or `sweep`.** That is the whole defect:
the script can only fail loudly if its caller lets it. Fourteen call sites across
nine workflows did exactly that and were fixed alongside this;
`scripts/ci/__tests__/acr-firewall-lease-close.test.mjs` fails the build if one
comes back.

A read-only `verify` subcommand is available for a workflow that wants to assert
posture without touching the lease:

```bash
scripts/csa-loom/acr-firewall-lease.sh verify --acr acrloomk6mvh5sm6z7do
# exit 0 = locked, 1 = state unreadable, 2 = publicly reachable
```

## Failure modes

| Scenario | What happens |
| --- | --- |
| **Holder finishes normally** | `release` sees `owner == me`, re-locks, **verifies the locked state**, then clears the lease tags. |
| **Re-lock does not take** (write rejected, ARM lag beyond the budget, another process re-opening) | `release` retries within its bounded budget, then **exits non-zero** naming the observed `publicNetworkAccess` / `defaultAction` and the exact `az acr update` to run by hand. The lease tags are deliberately **left in place** so the registry is not advertised as unowned while it is still open — the sweeper then sees an open registry with a holder it can probe. |
| **Holder is CANCELLED** (the #2603 case) | Its cleanup still runs. If it is still the recorded holder, it re-locks correctly. If the next run already took the lease, `release` sees a **live foreign holder**, logs a `::warning::` naming that holder, and **does not touch the firewall** — the in-flight push survives. |
| **Holder CRASHES** (runner killed, cleanup job never runs) | The registry stays open with a live lease. The sweeper probes the holder's GitHub run status; once it is no longer `in_progress/queued/waiting/requested/pending`, the sweeper re-locks **immediately** without waiting out the TTL. If the run status is unreadable, the lease expires after `LOOM_ACR_LEASE_TTL_MINUTES` (default 75; 120–180 for the long build/deploy paths) and the next sweep re-locks. Worst-case public exposure: one sweeper interval (15 min) when the run status is readable, TTL + 15 min otherwise. |
| **Two runs race for the claim** | Both write the owner tag; last write wins; both read back twice and only the tag's actual owner proceeds. The loser backs off with jitter and retries until its bounded deadline. In the pathological case where tag propagation exceeds both settles and both believe they won, invariant 2 still holds — both merely *open* (idempotent, and both are pushing), and only the process the tag names will ever *close*. |
| **Claim goes STALE** (holder gone, lease expired) | The next `acquire` takes it over with a `::warning::` naming the dead holder and how long ago it expired. If legitimate work routinely exceeds the TTL, raise `LOOM_ACR_LEASE_TTL_MINUTES` rather than letting takeovers happen. |
| **Non-holder releases with NO live holder** | Re-locks anyway (and verifies it). Nobody is protected by leaving it open. |
| **Registry opened by something unwired** (manual `az acr update`, a call site added later) | The sweeper finds it open with no lease and re-locks within 15 minutes, emitting a `::error::` that names the registry and points here. To hold it open deliberately, take a lease: `acr-firewall-lease.sh acquire --acr <acr> --owner manual:<you>`. |
| **Identity cannot write tags** | `acquire` emits a `::error::` naming the missing `Microsoft.Resources/tags/write` permission (grant **Tag Contributor** on the registry) and then, under the default `LOOM_ACR_LEASE_FALLBACK=legacy`, proceeds **unleased** — pre-#2603 behavior, still fail-closed but not race-free. An unleased process still *reads* the lease, so it refuses to open behind, or close under, a live foreign holder. Set `LOOM_ACR_LEASE_FALLBACK=fail` to make this fatal instead. |
| **Sweeper itself is parked** (`LOOM_ACR_SWEEPER_DISABLED=true`) | It logs a `::warning::` on every scheduled run saying a registry left open by a crashed build will not be re-locked until the variable is cleared. |

## Usage

```bash
# CI / script — open under a lease, release on any exit
bash scripts/csa-loom/acr-firewall-lease.sh acquire --acr "$ACR_NAME" --subscription "$SUB"
trap 'bash scripts/csa-loom/acr-firewall-lease.sh release --acr "$ACR_NAME" --subscription "$SUB"' EXIT

# Who holds it right now?
scripts/csa-loom/acr-firewall-lease.sh status --acr acrloomk6mvh5sm6z7do

# Janitor — re-lock if nobody live holds it
scripts/csa-loom/acr-firewall-lease.sh sweep --acr acrloomk6mvh5sm6z7do
# ... and when you KNOW the recorded holder is dead:
scripts/csa-loom/acr-firewall-lease.sh sweep --acr acrloomk6mvh5sm6z7do --force
```

Tunables (env):

| var | default | purpose |
| --- | --- | --- |
| `LOOM_ACR_LEASE_TTL_MINUTES` | `75` | lease lifetime. `120` for the image build / bluegreen / gov console rolls, `180` for `full-app-deploy-commercial`, `20` for the roll's signature-verify read. |
| `LOOM_ACR_LEASE_WAIT_MINUTES` | `25` | bounded acquire wait before failing loudly. `5` for the roll's verify step so a roll never sits behind a 2-hour build lease. |
| `LOOM_ACR_LEASE_SETTLE_SECONDS` | `6` | tag read-back settle between claim confirmations. |
| `LOOM_ACR_LEASE_OPEN_SECONDS` | `35` | firewall-rule propagation wait after opening. |
| `LOOM_ACR_CLOSE_ATTEMPTS` | `6` | verified-close attempts before failing closed (C24). |
| `LOOM_ACR_CLOSE_RETRY_SECONDS` | `20` | wait between close attempts. 6 × 20 = 120 s, past the documented 30–90 s ACR propagation window. |
| `LOOM_ACR_LEASE_FALLBACK` | `legacy` | `legacy` \| `fail` — behavior when tags are unwritable. |
| `LOOM_ACR_LEASE_OWNER` | derived | override the holder id. |

## Adding a new call site

Anything that needs the ACR data plane from outside the VNet **must** go through
the lease. Check for regressions with:

```bash
grep -rn "public-network-enabled\|--default-action" .github/workflows scripts/csa-loom
```

Every hit should be inside `acr-firewall-lease.sh`. Anything else is a call site
that will fight the lease holders and get swept.

## Audited, deliberately out of scope

Two adjacent shared toggles have the same open/restore shape and were reviewed
while wiring the lease. Neither is the #2603 failure, and neither is covered by
the lease today:

- **`--admin-enabled` on the ACR** (`full-app-deploy-commercial`). Also a shared
  registry-wide toggle, but ACR Tasks builds authenticate with the task
  identity, not admin creds, so a concurrent flip does not deny a push. It stays
  a plain per-run toggle. Note it is now enabled/disabled independently of the
  network lease, so a `release` that declines to re-lock the network still turns
  the admin user back off.
- **Key Vault `--public-network-access` / `--default-action`**
  (`csa-loom-post-deploy-bootstrap`, `dr-drill`, `gov-provision-posture`,
  `scripts/csa-loom/wire-spark-telemetry.sh`). Structurally identical — an
  unowned open/restore pair on a shared resource — and therefore carries the
  same latent race. Fixing it means generalizing this primitive to arbitrary ARM
  resources; tracked separately rather than widening this change.

## Required permission

The deploy identity needs `Microsoft.Resources/tags/write` on the registry —
included in **Contributor**, or grant **Tag Contributor** scoped to the ACR:

```bash
az role assignment create --role "Tag Contributor" \
  --assignee <deploy-sp-object-id> \
  --scope "$(az acr show -n <acr> --query id -o tsv)"
```

Without it the lease degrades to the pre-#2603 unconditional re-lock and logs a
`::error::` on every acquire.
