# Security-defect taxonomy for Loom Brain

**Status:** grounding document. Read-only analysis; no code changed.
**Measured on:** `e4dcfd728d` (worktree `wf_4502aa90-852-1`), 2026-08-23.
**Scope:** the thesis that *security detection is reachability with the edge
predicate inverted*, tested against defects this repo has actually shipped.

Every file:line in this document was opened and read in the session that wrote
it. Every count was produced by a command run in that session. Where a claim
could not be confirmed it is labelled **UNCONFIRMED** rather than asserted
(`deploy-integrity.md` R7). Identifiers are elided: this repo is public.

---

## 0. Two corrections before the taxonomy

Both matter because the rest of the document depends on them.

### 0.1 The PRP this document was commissioned against does not exist

The task cited `PRPs/active/loom-brain/PRP.md` §3.7. Measured:

```
PRPs/active/  ->  omnibus-2026-08-22/   (only entry)
grep -ril "loom.brain|loom_brain" PRPs docs .claude   ->  no matches
git ls-remote --heads origin | grep -i brain          ->  no matches
gh pr list --state all --search "loom-brain"          ->  no PR of that name
```

There is also no `substrate`, no provenance model, and no `declared` /
`configured` / `imports` / `observed` / `owns` vocabulary anywhere in the tree.
So the thesis under test is the one stated in the commission, not one this repo
has written down, and the provenance terms below are **my working definitions**,
offered so the taxonomy is implementable — not quoted from a spec.

| Provenance | Working meaning used here |
|---|---|
| `declared` | Asserted in source: a route file exists, a function is exported, a guard is named. Cheapest, and the one most often *wrong*. |
| `configured` | Set by deploy/env/bicep: `LOOM_*`, allowlist entries, gate registry rows. |
| `imports` | A static module edge. **Explicitly not a call.** See C3. |
| `observed` | Established at runtime or by executing an analyzer: a live guard run, a probe, a browser E2E. |
| `owns` | A tenancy/partition relation: `Workspace.tenantId` holds the creator's Entra oid and is the Cosmos partition key; `wsDoc.tid` holds the owning Entra tenant. |

The `owns` row is the load-bearing one and it is genuinely subtle in this repo:
`tenantId` does **not** mean tenant. `apps/fiab-console/lib/auth/workspace-guard.ts:106-115`
records that `assertOwner` was deleted precisely because a point-read on
`workspacesContainer().item(id, oid)` can only answer "did this caller *create*
this workspace", never "may this caller *access* it".

### 0.2 The admin-bypass family has THREE shapes, and the repo's own lane doc says two

`PRPs/active/omnibus-2026-08-22/L1-security-authz.md:51` still reads:

> The admin bypass is a FAMILY with two greppable shapes: `isTenantAdmin(session)) return null` and unfiltered `loadWorkspaceAdmin`.

Issue **#3891** (OPEN) established a third. The lane doc that governs the
security lane is stale against an open issue in its own inventory (#3891 is not
listed in its §7 table either). That is a live drift, not a historical note.

---

## 1. The thesis, restated so it can fail

> Waste is a node with no inbound edge. A vulnerability is an inbound edge that
> should not exist — a path from an untrusted origin to a privileged sink with
> no authorization edge on it. Same graph, same engine, opposite question.

Formally, the detector is:

```
exists path p : origin(untrusted) ⇝ sink(privileged)
  such that  no edge e ∈ p  carries an authorization predicate
             that is BOTH evaluated and consumed
```

The three words that carry all the weight are **evaluated**, **consumed**, and
**path**. This repo has shipped a defect against each of them independently:

- an edge whose predicate is *present and evaluated* but answers on the wrong
  input (C1);
- an edge whose predicate is *evaluated and correct* but whose answer is
  *discarded* (C3);
- a path that *does not exist in the static graph at all* (C4, C6).

The thesis survives the first. It survives the second only if "edge" is
redefined to mean a *consumed* verdict rather than a call. It does not survive
the third, and §11 says so.

---

## 2. C1 — The unauthorized inbound edge (the admin-bypass family)

The canonical class, and the one the thesis fits best.

### 2.1 Graph shape

```
node  caller           provenance: observed   (session claims: oid, tid, groups)
node  workspace/item   provenance: owns       (wsDoc.tid, Workspace.tenantId)
node  sink             provenance: declared   (an exported route handler)

edge  caller -> sink            UNTRUSTED   (caller supplies [id] in the URL)
edge  sink   -> resource        PRIVILEGED  (Cosmos read/write, ADLS ACL, delete)
edge  caller -> resource        AUTHORIZATION — must exist, be evaluated, be consumed
```

The defect is that the authorization edge is **replaced by a claims-only edge**.
`isTenantAdmin(session)` is an edge from `caller` to *nothing* — it reads a claim
and never touches the `owns` relation. The path reaches the privileged sink with
no edge that mentions the resource.

Critically, the correct predicate is a **positive match on `owns`**, not the
absence of a contradiction. `apps/fiab-console/lib/auth/workspace-access.ts:335`
is step 4:

```ts
if (callerTid && wsDoc.tid && wsDoc.tid !== callerTid) return null;
```

That is a *non-contradiction* test: a session with no `tid`, or a workspace doc
with no `tid`, short-circuits and passes. Step 6 at line 358 is the repaired form:

```ts
if (callerTid && wsDoc.tid && wsDoc.tid === callerTid) { ... }
```

Fixed by commit `bfd67ed1` — *"require a POSITIVE tenant match, not merely a
non-contradiction"* (#3859). In graph terms: **an edge that fails to fire on
missing data is not an edge.**

### 2.2 Real instances — measured on this tree

Three distinct spellings. All three counts below are from commands run this
session.

**Shape 1 — `isTenantAdmin(session)) return null` (allow before any read).**

```
grep -rn "isTenantAdmin(session)) return null" apps/fiab-console --include="*.ts"
```

7 hits, of which **2 are executable**:

| File:line | Verdict |
|---|---|
| `apps/fiab-console/app/api/items/[type]/[id]/security-roles/route.ts:85` | **LIVE DEFECT** — issue #3855 (OPEN) |
| `apps/fiab-console/lib/auth/feature-gate.ts:157` | Legitimate — `requireTenantAdmin`, the org-wide admin gate |

The remaining 5 are docblock prose (`workspace-guard.ts:57`, `:219`) and spec
prose (3 test files). `security-roles/route.ts` POST/DELETE grant and revoke
**real ADLS Gen2 POSIX ACLs** on shared DLZ storage, so this is a write-side
escalation, not a read.

> **Discrepancy I could not reconcile, recorded rather than smoothed over.**
> #3891's body states shape 1 measured *"8 grep hits repo-wide, only 1
> executable (`lib/auth/feature-gate.ts:157`)"*. I measure **7 hits, 2
> executable** — #3891's audit does not account for `security-roles/route.ts:85`,
> which #3833 and #3855 both name as a live shape-1 member. Either the
> measurement was taken on a tree where that line differed, or the audit that
> discovered the *third* shape undercounted the *first*. I cannot tell which
> from here. Two independent audits of one family disagree on its population,
> which is itself the finding.

