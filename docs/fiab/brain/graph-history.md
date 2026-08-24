# Loom Brain — graph history (W9, #3935)

**Status: merged code, NOT deployed and NOT verified live.** Nothing in this
page is a claim about a running estate. See *Per-cloud status* at the bottom for
exactly what has and has not been executed.

The Brain's central claim is that *"an edge that should not have formed"* is a
security finding. That sentence has no referent without a **before**. A snapshot
can say a node is unreachable *now*; it cannot say a route **gained** a
privileged edge and no authorization edge. This layer is the before.

It is also what makes pruning safe. A node with no inbound edge today may be
newly provisioned and not yet wired. A node with no inbound edge across N
consecutive versions **and** a real span of wall clock is genuinely dead.
Recommending a deletion off a single snapshot is how the Brain would delete
something that was mid-deploy.

Code: `apps/fiab-console/lib/brain/history/` ·
BFF: `apps/fiab-console/app/api/admin/brain/history/route.ts`

---

## 1. The version

One graph build → one immutable, timestamped, **content-addressed** document.

| Field | Meaning |
|---|---|
| `id` | `<compact capture instant>-<first 12 of digest>` — unique and sortable |
| `estateId` | partition key. History is scoped to an **estate**, not a tenant |
| `capturedAt` | when the CONTENT was first observed. Immutable |
| `digest` | sha256 over the canonical projection. **The content address** |
| `counts` | nodes/edges/resolved/dangling/by-provenance/by-kind |
| `collectedProvenances` | which provenances the capturing runtime actually collected |
| `observedCount` / `lastObservedAt` | the only mutable fields; excluded from the digest |
| `content` | the projected nodes and edges |

The projection is **smaller than the graph on purpose** — a version is a
change-detection record, not a second copy of the estate. Three things are
deliberately dropped:

- **`evidence.line`** — a wire moving from `main.bicep:4730` to `:4731` because a
  comment was inserted above it is not a change to the estate. Keeping the line
  turns every unrelated edit into estate drift.
- **the authored value** — replaced by a class (`absent` / `empty` / `nonempty`),
  a length, and a 64-bit digest. An env var value can be a connection string;
  this repo counts every place a secret comes to rest as a publication surface.
  The empty/non-empty distinction survives, because it **is** the founding
  finding (`LOOM_BROKER_URL: ''`).
- **tag values** — only the key set, plus `loom-estate-id`, which is load-bearing
  for ownership. Tag values are arbitrary customer text that Azure Policy
  rewrites on its own schedule.

### Public-repo constraint

A stored version legitimately carries the estate's own ARM ids — it lives in that
estate's Cosmos account. **Nothing in this repository may.**
`lib/brain/history/__tests__/no-real-ids.test.ts` scans the whole directory
(including the fixtures) for any 8-4-4-4-12 hex string and fails on one, with
**no allowlist**. The fixtures therefore use words (`sub-alpha`), not synthetic
GUIDs: an allowlist would turn a mechanical check into one that needs a human to
be right every time.

---

## 2. Why this does not produce noise

A history feature dies of false positives long before it dies of missing data.
Four decisions make "unchanged ⇒ no version" structural rather than hopeful.

1. **The digest is over a canonical, SORTED, semantic projection.** Azure
   Resource Graph does not promise a stable row order between calls, and the
   extractors iterate rows. Hash the graph as-emitted and the same estate hashes
   differently on the next poll — every capture stored, every diff empty.

2. **Every field is length-prefixed** in the canonical form, so a display name
   containing a separator cannot forge a field boundary. Collisions there would
   be by construction, not by luck, and a collision **silently discards a real
   change** — the store reads equal digests as "nothing happened".

3. **A capture decides in two stages.** Stage 1 is digest equality. Stage 2 runs
   the real comparator and, if nothing was added, removed or changed, still
   writes nothing. Stage 2 is what makes *"a version exists ⟺ the graph changed"*
   true rather than approximately true; it costs one O(n) diff per capture.

