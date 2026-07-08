# linked-service — parity with the ADF / Synapse Studio "Linked services" (Manage hub)

> Parity audit per `.claude/rules/ui-parity.md` + `.claude/rules/no-vaporware.md`
> + `.claude/rules/no-fabric-dependency.md`. Graded conservatively.

**What this is.** In the real product a **linked service** is not a standalone
app — it's a **sub-feature of Azure Data Factory / Synapse Studio**, managed in
the **Manage hub → Connections → Linked services** blade, and consumed inside
the pipeline / dataset / data-flow authoring surfaces. CSA Loom surfaces it in
BOTH places:

- **As a first-class catalog item** (`linked-service`) with its own editor —
  the subject of this doc.
- **Inline** inside the pipeline / Copy-job / dataset editors, where you pick or
  create a linked service to bind an activity (same shared gallery component).

**Source UI (grounded in Microsoft Learn, not memory):**
- Linked services concept: https://learn.microsoft.com/azure/data-factory/concepts-linked-services
- Manage hub (where linked services live in ADF/Synapse Studio): https://learn.microsoft.com/azure/data-factory/author-management-hub
- Connector overview (the connector gallery): https://learn.microsoft.com/azure/data-factory/connector-overview
- Store credentials in Azure Key Vault: https://learn.microsoft.com/azure/data-factory/store-credentials-in-key-vault
- REST — `Microsoft.DataFactory/factories/linkedservices`: https://learn.microsoft.com/rest/api/datafactory/linked-services

**Loom surface:**
- Editor: `apps/fiab-console/lib/editors/linked-service-editor.tsx` — a thin
  wrapper that hosts the shared, sibling-owned
  `LinkedServiceGallery` (`lib/components/pipeline/linked-service-gallery.tsx`)
  in **manage mode**, plus a Backend selector (ADF default / Synapse opt-in).
- Catalog: `apps/fiab-console/lib/catalog/item-types/data-factory.ts`
  (`slug: 'linked-service'`, `restType: 'LinkedService'`, category `Data Factory`).
- BFF: `app/api/adf/linked-services/route.ts` (list/create),
  `…/[name]/route.ts` (get/update/delete), `…/test/route.ts` (Test connection);
  Synapse opt-in path `app/api/synapse/linkedservices/**`.

**Backend reality check.** List/create/edit/delete call real ARM
(`Microsoft.DataFactory/factories/linkedservices`, api 2018-06-01) against the
env-pinned deployment-default factory; the Synapse path calls the Synapse dev
plane. Test connection PUTs a transient linked service and validates it
(`testLinkedService`). Secrets are written as ARM `secureString` (Key
Vault-backed where selected) — never round-tripped as plaintext, never freeform
JSON (`loom_no_freeform_config`). Azure-native default — no Fabric dependency;
an unset factory env shows an honest infra-gate MessageBar while the gallery
still renders.

---

## Azure/Fabric feature inventory → Loom coverage → backend

Legend: built ✅ · honest-gate ⚠️ · MISSING ❌

| # | ADF/Synapse Manage-hub capability | Loom | Where / backend |
|---|---|---|---|
| 1 | List existing linked services with type/status | ✅ built | Gallery manage mode → `GET /api/adf/linked-services` (`listLinkedServices`) |
| 2 | **Connector gallery** grouped by category (Azure / Database / File / NoSQL / Generic protocol / Services) | ✅ built | 31-connector gallery, searchable + category-grouped |
| 3 | New linked service → **structured per-connector form** | ✅ built | per-connector field set (never JSON textarea) |
| 4 | **Authentication selector** (Managed Identity / account key / SAS / service principal) | ✅ built | auth dropdown + auth-specific fields |
| 5 | Secrets stored securely (Key Vault / `secureString`) | ✅ built | written as ARM `secureString`; KV-backed reference when selected |
| 6 | **Test connection** | ✅ built | `POST /api/adf/linked-services/test` → `testLinkedService` (transient PUT + validate) |
| 7 | Create / save | ✅ built | `POST /api/adf/linked-services` (ARM upsert) |
| 8 | Edit an existing linked service | ✅ built | `PUT …/[name]` |
| 9 | Delete a linked service | ✅ built | `DELETE …/[name]` |
| 10 | Backend switch — **Synapse workspace** linked services | ✅ built (opt-in) | Backend dropdown → `app/api/synapse/linkedservices/**` |
| 11 | Parameterize a linked service (`parameters` / `@linkedService().x`) | ❌ MISSING | structured form only; no parameter authoring |
| 12 | Self-hosted / managed-VNet IR selection on the linked service | ⚠️ partial | connectivity via factory default IR; no per-LS IR picker in this surface |
| 13 | Managed private endpoint creation from the connection blade | ❌ MISSING | not surfaced here (see `integration-runtime` / networking surfaces) |
| 14 | Edit as JSON (portal "Edit JSON" escape hatch) | ❌ MISSING | intentionally omitted — structured-only per `loom_no_freeform_config` |

**Grade: B.** Browse → structured auth form → Test → create/edit/delete round-trips
to real ARM on the Azure-native default; core Manage-hub workflow is one-for-one.
Gaps are advanced authoring (LS parameters, per-LS IR/managed-PE picker) tracked
against the pipeline/networking surfaces, not stubs.
