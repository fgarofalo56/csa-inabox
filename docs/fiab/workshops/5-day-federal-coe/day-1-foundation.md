# Day 1 — Foundation & Deploy (Federal CoE)

**Track:** [5-Day Federal CoE Workshop](index.md) · **Day 1 of 5** ·
Foundation & Deploy

Day 1 takes the customer from an empty Azure Government subscription to a
running CSA Loom Admin Plane plus the first Data Landing Zone (DLZ). By the
end of the day the Loom Console is operational and a platform engineer has
deployed it themselves.

!!! info "Azure-native by default"
    Every deploy in this workshop runs on Azure-native backends (ADLS Gen2 +
    Delta, Synapse, Azure Data Explorer, Azure OpenAI Gov). **No Microsoft
    Fabric capacity or workspace is required.** Fabric appears only on Day 5
    as a *forward-migration target* (`Forecasted` in Gov).

## Learning objectives

By end of Day 1, each participant can:

1. Explain the CSA Loom architecture (Admin Plane + DLZ) and the per-boundary
   support matrix.
2. Verify an Azure Government subscription meets Loom's prerequisites.
3. Choose the correct `.bicepparam` for their boundary (GCC / GCC-High / IL5).
4. Deploy the Loom Admin Plane via `azd up` (or the Setup Wizard).
5. Confirm the Console is healthy and sign in with their Entra Gov identity.

## Facilitator guide

### Timing (8-hour day)

| Time | Activity | Mode |
|---|---|---|
| 09:00 | Kickoff with exec sponsor — mission framing, week outcomes | Plenary |
| 09:30 | Loom architecture + per-boundary matrix walkthrough | Lecture |
| 10:30 | Break | — |
| 10:45 | Prerequisites verification (roles, CIDR, Entra group, capacity) | Lab |
| 11:45 | Lunch | — |
| 12:45 | `.bicepparam` deep-dive — choose + edit the boundary param | Lab |
| 13:45 | `azd up` Admin Plane deploy (runs ~20-35 min) | Lab |
| 14:30 | While deploy runs: Setup Wizard conceptual tour + DLZ design | Lecture |
| 15:15 | Break | — |
| 15:30 | First DLZ deploy + Console health validation | Lab |
| 16:30 | Day-1 wrap-up + Day-2 preview + homework | Plenary |

### Talking points

- **Why Loom exists in Gov:** Microsoft Fabric is `Forecasted` for FedRAMP
  High / IL4 / IL5 / IL6 on the
  [Azure Government product roadmap](https://learn.microsoft.com/azure/azure-government/documentation-government-product-roadmap#product-general-availability-roadmap)
  — there is no public GA date. Loom gives mission teams the Fabric *experience*
  on Azure-native services today, and forward-migrates 1:1 when Fabric reaches
  their boundary.
- **Admin Plane vs DLZ:** The Admin Plane is the shared control surface (Console,
  catalog overlay, cost/monitoring rollup, governance). Each DLZ is an isolated
  per-domain landing zone. This is the federation model expanded on Day 5 and in
  the [Federal Data Mesh use case](../../use-cases/federal-data-mesh.md).
- **F-SKU honesty:** GCC / GCC-High have **no Power BI F-SKU** — semantic models
  use the Loom-native tabular layer (P-SKU optional). Do not promise Direct Lake
  on OneLake in Gov; that is a forward-migration capability, covered honestly on
  Day 4.

### Exercises (facilitator-led)

1. Have each participant read the per-boundary matrix and state which row their
   agency falls in and why.
2. Run a `what-if` against the chosen `.bicepparam` and read the resource diff
   aloud as a group before the real deploy.

### Common pitfalls

- Missing **User Access Administrator** on the target sub → role-assignment
  steps fail mid-deploy. Verify in the prereq lab, not during `azd up`.
- Entra group-claim emission disabled in the tenant → set
  `LOOM_TENANT_ADMIN_OID` so the first admin can reach `/admin/permissions`.
- ACR public-access propagation delay on first image pull (~30-90s) — expected;
  do not abort the deploy.

## Participant lab — deploy the Admin Plane

**Prerequisites (customer-completed before the workshop):** see the
[pre-workshop readiness checklist](../templates/readiness-checklist.md).

1. **Clone + init.**
   ```bash
   git clone https://github.com/fgarofalo56/csa-inabox.git
   cd csa-inabox/platform/fiab/azd
   azd auth login --tenant <your-gov-tenant-id>
   azd init
   ```
2. **Select your boundary param.** Copy the matching file from
   `platform/fiab/bicep/params/` — `gcc.bicepparam`, `gcc-high.bicepparam`, or
   (v1.1) `il5.bicepparam`. Set `adminEntraGroupId` to your **Loom Admins**
   group object ID. Leave `LOOM_DEFAULT_FABRIC_WORKSPACE` unset — Loom runs
   Azure-native.
3. **Preview.** `azd provision --preview` and review the resource diff with the
   facilitator.
4. **Deploy.** `azd up`. Expect ~20-35 minutes for the Admin Plane.
5. **Sign in.** Browse to the Console URL emitted by `azd up`, authenticate with
   your Entra Gov identity, and confirm the Workspaces pane (`/workspaces`)
   renders.
6. **Health check.** Open **Monitor → Service health** (`/monitor`) and confirm
   the service-health probes report the deployed backends as reachable. Any
   amber tile shows the exact env var / role to set — record it; you will
   resolve gates as they appear through the week.

**Validation (Day-1 done):** Console reachable, you are signed in, Workspaces
pane renders, and the first DLZ appears under **Workspaces**.

### Troubleshooting

| Symptom | Fix |
|---|---|
| `azd up` fails on role assignment | Grant the deploying principal User Access Administrator; re-run `azd up` (idempotent). |
| Console 403 on `/admin/*` | Set `LOOM_TENANT_ADMIN_OID` to your user OID; restart the Console revision. |
| Image pull timeout | Wait for ACR public-access propagation; re-run the failed deploy step. |

## Datasets

Day 1 uses no business data — only deployment. The synthetic datasets you load
from Day 2 onward are described in
[Workshop datasets](../datasets/index.md) (all CUI-safe synthetic).

## Homework

- Read the [governance overview](../../governance/index.md).
- Confirm your DLZ CIDR ranges and ER/VPN connectivity with your network team.

## Federal-specific emphasis

- **Boundary param walkthrough:** GCC-High vs IL5 differences (network egress
  allow-list, CMK requirements, Purview-primary catalog).
- **ATO framing:** capture the deployed resource inventory from the `azd up`
  output as a starting artifact for the System Security Plan.
- **ITAR:** GCC-High deploys keep all data and identities in the US sovereign
  boundary; no Commercial fallback endpoints are configured.

## Slide deck

Render the Day-1 facilitator deck:
`make loom-decks DECK=docs/fiab/workshops/5-day-federal-coe/day-1-foundation.md`.

## Related

- [Federal CoE index](index.md) · [Day 2 — Ingest →](day-2-ingest.md)
- [Quickstart](../../deployment/quickstart.md)
- [Tutorial 01 — First workspace](../../tutorials/01-first-workspace.md)
- [CoE charter template](../templates/coe-charter.md)
