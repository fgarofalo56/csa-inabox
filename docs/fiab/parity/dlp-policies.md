# dlp-policies — parity with Microsoft Purview Data Loss Prevention

**Surface:** Governance → Policies (`app/governance/policies/page.tsx`)
**Source UI:** Microsoft Purview portal → Data loss prevention → Policies
- https://purview.microsoft.com/datalossprevention
- Learn: https://learn.microsoft.com/purview/dlp-learn-about-dlp
- Default policy: https://learn.microsoft.com/purview/dlp-o365-default-policy
- Policy templates: https://learn.microsoft.com/purview/dlp-policy-templates-include
- Sensitive info types: https://learn.microsoft.com/purview/sit-sensitive-information-type-learn-about

## Design note — Azure-native, no Fabric / no hard Graph dependency

DLP policies in Loom are a **Loom-native governance object** persisted to Cosmos
(`tenant-settings` → `policies:<tenantId>`), read by downstream enforcement
(Synapse SQL / lakehouse query gate / restrict-access). There is **no Microsoft
Fabric / Power BI dependency**. The *live* Purview DLP data-plane (violations via
Microsoft Graph `/v1.0/security/alerts_v2`, policy reads via
`/beta/informationProtection/dataLossPreventionPolicies`) is an **honest,
opt-out-able enhancement** — when its AppRoles aren't consented the policy
library + authoring + the seeded default policy still work (config-only state,
per `no-vaporware.md`).

DLP is **ON by default** (best practice). `LOOM_DLP_ENABLED` is an admin
**opt-OUT** (`=false` disables live Graph reads); it is no longer an opt-in gate.
The app-code default (`dlpEnabled()` in `lib/azure/dlp-graph-client.ts`) treats
unset as enabled; `admin-plane/main.bicep` emits `LOOM_DLP_ENABLED=true` and the
bicepparams default it to `true`.

## Purview feature inventory → Loom coverage

| Purview capability | Loom coverage | Backend |
| --- | --- | --- |
| Default DLP policy, on out-of-box (credit-card, block on external share) | ✅ Seeded **Loom Baseline Data Protection** policy (credit-card + SSN + bank account + secrets → Block external), enabled by default | `lib/governance/policy-store.ts` seeds `defaultDlpPolicyBody()` into a new tenant doc |
| Ready-to-use policy templates (PII / Financial / PCI / HIPAA / GLBA / GDPR / …) | ✅ **Policy library** — 9 curated presets, one-click Enable | `GET/POST /api/governance/dlp/library` + `lib/governance/dlp-policy-library.ts` |
| Create custom policy (conditions → sensitive-info types → actions → scope) | ✅ **New policy** DLP wizard — multi-select SITs + condition (external / any) + action (Audit/Block/Notify/Quarantine) + scope (tenant/domain/workspace). Dropdowns/wizard, no freeform JSON | `POST /api/governance/policies` persists structured `dlp` rule |
| Sensitive information types catalog | ✅ 28-type curated SIT catalog (Financial / Identity / Health / Credentials / General), verbatim Purview names | `SENSITIVE_INFO_TYPES` in `dlp-policy-library.ts` |
| Enable / disable a policy | ✅ Per-row Switch (PUT) | `PUT /api/governance/policies` |
| Delete a policy | ✅ Per-row Delete (DELETE) | `DELETE /api/governance/policies` |
| DLP violations / alerts | ✅ Live violations table (Graph `alerts_v2`, all clouds) | `GET /api/governance/dlp/violations` |
| Restrict access on a match (real revoke) | ✅ Restrict-access dialog (ADLS RBAC / ACL, Synapse `DENY`, ADX role) | `POST /api/governance/dlp/restrict` |
| Trigger a content scan | ⚠️ Honest gate — no Graph REST triggers the Purview scanner; portal / `Start-Scan` link surfaced | `POST /api/governance/dlp/scan` (501 + remediation) |
| Policy simulation / "Test policy" | ⚠️ Honest gate — no public Graph simulate endpoint; portal link surfaced | `evaluatePolicy()` (501 + remediation) |
| DLP policy authoring via Graph (Gov/DoD) | ⚠️ Honest gate — `/beta` DLP policy segment not exposed on `graph.microsoft.us` / `dod-graph.microsoft.us`; Loom-native library + Purview compliance portal cover it | `graphDlpPolicyApiAvailable()` gate |

Zero ❌. Every row is built ✅ or an honest infra-gate ⚠️ that still renders the
full surface.

## Policy library presets (each maps 1:1 to a real Purview template)

| Preset | Category | Sensitive info types | Action | Template |
| --- | --- | --- | --- | --- |
| Loom Baseline Data Protection (default) | Security | Credit Card, U.S. SSN, U.S. Bank Account, Azure Storage Key, Client secret/API key, Password | Block (external) | Extends the Microsoft default Office 365 DLP policy |
| U.S. PII Protection | Privacy | SSN, ITIN, Passport, Driver's License, U.S. Address | Block (external) | U.S. PII Data Enhanced |
| Financial Data | Financial | Credit Card, U.S. Bank Account, ABA Routing | Block (external) | U.S. Financial Data |
| PCI DSS (Payment Cards) | Regulatory | Credit Card | Block (external) | PCI DSS |
| Healthcare / HIPAA | Healthcare | SSN, DEA, Address, Full Names, ICD-9, ICD-10, Medical Terms | Block (external) | U.S. HIPAA Enhanced |
| Financial Services / GLBA | Regulatory | Credit Card, Bank Account, ITIN, SSN, Driver's License, Passport, Address | Block (external) | U.S. GLBA Enhanced |
| EU Privacy / GDPR | Privacy | Full Names, EU Address, Passport, EU National ID, EU Debit Card | Notify (external) | GDPR Enhanced |
| Secrets & Credentials | Security | Azure Storage Key, SAS, Connection string, Client secret/API key, Password, SQL conn string, X.509 key, Login credentials | Block (any) | Credential SITs |
| Regulated Data Residency | Regulatory | Credit Card, SSN, Bank Account, IBAN, SWIFT | Block (external) | U.S. State Breach Notification |

## Verification

- Guard cascade (bff-errors, route-guards, env-sync, no-freeform, docs-hygiene,
  no-raw-px, no-bare-client-fetch, duplicate-env, sql-quoting, bicep-sync): all
  green.
- Live E2E: enable a preset (`POST /api/governance/dlp/library {presetId}`) →
  policy appears in the table with its structured rule; toggle/delete; author a
  custom DLP policy via the wizard. With `LOOM_DLP_ENABLED` unset the library +
  default policy render + persist; live violations show the honest AppRole gate
  until Graph consent lands.
