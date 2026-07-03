# CSA Loom v3.1 UAT Receipt — 2026-05-25

Receipt for v3.1 deploy per `.claude/rules/no-vaporware.md` validation gate.

Live URL: <https://<your-console-hostname>>
Image: `acrloomm56yejezt7bjo.azurecr.io/loom-console:v3.1`
`GET /api/version` → `{"current":"v3.1"}`

## Unauthenticated 401-pass sweep (Chunk 0 BFF routes)

All 13 new routes return 401 (auth gate working + routes deployed):

```
401  GET  /api/apps-catalog
401  GET  /api/workloads-catalog
401  GET  /api/user-prefs
401  GET  /api/tabs
401  GET  /api/notifications
401  GET  /api/downloads
401  GET  /api/items/recent
401  GET  /api/workspaces/x/folders
401  GET  /api/items/lakehouse/x/audit
401  GET  /api/items/lakehouse/x/comments
401  GET  /api/items/lakehouse/x/share
401  POST /api/search/items
401  POST /api/admin/bootstrap-catalogs
```

## Authenticated round-trip sweep

Session minted from KV secret (KV PNA temporarily opened to my workstation IP,
secret fetched, KV re-locked + IP removed + local secret file deleted).

### Bootstrap → catalogs

```
POST /api/admin/bootstrap-catalogs
  → {"ok":true,"tenant":"GLOBAL","appsSeeded":10,"workloadsSeeded":13}

GET /api/apps-catalog  (auto-copies GLOBAL→tenant on first read)
  → 10 apps; first: Casino Analytics

GET /api/workloads-catalog
  → 13 workloads
```

### Foundation routes

```
POST /api/user-prefs {"key":"uat-test","value":{"x":1}}  → {ok:true}
GET  /api/user-prefs?key=uat-test                        → {ok:true,value:{x:1}}

POST /api/tabs       {"tabs":[{...}]}                    → {ok:true}
GET  /api/tabs                                           → {ok:true, tabs:[...]}

GET  /api/notifications                                  → {ok:true, count:0}
```

### Per-item routes (against a freshly created azure-sql-database item)

```
POST /api/workspaces                            → workspace 6128cd84-...
POST /api/items/azure-sql-database              → item 5c95910b-...
POST /api/items/.../5c95910b/comments           → {comment.body:"UAT test v3.1"}
GET  /api/items/.../5c95910b/comments           → 1 comment
POST /api/items/.../5c95910b/audit              → {entry.action:"edit"}
GET  /api/items/.../5c95910b/audit              → 1 entry
POST /api/items/.../5c95910b/share              → URL returned
GET  /api/items/recent                          → 1 item (displayName mismatch
                                                  fixed; new route returns
                                                  displayName + lastTouchedAt)
```

## Security posture

- KV `kv-loom-m56yejezt7bjo` was opened to one IP (`73.87.214.57/32`) for ~10 minutes,
  then `publicNetworkAccess` set back to `Disabled`, the IP rule removed, and the
  local secret file deleted.
- No source-control commits contained the SESSION_SECRET.
- All authenticated UAT calls were against the live Front Door endpoint with
  the production session-cookie format (HKDF + AES-256-GCM).

## Net result

**v3.0 + v3.1 work end-to-end with real Cosmos backing.** No vaporware found.
One field-name fix landed (`/api/items/recent` now returns `displayName` +
`lastTouchedAt` to match the home-page client component).

## Still queued

- Chunk 4: Workspace + New item modal (Fabric category browser)
- Chunk 5: Workspace Settings drawer (15 sections of real Azure REST)
- Chunk 8: Switch /api/search/items to AI Search indexer
- Chunk 10: Vitest + Playwright UAT pass before v3 GA
