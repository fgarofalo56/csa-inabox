# Parity gap — `/setup`

**Loom route:** `/setup` (rendered by `apps/fiab-console/app/setup/page.tsx` → `SetupWizardPane`)
**Fabric reference:** No direct equivalent — Fabric setup is in Admin portal. Loom Setup wizard is **Loom-native** for deploying additional Data Landing Zones (DLZs) after the Admin Plane is installed.
**Loom screenshot:** `temp/parity/page-setup-loom.png`
**Captured:** 2026-05-26

## What this surface is

Loom-native conversational wizard for adding a new DLZ to the deployed Admin Plane. The flow:

intro → boundary → mode → domain → capacity → review → deploying → done

Boundary options: Commercial / GCC / GCC-High / IL5
Mode options: single-sub / multi-sub
Capacity options: F-SKU sizes
Tier dispatch: Commercial/GCC → Foundry Agent Service; GCC-High/IL5 → MAF + AOAI direct

## Phase 3 — UI assessment

| # | Element | Status | Notes |
|---|---|---|---|
| 1 | Page header "Setup wizard" with subtitle | present | Clear |
| 2 | Conversational intro | present | "I'll help you deploy a new Data Landing Zone…" |
| 3 | State machine (8 steps) | present | Codified in `WizardState['step']` |
| 4 | Boundary selector | present | 4 options |
| 5 | Mode selector | present | 2 options |
| 6 | Domain name input | present | Real input |
| 7 | Capacity SKU dropdown | present | Real dropdown |
| 8 | Review step | present | Shows summary |
| 9 | Bicep param preview | present | Real `using '../main.bicep'` snippet generated from state |
| 10 | Deploy progress UI | present BUT **SIMULATED** — frontend animates 6 fake stages on a 600ms timer | MAJOR concern |
| 11 | "Done" state with deployment ID | present | But deployment ID is `stub-${Date.now()}` |
| 12 | Cancel / restart | not visible | MINOR |
| 13 | Bicep preview download / copy button | not visible | MINOR |
| 14 | Honest gate / MessageBar | **MISSING** — no MessageBar warning the user that deploy is currently a stub | **MAJOR** |

## Phase 4 — Functional verification

| Control | Source | Result |
|---|---|---|
| Wizard state machine | Real React state transitions | OK |
| Bicep preview | Real string-template renderer in `renderBicepParam()` | OK — accurate Bicep param syntax |
| Deploy button | POSTs to `/api/setup/deploy` | Hits real endpoint |
| `/api/setup/deploy` backend | Source comment: "Stub - real impl POSTs to the Setup Orchestrator FastAPI which kicks off an azd deploy + tracks progress in Cosmos. Returns a fake deploymentId so the Setup Wizard's progress UI animates." | **STUB** with fake deploymentId |
| Progress UI | Frontend simulates 6 stages (`Validating`, `Provisioning network`, `Provisioning storage`, `Provisioning Databricks`, `Wiring identity`, `Done`) with 600ms sleeps between each | **FAKE** — these aren't real azd stages |

## Critical concern (no-vaporware)

The wizard **animates a fake deploy through 6 named stages** without telling the user the deploy backend is a stub. A user clicking "Deploy" will see what looks like a real deployment progress and a "Done" state, but **no Azure resources are actually provisioned.** This is the precise pattern banned by `no-vaporware.md`: "Buttons with no click handler" + "Pre-configured / hard-coded UI values that look like real data but aren't" + "Stubbed BFF routes that return [] or {} instead of calling a real backend."

The source code is honest in its comments. The UI is not honest with the user.

## Honest grade

**Grade: D — Vaporware deploy progress**

Reasoning:
- The wizard collection-of-inputs IS real (state machine, Bicep preview generation, form validation).
- The deploy step is a stub presenting a fake progress UI with no honest disclosure.
- Per `no-vaporware.md`: this surface looks like a working deploy and is not.

If the progress UI added an honest MessageBar saying "Deploy backend is in development — this is a simulation. The Bicep params below are real; copy them into `params/commercial-full.bicepparam` and run `az deployment sub create -f platform/fiab/bicep/main.bicep -p params/commercial-full.bicepparam` manually." then the grade jumps to B.

## Recommended next actions (URGENT)

1. **Either build the real deploy backend** (FastAPI Setup Orchestrator that kicks off azd + tracks progress in Cosmos as the source comment describes).
2. **Or replace the simulated progress with an honest MessageBar** that:
   - Shows the generated Bicep params as a copy/download-able snippet
   - Provides the exact `az deployment sub create` command the user can run themselves
   - Removes the fake progress animation
   - Labels itself "Deploy backend is in development. Use the Bicep params + command below to deploy manually until the orchestrator lands."
3. Update `apps/fiab-console/app/api/setup/deploy/route.ts` to actually call the orchestrator OR return 501 + the manual-deploy instructions.
4. Add a "Download Bicep params" button on the review step.
