# The Loom Brain security graph — a build-time artifact

**Status:** merged, not deployed. The extractor, the artifact and the runtime
loader are on `main`; nothing has been rolled to any estate. See
[Cloud coverage](#cloud-coverage) for what was and was not verified per boundary.

---

## Why this exists

`apps/fiab-console/lib/brain/security/**` is nine pure detectors of the shape
`SecurityGraph -> { findings, population }`. They were complete, tested and
**inert**, because nothing produced their input. Measured on `main`,
2026-08-24:

```
$ grep -rn "SecurityGraph" --include=*.ts lib app | grep -v "lib/brain/security/"
lib/brain/__tests__/security/fixtures/corpus.ts:53:  SecurityGraph,
lib/brain/__tests__/security/fixtures/corpus.ts:723:export function cleanBaseline(): SecurityGraph {
lib/brain/__tests__/security/fixtures/corpus.ts:847:): SecurityGraph {
```

Three matches, all in one **test fixture**. `SecurityGraph.source` carries the
values `'modelled' | 'extracted' | 'observed'` precisely so a fixture cannot be
mistaken for a measurement — a fixture is `'modelled'` by construction. So no
`'extracted'` graph existed, the detectors had never run against this
repository, and the risk lane of the synapses view (#3992) shipped permanently
NOT EVALUATED.

## Why it must be a build-time artifact

The detectors reason about **source**: which function reads an admin claim,
whether a caller consumed a verdict as a refusal, which access path reaches a
publication sink.

The deployed console can read Azure Resource Graph. It has **no checkout of the
repository it was built from**, and never will. So the extraction cannot happen
at request time, at start-up, or on a schedule inside the container. It happens
once, at build time, over the real tree; the result is committed as JSON and
imported statically into the image.

That shape has a second consequence worth stating explicitly, because
`cloud-parity.md` is die-hard: **the artifact is cloud-neutral by
construction.** It is resolved at build time, before any cloud exists. There is
no endpoint, no ARM call, no env var and no filesystem layout that could differ
between Commercial, GCC, GCC-High, IL5 and DoD. The property is asserted on the
real bytes by `__tests__/no-estate-identifiers.test.ts`, not merely claimed
here.

## Layout

| Path | Role |
|---|---|
| `scripts/brain/extract-security-graph.mjs` | The build step. Walks the tree, compiles the extractor with `tsc`, writes the artifact. |
| `lib/brain/security/extract/source-facts.ts` | Pure lexical primitives (comment/string blanking, handler discovery). |
| `lib/brain/security/extract/sinks.ts` | Privileged sinks + session-derived scope. |
| `lib/brain/security/extract/consumption.ts` | How a verdict is consumed (C3's whole mechanism). |
| `lib/brain/security/extract/route-nodes.ts` | `authorizer` (C1) and `verdict-call` (C3) nodes. |
| `lib/brain/security/extract/publications.ts` | `publication` (C4) nodes. |
| `lib/brain/security/extract/join.ts` | The estate join — painted / unjoined. |
| `lib/brain/security/extract/artifact.ts` | Refuses an artifact that cannot be trusted. |
| `lib/brain/security/extract/runtime.ts` | `loadExtractedSecurityGraph()` — the runtime half. |
| `lib/brain/security/extract/__generated__/security-graph.json` | The committed artifact. |

## Running it

```bash
node scripts/brain/extract-security-graph.mjs           # regenerate + write
node scripts/brain/extract-security-graph.mjs --check    # CI drift gate, exit 1 on drift
```

The `--check` mode compares the **graph and join**, not the inputs digest.
Measured 2026-08-24: fixing the generic-call matcher moved the node count
905 → 908 with a **byte-identical** digest, because the inputs had not changed
— only the extractor had. A digest-only check would have called a stale
artifact current.

## What is measured today

Over 2,040 scanned files (1,692 console route modules, 348 scripts):

| Node kind | Count | Detector |
|---|---:|---|
| `verdict-call` | 403 | C3 |
| `authorizer` | 297 | C1 |
| `publication` | 208 | C4 |
| **total nodes** | **908** | |
| edges | 174 | `calls` (authorizer → verdict-call) |

The edge count is low **by design**, not by omission. `substrate.ts` argues at
length that security detection needs facts a call graph cannot carry, and none
of the nine detectors traverses `edges` — they all read facets. Emitting more
edges would add weight and no fact.

### Findings on this tree

| Class | Count |
|---|---:|
| C1 unauthorized inbound edge | 29 |
| C4 unbounded publication | 14 |
| C3 discarded verdict | 3 |
| `POP-population-integrity` | 6 |

Coverage: `judged 908 / candidates 908`, ratio `1.0`, no incomplete detectors.

### The gap this closes

`scripts/ci/check-tid-boundary-chokepoint.mjs` matches the token
`isTenantAdmin(` and reports a repo-wide census of **15** candidates. Measured
on this tree, **72 route files** consume `withTenantAdmin`, which does not
contain that token. Those files are structurally outside that guard's
population — the "adoption removes the file from the population" failure
`population.ts` documents, applied to a wrapper.

This extractor **resolves the wrapper**: a route wrapped in `withTenantAdmin`
is emitted as an authorizer whose condition predicate is `isTenantAdmin`,
because that is the claim actually read. C1 is explicit that naming the
predicate is the extractor's job.

The concrete instance it surfaces:
`app/api/copilot/sessions/[id]/trace/route.ts` is `withTenantAdmin`-gated and
performs `c.item(id, id).read<T>()` — a point-read whose partition key **is the
caller's URL segment**, against a container with no tenant partition and no
`oid` comparison anywhere in the handler.

## What is NOT extracted, and how you can tell

Six of the nine node kinds have no extractor: `scoped-handler` (C2),
`verdict-totality` (C5), `credential-egress` (C6), `principal` (C7),
`emitted-command` (C8), `predicate-impl` (C9).

This is a **reported** gap, not a hidden one. `Population.emptyIsExpected`
defaults to `false` on every detector, so each of those six runs over an empty
candidate set and synthesises a `POP-population-integrity` finding reading
*"examined an EMPTY population — green and blind"*. The sweep says out loud,
per detector, that six classes were not measured.

That is strictly better than an extractor that emits a plausible node of each
kind so the numbers look complete — which would report a verdict over an estate
nobody examined.

### Known inert arms

- **C4's expression arm.** `carriesSensitive` matched **0 of 2,182** non-spawn
  publication sinks. Every C4 finding on this tree comes from the spawn-stdio
  arm (`stdio: ['inherit', …]`, where the child is not proven to redact). The
  expression arm is therefore unexercised by the real corpus, and C4's output is
  **not** evidence that no unbounded sensitive write exists. Recorded in the
  artifact's `meta.skipped` so it is countable.
- **The alias / destructured / bracket access paths** (#3876 bypasses 2–4) have
  **zero population** on this tree — 2,182 of 2,196 sinks are plain `member`
  access. The detection exists and is unit-tested, but no real file exercises it.
- **`declaredSinkCount` drift.** No module in this repo carries a
  `PUBLICATION-SINKS: N` marker, so C4's declared-count drift check is inert for
  all of them. The extractor records each such module in `meta.skipped` rather
  than manufacturing agreement — setting `declaredSinkCount = sinks.length`
  unconditionally would produce a check that cannot fail.

## The estate join

The two halves of the Brain have **disjoint id spaces**. The waste side keys on
`azure:/subscriptions/…`; the security side keys on source coordinates. Nothing
mapped one to the other, so a finding could be listed but not painted.

The join records the **logical** deployable unit that serves each module —
`loom-console`, the name the bicep gives the Container App — and stops there.
Resolving that to a live `azure:` node is the runtime's job, where the estate is
actually known and nothing is published. At build time no subscription exists,
and writing one into a committed file in a **public** repo would publish it.

| Lane | Count | Meaning |
|---|---:|---|
| painted | 700 | console route modules → `loom-console` |
| unjoined | 208 | CI scripts — they run in GitHub Actions and have **no** Azure estate presence |

`unjoined` is a **result, not a failure**. Painting a CI guard script onto a
Container App would assert an edge that does not exist.
`assertJoinCoversGraph()` refuses a join whose two lanes do not add up to the
node count, so a node cannot silently vanish between the extractor and the
surface — the population discipline of `population.ts`, applied to the join.

## Not evaluated, and why

`resolveSecurityGraph()` refuses an artifact it cannot trust and returns a
**reason**, never a zero. Every branch below is reachable and is entered by
`__tests__/artifact.test.ts`:

| Refusal | Cause |
|---|---|
| missing | no artifact shipped with this build |
| version | produced by a different extractor version |
| provenance | `source` is not `'extracted'` |
| **zero nodes** | a sweep would report zero findings, indistinguishable from clean |
| **stale** | older than 90 days — the artifact's age *is* the age of the source it describes |
| unparseable date | age cannot be established; an unknown must not be reported as a negative |
| malformed | shape does not carry graph/join/meta |
| incoherent join | some node is on no surface |

A zero-node graph is refused rather than swept. Handing it to the detectors is
tempting — all nine would raise "green and blind" population findings — but a
consumer that filters to *security* findings (which any "how many risks?" count
does) gets zero, and zero reads as clean.

## Wiring it to the surface

#3992 left the seam at
`app/api/admin/brain/_lib/security-source.ts#loadSecurityGraph`, which returns
`{ available: false, reason: … }` unconditionally. With this package present
that becomes one line:

```ts
export function loadSecurityGraph(): SecurityGraphSource {
  return loadExtractedSecurityGraph();
}
```

Same return type; every downstream consumer unchanged. That file lives on
#3992's branch and not on `main`, so this PR does **not** edit it — doing so
would create an add/add conflict on an unmerged PR.

## Cloud coverage

| Boundary | Status |
|---|---|
| Commercial | Extractor + loader verified locally and in CI. **Not deployed**, so not verified live. |
| GCC / GCC-High / IL5 / DoD | **Not deployed, not verified live.** |

The artifact is cloud-neutral *by construction* (static import, resolved at
build time, no cloud named anywhere in it — asserted by test). That is a
structural argument, and a strong one, but it is **not** a per-cloud deploy
receipt. Per `cloud-parity.md` a parity claim needs a receipt per boundary, and
per the Gov access rule that receipt comes from a GitHub Actions run. Neither
exists yet for this artifact.
