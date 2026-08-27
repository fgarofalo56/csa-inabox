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
| `SCAN STALE` | 4 | The lane has not **actually scanned** inside the declared ceiling (`SCAN_STALENESS_CEILING_DAYS`, 45 days). See "The staleness axis" below. |
| (a defect in the scan) | 1 | Not a verdict about the estate at all. |

Exit codes 1, 2, 3 and 4 are distinct because "this program is broken", "I could
not reach the estate", "I reached it and looked at a fifth of what I looked at
yesterday" and "I have not looked at anything at all for seven weeks" send an
engineer to four completely different places.

### The staleness axis — why PAUSED exiting 0 was not enough

PAUSED maps to 0 deliberately: Actions has only pass/fail, and a paused estate
failing nightly is how an operator learns to ignore a lane. But under the
standing estate-pause mandate **PAUSED is the normal mode**, so with no staleness
axis this lane would have been green every night having built no graph, run no
detector and reconciled nothing — and nothing in the workflow, the report or the
run record would ever have escalated it. A lane legitimately paused for sixty
nights was indistinguishable, at the check level, from a working one.

So the two non-scanning paths now read the last run that actually scanned and
report:

| Surface | What it carries |
|---|---|
| Log | A `SCAN STALENESS` block **above** the observed states — banner-boxed when past the ceiling. |
| Step summary | The verdict headline itself says `PAUSED, AND STALE`, plus a table of last-scan date, age in days, age in runs, and the ceiling. |
| Job outputs | `scan_stale`, `last_scanned_age_days`, `last_scanned_age_runs`, `last_scanned_at`. |
| Exit code | `4` once `ageDays` is past the ceiling. |

This is a **threshold over a measured quantity**, not a boolean that skips a run:
nothing about it can be set to make the lane green, and it is derived from
persisted run records rather than from configuration. It can sit red for as long
as an estate stays paused past the ceiling, and that is the intended reading —
`deploy-integrity.md` R3, *"a deploy path that has never run is the loudest case
of this, not a silent pass."*

The loudest case is distinguished from the quiet one: "this is the first run for
this estate" is **not** stale, while "this lane has run before and has never once
carried detector populations" is red as soon as the earliest visible run is past
the ceiling.

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

### …and the decay re-opened it, on a longer clock (#4014 review, second pass)

Re-basing the mark to **today's value** once the window elapsed turned every hold
into a laundering step. Measured end to end through the real
`snapshotPopulations` + `detectPopulationRegression` — drop 19% (inside the 20%
step tolerance, so silent), hold 31 days, repeat:

```
d31=810 d62=656 d93=531 d124=430 d155=348 d186=282
d217=228 d248=185 d279=150 d310=122 d341=99  d372=80
regressions fired: 0 over 372 days
```

92% of the population gone, in silence, again. The **mechanism** was never the
problem: the identical 19% erosion at *daily* cadence fires 11 times out of 12,
before and after the fix. Only the re-basing rule was wrong.

The old test for this sequence could not have caught it — it advanced the mark by
hand and never called `snapshotPopulations`, so the decay was outside its
population entirely. A fixture modelling the code.

**Why `max(examined, prevMark * 0.8)` is not the repair.** It was the obvious
suggestion and it is a **no-op against the very sequence it was meant to fix**:
`0.8` is exactly `1 - POPULATION_SHRINK_TOLERANCE`, and the erosion is calibrated
just inside that, so `0.81 × mark` is above `0.80 × mark` at every one of the
twelve cycles and `max` returns `examined` every time. The repair has to be a
rate *smaller* than the step tolerance or it cannot bind. (An executable
demonstration of this is kept in `population.test.ts`, so the argument does not
have to be re-derived.)

**What ships instead.** `HIGH_WATER_DECAY_FLOOR = 0.9`: a mark may re-base
downward by at most 10% per 30-day window when the drop that caused it was never
reported — plus an exemption when it *was*. And the decay rate is stated for what
it is:

