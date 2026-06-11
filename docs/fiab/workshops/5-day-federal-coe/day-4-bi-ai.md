# Day 4 — BI & AI & Direct Lake & Data Agents (Federal CoE)

**Track:** [5-Day Federal CoE Workshop](index.md) · **Day 4 of 5** ·
BI & AI & Direct Lake & Data Agents

Day 4 turns Gold tables into business value: a semantic model, a refreshable
report, a Direct-Lake-Shim demonstration with an honest latency discussion, and
a Loom Data Agent answering natural-language questions under Gov constraints.

!!! info "Azure-native by default"
    Semantic models use the Loom-native tabular layer over the warehouse/
    lakehouse; Data Agents run on **Azure OpenAI Gov** endpoints with identity
    passthrough. **No Power BI / Fabric workspace, no Foundry Agent Service**
    (it is `Forecasted` in Gov). `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Learning objectives

1. Author a semantic model over Gold and a report on top of it.
2. Configure the Direct-Lake-Shim and reason honestly about refresh latency.
3. Author and test a Loom Data Agent grounded on the lakehouse.
4. Design an Activator rule that fires into Teams.
5. Use Loom Copilot to accelerate item creation.

## Facilitator guide

### Timing (8-hour day)

| Time | Activity | Mode |
|---|---|---|
| 09:00 | Day-3 recap + semantic-layer architecture | Lecture |
| 09:30 | Author a semantic model over `gold.device_hourly` | Lab |
| 10:30 | Break | — |
| 10:45 | Direct-Lake-Shim config + **honest latency demo** | Lab + Lecture |
| 11:45 | Lunch | — |
| 12:45 | Data Agent authoring + test chat | Lab |
| 14:00 | Activator rule → Teams | Lab |
| 15:00 | Break | — |
| 15:15 | Loom Copilot build-assist tour | Lab |
| 16:15 | Wrap-up + Day-5 readout prep | Plenary |

### Talking points

- **Semantic layer without Power BI F-SKU:** in Gov there is no Fabric/Power BI
  F-SKU. The Loom-native tabular layer provides measures + relationships over
  Gold; reports render natively. A P-SKU Power BI is optional, not required.
- **Direct Lake honesty (read this verbatim):** Fabric's Direct Lake refresh is
  *framing* — a low-cost metadata operation that
  [takes a few seconds](https://learn.microsoft.com/fabric/fundamentals/direct-lake-how-it-works)
  and is on by default. The **Direct-Lake-Shim** reproduces the warm-cache
  pattern on Azure-native: it programmatically reframes the cache on Event Grid
  signals. Be honest that the shim's freshness window is **seconds to tens of
  seconds**, not a sub-second miracle, and that Direct Lake on OneLake (the
  Fabric original) is a *forward-migration* capability, not something Loom claims
  to out-perform.
- **Sovereign agents:** Foundry Agent Service is `Forecasted` in Gov, so server-
  side thread persistence and the Agents playground are unavailable. Loom Data
  Agents run on AOAI Gov with a manual SOC pipeline. See the
  [Sovereign AI Agents use case](../../use-cases/sovereign-ai-agents.md).

### Exercises

1. Group predicts the shim refresh latency for a Gold update, then measures it
   live and compares — the point is calibrated honesty, not a number to beat.
2. Each participant writes one Data Agent grounding instruction that prevents
   the agent from answering outside its authorized tables.

### Common pitfalls

- AOAI Gov deployment not provisioned → the Data Agent pane names the env var
  (`LOOM_OPENAI_*`) and the deployment to create. Provision and retry.
- Over-promising Direct Lake parity — keep the latency discussion honest.

## Participant lab — BI + AI

1. **Semantic model.** In **Semantic model** (`/semantic-model`), build a model
   over `gold.device_hourly`: define a measure (`avg reading`), a device
   dimension, and a date relationship. Save.
2. **Report.** Create a report with a timechart + a top-N table over the model.
   Confirm it renders against the live warehouse/lakehouse backend.
3. **Direct-Lake-Shim.** Configure the shim for the Gold table, push an update
   to Gold, and observe the reframe + measured refresh latency. Record the
   number for the Day-5 readout.
4. **Data Agent.** In **Data agent** (`/data-agent`), create an agent grounded on
   the IoT lakehouse tables. Ask: *"Which device had the highest average reading
   in the last 24 hours?"* Confirm a grounded answer with a citation.
5. **Activator rule.** In **Activator** (`/activator`), create a rule that fires
   a Teams message when a device's hourly average exceeds a threshold. Trigger
   it with a synthetic spike.
6. **Copilot.** Use **Copilot** (`/copilot`) build-assist to scaffold a second
   measure; review and accept the suggestion.

**Validation (Day-4 done):** semantic model + report render on real data, the
shim reframes with a measured latency, the Data Agent returns a grounded answer,
and the Activator rule posts to Teams.

## Datasets

- [Synthetic IoT](../datasets/synthetic-iot.md) — semantic model + agent
  grounding source.

## Homework

- Prepare your Day-5 readout slides: workload migrated, shim latency observed,
  agent demo, and one open risk.

## Federal-specific emphasis

- **No Foundry Agent Service / Agents playground in Gov** — covered honestly;
  Loom Data Agents are the Azure-native 1:1 on AOAI Gov.
- **Defender for AI** is Commercial-only; in Gov use the Sentinel pipeline
  workaround (PRP-13 `ai-defense.bicep`).
- **Content Safety** at IL4+ may require self-hosted Presidio — note for the SSP.

## Slide deck

`make loom-decks DECK=docs/fiab/workshops/5-day-federal-coe/day-4-bi-ai.md`.

## Related

- [← Day 3](day-3-transform.md) · [Day 5 — Operate →](day-5-operate.md)
- [Direct Lake parity workload](../../workloads/direct-lake-parity.md) ·
  [Data Agents parity](../../workloads/data-agents-parity.md)
- [Tutorial 03 — Direct Lake parity](../../tutorials/03-direct-lake-parity.md) ·
  [Tutorial 05 — Data Agent](../../tutorials/05-data-agent.md)
