# Deployment failure recovery

**What happens when a CSA Loom deploy, build, or roll step fails.**

This page documents the machinery, not a manual procedure. Almost none of it is
something you run — it is what the platform already does. It exists so that when
a message reaches you, you know exactly what it means and what it does *not*
mean.

Governing rule: `.claude/rules/deploy-integrity.md` R6 (classify, retry what is
retryable, hand back a concrete remediation) and R7 (never assert a cause the
code did not establish).

---

## The two rules this implements

**R6 — every failure self-diagnoses.** A failing step classifies the failure,
retries only what retrying can fix, and emits a specific remediation: the exact
command, value, role + scope, or portal action. Never a stack trace, never
"deployment failed".

**R7 — error messages must be TRUE.** On 2026-08-05 a roll reported *"the tag
does not exist"* when the truth was *"I could not reach the registry"*: a
`2>/dev/null` had turned a permission denial into an empty string and the empty
string into a false claim. That message sent two separate investigations down
the wrong path. **If the code does not know, the message says it does not
know.**

---

## The failure classes

The taxonomy lives in one file — `apps/fiab-console/lib/deploy/failure-taxonomy.json` —
read by the console (`lib/deploy/failure-taxonomy.ts`) and by CI
(`scripts/ci/deploy-classify.mjs`). Every signal in it is a string Azure was
**observed** to emit; the `observed` field records where.

| Class | Meaning | Retried? | Exit code |
|---|---|---|---|
| `transient` | Azure was momentarily unable to service the request | **yes** — 6 × 30s, jittered | 10 |
| `eventual-consistency` | a principal created moments ago has not replicated through Entra | **yes** — 8 × 15s | 11 |
| `registration` | the subscription has not registered a resource provider | after the platform registers it | 12 |
| `permission` | the deploying identity is not authorized | no | 13 |
| `quota` | the subscription or region is at a limit, or the SKU is unavailable | no | 14 |
| `config` | the target estate conflicts with what the template asked for | no | 15 |
| `defect` | the bug is in CSA Loom's own template, script, or workflow | no | 16 |
| `unknown` | nothing matched — **no cause is asserted** | no | 17 |

**`unknown` is not `defect` and is not a pass.** It exits non-zero saying the
failure could not be classified, names nothing, and asks for the run to be
attached to a new issue so the signal can be added. Silently treating unknown as
retryable is how a retry that cannot fail is born.

Ties resolve toward **fail fast**: non-retryable classes outrank retryable ones
in `classPrecedence`, because the dangerous direction of a misclassification is
calling a permanent failure transient. That is exactly what happened to a
`QuotaExceeded: standardDDSv5Family Cores … Current Limit: 200, Current Usage:
196` — it was retried three times over 90 seconds and then reported as
`"$APP ACR build failed after 3 attempts"`, a sentence with no cause in it.

---

## The retry harness

`scripts/ci/deploy-retry.mjs` is the only retry primitive. Every deploy, build,
and roll step that mutates Azure goes through it, and
`scripts/ci/check-deploy-failure-handling.mjs` (merge-blocking, in
`loom-guardrails.yml`) fails the build if a new hand-rolled retry loop appears.

```bash
node scripts/ci/deploy-retry.mjs \
  --class-allow transient,eventual-consistency \
  --max-attempts 6 --backoff 30 --jitter 0.3 --wall-clock 20m \
  --step "provision" --artifact deploy-failure.json --remediate \
  -- az deployment sub create -f main.bicep …
```

- Retries **only** the classes named in `--class-allow`, and only if the
  taxonomy marks that class retryable. A quota denial is attempted once.
- **Fails closed** on budget exhaustion, wall-clock expiry, and `unknown`. The
  exit code carries the class.
- The **happy path costs nothing**: one invocation, no sleeps, immediate exit 0,
  and no failure artifact written.
- Nothing is discarded. There is no `2>/dev/null`, no `|| true`, no
  `continue-on-error`. stderr is captured and, on final failure, echoed in full.
- Writes `deploy-failure.json`: class, signal id, **what was established**
  (the literal strings matched and the line each was on), the remediation, and
  every attempt.

---

## What the platform fixes by itself

Per `auto-bind-by-default.md` §5, a remediation the platform *could* have
performed is a defect, not a helpful message.

| Failure | What happens |
|---|---|
| `MissingSubscriptionRegistration` / `NoRegisteredProviderFound` | with `--remediate`, the harness reads the namespace out of the message, runs `az provider register --namespace <ns> --wait`, and retries once. If the namespace cannot be read it registers **nothing** and says so — guessing one would assert something it never established. |
| `PrincipalNotFound` on a just-created identity | waited out and retried; no operator action |
| `ContainerAppOperationInProgress`, `DeploymentActive`, throttling, Azure 5xx | serialized and retried |

Everything else hands back a named remediation. `quota` carries the portal path;
`permission` carries the `az role assignment create` shape with the role and
scope to fill in.

---

## Where the notice goes

Failure notices open or update **one dedicated, OPEN issue per failing
workflow**, titled `deploy: <workflow> is failing`, via
`.github/scripts/deploy-notify-failure.mjs`. The body renders the classified
failure from `deploy-failure.json`.

This replaced a comment on `issue_number: 279` — *"CSA Loom — v1 build
roadmap"*, **state CLOSED, 289 comments** — with the body "Check workflow logs".
That was the literal mechanism by which 47 days of daily deploy failure stayed
invisible. A hard-coded issue number in a deploy workflow is now a
merge-blocking guard failure (C1).

When no `deploy-failure.json` exists, the notice says **"No classification was
captured for this failure"** and asserts nothing — it does not guess.

---

## Reading a message correctly

The three states are kept apart everywhere, and the wording tells you which one
you are in:

| Wording | What it means |
|---|---|
| "the registry ANSWERED and the tag is absent" | the image genuinely is not there |
| "could NOT read … so the existence … is UNPROVEN (not disproven)" | nothing is known; the gate fails rather than skipping |
| "ARM answered ResourceNotFound" | the resource genuinely does not exist |
| "Could not establish whether … exists" | the probe failed for some other reason; the step refuses to continue |
| "Could not classify this failure … No cause is asserted" | the taxonomy has a gap; attach the run to a new issue |

A step that cannot verify an outcome **fails**. A supply-chain gate that skips an
image it could not read is not a gate, and a roll that quietly omits an app
reports success having deployed a subset.

---

## Adding a signal to the taxonomy

Only add a string you have **observed** Azure emit, and record where in
`observed`. A guessed signal is worse than no signal: an unmatched failure falls
to `unknown` and fails closed with an honest "I could not classify this", which
is a correct outcome. A wrong match is not — `scripts/ci/roll-gate-decision.mjs`
carries the cautionary tale, where a draft matched `the tag does not exist` when
`az` actually emits `the SPECIFIED tag does not exist`.

Add the case to `apps/fiab-console/lib/deploy/__fixtures__/failure-corpus.json`
in the same change. That corpus pins both classifier implementations — the
TypeScript one the console uses and the Node one CI uses — so either drifting
turns its own suite red.

---

## Related

- `.claude/rules/deploy-integrity.md` — R1–R8
- [Deployment index](index.md)
- [Deploy failure runbook](../runbooks/deploy-failure.md) — the per-error-code table
