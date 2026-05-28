# Catalog — Browse

Lazy-loaded tree rooted at Source → Workspace/Metastore → Schema/Domain → Asset.

## Endpoint

`GET /api/catalog/browse?source=<source>&path=<a|b|c>`

| Source | Empty path | One segment | Two segments | Three segments |
|---|---|---|---|---|
| `unity-catalog` | Metastores (federated, deduped) | Catalogs (in workspace) | Schemas (in catalog) | Tables + Volumes |
| `onelake` | Workspaces | Items (lakehouse, warehouse, …) | — | — |
| `purview` | Business domains | Data products in domain | — | — |

Path segments are pipe-separated (`path=adb-…|main|bronze`) so the segments themselves can contain dots and dashes safely.

## Response shape

```json
{ "ok": true, "nodes": [ { "id": "main", "label": "main", "kind": "catalog", "hasChildren": true, "meta": {…} } ] }
```

`hasChildren: false` nodes are leaf assets. Clicking a leaf opens the detail page in a new tab.

## UI

`/catalog/browse` → tabs to switch source, lazy-loaded indented list with disclosure triangles. No third-party tree library — the bundle keeps shipping Monaco + Fluent UI + MSAL only.
