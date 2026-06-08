# lakehouse-shortcuts-external — parity with Fabric OneLake external shortcuts

Source UI: Fabric OneLake **New shortcut → External sources** (Amazon S3,
Google Cloud Storage, ADLS Gen2, Dataverse) +
https://learn.microsoft.com/fabric/onelake/onelake-shortcuts

Azure-native, NO Fabric dependency: the shortcut registry is Cosmos; the
read-through binding is Synapse Serverless / Databricks Unity Catalog; external
credentials live ONLY in Azure Key Vault as a `secretRef` (never in Cosmos, the
item doc, the response body, or logs).

## Fabric feature inventory (per source type)

| # | Fabric capability | Source |
|---|-------------------|--------|
| 1 | Pick the source from a card grid with a per-provider **logo** | all |
| 2 | Enter a **connection / credential** (S3 key+secret or role, GCS service-account JSON, ADLS SAS, Dataverse link) | S3/GCS/ADLS/Dataverse |
| 3 | Credential is stored in a secret store, not the shortcut | all external |
| 4 | **Browse** the remote object store and pick a folder/file as the target | S3/GCS/ADLS/Dataverse |
| 5 | Name the shortcut + choose section (Files/Tables) + sub-folder | all |
| 6 | **Test / validate** connectivity (live OK / actionable error) | all |
| 7 | List / Delete shortcuts; Tables shortcuts register a queryable table | all |
| 8 | Sovereign-cloud correctness (GovCloud / GCC-High) | all |

## Loom coverage

| # | Status | Where |
|---|--------|-------|
| 1 | ✅ built | `shortcut-wizard.tsx` `SHORTCUT_SOURCE_CARDS` + inline-SVG `ShortcutSourceLogo` (CSP-safe, no CDN) |
| 2 | ✅ built | `ExternalCredsForm` — typed fields (key/secret, IAM role ARN, SA-JSON, SAS, Synapse-Link path); NO freeform JSON config (loom-no-freeform-config) |
| 3 | ✅ built | `POST /api/lakehouse/shortcuts/credentials` → `putShortcutSecret()` → KV; returns ONLY `secretName`, value never echoed; row keeps `credentialRef.keyVaultSecret` |
| 4 | ✅ built | `RemoteBrowseTree` → `GET /api/lakehouse/shortcuts/browse` → `shortcut-client.ts` (`listS3Objects` SigV4, `listGcsObjects` JWT, `browseAdls`, `listDataverseEntities`) |
| 5 | ✅ built | wizard steps 2–3 (name moved up for external; section + sub-folder + format) |
| 6 | ✅ built | `POST /api/lakehouse/shortcuts/test` (existing) — `testEngineObject` SELECT TOP 1 / `resolveAndTestAdls` listPaths |
| 7 | ✅ built | `GET/POST/DELETE /api/lakehouse/shortcuts` (existing) + `createTablesShortcut` |
| 8 | ✅ built / ⚠️ gate | S3 GovCloud regions in the region picker; GCS honest-gates outside Commercial (`gcs_not_available_in_cloud`); ADLS inherits sovereign DFS suffix |

Zero ❌ — every inventory row is built or honest-gated.

## Backend per control

- **Source cards / logos** — static client config, inline SVG (no network).
- **Save credential** — `POST /api/lakehouse/shortcuts/credentials` →
  `putShortcutSecret(name, value)` (KV REST `PUT /secrets`, Console UAMI,
  `LOOM_SHORTCUT_KEYVAULT` → falls back to `LOOM_KEY_VAULT_URI`). Honest-gate
  `key_vault_not_configured` names `LOOM_SHORTCUT_KEYVAULT`.
- **Browse tree** — `GET /api/lakehouse/shortcuts/browse`:
  - S3 → `listS3Objects` — `GET /?list-type=2&delimiter=/` signed AWS SigV4
    (Node `crypto` HMAC-SHA256, no `@aws-sdk`), XML parsed to folders + files.
  - GCS → `listGcsObjects` — self-signed RS256 JWT → `oauth2.googleapis.com/token`
    → `storage/v1/b/<bucket>/o`.
  - ADLS → `browseAdls` → adls-client `listPaths` on the Console UAMI.
  - Dataverse → `listDataverseEntities` → lists the Synapse-Link export folders
    in ADLS (Azure Synapse Link for Dataverse → ADLS Gen2 is the Azure-native
    Dataverse backend).
- **Create** — `POST /api/lakehouse/shortcuts` → `bindExternalSource`
  (UC storage credential + external location, or Synapse DATABASE SCOPED
  CREDENTIAL + EXTERNAL DATA SOURCE) + `createTablesShortcut`.
- **Test** — `POST /api/lakehouse/shortcuts/test` → real engine SELECT / listPaths.

## Key Vault / Bicep

- Console UAMI already holds **Key Vault Secrets Officer** on the admin-plane
  vault (`keyvault.bicep` line 78) — covers set/get/delete for shortcut
  credentials; no new role assignment required.
- `LOOM_SHORTCUT_KEYVAULT` env var added to the Console Container App
  (`admin-plane/main.bicep`, param `loomShortcutKeyVaultUri`, defaults to the
  admin-plane vault so the engine binding and browse read the same vault).

## Security invariants

- The credential VALUE is written to KV by the BFF and dropped from component
  state immediately; it is never returned in any response, never persisted in
  Cosmos, never logged.
- The shortcut row stores only `credentialRef.keyVaultSecret` (the name).
- IAM-role S3 cannot be live-browsed (no STS in-browser) → honest-gate
  `s3_iam_role_browse_unsupported`; the access-key path browses live.

## Verification

- `lib/azure/__tests__/shortcut-client.test.ts` — 11 tests: S3 SigV4 request
  line + auth header + XML parse, GovCloud endpoint, 403→`s3_auth_failure`; GCS
  JWT→token→list + cloud-boundary gate; ADLS delegation + 403 map; Dataverse
  abfss parse + list. All green.
- Live E2E (operator): create an S3 shortcut against a real bucket → the browse
  tree lists real objects; the KV secret exists at `loom-sc-s3-<lh>-<name>`
  (verified by name, value never echoed); Test returns live OK.
