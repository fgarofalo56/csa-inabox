# ADR-010 — Native rebuild in the console; Mosaic's MIT data artifacts ported, its services not vendored

**Status:** Proposed 2026-10-28; accepted when W1 ships.
**Lineage:** operator decision Q1; Mosaic `LICENSE` (MIT).

## Context

Mosaic is Python 3.12 / FastAPI, two React + Vite SPAs, Cosmos, five Entra
registrations, `azd`-deployed on App Service. Loom's console is Next.js /
TypeScript with Fluent v9, an ARM client for APIM, Cosmos accessors, access
requests, notifications, FinOps and MCP registries already in place, and
die-hard rules that every surface look and behave like one product.

## Decision

1. **Rebuild natively.** All plane logic lives in `apps/fiab-console/lib/api-gateway/**`
   and BFF routes; UI in Fluent v9 with Loom tokens and primitives; the worker
   is a Container Apps Job on the `loom-uat` image, like the existing jobs. No Python service, no second
   SPA, no App Service, no `azd`.
2. **Adopt Mosaic's ADRs as the design contract** (ADR-001 … ADR-009 here
   cite them by number). Behavioural fidelity is the goal; mechanisms change
   only where Loom already has one (`MOSAIC-CAPABILITY-MAP.md` "adapt" rows).
3. **Port as data, with attribution**, after reading each source in full in
   the implementing wave:

   | Mosaic artifact | Loom destination | Wave |
   |---|---|---|
   | `apps/api/src/mosaic_api/data/model_prices.json` + `model_prices.schema.json` | `lib/api-gateway/pricing/model-prices.json`, `model-prices.schema.json` (first version, Mosaic's source URLs and read dates kept) | W4 |
   | `scripts/price_seed.py` | `scripts/csa-loom/price-seed.py` (`--check`, `--cache`, `--date`) | W4 |
   | `integrations/policy.py`, `access_policy.py`, `pool_policy.py`, `mcp_access_policy.py`, `backend_keys.py` (policy renderers, header strip lists, trace formats) | `lib/api-gateway/policy/*.ts` renderers (TypeScript ports; XML templates reproduced; `mosaic-` → `loom-`, `x-mosaic-` → `x-loom-`) | W2, W6, W7 |
   | curated operation sets per shape (ADR 0010/0012) | `lib/api-gateway/shapes/*.ts` | W2 |
   | `integrations/loganalytics/*` KQL and the rollup fold rules (ADR 0019) | `lib/api-gateway/telemetry/kql.ts`, `rollup.ts` | W4 |
   | `scripts/verify_model_access.py`, `verify_mcp_access.py` | `scripts/measure/apiplane/verify-model-access.mjs`, `verify-mcp-access.mjs` | W3, W6 |
   | `environments.py` built-in catalog | `lib/api-gateway/environments/catalog.ts` seed | W1 |
   | `clouds.py` host → cloud inference | `lib/api-gateway/pricing/clouds.ts` | W4 |
   | DESIGN.md content/state rules | `docs/fiab/ux-standards.md` additions | W1 |

   Each ported file carries a header: `Ported from microsoft/mosaic-apim
   (<path>, commit <sha>, MIT). Changes: <list>.` and the repository's
   third-party notices file gains the MIT text if not already present.
4. **Not ported**: the FastAPI routers and repositories, React components,
   `azd` hooks and `infra/`, `entra_bootstrap.py` (Loom's bootstrap script is
   extended instead), ACS email, managed cost-center groups, Bedrock and
   OpenAI-compatible key endpoints (Q3), the Mosaic brand.
5. **Reading rule**: a wave that ports an artifact reads it in full and
   records the commit SHA; this set only records that the files exist
   (`research/mosaic-apim-sources.md`).

## Consequences

- More TypeScript to write than vendoring, but one data model, one identity,
  one design system, one deploy path per boundary, and every rule in
  `.claude/rules/` applies uniformly.
- Mosaic improvements are not inherited automatically; the capability map is
  the diff to re-check at each Mosaic release (a quarterly D-item in W9).
- MIT attribution is a hard requirement of every port.

## Alternatives rejected

- Vendoring the FastAPI service as a Loom app (second data model, five
  registrations, Python per boundary, UIs still to rebuild); running Mosaic
  beside Loom (separate sign-in, Cosmos and look; fails `ui-parity.md`,
  `web3-ui.md`, `auto-bind-by-default.md`).

## Verification

`grep -rn "Ported from microsoft/mosaic-apim" apps/fiab-console/lib/api-gateway scripts` lists every ported file with a commit SHA; the notices file contains the MIT text; no `mosaic-` prefix appears in any rendered fragment (a renderer test asserts the `loom-` prefix and fails on `mosaic-`).
