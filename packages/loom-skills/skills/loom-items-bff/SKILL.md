---
name: loom-items-bff
description: The generic CSA Loom item BFF contract. Every item type exposes /api/items/<type>/<id>/<action> returning { ok, data, error } with a real backend call and honest config gates — never mock arrays or dead handlers. Triggers on BFF route, API route, item action, session validation, config gate, response shape, NextResponse, no-vaporware.
allowed-tools: Read, Grep, Glob, Bash
---

# loom-items-bff — the generic item BFF contract

Every Loom item type is reached through a uniform BFF surface under
`apps/fiab-console/app/api/**`. This skill defines the contract an agent must
follow when adding or editing any route — it complements the per-item skills.

## The route shape

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export async function POST(req: NextRequest) {
  // 1. Validate session
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  // 2. Honest config gate — return BEFORE touching a backend that isn't wired
  const gate = someConfigGate(); // e.g. kustoConfigGate(), adfConfigGate(), eventhubsConfigGate()
  if (gate) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `… set ${gate.missing}.`, missing: gate.missing },
      { status: 503 },
    );
  }

  // 3. Resolve the item (tenant-scoped) from ?id=
  const itemId = req.nextUrl.searchParams.get('id')?.trim() || null;
  // loadXItem(itemId, '<type>', session.claims.oid) — validates ownership

  // 4. Call a REAL backend (Azure REST / TDS / Kusto / ARM) and return its result
  const data = await realBackendCall(/* ... */);
  return NextResponse.json({ ok: true, data });
}
```

This mirrors the live `app/api/adx/_shared.ts` guard: session → config gate →
per-item resolution from `?id=` (default fallback when standalone) → real control
command → `{ ok, ... }`.

## The response envelope (every route)

| Field | When | Notes |
|---|---|---|
| `{ ok: true, data }` | success | `data` is the real backend payload |
| `{ ok: false, error, code? }` | failure | precise message; `code:'not_configured'` for infra gates |
| HTTP `401` | no session | `error:'unauthenticated'` |
| HTTP `503` + `code:'not_configured'` | infra unset | name the exact env var in `error`/`missing` |
| HTTP `502` / client status | backend error | propagate the upstream status when known |

## Hard rules (no-vaporware)

- A route MUST call a real Azure backend. **No `return []`, no `return {}`, no
  mock/`SAMPLE_`/`MOCK_` arrays** as the data path.
- A missing backend produces an **honest gate**, never silent empty data.
- Every read/write is **tenant-scoped** via `session.claims.oid`.
- Config is **enumerated** (dropdowns / known ids), not free-form JSON
  (loom-no-freeform-config) — except the sanctioned ADF/Synapse expression builders.

## Picking the client

Use the item → client map in `AGENTS.md` / `README.md` and the matching per-item
skill. Resolve every endpoint host through `cloud-endpoints.ts`
(see `loom-cloud-endpoints`). Default to the Azure-native client; Fabric is opt-in
(`LOOM_<ITEM>_BACKEND=fabric` + bound workspace) and must pass
`assertFabricFamilyAvailable(...)` first.

## Cross-links

Governance: `.claude/rules/no-vaporware.md`, `no-fabric-dependency.md`,
`loom-no-freeform-config.md`. Reference guard: `app/api/adx/_shared.ts`.
