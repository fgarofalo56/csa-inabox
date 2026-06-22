# loom-marketplace — parity with Databricks Marketplace + Purview Unified Catalog + Fabric OneLake catalog

Source UIs:
- Databricks Marketplace + Delta Sharing — https://www.databricks.com/product/delta-sharing , https://learn.microsoft.com/azure/databricks/delta-sharing/
- Microsoft Purview Unified Catalog (data products + access requests) — https://learn.microsoft.com/purview/unified-catalog , https://learn.microsoft.com/purview/unified-catalog-data-product-access-requests
- Microsoft Fabric OneLake catalog (discover / endorse / request access) — https://learn.microsoft.com/fabric/governance/onelake-catalog-overview

## What this is

`Marketplace` (`/marketplace`) is the tenant's single, core data-mesh exchange. It
**merges** the former standalone *API marketplace* and *Data marketplace* into one
surface where users **publish, share, and subscribe** to every product kind:
data products, APIs, and live Delta Sharing data shares. It is a core nav
destination — not a per-workspace "New" item (`data-marketplace` is now
`coreSurface: true` and excluded from the New-item dialog; its editor still works
at `/items/data-marketplace/…` and links back here).

Discovery split (per the IA decision): the **catalogs** (`/catalog` Unified
catalog, `/onelake` OneLake catalog) remain the "browse every item" surfaces;
the Marketplace is scoped to publishable/subscribable **products**.

## Tabs

| Tab | Surface | Backend (all real) |
|-----|---------|--------------------|
| **Discover** | Unified federated search across all product kinds + asset-kind & domain filters | client-fan-out over the three sources below; each best-effort with honest per-source notes |
| **Data products** | Discover / Domains / Publish / My-data-access (the prior data-marketplace, embedded) | `POST /api/data-products/search` (Azure AI Search `loom-data-products`), `GET/POST /api/data-products`, `POST /api/catalog/request-access` |
| **APIs** | Browse APIM products/APIs, operations, OpenAPI, try-it, subscribe + keys, mini-app | `GET /api/marketplace/catalog`, `…/subscriptions`, `…/subscriptions/[sid]/keys` (Azure API Management REST) |
| **Data shares** | Bidirectional Delta Sharing — subscribe to inbound provider shares; publish outbound shares + recipients | `…/sharing/{shares,recipients,providers}` → Databricks Unity Catalog REST `/api/2.1/unity-catalog/*` |
| **My access** | Unified APIM subscriptions + data-product access requests | `GET /api/marketplace/subscriptions`, `GET /api/data-products/my-access-requests` |

## Databricks Marketplace / Delta Sharing feature inventory → Loom coverage

| Capability (Databricks) | Loom coverage | Backend per control |
|--------------------------|---------------|---------------------|
| Provider creates a **share** (read-only collection of tables) | ✅ Data shares ▸ Shared by me ▸ New share | `POST /api/2.1/unity-catalog/shares` |
| Add tables to a share | ✅ "Add table" (cascading catalog→schema→table picker over `/api/catalog/browse`) | `PATCH /shares/{name}` updates |
| Create a **recipient** (TOKEN = open sharing; DATABRICKS = D2D) | ✅ New recipient; TOKEN surfaces the one-time activation link | `POST /api/2.1/unity-catalog/recipients` |
| Grant a recipient `SELECT` on a share | ✅ "Grant recipient" on each share card | `PATCH /shares/{name}/permissions` |
| Consumer browses **providers** sharing with them (incl. Marketplace listings) | ✅ Data shares ▸ Shared with me | `GET /api/2.1/unity-catalog/providers` (+ `/shares`) |
| Add an inbound provider from an activation file | ✅ "Add provider (activation file)" | `POST /api/2.1/unity-catalog/providers` |
| **Subscribe** to a share → live read-only catalog (no copy) | ✅ "Subscribe" mounts it as a UC catalog | `POST /api/2.1/unity-catalog/catalogs { provider_name, share_name }` |
| Browse listings on the public Databricks Marketplace | ⚠️ honest-gate — surfaces via inbound providers once a metastore is bound; the public listing exchange is read from UC providers, not a separate Marketplace API |

## Purview / Fabric data-product feature inventory → Loom coverage

| Capability | Loom coverage | Backend |
|------------|---------------|---------|
| Governance domains organize products (data mesh) | ✅ Domains tab + domain facet | Cosmos `governance-domains` (mirrors to Purview collections + UC) |
| Publish a data product | ✅ Publish tab | `POST /api/data-products` (+ best-effort Purview UC register) |
| Faceted discover (domain/type/owner/glossary/CDE) | ✅ Discover tab | Azure AI Search `loom-data-products` |
| Request access → "My data access" | ✅ Request access + My access tab | `POST /api/catalog/request-access`, audit log |
| Access granted as real RBAC on approval | ✅ via Governance → Policies (see subscribe→access, PR pending) | access-policy backend |

## Honest gates (no-vaporware)

- **APIs** — `LOOM_APIM_NAME` + `LOOM_SUBSCRIPTION_ID` unset → MessageBar naming them.
- **Data products** — `LOOM_AI_SEARCH_SERVICE` unset → MessageBar naming it.
- **Data shares** — no Databricks workspace bound (`LOOM_DATABRICKS_HOSTNAMES`) or
  Delta Sharing disabled on the metastore → 501 gate naming the exact remediation;
  the full surface still renders. Delta Sharing is an Azure Databricks feature, so
  this is a legitimate Azure infra gate, **not** a Microsoft Fabric dependency.

## Verification

`/marketplace` renders all five tabs; Data shares shows the honest gate when no
metastore is bound, and (with a bound metastore + Delta-Sharing-admin UAMI) lists
shares/recipients/providers and round-trips create/grant/mount against real UC REST.
Live side-by-side + click-every-control per `no-scaffold` rule.
