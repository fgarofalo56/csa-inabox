---
name: governance-autopilot
status: backlog
priority: P2
order: 16
depends_on: []
review: none
orchestrator_model: opus
implementer_model: sonnet
created: 2026-10-16
issues: [5016, 5042]
---

# PRP (hub): Governance Autopilot - zero-touch Purview enrollment, scanning, classification and labeling, plus Copilot governance tools

TRACKING ISSUE: #5296 (tracker, created 2026-11-14). Work-item issues are filed from the wave files below.

Reference design (shared context, not repeated here): `DESIGN.md` in this directory. Measurement receipt: `W0-RECEIPT.md` (this directory).
The old single-file PRP was ~99 KB and could not run in one session; it is now this hub plus 13 wave PRPs. DESIGN.md section 6 is superseded by the table below.

## 1. Goal
Copilot can act on the registered data-governance tools, and every Loom item is enrolled in Purview, scanned, classified, tagged and labeled automatically ("part of the way Loom is integrated", operator 2026-10-16), in Commercial and GCC-High, with IL5/DoD on a native scanner.

## 2. Why
Operator request 2026-10-16. Rules: `auto-bind-by-default.md` (no user plumbing), `no-fabric-dependency.md` (Purview is Azure), `cloud-parity.md`, `deploy-integrity.md` (done = deployed and verified).

## 3. Scope / Non-goals
Scope: the 13 wave PRPs. Non-goals: Purview-native auto-labeling as primary (D5); Event Hubs scanning (D9); GCC exercised receipt (GCC is supported-in-code, never exercised).

## 4. Acceptance criteria
See DESIGN.md s12 (8 conditions). The program is done only on deployed-and-verified receipts; each is falsifiable: the operator prompt in DESIGN s7.1 must produce enrollment visible in Purview (an answer without a binding fails); the GCC-High receipt must be an Actions run id (a local az paste fails).

## 5. Read first
`DESIGN.md` (s5 design, s6.3 collisions), `W0-RECEIPT.md`, `apps/fiab-console/lib/governance/{backing-resolver,inventory,inventory-tool}.ts` (built in W0/W1).

## 6. Owns
This directory only. Each wave file declares its own source ownership.

## 7. Must NOT touch
`PRPs/INDEX.md`, `MASTER-INDEX.md`, `REGISTER.md` (orchestrator).

## 8. Consumes
Estate-power pause contract (`PRPs/backlog/finish-2026-10/PRP-02-estate-power.md`, operator-local), `per-workspace-spark-identity` and `apim-ai-gateway` bicep collisions (DESIGN s6.3), the bicep interlock ledger `PRPs/reference/INTERLOCK.md`.

## 9. Provides
Binding model + enrollment service, scan orchestration, label policy, Copilot tools, admin surface, brownfield adopt path, docs.

## 10. Steps
Execute waves in order; within a wave lanes run in parallel (<=4). See the lane graph and table.

```
W0 (done) -> W1 (done)
W2 --+--> W3 (bicep) ----------------------> W5b (bicep) -> W9 (bicep) --+
     +--> W4 --+--> W5a ----------------------^                          |
     |         +--> W6a --+                                              +--> W10
     |         +--> W6b --> W8b ---------------------------------------->+
     +--> W7a --> W7b (needs W4, W5a, W6a) ------------------------------>+
     +--> W8a --> W8b
```

