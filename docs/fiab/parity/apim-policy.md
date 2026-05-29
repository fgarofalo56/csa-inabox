# apim-policy — parity with Azure API Management → Policies

Source UI: Azure portal → API Management policy editor (https://learn.microsoft.com/azure/api-management/api-management-howto-policies)

## Azure feature inventory

| # | Capability | Azure surface |
|---|------------|---------------|
| 1 | Policy XML editor (Monaco) | Policy code editor |
| 2 | Apply at scopes: Global / API / Product / Operation | scope selector |
| 3 | Policy snippets / templates (rate-limit, validate-jwt, cors, set-header, mock…) | "+ Add policy" gallery |
| 4 | Validate well-formed XML | client-side parse |
| 5 | Save to scope (real ARM PUT) | Save |

## Loom coverage

| # | Status | Notes |
|---|--------|-------|
| 1 | built ✅ | `MonacoTextarea` language=xml |
| 2 | built ✅ | scope Dropdown (service/api/product/operation) + id inputs |
| 3 | built ✅ | Snippet gallery inserts proven APIM snippets into the editor at the cursor/inbound section |
| 4 | built ✅ | `isWellFormedXml` + Validate ribbon |
| 5 | built ✅ | PUT `/api/items/apim-policy/[id]` → `upsertPolicy` |

## Backend per control

- Load/Save → `getPolicy` / `upsertPolicy` (ARM `…/policies/policy`)
- Snippets are static APIM policy XML (the same snippets the portal gallery ships) inserted into the editor buffer — no backend.
