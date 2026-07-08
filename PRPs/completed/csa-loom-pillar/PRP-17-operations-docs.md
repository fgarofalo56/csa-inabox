# PRP-17 — Operations Documentation + Runbooks

## Context

Day-2 ops content under `docs/fiab/operations/` + runbooks for common
incidents.

PRD ref: `temp/fiab-prd/08-observability-security.md`; `temp/fiab-prd/
09-forward-migration.md`.

## Goal

Customer ops teams can run CSA Loom in production without ongoing
vendor escalation. Runbooks cover the top-15 incident patterns.

## Acceptance criteria

- [ ] `docs/fiab/operations/index.md` — landing page
- [ ] `docs/fiab/operations/capacity-management.md` — CU-equivalent
  model + scaling (per PRD §8.2)
- [ ] `docs/fiab/operations/monitoring.md` — Monitoring Hub deep-dive
  + pre-built KQL queries (per PRD §8.1.2)
- [ ] `docs/fiab/operations/cost.md` — cost optimization patterns
- [ ] `docs/fiab/operations/disaster-recovery.md` — DR per component
  + RPO/RTO targets (per PRD §8.3)
- [ ] `docs/fiab/operations/upgrade-migration.md` — upgrade lifecycle
  (azd re-run; ACR image pulls)
- [ ] `docs/fiab/operations/forward-to-fabric.md` — forward-migration
  runbook (per PRD §9.5.1)
- [ ] 12 runbooks under `docs/fiab/runbooks/` per PRD §8.6:
  fiab-deploy-failure, direct-lake-shim-stuck, activator-rules-not-
  firing, mirroring-cdc-lag, loom-copilot-throttling, fiab-capacity-
  overrun, purview-scan-stuck, dlz-onboard-new-domain, forward-
  migrate-to-fabric, boundary-promotion, defender-ai-equivalent-soc,
  mcp-troubleshooting
- [ ] All pages use CSA Loom brand
- [ ] Runbooks mirror existing `docs/runbooks/` structure (per
  [[csa-inabox-docs-pattern]])

## Validation gates

- `mkdocs build --strict` clean
- Each runbook structured as: symptom / detection / diagnosis /
  remediation / prevention
- KQL queries in monitoring.md execute against test LAW

## File changes

7 operations pages + 12 runbook pages = 19 files.

## References

- `temp/fiab-prd/08-observability-security.md`
- `temp/fiab-prd/09-forward-migration.md`
- Existing `docs/runbooks/` (template + pattern)
