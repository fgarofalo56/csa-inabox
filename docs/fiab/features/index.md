# Feature deep-dives

Per-**feature** guides for the capabilities that cut across item types — the
trust chain behind every Copilot answer, the open-lakehouse interop surface, the
migration on-ramp, the collaboration layer, and the operator-facing hubs.

These are different from the two neighbouring doc sets:

| Doc set | Answers |
|---|---|
| [Editor tutorials](../tutorials/README.md) (`editor-<slug>.md`) | "How do I use *this item type*?" |
| [Parity specs](../parity-matrix.md) (`docs/fiab/parity/`) | "Does Loom match the Azure / Fabric surface, control for control?" |
| **Feature deep-dives** (this set) | "What is *this capability*, why does it exist, how do I drive it end to end, and what happens when it is turned off?" |

Every page here follows the same shape: **what it is → why it exists → how to
use it end to end → the real backend → honest gates → the kill-switch flag id**.
Flag ids are the live ones registered in
`apps/fiab-console/lib/admin/runtime-flags.ts` and toggled from
**Admin → Runtime flags**; unless a page says otherwise a flag is **default ON**
(per the default-on / opt-out rule) and flipping it OFF is a seconds-fast revert
that needs no revision roll.

## Trusted answers (the trust chain)

Four features compose into one chain: a question is matched against a governed
contract, grounded on the graph, repaired if the generated query fails, and
finally handed back with a receipt an auditor can read.

- [Verified queries and the semantic contract](verified-queries.md) — refuse, don't guess.
- [GraphRAG grounding](graphrag-grounding.md) — multi-hop retrieval over the ontology you authored.
- [Self-healing NL2SQL](self-healing-nl2sql.md) — bounded repair plus a plausibility check.
- [Answer receipts](answer-receipts.md) — the compliance artifact under every answer.
- [Prompt registry and token budgets](prompt-registry-token-budgets.md) — LLMOps for the prompts and the spend.

## Open lakehouse and query surfaces

- [Iceberg REST catalog and Delta/Iceberg interop](iceberg-interop.md)
- [Arrow Flight SQL and ADBC connect](flight-sql-adbc.md)
- [Trino federation (opt-in)](trino-federation.md)
- [Streaming SQL on RisingWave](streaming-sql-risingwave.md)
- [PRQL modern-query mode (Preview)](prql-modern-query.md)

## Authoring surfaces

- [Mapping data flow Debug sessions](mapping-dataflow-debug.md)
- [Real-Time Dashboard pages, text tiles and drill-through](kql-dashboard-depth.md)
- [Canvas full-screen](canvas-fullscreen.md)
- [Collaborative presence and comments](collaboration-presence-comments.md)

## Platform and operations

- [Workspace portability (.loomws export / import / clone)](workspace-portability.md)
- [Column-level lineage and impact analysis](column-level-lineage.md)
- [Migration on-ramp: assess, copy in, translate](migration-on-ramp.md)
- [FinOps hub](finops-hub.md)
- [Dependency-chaos harness](dependency-chaos-harness.md)

## Reading a kill-switch

Every flag row on **Admin → Runtime flags** states, in operator terms, exactly
what flipping it OFF reverts. Three properties hold for all of them:

1. **Absence is ON.** A missing flag document (or an unreadable Cosmos) means
   enabled — a flag can never gate a surface by accident.
2. **OFF is a revert, not a delete.** Persisted data (receipts, contracts,
   Iceberg metadata, budgets, comments) survives a flip; only the surface or the
   code path changes.
3. **Every flip is audited.** The actor, the prior value and the new value land
   in `_auditLog` and fan out to the SIEM stream.

The two documented exceptions to default-ON are called out on their own pages:
[Trino federation](trino-federation.md) and the
[dependency-chaos harness](dependency-chaos-harness.md).