Waves (max 4 lanes; only ONE bicep PR in flight across all programs):
- Wave 1: W2 (Opus design pass, then Sonnet).
- Wave 2: W3 (bicep lane), W4, W7a, W8a.
- Wave 3: W5a, W6a, W6b.
- Wave 4: W5b (bicep), W7b, W8b.
- Wave 5: W9 (bicep).
- Wave 6: W10.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| W0 measurement spike | merged | | sonnet | #5016 merged; Commercial scan state unmeasured; Gov W0 BLOCKED (guest token; Gov via Actions dispatch only) | 2026-11-14 |
| W1 visibility fixes + governance_inventory | merged | | sonnet | #5042 merged, not deployed unless build marker says so (`lib/governance/inventory.ts`, `inventory-tool.ts` exist) | 2026-11-14 |
| W2 gov-W2-ges-core | todo | feat/gov-w2-ges-core | opus+sonnet | no `lib/governance/enrollment/` yet | 2026-11-14 |
| W3 gov-W3-permissions-infra | todo | feat/gov-w3-permissions-infra | sonnet | bicep; blocked by interlock + green deploy | 2026-11-14 |
| W4 gov-W4-scan-orchestration | todo | feat/gov-w4-scan-orchestration | sonnet | | 2026-11-14 |
| W5a gov-W5a-triggers-and-reconcile-route | todo | feat/gov-w5a-triggers | sonnet | | 2026-11-14 |
| W5b gov-W5b-reconcile-job-and-native-scanner | todo | feat/gov-w5b-reconcile-job | sonnet | bicep | 2026-11-14 |
| W6a gov-W6a-label-policy-and-apply | todo | feat/gov-w6a-label-policy | sonnet | | 2026-11-14 |
| W6b gov-W6b-classification-sync-and-lineage | todo | feat/gov-w6b-classification-lineage | sonnet | | 2026-11-14 |
| W7a gov-W7a-copilot-governance-read-tools | todo | feat/gov-w7a-read-tools | sonnet | | 2026-11-14 |
| W7b gov-W7b-copilot-governance-write-tools | todo | feat/gov-w7b-write-tools | sonnet | | 2026-11-14 |
| W8a gov-W8a-enrollment-admin-api-and-page | todo | feat/gov-w8a-admin-page | sonnet | no `app/admin/governance-enrollment/` yet | 2026-11-14 |
| W8b gov-W8b-item-chip-gates-parity-doc | todo | feat/gov-w8b-chip-gates | sonnet | | 2026-11-14 |
| W9 gov-W9-brownfield-adopt | todo | feat/gov-w9-brownfield | sonnet | bicep (preflight) | 2026-11-14 |
| W10 gov-W10-docs-and-e2e | todo | docs/gov-w10-docs-e2e | sonnet | | 2026-11-14 |

(The 11 program items W0..W10 are 15 rows because W5, W6, W7, W8 were split to fit one session each.)

## 11. Validation
Per wave file. Program done = DESIGN.md s12. Merged is reported as "merged, not deployed" until the estate carries it.

## 12. Rollback
Per wave; every wave is additive and revertible. Hooks (W5a) have an env off-switch.

## 13. Docs to update
`docs/fiab/governance-autopilot.md` and `docs/fiab/parity/governance-enrollment.md` (W10, W8b).

## 14. Wave / Blocked-by / Branch / Worktree
Hub. Waves above. Worktrees `E:/Repos/_gov-<wave>`.

## 15. Hot files (single owner per wave, serialized)
| File | Owner (by wave) |
|---|---|
| `lib/catalog/fabric-item-types.ts`, `lib/azure/cosmos-client.ts` | W2 only |
| `lib/azure/purview-client.ts` | W4 only |
| `app/api/items/_lib/item-crud.ts`, `lib/azure/purview-autoonboard.ts` | W5a only |
| `lib/azure/copilot-orchestrator.ts` | W7a (wave 2) then W7b (wave 4), never concurrent |
| `lib/gates/registry/*.ts` | W8b only |
| `admin-plane/main.bicep`, `catalog.bicep`, `params/*.bicepparam` | W3 (wave 2), then W5b (wave 4), then W9 if needed; one bicep PR at a time across ALL programs |
| build-fiab-images matrix | W5b serialized integration step |

touches_bicep: yes for W3, W5b, W9; no for the rest.

## 16. Kickoff prompt
```
Read PRPs/backlog/governance-autopilot/PRP.md (hub), then the wave file you are assigned and the DESIGN.md sections it cites.
Check PRPs/reference/INTERLOCK.md before any bicep wave (W3, W5b, W9). Re-verify line numbers at head; DESIGN.md citations were taken at 089666884.
Proof of done is in the wave file's Validation section; report merged vs deployed vs verified separately.
```

## Open items and decisions
- Operator decisions D1, D2, D4, D10 recorded 2026-10-16 (DESIGN s11.1). D3, D5, D6, D7, D8, D9, D11 are unanswered; waves proceed on the recommended defaults (DESIGN s11) unless the operator says otherwise before the dependent wave starts. D1 real enablement also waits on W0 scan-cost evidence.
- W0 Commercial scan state is unmeasured (needs a Limitless-tenant identity); Gov W0 is BLOCKED (guest token; Gov only via GitHub Actions dispatch).
- > ASSUMPTION: wave file names carry a `gov-` prefix because PRP names are global across the register; `W2` alone would collide with other programs.
- > ASSUMPTION: off-switch env var names in W5a/W6a are placeholders to be fixed during implementation.
