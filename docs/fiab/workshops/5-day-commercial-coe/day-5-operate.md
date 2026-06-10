# Day 5 — Operate & Govern & Forward-Migrate (Commercial CoE)

**Track:** [5-Day Commercial CoE Workshop](index.md) · **Day 5 of 5** ·
Operate & Govern & Forward-Migrate

Day 5 operationalizes the deployment, runs a DR drill, and — the major
differentiator vs the Federal track — **forward-migrates live to Fabric
Commercial** (which is GA). It ends with the CoE charter and exec readout.

!!! info "Azure-native by default + live Fabric migration"
    Monitoring/cost run on Azure Monitor + Cost Management. Because Fabric
    Commercial is **GA**, forward migration is **demonstrated live** here, not
    planning-only. Loom itself still requires no Fabric to operate.

## Learning objectives

1. Operate Loom day-2: monitoring, alerting, multi-DLZ cost rollup.
2. Run a DR drill (simulated region failover); document RTO/RPO.
3. **Forward-migrate a workload live to Fabric Commercial.**
4. Finalize the CoE charter.
5. Deliver the exec readout.

## Facilitator guide

### Timing (8-hour day)

| Time | Activity | Mode |
|---|---|---|
| 09:00 | Day-4 recap + day-2 ops overview | Lecture |
| 09:30 | Monitoring Hub + diagnostics | Lab |
| 10:15 | Cost management — rollup + budgets | Lab |
| 10:45 | Break | — |
| 11:00 | DR drill — simulated region failover | Lab |
| 12:00 | Lunch | — |
| 13:00 | **Live forward migration to Fabric Commercial** | Lab |
| 14:30 | CoE charter finalization | Workshop |
| 15:00 | Break | — |
| 15:15 | Exec readout dry-run | Workshop |
| 16:00 | Exec readout to sponsor | Plenary |

### Talking points

- **Live forward migration (unique to Commercial):** unlike the Federal track
  (Fabric `Forecasted` → planning-only), commercial customers can run
  `fiab-migrate execute` against a **real Fabric Commercial workspace** today:
  create OneLake shortcuts to the existing Delta tables (zero data movement),
  port dbt + KQL unchanged, and re-author the semantic model for Direct Lake on
  OneLake. The customer leaves Day 5 with a working Fabric workspace **alongside**
  Loom.
- **Side-by-side:** run the same query in Loom (Azure-native) and Fabric
  Commercial and compare results — proves the 1:1 parity claim concretely.
- **DR:** document RTO/RPO; ADLS Delta + ADX redundancy are customer-owned.

### Exercises

1. Group executes the OneLake shortcut creation and verifies zero data movement.
2. Pairs run the Loom-vs-Fabric side-by-side query and reconcile row counts.

### Common pitfalls

- No Fabric Commercial capacity provisioned for the live migration → provision an
  F-SKU trial/capacity before Day 5, or fall back to the planning walkthrough.
- Assuming the migration moves data — it creates shortcuts; data stays in ADLS.

## Participant lab — operate + migrate live

1. **Monitoring.** In **Monitor** (`/monitor`), confirm diagnostics, open the KQL
   chart library, pin a health tile; resolve remaining gates.
2. **Cost.** Set a DLZ budget; confirm the cross-DLZ trend renders.
3. **DR drill.** Walk the region-failover runbook; record RTO/RPO.
4. **Forward migration (live).** Run `fiab-migrate execute` against the Fabric
   Commercial workspace: create OneLake shortcuts to `gold.*`, port dbt + KQL,
   re-author the semantic model for Direct Lake on OneLake. Verify the Fabric
   workspace shows the tables.
5. **Side-by-side.** Run the top-10 device query in Loom and in Fabric
   Commercial; reconcile.
6. **CoE charter.** Fill the [CoE charter template](../templates/coe-charter.md)
   and export.
7. **Readout.** Present outcomes to the exec sponsor.

**Validation (workshop done):** monitoring + cost operational, DR documented, a
workload live in Fabric Commercial via shortcuts with a reconciled side-by-side
query, CoE charter complete, exec readout delivered.

## Datasets

No new data — operates on Days 2-4 output.

## Post-workshop

- Complete the [post-workshop satisfaction survey](../templates/post-survey.md).

## Commercial-specific emphasis

- **Live Fabric Commercial migration** is the headline differentiator.
- **Direct Lake on OneLake** becomes available post-migration (native Fabric).
- **Vertical sign-off:** map the deployment to HIPAA/SOC 2/PCI/GDPR/FDA Part 11
  controls in the charter.

## Slide deck

`make loom-decks DECK=docs/fiab/workshops/5-day-commercial-coe/day-5-operate.md`.

## Related

- [← Day 4](day-4-bi-ai.md) · [Commercial CoE index](index.md)
- [Federal CoE Day 5](../5-day-federal-coe/day-5-operate.md) — sibling variant
- [Forward-migrate to Fabric runbook](../../runbooks/forward-migrate-to-fabric.md)
- [Hybrid topology use case](../../use-cases/hybrid-topology.md)
