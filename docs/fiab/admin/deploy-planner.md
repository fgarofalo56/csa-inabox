# Deployment planner admin page

> **Surface:** `/admin/deploy-planner`

The **Deployment planner** lets an operator visually plan what deploys to which
subscription and domain — then generates the `bicepparam` for the actual
`az deployment`. It turns a target topology into the exact, reviewable parameter
file the platform bicep consumes, so a deployment is planned in the UI and
executed from real infrastructure-as-code.

## What you can do

- **Plan the topology** — lay out which workloads / landing zones go to which
  subscription and governance domain.
- **Generate the bicepparam** — the planner emits the `*.bicepparam` matching the
  plan (the same params `platform/fiab/bicep/main.bicep` reads), ready for
  `az deployment sub create`.
- **Review before you run** — the plan is inspectable and diff-able; nothing is
  deployed from this page, keeping the two-phase image path (infra, then app
  build) intact.

## Backend

The planner is a client-side planning surface that serializes to the canonical
bicep parameter shape. It does not itself run ARM; the generated `bicepparam` is
handed to the operator's `az deployment` (or the app-deploy workflow), keeping
the from-scratch path auditable and idempotent.

## RBAC & honest gates

Tenant-admin. Actually deploying the generated params requires the deploy service
principal's subscription rights — the planner produces the plan; the operator
runs it through the normal deployment pipeline.

## Related

- [Landing zones](landing-zones.md) · [Scale by SKU](scaling.md)
