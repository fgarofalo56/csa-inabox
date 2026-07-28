# fiab-report-subscriptions

CSA Loom — **report subscriptions** timer Function. Azure-native parity with
Fabric / Power BI "Subscribe to report".

On its schedule (`REPORT_SUBSCRIPTIONS_CRON`, NCRONTAB 6-field) it:

1. reads enabled subscriptions from the shared Cosmos `loom` database
   (`report-subscriptions`, PK `/reportId`),
2. for each subscription whose own schedule became due in the current tick
   window, renders the report via the **real Power BI ExportTo REST job**
   (`start → poll → download`) to PDF / PPTX / PNG,
3. archives the file to ADLS Gen2 (`report-exports` container, best-effort),
4. delivers it as an email attachment through the **report-subscription
   delivery Logic App** (ARM `listCallbackUrl` → POST), and
5. writes a `report-delivery-log` row (PK `/subscriptionId`) and stamps
   `lastRunAt` / `lastStatus` / `lastError` on the subscription.

No Microsoft Fabric dependency — Power BI REST is the Azure-native rendering
backend; ADLS Gen2 is the archive; a Consumption Logic App + Office 365
connector is the Azure-native delivery path.

## Identity & roles

The Function App identity (system-assigned by default; set `AZURE_CLIENT_ID` /
`LOOM_UAMI_CLIENT_ID` for a user-assigned identity) must hold:

- **Cosmos DB Built-in Data Contributor** on the Loom Cosmos account
  (data-plane sqlRoleAssignment — granted in post-deploy bootstrap,
  `scripts/csa-loom/grant-navigator-rbac.sh`),
- **Storage Blob Data Contributor** on `LOOM_ADLS_ACCOUNT`,
- **Logic App Contributor** on the delivery workflow (granted in
  `report-subscriptions-function.bicep` when the principalId is known, or in
  bootstrap),
- membership (**Member** or above) in each Power BI workspace it exports from.

## App settings

| Setting | Purpose |
| --- | --- |
| `LOOM_COSMOS_ENDPOINT` / `LOOM_COSMOS_DATABASE` | Loom Cosmos account + db (`loom`) |
| `REPORT_SUBSCRIPTIONS_CRON` | Function tick schedule (NCRONTAB 6-field) |
| `LOOM_ADLS_ACCOUNT` | ADLS Gen2 account for the export archive |
| `LOOM_SUBSCRIPTION_ID` | Subscription id for ARM `listCallbackUrl` |
| `LOOM_SUBSCRIPTION_LOGIC_APP_NAME` / `LOOM_SUBSCRIPTION_LOGIC_APP_RG` | Delivery Logic App (RG defaults to `LOOM_DLZ_RG`) |
| `LOOM_POWERBI_BASE` / `LOOM_ARM_ENDPOINT` / `LOOM_STORAGE_SUFFIX` | Sovereign-cloud endpoint overrides (Gov) |
| `LOOM_AOAI_ENDPOINT` / `LOOM_AOAI_DEPLOYMENT` / `LOOM_AOAI_API_VERSION` | B-N19d digest narration (unset -> the deterministic summary is delivered instead) |
| `LOOM_DLZ_SUBSCRIPTION_ID` | B-N19d: additional subscription sampled for platform metrics + alerts |

## B-N19d - scheduled insight digests (same tick, same delivery path)

This Function ALSO processes scheduled insight digests. `functions/
reportSubscriptions.ts` calls `runSubscriptions` and then `runInsightDigests`
inside the SAME invocation, using the same window, the same Cosmos database,
the same AAD credential, the same NCRONTAB matcher, and the same delivery Logic
App. There is deliberately no second scheduler and no second workflow; a digest
failure is caught separately so it can never fail or delay report delivery.

Per tick, for every enabled digest in `insight-digests` whose cron became due -
or which an operator queued from the console (`runNowRequestedAt`) - the engine:

1. resolves the Loom resources of the digest's stored `metricPlan` resource
   types via ARM (`/subscriptions/{sub}/resources`),
2. reads REAL Azure Monitor platform metrics over a window twice the lookback
   (so the previous and current halves come from one call per metric family),
3. reads REAL fired alert instances (`Microsoft.AlertsManagement/alerts`),
4. folds them into deltas and narrates on the Loom Azure OpenAI deployment
   (deterministic grounded fallback when AOAI is absent or fails),
5. delivers the HTML body through the delivery Logic App (`bodyHtml`, no
   attachment), and
6. appends an `insight-digest-log` row and stamps `lastRunAt` / `lastStatus`.

Extra RBAC for this path: **Monitoring Reader** at subscription scope
(`admin-plane/monitoring-reader-rbac.bicep`, `digestPrincipalId`) and
**Cognitive Services OpenAI User** on the AOAI/Foundry account (granted in
`report-subscriptions-function.bicep`).

`src/insight-digest-model.ts` is a deliberate narrow PORT of the console's pure
delta/prompt/HTML helpers (`apps/fiab-console/lib/insights/digest-model.ts`) -
the two apps have no shared workspace package. Both export
`DIGEST_MODEL_VERSION` and both test suites assert the same golden vectors, so
an unmirrored change fails CI on the other side.

## Tests

`vitest run` covers the pure NCRONTAB window-matching logic
(`src/cron-match.test.ts`) and the B-N19d digest model + port contract
(`src/insight-digest-model.test.ts`).