> **The decay rate IS the maximum silently-permitted contraction rate.** That is
> not a tuning knob, it is the definition: an erosion that tracks the mark's decay
> exactly is, by construction, indistinguishable from an estate that is honestly
> getting smaller.

So the contract is explicit — an examined set may contract up to 10% per 30-day
window without comment; faster than that, with no step ever crossing the
tolerance, is reported:

| contraction | verdict |
|---|---|
| 19% / 31d | fires at cycle 2 |
| 12% / 31d | fires at cycle 6 |
| 10% / 31d | never fires (exactly the permitted rate) |
| 5% / 31d | never fires |
| flat | never fires |

**The exemption, and why it exists.** A drop bigger than the 20% tolerance
already fired `shrank` the night it happened — the operator *saw* it. Bounding
its re-base would keep the lane red for months over a downsizing that was
announced on day one, breaking the "clears within a month" promise for no signal
in return. So `DetectorPopulationSnapshot.reportedStepAt` records the last step
this comparator actually reported, and a re-base newer than the mark re-bases
freely. An erosion cannot use that exemption without first paying for a **red
run**, which is precisely the visibility it was engineered to avoid.

Both sides share one predicate (`stepWasReported`) so the comparator and the
snapshot cannot drift apart — the drift would be silent in exactly the direction
that matters.

Finally, a downward re-base used to leave **no trace at all**: it wrote a new
baseline and handed the operator a number with no history behind it.
`decayRebases` counts consecutive downward re-bases and the regression message
says so out loud.

`__tests__/mutation/mutations.mjs` carries `high-water-rebase-unbounded`, which
restores the pre-fix rule verbatim as a permanent arm.

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

**The schedule runs COMMERCIAL ONLY.** The Gov job is dispatch-only — see
"There is NO Gov in-boundary runner" below and issue #4051. Until that runner
exists, **Gov has no nightly Brain coverage**, and that is stated here rather
than implied by a red square on the run list.

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
to start against a red baseline or a baseline that executed fewer than 300 tests
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
| `LOOM_UAMI_CLIENT_ID` | on the ACA runner | The console UAMI. Selects the identity that already holds Cosmos Data Contributor, and is the identity the run asserts its minted token against. On Commercial its absence is **fatal** — with the SP env vars gone there is no other route to the data plane, so running on would 403 with a wrong stated cause. On Gov it is reported but not fatal: `ubuntu-latest` has no managed identity to select with it either way. |
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
| Unit + property suite | yes | `vitest run lib/brain/run` — 336 tests |
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

### Why the Commercial job runs on `[self-hosted, loom-aca]`

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

`loom-aca` is real: it is declared in `.github/actionlint.yaml` and used by 11
workflows including `deploy-fiab-commercial.yml`. It is the scale-to-zero ACA Job
runner (`gh-runner-job.bicep`), inside the hub VNet **and running as the console
UAMI** (`identity: consoleUamiId`). That identity already holds the Cosmos
built-in Data Contributor role via `cosmosDataRole` in both modules, so this lane
needs **no new `sqlRoleAssignment`** and puts no object id in a public
repository. The workflow reads `LOOM_UAMI_CLIENT_ID` off the console app so the
credential chain selects it explicitly.

### The credential chain had to be unshadowed before it could reach that identity

Everything in the paragraph above was true about **intent** and false about
**behaviour**, and the lane could not have completed a single run in either
boundary because of it. Measured at head by reading the installed SDK rather than
the docs:

- `apps/fiab-console/node_modules/@azure/identity` is **4.13.1**.
- `dist/commonjs/credentials/defaultAzureCredential.js:78-80` orders the
  production chain `EnvironmentCredential -> WorkloadIdentityCredential ->
  ManagedIdentityCredential`, and `:130` appends the developer credentials when
  `AZURE_TOKEN_CREDENTIALS` is unset.