**Shape 2 — admin triggers an unfiltered cross-partition read.**

```
grep -rn "loadWorkspaceAdmin(" apps/fiab-console --include="*.ts"
```

5 hits: 1 definition (`lib/clients/workspaces-client.ts:213`), 1 executable
consumer (`lib/azure/powerbi-workspace-mapping.ts:68`, triaged in #3833 as
not-a-finding — it returns a Power BI id mapping and decides nothing), and 3
docblock/test references in `app/api/workspaces/bulk-delete/`.

`bulk-delete` is **FIXED**. Its route header (`route.ts:13-41`) now records the
removed shape and states the repair: the private path is gone, admins are
authorized too (no `!admin &&` short-circuit), and a foreign-tenant id is
indistinguishable from a nonexistent one. This was the worst member of the
family — it ended in `deleteOne(ws, cascade)`, a cascade teardown of Azure
resources.

**Shape 3 — a coerced truthy read becomes the authorization decision.**

`apps/fiab-console/app/api/workspaces/[id]/folders/route.ts:35-37`, **LIVE**
(#3891, OPEN):

```ts
if (isTenantAdmin(session)) {
  return !!(await readWorkspaceById(id));
}
```

`readWorkspaceById` is an unfiltered cross-partition read. The boolean it is
coerced into gates **GET, POST, PATCH and DELETE** on the folder tree. This is
neither shape 1 (`return null`) nor shape 2 (`loadWorkspaceAdmin`), so every
grep the family had been audited with missed it.

### 2.3 The detector query

> Over the console's exported route handlers and every function in `lib/auth/**`:
> find each function whose body contains a `return` on a path condition that
> mentions an admin-claim predicate, and whose returned value classifies as
> ALLOW for that function's return type. For each, require that the ALLOW is
> **implied by** a verdict obtained from the canonical `owns` resolver
> (`resolveWorkspaceAccessByOid`) — proved by boolean implication over the path
> condition, not by the condition *mentioning* the verdict. An ALLOW that
> precedes any delegation must be pinned by the *whole prologue text*, not by
> its condition string.

That is not hypothetical: it is `scripts/ci/check-tid-boundary-chokepoint.mjs`
section 8, and its own header (lines 22-41) records that sections 1-7 were
**measured blind** to #3825 — with step 6 fully reverted the guard still printed
OK and exited 0, because checks 1-7 verify that every call site *supplies* the
discriminant, never that the boundary *decides*.

**Design rule extracted:** verifying that an edge is *present* is a different
property from verifying that it *decides*. Both are needed. The first is cheap
and is what every naive detector implements.

### 2.4 The NARROW bypass — measured live, this session

This is the section that matters most, because the repo's dominant evasion is
scope narrowing and the evidence here is unusually good.

**(a) Scope the bypass to one item type.** `workspace-guard.ts:216-227` records
that on 2026-08-21 an independent review inserted ONE line at the top of
`authorizeItemWorkspace`:

```ts
if (opts.itemType === 'lakehouse' && isTenantAdmin(session)) return null;
```

It passed **the entire verification stack** — guard exit 0, the 27-test #3825
spec green, the 259-test wide suite green — while granting a real cross-tenant
ALLOW for that one item type. `authorizeItemWorkspace` is the 85-importer entry
point; a bypass scoped to one `itemType` is invisible to a spec suite that
exercises a different one.

The round-2 fix for it was then defeated by:

```ts
if (!denied || opts.itemType === 'lakehouse') return null;
```

— which *mentions* the verdict and discards it. Hence the boolean-implication
requirement above: **mentioning a verdict is not reading it.**

**(b) Forge the predicate's INPUT one line up.** `workspace-guard.ts:202-211`
records a review that left the condition `!workspaceId` byte-identical and
changed what feeds it:

```ts
workspaceId = opts.itemType === 'x' ? '' : (await workspaceIdOfItem(…)) || '';
```

producing a live cross-tenant ALLOW that never read a document at all. A second
`if (!workspaceId) return null;` elsewhere in the same function inherited the
exemption because the allowlist key was `<fn>:<condition>`. Pinning the
*condition* was not enough; the pin is now positional over the whole prologue.

**(c) Fall outside the guard's population by naming your parameter something
else.** This is the strongest single measurement in this document, and I ran it:

```
$ node scripts/ci/check-tid-boundary-chokepoint.mjs
[tid-boundary-chokepoint] repo-wide admin-shape scan: 15 function(s) whose OWN
  body grants on an isTenantAdmin-bearing condition, of which 1 are
  workspace-scoped by signature (#3825)
[tid-boundary-chokepoint] OK — the tenant boundary is required at every call site.
RC=0
```

**The detector finds 15 functions carrying the exact defect shape and judges
1.** The filter that discards the other 14 is at
`scripts/ci/check-tid-boundary-chokepoint.mjs:2662`:

```js
const ADMIN_GRANT_SCOPE = /\bworkspace(Id|_id)?\b/i;
```

applied at `:2684` as `if (!ADMIN_GRANT_SCOPE.test(fn.params)) continue;`. A
route-level authorizer whose parameters are named `itemId` / `itemType` — which
is exactly `security-roles/route.ts:85`'s signature — is outside the judged
population. The guard says **OK, RC=0** with a live shape-1 defect in the tree.

To the guard's credit this limit is *disclosed* in its own comment at
`:2655-2661`. Disclosure is not enforcement. The detector's honest verdict
is "1 of 15 judged", and a consumer reading only `RC=0` learns the opposite.

**Design rule extracted:** report the **population**, not the verdict. A
detector must emit `judged / candidates` and a consumer must treat a shrinking
`judged` as an alarm. Section 9 of this same guard exists for precisely that
reason — *"every finding of the round-5 review showed up first as that list
quietly getting shorter while the guard printed OK."*

### 2.5 Regression fixtures

**Positive (must fire):** a function taking `(session, itemId: string, itemType: string)`
whose body opens `if (isTenantAdmin(session)) return null;` and then performs an
owner-scoped read. Must be flagged **despite** no parameter matching
`/workspace(Id|_id)?/i` — this is the C1 §2.4(c) case and the current guard
misses it.

**Positive (narrow variant, must fire):** the same function with the ALLOW
scoped to a single literal — `if (opts.itemType === 'lakehouse' && isTenantAdmin(session)) return null;`
— and a spec suite exercising a *different* item type. The detector must not
depend on the suite.

**Negative control (must NOT fire):** `lib/auth/feature-gate.ts:157`
(`requireTenantAdmin`). It is byte-identical in shape to the defect and is
correct, because its contract is "is this caller a tenant admin at all" — an
org-wide gate over no resource. Any detector that flags it is keyed to a
spelling rather than to the presence of an unauthorized *resource* edge. This is
the fixture that separates a real detector from a grep.

**Negative control (must NOT fire):** `lib/azure/powerbi-workspace-mapping.ts:68`
— an unfiltered `loadWorkspaceAdmin` whose result never becomes an authorization
decision. Shape-matching flags it; edge-semantics does not.

---

## 3. C2 — The aggregate oracle (a count is an edge when the caller picks the scope)

### 3.1 Graph shape

```
edge  caller -> query-scope   UNTRUSTED   (caller supplies workspaceId)
edge  query  -> resource      PRIVILEGED  (cross-tenant Cosmos read)
edge  result -> caller        REDACTED    (identifiers stripped; count survives)
```

The identifier-redaction edge is real and correct. It is also **the wrong
edge**. The disclosure is not the identifiers, it is the *cardinality of a
population the attacker chose*. A redaction defence answers "what leaves?" and
says nothing about "who chose what was counted?".

### 3.2 Real instance

`auto-bind-sweep.ts` (#3808) returned `excludedByAccess` as a count only, with a
docblock defending it verbatim: *"naming them would be the cross-tenant
disclosure the filter exists to prevent."* That reasoning is correct and it still
shipped a leak, because the same function accepted a caller-supplied
`opts.workspaceId` that reached the Cosmos query unchecked. Measured at the time,
with the access resolver returning `null` for every row:

```
POST { workspaceId: '<foreign-ws>', itemTypes: ['t'] }
-> excludedByAccess: 5, rows: [], no identifier in the body
```

Existence plus cardinality, narrowable per `itemType`. No identifiers disclosed.

**Current state — measured:** `grep -rn "excludedByAccess" apps scripts` returns
**zero hits**, and no `auto-bind-sweep` file exists in `apps/` or `scripts/`. The
instance is gone. I did **not** confirm which PR removed it (`gh search commits`
for the obvious terms did not surface it), so: instance closed, **provenance
UNCONFIRMED**.

The repo's stated answer is at `apps/fiab-console/lib/api/route-toolkit.ts:113`
— *"the same 404-not-403 behaviour the hand-rolled routes use so an id can't be
probed for existence across tenants."* `bulk-delete/route.ts:34-36` applies it
per-id: a foreign-tenant id and a nonexistent id report an identical `not_found`.

### 3.3 Detector query

> For every handler that accepts a scope-narrowing parameter from the request
> (`workspaceId`, `tenantId`, `itemType`, any `[id]`), require that the scope is
> resolved against the `owns` relation **before** it reaches a data-plane query.
> Then, over the response shape, treat any *numeric* field derived from that
> query as a disclosure edge of the same weight as an identifier field. Flag any
> response where an identifier field is redacted **and** a count derived from
> the same query is not — that asymmetry is the signature.

### 3.4 The NARROW bypass

Scope the aggregate so it looks incidental. A detector keyed to "a count in a
response body" is defeated by:

- returning the count in a **header**, a `GITHUB_STEP_SUMMARY`, or a telemetry
  span rather than the JSON body;
- returning a **boolean** — `hasExcluded: true` — which is a count truncated to
  one bit and still an existence oracle;
- returning the count under a **different query** than the one the scope
  narrowed, so a taint-follow from `opts.workspaceId` to the emitted number
  finds no path;
- exposing it as a **timing** or pagination artifact (`nextCursor` present or
  absent) rather than a number at all.

The general form: the detector's population is "counts", and the leak need not
be one. That is the same failure as C4's enumerator (§5.4) one level up.

### 3.5 Regression fixtures

**Positive:** a handler taking `opts.workspaceId`, resolving access per-row,
returning `{ rows: [], excludedByAccess: N }`. Must fire.

**Positive (bit-truncated):** the same handler returning `{ rows: [], anyExcluded: true }`.
Must fire — this is the bypass, and a count-typed detector misses it.

**Negative control:** the same handler where `workspaceId` is resolved through
`resolveWorkspaceAccessByOid` and a denial returns the 404 shape **before** the
query. `excludedByAccess` may then be returned freely: the caller can only
narrow to scopes they already own. This control is essential — it proves the
detector keys on *scope provenance*, not on the presence of a number.

---

## 4. C3 — The discarded verdict (authorization is the CALLER's line)

The class that most sharply refines the thesis.

### 4.1 Graph shape

Every returned-value guard in this console has the contract
`Promise<NextResponse | null>` — `null` means allowed.
`apps/fiab-console/lib/auth/feature-gate.ts:185`:

```ts
export async function enforceCapability(
  session: SessionPayload | null,
  capabilityId: string,
  requiredRole: FeatureRole = 'Reader',
): Promise<NextResponse | null> {
```

So the *authorization edge is not the call*. The call produces a value; the edge
is `if (gate) return gate;` **in the caller**. Delete that one line and the graph
still contains: the import, the call, the guard's full correct implementation —
and no authorization.

In provenance terms: the `imports` edge and the `declared` call both survive; the
`observed` enforcement does not. **A detector operating on `declared` +
`imports` cannot see this class at all.**

### 4.2 Real instance

`scripts/ci/check-route-guards.mjs:24-36` records it:

> On 2026-08-07 `if (gate) return gate;` was deleted from
> `app/api/setup/deploy/route.ts` — the route that submits SUBSCRIPTION-SCOPED
> ARM deployments — leaving the `enforceCapability` call in place. Measured:
> this checker printed `violations: 0`; so did check-route-toolkit and
> check-credential-route-authz. Authorization was fully defeated and every
> merge-blocking control in the repo was green.

Three independent merge-blocking controls, all green, over a fully defeated
authorization on a subscription-scoped ARM deploy path. Seven symbols share the
contract and are now covered: `enforceCapability`, `requireTenantAdmin`,
`denyIfNoDlzAccess`, `pdpCheck`, `authorizeItemWorkspace`, `authorizeWorkspace`,
`requireWorkspace`.

The precursor is the same class with a comment: #2977, where `assertOwner`
survived only as a word in a comment. And its sibling, `check-route-guards.mjs:56-63`
— *"AN IMPORT IS NOT A USE"* — where every guard **call** in
`items/activator/[id]/route.ts` was replaced with an unscoped equivalent and the
only guard-signal occurrences left were two `import` lines. `violations: 0`.

### 4.3 Detector query

> For every call to a symbol whose declared return type is `NextResponse | null`
> (or the project's equivalent verdict union), require the returned value to be
> **consumed in a decision position** — bound to an identifier that is then
> tested, or tested inline — on **every** control-flow path that reaches a
> privileged sink. Run this over the *whole* population including allowlisted
> routes: "this route needs no per-resource authorization" never licenses
> "call a gate and throw its answer away".

That last sentence is quoted from `check-route-guards.mjs:29-31` and is the
non-obvious part of the design.

### 4.4 The NARROW bypass

**(a) Consume the verdict on one branch.** `if (gate && req.method !== 'GET') return gate;`
— consumption is real, the value is tested, a decision is taken. GET is
unauthorized. A consumption checker that asks "is the value tested?" passes.
The requirement must be *every path to the sink*, not *some path*.

**(b) Consume it into a dead store.** `const gate = await enforceCapability(...); if (gate) log(gate);`
— tested, consumed, and never returned.

**(c) Satisfy the presence signal with an audit field.** The measured case, from
`check-route-guards.mjs:96-108`: a bare `claims.oid` proves the token is
*present* in the handler, not that it *authorizes*. `items/dashboard/[id]` PUT
passed on `sanitizeOverlay(id, body, session.claims.upn || session.claims.oid)`
— the overlay's `savedBy` **attribution** — while overwriting any tenant's
overlay by id. `databricks-notebook/[id]/versions` POST passed on
`savedBy: session.claims.oid` for the same reason. Both are fixed; the signal
remains weak by construction. Removing bare `claims.*` from the signal set was
measured on 2026-08-08: **0 violations → 205**.

The same class at the reporting layer: commit `72fb01afd` —
*"the route inventory called a LOG FIELD an authorization check — 271 of 773
owner-scoped rows"* (#3625).

**Design rule extracted:** a signal that a *token* is present is not a signal
that a *decision* was made. This repo has paid for that confusion at least four
times — twice in routes, once in the inventory, once in the guard's own signal
set.

### 4.5 Regression fixtures

**Positive:** a route that calls `enforceCapability` and never tests the result.
Must fire.

**Positive (narrow):** a route that returns the gate only when
`req.method !== 'GET'`. Must fire. A naive consumption checker passes this.

**Positive (attribution):** a route whose only `claims.oid` occurrence is inside
a `savedBy:` field on a write that takes its target from `[id]`. Must fire.

**Negative control:** a route that legitimately needs no per-resource
authorization — a static capability catalogue read — which calls no guard at
all. Must NOT fire. Distinguishing this from C3 requires knowing the sink is not
privileged, which is a `declared` property of the sink and must be maintained
explicitly, not inferred.

---

## 5. C4 — The unbounded publication edge (a public repo has FOUR surfaces, and one has no `write()`)

### 5.1 Graph shape

```
node  identifier        provenance: observed  (an ARM leaf's resourceName)
node  public-surface    provenance: declared  (issue body, issue TITLE,
                                               annotation, raw stderr, artifact)
edge  identifier -> surface   PUBLICATION — must pass a redaction boundary
```

Two things make this class hard. First, the surfaces are **five distinct sinks**
that look like one. Second, one of them has **no source-level edge**.

### 5.2 Real instance

#3829 was filed against ONE leak: `decision.reason` reaching a public issue body
unredacted from `scripts/ci/deploy-retry.mjs`. Each round of fixing it found the
population larger than the round before. Three GUID-carrying fields
(`whyStopped`, `leafClasses[].resourceName`, `armDrilldown.leaves[].resourceName`),
all fed by an ARM leaf's `resourceName`, reaching:

1. the auto-issue-poster → a public issue **body** … **and the TITLE**, built
   separately by `buildIssueTitle` and not covered by the body fix;
2. `ghAnnotate(...)` → Actions annotations;
3. **raw `process.stderr`** → in an Actions `run:` step this *is* the public run
   log, and it is a **different path** from `ghAnnotate`. Guarding the annotation
   does not cover it. `deploy-retry.mjs` runs from 10 workflows, including all
   four Gov/GCC/GCCH/IL5 lanes;
4. the `deploy-failure.json` artifact write.

Fixed by `afcf3e6b` — *"redact at the issue-poster boundary, not field by
field"* (#3829, PR #3835). The shared boundary now lives at
`scripts/ci/_azure-redact.mjs`, whose header records that it is
**size-independent by contract**: `if (text.length > 20000) return text;` left
all three suites GREEN at 90/90, and a 60-leaf `renderLeaves()` dump measures
24,419 bytes — so a length cap is a reachable leak, not a theoretical one.

### 5.3 The fifth surface has no `write()` — the inherited fd

`scripts/ci/deploy-retry.mjs:800`:

```js
stdio: ['inherit', 'inherit', 'pipe'],
```

This hands the child **the parent's stdout file descriptor**. The child's bytes
land on the public Actions run log with **no `write` call anywhere in the
parent's source**. Every assertion of the shape *"grep the source for
`process.stdout.write` and prove each one goes through the boundary"* is
therefore **structurally blind** to it.

PR #3835 went four rounds hardening publication surfaces and none of them could
have seen this one; it was found only when a fifth pass enumerated `stdio:`
spawn configs instead of write calls. The known open gap is
`scripts/csa-loom/converge-role-assignment.mjs`, which reaches the log this way
with a raw `e.message` on its parse-error branch — issue **#3861** (OPEN,
labelled `security`), confirmed open this session.

Measured population of inherited-stream spawns on this tree:
`assert-no-silent-image-tag-revert.mjs:389`, `check-standalone-vitest-suites.mjs:191`,
`deploy-retry.mjs:529` and `:800`, `scripts/csa-loom/parity-autopilot.mjs:133`.

### 5.4 Detector query

> Enumerate publication sinks **structurally**, not lexically. The set is at
> minimum: `process.stdout.write`, `process.stderr.write`, `console.*`,
> `::error::` / `::warning::` / `::notice::` annotations, issue **bodies** AND
> issue **TITLES**, artifact writes, `GITHUB_STEP_SUMMARY` / `GITHUB_OUTPUT` /
> `GITHUB_ENV`, and **every `stdio:` spawn config that names `inherit` on fd 1
> or 2**. For each, require the emitted expression to be *wholly* produced by a
> boundary function or explicitly marked `unredactedByDesign()`. **Count** the
> enumerated sinks and assert the count, so a new one cannot appear silently.

### 5.5 The NARROW bypass — four of them, already measured

Issue **#3876** (OPEN) records four measured bypasses of the checker #3835
added, with a discriminating probe (3 positive controls fire, 2 negative
controls stay clean). The enumerator at
`scripts/ci/__tests__/_publication-surfaces.mjs:147` matches only the literal
member expression, and the classifier at `:173-174` is prefix-only:

```js
return streamWrites(src).filter((w) => !allowed.some((fn) => w.arg.startsWith(`${fn}(`)));
```

| # | Shape | Why it slips |
|---|---|---|
| 1 | `process.stdout.write(formatStdout(a) + raw)` | argument *starts with* an allowed boundary call; `raw` is never examined |
| 2 | `const out = process.stdout; out.write(raw)` | alias — enumerator counts **0** writes |
| 3 | `const { stdout } = process; stdout.write(raw)` | destructuring — same |
| 4 | bracket access — `process['stdout'].write(raw)` | same |

Three of the four are **zero-population** bypasses: the checker reports clean not
because the write is safe but because it counted no writes at all. That is the
signature to look for, and it generalises: *a detector whose population can be
driven to zero by renaming is not a detector.*

A fifth, orthogonal bypass is documented in `_azure-redact.mjs`'s header: the
GUID boundary was originally `\b`, and `_` is a word character, so `admin_<guid>`
leaked — and `<name>_<guid>` is exactly the shape of ARM deployment names this
repo generates. Undashed 32-hex remains deliberately uncovered (it would collide
with MD5 and short-hash strings). That residual is disclosed, not closed.

### 5.6 Regression fixtures

**Positive:** `process.stderr.write(\`deploy: ${id}\n\`)` in a script that posts
to a public surface. Must fire.

**Positive (alias):** `const out = process.stdout; out.write(raw)`. Must fire —
this is bypass #2 and the current checker reports 0 writes.

**Positive (inherited fd):** a `spawn(..., { stdio: ['inherit','inherit','pipe'] })`
whose child is not itself proven to redact. Must fire with **no `write` in the
file**.

**Negative control:** `process.stdout.write(formatStdout(t))` — wholly bounded.
Must NOT fire.

**Negative control (disclosed exception):** `process.stdout.write(unredactedByDesign(c))`.
Must NOT fire.

**Anti-fixture, stated because this repo tripped on it:** do **not** key a
non-degeneracy control to the leaked value itself. A test asserting *"the raw
stderr MUST still carry the id, or this test proves nothing"* turns *closing the
leak* into a test failure. Key such controls to a non-secret token.

---

## 6. C5 — Fail-open: UNKNOWN reported as a definite answer

### 6.1 Graph shape

An authorization or verification edge has three possible verdicts — ALLOW, DENY,
**UNKNOWN** — and the code models two. UNKNOWN collapses into whichever of the
other two is the code's default, and in every instance below the default was the
permissive one.

### 6.2 Real instances

**(a) Fail-open on a Graph 2xx — FIXED, kept because the shape is the lesson.**
Until `bfd67ed1` (#3859, the first half of issue **#3834**),
`workspace-guard.ts` disclosed this as a live residual:

> `graphUserInGroup` reads a BARE `res.ok` as membership without inspecting the
> body, so any 2xx from something sitting in front of Graph (a proxy, a WAF, a
> captive portal, a wrong-national-cloud host) GRANTS the group's role and
> silently defeats the `tenant_unconfirmed` refusal this function exists to
> produce.

The point-read now requires the returned directoryObject to identify the
principal that was asked about; anything else is `'unknown'`, which contributes
no role. The remainder of #3834 closed the walk's other non-answers — an
enumeration transport failure resolves `'unknown'` instead of throwing out of
the authorization boundary, a 429 aborts instead of falling through into a
second throttled call, and the sequential group loop runs under one walk-wide
clock (`LOOM_GRAPH_GROUP_WALK_BUDGET_MS`, defaulting to the single-request
ceiling).

#3834's title stated it precisely: *fail-OPEN in 2 of 9 measured Graph failure
modes*. Note the shape — the other 7 modes answered `'unknown'` and refused
correctly. **The class is not "this code fails open"; it is "this code's UNKNOWN
handling is non-uniform across 9 paths and 2 of them invert."** The instance is
written in the past tense rather than deleted, for the reason §6.4 gives below:
adopting a fix must not remove the evidence that the fix was needed, and
restating a closed finding as live would itself be a C5.

**(b) Fail-open at the shell.** `deploy-integrity.md` R7 exists because of a
measured incident: a `2>/dev/null` converted a permission denial into an empty
string, and the empty string into the claim *"the tag does not exist"*. That
message sent two separate investigations down the wrong path. The repo now
carries guards against the family — `assert-no-silent-image-tag-revert.mjs:295`
records *"turning a permission denial into 'nothing to adopt'"*, and
`check-cross-cloud-drift.mjs:71` records that git's stderr is *captured and
REPORTED rather than swallowed*.

**(c) Fail-open in the UI.** `scripts/ci/check-empty-claim-read-evidence.mjs`
(#3281) generalises it: *"if the render path that emits 'there is nothing here'
is still reachable when the read FAILED, the surface asserts as fact something
it never established."* The live example was `app/catalog/domains`: an honest
"could not reach the route" banner rendered three DOM nodes above a grid
asserting "No business domains defined for this tenant yet."

### 6.3 Detector query

> For every edge that produces a verdict consumed by a security or truth claim,
> enumerate its failure modes and require each to map explicitly to DENY or to a
> distinguished UNKNOWN — never to fall through to the ALLOW/EMPTY default.
> Structurally: flag any `catch` whose handler does not `return`/`throw` a
> refusal; any `res.ok` consumed as a semantic answer without inspecting the
> body; any `2>/dev/null` or `|| true` on a command whose exit status feeds a
> claim; and any empty-state render path reachable when the read's error state
> is set.

That last clause is the one that resists regex, and
`check-empty-claim-read-evidence.mjs:30-35` records that widening by regex was
tried and failed — 161 candidates → 35 → 20 → 2, and both survivors were false
positives. *"Regex proximity cannot express **this failure feeds that claim**."*
The working design is a reachability question over the render graph, which is
the closest thing in this repo to a genuine vindication of the thesis.

### 6.4 The NARROW bypass

**Key the guard to the UNSAFE spelling.** This repo names the trap explicitly
(`check-empty-claim-read-evidence.mjs:36-38`): a token rule keyed to the unsafe
pattern *goes quiet on exactly the files that adopt the fix*. Adoption removes
the file from the population, so coverage and compliance become
indistinguishable, and a file that never had the pattern is scored identical to
one that fixed it.

The correct construction is stated in the same header and is the single most
transferable idea in it:

> **POPULATION MEMBERSHIP IS INDEPENDENT OF THE FIX.** A component is judged
> because it (a) performs a client read and (b) renders an EmptyState-family
> claim. Adopting the fix removes NEITHER.

Second bypass: **narrow the failure mode.** Handle 7 of 9 modes correctly and
leave 2 inverted (#3834 exactly). A detector that samples one failure path — or
that asserts "there is a catch" — passes.

Third: **`bash -e` truncation.** A guard script that aborts early leaves later
guards unrun while the harness reports success; this repo has a memory for it
(`guardrails bash -e aborts later guards`). The *absence* of a verdict reads as
the absence of a finding. I did not re-measure this one; **UNCONFIRMED on this
tree.**

### 6.5 Regression fixtures

**Positive:** a membership probe returning `res.ok` as the answer. Must fire.

**Positive (narrow):** a probe handling 7 named failure modes with explicit
refusals and letting a 2xx-from-a-proxy through. Must fire — one uninverted
sample is not coverage.

**Negative control:** a probe that returns a distinguished `'unknown'` and whose
caller maps `'unknown'` to refusal. Must NOT fire.

**Negative control (population integrity):** a component that performs a client
read and renders an empty state **and has adopted the fix**. Must remain **in
the judged population** with a clean verdict. If adopting the fix removes it
from the population, the detector is keyed to the unsafe pattern and is invalid.

---

## 7. C6 — Credential forwarded to an unbounded sink (NEW — not in the commissioned list)

### 7.1 Why it is a distinct class

Every class above concerns an edge that exists in the graph and is mis-predicated.
This one concerns an edge whose **sink node is chosen at runtime by a remote
party**. There is no node to reason about statically.

### 7.2 Real instance

Issue **#3717** (OPEN, `sprint:active`): *six credential-bearing
`urllib.request.urlopen` sites follow cross-origin redirects with `Authorization`
attached.* All call through Python's **default global opener**, which:

- installs `FTPHandler`, `FileHandler` and `DataHandler` — **no proxy variable
  required**;
- permits a redirect to `('http','https','ftp','')`;
- copies **every** header except `content-length`/`content-type` onto the
  redirected request. `urllib` does **not** strip `Authorization` across a host
  change the way `requests` does.

So a hostile or compromised upstream answering `302` hands the caller's bearer
token to whatever host `Location:` names. The sites named in the issue:
`cli/client.py:77`, `azure-functions/copilot-chat/content_safety.py:85`,
`apps/loom-migrate/app/connectors.py:95` and `:117`,
`apps/fiab-console/lib/notebook/loom-semantic-link.py:63` (which carries
`Authorization` **and** a `loom_session` cookie — both copied), and
`scripts/csa-loom/loom-unity-migrate-catalog.py:101`.

The issue also records a correction to its own original framing, which is
instructive: it was opened naming **one** file and only the `ftp:` variant, gated
on a proxy variable. Both were wrong, and the corrected version is *worse* — six
sites, no proxy variable needed, and the plain `http:` cross-host redirect (not
`ftp:`) is the variant that matters. **I did not independently re-verify the six
file:line citations; they are the issue's measurement, not mine — UNCONFIRMED by
me.**

### 7.3 Graph shape, detector, bypass, fixtures

```
node  credential   provenance: configured  (a bearer token / session cookie)
node  request      provenance: declared
node  sink         provenance: NONE — chosen by the remote at runtime
edge  credential -> sink   EGRESS with no static target
```

**Detector:** for every outbound HTTP call that attaches a credential header,
require either (a) redirects disabled, or (b) an explicit same-origin check on
the redirect target before the credential is re-attached, or (c) an opener/
session whose handler set is restricted to `https` and which strips
`Authorization` on host change. Flag any use of a language's *default* opener/
client where the default is header-preserving — the defect is in the default, so
the absence of configuration is the finding.

**The NARROW bypass:** fix the scheme, not the origin. #3717 is the bypass
already in the record — the first fix addressed `ftp:` only, and a plain `http:`
cross-host redirect walks straight through it. Any detector keyed to a *scheme
allowlist* rather than to *origin comparison* is defeated by one character's
difference. A second: fix the six named sites and leave the default opener
installed, so site seven inherits the defect on creation.

**Fixtures.** *Positive:* a call attaching `Authorization` through a default
opener with redirects enabled. Must fire. *Positive (narrow):* the same call
after an ftp-only fix — must still fire on the `http:` cross-host path.
*Negative:* a call with `allow_redirects=False`, or one using a session that
strips `Authorization` on host change. Must NOT fire.

---

## 8. C7 — The synthesized principal (NEW — not in the commissioned list)

### 8.1 Why it is distinct

C1 is "the wrong principal was authorized". This is "**no principal existed and
one was invented**". The identity node's provenance is neither `observed` nor
`configured` — it is a literal, and it is well-formed, so every downstream check
that validates *shape* passes.

### 8.2 Real instances

Issue **#3818** (OPEN) states the mechanism, and the key sentence explains why
this matters more here than in most codebases:

> In this codebase the caller's `oid` is a **Cosmos partition key** — a
> tenant/resource boundary. A placeholder oid writes into a partition no real
> user occupies, which is how a green run can measure nothing (#3804).

That is the connective tissue to C1: `Workspace.tenantId` stores the creator's
oid and is the partition key (`workspace-guard.ts:109-112`). So a synthesized oid
does not merely mis-attribute — it **creates a shadow tenant**.

Issue **#3804** (OPEN) is the consequence: *"Eight UAT harnesses mint a LIVE
session as an all-zeros principal when the identity env var is unset — it already
orphaned 24 workspaces."*

#3818 also names the structural problem: the placeholder-oid check exists in
**eight independent copies and exactly one is under test**, so the class is open
even though the instances were closed. And it names two live bypasses:

1. `.github/workflows/perf-gate.yml:135` guards with `[[ -z "${LOOM_AUTOMATION_OID:-}" ]]`
   — which catches **absence only**. An explicitly-set all-zeros value passes and
   mints at `:145`.
2. `apps/fiab-console/tests/e2e/_shared.ts:80-85` — `signIn()` prefers a cached
   storage artifact and returns **without ever calling `mintSessionCookie()`**,
   so a cookie minted under the zero GUID before the fix is still loaded after it.

These are the issue's measurements; I read the issue but did **not** re-open
those two files — **UNCONFIRMED by me.**

One measured negative worth recording so it is not re-investigated: the
nil-GUID fail-open scan came back **clean**, and the bare `…000000000002`
constant that shows up in that grep is the Cosmos Data Contributor **role id**,
not an identity.

### 8.3 Detector, bypass, fixtures

**Detector:** treat every principal-shaped value reaching a partition key,
tenant scope, or authorization input as requiring `observed` provenance. Flag any
path where such a value can originate from a literal, a default, an unset
environment variable, or a **cached artifact** that bypasses the minting
function. The guard must assert on the **value**, not merely on presence.

**The NARROW bypass** is the one #3818 already measured: guard emptiness rather
than validity (`-z` passes an explicitly-set placeholder), and reach the sink by
a **cached path** that never calls the guarded minter at all. A third, implied by
"eight independent copies, one under test": fix the copy under test.

**Fixtures.** *Positive:* `LOOM_AUTOMATION_OID` explicitly set to an all-zeros
GUID; the minter must refuse. *Positive (cache path):* a pre-existing storage
artifact carrying a zero-oid cookie; `signIn()` must refuse it. *Negative:* a
real oid from a live token — must mint. *Population control:* the fixture suite
must exercise **all eight** copies of the check, and the detector must report the
count, because seven untested copies is the actual defect.

---

## 9. C8 — Injection into a human-executed command (NEW — a sink that is not a machine)

Issue **#3610** (OPEN). `apps/fiab-console/app/api/setup/identity/route.ts` builds
a `bootstrapScript` string returned in the response body, wrapping
caller-supplied values in single quotes with **no escaping of an embedded quote**
— `:124` (`existingClientId`), `:137` (`consoleHosts`), `:139`
(`existingClientId`). Neither field is validated: `consoleHosts` is only
`.trim()`ed and `existingClientId` is never checked to be a GUID. (Issue's
measurement; **UNCONFIRMED by me** — I read the issue, not the route.)

The route does **not** execute the string. That is exactly what makes it a
distinct class: the sink is the **operator's terminal**, and the emitted command
already carries `KEYVAULT_NAME`, `CONSOLE_RG` and runs a privileged bootstrap
script. Standard taint analysis terminates at "no `exec` on this path" and
reports clean. The privileged execution happens off-graph, performed by a human
who has every reason to trust the product's own output.

#3610 also notes the route authorizes on a bare `getSession()` with no capability
gate — it is one of the routes whose clean `check-route-guards` verdict rests on
the `app/api/setup/` allowlist class, which #3607 (OPEN) records is *never
premise-tested*. So C8 and C1 compound here.

**Detector:** treat any response field whose *name or content shape* is a shell
command, connection string, or copy-paste remediation as a privileged sink, and
require every interpolated value to be allowlisted or escaped. **The NARROW
bypass:** escape the value in the field the detector knows about and add a second
emitter — this is #3602's history exactly, where `remediation.commands` in
`wire-existing` was allowlisted and `bootstrapScript` in a sibling route was not.
**Fixtures:** *positive*, a value containing `'` reaching an emitted command
unescaped; *negative*, the same value passed through the `wire-existing`
allowlist; *negative control*, a genuinely static command string with no
interpolation, which must not fire.

---

## 10. C9 — The duplicated decision (the class that is not a path at all)

This class is listed last because it is the hinge for §11.

### 10.1 What it is

Not a missing edge. **N implementations of the same predicate on parallel edges,
which drift.** `workspace-guard.ts:19-53` is unusually honest about it, and the
header explains why the honesty is the point:

> #3825 — `resolveWorkspaceAccessByOid` IS THE CANONICAL IMPLEMENTATION … Do not
> re-add a tenant-admin short-circuit here, in any form.
>
> THAT IS NOT THE SAME AS "there is exactly one implementation", which is what
> this header used to claim and what an independent review counted wrong on
> 2026-08-21. **Six places in the console still answer some form of the
> question**; naming them is the point, because a header that overstates the
> invariant is worse than no header — the next reader stops looking.

The six, as enumerated there: `resolveWorkspaceAccessByOid` (canonical);
`listAccessibleWorkspaces` (the LIST shape, its own `doc.tid !== callerTid`
filter in the same file); `resolveWorkspaceRole` / `findWorkspace` (an older
independent lookup — **#3840**, also the cause of #3751);
`resolveItemAccessByOid` (a second grant with its own boundary);
`resolveAdminWorkspace`'s owner fast-path; and `authorizeItemWorkspace`'s
`if (!workspaceId) return null`.

Measured live this session, the guard reports the same thing from the other
direction:

```
[tid-boundary-chokepoint] tenant comparisons found by NAME outside the
  chokepoint: 11 in 3 file(s), all pinned (#3843)
  — lib/auth/item-access.ts:177, lib/auth/tenant-boundary.ts:84 (x2), :85, :103,
    :117, :119, :120, lib/auth/workspace-access.ts:335, :358, :490
```

Eleven comparisons, three files, all pinned. And the open issues confirm the
drift is not theoretical: **#3843** (`items/by-type` re-derives the boundary in
the *pre-#3824* shape — a tid-less session enumerates every tenant's items),
**#3826** (three more admin paths carry the same tid fall-through, one a
write-side escalation *around* the #3824 fix), **#3840** (a fourth independent
copy). #3818 reports the identical structure for the placeholder-oid check:
**eight independent copies, one under test.**

### 10.2 Why this is not reachability

Every one of those eleven comparisons **is** an authorization edge. Every path
through them has one. The reachability query returns clean — correctly. The
defect is a property of the **set**: two edges that should be the same predicate
and are not, where one was repaired and the others were not.

`workspace-guard.ts:75-81` states the causal claim directly: *"Copies of this
decision are how #3823 and #3825 both happened."*

**Detector (not a path query):** cluster all implementations of a security
predicate by the `owns` relation they compare, then assert (a) the cluster size
against a declared expected count, and (b) semantic equivalence across the
cluster — at minimum, that each member's truth table over
`{callerTid present/absent} × {docTid present/absent} × {equal/unequal}` is
identical. A member that answers ALLOW where the canonical answers DENY on any
row is the finding. The guard's section 9 is the weaker, cheaper form of this
(assert the derived authorizer list has not silently shrunk), and it exists
because *"every finding of the round-5 review showed up first as that list
quietly getting shorter while the guard printed OK."*

**The NARROW bypass:** add copy N+1 in a file the clustering does not scan.
`check-guard-logical-lines.mjs` has the mirror-image problem, recorded in
**#3438** (OPEN): it *"scans only `check-*.mjs` — a guard that factors its
scanner into a `_`-module is invisible to it."* Same evasion, one level up.
A second: keep the truth tables identical and let the *inputs* differ — #3843's
shape, where the comparison is right and the tid it reads is derived differently.

**Fixtures.** *Positive:* a second file comparing `doc.tid !== callerTid` (the
non-contradiction form) while the canonical uses the positive form. Must fire on
the truth-table row `{callerTid absent}`. *Negative:* two files whose truth
tables match exactly — must NOT fire merely for being duplicates, because
duplication with equivalence is a maintainability issue, not a security one, and
a detector that conflates them will be turned off.

---

## 11. Where the reachability thesis breaks down

The thesis is **substantially right and materially incomplete**. Stated as
precisely as the evidence supports:

### 11.1 It holds, cleanly, for C1, C2, C6 and C8

These are genuinely "an inbound edge that should not exist". C1 is the paradigm
case, and the repo's best detector (`check-tid-boundary-chokepoint.mjs` §8) is
recognisably a path-and-predicate analysis: it derives the authorizer set, then
proves each ALLOW is *implied by* a delegated verdict. C2 is the same query with
the disclosure edge widened to include aggregates. C6 and C8 are reachability
with an unusual sink — a runtime-chosen host, a human's terminal — and both are
expressible once you accept that the sink node is not in the source.

### 11.2 It requires a redefinition of "edge" to survive C3

An authorization edge in this codebase **is not a call**. The seven guards return
`NextResponse | null`; the edge is `if (gate) return gate;` in the *caller*.
Delete that line and the `declared` call, the `imports` edge, and the guard's
entire correct implementation all remain — while authorization is fully defeated.
Measured on 2026-08-07 against a subscription-scoped ARM deploy path, with
**three merge-blocking controls green**.

So: a graph whose edges are calls or imports is **blind to C3 by construction**.
The thesis survives only if an edge is defined as *a verdict consumed in a
decision position on every path to the sink* — which means the substrate must
carry data-flow and control-flow, not just a call graph. That is a much larger
engineering commitment than "same graph, opposite question", and it should be
stated up front rather than discovered.

### 11.3 It does not describe C5 at all

C5 is not about which edges exist. It is about whether a **single** edge's
verdict space is complete. `graphUserInGroup` has an authorization edge; it is on
the path; it is consumed. It answers ALLOW on 2 of 9 failure modes (#3834). No
reachability query over any edge set detects that, because the edge is present
and consumed and the path is guarded. The property is *"the verdict function is
total and fails closed"* — a property **of a node's implementation**, not of the
graph's shape.

Same for `2>/dev/null` (R7) and for the empty-state class. The best guard the
repo has here (`check-empty-claim-read-evidence.mjs`) does describe itself as
reachability — *"if the render path that emits 'there is nothing here' is still
reachable when the read FAILED"* — but note what it is reachability **over**: the
render graph under an *error precondition*. That is model checking a state
predicate, not finding an unguarded path. It is a different engine.

### 11.4 It does not describe C9 at all, and C9 is the repo's most productive class

C9 has **no missing edge**. Eleven tenant comparisons across three files, all
pinned, all present, all on-path. The reachability query returns clean and is
right to. The defect is that two of them disagree, and one was repaired while the
others were not — which is how #3823 and #3825 *both* happened, per the guard's
own causal claim.

This is a property of a **set of nodes**, not of a path. The detector is
clustering plus differential semantics, not traversal. And it is the class with
the most open issues attached to it right now: #3826, #3840, #3843, #3818, #3877,
and arguably #3438.

### 11.5 The failure mode the thesis cannot see at all: the detector's own population

Everything above assumes the detector runs over the right set. This repo's
dominant, measured, repeatedly-successful evasion is **not** to add an
unguarded edge — it is to **fall outside the population being examined**, and it
is invisible in every artifact except a population count:

- `check-tid-boundary-chokepoint.mjs` — **15 candidates, 1 judged**, RC=0, with a
  live shape-1 defect in the tree. Measured this session. The discriminant is a
  regex on parameter *names* (`:2662`).
- `_publication-surfaces.mjs` — 3 of 4 measured bypasses (#3876) drive the write
  count to **zero** by aliasing, destructuring, or bracket access.
- `check-route-guards.mjs` — measured 2026-08-08: **119 route files with a data
  surface are outside the remit**, and a previous revision of its own header
  asserted the number was one. The header records the correction rather than
  quietly fixing it, *"because a false invariant in a security control's own
  documentation is how the next reader gets misled."*
- `check-guard-logical-lines.mjs` — scans only `check-*.mjs` (#3438).
- Placeholder-oid — 8 copies, 1 under test (#3818).
- `check-route-guards.mjs` CHECK 3 exists because allowlist entries were **never
  premise-tested**; #3607 records the same gap is still open for
  `ALLOWLIST_PREFIXES`, load-bearing for 12 routes; #3580 is a 26th instance of
  the same GHSA class.

No inverted edge predicate finds any of these, because the query never ran on
them. **The single highest-value thing Loom Brain can do is not the inverted
reachability query — it is to make every detector emit `judged / candidates` and
treat a shrinking `judged` as a P0 signal.** That is cheap, it is
class-independent, and on the evidence above it would have caught more real
defects in this repo than the query itself.

### 11.6 One thing the thesis gets exactly right, and it is worth keeping

The symmetry claim — waste is a node with no inbound edge, a vulnerability is an
inbound edge that should not exist — **does** hold for the largest single class
(C1), and it buys something real: the two questions share a substrate, so
building the `owns` relation once serves both. The correction is not to abandon
it. It is to state that the substrate needs **three** things the waste query does
not:

1. **data-flow**, so a consumed verdict is distinguishable from a call (C3);
2. **per-node verdict totality**, so an edge that answers ALLOW on failure is a
   finding (C5);
3. **cross-node differential semantics**, so N implementations of one predicate
   can be compared (C9).

And it needs one thing no query provides: **an asserted population**.

---

## 12. Summary table

| Class | Thesis fit | Live instance (measured this session unless noted) |
|---|---|---|
| C1 unauthorized inbound edge | **holds** | `security-roles/route.ts:85` (#3855), `folders/route.ts:36` (#3891) |
| C2 aggregate oracle | **holds** | instance closed; provenance UNCONFIRMED. Precedent `route-toolkit.ts:113` |
| C3 discarded verdict | holds only if edge ≡ consumed verdict | `setup/deploy/route.ts`, 2026-08-07, 3 controls green |
| C4 unbounded publication | holds; sink set is non-obvious | `deploy-retry.mjs:800`; #3861 open; 4 bypasses in #3876 |
| C5 fail-open / UNKNOWN | **does not hold** | #3834 (2 of 9 Graph modes), R7 `2>/dev/null` |
| C6 credential → unbounded sink | holds, sink is runtime-chosen | #3717, 6 sites (issue's measurement) |
| C7 synthesized principal | partial — provenance, not path | #3804, #3818 (issue's measurement) |
| C8 human-executed command | holds, sink is off-graph | #3610 (issue's measurement) |
| C9 duplicated decision | **does not hold** | 11 comparisons / 3 files, live guard output; #3826, #3840, #3843 |

---

## 13. Sources

Code read this session (all paths repo-relative):
`apps/fiab-console/lib/auth/workspace-guard.ts` (full, 531 lines),
`apps/fiab-console/lib/auth/workspace-access.ts` (scanned),
`apps/fiab-console/lib/auth/feature-gate.ts:150-218`,
`apps/fiab-console/lib/api/route-toolkit.ts:105-125`,
`apps/fiab-console/app/api/items/[type]/[id]/security-roles/route.ts:70-100`,
`apps/fiab-console/app/api/workspaces/[id]/folders/route.ts:20-60`,
`apps/fiab-console/app/api/workspaces/bulk-delete/route.ts:10-50`,
`scripts/ci/check-route-guards.mjs:1-120`,
`scripts/ci/check-tid-boundary-chokepoint.mjs:1-70` and `:2655-2700`,
`scripts/ci/check-empty-claim-read-evidence.mjs:1-45`,
`scripts/ci/_azure-redact.mjs:1-60`,
`scripts/ci/__tests__/_publication-surfaces.mjs` (scanned),
`PRPs/active/omnibus-2026-08-22/L1-security-authz.md` (full).

Commands run: the `grep` population counts in §2.2, and one live guard execution
(`node scripts/ci/check-tid-boundary-chokepoint.mjs`, RC=0) quoted in §2.4(c)
and §10.1.

Issues read: #3891, #3876, #3855, #3843, #3833, #3818, #3717, #3610, #3861
(title/state only), #3580, #3607, #3438.

Commits identified by `gh search commits` (full history; the local clone is
shallow at 71 commits, so no local ancestry command was trusted): `bfd67ed1`
(#3859 positive tenant match), `afcf3e6b` (#3835 redact at the poster boundary),
`d4acf0618` (#3824), `51ac41841` (#3830), `72fb01afd` (#3643 log field as
authorization), `ad891448d` (#3664), `0351ca766` (#3674), `39970552c` (#3624),
`d4b761891` (#3648), `ca5d7049b` (#3655).
