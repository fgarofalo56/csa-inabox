# Loom Brain — the scheduler and the finding lifecycle

**Work item:** W10 (#3936). **Design:** `PRPs/active/loom-brain/PRP.md`.
**Code:** `apps/fiab-console/lib/brain/run/**`.
**Workflow:** `.github/workflows/loom-brain-scan.yml`.

---

## Why this exists

A Brain nobody runs finds nothing. W1–W9 built a graph substrate, six waste
detectors, a security layer, an agent layer and a version history. Without a
loop that runs them, every one of those is a capability rather than an outcome.

The cautionary instance is already in this repo: `lcu-autopilot` implements
read → decide → actuate → audit and has **no scheduler**, so it has never
produced a finding in anger.

---

## The hard problem: the estate is paused

Standing operator mandate — the Commercial and Gov estates are kept **paused**
unless actively validating. A naive `schedule:` cron therefore produces a red
run every cycle carrying "could not reach Azure", the operator learns to ignore
the lane, and the lane becomes decorative. That is exactly the silently-broken
path `deploy-integrity.md` R1 forbids.

The forbidden cure is a config flag that skips the run: a boolean that disables
a job is a gate that cannot fail.

**The cure that is used instead: three verdicts, each derived from an actual ARM
read.**

| Verdict | Exit | What it means |
|---|---|---|
| `OK` | 0 | Reached ARM; at least one in-scope resource is `Online`. Graph built, detectors run, graph version written, findings reconciled, counts reported. |
| `PAUSED` | 0 | Reached ARM, and **every** in-scope resource is definitively stopped. Neutral: nothing was scanned, so not green; nothing is broken, so not red. Every observed per-resource state is printed with the ARM api-version it came from. |
| `UNREACHABLE` | 2 | Auth failed, the network failed, ARM returned an error, **zero** in-scope resources were observed, or a power state could not be established. Red. |

Plus one signal on a separate axis:

| Signal | Exit | What it means |
|---|---|---|
| `POPULATION REGRESSION` | 3 | The estate **was** reached and scanned, and the scan examined materially less than it did last run. PRP §5: a shrinking judged count is a P0. |
| (a defect in the scan) | 1 | Not a verdict about the estate at all. |

Exit codes 1, 2 and 3 are distinct because "this program is broken", "I could
not reach the estate" and "I reached it and looked at a fifth of what I looked
at yesterday" send an engineer to three completely different places.

### The paused verdict cannot be forged from a setting

`PausedVerdict.readings` is `readonly ArmPowerReading[]`, and `ArmPowerReading`
(`lib/estate/pause-state.ts`) carries a **type-only unique-symbol brand** whose
sole constructor `armPowerReading()` requires an ARM api-version. No object
literal written outside that module satisfies the type, and `pause-inventory`'s
Resource Graph shape declares `powerState?: never`. So "the estate is paused" is
not expressible from an env var, a workflow input, or a Resource Graph row —
only from a direct ARM `GET`.

**Measured 2026-08-22, which is why Resource Graph is refused for state:** the
activity log recorded a Synapse pool `pause/action -> Succeeded @ 20:22:14`
while Resource Graph kept reporting that same pool `Online` afterwards. ARG is a
replicated index; what is indexed is not what is serving.

### `Unknown` is never laundered into `PAUSED`

`EstatePowerState` has nine members and only three of them
(`Paused` / `Stopped` / `Deallocated`) establish that a resource is stopped. The
tempting predicate is `!isRunningState(s)` — one call, reads fine, and it
quietly turns "I could not tell" into "it is paused", which renders a mid-pause
or half-broken estate as a clean neutral outcome and stops the run from ever
going red. `PAUSED` therefore requires `isPausedState` to hold for **every**
reading; anything else with nothing running fails closed as
`UNREACHABLE / state-indeterminate`.

### R7 — an error message says only what it established

`could not reach` and `nothing is there` are **different claims**.

- A reach failure (auth / network / HTTP) says **"could not reach"**.
- A run that reached Azure and got zero rows says it **reached** Azure and got
  zero rows. It does **not** say "could not reach".

Both are red. `verdict.ts` re-checks that correspondence at runtime
(`assertMessageMatchesReason`), because the realistic regression is not a typo —
it is a later edit that unifies every red message under one phrase for
consistency. That substitution is a real 2026-08-05 incident here: a
`2>/dev/null` turned a permission denial into "the tag does not exist" and sent
two investigations down the wrong path.

---

## The scan scope, and why the probe is narrower than the graph

| | Scope | Why |
|---|---|---|
| **Power probe** | The Loom admin-plane resource group(s), via `LOOM_BRAIN_RESOURCE_GROUPS` | Of the 13 managed environments visible across these subscriptions, **one** is Loom's. An unscoped probe would make "the estate is paused" depend on someone else's workload. |
| **Graph** | Every readable subscription | PRP §1 decision 4: reports cover **all** subscriptions. Narrowing the graph would hide exactly the cross-boundary edges a reachability query exists to find. |

**Measured 2026-08-24 against the live Commercial estate: zero of the 63
container apps carry the `loom-estate-id` tag.** So a probe scoped by that tag
finds nothing and the lane goes red every night — the "gate that always fails"
twin of the failure this design exists to avoid.

Do **not** cure that by widening ownership to a tag that *is* present
(`CSA_Loom`, `csa-loom`, `loom-band`, `loom-item`): none is estate-scoped, so
none can tell two Loom estates apart, and a wrong ownership inference on this
estate reaches non-Loom Container App environments. A resource group the
platform deploys into is **evidence**; a tag that is not there is not.

The CLI **refuses to run unscoped** — `LOOM_BRAIN_RESOURCE_GROUPS` is required
and has no default.

---

## The finding lifecycle

```
        (first sighting)
              │
              ▼
            new ──────────► acknowledged ◄────────── accepted
              │                   │        expiry        │
              │                   │                      │
              └────────┬──────────┴──────────────────────┘
                       │  (detector ran, did not report it)
                       ▼
                     fixed
                       │
                       │  (it comes back)
                       ▼
                  REGRESSED
```

### A regression can never be reported as `new`

That is the single most valuable signal this lane produces: something that was
understood and repaired has broken again. It is made structurally impossible
three ways:

1. **L1 (type)** — `NewFinding` pins `regressionCount: 0` as a literal and
   declares `fixedAt?: never` / `priorState?: never`, so a record carrying a
   repair history is not assignable to `new`.
2. **L2 (type)** — `RegressedFinding` pins `priorState: 'fixed'` as a literal,
   so a regression cannot be minted from any other state.
3. **L3 (runtime)** — `reconcile()` is the only constructor of a next state, it
   has no `new` branch reachable when a prior record with a history exists, and
   `assertNoRegressionReportedAsNew()` re-checks that before returning.

`new → new` is the one legal carry-forward: a finding first seen last run and
still present stays `new`, and its `firstSeenRunId` keeps it out of
`digest.newFindings`.

### `accepted` requires a reason AND an owner, and it expires

`Suppression` has four required fields — `reason`, `owner`, `acceptedAt`,
`expiresAt`. None is optional and none is nullable, enforced at the type level
and again at runtime by `acceptFinding()`, which additionally rejects an empty
reason, an empty owner, a non-future expiry, and an expiry beyond
**180 days** (`MAX_SUPPRESSION_DAYS`).

A reason-free suppression is how a real finding gets buried. An `accepted` with
no expiry is indistinguishable from a deleted detector.

**On expiry the finding re-surfaces.** It returns to `acknowledged` — a human
had seen it; that is what accepting it meant — and the digest lists it under
`suppressionsExpired`. It is **not** a regression: it was never fixed, and
collapsing the two would make "regression" mean "anything that came back",
which is exactly the dilution that makes the signal worthless.

### Absence is not a fix

The subtlest way this lane could lie: mark every open finding `fixed` because
its detector did not report it, when the real reason is that the detector ranged
over an **empty population** and was green and blind (PRP §3.2, §3.8).

So `reconcile()` takes the set of detectors that ran with a **non-blind**
population, and a record whose detector is not in that set is left untouched and
reported under `notEvaluated`. Under the naive version, the first run after a
detector breaks marks its entire backlog fixed, and the run after the detector
is repaired reports every one of them as `new` — the regression signal is not
merely lost, it is inverted into a wave of false new findings.

The same rule applies to a record stored on an older `schemaVersion`, and to the
whole estate on the `PAUSED` path.

---

## The report is a digest, not a backlog dump

Listed: **regressions first (always, even at zero)**, then new, then fixed, then
expired suppressions. Counted, not listed: still-open and suppressed. A nightly
report that re-prints the whole backlog is a report the operator stops reading,
and then the one line that mattered is missed.

The verdict is the headline in three places a green check cannot hide: the first
line of the log, the step-summary title, and the `verdict` job output.

---

## Population regression — PRP §5's P0

**Measured live, 2026-08-24, Commercial estate.** Emptying the wire-binding
table the graph extractor is fed took the run from

```
105 nodes · 18 edges ·  8 findings · 1 blind detector
105 nodes ·  0 edges ·  0 findings · 2 blind detectors
```

and the run still reported a cheerful `ok` with "0 findings". Every count moved.
The **verdict** did not. An operator reading that summary sees a clean estate.

So each run persists its per-detector examined counts, and the next run
compares. A detector that **went blind**, **disappeared**, **shrank** past a 20%
tolerance, or sits more than 20% **below its own high-water mark** makes the run
exit 3.

Finding *counts* are never compared — fewer findings is the outcome the whole
system exists to produce, and treating it as an incident would make the lane
punish success. What is compared is what the detectors **looked at**.

### The basis is the last run that SCANNED, not the last run

PAUSED and UNREACHABLE runs persist `detectorPopulations: null`. Taking the basis
from "the last run" therefore meant **one paused night erased the baseline** —
measured, `OK → PAUSED → went-blind OK` gave `populationRegression: null,
exit 0`, where the same sequence without the paused night gave exit 3.

Under the standing estate-pause mandate PAUSED is the **normal** operating mode,
so the comparator this lane exists to provide would have been switched off almost
always. `FindingStore.lastScannedRun` is the basis, and the digest reports how
many runs back it is so a comparison spanning eleven nights says so.

With no previous *scanned* run there is **no basis**, which is reported as "no
basis" rather than as "no regression" — different facts, and only one is
reassuring.

### The high-water mark is the anti-ratchet

Comparing only against the previous run makes the comparator a **ratchet**: it
asks "worse than yesterday?", and a slow erosion answers "no" every night.
Measured at 19% per run:

```
1000 → 810 → 656 → 531 → 430 → 348 → 281 → 227 → 183 → 148 → 119 → 96 → 77
```

Twelve runs, 92.3% of the population gone, **zero** regressions reported. And a
single large drop was red for exactly one run and green on an immediate re-run
with nothing about the estate changed — the P0 was clearable by pressing "Re-run
jobs".

Each detector therefore carries `maxExamined`, and a run more than 20% below it
is red even when no single step crossed the tolerance. The 20% figure was never
the problem; the missing mark was.

The mark **decays after 30 days** so a deliberate, permanent downsizing does not
pin the lane red forever — a gate that can never go green is its own failure
mode.

### Composition at constant size

`DetectorPopulationSnapshot` is a count with no identity, so swapping every
subject while holding `examined` constant is invisible to the comparator. That
matters here specifically because the graph pull is deliberately unscoped: ARG
returns every container app the run identity can read (63 measured, 29 of them
Loom's), so non-Loom growth can mask Loom's disappearance one for one.

Each scanning run therefore records `graphSubjectsDigest` — a sorted digest of
the graph's node-id set — and a change is reported in the run notes. Sorted
before hashing, because ARG does not promise a stable row order and hashing
as-emitted would report composition change on every run.

**Honest limit:** this digests the **graph's** node set, not each detector's
examined subset. A detector's subject list is not on `DetectorResult` —
`Population` exposes a count only — so per-detector composition needs a change in
`lib/brain/detectors`, which this lane does not own.

---

## Storage

One Cosmos container, **`brain-findings`**, partition key `/estateId`, declared
in **both**:

- `platform/fiab/bicep/modules/landing-zone/cosmos.bicep`
- `platform/fiab/bicep/modules/admin-plane/loom-console-cosmos.bicep`

Two document kinds share it, discriminated by `docType`:

| `docType` | TTL | Why |
|---|---|---|
| `finding` | **none** | A `fixed` finding is the only thing that makes its next occurrence a regression. Expiring one silently downgrades the loudest signal this lane produces to the quietest. |
| `scan-run` | 90 days | Operational telemetry. Losing an old one costs nothing. |

The container carries `defaultTtl: -1` — TTL **on**, no blanket expiry, each
document opting in. This is deliberately the opposite of the choice
`brain-graph-versions` (W9) makes, and the reason is in the table above.

The document id is a **reversible base64url encoding** of the fingerprint, not a
hash: a hash introduces a collision class in which two different findings share
a document and one silently leaves the backlog.

---

## Running it

### Scheduled

`11 4 * * *` — daily at 04:11 UTC. Deliberately not minute 0 or 30: the whole
GitHub fleet lands there and a scheduled run can be delayed by many minutes,
which for a lane whose verdict depends on whether an estate is running at that
instant is a real source of noise.

### On demand

```
gh workflow run loom-brain-scan.yml -f cloud=commercial
gh workflow run loom-brain-scan.yml -f cloud=gov
gh workflow run loom-brain-scan.yml -f cloud=both
```

### Locally, against a fixture

```
cd apps/fiab-console
npx vitest run lib/brain/run
```

### The mutation sweep

```
cd apps/fiab-console
node lib/brain/run/__tests__/mutation/run-arms.mjs
node lib/brain/run/__tests__/mutation/run-arms.mjs regression-reported-as-new
```

Twenty-five arms, each removing one property the lane claims. The runner refuses
to start against a red baseline or a baseline that executed fewer than 215 tests
(a green sweep over an unexecuted suite scores every arm as CAUGHT for the wrong
reason — that is #3783). A `NEEDLE-MISSED` outcome is reported separately from
both CAUGHT and SURVIVED, because a needle that does not match is a silent no-op
that reads exactly like a catch — measured in this repo where CRLF line endings
made an entire sweep report a perfect score having changed nothing. Needles are
matched against an LF-normalised copy and the original endings restored, so the
runner is immune to the checkout it is run from.

**There are currently no declared survivors.** There was one:
`narrow-regression-bypass-uncovered` scoped the regression-defeating edit to a
detector no test exercised, and it survived because the runtime guard only
inspected records whose state was `new`. The reviewer of #4014 found the sibling
that broke the compensation argument — route the recurrence to `acknowledged`
instead and nothing fires at all. Both are now caught, because the guard asserts
the **transition** (any fingerprint with a prior `fixed` record that recurs must
appear in `digest.regressions`) rather than the destination state.

`expect: 'survives'` remains available for the next honest blind spot. The
operating rule is unchanged: when an arm survives, write it down and say why,
rather than dropping it from the set.

---

## How the CLI is built and run

The scan runs **outside** the console image: a plain Node process compiled by
`lib/brain/run/tsconfig.cli.json`. That is not an implementation detail — the
console Container App is itself one of the things that may be stopped when the
estate is paused, and a scheduler that could only run inside the thing it
monitors cannot report that the thing is down.

`tsconfig.cli.json` deliberately declares **no `paths` mapping**. `tsc` resolves
the console's `@/*` alias for typechecking but does **not** rewrite the
specifier on emit, so an alias import anywhere in the CLI's dependency tree
typechecks, passes `next build`, passes vitest — and then fails at 04:11 UTC
with `Cannot find module '@/lib/x'`, which reads like a broken install rather
than like the source edit that caused it. Omitting `paths` makes that a compile
error. `__tests__/cli-buildable.test.ts` walks the transitive import graph and
asserts the closure stays alias-free.

A concrete consequence, measured while building this lane:
`lib/azure/fetch-with-timeout.ts` imports `@/lib/resilience/fault-injection`, so
the CLI reaches `lib/azure/cloud-endpoints` (alias-free) and **not**
`lib/azure/aca-managed-identity` (which pulls in `fetch-with-timeout`).

The emitted tree lands in `apps/fiab-console/temp/brain-scan-build`, not at the
repo root: the console is a standalone pnpm package, so `@azure/cosmos` and
`@azure/identity` resolve by walking up to `apps/fiab-console/node_modules`.
Emitting to `<repo>/temp` produced `Cannot find module '@azure/cosmos'` on the
first smoke run.

---

## Environment

The CLI decides it was invoked directly from `process.argv[1]`, not from an
environment variable. Nothing about a run's **outcome** is reachable from
environment at all — that is the whole design of `verdict.ts` — and a
`LOOM_*`-prefixed entrypoint marker would additionally fail
`scripts/ci/check-env-sync.mjs`, correctly, because this process is launched by
a workflow and its environment does not come from a container app.

| Variable | Required | Meaning |
|---|---|---|
| `LOOM_ESTATE_ID` | no | Cosmos partition key. When unset it is DERIVED from `LOOM_SUBSCRIPTION_ID` + `LOOM_ADMIN_RG` as `loom:<sub8>:<rg>` — the same algorithm `lib/estate/pause-orchestrator.ts#resolveEstateId` uses, so the console and this lane agree by construction. No bicep module emits it, so a literal in the workflow would disagree with whatever the console resolves and write findings into a partition nothing reads. |
| `LOOM_SUBSCRIPTION_ID` · `LOOM_ADMIN_RG` | yes (unless the above is set) | The deploy facts the estate id is derived from. |
| `LOOM_UAMI_CLIENT_ID` | on the ACA runner | The console UAMI. Selects the identity that already holds Cosmos Data Contributor. Absent = the managed-identity leg is not added at all, so there is no failed IMDS probe before the fallback. |
| `LOOM_BRAIN_RUN_ID` | yes | Stamped on every transition and on the run record. |
| `LOOM_BRAIN_RESOURCE_GROUPS` | yes | Comma-separated. The power-probe scope. No default — see "The scan scope" above. |
| `LOOM_BRAIN_SUBSCRIPTIONS` | no | Comma-separated. Omitted = every readable subscription. |
| `LOOM_CLOUD` | no | `Commercial` / `GCC` / `GCC-High` / `IL5` / `DoD`. Selects the ARM host and token audience. Defaults to Commercial. |
| `LOOM_COSMOS_ENDPOINT` | yes | Read off the console app by the workflow. Deployed, not requested. |
| `AZURE_AUTHORITY_HOST` | Gov only | `https://login.microsoftonline.us`. Without it the run authenticates to Commercial and every Gov ARM call returns 401 — which the probe would correctly classify as `auth`, and which would be a completely misleading answer. |

---

## Cloud parity

`cloud-parity.md` is a die-hard rule, so the workflow carries two jobs with
identical steps, one per boundary. The ARM host and token audience come from
`lib/azure/cloud-endpoints` keyed on `LOOM_CLOUD`; no literal host appears in
the workflow or in the scan.

**That is an argument from construction, not a receipt.** Gov cannot be driven
from a workstation — there is no local Gov `az` context — so the Gov receipt can
only ever come from a run of this workflow.

### What has actually been executed

| | Executed | Evidence |
|---|---|---|
| Unit + property suite | yes | `vitest run lib/brain/run` — 240 tests |
| Mutation sweep (25 arms) | yes | `run-arms.mjs`, all as declared |
| Compiled CLI runs end to end | yes | plain Node, Commercial ARM |
| ARG discovery + per-resource ARM `GET` | yes, **Commercial only** | 63 discovered, 63 read |
| Full scan: graph + detectors + counts | yes, **Commercial only**, in-memory ports | 105 nodes, 18 edges, 8 findings |
| `UNREACHABLE` (network / auth / null token) | yes, **Commercial only** | three live arms |
| **Cosmos reachable from a hosted runner** | **NO — measured 403** | see below |
| `PAUSED` against a genuinely paused estate | **no** — proven by fixture only | the Commercial estate read 63/63 `Online` |
| Any Cosmos write | **no** | nothing has been persisted in either boundary |
| The workflow itself, on either runner | **no** | it has never run |
| Azure Government, anything | **no** | requires a run of this workflow |

### Why the jobs run on `[self-hosted, loom-aca]`

**Measured 2026-08-24 from outside the VNet** — a workstation sits in the same
network position as a GitHub-hosted runner:

```
GET https://<loom cosmos account>/   ->  HTTP 403
{"code":"Forbidden","message":"Request originated from IP <redacted> through
 public internet. This is blocked by your Cosmos DB account firewall settings."}
```

Both cosmos modules set `publicNetworkAccess: 'Disabled'` with
`networkAclBypass: 'AzureServices'` and a private endpoint. `recordRun` fires on
**every** path — including PAUSED and UNREACHABLE — so on `ubuntu-latest` every
single run would die before persisting anything, in **both** clouds.

`[self-hosted, loom-aca]` is the scale-to-zero ACA Job runner
(`gh-runner-job.bicep`), which is inside the hub VNet **and runs as the console
UAMI** (`identity: consoleUamiId`). That identity already holds the Cosmos
built-in Data Contributor role via `cosmosDataRole` in both modules, so this lane
needs **no new `sqlRoleAssignment`** and puts no object id in a public
repository. The workflow reads `LOOM_UAMI_CLIENT_ID` off the console app so the
credential chain selects it explicitly.

**The Gov runner label `loom-aca-gov` is UNVERIFIED.** No such runner has been
observed registered. If none exists the Gov job will sit queued rather than fail
— which is its own silent state, and it is named here rather than left to be
discovered.

---

## Related

- `PRPs/active/loom-brain/PRP.md` — the design, §3.2 population contract, §3.8
  where the reachability thesis fails, §5 definition of done.
- `docs/fiab/brain/graph-history.md` — W9, the graph version this scan writes.
- `.claude/rules/deploy-integrity.md` — R1 (a broken lane is P0), R6 (classify,
  retry, remediate), R7 (an error must be true).
- `.claude/rules/cloud-parity.md` — why the Gov job exists and why its absence
  from the receipt table is stated rather than implied.
