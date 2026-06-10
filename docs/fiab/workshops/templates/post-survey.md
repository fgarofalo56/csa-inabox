# Post-workshop satisfaction survey + outcome metrics

Two artifacts: a **satisfaction survey** (each participant) and an **outcome
metrics** scorecard (the team). Collect both within 3 business days of Day 5.

## Part A — Participant satisfaction survey

Score 1 (strongly disagree) to 5 (strongly agree).

| # | Statement | Score (1-5) |
|---|---|---|
| 1 | I can deploy CSA Loom into our Azure subscription independently | `<…>` |
| 2 | I understand the Admin Plane + DLZ architecture | `<…>` |
| 3 | I can ingest a source and build a Bronze → Silver → Gold medallion | `<…>` |
| 4 | I can author a semantic model + report on real data | `<…>` |
| 5 | I understand the Direct-Lake-Shim and its **honest** latency window | `<…>` |
| 6 | I can author and ground a Loom Data Agent | `<…>` |
| 7 | I understand our forward-migration path to Fabric | `<…>` |
| 8 | The labs worked against our deployed Loom with no broken exercises | `<…>` |
| 9 | The pace fit an 8-hour day | `<…>` |
| 10 | I would recommend this workshop to a peer team | `<…>` |

**Open feedback**

- What was most valuable? `<…>`
- What should change? `<…>`
- What is still unclear / what is your top open question? `<…>`

!!! note "Honesty calibration matters"
    Question 5 is intentional. The workshop's credibility depends on
    participants leaving with a **correct** mental model of Direct Lake parity
    (framing is seconds; the shim reframes on Event Grid — it is not sub-second).
    A low score here means the Day-4 honesty discussion needs reinforcement.

## Part B — Team outcome metrics scorecard

Objective, verifiable outcomes (yes/no + evidence).

| Outcome | Achieved? | Evidence |
|---|---|---|
| Loom Admin Plane deployed in customer sub | `<Y/N>` | `<Console URL / resource group>` |
| ≥1 DLZ deployed | `<Y/N>` | `<workspace name>` |
| One real workload piloted end-to-end | `<Y/N>` | `<workload + Gold table>` |
| Activator rule firing into Teams | `<Y/N>` | `<rule name>` |
| Data Agent answering grounded questions | `<Y/N>` | `<agent name>` |
| Direct-Lake-Shim refresh latency measured | `<Y/N>` | `<observed seconds>` |
| CoE charter completed | `<Y/N>` | `<link>` |
| Forward-migration plan produced | `<Y/N>` | `<snapshot artifact>` |
| **(Commercial)** Live migration to Fabric Commercial | `<Y/N/NA>` | `<Fabric workspace>` |
| Team certified ready to operate independently | `<Y/N>` | `<lead sign-off>` |

## Follow-up

- [ ] Aggregate scores; flag any item averaging < 3.5 for follow-up enablement
- [ ] Schedule quarterly check-in (optional add-on)
- [ ] File outcome scorecard with the [CoE charter](coe-charter.md)

## Related

- [Day 5 — Operate & Govern](../5-day-federal-coe/day-5-operate.md)
- [Readiness checklist](readiness-checklist.md) · [CoE charter](coe-charter.md)
