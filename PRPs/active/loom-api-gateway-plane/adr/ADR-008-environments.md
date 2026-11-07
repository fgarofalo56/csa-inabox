# ADR-008 — Environments for gateways, endpoints and MCP servers, enforced by one `permits()` function

**Status:** Proposed 2026-10-28; accepted when W1 (catalog, classification) and W2 (plan enforcement) ship.
**Mosaic lineage:** ADR 0014 and its 2026-09-30 amendments.

## Context

A label nothing enforces is a comment. Loom's deployment pipelines carry
stages, but nothing today prevents a development Foundry account from being
published through the production gateway, and end users cannot tell a
development offering from a production one in the marketplace.

## Decision

1. One `environmentCatalog` per tenant, seeded with Development, Test, QC,
   Staging, Production, Sandbox (built-in, undeletable) plus Loom pipeline
   stage names not already present (D9). Each environment has an immutable
   key, display name, description, Fluent badge color, production-class flag,
   aliases (suggestions only) and exceptions (other environments whose
   resources its gateways may front; a production-class environment may list
   only production-class exceptions). An environment in use cannot be deleted.
2. Gateways, model endpoints and MCP endpoints carry one key or none
   (Unclassified). Derived records inherit: adopted APIs, adopted MCP servers
   and products take the gateway's; deployment grants take the endpoint's.
   Everything starts Unclassified.
3. `permits(gatewayEnv, resourceEnv, settings)` returns `allowed | warning |
   blocked` with plain-language wording; the console reads a compatibility
   matrix the API derives and never reimplements the rules. Production-class
   gateways never front non-production or unclassified resources (blocked);
   unclassified gateways never front production-class resources (blocked);
   other unclassified pairings warn, or block with **Require classification**;
   unknown keys block.
4. Invariant: re-classifying a resource, editing or deleting an environment,
   or turning on Require classification is refused if it would leave an
   applied publication (one that may own gateway state) blocked; the refusal
   lists them. Draft publications may be left behind and fail at plan time.
   Unpublish, rollback and recovery never check environments.
5. Mechanics: observation never overwrites classification (re-read, preserve
   authored fields, replace against the etag); lock order tenant environments
   scope → gateway scopes → endpoint scopes → publication locks, sorted by ID,
   as leases with expiry; apply holds its publication lock and re-checks the
   verdict; plan digests include a compatibility fingerprint (both keys,
   production flags, permitting exception, the setting, the verdict).
6. One route re-classifies a batch (a gateway and its endpoints move
   together), validates the final state, writes applied-linked resources in
   one transactional batch with an audit event per resource, and refuses
   batches too large for one Cosmos transaction.
7. Azure `environment` / `env` tags seen on ARM responses become one-click
   suggestions an administrator confirms; tags are never written back.
8. Advisory findings report blocked pairings that exist in APIM outside the
   plane's publications (backend or API URLs pointing at registered endpoints
   in incompatible environments; gateway MCP servers matching registered MCP
   endpoints); findings never block.
9. Moving a resource with enabled grants into or out of a production-class
   environment names the affected grants and principals and requires
   acknowledgement, recorded in the audit event. Access requests snapshot the
   environment; approval re-confirms if it changed.

## Consequences

- Safe upgrade: nothing is blocked on day one; existing pairings become
  warnings at most.
- Plans made before the catalog existed must be re-planned once.
- The plane does not relate the same model across environments; users
  request each environment separately (deferred "environment chains").

## Alternatives rejected

- Free-text labels (unenforced); a pool-specific environment label (drifts
  from the gateway's); auto-classifying from tags (a tag is a hint, not a
  decision).

## Verification

`permits()` mutation receipt (`TEST-STRATEGY.md` § 1); a G1 walk that tries
to publish a Development endpoint through a Production gateway and is refused
with the stated wording.
