# ADR-002 — Deterministic plan, reviewed apply, digest check, tracked rollback

**Status:** Proposed 2026-10-28; accepted when W2 ships.
**Mosaic lineage:** ADR 0010 (publishing), 0011 (governed access apply),
0017 (MCP fail-closed apply), 0024 (pool writes), 0028 (reviewed deployment).

## Context

Every gateway write the plane makes is destructive in some degree: it creates
or deletes APIs, products, subscriptions and policy fragments on a service
that may also carry customer-authored configuration. Loom's existing panes
write directly over ARM (`apim-client.ts` `upsertApi:279`, `upsertPolicy:799`),
which is right for an administrator editing one resource and wrong for a
plane composing eight.

## Decision

1. **Plan** is a pure function of desired state, the latest observed snapshot
   and the environment catalog. It yields ordered steps with semantic facets
   and a SHA-256 digest over facets + environment fingerprint + applied-state
   version. Planning writes nothing to Azure.
2. **Apply** takes a plan ID; it refuses when the gateway is in `observe`,
   when the digest recomputed at apply time differs (`409 stalePlan`), when no
   plan is given (`409 planRequired`), or when the gateway write lock is held
   by another run. It holds the lock for the whole run.
3. **Order**: named values → backends → backend pools → fragment → API →
   operations → API policy → product → product-API link → subscriptions/keys;
   deletes in reverse. Fragments reference backends, so backends come first
   (Mosaic shipped it the other way once and failed on a real gateway).
4. **Existence at write time**: each step re-reads; a resource the plan
   expected to create that now exists is refused, not overwritten.
5. **Long-running writes** (fragment PUT, API PUT/DELETE) are polled through
   `Azure-AsyncOperation` / `Location` to a terminal state; a step succeeds
   only then. A failed update leaves the previous content in place.
6. **Ownership** of created resources is merged across applies, never
   replaced; **rollback** deletes only what this run created and reports what
   remains; nothing reconciles orphans automatically.
7. **Unpublish** is a reviewed plan that lists every enabled grant that stops
   working; access is denied before the live API is deleted (MCP writes a
   deny policy first); `unpublishedAt` is recorded; the plane never
   automatically restores a previous allow policy after a failure.
8. **Recovery** of an interrupted run requires explicit confirmation that the
   worker has stopped; it re-establishes deny, marks the run failed and
   releases the lock.
9. **Drift** is detected on re-plan (existence) and from stored digests of
   the API policy and fragment (content); it is shown, never auto-repaired.
10. Diagnostics enablement on plane-published APIs and the budget named-value
    update are the only gateway writes outside a plan; both are audited and
    named in-product.

## Consequences

- Administrators publish without typing policy XML, and every change has a
  reviewable, replayable record.
- Publishes take longer (LRO polling) and read more.
- Partial rollback failures can leave orphans; the run result lists them.
- Customers who edit plane-owned resources out of band see drift on the next
  plan and must choose.

## Alternatives rejected

- Writing on save; inferring ownership from names (look-alike deletions);
  replacing ownership on each apply (disarms rollback); content-diffing every
  resource on every plan (expensive; digests suffice); automatic orphan
  reconciliation (not implemented by Mosaic either).

## Verification

Mutation receipts in `TEST-STRATEGY.md` § 1 for `plan`, `digest`, `apply`
re-read and `rollback` ownership; a live apply on the Commercial estate with
one deliberately pre-created product proving the refusal.
