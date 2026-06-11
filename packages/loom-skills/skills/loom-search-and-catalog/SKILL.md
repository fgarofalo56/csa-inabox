---
name: loom-search-and-catalog
description: Azure-native search + catalog in CSA Loom — index items and docs in Azure AI Search (Cosmos substring fallback), never a Fabric OneLake catalog. Call loom-search.ts + loom-docs-index.ts via /api/ai-search and /api/search. Triggers on search, catalog, discovery, AI Search, index, RAG, find items, full-text, semantic search.
allowed-tools: Read, Grep, Glob, Bash
---

# loom-search-and-catalog — Azure AI Search + Cosmos (the Azure-native catalog)

Loom **search / catalog** is backed by **Azure AI Search** (the `loom-items`
index for item discovery and the `loom-docs` index for the Help Copilot RAG),
with a **Cosmos substring fallback** when AI Search is not provisioned. It is NOT
a Fabric OneLake catalog.

## Clients

`apps/fiab-console/lib/azure/loom-search.ts` (item index) and
`loom-docs-index.ts` (docs/RAG index).

Real exported symbols:

```ts
// loom-search.ts
export interface LoomDoc { /* id, kind, name, tenantId, ... */ }
export interface LoomHit extends LoomDoc { /* score */ }
export function isSearchConfigured(): boolean;                 // honest gate
export async function ensureLoomIndex(): Promise<{ created: boolean; ok: boolean; error?: string }>;
export async function upsertLoomDoc(doc: LoomDoc): Promise<void>;
export async function deleteLoomDoc(id: string): Promise<void>;
export async function searchLoomItems(opts: { /* query, tenantId, top, kind */ }): Promise<LoomHit[]>;
export function docForWorkspace(ws: {...}): LoomDoc;
export function docForItem(it: {...}): LoomDoc;

// loom-docs-index.ts
export interface DocChunk { /* id, kind, title, body, ... */ }
export function isSearchConfigured(): boolean;
export async function ensureDocsIndex(): Promise<{ ok: boolean; created: boolean; error?: string }>;
export async function searchDocs(query: string, top?: number, kind?: DocChunk['kind']): Promise<{ ... }>;
export async function buildCorpus(): Promise<DocChunk[]>;      // summarizes lib/azure, lib/editors, lib/components
export async function reindex(): Promise<ReindexResult>;
```

Search uses `searchEndpointBase(LOOM_AI_SEARCH_SERVICE)` + the cloud-invariant
`SEARCH_AAD_SCOPE`. When AI Search is unconfigured, both clients fall back to a
Cosmos substring scan — honest, not a mock.

## Auth

UAMI-first chain. The UAMI needs **Search Index Data Contributor** + **Search
Service Contributor** on the AI Search service (bicep `ai`). Searches are always
tenant-scoped (`tenantId` filter) — never cross-tenant.

## BFF routes

`/api/ai-search/**`, `/api/search/items`, `/api/help-copilot/**`. Validate session
→ `isSearchConfigured()` (honest gate / Cosmos fallback) → `searchLoomItems()` /
`searchDocs()` → `{ ok, data: hits }`. `/api/help-copilot/reindex` runs `reindex()`.

## Do / don't

- DO keep every item write in lockstep with the index (`upsertLoomDoc()` /
  `deleteLoomDoc()` on item CRUD).
- DO scope every query by `tenantId`.
- DON'T call a Fabric OneLake catalog API.
- DON'T return an empty array when AI Search is down — fall through to Cosmos.

## Cross-links

UI parity: `docs/fiab/parity/search.md`, `catalog.md`. Backend map row:
search/catalog (semantic-model row family) in `.claude/rules/no-fabric-dependency.md`.
This skill also powers the Help Copilot RAG that indexes `lib/azure` (the very
clients these skills document) via `buildCorpus()`.
