# Catalog — Search

Single search box that federates across Microsoft Purview + Databricks Unity Catalog + Fabric / OneLake.

## Endpoint

`GET /api/catalog/search?q=<keywords>&source=<csv>&limit=<n>`

| Param | Purpose |
|---|---|
| `q` | Required. Empty string returns the latest 50 hits across each source (browse mode). |
| `source` | Optional comma-separated filter (`purview`, `unity-catalog`, `onelake`). |
| `limit` | Per-source cap (default 30, max 100). |

## Response shape

```json
{
  "ok": true,
  "q": "customers",
  "total": 42,
  "hits": [{"source": "purview", "id": "0e1a-…", "display_name": "customers", "type": "Table", "owner": "alice@", "detail_path": "/catalog/purview/0e1a-…"}],
  "sources": {
    "purview":        {"ok": true,  "count": 7,  "durationMs": 412},
    "unity-catalog":  {"ok": true,  "count": 19, "durationMs": 1138},
    "onelake":        {"ok": false, "count": 0,  "durationMs": 18, "error": "…", "hint": { /* bicep + role hint */ } }
  }
}
```

Each source is queried independently. **Partial success is preserved** — when one back-end is down, the others still contribute and the UI renders a precise MessageBar for the failing one. There is no silent fallback to mocks.

## Result row

Every hit row carries:

- `source` — which back-end contributed the row (badge color encodes it)
- `display_name` + `qualified_name` (for UC: full three-part name; Purview: `qualifiedName`; OneLake: workspace + display)
- `type`
- `owner` (best effort across sources)
- `workspace_name` / `domain` — the parent container
- `classifications` (Purview only on phase 1)
- `detail_path` — deep link to the asset detail page in Loom

## UI

`/catalog` → `FederatedSearch` component. Toolbar shows per-source chips with live counts. Click a chip to restrict the search to that source only. The MessageBar block below the toolbar shows every NotConfigured hint so the operator sees the exact remediation in-page.
