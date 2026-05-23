# PRP-26 — Data Marketplace + catalog

> **Status: v2 backlog (stub).** No code work until v1 complete + v2 walkthrough.

## Context

Per the user 2026-05-23 walkthrough, CSA Loom needs a federated data
marketplace mirroring Fabric **OneLake Catalog** patterns:
internal-marketplace catalog of data products (tables, semantic
models, KQL DBs, API endpoints), subscription/access-request workflow,
usage metrics + lineage per product, cross-DLZ federation.

PRD ref: `docs/fiab/v2-scope-expansion.md` §1.

## Goal

`apps/fiab-marketplace/` + new Console "Marketplace" pane delivers a
self-service data product browser + subscriber workflow comparable
to Fabric OneLake Catalog, scoped across all DLZs in the deployment.

## Acceptance criteria

- [ ] Marketplace pane in Loom Console (9th pane)
- [ ] Cosmos DB collection `marketplace-products` (per-product metadata:
  name, description, owner, sensitivity, freshness SLO, source type,
  source endpoint, sample query, schema)
- [ ] Cosmos DB collection `marketplace-subscriptions` (per-user-per-
  product access requests + grants)
- [ ] Search/filter UI (by domain, by sensitivity, by source type)
- [ ] Subscription workflow: user requests → admin approves → RLS
  grant applied + notification email
- [ ] Usage metrics view (queries/day, top consumers, error rate)
- [ ] Lineage view (downstream consumers tree from Purview/Atlas)
- [ ] Bicep wiring: marketplace-products + marketplace-subscriptions
  added to `cosmos.bicep` DLZ databases list
- [ ] Bidirectional Purview sync: products registered in Purview as
  data products

## Per-boundary behavior

| Boundary | Notes |
|---|---|
| Commercial / GCC | Full feature set |
| GCC-High / IL5 | Purview-primary catalog (no UC managed); Atlas at IL5 |

## Risks

- **Cross-DLZ federation perf** — queries hitting marketplace catalog
  spanning multiple Cosmos accounts may be slow. Mitigation: cache
  marketplace metadata in Loom Console BFF.
- **RLS grant propagation** — granting access requires writing to
  Databricks UC / Purview / individual lakehouse ACLs. Mitigation:
  one-touch workflow runs Synapse + Databricks + storage RBAC API
  calls in parallel; rollback on partial failure.
- **Lineage scaling** — Purview queries for deep lineage trees are
  slow. Mitigation: paginate + cache.

## Sizing: L (8 weeks)

## Related

- v1 PRP-12 (catalog wiring) ships the Purview + Atlas plumbing
  this PRP builds on
- PRP-33 (domain mgmt) provides the domain taxonomy this marketplace
  filters by
- v1 audit: [PRP Delivery Audit](../../docs/fiab/prp-audit.md)
