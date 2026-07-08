# PRP-22 — 5-Day Cloud CoE Workshops (Federal + Commercial Day-One)

## Context

Per AMENDMENTS §A12 (OQ-13 change from default), both Federal CoE
and Commercial CoE workshop variants ship day-one in v1.

PRD ref: `temp/fiab-prd/10-marketing-workshop.md` §10.8;
`temp/fiab-prd/AMENDMENTS.md` §A12.

## Goal

Two 5-day workshops under `docs/fiab/workshops/`:
- `5-day-federal-coe/` — federal civilian / DoD / IC / state+local
- `5-day-commercial-coe/` — regulated commercial verticals

Both follow the same 5-day structure with content tuned per audience.

## Acceptance criteria

For each workshop (federal + commercial):

- [ ] Index page (`index.md`)
- [ ] `day-1-foundation.md` — Foundation & Deploy
- [ ] `day-2-ingest.md` — Ingest & Mirroring & Catalog
- [ ] `day-3-transform.md` — Transform & Lakehouse & Warehouse
- [ ] `day-4-bi-ai.md` — BI & AI & Direct Lake & Data Agents
- [ ] `day-5-operate.md` — Operate & Govern & Forward-Migrate
- [ ] Facilitator guide per day (timing, talking points, exercises)
- [ ] Participant lab guide per day (hands-on instructions)
- [ ] Sample dataset(s) — CUI-safe synthetic data
- [ ] Day-by-day slide deck generated from markdown
- [ ] Pre-workshop readiness checklist
- [ ] Post-workshop satisfaction survey + outcome metrics template
- [ ] CoE charter document template

Federal variant emphasizes:
- FedRAMP / IL4 / IL5 audit boundary content
- CMMC L2/L3 compliance considerations
- ITAR-eligibility for GCC-High deploys
- CNSSI 1253 control mapping (when IL5 ships in v1.1)
- Forward-migration to Fabric Gov (`Forecasted`)

Commercial variant emphasizes:
- Commercial Azure regions; no boundary-specific content
- UC managed primary (commercial-only)
- Foundry Agent Service available
- Forward-migration to Fabric Commercial (already GA)

## Validation gates

- Workshop delivered to internal pilot audience (Microsoft federal
  team) end-to-end with no broken exercises
- Each day's content fits within the 8-hour day
- All hands-on labs work against the deployed Loom from PRP-02 +
  PRP-03
- All sample data is CUI-safe (verified by security review)

## Implementation outline

1. Federal CoE workshop content (5 days × ~4 pages = 20 pages)
2. Commercial CoE workshop variant (5 days × ~4 pages = 20 pages;
   most pages share structure with federal but differ in
   compliance/boundary content)
3. Sample datasets (3 sets: synthetic IoT, synthetic financial
   transactions, synthetic clinical encounters)
4. Slide decks per day (auto-generated)
5. Facilitator + participant guides per day
6. CoE charter template
7. Pre-workshop readiness checklist
8. Post-workshop survey

## File changes

```
docs/fiab/workshops/index.md                                  created
docs/fiab/workshops/5-day-federal-coe/                        created (~7 files)
docs/fiab/workshops/5-day-commercial-coe/                     created (~7 files)
docs/fiab/workshops/datasets/                                 created
docs/fiab/workshops/templates/coe-charter.md                  created
docs/fiab/workshops/templates/readiness-checklist.md          created
docs/fiab/workshops/templates/post-survey.md                  created
```

## Open questions / risks

- Two workshops day-one is ~+30% content scope vs OQ-13 default;
  staffing is the constraint; consider dedicating 2 engineers in
  parallel for ~5 weeks each
- State/local + CMMC variants stay in v1.1 (PRP-106)

## References

- `temp/fiab-prd/10-marketing-workshop.md` §10.8
- `temp/fiab-prd/AMENDMENTS.md` §A12
- Existing `learn/multimedia/presentations/`
