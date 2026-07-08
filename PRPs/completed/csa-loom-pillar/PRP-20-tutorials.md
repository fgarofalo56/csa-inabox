# PRP-20 — Tutorials (8 Step-By-Step Pieces)

## Context

Step-by-step tutorials let new users build something tangible in
Loom in under 30 minutes per tutorial.

PRD ref: `temp/fiab-prd/02-brand-positioning.md` §2.3.1 (the IA).

## Goal

8 tutorials under `docs/fiab/tutorials/` walking users through the
key Loom capabilities. Each tutorial is testable against a deployed
Loom workspace.

## Acceptance criteria

- [ ] `docs/fiab/tutorials/01-first-workspace.md` — create a workspace
  via the Console (15 min)
- [ ] `docs/fiab/tutorials/02-first-lakehouse.md` — Bronze table +
  basic Spark transform (30 min)
- [ ] `docs/fiab/tutorials/03-direct-lake-parity.md` — author TMDL
  semantic model + configure Direct-Lake-Shim refresh policy + Power
  BI report (45 min)
- [ ] `docs/fiab/tutorials/04-activator-rules.md` — rule over IoT
  stream → Teams alert (30 min)
- [ ] `docs/fiab/tutorials/05-data-agent.md` — author + test Loom Data
  Agent over lakehouse (30 min)
- [ ] `docs/fiab/tutorials/06-mirroring-cosmos.md` — mirror Cosmos
  DB to Bronze (30 min)
- [ ] `docs/fiab/tutorials/07-marketplace-data-product.md` — publish
  data product to org marketplace (15 min)
- [ ] `docs/fiab/tutorials/08-forward-migrate-to-fabric.md` — set up
  OneLake shortcut from Fabric Commercial to FiaB lakehouse (30 min;
  Commercial only; demonstrative)
- [ ] Each tutorial has copy-paste-ready code blocks
- [ ] Each tutorial uses CSA Loom brand
- [ ] Each tutorial works against the deployed Loom from PRP-02 +
  PRP-03

## Validation gates

- E2E: each tutorial runnable end-to-end against staging Loom
- `mkdocs build --strict` clean
- All code blocks are syntax-checked

## File changes

8 tutorial pages + sample data + sample TMDL + sample rules JSON.

## References

- `temp/fiab-prd/02-brand-positioning.md` §2.3.1
- `temp/fiab-prd/11-examples-port.md` (overlapping content)
