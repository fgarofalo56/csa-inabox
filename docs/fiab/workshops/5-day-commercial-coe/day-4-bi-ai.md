# Day 4 — BI & AI & Direct Lake & Data Agents (Commercial CoE)

**Track:** [5-Day Commercial CoE Workshop](index.md) · **Day 4 of 5** ·
BI & AI & Direct Lake & Data Agents

Day 4 builds a semantic model + report, demonstrates the Direct-Lake-Shim with
an honest latency discussion, and authors a Loom Data Agent — on Commercial,
optionally integrated with the **Foundry Agent Service** (GA).

!!! info "Azure-native by default"
    Semantic models use the Loom-native tabular layer (Power BI F-SKU optional
    on Commercial). Data Agents run on Azure OpenAI; on Commercial the **Foundry
    Agent Service is available (GA)** for server-side thread persistence.
    Loom still runs without Fabric — `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Learning objectives

1. Author a semantic model over Gold + a report.
2. Configure the Direct-Lake-Shim and reason honestly about latency.
3. Author + test a Loom Data Agent (optionally on Foundry Agent Service).
4. Design an Activator rule firing into Teams.
5. Use Loom Copilot build-assist.

## Facilitator guide

### Timing (8-hour day)

| Time | Activity | Mode |
|---|---|---|
| 09:00 | Day-3 recap + semantic-layer architecture | Lecture |
| 09:30 | Author a semantic model over `gold.device_hourly` | Lab |
| 10:30 | Break | — |
| 10:45 | Direct-Lake-Shim config + **honest latency demo** | Lab + Lecture |
| 11:45 | Lunch | — |
| 12:45 | Data Agent authoring + Foundry Agent Service integration | Lab |
| 14:00 | Activator rule → Teams | Lab |
| 15:00 | Break | — |
| 15:15 | Loom Copilot build-assist tour | Lab |
| 16:15 | Wrap-up + Day-5 readout prep | Plenary |

### Talking points

- **Semantic layer:** Loom-native tabular layer over Gold. On Commercial a Power
  BI F-SKU is available if the customer prefers native Power BI; it is optional,
  not required.
- **Direct Lake honesty (read verbatim):** Fabric Direct Lake refresh is
  *framing* — a metadata operation that
  [takes a few seconds](https://learn.microsoft.com/fabric/fundamentals/direct-lake-how-it-works),
  on by default. The Direct-Lake-Shim reproduces this warm-cache pattern on
  Azure-native by reframing on Event Grid signals; the freshness window is
  **seconds to tens of seconds**. On Commercial, customers also have a live path
  to Direct Lake on OneLake via forward migration (Day 5).
- **Foundry Agent Service (GA on Commercial):** Data Agents can use server-side
  thread persistence + the Agents playground. Contrast with the Federal track,
  where Foundry Agent Service is `Forecasted` in Gov.

### Exercises

1. Measure the shim refresh latency live; calibrate expectations honestly.
2. Each participant configures a Foundry Agent Service thread store and confirms
   persistence across sessions.

### Common pitfalls

- AOAI deployment missing → the Data Agent pane names the env var/deployment;
  provision + retry.
- Treating the shim as sub-second — keep the latency discussion honest.

## Participant lab — BI + AI

1. **Semantic model.** In **Semantic model** (`/semantic-model`), build measures
   + dimension + date relationship over `gold.device_hourly`. Save.
2. **Report.** Build a timechart + top-N table; confirm it renders on real data.
3. **Direct-Lake-Shim.** Configure for the Gold table, push a Gold update,
   measure the reframe latency. Record for Day-5 readout.
4. **Data Agent.** In **Data agent** (`/data-agent`), create an agent grounded on
   the IoT lakehouse. Optionally wire the **Foundry Agent Service** thread store.
   Ask: *"Which device had the highest average reading in the last 24 hours?"*
5. **Activator rule.** In **Activator** (`/activator`), fire a Teams message on a
   threshold breach; trigger with a synthetic spike.
6. **Copilot.** Use **Copilot** (`/copilot`) build-assist to scaffold a measure.

**Validation (Day-4 done):** semantic model + report on real data, shim reframe
measured, Data Agent grounded answer (with Foundry thread persistence if wired),
Activator posts to Teams.

## Datasets

- [Synthetic IoT](../datasets/synthetic-iot.md) — model + grounding source.

## Homework

- Prepare Day-5 readout slides incl. the live forward-migration plan.

## Commercial-specific emphasis

- **Foundry Agent Service available (GA)** — server-side threads + playground.
- **Defender for Cloud AI Threat Protection** available on Commercial (no
  Sentinel workaround needed).
- **Power BI F-SKU optional** — native Power BI is an available alternative to
  the Loom-native tabular layer.

## Slide deck

`make loom-decks DECK=docs/fiab/workshops/5-day-commercial-coe/day-4-bi-ai.md`.

## Related

- [← Day 3](day-3-transform.md) · [Day 5 — Operate →](day-5-operate.md)
- [Federal CoE Day 4](../5-day-federal-coe/day-4-bi-ai.md) — sibling variant
- [Direct Lake parity workload](../../workloads/direct-lake-parity.md) ·
  [Data Agents parity](../../workloads/data-agents-parity.md)
