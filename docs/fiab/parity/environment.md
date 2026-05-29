# environment — parity with Fabric Environment

Source UI: https://learn.microsoft.com/fabric/data-engineering/create-and-use-environment
Editor: `EnvironmentEditor` in `apps/fiab-console/lib/editors/phase2-misc-editors.tsx`

## Feature inventory

| # | Capability |
|---|---|
| 1 | Spark compute config (pool, driver/executor) |
| 2 | Public/custom libraries |
| 3 | Spark properties |
| 4 | Publish / Apply to pool |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | Compute config form (Edit group) |
| 2 | ✅ | Libraries form |
| 3 | ✅ | Spark properties form |
| 4 | ✅ | `Apply to pool` → `/environment/[id]` apply (Fabric REST) |

## Backend per control
- Config + apply → Fabric REST environment APIs.

Grade: **A (config + libraries + spark props + apply all real Fabric REST).**
