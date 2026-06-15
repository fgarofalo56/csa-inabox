# information-protection — parity with Microsoft Purview Information Protection

**Surface:** `/admin/security` → Information Protection tab (`MipPanel`).
**Source UI:** Microsoft Purview compliance portal → Information Protection →
Labels / Label policies (https://compliance.microsoft.com/informationprotection).
Grounded in Microsoft Learn:
- Create & configure sensitivity labels + policies — https://learn.microsoft.com/purview/create-sensitivity-labels
- `New-Label` / `Set-Label` / `Remove-Label` — Security & Compliance PowerShell
- `New-LabelPolicy` / `Set-LabelPolicy` / `Remove-LabelPolicy` / `Get-LabelPolicy`
- List sensitivity labels (Graph beta) — https://learn.microsoft.com/graph/api/security-informationprotection-list-sensitivitylabels?view=graph-rest-beta
- `evaluateApplication` (service-principal) — https://learn.microsoft.com/graph/api/security-sensitivitylabel-evaluateapplication?view=graph-rest-beta
- App-only auth for SCC PowerShell — https://learn.microsoft.com/powershell/exchange/app-only-auth-powershell-v2

## The hard constraint that shapes this surface

Microsoft Graph exposes **read** of sensitivity-label *definitions* app-only
(`InformationProtectionPolicy.Read.All`) and the `evaluateApplication`
recommendation. Graph has **no app-only read for label policies at all**, and
only a thin, low-fidelity label-definition create surface under the separate
`/beta/security/dataSecurityAndGovernance/sensitivityLabels` navigation property
— which cannot publish a policy, cannot scope a label to workloads, and lacks
full color/encryption/marking fidelity, so Loom does **not** use it. Full
label + policy CRUD lives in Security & Compliance PowerShell. So Loom splits
the surface:

- **READ (label definitions) + evaluate** → Microsoft Graph beta via the Console
  UAMI (`mip-graph-client.ts`). Works whenever `LOOM_MIP_ENABLED=true`.
- **Policy reads + all CRUD** → SCC PowerShell sidecar (`scc-labels-client.ts` →
  `azure-functions/scc-labels`) with certificate-based app auth. Works when
  `loomMipAdminEnabled=true` and the SCC app + cert are provisioned.

This also fixed the task's reported HTTP **400**: the old policies call hit
`GET /beta/security/informationProtection/policy/labels`, a path that does not
exist app-only. Policy reads now go through `Get-LabelPolicy`.

## Purview feature inventory → Loom coverage

| Capability (Purview portal) | Loom coverage | Backend per control |
|---|---|---|
| List sensitivity labels (name, color, sensitivity, parent, protection) | ✅ Sensitivity labels tab table | `GET /beta/security/informationProtection/sensitivityLabels` (UAMI) |
| Create label (name, tooltip, color, parent, encryption) | ✅ New label wizard (guided form) | `POST /api/admin/security/mip/labels` → `New-Label` |
| Edit label (display name, tooltip, comment, color, encryption) | ✅ Edit label wizard | `PATCH /api/admin/security/mip/labels/[id]` → `Set-Label` |
| Delete label | ✅ Delete (confirm dialog) | `DELETE /api/admin/security/mip/labels/[id]` → `Remove-Label` |
| List label policies (published labels, mandatory, default, scope) | ✅ Label policies tab table (scope column shows All / per-workload counts) | `GET /api/admin/security/mip/policies` → `Get-LabelPolicy` (returns Exchange/SharePoint/OneDrive/ModernGroup locations) |
| Create label policy (labels, **locations/scope**, mandatory, default) | ✅ New policy wizard — label checklist + **Publish-to scope** (All locations / Specific: Exchange, SharePoint, OneDrive, M365 Groups identity boxes) + toggles | `POST /api/admin/security/mip/policies` → `New-LabelPolicy -ExchangeLocation/-SharePointLocation/-OneDriveLocation/-ModernGroupLocation` (+ `Set-LabelPolicy` advanced settings) |
| Edit label policy (labels, scope, mandatory, default) | ✅ Edit policy wizard (scope prefilled from live policy; edits diff to add/remove) | `PATCH /api/admin/security/mip/policies/[id]` → `Set-LabelPolicy` `Add*/Remove*Location` + `Add/RemoveLabels` (sidecar diffs against `Get-LabelPolicy`) |
| Delete label policy | ✅ Delete (confirm dialog) | `DELETE /api/admin/security/mip/policies/[id]` → `Remove-LabelPolicy` |
| Apply a label to content | ✅ Apply label wizard (pick item → pick label → apply) | `PUT /api/items/[type]/[id]/sensitivity-label` (validates taxonomy + policy, writes Cosmos + Purview Atlas) |
| Auto-label recommendation | ✅ "Get recommendation" in Apply tab — renders the recommended label as a themed chip (swatch + name mapped to the live taxonomy) plus the content-marking / encryption actions MIP would apply, with a "Use this label" shortcut and a collapsible raw-response view | `POST /api/admin/security/mip/evaluate` → `sensitivityLabels/evaluateApplication` |
| Encryption / RMS template detail editor | ⚠️ encryption ON/OFF toggle only (full RMS template config is a Purview-portal deep surface) | `New-/Set-Label -EncryptionEnabled` |
| Adaptive scopes + location exceptions (`*LocationException`, `ExchangeAdaptiveScopes`) | ⚠️ static locations only (All / explicit identities); adaptive scopes + exception lists are a Purview-portal deep surface, not yet built | `New-/Set-LabelPolicy` exception params (available, not wired) |

All config is via **guided forms / wizards / checklists** — no raw JSON
(per `loom-no-freeform-config`).

## Honest gates (no-vaporware)

- `LOOM_MIP_ENABLED` unset → 503 `mip_not_configured`: reads/evaluate gate with
  env var + AppRoles + bootstrap step.
- `loomMipAdminEnabled` unset / SCC sidecar unwired → 503 `mip_admin_not_configured`:
  CRUD + policy reads render a `NotConfiguredBar` naming the SCC app roles
  (Exchange.ManageAsApp + Compliance Administrator), the cert, the bicep module,
  and `provision-scc-labels-sidecar.sh`. The full UI surface still renders.

## Per-cloud matrix

| Boundary | Label reads / evaluate (Graph) | Policy reads + CRUD (SCC) |
|---|---|---|
| Commercial | ✅ `graph.microsoft.com` | ✅ default SCC endpoint |
| GCC | ✅ `graph.microsoft.com` | ✅ default SCC endpoint |
| GCC-High (L4) | ⚠️ Graph MIP beta unavailable → honest gate; `LOOM_MIP_GRAPH_BASE=graph.microsoft.us` wired | ✅ `sccConnectionUri=https://ps.compliance.protection.office365.us` |
| DoD / IL5 (L5) | ⚠️ Graph MIP beta unavailable → honest gate | ✅ Gov SCC endpoint via `sccConnectionUri` |

In Gov boundaries where Graph MIP reads are unavailable, the CRUD path can still
operate via SCC PowerShell; the read/evaluate panels render the documented gate
rather than fabricating labels.

## Backend / infra summary

- BFF routes: `app/api/admin/security/mip/{labels,labels/[id],policies,policies/[id],evaluate,applicable-items}/route.ts`
- Clients: `lib/azure/mip-graph-client.ts` (Graph reads/evaluate), `lib/azure/scc-labels-client.ts` (SCC proxy)
- Sidecar: `azure-functions/scc-labels` (PowerShell)
- Bicep: `platform/fiab/bicep/modules/admin-plane/scc-labels-function.bicep` + `main.bicep`/`admin-plane/main.bicep` params (`loomMipAdminEnabled`, `sccAppId`, `sccCertThumbprint`, `sccOrganization`, `sccConnectionUri`)
- Bootstrap: `scripts/csa-loom/provision-scc-labels-sidecar.sh` + `.github/workflows/csa-loom-post-deploy-bootstrap.yml` step "Provision SCC labels sidecar"
- Tests: `lib/azure/__tests__/mip-graph-client.test.ts`, `lib/azure/__tests__/scc-labels-client.test.ts`
