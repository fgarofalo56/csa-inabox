# Collaborative presence and comments

> **Surface:** presence avatars on every canvas and on the notebook / report-designer / semantic-model / unified-SQL editor headers; sticky comments on canvases; the item review thread
> **Backend:** the TTL-enabled `canvas-presence` and the `canvas-comments` Cosmos containers, plus one Server-Sent-Events stream per open editor at `/api/items/<type>/<id>/collab/stream`
> **Kill-switch flag:** `a14-collab-push` (default ON) — gates the **push transport**, not collaboration itself
> **Honest gate:** none beyond Cosmos itself

See who else has this item open, in about a second. Leave a sticky comment on a
canvas node or a note on the item review thread, and have your colleague's
client pick it up without a refresh.

## Why it exists

Two people editing the same pipeline without knowing it is how work gets lost.
Fabric solves it with a co-authoring avatar stack; Loom carries the same
affordance across **every** surface — canvases and the non-canvas editors alike.

The honest scope note: this is **presence and comments**, not character-level
co-editing. Full CRDT co-editing is a larger infrastructure lift tracked
separately, and the client says so plainly with a "Live co-edit (CRDT) —
Preview" note rather than implying it already works.

## How to use it end to end

### Presence

1. **Open any item.** Your client starts a heartbeat.
2. **Look at the avatar stack** — on a canvas it renders inside the collaboration
   layer; on the notebook, report designer, semantic model and unified SQL
   editor it renders as a compact chip in the editor header's action row.
3. **Colours are stable.** A peer reads the same colour on a canvas and in an
   editor header, so you can track who is where.
4. **Zero peers is quiet by design** — a subtle people icon with an honest
   tooltip. No banner, no noise on first open.
5. **Peers self-evict.** A colleague who closed the tab or crashed disappears on
   the beacon TTL; there is no explicit "leave" call to miss.

### Comments

1. **On a canvas**, add a sticky comment anchored to the canvas.
2. **On an item**, use the review thread.
3. **Edit and delete are owner-only** — only the author (by Entra object id) may
   change or remove their own comment. Anyone who can open the item can read the
   comments, which is the same visibility the editor already grants.

### The push transport

With the flag ON, one SSE stream per open editor multiplexes four event kinds:
`presence`, `canvas-comments`, `item-comments`, and a server-initiated
`reconnect`. Cadences are tuned so the stream is cheap: presence is re-read
about every second, the two comment feeds about every four seconds, and a
keep-alive ping every fifteen seconds defeats idle-timeout proxies. The server
pushes an event **only when a change signature actually changed** — never a
per-tick firehose — and rotates the stream cleanly before any proxy would kill
it.

## What the backend actually does

| Control | Backend |
|---|---|
| Presence heartbeat (write) | Upsert into the TTL-enabled `canvas-presence` Cosmos container (PK `/itemId`), one deterministic document per item + canvas + object id, so repeated beats overwrite one row and refresh its TTL |
| Presence read | Single-partition query for active peers |
| Comments | The `canvas-comments` Cosmos container (PK `/itemId`), a per-item sidecar so comment documents never pollute item queries |
| Push transport | `GET /api/items/<type>/<id>/collab/stream` — SSE, the same framing the estate's Copilot streams already use through Front Door |
| Client retry | Exponential backoff in the shared transport layer |

The transport choice was deliberate: SSE is the estate-proven streaming pattern
and needs **zero new infrastructure**. There is no Web PubSub dependency.

## Honest gates

None specific to this feature. If Cosmos is not configured the container
accessor raises the standard honest not-configured gate, exactly as it does for
every other Cosmos-backed surface.

## Kill-switch

`a14-collab-push` — default ON. Flipping it OFF reverts every surface to the
pre-push **polling** heartbeat within seconds: the stream route answers 503, open
streams wind down, and **presence and comments keep working end to end over the
poll** — degraded latency only (roughly fifteen seconds instead of one), no
roll. The Cosmos beacon and comment stores and the heartbeat write path are
unaffected either way.

The same applies to any stream failure: a client that cannot hold the stream
falls back to polling on its own.

## Related

- [Canvas full-screen](canvas-fullscreen.md)
- [UX standards](../ux-standards.md) — the canvas kit these layers ride on
- [Workspace RBAC](../governance/workspace-rbac.md)
