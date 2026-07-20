# ontology-object-security — parity with Palantir Foundry object/property/action security (WS-4.3)

Source UI: Palantir Foundry "Ontology → Security" (object-type security, property
markings, action permissions). Loom builds the equivalent on **Azure-native**
primitives — Entra security groups + Cosmos-persisted markings + Apache-AGE
instances — with **no Fabric / Power BI dependency** (Gov-safe).

WS-4.3 depends on WS-4.1 object views (merged) and REUSES the EH Phase-1 PDP/RLS
pattern (`apps/fiab-console/lib/auth/pdp`): the property marking is the CLS
analogue (mask a value), the row marking is the RLS analogue (hide an instance),
and the item-level `pdpCheck` keeps the ontology routes owner/ACL-gated.

## Foundry feature inventory (grounded in Foundry security model)

| Capability | Foundry behavior |
|---|---|
| Object-type visibility | An object type is visible only to principals granted it. |
| Property (mandatory) markings | A property carries a marking; a user without the marking cannot see the value — the value is redacted, not merely hidden. |
| Row-level markings (granular security) | Rows carry a marking value; a user not granted that marking does not see the row at all. |
| Action permissions | A write-back action is gated — only permitted principals may submit it. |
| Server-side enforcement | Security is enforced in the platform, not the client; blocked reads/writes fail server-side. |
| Audit | Marking decisions (masked reads, blocked actions) are auditable. |

## Loom coverage

| Row | Status | Loom implementation |
|---|---|---|
| Object-type / row-level markings | ✅ built | `rowMarking` on `state.objectSecurity`: a marking property + per-value Entra-group clearances. Uncleared rows are filtered server-side from `/objects` and 403'd on `/objects/[vertexId]/view`. RLS analogue. |
| Property (mandatory) markings | ✅ built | `propertyMarkings[]`: a property cleared to Entra groups. Uncleared callers get the value **dropped from the payload** (never serialized) on both read routes. CLS analogue. |
| Action permissions | ✅ built | `actions[]`: a write-back action cleared to Entra groups. `/run-action` returns **403 `action_forbidden`** before any validation/write for uncleared callers. |
| Server-side enforcement | ✅ built | All three enforced in the BFF over real AGE data — masked values dropped server-side, restricted rows/actions blocked. Tenant admins bypass (mirrors the PDP tenant-admin short-circuit). |
| Owner/ACL gate reuse | ✅ built | `loadOwnedItem` (owner/workspace-ACL) + `pdpCheck(item, read|write)` (EH Phase-1 PDP authorize/context-loader path; shadow-by-default, enforce-capable). |
| Caller group membership | ✅ built | `session.claims.groups` — the existing Graph/PDP claims path; not reinvented. |
| Audit | ✅ built | `kind:'object-security'` rows in the shared `audit-log` container (`recordObjectSecurityEvent`): masked/filtered reads, denied actions, and allowed gated actions — surfaced in Admin → Audit Logs. |
| Markings authoring UI | ✅ built | Ontology editor **Security** tab (`ontology-security-panel.tsx`): Dropdowns + the shared Entra `GroupMultiPicker` — no freeform JSON (loom-no-freeform-config). Web3/UX-baseline: elevated cards, section icons, EmptyState guidance, badge-wrap. |

Zero ❌.

## Backend per control

| Control | Backend called |
|---|---|
| List instances (`GET /objects`) | `weave-ontology-store.listObjects` (AGE) → `secureInstances` (row filter + property mask) |
| Object viewer (`GET /objects/[vertexId]/view`) | `weave-ontology-store.getObject` + `weave-explore.traverseObject` (AGE) → `isRowVisible` (403) + `maskProperties` (anchor + neighbours) |
| Run action (`POST /run-action`) | `isActionAllowed` gate (403) → `weave-ontology-store.runActionType` (AGE, ACID) |
| Marking persistence | Cosmos item `state.objectSecurity` via the normal editor PATCH save |
| Group membership | `session.claims.groups` (Entra) |
| Audit | Cosmos `audit-log` container (`recordObjectSecurityEvent`) |

## Enforcement model (pure, tested)

`apps/fiab-console/lib/foundry/object-security.ts` — `isCleared` (empty allow-list =
unrestricted; else Entra-group intersection), `maskProperties` (CLS), `isRowVisible`
(RLS), `secureInstances` (combined), `isActionAllowed` (action ACL). Unit-tested in
`lib/foundry/__tests__/object-security.test.ts`; route enforcement tested in the
three route `__tests__/route.test.ts`.

## Verification

- `npx tsc -p tsconfig.build.json --noEmit` → clean.
- `npx vitest run` (model + 3 guarded routes) → 30 green (cleared caller reads all;
  restricted caller gets masked props + filtered rows + 403 on gated action; tenant
  admin bypass).
- `check-route-guards.mjs`, `check-env-sync.mjs`, `check-bff-errors.mjs`,
  `check-file-size.mjs` → OK.
- **Owed (Track-0): browser-E2E receipt** — a restricted group sees masked
  properties + 403 on a gated action, live in the ontology object viewer.
