# Day 5 — Operate & Govern & Forward-Migrate (Federal CoE)

**Track:** [5-Day Federal CoE Workshop](index.md) · **Day 5 of 5** ·
Operate & Govern & Forward-Migrate

Day 5 makes the deployment operable and governed, runs a DR drill, builds the
forward-migration plan to Fabric Gov (`Forecasted`), finalizes the CoE charter,
and ends with the exec readout.

!!! info "Azure-native by default"
    Monitoring is Azure Monitor + the Console rollup; cost is Cost Management.
    Forward migration to Fabric is **planning-only in Gov** because Fabric is
    `Forecasted` — there is no live target to migrate to yet.

## Learning objectives

1. Operate Loom day-2: monitoring, alerting, cost rollup across DLZs.
2. Run a DR drill (simulated region failover) and document RTO/RPO.
3. Produce a 1:1 forward-migration plan to Fabric Gov.
4. Finalize the CoE charter (governance, naming, RBAC, capacity, cost, ops).
5. Deliver the exec readout.

## Facilitator guide

### Timing (8-hour day)

| Time | Activity | Mode |
|---|---|---|
| 09:00 | Day-4 recap + day-2 ops overview | Lecture |
| 09:30 | Monitoring Hub + diagnostics-on-by-default | Lab |
| 10:15 | Cost management — multi-DLZ rollup + budgets | Lab |
| 10:45 | Break | — |
| 11:00 | DR drill — simulated region failover | Lab |
| 12:00 | Lunch | — |
| 13:00 | Forward-migration planning (`fiab-migrate snapshot`) | Lab |
| 14:15 | CoE charter finalization (group authoring) | Workshop |
| 15:00 | Break | — |
| 15:15 | Exec readout dry-run + Q&A prep | Workshop |
| 16:00 | Exec readout to sponsor | Plenary |

### Talking points

- **Forward migration is honest planning in Gov:** because Fabric is
  `Forecasted` for FedRAMP High / IL4 / IL5 / IL6, there is no Fabric Gov target
  to migrate to today. Day 5 produces the *plan* — table inventory, the OneLake
  shortcut strategy (zero data movement), the dbt/KQL port (unchanged), and the
  semantic-model re-author for Direct Lake on OneLake. Contrast this with the
  Commercial CoE where forward migration is demonstrated live.
- **DR posture:** document RTO/RPO from the drill; ADLS Delta + ADX have
  independent redundancy settings the customer owns.
- **CoE charter:** the durable artifact the customer keeps — governance model,
  naming, RBAC, capacity sizing, cost allocation, and the operations runbook.

### Exercises

1. Group fills the forward-migration table inventory for the Day-3 workload.
2. Pairs draft one CoE charter section each, then merge into the team charter.

### Common pitfalls

- Treating forward migration as available now in Gov — it is planning-only;
  state this clearly to the sponsor.
- Skipping the DR drill for time — keep it; it surfaces real RTO gaps.

## Participant lab — operate + plan

1. **Monitoring.** In **Monitor** (`/monitor`), confirm diagnostics are on for
   the DLZ resources, open the KQL chart library, and pin a workload health
   tile. Resolve any remaining amber service-health gates from Day 1.
2. **Cost.** Open the cost rollup, set a budget for the DLZ, and confirm the
   cross-DLZ trend renders. Map cost to the agency subscription.
3. **DR drill.** Walk the simulated region-failover runbook; record RTO/RPO.
4. **Forward-migration snapshot.** Run `fiab-migrate snapshot` to produce the
   table inventory + migration plan. Review the OneLake-shortcut + dbt-port
   sections.
5. **CoE charter.** Open the [CoE charter template](../templates/coe-charter.md),
   fill governance/naming/RBAC/capacity/cost/ops for the customer, and export.
6. **Readout.** Present the week's outcomes to the exec sponsor.

**Validation (Day-5 / workshop done):** monitoring + cost operational, DR drill
documented, forward-migration plan produced, CoE charter completed, exec readout
delivered.

## Datasets

No new data — Day 5 operates on what was built Days 2-4.

## Post-workshop

- Complete the [post-workshop satisfaction survey](../templates/post-survey.md).
- Schedule quarterly check-ins (optional add-on).

## Federal-specific emphasis

- **Forward migration is planning-only** (Fabric `Forecasted` in Gov).
- **CNSSI 1253 control mapping** is v1.1-gated (ships with IL5); mark it as a
  v1.1 deliverable in the charter, not a v1 capability.
- **ATO handoff:** the resource inventory + diagnostics config + charter feed the
  System Security Plan.

## Slide deck

`make loom-decks DECK=docs/fiab/workshops/5-day-federal-coe/day-5-operate.md`.

## Related

- [← Day 4](day-4-bi-ai.md) · [Federal CoE index](index.md)
- [Forward-migrate to Fabric runbook](../../runbooks/forward-migrate-to-fabric.md)
- [Tutorial 08 — Forward migrate to Fabric](../../tutorials/08-forward-migrate-to-fabric.md)
- [CoE charter template](../templates/coe-charter.md) ·
  [Post-workshop survey](../templates/post-survey.md)
