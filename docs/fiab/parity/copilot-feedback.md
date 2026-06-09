# copilot-feedback — parity with the Copilot chat feedback + history surface

Source UI: Microsoft 365 Copilot / Azure AI chat panes (per-message thumbs
up/down, "Clear chat", and a session-history list). Grounded in the common
Copilot chat affordances exposed across Microsoft Copilot surfaces.

This is the CSA Loom right-rail Copilot pane (`lib/components/copilot-pane.tsx`),
not a Fabric object — it is a Loom-native assistant over the Azure-native
orchestrator (AOAI via the Foundry hub). No Fabric / Power BI dependency:
everything runs against Cosmos (`LOOM_COSMOS_ENDPOINT`) + AOAI and works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Feature inventory (Copilot chat pane)

| Capability                              | Behaviour in the source UI                                  |
|-----------------------------------------|-------------------------------------------------------------|
| Per-message thumbs up                   | Marks a reply helpful; persists a feedback signal           |
| Per-message thumbs down                 | Marks a reply unhelpful; persists a feedback signal         |
| Feedback persistence                    | Feedback stored server-side for quality review              |
| Clear chat                              | Empties the pane and discards the current conversation      |
| Conversation retention / expiry         | Old conversations age out automatically                     |
| History list of prior conversations     | Browse + reopen earlier sessions                            |
| Reopen a prior session                  | Replays the session's messages back into the pane           |

## Loom coverage

| Capability                          | Status | Backend per control                                                                 |
|-------------------------------------|:------:|-------------------------------------------------------------------------------------|
| Thumbs up                           |   ✅   | `PATCH /api/copilot/sessions/[id]` → Cosmos `copilot-feedback` create (rating:'up') |
| Thumbs down                         |   ✅   | `PATCH /api/copilot/sessions/[id]` → Cosmos `copilot-feedback` create (rating:'down') |
| Feedback persistence                |   ✅   | Real Cosmos doc in `copilot-feedback` (PK /sessionId, permanent audit log)           |
| Feedback → backlog drain (mirror)   |   ✅   | Best-effort forward to copilot-chat Function `/api/loom/feedback` (host-key gated; optional, no-op when `LOOM_COPILOT_FUNCTION_URL`/`_KEY` unset) |
| Clear chat                          |   ✅   | `DELETE /api/copilot/sessions/[id]` → Cosmos point-delete (ownership-checked, idempotent) |
| Conversation 28-day expiry          |   ✅   | Cosmos `copilot-sessions` `defaultTtl=2419200` (set on create + one-time replace() upgrade in `cosmos-client.ts ensure()`) |
| History list of prior sessions      |   ✅   | `GET /api/copilot/sessions` → `listSessions(userOid)` (cross-partition, ORDER BY updatedAt DESC) |
| Reopen a prior session              |   ✅   | `GET /api/copilot/sessions/[id]` → replays `steps[]` into the pane                   |

Zero ❌, zero stub banners. Every control calls a real Cosmos-backed BFF route.

## Backend per control (summary)

- Thumbs: `PATCH /api/copilot/sessions/[id]` validates the session cookie,
  validates `rating ∈ {up,down}` + numeric `messageIndex`, then `items.create`
  a feedback doc `{ id, sessionId, userOid, messageIndex, rating, improvement,
  createdAt }` in the `copilot-feedback` container.
- Clear chat: `DELETE /api/copilot/sessions/[id]` point-reads the session,
  enforces `userOid` ownership (403 on mismatch), then `item().delete()`. A
  missing doc returns 204 (idempotent).
- History: `GET /api/copilot/sessions` lists the user's sessions; clicking one
  hits `GET /api/copilot/sessions/[id]` and replays the persisted steps.
- TTL: `copilot-sessions` is created with `defaultTtl=2419200` (28 days) and
  upgraded in place for pre-existing containers via `container.replace()` —
  conversations expire automatically, so clear-chat + the 28-day window need no
  purge job. `copilot-feedback` has NO TTL (permanent audit record).

## Verification

- `app/api/copilot/sessions/__tests__/session-id-route.test.ts` — 8 tests green:
  DELETE 401/204-owner/403-cross-user/204-missing; PATCH 401/200-writes-doc/
  400-bad-rating/400-missing-index. Asserts the real Cosmos `delete` /
  `items.create` calls fire with the right partition key + payload.
- Acceptance (live): thumbs writes a verifiable `copilot-feedback` doc; clear
  removes the `copilot-sessions` doc; history lists real prior sessions; the
  `copilot-sessions` container shows TTL = 2419200 s in Cosmos Data Explorer.
