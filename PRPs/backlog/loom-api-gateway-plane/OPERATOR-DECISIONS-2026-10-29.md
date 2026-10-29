# API & AI Gateway Plane — operator decisions recorded 2026-10-29

Answers given in chat on 2026-10-29 to the eight open questions in
`RISKS-AND-OPEN-DECISIONS.md` § 2, to #4442's open Q5, and to two
sequencing questions. They are fixed inputs like the 2026-10-28 set. Where an
answer departs from the recommended default the consequence is stated so a
later reader sees why a wave carries an extra item.

| Id | Question | Options offered | Answer | Consequence for the plan |
|---|---|---|---|---|
| Q9 | Who may administer the plane? | (a) tenant admin now, scoped capability in W9; (b) scoped `apiplane-admin` capability from W1; (c) workspace admins manage what they register | **(b) scoped capability from W1** — departs from the recommended default (a) | New item **W1-8**: an `apiplane-admin` capability declared in `lib/auth/feature-catalog.ts`, enforced by `withCapability` (`lib/api/route-toolkit.ts:254`) on every plane admin route from day one, assignable to an Entra group; tenant admins remain a superset; audit records the capability used. W9-4 narrows to hardening (route-enumeration test, docs). D6, ADR-004, `ARCHITECTURE.md`, `LOOM-INTEGRATION.md`, `SECURITY-AND-COMPLIANCE.md` and `MOSAIC-CAPABILITY-MAP.md` row 3.1 updated. |
| Q10 | Adopt the bicep-authored day-one gateway (#4442 Waves A/B1) into the plane? | (a) adopt in W7 via reviewed apply; (b) stay observe-only; (c) adopt in W2 | **(a) adopt in W7** (recommended) | D14 confirmed; W7-5 unchanged: bicep authors until the reviewed apply succeeds, then `loomBackends.aoaiGateway` flips to `'plane'`. |
| Q16 | Loom's own Copilot/agent traffic as a governed principal under a `platform` cost center? | (a) yes, visible in chargeback; (b) yes, hidden by default; (c) no | **(a) yes, visible** (recommended) | R9 and W7-5 unchanged; platform usage appears in Analytics and chargeback from W7 with no hiding toggle. |
| #4442 Q5 | APIM tier for Commercial / GCC / DMLZ | (a) stay on PremiumV2; (b) migrate to Premium classic for multi-region; (c) stay now, multi-region as a later dated epic | **(a) stay on PremiumV2** (recommended); Government stays on Premium classic | #4442 Wave C is unblocked and reduces to the per-boundary SKU contract in `docs/` plus threading `capacity`; no migration, no new `azure-api.net` record. Recorded in `PRPs/backlog/apim-ai-gateway/PRP.md` (§ 2 table, § 2.4, Wave C, § 7) and on #4442. |
| Q11 | Sending mailbox for Graph email | (a) new shared mailbox per boundary; (b) reuse an existing one; (c) no email in v1 | **(a) new shared mailbox per boundary** (recommended) | W5-4 unchanged: gate `api-gateway.mailbox` names the Exchange steps; `docs/fiab/v3-tenant-bootstrap.md` gains the mailbox section. |
| Q12 | Teams channel | (a) shared Workflows only; (b) Workflows + personal bot; (c) none | **(a) Workflows only** (recommended) | D12 confirmed; the personal bot stays deferred with no review date until asked. |
| Q15 | Budget on an auto-created workspace cost center | (a) none until an owner sets one; (b) warn-only at a tenant default; (c) block at a tenant default | **(a) none** (recommended) | D8 confirmed; the Overview lists cost centers without a budget (W5-1). |
| Q14 | Price-list refresh | (a) per release plus an on-demand check that proposes versions; (b) per release only; (c) monthly job | **(a) per release + on-demand check** (recommended) | D10 confirmed; W4-4 includes the "Check for newer prices" admin action producing proposed versions for review. |
| Q13 | Who creates the Government service principal for cross-cloud? | (a) the operator, in the Government tenant, documented steps; (b) the Gov bootstrap creates it; (c) defer the procedure | **(a) the operator** (recommended) | W8-4 unchanged; `docs/fiab/api-gateway/cross-cloud.md` carries the steps; Loom stores the secret write-only in the management vault. |
| PR #5180 | What happens to the docs PR | (a) record these answers, then merge; (b) merge now, record after; (c) hold for review | **(a) record, then merge** (recommended) | This file and the edits it names land on the PR branch; the PR merges once its checks are green again. |
| Spikes | Do the plane's W0 and #4442 Wave 0 share their probe runs? | (a) both clouds, one shared probe per cloud; (b) both clouds, separate probes per program; (c) Government first, then Commercial | **(a) one shared probe per cloud** (recommended). The operator first asked whether measurement must happen in both clouds; it must and it does. | Clarified in `apigw-W00-measurement-spike.md`: every measurement runs in Commercial (build pool, live PremiumV2 gateway) **and** GCC-High (Actions, Premium classic gateway); GCC (no tenant) and IL5 (no deploy run) are recorded as not measured. The Government workflow run and the Commercial pool run each serve both programs; results post to `W0-RECEIPT.md`, #4442 and #4460. |

## What this does not change

The 2026-10-28 decisions Q1–Q8 (`OPERATOR-DECISIONS-2026-10-28.md`), the
wave order, the review assignments (W2, W3, W5, W6, W7, W8 required) and the
model assignments (Sonnet per wave; Opus only for W2-1 and W3-4). W1 gains one
item and about one session.
