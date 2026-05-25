# NO VAPORWARE — Die-hard rule

**Effective: 2026-05-25. Scope: all CSA Loom work, all branches, all contributors (human or agent).**

## The rule

**Nothing ships unless it's functional end-to-end.** "Functional" means:

1. **Front-end** renders without overlaps, is readable, is keyboard-navigable, and every interactive element does the thing its label says it does.
2. **Middle (BFF route)** exists, validates session, and returns structured JSON (`{ok: true|false, data, error}`) with proper HTTP status codes.
3. **Back-end (Azure service)** is actually called — real Azure REST, real Cosmos query, real TDS/SQL execution, real ARM update. **No mock arrays. No `return []` placeholders. No hard-coded sample data unless explicitly labeled "SAMPLE — replace before ship".**
4. **Validation gate**: minted-session cookie probe + manual browser walk. The endpoint must return either real data or a precise MessageBar explaining what's missing (e.g., "AI Search not provisioned in this deployment; set LOOM_AI_SEARCH_SERVICE env var").

## What's explicitly forbidden

- Pre-configured / hard-coded UI values that look like real data but aren't
- Buttons with no click handler
- Forms that don't POST anywhere
- Tabs that show static content
- Editors that read from `useState(MOCK_DATA)` instead of `useQuery('/api/...')`
- "Coming soon" labels without a tracked TODO ticket linking to the implementation PR
- Stubbed BFF routes that return `[]` or `{}` instead of calling a real backend
- Bicep features that aren't tested in the actual deployment

## What's allowed (with disclosure)

- **Honest config-only state**: when a runtime requires infrastructure that isn't deployed yet, the UI MUST show a Fluent UI MessageBar with `intent="warning"`, the exact env var name to set / role to grant / resource to provision, and a link to the bicep module that would deploy it. The config form below can still save to Cosmos.
- **Tenant-gated state**: same pattern. MessageBar explains the one-time admin action required.
- **Preview features**: must be tagged `Badge` "Preview" and surfaced in the catalog with `preview: true`.

## Bicep sync requirement

For every new Loom feature:

1. **New Azure resource** → add to `platform/fiab/bicep/modules/**/*.bicep` and wire into the appropriate orchestrator
2. **New env var** → add to `apps[]` env list in `admin-plane/main.bicep`
3. **New role assignment** → add to the resource's bicep module with `Microsoft.Authorization/roleAssignments`
4. **New Cosmos container** → add to a Cosmos init step (either bicep deploymentScript or the cosmos-client's `createIfNotExists`)
5. **New tenant config (Power BI, Fabric, KV firewall, etc.)** → document in `docs/fiab/v3-tenant-bootstrap.md` and (where possible) add to `scripts/csa-loom/*.sh` or `.github/workflows/*-bootstrap.yml`

The acceptance test: **`az deployment sub create -f platform/fiab/bicep/main.bicep -p params/commercial-full.bicepparam` + the post-deploy bootstrap workflow must produce a working Loom with the same feature set as the live deployment.** Drift between what's running and what bicep deploys is itself a vaporware violation.

## Validation per merge

Before merging any PR, the author MUST attach a "real data E2E" receipt:

- Endpoint hit (e.g., `/api/items/<type>/<id>/<action>`)
- Real response body (first 300 chars)
- Browser screenshot of the surface OR a Playwright trace
- Bicep diff if any infra changed

The receipt goes in the PR body. Reviewers REJECT any PR without it.

## Teardown validation (recurring)

Quarterly (or after any major feature group lands), run a complete teardown + 1-button redeploy in a clean sub. Both Commercial AND Gov.

Acceptance: every editor in the catalog renders + executes its primary action against the freshly-deployed Azure backing, OR shows the documented MessageBar gate. If anything else happens, the feature is recorded as vaporware and removed from the catalog until fixed.

## Grading rubric

Each surface gets graded on:
- **F (Vaporware)**: looks real but isn't; remove or fix
- **D (Stubbed)**: renders but does nothing; flag with MessageBar or remove
- **C (Functional but rough)**: works but UX issues (overlaps, slow, ugly)
- **B (Production-grade)**: works, looks good, real data, real backend
- **A (Production-grade + tested)**: B + Vitest/Playwright covered
- **A+ (Production-grade + tested + documented + bicep-synced)**: A + Learn popup + bicep deploys it from scratch

Target: **everything A or A+** before the next major release.

## How to spot a vaporware violation

```bash
grep -rE "(return \[\]|return \{\}|useState\(\[\{)" apps/fiab-console/lib/editors apps/fiab-console/app/api
grep -rE "(MOCK_|SAMPLE_|TODO|FIXME|XXX)" apps/fiab-console
```

Any result is a candidate vaporware violation. Triage at every PR.
