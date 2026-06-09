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

## Tests

`vitest run` covers the pure NCRONTAB window-matching logic
(`src/cron-match.test.ts`).