4. **A diff only ranges over provenances BOTH versions collected.** The deployed
   console cannot collect `declared` (bicep is not in the image) or `imports`
   (the sources are not in the image). If a future capture path does collect
   them, comparing it against a version that did not would report every bicep
   edge as ADDED — and the reverse comparison would report every one as REMOVED.
   Neither is a change in the estate; both are a change in what was looked at,
   and both look exactly like a catastrophe. The intersection is computed and the
   excluded provenances are **named** in `provenancesNotComparable`.

Edges are additionally **paired by wire, not by id**. An `EdgeId` embeds the
provenance, the target and the source line, so `LOOM_BROKER_URL: ''` becoming
`LOOM_BROKER_URL: 'https://…'` retires one id and mints another. Diffed by id,
the single most interesting event this system can observe — a dead wire coming
alive — arrives as an unrelated addition next to an unrelated removal.

---

## 3. Atomicity, and failing closed

A version is **one document**. There is no chunking path and no truncation path,
because a half-written graph read as a diff base reports a mass of spurious
removals and looks exactly like a catastrophic outage.

- Over the document budget → `GraphVersionTooLargeError`, **nothing written**,
  with the counts and a concrete remediation (deploy-integrity R6).
- A stored version that does not verify → `GraphVersionIntegrityError`, and the
  diff is **refused**. Verification is two independent checks: recomputing the
  digest (catches any edit) and the stored counts (catches a truncation even from
  something that also rewrote the digest). The count checks run first so a
  truncation produces the message that names it.
- An unknown `base` version id → **refused**. Treating it as an empty graph would
  report every edge in the estate as newly added, to a consumer whose job is to
  highlight new edges as a risk surface. The refusal states only what it
  established (deploy-integrity R7): the route checks the id against the
  **complete** retained list, so "no graph version with that id is retained" is a
  fact it can assert; the window-scoped query underneath cannot, and says
  instead that the id is not among the versions it loaded — with the **retained**
  count, never the window size.

---

## 4. The queries

| Query | Answers |
|---|---|
| `edgesAddedSince(history, versionId)` | the risk surface for new-code review |
| `edgesAddedSincePrevious(history)` | the default change feed |
| `nodeUnreachableForConsecutiveVersions(history, n)` | the **safe** prune predicate |
| `edgeProvenanceChanged(base, head)` | a `declared` wire becoming a live `configured` one |
| `publicExposureGained(diff)` | a private endpoint that went public |

### The prune predicate is the dangerous one

Its output is a deletion proposal, so every default leans toward not firing:

- **`n >= 2` is required.** `n = 1` is the single-snapshot answer this whole work
  item exists to replace; it throws rather than accepting the argument that
  reintroduces the bug.
- **Present in all n.** A node that did not exist in the oldest examined version
  cannot have been unreachable in it. Counting absence as unreachability makes
  every newly created resource instantly prunable.
- **A time floor**, default 24 h, opt-out. A deploy can produce several graph
  changes in minutes, and a resource created inside that window is unreachable in
  every one of them.
- **Coverage is checked.** A version that did not COLLECT the provenance has zero
  inbound edges of it for every node, *vacuously*. `Population.blind` cannot
  catch that — the node set is not empty — so the query refuses and says so.

Every result carries a `HistoryPopulation`: versions retained, versions examined,
versions discarded for a format mismatch, and nodes/edges **per version**.
`versionsExamined < 2` means **no basis**, not "no changes".

---

## 5. Retention — bounded, and stated

| Bound | Value | Enforced where |
|---|---|---|
| Versions per estate | **50** | `captureGraphVersion`, on every successful write, before it returns |
| Container TTL | **90 days** (7 776 000 s) | Cosmos `defaultTtl`, set by bicep |
| Single document | **1.6 MB** | `captureGraphVersion` — over budget FAILS |

