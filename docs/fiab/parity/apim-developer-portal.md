# apim-developer-portal — parity with Azure API Management → Developer portal

> **rev — Wave-2 (2026-06-18): admin-dashboard Developer portal tab wired.** The
> Admin → API Management dashboard (`app/admin/api-management/page.tsx`) gained a
> **Developer portal** tab (`apim-developer-portal-pane.tsx`) backed by a new BFF
> route **`/api/apim/developer-portal`** (GET URLs + revision history, POST
> publish) over real ARM REST. Same wave also wired the **Backends** tab to full
> create/edit/delete (was list-only with dead buttons) and gave the **Policies**
> tab a real API/product scope picker (was the `apis/example` placeholder) plus a
> snippet inserter over the 1:1 XML editor.

**Source UI:** Azure portal → API Management instance → **Developer portal**
(Portal overview: open developer portal, open admin portal, Publish, revisions
list with "Make current and publish"; Enable CORS).
Grounded in Microsoft Learn:
- Developer portal overview / publish + revisions — https://learn.microsoft.com/azure/api-management/developer-portal-overview
- Access & customize the developer portal — https://learn.microsoft.com/azure/api-management/api-management-howto-developer-portal-customize
- PortalRevision REST (`portalRevisions/{id}` CreateOrUpdate, `isCurrent`) — https://learn.microsoft.com/rest/api/apimanagement/portal-revision
- Service resource properties (`developerPortalUrl`, `portalUrl`, `developerPortalStatus`, `managementApiUrl`) — https://learn.microsoft.com/javascript/api/@azure/arm-apimanagement/apimanagementserviceresource

**Loom surface:**
- Pane: `apps/fiab-console/lib/components/admin/apim-developer-portal-pane.tsx`
- BFF: `apps/fiab-console/app/api/apim/developer-portal/route.ts`
- Client (real ARM REST, `2024-06-01-preview`, UAMI ChainedTokenCredential):
  `apps/fiab-console/lib/azure/apim-client.ts` (`getServiceInfo`,
  `listPortalRevisions`, `publishPortalRevision`)

Legend: **built ✅** · **partial ⚠️** · **gated ⚠️** (honest infra-gate) · **MISSING ❌**

---

## Azure feature inventory → Loom coverage → Backend per control

| Azure capability | Loom | Backend |
| --- | --- | --- |
| **Open developer portal** (the consumer-facing site URL) | **built ✅** "Open developer portal" button → `developerPortalUrl` in a new tab | `getServiceInfo` → service `properties.developerPortalUrl` |
| **Open admin / publisher portal** (the visual editor) | **built ✅** "Open admin portal" button → `portalUrl` | `getServiceInfo` → `properties.portalUrl` |
| **Publish** the portal (run publishing pipeline, make current) | **built ✅** "Publish portal" dialog (optional description, isCurrent:true) → async LRO | `publishPortalRevision` → ARM PUT `/portalRevisions/{id}` (201/202) |
| **Revisions** list (history, which is current, status, created) | **built ✅** "Publish history" table (newest first, Current badge, status, timestamp) | `listPortalRevisions` → ARM GET `/portalRevisions` |
| Portal **status** (developerPortalStatus / provisioning) | **built ✅** status badge | `getServiceInfo` → `properties.developerPortalStatus` |
| **Make a previous revision current** ("Make current and publish") | **partial ⚠️** publish always creates+makes a new revision current; per-row "restore this revision" not yet exposed | would PUT `/portalRevisions/{existingId}` `isCurrent:true` |
| **Enable CORS** for the interactive test console | **MISSING ❌** | — |
| **Reset portal to default** / **self-host** / **CSP & custom domain** | **MISSING ❌** (managed-portal designer is in Azure's portal UI) | — |
| Visual page/widget designer | **MISSING ❌** (intentionally — the visual editor opens in Azure via the admin-portal link) | — |

Honest gate: when APIM is unprovisioned the pane (via `apim-pane-fetch`) shows the
shared 503 `not_configured` MessageBar naming the missing env var
(`LOOM_SUBSCRIPTION_ID` / `LOOM_APIM_NAME` / `LOOM_APIM_RG`); when the service has
no `developerPortalUrl` yet, the card shows an honest "not yet provisioned" note
rather than a dead link.

## Verdict

The Developer-portal tab covers the **Portal overview** loop that the Azure portal
exposes outside the visual designer: open the live portal, open the admin portal,
publish (creating a current revision), and review publish history — all on real ARM
`portalRevisions` REST with an honest infra-gate. The deep visual designer
(pages/widgets/styling) is intentionally deferred to Azure's own admin-portal link
(opened from here), since that surface is the managed React app, not an ARM API.

**Grade: B** — the publish + revisions + URL-launch loop is full 1:1 with real
backend; the remaining gaps (per-revision restore, Enable CORS, reset/self-host/CSP)
are tracked here.
