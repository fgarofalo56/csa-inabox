# CSA Loom — Public-Release PRP (index)

> Program to take CSA Loom from "deep but last-mile-broken" to a defensible **public v1**.
> Full spec: [`PRP.md`](./PRP.md). Verdict + evidence: [`../../../docs/fiab/prp/RELEASE-READINESS-2026-07-02.md`](../../../docs/fiab/prp/RELEASE-READINESS-2026-07-02.md).
>
> Author: release-audit synthesis lead · Date: 2026-07-02 · Branch: `feat/loom-marketplace`

---

## Verdict

**NOT READY.** The product a signed-in single operator uses is largely B/A-grade, but the
public-facing edges no prior sweep exercised — the documented install path, the login flow,
the first upgrade, a second user in a shared workspace, the CI/test gate, and the published
docs site — each hit a wall. ~13 confirmed blockers (Wave 0–1b) plus deployment-truth
(Wave 2) gate the tag.

## The 13 release blockers (Wave 0–1b)

| Blocker | rel-T | Wave |
|---------|-------|------|
| B1 Onboarding funnel vaporware (azd/deploy-button/fiab-migrate) | T01, T77 | 0 |
| B2 Live estate IDs + PII on public docs | T02 | 0 |
| B3 Predictable `LOOM_INTERNAL_TOKEN` on internet endpoints | T10 | 1 |
| B4 `tenantId==oid` breaks all multi-user features | T11 | 1 |
| B5 UDF Run executes the baked-in sample | T05 | 0 |
| B6 bicep-sync merge-blocker FAILS | T08 | 0 |
| B7 AAS deployed twice with conflicting SKUs + env | T31 | 2 |
| B8 Gov post-deploy bootstrap missing | T32 | 2 |
| B9 Teardown→redeploy blocked (soft-deletes) | T35 | 2 |
| B10 Gov private-DNS zones hard-code commercial | T36 | 2 |
| B11 Scorecard hard-requires Power BI | T03 | 0 |
| B12 Default BI backend = Power BI + api.powerbi.com on default render | T04 | 0 |
| B13 Vitest in no CI + red; merge auto-rolls prod ungated | T21, T22 | 1b |

## Wave map

| Wave | Theme | Items | Gate |
|------|-------|-------|------|
| 0 | Release blockers (vaporware / privacy / no-fabric) | rel-T01…T09 | G1–G4 |
| 1 | Security + access-control | rel-T10…T20 | G5–G6 |
| 1b | Testing + CI enforcement | rel-T21…T30 | G7 |
| 2 | Deployment-truth + product-truth | rel-T31…T44 | G8–G9 |
| 3 | IA / navigation consolidation | rel-T45…T54 | — |
| 4 | UI polish + a11y + refactor hygiene | rel-T55…T70 | G10 |
| 5 | Docs / help / release engineering | rel-T71…T80 | G11 |
| 6 | Fabric-parity feature gaps | rel-T81…T95 | — |
| 7 | Product-gap features + nice-to-have | rel-T96…T108 | — |

## How to run a wave

1. **Re-verify first.** Audit plans go stale on an active repo (07-01 lesson). Confirm each item's evidence against current code before building — several fabric-parity gaps are already partially built.
2. **Inherit the cross-cutting gates** (PRP §1): real backend per control, Azure-native default + Fabric opt-in, Fluent v9 + Loom tokens, no-freeform config, dual-cloud, bicep-synced, no-scaffold proof-of-done.
3. **Serialize ACR rolls** (parallel rolls fail); parallel agents never `git stash`; build heap 6144.
4. **Attach a real-data E2E receipt** to every PR (endpoint + real response + screenshot/trace + bicep diff).

## Grade table (2026-07-02)

vaporware-api A · vaporware-editors B · fabric-parity B · no-fabric-dep B · ui-consistency B ·
security B · refactor B · usability B · ui-navigation C · access-control C · deployment C ·
testing C · docs-help C · product-gaps C.

## Effort roll-up

S ≈ 46 · M ≈ 42 · L ≈ 15 · XL ≈ 5 (108 items). Critical path to a v1 tag = Waves 0–1b;
Wave 2 gates Gov + teardown; Waves 3–7 raise the grade from shippable to A/A+.

## Related

- Mandates: `.claude/rules/{no-vaporware,ui-parity,web3-ui,no-fabric-dependency}.md` + BLOCKING memory.
- Fabric-parity program: `PRPs/active/fabric-parity/{README.md,PHASES.md}`.
- Enterprise hardening (Phase 1 OBO + multi-domain ACL, overlaps rel-T11): `PRPs/active/enterprise-hardening/PHASES.md`.
- Prior audits: `docs/fiab/prp/{AUDIT-2026-06-10.md,AUDIT-2026-06-10-deep.md}`.
- Per-dimension detail: `docs/fiab/prp/release-audit/*.md`.