A version is written only when the graph **semantically changed**, so 50 is 50
real estate changes, not 50 polls. Measured baseline (PRP §2: 63 Container Apps /
29 jobs / 13 environments) projects to roughly 60–100 KB per version.

The TTL is the backstop for the case count-based pruning cannot cover: an estate
that stopped being captured. Count-based pruning only runs when something writes.

---

## 6. What the deploy wires

Cosmos container **`brain-graph-versions`**, partition key `/estateId`,
`defaultTtl` 7 776 000, declared in **both** container-provisioning paths so the
topology choice cannot silently skip it:

- `platform/fiab/bicep/modules/landing-zone/cosmos.bicep` (single-DLZ topology)
- `platform/fiab/bicep/modules/admin-plane/loom-console-cosmos.bicep`
  (separate console-Cosmos topology)

**No new environment variable.** The store reuses `LOOM_COSMOS_ENDPOINT` /
`LOOM_COSMOS_DATABASE`, which the deploy already emits, and the estate id comes
from `resolveEstateId()`, which synthesizes a deterministic value when
`LOOM_ESTATE_ID` is unset. Per `auto-bind-by-default.md` §5 there is nothing for
an operator to set.

The store also `createIfNotExists`'s the container with the same partition key
and TTL — the sanctioned idempotent fallback for an estate whose Cosmos account
predates this module. The deploy is the primary path.

---

## 7. The API

`GET /api/admin/brain/history` — read-only. Never writes, not even an
observation: a read endpoint that appends is one a prefetch or a retry silently
drives, and the resulting history records the polling schedule.

Query parameters: `base` (**any** retained version id), `consecutive` (prune
depth, `>= 2`, default 3).

The read path loads the newest **8** versions with content — an RU bound on the
default question ("what changed since last time?"), since retention keeps up to
50. That bound does **not** restrict `base`: a retained version outside the
window is fetched by a single point read on its id, and the response says so
(`baseResolvedOutsideReadWindow`, plus a note that the versions *between* base
and head were not loaded, so the diff is a pairwise comparison of the two
endpoints). The `consecutive` prune predicate deliberately keeps ranging over
the **contiguous** window only — a gap must never be able to masquerade as a
streak in something whose output is a deletion proposal.

`POST /api/admin/brain/history` — capture. Writes only on a semantic change;
returns `status: 'unchanged'` with the reason otherwise.

Both are wrapped in `withTenantAdmin` from `lib/api/route-toolkit.ts`. The
handler is an **argument** to the gate, so there is no `if (gate) return gate;`
line a caller can drop — the failure shape that defeated authorization on a
subscription-scoped ARM deploy path on 2026-08-07 while three merge-blocking
controls stayed green.

---

## 8. Per-cloud status — read this before claiming anything

| | Status |
|---|---|
| Unit / property tests | **PASS** — 103 tests over the history layer, plus 13 mutation arms, each proven to turn a spec RED |
| `tsc -p tsconfig.build.json` | **PASS**, 0 errors |
| `az bicep build` (both modules) | **PASS**, no new diagnostics |
| Commercial (MAC) | **NOT DEPLOYED, NOT VERIFIED.** No Cosmos write has been executed against a real account |
| Azure Government (MAG) | **NOT DEPLOYED, NOT VERIFIED.** Cloud invariance is an argument from construction (no host literal; the endpoint comes from the deploy), not a receipt |
| Browser E2E (`ux-baseline.md` G1) | **NOT DONE.** This work item ships no UI; W8 (#3934) owns the surface |

Known gap, disclosed rather than implied: **nothing calls `POST` yet.** On a
fresh estate the endpoint honestly reports an empty history rather than
pretending the current snapshot is a change. Wiring a caller — the Brain surface
on load, or a scheduled Container App Job — needs files this work item does not
own.

---

Related: `PRPs/active/loom-brain/PRP.md` §3.7 · `docs/fiab/brain/security-taxonomy.md` ·
issues #3933 (Loom Brain), #3935 (this), #3934 (the surface that renders it).
