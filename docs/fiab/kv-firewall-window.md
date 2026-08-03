# Key Vault firewall window — verified, fail-loud

Issue: [#2855](https://github.com/fgarofalo56/csa-inabox/issues/2855).
Script: `scripts/csa-loom/kv-firewall-window.sh`.
Tests: `scripts/ci/test-kv-firewall-window.sh` (fake-`az` suite),
`scripts/ci/__tests__/kv-firewall-restore.test.mjs` (guard self-test).
Guard: `scripts/ci/check-kv-firewall-restore.mjs` (Loom Guardrails lane).

## The problem this replaces

The Loom Key Vault is deployed `publicNetworkAccess=Disabled` +
`networkAcls.defaultAction=Deny` (private endpoint only). Several bootstrap
paths must write a secret into it from a public GitHub-hosted runner, so they
open a single-IP window and re-lock it afterwards.

Six call sites did that. **None verified that the re-lock applied.** They
trusted `az keyvault update`'s exit code, and most discarded even that:

| Call site | Restore | Why a failure was invisible |
|---|---|---|
| `csa-loom-post-deploy-bootstrap.yml` — MSAL app-reg | `trap … EXIT` | `-o none \|\| true`, no read-back; step runs `set -uo pipefail` (no `-e`) |
| `csa-loom-post-deploy-bootstrap.yml` — posture Function | inline, no trap | `set +e` + `2>/dev/null` + step-level `continue-on-error: true` |
| `csa-loom-post-deploy-bootstrap.yml` — always() safety net | job backstop | terminal `\|\| echo "::warning::…"`; step exits 0 regardless; ACLs never re-read |
| `dr-drill.yml` — always() re-lock | job backstop | trailing `echo "Vault … re-locked."` became the step's exit status |
| `gov-provision-posture.yml` | inline, no trap | `set +e` + `2>/dev/null`; **Gov had no always() backstop at all** |
| `scripts/csa-loom/wire-spark-telemetry.sh` | `trap … EXIT` | `\|\| true`; printed `(restored Key Vault … private)` unconditionally |

Three of them printed a success line on the path where the mutation may have
failed. So a transient ARM error during bootstrap left the vault holding
`loom-msal-client-secret`, `session-secret` and `loom-posture-function-key`
publicly reachable, the workflow green, and the log claiming it was locked.

## The design

Three invariants, in priority order.

1. **Verify, don't trust.** `close` does not believe the mutation's exit code.
   It re-reads `publicNetworkAccess`, `networkAcls.defaultAction` and the
   `ipRules` count and asserts all three. `az keyvault update` reporting success
   while ARM did not apply the change is precisely the case that was invisible.

2. **Unreadable is a failure, never a pass.** Every judgement comes from ONE
   read that must return a non-empty `publicNetworkAccess`. An `az` that fails
   yields an empty string, and an empty string can never satisfy the assertion —
   so a broken token or throttled ARM cannot be mistaken for "0 ip rules,
   locked". Reading an `az` failure as "empty means fine" is bug
   [#2836](https://github.com/fgarofalo56/csa-inabox/issues/2836); the
   correlated case matters most, because whatever broke `az` is also a plausible
   cause of the failure that left the vault open.

3. **Loud and fatal.** On final failure `close` emits `::error::` *and* exits
   non-zero, so the step and therefore the job go red. An annotation alone is
   not a control ([#2837](https://github.com/fgarofalo56/csa-inabox/issues/2837)).

Bounded retry (`LOOM_KV_WINDOW_CLOSE_ATTEMPTS`, default 3) absorbs ARM's
eventual consistency and 409/429 under a concurrent deploy. Retry turns a flake
into a slow success; it can never turn a real failure into a pass, because the
verdict is always the read-back.

## Where the enforcement lives

Every job that opens a window ends with an `if: always()` **verified restore**
step whose exit status is the helper's — no `continue-on-error`, no trailing
`exit 0` on the enforcing path. `always()` runs after a failed *or cancelled*
step, which is exactly when the vault is most likely to have been left open.

The mid-job inline closes run with `LOOM_KV_WINDOW_SOFT_FAIL=1`. That downgrades
the *annotation* to `::warning::` — the return code is 1 either way — so a
transient miss shortens the exposure window without aborting the rest of
bootstrap, and does not print a bare `::error::` from a step that cannot fail.
The authoritative verdict is the `always()` step, which re-derives the posture
from the vault itself.

## Usage

```bash
scripts/csa-loom/kv-firewall-window.sh open   --vault <name> [--subscription <sub>]
scripts/csa-loom/kv-firewall-window.sh close  --vault <name> [--subscription <sub>]
scripts/csa-loom/kv-firewall-window.sh verify --vault <name> [--subscription <sub>]
```

Exit codes: `open` 0 open / 1 could not open; `close` 0 VERIFIED private / 1
otherwise; `verify` 0 private / 1 unreadable / 2 readable-and-open.

Tunables: `LOOM_KV_WINDOW_OPEN_SECONDS` (20), `LOOM_KV_WINDOW_CLOSE_ATTEMPTS`
(3), `LOOM_KV_WINDOW_RETRY_SECONDS` (8), `LOOM_KV_WINDOW_SOFT_FAIL` (0).

## The whole-internet fallback

When the runner's egress IP cannot be resolved, `open` falls back to
`--default-action Allow`, which exposes the vault to the entire internet for the
duration of the window. That behaviour is inherited from the call sites this
replaces and is preserved so the secret write still lands — but it is now
emitted as a `::warning::` naming the exposure, and the verified `close`
re-asserts `Deny` and proves it. Previously the same fallback existed with an
unverified close, which is the worst available end state.

## Relation to the ACR firewall lease

`scripts/csa-loom/acr-firewall-lease.sh` +
`.github/workflows/acr-firewall-sweeper.yml` solve a **different** half of the
same problem for container registries: *ownership*, so a cancelled run's cleanup
cannot re-lock a live holder's registry mid-push
([#2603](https://github.com/fgarofalo56/csa-inabox/issues/2603)), plus a
scheduled sweeper for a holder that dies.

Two honest observations from reading it:

* Its `_lease_close_firewall` **also** does not verify — `az acr update … || true`
  twice, no read-back. It relies on the sweeper to catch a registry left open.
  So verification is new here, not adopted.
* What *was* worth adopting is the shape: the logic lives in a script with a
  fake-`az` regression suite rather than inline in YAML. `acr-firewall-sweeper.yml`
  records why in its own comments — "inline YAML cannot be tested and this step
  was silently broken (#2836)".

Key Vault does not have ACR's ownership problem: these writes are seconds long,
not fourteen-minute image pushes, and they are serialized inside one bootstrap
job. So the lease machinery is not reproduced.

## Residual: no scheduled sweeper

`if: always()` runs after a failed or cancelled step. It does **not** run if the
runner itself dies, the job hits its hard timeout, or the workflow is force-
cancelled at the job level. In those cases a window opened seconds earlier stays
open until the next run of a workflow that closes it.

ACR bounds that with a 15-minute cron sweeper. Key Vault does not have one yet.
Adding it means a scheduled workflow with Azure write access and its own tested
discovery script (`az` failure must not read as "no vaults" — #2836 again), and
is deliberately **not** part of the #2855 change so the verification can land
reviewable and tested. It is tracked on #2855 as the remaining gap.

In the meantime, `kv-firewall-window.sh verify --vault <name>` is a read-only
one-liner that answers "is the Loom vault private right now?" and exits non-zero
if it is not — usable from a laptop or a scheduled probe.