- `AZURE_TOKEN_CREDENTIALS` appears **zero** times across `.github/workflows`.
- `loom-brain-scan.yml` set `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` /
  `AZURE_TENANT_ID` at **job** level in both jobs.

So `EnvironmentCredential` won every time, the managed-identity leg was never
evaluated, and `LOOM_UAMI_CLIENT_ID` was **inert** — the two workflow steps that
exist to resolve it were establishing nothing. The deploy service principal holds
no `sqlRoleAssignments` anywhere in the platform bicep, `disableLocalAuth: true`
makes AAD-RBAC the only data-plane path, and `recordRun` fires on OK, PAUSED
**and** UNREACHABLE — so every verdict would have died on its Cosmos write, from
the first scheduled run onwards.

There was a second door in the same file: when `managedIdentityClientId` is not
supplied, `createDefaultManagedIdentityCredential` falls back to
`process.env.AZURE_CLIENT_ID` — the SP's app id — and asks IMDS for an identity
attached to nothing.

Two changes, and the second is the durable one:

1. **The three variables are gone from both jobs.** They were never needed:
   `Azure/login` takes its credentials inline via `creds:`, and every `az` call
   uses the resulting session.
2. **The identity is now asserted, not assumed.** "We removed the env vars" is a
   claim about a file, not about a run. `lib/brain/run/token-identity.ts` decodes
   the minted token's `appid`/`oid`/`tid` and fails closed when the principal is
   not the one the run declared — so a re-added env var, a runner without the
   UAMI attached, or a chain reorder in a future SDK all fail loudly with the
   principal they actually got, instead of a 403 three steps later. The principal
   is printed **masked**: this repo is public and a workflow log publishes.

An unreadable token with an expectation set is a **failure**, not a pass — a
check that waves through what it could not parse is a check that can be defeated
by making it unparseable.

### Per-cloud status of that fix (`cloud-parity.md`)

The defect was identical in both jobs, so the removal is identical in both. What
the chain can then **reach** is not, and the difference is real rather than an
oversight:

