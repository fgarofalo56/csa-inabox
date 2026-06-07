# data-pipeline / approval-activity — parity with Fabric "Office 365 → Send approval email" + Power Automate approvals

Source UI: Fabric Data pipeline → Activities → Outlook 365 "Send approval email" /
Power Automate "Start and wait for an approval"
(https://learn.microsoft.com/azure/data-factory/control-flow-webhook-activity,
https://learn.microsoft.com/connectors/office365/).

Backend (Azure-native DEFAULT, no Fabric / Power Automate):
- Pipeline activity: native ADF/Synapse **WebHook** activity (`Microsoft.DataFactory` api `2018-06-01`).
- Approval engine: **Consumption Logic App** (`Microsoft.Logic/workflows@2019-05-01`) +
  **Office 365 Outlook** API connection (`Microsoft.Web/connections@2016-06-01`,
  `office365` managed API), deployed by
  `platform/fiab/bicep/modules/integration/approval-logicapp.bicep`.
- Trigger URL fetched by the Console BFF via ARM `listCallbackUrl`.

## How the approval round-trip works

1. The pipeline runs an **Approval (Logic App)** activity (Loom palette key
   `ApprovalWebhook`, ADF wire type `WebHook`). It POSTs to the Logic App's HTTP
   `manual` trigger. ADF injects `callBackUri` into the body alongside
   `{ pipelineName, runId, approverEmail }`.
2. The Logic App runs **Send_approval_email** (O365 `/approvalmail/$subscriptions`)
   and blocks until the approver clicks **Approve** or **Reject** in their inbox.
3. The Logic App POSTs back to `callBackUri`:
   - **Approve** → `{ StatusCode: 200, Output: {...} }` → the WebHook activity
     succeeds and the pipeline **continues**.
   - **Reject** → `{ StatusCode: 400, Error: {...} }` → the activity **fails**,
     failing that branch (downstream "Upon Success" edges do not run).
   `reportStatusOnCallBack: true` makes the callback body drive activity status.

## Fabric / Power Automate feature inventory → Loom coverage

| Capability | Loom coverage | Backend |
| --- | --- | --- |
| Add "approval" step to a pipeline | ✅ built — **Approval (Logic App)** palette entry (Control flow) | native ADF `WebHook` activity |
| Pause pipeline until a human responds | ✅ built — WebHook + `callBackUri` round-trip | Logic App async `Request` trigger |
| Send approval email with Approve/Reject options | ✅ built — `Send_approval_email` action | O365 Outlook `/approvalmail/$subscriptions` |
| Choose recipient | ✅ built — per-run pipeline parameter `approverEmail` (Parameters tab) + module default `defaultApproverEmail` | trigger body `approverEmail` |
| Set approval timeout / SLA | ✅ built — **Approval timeout** field (`timeout`, d.hh:mm:ss, max 90d) | WebHook `timeout` |
| Continue on approve | ✅ built — Approve → callback 200 | Logic App `Callback_approved` (HTTP) |
| Fail branch on reject | ✅ built — Reject → callback 400 | Logic App `Callback_rejected` (HTTP) |
| Record approver / decision | ✅ built — callback `Output.approver` / `respondedAt` from `ResponseAuthor` | O365 response body |
| Provision / link the approval engine | ✅ built — **Fetch trigger URL** button in the activity Settings tab | `GET /api/items/data-pipeline/[id]/approval-logicapp` → ARM `listCallbackUrl` |
| Engine not deployed | ⚠️ honest-gate — warning MessageBar naming `approval-logicapp.bicep` + `LOOM_APPROVAL_LOGIC_APP_NAME` | route 503 `{ gate: { reason, remediation } }` |
| O365 mailbox not yet authorized | ⚠️ honest-gate (one-time admin) — see `docs/fiab/v3-tenant-bootstrap.md` | OAuth connection consent |

Zero ❌. The only non-functional states are honest infra/tenant gates.

## Backend per control

- **Fetch trigger URL** → `GET /api/items/data-pipeline/[id]/approval-logicapp?workspaceId=…`
  → `ChainedTokenCredential(UAMI, Default)` → ARM
  `POST …/workflows/{name}/triggers/manual/listCallbackUrl?api-version=2019-05-01`.
  Cloud-aware: `management.usgovcloudapi.net` when `AZURE_CLOUD=AzureUSGovernment`
  (GCC-High / IL5), else `management.azure.com`.
- **url / timeout / reportStatusOnCallBack** fields → patched onto the activity
  `typeProperties`, saved + published through the existing data-pipeline Save /
  Publish routes (real ADF `upsertPipeline`).

## Per-cloud

| Boundary | Logic App tier | ARM endpoint | Trigger URL domain | O365 connector |
| --- | --- | --- | --- | --- |
| Commercial | Consumption | management.azure.com | *.logic.azure.com | Standard OAuth |
| GCC | Consumption | management.azure.com | *.logic.azure.com | GCC tenant OAuth |
| GCC-High | Consumption | management.usgovcloudapi.net | *.logic.azure.us | re-auth with AzureUSGovernment endpoint |
| IL5 | Consumption (Standard recommended for full VNet boundary) | management.usgovcloudapi.net | *.logic.azure.us | as GCC-High; unclassified coordination only |

## Verification

Run a pipeline with an Approval (Logic App) activity (a `string` parameter
`approverEmail` declared): a real approval email is sent; **Approve** → the
pipeline continues; **Reject** → the branch fails. With the Logic App absent
(or `LOOM_APPROVAL_LOGIC_APP_NAME` unset) the **Fetch trigger URL** button
surfaces a warning MessageBar naming `approval-logicapp.bicep` +
`LOOM_APPROVAL_LOGIC_APP_NAME` — not a dead button.
