# ADR-009 — Sovereign-native by default; cross-cloud Government management as a disclosed opt-in

**Status:** Proposed 2026-10-28; accepted when W8 ships.
**Mosaic lineage:** ADR 0026, `azure-government.md`. Operator decision Q4
(differs from the recommended default; consequences recorded in
`OPERATOR-DECISIONS-2026-10-28.md`).

## Context

Loom deploys per boundary (Commercial, GCC-High, IL5 by params, GCC
supported-in-code only). Mosaic instead lets one Commercial deployment manage
Government gateways through a Government service principal, processing
Government metadata, telemetry and the management secret in Commercial, and
states that this is not a sovereign deployment. The operator wants both.

## Decision

1. **Default — sovereign-native.** A Loom deployed in a boundary registers
   and manages gateways, endpoints and MCP servers in that boundary with its
   own Console UAMI, through `lib/azure/cloud-endpoints.ts` (ARM, Log
   Analytics, login authority per cloud). No cross-cloud data flow exists in
   this mode. Every table in this set lists GCC as supported-in-code, never
   exercised, and IL5 as having no deploy run.
2. **Opt-in — cross-cloud connections.** When `LOOM_APIPLANE_CROSS_CLOUD=true`
   and the isolated management vault exists (`apiplane-mgmt-vault.bicep`,
   Console UAMI as Secrets Officer, no APIM identity access), an administrator
   may create a named **Azure Government** connection: tenant ID, application
   (client) ID, secret value entered write-only and stored only in that vault;
   Cosmos keeps the vault reference and safe metadata. **Test authentication**
   proves a token, not permissions; each resource's preflight proves the rest.
3. **Routing by explicit connection.** Resources store `cloud` and
   `connectionId`; ARM calls, permission checks, telemetry, publishing,
   subscriptions and backend credential operations route by them; authorities,
   origins, scopes and audiences are bound to closed cloud profiles; cloud is
   never inferred from an environment tag or a price override; cross-origin
   authenticated continuations and redirects are rejected.
4. **Government runtime is key-only.** A key represents an exact applied
   direct grant and cost center, not a Government user. Commercial tokens and
   group membership are never a runtime fallback. Government user sign-in,
   Government Graph expansion, runtime Government Entra tokens, federation and
   certificates are **blocked** (same list as Mosaic). Government backend
   secrets belong in a Government vault, never either Commercial vault.
5. **Money and telemetry.** Commercial and Government resources share
   cost-center IDs; cloud and provenance are kept in rollups, prices, filters,
   exports and enforcement; pricing follows the served deployment's cloud and
   region; missing Government rates stay unpriced; a failed Government query
   is a freshness condition, never zero usage, and never discards Commercial
   results.
6. **Disclosure.** The Connections page states that Government resource
   metadata, access records, telemetry and the management credential are
   processed in Commercial and that organizational approval is required; the
   readiness page lists the connection as "cross-cloud management (not
   sovereign)"; docs say it establishes no regulatory compliance and does not
   authorize transferring restricted data.
7. **Connection rules.** One connection may serve several resources in its
   cloud; a connection cannot be removed while resources use it; secret
   replacement verifies the candidate before switching the reference;
   removing a connection deletes only the stored credential; management
   credentials never enter named values, backends or the marketplace.

## Consequences

- Mixed estates get one console for both clouds; the price is a cross-cloud
  data boundary the operator must approve per deployment.
- Keys provide no private-network connectivity; DNS, routing and private
  endpoints are arranged separately and the docs say so.
- W8 has `review: required` because it handles a credential.
- Sovereign-native remains the path customers with a strict boundary use;
  nothing in cross-cloud is needed for it.

## Alternatives rejected

- Cross-cloud as the default (Mosaic's model; wrong for sovereign customers);
  reusing the environment vault (APIM can read it); inferring cloud from
  tags; one identity across clouds; Government tokens at runtime.

## Verification

With the flag off, no code path references the management vault (a route
enumeration test asserts the connection routes return `404` and the vault
URI is empty); with it on, a GCC-High gateway registered through a connection
lists its inventory, publishes under a reviewed plan, and
`verify-model-access.mjs` passes key-only from a Government caller via
Actions. Q13 names who creates the service principal.