| Boundary | Runner | What the chain reaches now | Status |
|---|---|---|---|
| Commercial | `[self-hosted, loom-aca]` | The console UAMI — the runner carries it. Asserted per run. | **Fixed**, pending a live receipt. |
| Gov (GCC-High) | `ubuntu-latest` | No managed identity exists on a GitHub-hosted runner, so the chain falls through to `AzureCliCredential` — the service principal, via `az login`. That principal holds no Cosmos data-plane role. | **Still blocked**, tracked in [#4051]. |

On Gov this is the *second* blocker, not the first: the job's own preflight
already fails because a hosted runner cannot reach a private-endpoint-only Cosmos
account at all. Both are closed by the same thing — an in-boundary Gov runner
carrying the console UAMI (#4051). Until then the scan names the principal it
actually used and prints the exact
`az cosmosdb sql role assignment create --role-definition-id 00000000-0000-0000-0000-000000000002`
command, rather than failing on a 403 whose stated cause would be wrong
(`deploy-integrity.md` R6/R7).

**Neither boundary has a live receipt for this yet.** The estates are paused per
`scripts/ci/estate-pause-declaration.json` and nothing here was executed against
Azure — the claims above rest on the installed SDK source, the workflow tree and
the bicep grants, all read at head, plus the vitest suites. Stated as untested
rather than implied working.

### There is NO Gov in-boundary runner — and the Gov job says so out loud

An earlier revision of this lane targeted `[self-hosted, loom-aca-gov]`. **That
label was invented.** Measured:

- `.github/actionlint.yaml` declares exactly one self-hosted label, `loom-aca`.
- actionlint says so directly: `label "loom-aca-gov" is unknown`.
- Every one of the ~25 `gov-*.yml` workflows in this repo runs `ubuntu-latest`.

Targeting a label nothing serves would have made the Gov job **queue** — up to
GitHub's 24-hour ceiling, showing as neither red nor green. A lane that never
runs and never complains is the precise failure `#3936` exists to prevent.

So the Gov job runs where every other Gov job runs, and a **preflight probes the
Gov Cosmos account before the scan** and fails with the specific cause and the
specific remediation rather than dying later inside `recordRun` with a stack
trace. **Making it green would be a false claim.**

But it was also on the nightly `schedule:`, and that was its own defect. A job
that is red every night by construction makes a **genuine Commercial population
regression indistinguishable at the run level** — the run is red either way, so
the one signal PRP §5 calls the most valuable thing this system produces gets
buried under a known-red sibling within a week of nobody looking. That is the
"gate that always fails" shape `lib/brain/run/model.ts` refuses in its own
header.

So as of the #4014 review the Gov job is **dispatch-only**:

```yaml
if: github.event_name == 'workflow_dispatch' && (inputs.cloud == 'both' || inputs.cloud == 'gov')
```

Nothing is hidden. The job still exists, still carries its full preflight, and is
still one `gh workflow run … -f cloud=gov` away — and per the standing Gov-access
rule a Gov receipt can ONLY come from a GitHub Actions run, never from local
`az`, so dispatch is the same mechanism it always was. What changes is that a red
Commercial run now means Commercial is red.

Under `cloud-parity.md` a Gov gap must be "a tracked defect with an owner and a
date — never a silent state". **#4051 is that tracked state**, and it is where
the owner and the date belong; a nightly red was an untracked one that also
drowned the Commercial signal.

Closing it needs a Gov equivalent of the `gh-aca-runner` ACA Job inside the Gov
hub VNet, its label declared in `.github/actionlint.yaml`, and the job pointed at
it. That is infrastructure work outside this lane. Restore
`github.event_name == 'schedule' ||` to the job's `if:` on the **same commit**
that repoints `runs-on` — not before, or the nightly red is back.

### The queue-time watchdog

`timeout-minutes` bounds a job's **execution**, not its time in the queue. So a
separate `queue-watchdog` job runs on a GitHub-hosted runner, polls this run's
own jobs, and fails if a scan job is still queued after 20 minutes.

The budget is 20 minutes rather than 2 because `loom-aca` scales **from zero**
when a job queues — brief queueing is its designed behaviour, and a preflight
demanding a runner already be online would fail on the healthy path. 20 minutes
is far outside a cold start and far inside the 24-hour silent ceiling.

It measures whether the job **started**, not whether a runner exists: listing
self-hosted runners needs `administration: read`, which `GITHUB_TOKEN` cannot be
granted, whereas reading this run's jobs needs `actions: read`, which it can. The
observable that can actually be established is the one that is checked.

It lives in `scripts/ci/brain-scan-queue-watchdog.sh` rather than inline in the
workflow, because the inline version could not be tested and got two things wrong
that only execution reveals:

1. **A `gh api` failure exited 0 on the FIRST iteration**, with only a warning.
   One 403 or one blip and the watchdog was silently absent for that run while
   the run itself stayed green. **Exiting 0 is a claim** — per `R7` a guard that
   could not measure must not publish a clean verdict. It now retries
   (`MAX_API_FAILURES`, default 5 consecutive) and then **fails closed**.
2. **`TOTAL == 0` printed "a Brain scan job was still QUEUED"**, which is false.
   Zero jobs is not a queued job, and the two have different causes and different
   fixes: a runner that never picked the job up, versus a job `name:` that no
   longer matches the filter — i.e. a watchdog watching nothing, which would
   report green forever. Each now gets its own true message. An R7 violation
   inside an R7 guard.

`scripts/ci/test-brain-scan-queue-watchdog.sh` proves both with `gh`, `jq` and
`sleep` stubbed and counted — no network, no token, no wall-clock waiting — and
runs in `loom-guardrails.yml`. Measured against the pre-fix script: the
forced-failure arm returned **RC=0** and the zero-jobs arm **wrongly said "still
QUEUED"**; both move now (RC=1, and the correct message). The transient-failure
control still passes in both, so the fix is a repair rather than a blanket
tightening that would fail every healthy run.

### Markdown encoding in the step summary

`ProbeFailure.detail` is a verbatim ARM response body, and resource ids and
detector subjects are Azure resource names and tag values — so text reaching the
step summary is **attacker-influenced**. CodeQL flagged the first version's
`detail.replace(/\|/g, '\\|')` as `js/incomplete-sanitization` (HIGH), correctly:
a backslash immediately before a pipe produced `\\|`, which GFM reads as an
escaped backslash followed by an **unescaped** pipe, breaking the table. It also
ignored newlines, which end the table *row*.

Two structural fixes, not "also escape the backslash":

1. **Entity-encode instead of backslash-escape**, so there is no escape character
   to re-escape and the class cannot recur. `&` is encoded first.
2. **Put unbounded text where escaping is not needed** — the ARM id and the
   response body go into a fenced block whose fence is computed longer than the
   longest backtick run in the content. Only union-typed and numeric fields stay
   in the table.

Entities do not decode inside a code span, so nothing entity-encoded is wrapped
in backticks.

**Block-level was not the whole threat (#4014 review, second pass).** The first
version of `mdParagraph` neutralised *nothing*: it collapsed newlines and argued
that every block-level construct must begin at the start of a line. That is true
and beside the point — `[text](url)` and `![alt](url)` are **inline** and need no
line start, and `mdParagraph` is applied to `v.message`, which embeds
`ProbeFailure.detail`. Measured end to end in the rendered summary:

| | before | after |
|---|---|---|
| `link-live` | **true** | false |
| `img-live` | **true** | false |

A live link in a scan summary is a phishing surface with the Brain's authority
behind it; a live image is an unauthenticated outbound GET from whoever opens the
run — a read receipt on the alert. `mdTableCell` had the identical gap: its
corpus tested forged *rows* and *headings*, so an inline link in a cell was never
exercised. Both now share one encoder (`mdInline`), because two copies would
drift silently in the direction that matters.

`*`, `_` and `~` are deliberately left alone — emphasis is cosmetic and cannot
carry a destination. **Honest limit, asserted rather than hidden:** a bare
`https://…` still autolinks. It cannot be encoded away without mangling the URL
text, which would destroy the verbatim failure R7 preserves, and it is materially
weaker — an autolink's visible text *is* its destination, so it cannot lie about
where it goes. `[click here](evil)` can, and that is what is now dead.

`__tests__/markdown-encoding.test.ts` carries the hostile corpus (now including
the inline shapes), a control that shows the original newline-only implementation
failing them, a decode round-trip proving no evidence is lost, and a drift check
that `mdTableCell` and `mdParagraph` agree on every payload.

### The query scope is validated, not escaped

The Azure Resource Graph REST API has **no parameter binding** — `QueryRequest`
carries only a query string — so a literal is the only construction available.
The first version hand-rolled quote-doubling next to the query, which
`check-sql-quoting` correctly rejects.

Every value the query interpolates has a documented, restrictive character set,
so values are **validated and refused** rather than escaped: an input that cannot
contain a quote cannot break out of one. A resource-group name is checked against
the ARM naming rule (ASCII-only, narrower than ARM's own, because a Unicode
homoglyph in this position would be a finding in itself); the estate tag is
checked against the shape the deploy stamps.

---

## Related

- `PRPs/active/loom-brain/PRP.md` — the design, §3.2 population contract, §3.8
  where the reachability thesis fails, §5 definition of done.
- `docs/fiab/brain/graph-history.md` — W9, the graph version this scan writes.
- `.claude/rules/deploy-integrity.md` — R1 (a broken lane is P0), R6 (classify,
  retry, remediate), R7 (an error must be true).
- `.claude/rules/cloud-parity.md` — why the Gov job exists and why its absence
  from the receipt table is stated rather than implied.
