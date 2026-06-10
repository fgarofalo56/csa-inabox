# Day 1 — Foundation & Deploy (Commercial CoE)

**Track:** [5-Day Commercial CoE Workshop](index.md) · **Day 1 of 5** ·
Foundation & Deploy

Day 1 takes a regulated commercial customer from an empty Azure Commercial
subscription to a running CSA Loom Admin Plane plus the first DLZ, deployed by a
platform engineer themselves.

!!! info "Azure-native by default"
    Loom runs on Azure-native backends (ADLS Gen2 + Delta, Databricks/Synapse,
    Azure Data Explorer, Azure OpenAI). **No Microsoft Fabric capacity is
    required** to run Loom. On Commercial, Fabric *is* GA — so Day 5 can
    forward-migrate **live**, unlike the Federal track.

## Learning objectives

1. Explain the Loom architecture (Admin Plane + DLZ) for a commercial estate.
2. Verify an Azure Commercial subscription meets Loom's prerequisites.
3. Deploy the Admin Plane via `azd up` with the commercial param.
4. Confirm Unity Catalog managed catalog is wired (commercial primary).
5. Sign in and confirm the Console is healthy.

## Facilitator guide

### Timing (8-hour day)

| Time | Activity | Mode |
|---|---|---|
| 09:00 | Kickoff with exec sponsor — business framing, week outcomes | Plenary |
| 09:30 | Loom architecture (commercial framing) | Lecture |
| 10:30 | Break | — |
| 10:45 | Prerequisites verification (roles, subs, Entra group) | Lab |
| 11:45 | Lunch | — |
| 12:45 | `commercial.bicepparam` walkthrough (UC managed, Foundry on) | Lab |
| 13:45 | `azd up` Admin Plane deploy (~20-35 min) | Lab |
| 14:30 | While deploy runs: Setup Wizard + DLZ design | Lecture |
| 15:15 | Break | — |
| 15:30 | First DLZ deploy + Console health validation | Lab |
| 16:30 | Day-1 wrap-up + Day-2 preview | Plenary |

### Talking points

- **Why a regulated commercial customer uses Loom:** sovereignty, data-residency,
  or a preference to keep analytics on owned Azure-native services with a clean
  1:1 path to Fabric. Loom is the bridge; Fabric Commercial is the destination
  (and it is GA today).
- **UC managed primary:** on Commercial, the catalog primary is Unity Catalog
  managed, with a Purview overlay. Contrast with the Federal track (Purview
  primary).
- **Foundry Agent Service available:** on Commercial, Data Agents can use the
  Foundry Agent Service (GA). Day 4 demonstrates this directly.

### Exercises

1. Each participant states their vertical (HIPAA / FSI / pharma) and the one
   compliance constraint that brought them to Loom rather than Fabric directly.
2. Run `what-if` on the commercial param and read the diff as a group.

### Common pitfalls

- Missing User Access Administrator on the sub → role assignments fail; verify
  in the prereq lab.
- Assuming Gov constraints — on Commercial, F-SKU/Power BI, Foundry, and Defender
  for AI are all available; do not over-restrict.

## Participant lab — deploy the Admin Plane

**Prerequisites:** see the
[pre-workshop readiness checklist](../templates/readiness-checklist.md).

1. **Clone + init.**
   ```bash
   git clone https://github.com/fgarofalo56/csa-inabox.git
   cd csa-inabox/platform/fiab/azd
   azd auth login
   azd init
   ```
2. **Use the commercial param.** Copy `platform/fiab/bicep/params/commercial.bicepparam`
   (or `commercial-full.bicepparam` for everything-on). Set `adminEntraGroupId`
   to your Loom Admins group. `catalogPrimary = 'unity-catalog-managed'` and
   `agentOrchestrator = 'foundry-agent-service'` are the commercial defaults.
   Leave `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
3. **Preview.** `azd provision --preview`; review with the facilitator.
4. **Deploy.** `azd up` (~20-35 min).
5. **Sign in + health.** Browse to the Console URL, authenticate, confirm
   **Workspaces** renders and **Monitor → Service health** is green (resolve any
   amber gate it names).

**Validation (Day-1 done):** Console reachable, signed in, Workspaces renders,
first DLZ present, UC managed catalog wired.

### Troubleshooting

| Symptom | Fix |
|---|---|
| Role-assignment failure | Grant User Access Administrator; re-run `azd up`. |
| UC catalog not wired | Confirm `catalogPrimary = 'unity-catalog-managed'` and the metastore admin grant ran. |

## Datasets

Day 1 uses no business data. Synthetic datasets are described in
[Workshop datasets](../datasets/index.md) (CUI-safe synthetic; safe for
regulated verticals).

## Homework

- Read the [governance overview](../../governance/index.md).
- Confirm your DLZ networking matches your vertical's policy (public + private
  mix per customer choice).

## Commercial-specific emphasis

- **Commercial baseline, no boundary param gymnastics** — one commercial param.
- **UC managed primary** catalog from the start.
- **Vertical compliance** (HIPAA / SOC 2 / PCI / GDPR / FDA Part 11) framing
  rather than FedRAMP/IL framing.

## Slide deck

`make loom-decks DECK=docs/fiab/workshops/5-day-commercial-coe/day-1-foundation.md`.

## Related

- [Commercial CoE index](index.md) · [Day 2 — Ingest →](day-2-ingest.md)
- [Federal CoE Day 1](../5-day-federal-coe/day-1-foundation.md) — sibling variant
- [Quickstart](../../deployment/quickstart.md)
