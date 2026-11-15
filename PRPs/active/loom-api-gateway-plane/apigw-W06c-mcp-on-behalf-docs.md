---
name: apigw-W06c-mcp-on-behalf-docs
status: backlog
priority: P1
order: 42
depends_on: [apigw-W06a-mcp-registry-publish, apigw-W06b-mcp-grants-rest-to-mcp, apigw-W04b-diagnostics-rollup-job, apigw-W04c-analytics-verifier]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---
# W6c - Model caller, on-behalf attribution, MCP docs and receipts (W6-4, W6-6)

Hub: `PRPs/active/loom-api-gateway-plane/PRP.md` (wave table and bicep rules). Shared context is linked, not repeated:
`ARCHITECTURE.md`, `TEST-STRATEGY.md`, `LOOM-INTEGRATION.md`, `W0-RECEIPT.md` in the same folder. Program rules: `.claude/rules/`.

## Goal
Model calls made by an MCP server can be attributed to the person served (ADR-007), and the MCP slice closes with docs, parity rows and a G1 walk.

## Why
W6-4 needs the W4-3 rollup job (W04b) to join MCP and model traces; W6-6 is the closing receipt for W06a-b.

## Scope / Non-goals
**Scope:** work items W6-4, W6-6 below.

**Non-goals:** New publication or grant behaviour (W06a/b); Government on-behalf (not measured).

## Acceptance criteria
Each names the value or output that would make it fail (the per-item Verify column below is part of this list).
- W6-4: a model call 6 minutes after the MCP call window is `late`; breaks if it joins.
- W6-4: another application reference resolves to `caller`; a direct call carrying the header records nothing.
- W6-6: every Mosaic live-verification MCP row in `TEST-STRATEGY.md` section 5 is marked measured or unknown; breaks on an unmarked row.

## Read first
- `apigw-W04b-diagnostics-rollup-job.md` (rollup/parser contract).
- `ARCHITECTURE.md` ADR-007.
- `TEST-STRATEGY.md` section 5.

## Owns
- `apps/fiab-console/lib/api-gateway/mcp/model-caller.ts`
- `apps/fiab-console/app/api/admin/api-gateway/mcp-publications/[id]/model-caller/route.ts`
- `apps/fiab-console/e2e/api-gateway-mcp.uat.ts`

## Must NOT touch
- `lib/api-gateway/mcp/publication.ts` (W06a).
- Gateway writes outside the reviewed plan path.

## Consumes
- W06a publication and fragments; W06b verifier; W04b rollup/parser; W04c analytics routes.

## Provides
- On-behalf summaries (`onBehalf`, `onBehalfUnresolved`), Consumers "Model use through MCP servers", chargeback columns "On behalf of".

## Steps
Ordered; W6-4 then W6-6.

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W6-4 | todo | | sonnet | | 2026-10-28 |
| W6-6 | todo | | sonnet | | 2026-10-28 |

#### Integration step (serialized)

- `lib/api-gateway/policy/mcp.ts` (header rules): owned by W06a; `lib/api-gateway/policy/access.ts`: owned by W03b.
- `lib/api-gateway/telemetry/{rollup,parser}.ts` (join + summaries): owned by W04b.
- Analytics routes/pages section and chargeback CSV two columns: owned by W04c (ASSUMPTION; the CSV may be W04a, confirm in their Owns lists).
- Docs: `docs/fiab/parity/apim-ai-gateway.md` and `docs/fiab/admin/api-management.md` (section-scoped rows only; no PRP owns these files, so they are edited last in the PR and rebased on conflict; ASSUMPTION: orchestrator assigns the docs slot in `PRPs/reference/GLOBAL-SCHEDULE.md`).

## Validation
```bash
pnpm --dir apps/fiab-console vitest run lib/api-gateway/mcp lib/api-gateway/telemetry
pnpm --dir apps/fiab-console uat   # G1 walk (scripts/uat-launch.mjs); attach screenshots
python -S -E ~/.claude/kits/orchestrated-prp/prp_index.py check --root .
```
Per-cloud receipts: Commercial: live walk with one MCP server calling a governed model (on-behalf visible in Consumers and chargeback CSV). GCC-High: per W0-3 outcome, Actions run id or the stated limitation.
Merged is not done (`deploy-integrity.md` R2): until the deploy rolled and `/build-marker.txt` matches, report "merged, not deployed". A boundary without a receipt is named unexercised; GCC is supported-in-code, never exercised.

Done receipt: Commercial: external MCP server published and verified; Loom data agent called from VS Code; on-behalf attribution in Consumers and CSV. GCC-High: run id or W0-3 limitation.

## Rollback
Model-caller `DELETE` route; fragments restored by the next reviewed plan; flag off hides the surface.

## Docs to update
`docs/fiab/parity/apim-ai-gateway.md` and `docs/fiab/admin/api-management.md` (section-scoped rows only; no PRP owns these files, so they are edited last in the PR and rebased on conflict; ASSUMPTION: orchestrator assigns the docs slot in `PRPs/reference/GLOBAL-SCHEDULE.md`); `docs/fiab/admin/api-management.md` MCP section.

## Wave / Blocked-by / Branch / Worktree
Wave: 7 · Blocked-by: apigw-W06a-mcp-registry-publish, apigw-W06b-mcp-grants-rest-to-mcp, apigw-W04b-diagnostics-rollup-job, apigw-W04c-analytics-verifier · Branch: feat/apigw-w06c · Worktree: E:/Repos/_apigw-w06c

## Hot files
`lib/api-gateway/policy/{mcp,access}.ts`, `lib/api-gateway/telemetry/{rollup,parser}.ts` (integration; owned upstream).
`touches_bicep: no`

## Kickoff prompt
```
Read PRPs/active/loom-api-gateway-plane/apigw-W06c-mcp-on-behalf-docs.md and the apigw-W04b rollup contract.
Goal: W6-4 model caller + on-behalf join; W6-6 docs, parity rows, G1 walk.
Edit Owns paths; shared telemetry/policy files only after their owners merged.
Branch feat/apigw-w06c in E:/Repos/_apigw-w06c.
Proof: vitest run lib/api-gateway/mcp lib/api-gateway/telemetry; the late-join test goes RED when the window is widened.
"merged, not deployed" until rolled.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W6-4 | todo | | sonnet | | 2026-11-14 |
| W6-6 | todo | | sonnet | | 2026-11-14 |

Cost / credit estimate: ~3 Sonnet sessions.
