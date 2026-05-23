# PRP-23 — Use-Case Pages (5 CSA Loom-Specific Use Cases)

## Context

Use cases under `docs/fiab/use-cases/` show CSA Loom in real-world
analytical scenarios that aren't captured by the industry examples
(PRP-14). These are pattern-level use cases.

PRD ref: `temp/fiab-prd/02-brand-positioning.md` §2.3.1 (the IA);
`temp/fiab-prd/10-marketing-workshop.md` §10.9.

## Goal

5 use-case pages that complement the industry examples by focusing on
cross-cutting patterns customers will recognize.

## Acceptance criteria

- [ ] `docs/fiab/use-cases/federal-data-mesh.md` — federal department
  with multiple agencies using domain-DLZ pattern (notional, generic
  framing per [[writing-voice-no-customer-framing]])
- [ ] `docs/fiab/use-cases/multi-agency-onboarding.md` — runbook for
  onboarding a new agency as a domain in an existing CSA Loom deploy
- [ ] `docs/fiab/use-cases/direct-lake-replacement.md` — migration
  from Tableau / Qlik / on-prem Power BI Report Server to the warm-
  cache materializer pattern
- [ ] `docs/fiab/use-cases/sovereign-ai-agents.md` — building Loom
  Data Agents under Gov constraints (no Foundry Agent Service;
  manual SOC pipeline; AOAI Gov endpoints)
- [ ] `docs/fiab/use-cases/hybrid-topology.md` — Fabric Commercial +
  CSA Loom Gov dual-cloud topology
- [ ] All pages use CSA Loom brand
- [ ] All pages comply with voice rule (generic federal-mission or
  generic-industry framing only)

## Validation gates

- `mkdocs build --strict` clean
- Each page has hero image
- Each page links to relevant workload page (PRP-15), tutorial (PRP-20),
  and example (PRP-14)

## File changes

5 use-case pages.

## References

- `temp/fiab-prd/02-brand-positioning.md` §2.3.1
- `temp/fiab-prd/10-marketing-workshop.md` §10.9
- Memory: [[writing-voice-no-customer-framing]]
