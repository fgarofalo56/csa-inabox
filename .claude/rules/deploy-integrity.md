# DEPLOY INTEGRITY — merged is not done, and a broken deploy is P0 (die-hard rule)

**Effective: 2026-08-05. Scope: every CSA Loom deploy path, workflow, bicep
module, wizard, and doc — Commercial AND Azure Government, greenfield AND
brownfield. All branches, all contributors (human or agent). This rule sits
ABOVE feature work: when a deploy path is broken, nothing else is more
important.**

## Why this rule exists (the incident, recorded so it is not repeated)

On 2026-08-05 the operator reported that "all the gates" were still present and
that federated lake access and Loom Unity still did not work. They were right,
and every status report they had been given was misleading. Measured:

- The live Commercial console was **8 merges behind `main`**.
- The last successful subscription-level infra deploy was **2026-07-23 — it
  FAILED**.
- `full-app-deploy-commercial.yml` — the only producer of `loom-duckdb:v0.1` —
  had **failed its last three runs** and had been broken for roughly two weeks.

So the deploy machinery itself was down. Dozens of PRs merged green during that
window and **not one of them could change anything the operator could see.**
Work was reported as "fixed" when it was only "merged". No signal anywhere said
the estate was frozen.

**The failure was not the broken deploy. It was that the breakage was
invisible, and that work continued around it for two weeks.**

## The rules

### R1 — A broken deploy path is P0. Full stop.

If any deploy, build, or roll workflow is failing, **fixing it preempts all
feature work**. Not "after this PR". Immediately. A repo that cannot deploy is
a repo whose merges do not exist.

This includes a path that is *silently* broken: exits 0 having produced
nothing, is never dispatched, or reports success while deploying the wrong
artifact.

### R2 — "Merged" is NEVER "done". Done = DEPLOYED and VERIFIED LIVE.

No issue is closed, no task is marked complete, and no status is reported as
"fixed" on the strength of a merge. The only acceptable evidence is the
behaviour observed **on the estate**, per `ux-baseline.md` G1.

When something is merged but not yet deployed, it MUST be reported in exactly
those words — "merged, not deployed" — never as "fixed". Reporting a merge as a
fix is the specific error this rule exists to prevent.

### R3 — The estate must never silently trail `main`.

Drift between the live estate and `main` is a **defect with an owner**, not a
background condition. It must be surfaced where the operator looks
(`/admin/readiness`), not only in CI, and it must name: the live SHA, how far
behind it is, when the last successful deploy of each path was, and which
merged fixes are therefore inert.

A deploy path that has **never run** is the loudest case of this, not a silent
pass.

### R4 — Greenfield AND brownfield must both work, zero-touch, in both clouds.

A from-scratch deploy into an empty subscription and a deploy into an existing
estate are **both** first-class supported paths. Each must be verified
independently — greenfield working proves nothing about brownfield, and vice
versa. Both must work in Commercial and in Azure Government.

The customer must never have to troubleshoot a deployment. If they have to read
a log to get past a step, that step is a defect.

### R5 — Brownfield: DISCOVER, OFFER, never assume.

For a brownfield deployment the platform MUST:

1. **Offer a multi-subscription analysis** of what already exists that Loom
   could use — networking (VNet/subnets/DNS/firewall), Purview, Key Vault, ACR,
   storage/ADLS, Synapse, Databricks, Event Hubs, ADX, Cosmos, AI Search, AOAI,
   Log Analytics, and every other backing service Loom binds.
2. **Present each discovered candidate** with what Loom would use it for and
   what it would change about it.
3. **Ask per service: use the existing one, or deploy new?** Never silently
   adopt, and never silently duplicate.
4. **Validate the chosen existing resource is actually usable** — SKU, region,
   network reachability, RBAC the deployment identity holds or can be granted —
   and say precisely what is wrong when it is not.
5. **Accept supplied values** for existing infrastructure as a first-class
   input path, not an undocumented override.

Silently deploying a second Purview next to the customer's existing one is a
violation. So is failing because one exists.

### R6 — Every failure self-diagnoses, retries what is retryable, and hands
back a concrete remediation.

A deployment step that fails must:
- **Classify** the failure: transient (retry), configuration (remediable),
  permission (name the exact role and scope), quota/capacity, or genuine defect.
- **Retry what is genuinely transient**, with bounded backoff, and **fail
  closed** on exhaustion. A retry that cannot fail is forbidden.
- **Emit a specific, actionable remediation** — the exact command, value, role
  assignment, or portal action — never a raw stack trace or a generic
  "deployment failed".
- **Never report success on an unverified outcome.** If it cannot confirm, it
  says so.

Per `auto-bind-by-default.md` §5, where the platform *can* perform the
remediation itself, it must — a remediation the platform could have executed is
a defect, not a helpful message.

### R7 — Error messages must be TRUE.

An error must not state as fact something it did not establish. On 2026-08-05 a
roll reported "the tag does not exist" when the truth was "I could not reach the
registry" — a `2>/dev/null` had converted a permission denial into an empty
string and the empty string into a false claim. That message sent two separate
investigations down the wrong path.

If the code does not know, the message says it does not know.

### R8 — Docs must carry BOTH paths, explicitly.

`docs/` must document greenfield and brownfield as separate, complete
walkthroughs — not one path with brownfield as an aside. Each must cover: the
decision points, how to supply existing-infrastructure values, what the
multi-sub analysis does, what is validated, and what to do when a step fails.

The wizard and the docs must agree. A wizard step with no doc, or a doc step the
wizard does not implement, is drift and is a defect.

## Explicitly forbidden

- Reporting a merge as a fix, or closing an issue on a merge alone.
- Continuing feature work while a deploy path is failing.
- A deploy/build/roll step whose result is discarded (`continue-on-error`,
  `|| true`, `2>/dev/null`) — see `csa_loom_gates_that_cannot_fail`.
- A deploy workflow that exits 0 having produced no artifact.
- A roll that reports success having deployed a different SHA than requested.
- Brownfield handled by "just deploy new alongside it".
- A failure whose only output is a stack trace or an unexplained exit code.
- An error string asserting a cause the code did not verify.

## How to spot a violation

```bash
# Deploy paths that are failing or have never run:
for wf in full-app-deploy-commercial deploy-fiab-commercial deploy-gov \
          csa-loom-post-deploy-bootstrap loom-roll-and-validate \
          build-fiab-images-acr-tasks deploy-copilot-evaluator; do
  echo "== $wf"; gh run list --workflow "$wf.yml" --limit 3 \
    --json conclusion,createdAt --jq '.[] | "\(.conclusion // "never-run")\t\(.createdAt)"'
done

# Is the estate behind main?
curl -s https://csa-loom.limitlessdata.ai/build-marker.txt
git log --oneline <live-sha>..origin/main | wc -l

# Result-discarding in deploy paths:
grep -rnE "continue-on-error|\|\| true|2>/dev/null" .github/workflows/*deploy* .github/workflows/*roll* .github/workflows/*build*
```

## Verification per merge

A PR touching any deploy path, wizard, or bicep module must state which of
greenfield / brownfield / Commercial / Gov it was verified against, and how. An
untested path is declared untested — never implied working.

Related: `no-vaporware.md` (§Bicep sync, the three-step from-scratch path),
`auto-bind-by-default.md` (§5 infra is deployed, not requested),
`ux-baseline.md` (G1 browser E2E, G2 zero day-one gates), and issues #2775
(merged ≠ deployed), #2958, #2963.
