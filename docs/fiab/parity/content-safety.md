# content-safety — parity with Azure AI Content Safety

Source UI: Content Safety Studio (https://contentsafety.cognitive.azure.com/) +
Foundry portal → Guardrails + controls (https://ai.azure.com/explore/contentsafety)
(https://learn.microsoft.com/azure/ai-services/content-safety/overview,
https://learn.microsoft.com/azure/ai-services/content-safety/concepts/harm-categories,
https://learn.microsoft.com/azure/ai-services/content-safety/how-to/use-blocklist).

Azure-native backend (no Fabric): **Azure AI Content Safety** (Cognitive
Services `ContentSafety` kind, data-plane analyze APIs + blocklist management)
and **`Microsoft.CognitiveServices/accounts/{name}/raiPolicies`** (ARM,
2024-10-01) for RAI content-filter policies. Clients: `foundry-client`
(moderation), `foundry-cs-client` (RAI policies + blocklists).

## Content Safety inventory (grounded in Learn)

1. **Moderate text content** — analyze text across four harm categories (Hate,
   Sexual, Violence, Self-harm) at severity 0/2/4/6, plus Accepted/Rejected
   against configured filters.
2. **Moderate image content** — same four categories, severity levels, on an
   uploaded/base64 image.
3. **Blocklists** — create custom term lists (≤10K terms, regex support); add /
   remove blocklist items; attach to text analysis.
4. **RAI content-filter policies** — per-category severity thresholds for Prompt
   vs Completion, blocking/annotate, base policy (`Microsoft.DefaultV2`);
   create/update/delete.
5. Advanced (studio): Prompt Shields (jailbreak/indirect attack), Groundedness
   detection, Protected material, Custom categories, monitoring dashboard.

## Loom coverage

| Content Safety capability | Loom coverage | Backend (real REST) |
| --- | --- | --- |
| **Moderate text** (4 categories × severity) | ✅ built — Moderation tab, text box → severity result | `POST /api/items/content-safety` `{kind:'text'}` → `moderateText` |
| **Moderate image** (upload / base64) | ✅ built — Moderation tab, file picker → base64 → analyze | `POST /api/items/content-safety` `{kind:'image'}` → `moderateImage` |
| List existing RAI policies | ✅ built — Content filters tab table | `GET /api/items/content-safety/rai-policies` (ARM listRaiPolicies) |
| **Create / update RAI policy** — 4 harm categories × {Prompt, Completion}, severity threshold, enabled/blocking, base policy | ✅ built — filter-row grid seeded from `RaiPolicyContentFilter`, Save | `POST /api/items/content-safety/rai-policies` (ARM upsertRaiPolicy) |
| Edit / clone system-managed policy (read-only → clone) | ✅ built — `editPolicy` clears name to force user-managed clone | `POST .../rai-policies` |
| Delete RAI policy | ✅ built — delete action | `DELETE /api/items/content-safety/rai-policies?name=` |
| **Blocklists** — list / create / delete | ✅ built — Blocklists tab | `GET/POST/DELETE /api/items/content-safety/blocklists` |
| **Blocklist items** — add (text + description + isRegex) / remove / list | ✅ built — per-selected-blocklist item editor | `GET/POST/DELETE /api/items/content-safety/blocklists/items?name=` |
| Deep-link to Content Safety Studio | ✅ built — ribbon link to `contentsafety.cognitive.azure.com` | n/a |
| Prompt Shields / Groundedness / Protected material / Custom categories | ⚠️ honest-gate — advanced guardrails surfaced via the studio deep-link (single-account, tenant-level); not re-implemented in-editor | studio |
| Content Safety account not deployed | ⚠️ honest-gate — 503 `NotDeployed`/`CsNotConfigured` → MessageBar names the missing account/env var; full UI still renders | n/a |

Zero ❌ for the core moderate / filter / blocklist surface. Every severity
threshold is a real persisted ARM policy value (no fabricated thresholds, per
issue #1410 / `no-vaporware.md`).

## Backend per control

- Moderation (text/image): `POST /api/items/content-safety` → `foundry-client.{moderateText,moderateImage}`.
- Policy list/gate: `GET /api/items/content-safety` → `listContentSafetyPolicies`.
- RAI policies: `/api/items/content-safety/rai-policies` (GET/POST/DELETE) → `foundry-cs-client.{listRaiPolicies,upsertRaiPolicy,deleteRaiPolicy}` over `Microsoft.CognitiveServices/accounts/{name}/raiPolicies`.
- Blocklists: `/api/items/content-safety/blocklists` (GET/POST/DELETE) — data-plane text blocklist management.
- Blocklist items: `/api/items/content-safety/blocklists/items?name=` (GET/POST/DELETE).
- Honest gates: `NotDeployedError` → 503 with `hint`; `CsNotConfiguredError` → 503 when no model-hosting account is configured.
