# Agent memory service (B-N14d)

The **formalized agent-memory service** — durable memory an agent recalls across
unrelated sessions, scoped to an **agent + workspace**, retained under an
explicit policy, and audited on every write.

Azure-native and sovereign: Cosmos + the existing Loom audit stream. No
Microsoft Fabric / Power BI dependency.

## Why it exists

Before N14d, Loom had two unrelated memory stacks and neither was a service:

| Stack | Scope | Gaps |
|---|---|---|
| CTS-08 Copilot brain (`lib/copilot/memory-*-core.ts`, `lib/azure/memory-store.ts`) | `user:<oid>` / `workspace:<id>` | not agent-aware at all |
| AIF-14 agent memory (`lib/azure/agent-memory-client.ts`) | agent + user | no workspace dimension, count cap only (no time retention), no audit on write, no read/write API |

N14d layers ONE service over both. Nothing was removed: the AIF-14 client keeps
its threads / eval rows / fact extraction, and the CTS-08 brain is untouched.
The new service reuses the CTS-12 **pure** screening primitives (`redactSecrets`,
`looksLikeInjection`) rather than growing a second sanitizer.

## Scoping — derived from the session, never from the request

```
agent:<agentId>|ws:<workspaceId|_>            # shared agent operating knowledge
agent:<agentId>|ws:<workspaceId|_>|user:<oid> # private to one user's conversations
```

- The **workspace** comes from the resolved agent (a `data-agent` / `agent-flow`
  workspace item, or `''` for a tenant-level mesh agent) — never from a request
  field, so a caller cannot address a sibling workspace's agent memory even
  inside their own tenant.
- The **tenant** and **user** come from the session.
- Every read filters on `tenantId` **and** the scope keys the actor can derive,
  on the `/agentId` partition — a read cannot cross a tenant, a workspace, or
  another user's private rows.

`GET|POST|DELETE /api/agents/{id}/memory` first proves the caller can see the
agent (`loadOwnedItem` with a role, or the tenant-scoped mesh registry) and
404s otherwise.

## Retention

| Knob | Default | Meaning |
|---|---|---|
| `LOOM_AGENT_MEMORY_RETENTION_DAYS` | `180` | default lifetime; `0` = keep forever |
| `LOOM_AGENT_MEMORY_MAX_RETENTION_DAYS` | `730` | ceiling a per-write `retentionDays` override is clamped to |
| `LOOM_AGENT_MEMORY_CAP` | `200` | per-scope count cap; the oldest beyond it are evicted on write |
| `LOOM_AGENT_MEMORY_TOPK` | `8` | memories packed into one agent turn |

All four are numeric **tuning knobs with safe code defaults** — none is a
day-one gate, and leaving every one unset is a fully working configuration
(`loom_default_on_opt_out`). Each write stamps both an `expiresAt` instant and
the Cosmos item `ttl`; expired rows are additionally swept on read and on write,
so retention holds regardless of container TTL configuration.

## Write path — no unguarded route

`screenAgentMemoryWrite` (pure) runs on **every** write and the service persists
only its stamped record:

1. shape — non-empty, ≤ 600 chars, known category (`fact` / `preference` /
   `decision` / `context` / `instruction`) and source (`run` / `explicit` /
   `consolidation` / `import`);
2. prompt-injection screen — content that reads as a model instruction is rejected;
3. secret redaction — credentials / keys / tokens stripped from content **and** tags;
4. scoping — scope key, workspace, tenant, user derived from the actor;
5. retention — `expiresAt` + `ttl` from the resolved policy.

Every attempt, **stored or rejected**, writes a Cosmos `audit-log` row and fans
out through `emitAuditEvent` (SIEM + webhooks) as `agent-memory.write` /
`.reject`; deletes, purges, and recalls are audited too. Audit is
fire-and-forget — an audit hiccup never fails an agent turn.

## Recall in the loop

`recallAgentMemories()` reads, packs under `topK` + an optional token budget
(shared agent knowledge preferred over private rows at equal confidence, expired
rows dropped, duplicate content deduped), reinforces `recallCount` /
`lastRecalledAt` on the selected rows, and audits the recall. The Foundry /MAF
agent run route (`POST /api/foundry/agents/run`) injects the resulting block
alongside the AIF-14 preamble, and mirrors each newly distilled fact back into
the service so the next run recalls it at agent+workspace scope.

## API

| Method | Path | Behaviour |
|---|---|---|
| `GET` | `/api/agents/{id}/memory[?scope=agent\|agent-user]` | visible memories + the retention policy in force + the recall block the agent would receive |
| `POST` | `/api/agents/{id}/memory` | `{ content, … }` or `{ memories: [...] }` (max 25); returns a per-candidate result with `reason` / `flags` / `redacted` |
| `DELETE` | `/api/agents/{id}/memory?memoryId=<id>` | delete one memory in a scope the caller can address |
| `DELETE` | `/api/agents/{id}/memory?purge=1[&scope=…]` | purge every memory the caller can see for the agent |

## Kill switch

Runtime flag **`n14d-agent-memory`** (registered in `lib/admin/runtime-flags.ts`,
toggled on `/admin/flags`). Default-ON and **fail-open**: a missing flag doc or
an unreachable Cosmos means enabled, so a kill-switch outage never takes agent
memory down. OFF makes reads return empty and writes return an honest
`reason:'disabled'` with the exact remediation; **nothing stored is deleted**,
and `purge` still works (a data-rights operation must not depend on the switch).

## Storage

Reuses the existing Cosmos container **`loom-agent-memory`** (PK `/agentId`),
shared with the AIF-14 `thread` / `memory` / `eval` docs. The new documents carry
`docType:'agent-memory'` so they never collide. **No new Azure resource and no
bicep change.**

## Backend map
- Pure policy core (scoping, retention, screening, packing): `lib/copilot/agent-memory-core.ts`
- Cosmos service (read/write/delete/purge/recall + audit): `lib/azure/agent-memory-service.ts`
- BFF route: `app/api/agents/[id]/memory/route.ts`
- Kill switch: `lib/admin/runtime-flags.ts` → `n14d-agent-memory`
- Tests: `lib/copilot/__tests__/agent-memory-core.test.ts`
