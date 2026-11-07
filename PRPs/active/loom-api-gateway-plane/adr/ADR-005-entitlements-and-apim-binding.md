# ADR-005 — Entitlements: subject × resource × cost center, bound to APIM by grant-scoped subscriptions and attribution keys

**Status:** Proposed 2026-10-28; accepted when W3 ships.
**Mosaic lineage:** ADR 0009 (entitlement model), 0011 (governed access,
credential disclosure), 0021 (keys), 0022 amendment (cost center as part of
grant identity).

## Context

Loom has an access-request workflow with tiers (`access-request-workflow`,
`withApprovalAuthority`), approval policies scoped by default / resource-type
/ package, and APIM subscriptions with no link to Entra principals. Mosaic's
grant is the record that ties a principal, a governed resource and a cost
center to the gateway artefacts that realize it.

## Decision

1. **Grant** (`entitlement`): `subject{kind,principalId}` × `resource{kind,id,scopeId}`
   × `costCenterId`, ID deterministic on those three; re-granting is a
   conflict. `enforcement` is optional; absent means unrestricted (shown as
   unrestricted, never as zero). Token limits (`llm-token-limit`) and request
   limits (`rate-limit-by-key`, `quota-by-key`) are separate structures.
2. **Resources**: `modelApi` and `mcpServer` (plane-published or adopted),
   `poolModel`, and observed `product` / `modelDeployment` scoped by gateway
   or endpoint. A resource the plane does not know is refused.
3. **Binding**: each enforced direct grant has a dedicated API-scoped APIM
   subscription that identifies its key path; native APIM acceptance of a key
   is not enough, the `loom-*` fragment must also recognise the subscription
   as an enabled grant. Generic, all-access and unrelated keys never authorize
   a grant. Entra-token, security-group and MCP grants have no subscription
   and link usage through `attributionKey` (+ `attributionPerMember` for
   groups). Binding source is `inferred | manual | orchestrated`; inference
   claims a binding only on exactly one match.
4. **Keys** are created, rotated per slot and deleted by the owner (My
   access) or an administrator (Entitlements), never by an apply; one key per
   subject × pool × cost center for pool models; keys are named with the cost
   center code; an apply suspends keys while replacing policy and reactivates
   them when the grant is still enabled; revocation deletes them at the next
   apply.
5. **Reveal**: ARM `listSecrets` only on an explicit reveal by the owning
   principal (or an administrator-only handoff route that shows no key to the
   administrator, D7); the service checks the subscription's active API scope
   and rechecks the grant after the ARM call; responses are non-cacheable;
   the UI holds the value at most 60 s and clears on unmount or navigation;
   listing, planning, publishing and sync never call `listSecrets`.
6. **Authentication methods** per governed resource: keys, Entra tokens, both
   or neither; neither denies all; if both are supplied both must be valid and
   name the same grant; invalid credentials never fall back to the other
   method; authentication and authorization run before routing and limits.
7. **Approval** creates the grant in one atomic batch with the decision and
   audit; it never applies a plan; an unregistered requester becomes a `user`
   principal; a request for an unpublished resource is refused `409
   notPublished`; if the resource's environment changed since the request,
   approval requires re-confirmation.
8. **Effective access** returns direct grants plus group grants with the path
   each arrived by; a direct grant is never replaced by a group grant; plan
   review warns on overlaps.
9. Loom's F16 approval inbox and approval policies are reused with resource
   kinds `model-api`, `pool-model`, `mcp-server`; the plane does not build a
   second inbox.

## Consequences

- Changing a publication to governed access can stop clients using its
  former generic key; the plan shows that impact.
- Revocation takes effect as APIM propagates configuration, not when intent
  is saved; the console says so.
- Keys already revealed cannot be recalled; rotation is the remedy.
- Counters are distributed and approximate; the ledger is the rollup, not the
  counter.

## Alternatives rejected

- Treating a key's label as proof of identity; storing keys in Key Vault or
  Cosmos; one key per subject across cost centers (breaks per-center
  charging); fabricating an inventory snapshot to link a published API;
  a plane-local group as an authorization mechanism.

## Verification

`effectiveAccess`, `resolveCostCenter` mutation receipts; the
`verify-model-access.mjs` matrix; a G1 walk covering request → approve →
reveal → call → rotate → revoke on Commercial and GCC-High.
