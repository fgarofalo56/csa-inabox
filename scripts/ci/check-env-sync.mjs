#!/usr/bin/env node
/**
 * GUARDRAIL: env-sync  (merge-blocker)
 * ------------------------------------------------------------------------
 * RULE (no-vaporware.md "Bicep sync requirement"):
 *   Every `process.env.LOOM_*` name that the fiab-console reads at runtime
 *   must EITHER be emitted by the platform bicep (so a from-scratch
 *   `az deployment` produces a working console) OR be explicitly declared
 *   here as a legitimately runtime-only / derived / opt-in variable.
 *
 *   A var that code reads but bicep never sets is silent config drift: it
 *   worked in the live deployment (where someone `az containerapp update`-d
 *   it by hand) but a clean redeploy ships it unset -> the feature gates off
 *   or 500s. This check catches that class before merge.
 *
 * WHAT IT DOES:
 *   1. Collects every LOOM_* name read under apps/fiab-console/{app,lib}.
 *   2. Collects every LOOM_* name emitted anywhere under
 *      platform/fiab/bicep/**\/*.bicep  (env-array `name: 'LOOM_..'` AND any
 *      other CODE reference — params, vars, string interpolation) — with
 *      DOCUMENTATION excluded: `//` comments, block comments, and the argument
 *      of `@description(…)` / `@metadata(…)`. See `stripBicepDocs` for why
 *      (until 2026-08-04 this scanned raw text, so a var merely NAMED in prose
 *      read as "the deploy sets this"; the guard was measuring documentation).
 *   3. Reports read-but-never-emitted names that are NOT covered by an
 *      ALLOWLIST_PATTERN or the explicit ALLOWLIST below. Exits 1 if any.
 *
 * HOW TO ADD AN ALLOWLIST ENTRY (when you add a NEW read-only-at-runtime var):
 *   - If it fits an existing category (a tuning knob, a backend selector, a
 *     secret injected via KV secretRef, an AAD scope / host-suffix derived
 *     from the cloud, an *_API_VERSION pinned in code, an *_ENABLED flag),
 *     it is already matched by an ALLOWLIST_PATTERN — nothing to do.
 *   - Otherwise, if the var is genuinely derived at runtime (e.g. computed
 *     from another emitted var) or is an OPT-IN feature that is intentionally
 *     unset by default, add its exact name to the explicit ALLOWLIST array
 *     with a one-line `// reason`.
 *   - If instead the var SHOULD ship with the deployment, do NOT allowlist it
 *     — add it to the console app's env array in
 *     platform/fiab/bicep/modules/admin-plane/main.bicep (or the owning
 *     module). That is the fix this guard is asking for.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

const CONSOLE_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');
const BICEP_ROOT = path.join(REPO_ROOT, 'platform', 'fiab', 'bicep');

// ── Allowlist patterns: whole categories of legitimately-runtime-only vars ──
// Each is a regex tested against the bare NAME (e.g. "LOOM_QUERY_CACHE").
const ALLOWLIST_PATTERNS = [
  /_BACKEND$/,              // backend selectors — Azure-native is the DEFAULT; only set to opt into an alternative (no-fabric-dependency.md)
  /_ENABLED$/,              // feature toggles — default off, code has a fallback
  /_MS$/,                   // millisecond tuning knobs / TTLs / budgets (code default)
  /_TTL(_MS)?$/,            // cache TTLs
  /_BUDGET_MS$/,            // time budgets
  /_MAX_[A-Z0-9_]+$/,       // MAX_ROWS / MAX_TABLES / MAX_NODES / MAX_CONCURRENCY caps
  /_CONCURRENCY$/,          // concurrency caps
  /_POLLS$/,                // poll-count knobs
  /_CACHE$/,                // cache on/off knobs
  /_RATE_LIMIT$/,           // rate-limit knob
  /_ROWS_PER_PAGE$/,        // paging knob
  /_MAX_AGE_SECS$/,         // session lifetime knob
  /_KEY$/,                  // secrets — injected via KV secretRef (not a plain bicep env literal)
  /_SECRET$/,               // secrets — KV secretRef
  /_TOKEN$/,                // secrets — KV secretRef / PAT
  /_BEARER$/,               // secrets — KV secretRef
  /_CONNECTION_STRING$/,    // secrets — KV secretRef
  /_SCOPE$/,                // AAD resource scopes derived from the cloud (cloud-endpoints.ts)
  /_SUFFIX$/,               // data-plane host suffixes derived from the cloud
  /_API_VERSION$/,          // service API versions pinned in code with a default
  /_MCP_ENDPOINT$/,         // opt-in MCP server endpoints (unset unless deployed)
];

// ── Explicit allowlist: named vars that are runtime-derived, ambient, or opt-in.
// Seeded from the CURRENT tree (2026-07). Each MUST carry a reason.
const ALLOWLIST = new Set([
  // ---- Build / ambient (injected by the container runtime or platform, not app bicep) ----
  'LOOM_CONSOLE_URL',               // read only inside GENERATED hosted-app source (workshop eject-to-code server.js template in _palantir-codegen.ts) — the eject route seeds it as an app binding; never a console-runtime var
  'LOOM_READ_WARMER_DISABLED',      // runtime-only opt-out for the dashboard read-warmer (lib/perf/read-warmer.ts) — warming is on by default, never a deploy dependency
  'LOOM_READ_WARMER_INTERVAL_MS',   // runtime-only tuning knob for the read-warmer interval (default 10 min)
  'LOOM_DL_FRAME_TTL_SECONDS',       // WS-3.3 runtime-only tuning knob: how long the Direct Lake substitute reuses a resolved Delta frame/version before re-framing (default 30s in columnar-cache-query.ts) — framing works without it, never a deploy dependency
  'LOOM_BUILD_SHA',                 // stamped at image build time
  'LOOM_BUILD_TIMESTAMP',           // stamped at image build time
  'LOOM_APP_REVISION',              // ambient container revision fallback for the PSR-1 perf runner (CONTAINER_APP_REVISION is the real ACA-injected value; this is a manual override) — never a blocking dependency
  'LOOM_URL',                       // ambient console base-URL fallback for the PSR-1 perf runner's page-TTI GETs (LOOM_CONSOLE_BASE_URL / the request origin take precedence); also the standard UAT/e2e base-URL convention
  'LOOM_TENANT_ID',                 // ambient Entra tenant (from MSI / token)
  'LOOM_ENTRA_TENANT_ID',           // ambient Entra tenant alias
  'LOOM_REGION',                    // ambient deployment region
  'LOOM_AZURE_LOCATION',            // ambient deployment region alias
  'LOOM_GCCH',                      // cloud flag derived from ARM environment
  'LOOM_IL5',                       // cloud flag derived from ARM environment
  'LOOM_TEMPLATE_TENANT',           // opt-in multi-tenant template mode
  'LOOM_SKIP_DEPLOY_PREFLIGHT',     // dev/opt-in escape hatch
  'LOOM_UDF_ALLOWED_FUNCTION_BASES',// OPT-IN operator approval list for per-item UDF function-host overrides (lib/azure/udf-endpoint-policy.ts). Unset by default: the bicep-emitted LOOM_UDF_FUNCTION_BASE is the only approved endpoint, which is the secure default — an operator adds a host here only to allow their own Azure Function App.
  'LOOM_FABRIC_UDF_ALLOWED_HOSTS',  // OPT-IN extra approved hosts for the opt-in Fabric UDF backend (LOOM_UDF_BACKEND=fabric). Unset by default; LOOM_FABRIC_UDF_HOST alone is sufficient (no-fabric-dependency.md keeps Fabric off the default path).
  'LOOM_MAPS_GEOCODE_URL',          // opt-in self-hosted OSS Nominatim (OpenStreetMap) geocoder for the MapLibre (GCC-High) backend; unset => the map's address-geocode sub-feature honest-gates (503) while lat/long + filled layers render. Not a deploy dependency.
  'LOOM_OPENLINEAGE_AUDIENCE',      // L2 opt-in override of the OpenLineage ingest's pinned token audience (defaults to the bicep-wired LOOM_MSAL_CLIENT_ID / api://<clientId>) — runtime-only, never a deploy dependency
  'LOOM_PYLSP_DEBUG',               // dev-only language-server debug flag
  'LOOM_PYLSP_PYTHON',              // dev-only python path override
  'LOOM_POWERPLATFORM_ASSUME_CRED', // opt-in Power Platform cred mode
  'LOOM_COPILOT_STUDIO_PORTAL_URL',  // opt-in cloud override for the Copilot Studio maker-portal deep link (default commercial copilotstudio.microsoft.com; set for Gov) — T93
  'LOOM_M365_ADMIN_CENTER_URL',      // opt-in cloud override for the M365 admin-center approval link (default commercial admin.microsoft.com; admin.microsoft.us for Gov) — T93
  'LOOM_INTERNAL_ALLOWED_OIDS',     // opt-in allowlist of automation oids for the token-gated internal surface (rel-T10/B3); unset default = any well-formed GUID
  'LOOM_MCP_EGRESS_ALLOW',          // opt-in SSRF egress allow-list for admin MCP test-connection (rel-T13)
  'LOOM_A2A_EGRESS_ALLOW',          // WS-5.2 gov-safe A2A OUTBOUND egress allow-list; runtime-only knob, unset = outbound A2A disabled (sovereign default). Inbound A2A needs no config. Also gates the WS-9 mesh A2A/MCP hops.
  'LOOM_MESH_PROFILE',              // opt-in WS-9 mesh egress profile override (commercial|gov|air-gap); unset = cloud default (gov cloud → gov, else commercial)
  'LOOM_EVAL_MONITOR_ACTION_GROUP_ID', // WS-1.5 opt-in Azure Monitor action group ARM resource ID for the eval-regression alert; unset = alert fires silently (Azure Monitor still captures it) with no email/webhook routing
  'LOOM_EVAL_SEARCH_PRINCIPAL_OID',  // SRCH1 opt-in eval principal oid for /api/internal/copilot/search-probe (the demo/admin oid whose accessible workspaces hold the golden search items); unset = federated-search evals honest-gate (no fabricated results)
  'LOOM_MULTIUSER_ACL',             // opt-out kill switch for the multi-user ACL fallback (default on in code; rel-T11)
  'LOOM_ONBOARDING_ENTRA_GROUP_ID', // #2758 opt-in: the Entra group an onboarded access requester is added to. Unset => falls back to LOOM_TENANT_ADMIN_GROUP_ID (already bicep-wired); the access-gov wizards still invite/create without it (workspace roles grant access). Never a deploy dependency.
  'LOOM_PUBLIC_URL',                // #2758 ambient opt-in override for the guest-invite redeem redirect. The request Origin header is the primary source; this is only a fallback for that one link. Never a deploy dependency.
  'LOOM_APP_URL',                   // #2758 ambient alias of LOOM_PUBLIC_URL (same redeem-redirect fallback) — never a deploy dependency.
  'LOOM_SEMANTIC_LINK',             // opt-out kill switch for injecting the Semantic Link notebook helper preamble (default on in code; FGC-17) — Azure-native, no Fabric
  'LOOM_SCHEDULER_EMAIL_WEBHOOK',   // opt-in email relay (ACS/Logic App/SMTP) for scheduler failure alerts (rel-T81); unset = alerts land in the Loom inbox + optional webhook only
  'LOOM_DATABRICKS_UC_STORAGE_ROOT', // opt-in managed-location base (abfss://…) for domain→UC-catalog sync when the metastore has no default storage_root; unset = send no storage_root (metastores with a default root work as-is)
  'LOOM_ITEM_VERSION_CAP',          // opt-in tuning knob for the per-item version-history retention cap (W6); unset default = 50 in code (lib/versions/item-version-store.ts)
  'LOOM_DAB_APP_NAME',              // opt-in override for the shared DAB preview Container App name (apply-to-runtime route #19); unset = derived from the LOOM_DAB_PREVIEW_URL host's first FQDN label
  // ---- #3730 cross-cloud estate drift: per-estate endpoint OVERRIDES ----
  // The four below are optional overrides of the LOOM_ESTATES registry in
  // apps/fiab-console/lib/admin/estate-fleet.ts, whose defaults are the LIVE,
  // measured, unauthenticated endpoints of each console. Unset is the working
  // production state — the readiness fleet table reads both estates with none of
  // these set — so they are runtime-only knobs, never a deploy dependency, and
  // emitting them from bicep would only restate a constant the image already has.
  //
  // STATED PLAINLY BECAUSE IT IS A REAL LIMITATION, not a shrug: the Gov default
  // is an Azure Front Door FQDN with a generated label
  // (loom-console-<hash>.z01.azurefd.us). If Gov is ever redeployed behind a NEW
  // Front Door, that default goes stale and the estate reads UNREACHABLE — which
  // is loud and honest (never a false "current"), but it is a redeploy away from
  // needing LOOM_ESTATE_URL_GOV set. These overrides are how that is fixed
  // without a code change, which is why they exist at all.
  'LOOM_ESTATE_URL_COMMERCIAL',
  'LOOM_ESTATE_URL_GOV',
  'LOOM_ESTATE_VERSION_URL_COMMERCIAL',
  'LOOM_ESTATE_VERSION_URL_GOV',
  'LOOM_CANVAS_COMMENT_CAP',        // opt-in tuning knob for the per-(item,canvas) comment/sticky retention cap (W4); unset default = 300 in code (lib/collab/canvas-comment-model.ts)
  'LOOM_ADT_ENDPOINT',
  'LOOM_SPARK_POOL_REAP',            // opt-out kill switch for the stale-Livy-session reaper (#1796; default ON — pool self-cleans leaked sessions)
  'LOOM_SPARK_POOL_REAP_GRACE',      // opt-in tune: grace seconds before an untracked Livy session is reaped (default 600)              // opt-in Azure Digital Twins endpoint (FGC-12); default twin backend is ADX-native — deploy platform/fiab/bicep/modules/integration/adt-instance.bicep to enable
  // LOOM_ICEBERG_CATALOG_URL is NO LONGER allowlisted: the N1 Iceberg REST
  // Catalog is DEFAULT-ON. admin-plane/main.bicep deploys
  // data-plane/iceberg-catalog-aca.bicep and emits the var, so this guard now
  // ENFORCES that wiring instead of excusing its absence — which is exactly how
  // the live estate ended up carrying a hand-set 0.0.0.0 placeholder.
  // (LOOM_ICEBERG_CATALOG_TOKEN auto-allowed by /_TOKEN$/.)
  // LOOM_RISINGWAVE_URL and LOOM_DUCKDB_URL were allowlisted here as "opt-in …
  // deployed out-of-band via data-plane/*.bicep (admin-plane/main.bicep at the
  // 256-param ceiling), then set on the console app". BOTH reasons are stale —
  // admin-plane/main.bicep deploys each tier by DEFAULT and emits the var:
  //   LOOM_RISINGWAVE_URL  main.bicep:3796  (module :5808, `risingwaveActive`)
  //   LOOM_DUCKDB_URL      main.bicep:5005  (`duckdbTierActive`)
  // The note immediately below already CLAIMED LOOM_DUCKDB_URL had been removed
  // in #2640 round 2; it had not — the entry survived, so the claim in the file
  // and the contents of the file disagreed, and nothing enforced the default-ON
  // promise for either var. An allowlisted var is INVISIBLE to this guard: if a
  // future edit drops the bicep emission, the guard stays green. Both entries
  // are REMOVED so the guard enforces the emission it is here to enforce.
  // (LOOM_RISINGWAVE_DATABASE / _USER stay below — they are genuine code-default
  // runtime knobs, not deploy dependencies.)
  'LOOM_RISINGWAVE_DATABASE',        // N7a opt-in RisingWave database override (code default 'dev') — runtime-only knob, never a deploy dependency
  'LOOM_RISINGWAVE_USER',            // N7a opt-in RisingWave user override (code default 'root') — runtime-only knob, never a deploy dependency
  // LOOM_RISINGWAVE_PASSWORD was allowlisted here as "opt-in; single-node default
  // is in-VNet trust (no password)". That default WAS the vulnerability: RisingWave
  // ships `root` with no password, and every app in a Container Apps environment
  // draws its pod IP from the same infrastructure subnet, so "in-VNet trust" meant
  // loom-script-runner and loom-udf-runtime — two services that execute
  // user-supplied code — could open a root session. The credential is now
  // MANDATORY and admin-plane/main.bicep emits it as a Key-Vault-backed
  // secretRef, so the entry is REMOVED and the guard enforces the emission.
  'LOOM_MIGRATE_AUDIENCE',           // M1 opt-in AAD audience (app id URI) for the loom-migrate reader's bearer token; unset => the BFF reaches the internal-ingress reader on in-VNet trust (no anonymous public path exists).
  // (LOOM_DUCKDB_URL and LOOM_FLIGHTSQL_URL used to be allowlisted here as
  //  "deployed out-of-band". REMOVED in PR #2640 round 2: admin-plane/main.bicep now
  //  deploys the N2b/N3 DuckDB serving tier by default (duckdbTierActive) via
  //  data-plane/duckdb-aca.bicep and binds both vars on the Console, so the guard
  //  fails if that wiring is ever regressed away. Without the tier the DuckLake
  //  catalog gate below could never actually clear — the engine that runs its
  //  ATTACH did not exist in any deployment.)
  // (LOOM_DUCKLAKE_CATALOG_URL used to be allowlisted here as "operator-provided /
  //  not bicep-emitted". It is now DEFAULT-ON and emitted by admin-plane/main.bicep
  //  as a Key Vault secretRef backed by data-plane/ducklake-catalog-postgres.bicep.
  //  The allowlist entry was removed DELIBERATELY so this guard fails if that
  //  wiring is ever regressed away.)
  'LOOM_FLIGHTSQL_PUBLIC_URL',       // N3 opt-in EXTERNALLY-reachable Flight endpoint an operator publishes (behind Front Door / a private-link listener). Deliberately not bicep-emitted: the internal-ingress address must never be handed to a client, so this is set only when a real public listener exists. Unset => the Connect tab honestly reports "in-VNet only" instead of printing an unreachable host.
  'LOOM_FLIGHT_ROW_THRESHOLD',       // N3 opt-in tuning knob: rows past which Loom's own grids switch from JSON to the Arrow transport; unset default = 5000 in code (lib/arrow/transport-policy.ts)
  'LOOM_ICEBERG_CATALOG_PREFIX',     // N1 opt-in IRC path prefix override (code default /api/2.1/unity-catalog/iceberg) — runtime-only knob, never a deploy dependency
  'LOOM_ICEBERG_CATALOG_WAREHOUSE',  // N1 opt-in IRC warehouse override (code default 'loom') — runtime-only knob, never a deploy dependency
  'LOOM_ICEBERG_CATALOG_AUDIENCE',   // N1 opt-in Entra audience for the upstream catalog hop (defaults to api://<LOOM_MSAL_CLIENT_ID>) — runtime-only knob
  // LOOM_TRINO_URL is NO LONGER allowlisted: N7e is DEFAULT-ON. The push-button
  // deploy stands up the scale-to-zero single-node Trino Container App
  // (data-plane/loom-trino-aca.bicep) and admin-plane/main.bicep emits the var,
  // so this guard now enforces that wiring instead of excusing its absence.
  // (LOOM_TRINO_TOKEN auto-allowed by /_TOKEN$/; LOOM_TRINO_FETCH_TIMEOUT_MS by /_MS$/.)
  // LOOM_TRINO_AUDIENCE is NO LONGER allowlisted either. Its old note said
  // "unset => the BFF reaches the internal-ingress cluster on in-VNet trust",
  // which stopped being true the moment the engine started ENFORCING Entra bearer
  // authorization (#2678 §3) — in-VNet trust is precisely the posture that was
  // removed. admin-plane/main.bicep emits it alongside LOOM_TRINO_AUTH_MODE.
  'LOOM_TRINO_ICEBERG_CATALOG',      // N7e opt-in Trino catalog name that fronts the Loom Iceberg REST Catalog (code default 'iceberg') — runtime-only knob, never a deploy dependency
  'LOOM_SHARING_AUDIENCE',          // LU-9 the Entra AUDIENCE an external Delta Sharing RECIPIENT's token must carry: a DEDICATED app registration (App ID URI) for the sharing API. When set it REPLACES the fallback (api://<LOOM_MSAL_CLIENT_ID>) rather than adding to it, so the Console's own API stops being a data-export credential. One of this or LOOM_SHARING_SCOPE is REQUIRED once LOOM_SHARING_URL is set (env-check svc-loom-sharing anyOf) — /api/delta-sharing/* fails CLOSED with 503 otherwise. Runtime-only (an Entra app registration, not an ARM resource), never a deploy dependency.
  'LOOM_SHARING_SCOPE',             // LU-9 the alternative half of the same pin: a scope or app role (comma/space separated) that a recipient token must carry in scp/roles. Lets an estate keep the Console's own registration as the audience while still separating recipient tokens from ordinary Console API tokens — expose the scope on the Console app registration and consent it ONLY to recipient apps. Runtime-only. See lib/sharing/store.sharingAudiencePinned + docs/fiab/delta-sharing-gov.md.
  // LU-9 the sharing SERVER's own URL. Surfaced by the doc-blindness fix: it
  // appeared "emitted" only through comments + an @description in
  // compute/loom-sharing-app.bicep. That module is a STANDALONE out-of-band
  // entrypoint (admin-plane/main.bicep is at the ARM 256-param ceiling), so no
  // orchestrator invokes it and no template can emit its FQDN. Its two audience
  // pins above are already allowlisted for the same reason. Unset (the default)
  // => /api/delta-sharing/* honest-gates; nothing else changes.
  'LOOM_SHARING_URL',
  'LOOM_POWERBI_USER_PASSTHROUGH',  // opt-out kill switch for Power BI user-passthrough (OBO) auth (#1800 PBI slice; default ON in code — all Power BI tie-ins authenticate as the signed-in user, Synapse-style); set 'false' to revert every Power BI call to the console service principal
  'LOOM_POWERPLATFORM_USER_PASSTHROUGH', // opt-out kill switch for the SAME passthrough on the Power Platform / Copilot Studio clients (default ON in code). Those clients now try the signed-in user FIRST and RETRY as the service principal on 401/403 (lib/azure/powerplatform-client.ts ppFetch), because only a licensed USER can author Power Automate flows / act as a Dataverse application user, while only the registered management app can use the BAP admin scope. Set 'false' to revert both clients to the pure service-principal path.
  'LOOM_POWERAPPS_SCOPE',           // opt-in override for the Power Apps AAD audience (default https://service.powerapps.com/.default). Sovereign boundaries can use a different audience than the Commercial one, and it is NOT derivable from the REST host — runtime-only knob, resolved in lib/azure/cloud-endpoints.powerPlatformEndpoints().
  'LOOM_FLOW_SCOPE',                // opt-in override for the Power Automate (Flow) AAD audience (default https://service.flow.microsoft.com/.default) — same rationale as LOOM_POWERAPPS_SCOPE.
  'LOOM_RESULT_CACHE_REDIS_BREAKER_THRESHOLD', // opt-in tune: consecutive Redis-tier failures before the cache circuit breaker opens (default 3 in redis-cache-client.ts)
  'LOOM_SETUP_DISCOVERY_CACHE_DISABLED', // opt-out kill switch for the in-process cross-sub discovery SWR cache (Setup / Add-landing-zone wizards); default on in code (lib/azure/cross-sub-cache.ts) — a latency-only memo, no infra
  'LOOM_BATCH_SUB',                 // opt-in subscription override for the Azure Batch account (SVC-5); default = LOOM_SUBSCRIPTION_ID
  // The three remaining names the doc-blindness fix surfaced, each genuinely
  // un-emittable by the shipped orchestrators:
  //
  // LOOM_CAPACITY_BROKER_URL — a LEGACY ALIAS, not a deploy dependency. The
  //   name the deploy emits is LOOM_BROKER_URL (admin-plane/main.bicep:3816,
  //   empty default), which is also the name the readiness gate, EDITABLE_ENV,
  //   self-audit and docs/fiab/hyperscale.md all use. lib/azure/
  //   capacity-broker-client.ts historically read ONLY this alias, so following
  //   the documented remediation turned the gate green while leaving the client
  //   disabled; the client now reads LOOM_BROKER_URL as well (see its header),
  //   and this entry keeps estates that already set the alias working.
  'LOOM_CAPACITY_BROKER_URL',
  // LOOM_EVENTGRID_SAS_AUTH — an opt-IN to the LESS secure posture. Entra-only
  //   publish is the deployed default and is MANDATORY at GCC-High/IL5
  //   (landing-zone/eventgrid*.bicep disableLocalAuth). Emitting it would mean
  //   shipping a var whose only purpose is to weaken auth; unset is correct.
  'LOOM_EVENTGRID_SAS_AUTH',
  // LOOM_PERF_DCR_ENDPOINT / LOOM_PERF_DCR_ID — outputs of
  //   admin-plane/perf-benchmarks-dcr.bicep, which NO orchestrator invokes: its
  //   own header documents a standalone `az deployment group create` and the
  //   operator then sets these two values. Verified: the only repo references
  //   are inside that module. Unset => the perf-benchmark publisher no-ops.
  'LOOM_PERF_DCR_ENDPOINT',
  'LOOM_PERF_DCR_ID',
  'LOOM_CANVAS_AI_SUGGEST',         // opt-out kill switch for the W7 AOAI ghost-suggestion engine (default on in code)
  'LOOM_COPILOT_MEMORY',            // opt-out kill switch for the CTS-06 dump-to-memory action (default on in code)
  'LOOM_COPILOT_MEMORY_AGENT_ID',   // opt-in override for the memory agent identity (CTS-06); unset default in code
  'LOOM_COPILOT_MEMORY_FLUSH_N',    // opt-in tuning knob: how many turns a memory flush extracts (CTS-06)
  'LOOM_COPILOT_MEMORY_CAP',        // opt-in tuning knob: per-scope memory cap before oldest-eviction (CTS-08)
  'LOOM_COPILOT_MEMORY_VEC_INDEX',  // opt-in override for the AI Search vector-mirror index name (CTS-08; default 'copilot-memory-vec' in code)
  'LOOM_COPILOT_MEMORY_L0_LIMIT',   // opt-in tuning knob: L0 identity/preference recall count (CTS-08)
  'LOOM_COPILOT_MEMORY_L1_LIMIT',   // opt-in tuning knob: L1 high-confidence fact recall count (CTS-08)
  'LOOM_COPILOT_MEMORY_L2_TOPK',    // opt-in tuning knob: L2 vector-relevant recall top-K (CTS-08)
  'LOOM_COPILOT_MEMORY_CONSOLIDATE_SCAN', // opt-in tuning knob: per-scope scan depth for the CTS-13 nightly pass
  'LOOM_COPILOT_MEMORY_DEDUPE_SIM', // opt-in tuning knob: Jaccard similarity threshold for CTS-13 near-duplicate merge
  'LOOM_COPILOT_MEMORY_TOPIC_MIN',  // opt-in tuning knob: min tag recurrence to promote a CTS-13 topic page
  'LOOM_SPARK_POOL_CONCURRENT',     // opt-out kill switch for the FGC-10 concurrent shared-session mode (default on in code)
  'LOOM_SPARK_POOL_SHARED_MAX',     // opt-in tuning knob: max read-only leases sharing one warm session (PSR-3/FGC-10)
  'LOOM_SPARK_VCORE_BUDGET',        // opt-in tuning knob (A12): max estimated active Spark vCores before refusing a new session; default 400 in code (0 = unlimited)
  'LOOM_SPARK_TENANT_SESSION_MAX',  // opt-in tuning knob (A12): max concurrent active Spark sessions; default 50 in code (0 = unlimited)
  // PSR-5/6 result cache — all opt-in: unset default = in-process LRU (no Redis,
  // no behavior change). The shared Redis is the hband-shared.bicep instance
  // deployed out-of-band (admin-plane at the 256-param ceiling).
  'LOOM_RESULT_CACHE_REDIS',           // opt-in Redis host:port for the shared result-cache tier (PSR-5/6)
  'LOOM_RESULT_CACHE_REDIS_PASSWORD',  // opt-in Redis access key (PSR-5/6); prefer KV/secretRef when wired into bicep
  'LOOM_RESULT_CACHE_REDIS_TLS',       // opt-in TLS toggle for the Redis tier (default on for :6380)
  // Same H-band shared-Redis family as LOOM_RESULT_CACHE_REDIS above, and the
  // one member of it that was never allowlisted — it read as "emitted" only via
  // an @description in compute/hband-shared.bicep:423 and a comment in
  // landing-zone/cosmos.bicep:336, both of which merely NAME it. Surfaced by the
  // doc-blindness fix in stripBicepDocs(). Opt-in exactly like its siblings:
  // unset = the Spark session pool keeps its lease ledger in Cosmos
  // (LOOM_SPARK_POOL_LEASE_CONTAINER, which IS emitted) and nothing gates.
  'LOOM_SPARK_POOL_REDIS',
  'LOOM_QUERY_CACHE_TTL_MS_DEDICATED', // opt-in tuning knob: dedicated-pool result TTL override (PSR-5)
  'LOOM_QUERY_CACHE_TTL_MS_SERVERLESS',// opt-in tuning knob: serverless result TTL override (PSR-5)
  // OBS-CACHE — per-backend result-TTL overrides for the observability routes'
  // stale-while-revalidate cache (chargeback/usage/audit/copilot-usage/monitor).
  // All opt-in tuning knobs: unset default = the route's own default TTL in code.
  'LOOM_QUERY_CACHE_TTL_MS_COSTMGMT',    // opt-in: chargeback / cost-attribution TTL override (default 20m)
  'LOOM_QUERY_CACHE_TTL_MS_USAGEROLLUP', // opt-in: usage-metrics TTL override (default 5m)
  'LOOM_QUERY_CACHE_TTL_MS_AUDITMERGE',  // opt-in: audit-log 3-backend-merge TTL override (default 5m)
  'LOOM_QUERY_CACHE_TTL_MS_COPILOTUSAGE',// opt-in: copilot-usage TTL override (default 10m)
  'LOOM_QUERY_CACHE_TTL_MS_MONITOR',     // opt-in: monitor inventory/health/activity/metrics TTL override (default 90s)
  // PSR-8 Copilot turn-latency SLO — opt-in tuning knobs; unset defaults match the
  // perf-budgets ceilings so the CI gate and the runtime SLO never disagree.
  'LOOM_COPILOT_SLO_FIRST_TOKEN_MS', // opt-in: streaming first-token p95 budget override (default 5000)
  'LOOM_COPILOT_SLO_FULL_TURN_MS',   // opt-in: full-turn p95 budget override (default 30000)
  'LOOM_COPILOT_SLO_OBJECTIVE',      // opt-in: SLO attainment objective 0..1 override (default 0.95)
  // Databricks pipeline linked-service binding — opt-in (Databricks is an
  // alternative Azure-native compute; Synapse is the default). Used by the
  // dev-pipeline seeder to auto-stub / bind the AzureDatabricks linked service a
  // bundle's Databricks-notebook activities require. Unset default = honest
  // remediation gate on those pipeline items (lib/install/provisioners/_seed-dev-pipeline.ts).
  'LOOM_DATABRICKS_WORKSPACE_URL',        // opt-in Databricks workspace URL (alias of LOOM_DATABRICKS_HOSTNAME with scheme)
  'LOOM_DATABRICKS_WORKSPACE_RESOURCE_ID', // opt-in Databricks workspace ARM resourceId — enables MSI auth on the auto-stubbed linked service
  'LOOM_DATABRICKS_LINKED_SERVICE',       // opt-in name of an already-registered AzureDatabricks linked service to reuse instead of auto-stubbing
  // SVC-1/SVC-8 — AI-enrichment cognitive endpoints. NOW EMITTED default-ON by
  // admin-plane/main.bicep (LOOM_DOCINTEL/VISION/LANGUAGE/TRANSLATOR_ENDPOINT +
  // LOOM_TRANSLATOR_REGION), derived from the multi-service AIServices (Foundry)
  // custom-domain endpoint the Console UAMI already has "Cognitive Services User"
  // on — so they are no longer allowlisted (a clean deploy wires them). Dedicated
  // single-kind accounts (deploy-planner/cognitive-account.bicep) remain an opt-in
  // override set via /admin/env-config.

  // ---- Derived from an emitted var at runtime (KV name<->url, cosmos endpoint<->id, etc.) ----
  'LOOM_KEY_VAULT_NAME',            // derived from LOOM_KEY_VAULT_URL
  'LOOM_KEY_VAULT_URL',             // derived from KV name / emitted per-module
  'LOOM_COSMOS_DB',                 // default 'loom'; derived when unset
  'LOOM_COSMOS_ACCOUNT_ENDPOINT',   // derived from cosmos account id
  'LOOM_COSMOS_ACCOUNT_ID',         // derived from account name + sub
  'LOOM_CAE_ID',                    // derived from CAE name + rg
  'LOOM_CAE_NAME',                  // derived / ambient container-app env name
  'LOOM_CAE_DEFAULT_DOMAIN',        // derived from CAE ingress
  'LOOM_CONSOLE_APP_NAME',          // ambient container-app name
  'LOOM_CONSOLE_PUBLIC_URL',        // derived from ingress FQDN / Front Door
  'LOOM_PUBLIC_BASE_URL',           // derived from ingress FQDN / Front Door
  'LOOM_DOMAIN_NAME',               // derived per-workspace domain
  'LOOM_UAMI_APP_ID',               // derived from the bound user-assigned MI
  'LOOM_UAMI_NAME',                 // derived from the bound user-assigned MI
  'LOOM_ONELAKE_BASE',              // derived from cloud endpoints
  'LOOM_ONELAKE_DFS_BASE',          // derived from cloud endpoints
  'LOOM_DLP_GRAPH_BASE',            // derived from cloud endpoints (Graph)
  'LOOM_DEVOPS_BASE',               // derived from cloud endpoints (Azure DevOps)
  'LOOM_DOCS_BASE_URL',             // derived from public docs site
  // LEGACY ALIAS, and the comment on this line used to be a LIE that hid a real bug.
  // It read "derived from cloud endpoints (BAP)" — but no code derived anything:
  // copilot-studio-client read THIS var directly while bicep emitted the DIFFERENT
  // var LOOM_BAP_BASE, so the entire Copilot Studio family was pinned to the
  // Commercial host in every sovereign boundary. Seven parity docs told operators
  // to set this name; this exemption is why nobody noticed nothing consumed it.
  // The claim is now TRUE: lib/azure/cloud-endpoints.powerPlatformEndpoints()
  // derives the BAP host from the detected cloud and accepts this name only as a
  // back-compat alias for LOOM_BAP_BASE, so an estate that set it is not regressed.
  // Keep the entry (nothing emits the alias); do NOT restore the old wording.
  'LOOM_POWER_PLATFORM_BAP_BASE',
  'LOOM_POWERBI_EMBED_HOST',        // derived from cloud endpoints (Power BI)
  'LOOM_AZURE_MAPS_SEARCH_HOST',    // derived from cloud endpoints (Azure Maps)
  'LOOM_AML_DATAPLANE_HOST',        // derived from AML workspace region
  'LOOM_FABRIC_UDF_HOST',           // opt-in Fabric UDF host
  'LOOM_ARG_URL',                   // derived ARM Resource Graph endpoint
  'LOOM_DIRECTLINE_TOKEN_URL',      // derived DirectLine endpoint

  // ---- Optional / opt-in service targets (unset unless that service is provisioned) ----
  'LOOM_AAS_DB',                    // Azure Analysis Services db (opt-in semantic layer)
  'LOOM_AAS_LOCATION',              // AAS region (opt-in)
  'LOOM_AAS_SKU',                   // AAS sku (opt-in)
  'LOOM_AAS_XMLA_URL',              // AAS XMLA endpoint (opt-in)
  'LOOM_ADLS_CONTAINER',            // default 'loom'; derived when unset
  'LOOM_AML_SCHEDULE_ENVIRONMENT',  // AML curated env name (code default)
  'LOOM_AML_SERVERLESS_VMSIZE',     // AML serverless job VM size (code default Standard_DS3_v2)
  'LOOM_AML_SPARK_INSTANCE_TYPE',   // AML spark sizing (code default)
  'LOOM_AML_SPARK_RUNTIME',         // AML spark runtime version (code default)
  'LOOM_ADMIN_RESOURCE_GROUP',      // script-context alias for LOOM_ADMIN_RG; falls back to resourceGroup()/ARM
  'LOOM_AML_WORKSPACE_NAME',        // derived from Foundry hub
  'LOOM_APPS_KEY_VAULT_URI',        // opt-in KV uri for Loom Apps secretRef env resolution; falls back to LOOM_KEY_VAULT_URI (loom-apps-client)
  'LOOM_AOAI_CLIENT_V2',            // opt-in AOAI client switch
  // Model-strategy M4 — OPT-IN APIM AI-gateway routing. Emitted by admin-plane/main.bicep
  // (default OFF/direct), and read via an injected `env` param in aoai-apim-gateway.ts
  // (resolveAoaiCallTarget) rather than a literal process.env.* — so the reader-scan
  // does not see them; allowlisted explicitly to document intent. Default = direct-with-MI.
  'LOOM_AOAI_VIA_APIM',             // opt-in: route AOAI through the APIM gateway (default false → direct)
  'LOOM_AOAI_APIM_URL',             // opt-in: APIM gateway URL (emitted only when the AI-gateway is authored)
  'LOOM_AOAI_APIM_SUBSCRIPTION_KEY',// opt-in APIM subscription key for the AI-gateway (secret; MI bearer works without it)
  // Model-strategy M5 — cloud-aware best-available model resolution. Opt-OUT
  // kill switch (default ON): the runtime degrades a configured-but-undeployed
  // model down to a supported one (per model-availability-matrix.ts) against the
  // account's live deployment list. Cached + non-fatal; never blocks a chat.
  'LOOM_AOAI_AVAILABILITY_CHECK',   // opt-out: disable the M5 best-available-model fallback (default ON → configured-but-missing model degrades gracefully instead of 404ing)
  'LOOM_AZURE_SQL_DEFAULT_DB',      // sample-DB default (code default)
  'LOOM_AZURE_SQL_DEFAULT_SERVER',  // sample-DB default (code default)
  'LOOM_BI_RENDER_FUNCTION_NAME',   // derived report-render function name
  'LOOM_COPILOT_FUNCTION_URL',      // derived copilot function endpoint
  'LOOM_COSMOS_VCORE_DATABASE',     // opt-in cosmos vCore (pgvector alt)
  'LOOM_COST_SUBSCRIPTIONS',        // opt-in cost-scope subscription list
  // GHSA-v8r7-c2p5-mjf2 — opt-in NARROWING/widening of the Azure SQL /
  // PostgreSQL authorization boundary. Not an auto-bind violation: the DEFAULT
  // is derived from LOOM_SUBSCRIPTION_ID + LOOM_DLZ_SUBSCRIPTION_ID, both of
  // which the deploy already emits, so the feature works with zero operator
  // configuration. Deliberately NOT delivered as an always-empty env entry —
  // that would be the inert shape this file's own always-empty check rejects.
  'LOOM_SQL_AUTHORIZED_SUBSCRIPTIONS',
  'LOOM_DATABRICKS_CATALOG',        // UC catalog default (code default)
  'LOOM_DATABRICKS_CLUSTER_ID',     // derived / opt-in default cluster
  // Surfaced by the comment-blindness fix in collectEmitted() (2026-08-04): it
  // was "emitted" only by admin-plane/spark-session-pool.bicep:27, a comment
  // DOCUMENTING that an operator sets it. Same family as
  // LOOM_DATABRICKS_CLUSTER_ID above and genuinely un-emittable: the value is a
  // Databricks all-purpose cluster id created by the user INSIDE their
  // workspace, which no ARM template can know. It gates nothing — when unset,
  // spark-session-pool.ts simply skips Databricks pre-warm (`if (gate.backend
  // === 'databricks' && !process.env.LOOM_DATABRICKS_DEFAULT_CLUSTER) return;`)
  // and the prove-warm route answers 200 with `configured:false`.
  'LOOM_DATABRICKS_DEFAULT_CLUSTER',
  'LOOM_DATABRICKS_DEFAULT_CATALOG',// UC catalog default (code default)
  'LOOM_DATABRICKS_DEFAULT_SCHEMA', // UC schema default (code default)
  'LOOM_DATABRICKS_SCHEMA',         // UC schema default (code default)
  'LOOM_DATABRICKS_SUBSCRIPTIONS',  // opt-in databricks discovery scope
  'LOOM_DBT_RUNNER_AUDIENCE',       // opt-in dbt runner audience
  'LOOM_TRANSFORM_RUNNER_AUDIENCE', // N4 — opt-in Entra audience for the loom-transform-runner ACA app when Easy Auth is layered on its internal ingress; unset = in-VNet trust (the deployed default). The runner URL itself IS bicep-emitted (LOOM_TRANSFORM_RUNNER_URL).
  'LOOM_DEFAULT_POWERBI_WORKSPACE', // opt-in Power BI workspace (Fabric-family, opt-in)
  'LOOM_PBI_CAPACITY_ID',           // opt-in Fabric/Premium capacity id (Weave→Power BI D2); unset default = the VM on-prem data gateway is used. When set, the Network pane recommends the managed VNet data gateway auto-upgrade (LOOM_PBI_GATEWAY_MODE=auto). Operator provides per D3.
  'LOOM_PBI_WORKSPACE_ID',          // opt-in bound Power BI workspace id (Weave→Power BI D3, real-PBI destination W5); unset default = the real Power BI Service destination honest-gates and the Azure-native/loom-native path is used. Operator provides.
  'LOOM_PBI_TEMPLATE_REPORT',       // opt-in blank template report (id or name) the real-PBI report/dashboard targets clone (Power BI REST has no create-report-bound-to-model API — W5); unset default = report/dashboard on the real-PBI path honest-gates. Operator uploads a blank .pbix + sets this.
  'LOOM_DELTA_SHARING_VOLUME',      // opt-in delta-sharing volume
  'LOOM_DEVCENTER_CATALOG',         // opt-in DevCenter catalog
  'LOOM_DEVCENTER_ENV_TYPE',        // opt-in DevCenter env type
  'LOOM_DEVCENTER_URI',             // opt-in DevCenter uri
  'LOOM_DIRECT_LAKE_COSMOS_CONTAINER', // opt-in Direct Lake mirror
  'LOOM_DIRECT_LAKE_COSMOS_DB',     // opt-in Direct Lake mirror
  // LOOM_DIRECTLAKE_URL was here. REMOVED (#3291): it is now EMITTED by
  // platform/fiab/bicep/modules/admin-plane/main.bicep from the loomDirectLake
  // module's own fqdn output (directLakeSvcActive, default-ON), so it no longer
  // qualifies as "an OPT-IN feature intentionally unset by default" — which is
  // the only thing this list is for. The old entry also carried the false
  // justification this guard helped keep alive for a year: "deploy
  // compute/loom-directlake-app.bicep out-of-band (admin-plane/main.bicep at the
  // 256-param ceiling)". Measured at the time of the fix: 238 params, 18 of
  // headroom, and wiring the module added ZERO new params. An allowlist entry
  // that repeats an unverified reason is how a dead capability stays invisible.
  'LOOM_DQ_SOURCE_CONNECTION_STRING', // handled by _CONNECTION_STRING pattern; kept for clarity
  'LOOM_DSPM_AI_AGENT_ITEM_TYPES',  // classifier config list (code default)
  'LOOM_DSPM_AI_WINDOW_DAYS',       // opt-in default usage-window override (code default 14)
  'LOOM_DSPM_AI_TTL_MS',            // opt-in posture-memo TTL tuning (code default 60s)
  'LOOM_EVENTHUB_CONSUMER_GROUP',   // opt-in consumer-group override for the EH health-exercise probe (code default 'loom')
  'LOOM_EVENTHUB_DEFAULT_HUB',      // opt-in default hub name for the EH health-exercise probe (code default 'loom-eventstream')
  'LOOM_EVENTSTREAM_EVENTS_TABLE',  // ADX table default (code default)
  'LOOM_ASA_REFERENCE_CONTAINER',   // opt-in blob container for the ASA reference-data geofence (falls back to 'landing' → first configured container)
  'LOOM_EVENTSTREAM_HUB',           // opt-in eventstream hub-name alias for the EH health-exercise probe (fallback for LOOM_EVENTHUB_DEFAULT_HUB)
  'LOOM_FABRIC_GRAPH_WORKSPACE',    // opt-in Fabric graph workspace
  'LOOM_FABRIC_SEMANTIC_MODEL_ID',  // opt-in Fabric semantic model
  'LOOM_FABRIC_WORKSPACE_ID',       // opt-in Fabric workspace (no-fabric-dependency.md: never a default gate)
  'LOOM_FOUNDRY_EVAL_DATASET',      // opt-in eval dataset
  'LOOM_FOUNDRY_EVAL_DEPLOYMENT',   // opt-in eval deployment
  'LOOM_FOUNDRY_HUB_NAME',          // derived from Foundry hub
  'LOOM_FOUNDRY_PROJECT',           // derived from Foundry project
  'LOOM_GHCR_OWNER',                // opt-in GHCR mirror owner
  'LOOM_GHCR_REGISTRY',             // opt-in GHCR mirror registry
  'LOOM_GITHUB_REPO_NAME',          // opt-in GitHub integration
  'LOOM_GITHUB_REPO_OWNER',         // opt-in GitHub integration
  'LOOM_FEEDBACK_REPO_NAME',        // opt-in feedback repo
  'LOOM_FEEDBACK_REPO_OWNER',       // opt-in feedback repo
  // Default branch the /api/admin/deploy-status estate-drift comparison runs
  // against. Same family as the two above and allowlisted for the same reason:
  // it names the UPSTREAM repo, not anything this deployment owns, and its
  // default ('main') is correct for every estate that tracks this repo. Only a
  // fork whose default branch is not `main` needs to set it. Deliberately NOT a
  // bicep param — main.bicep sits at 251/256 and this buys no capability.
  // If it is wrong, the compare call 404s and the banner reports UNKNOWN, which
  // is a visible warning rather than a false "up to date".
  'LOOM_UPSTREAM_BRANCH',           // opt-in upstream default-branch override
  'LOOM_IOTHUB_RG',                 // opt-in IoT Hub resource group
  'LOOM_IOTHUB_SUB',                // opt-in IoT Hub subscription
  'LOOM_KUSTO_FABRIC_MANAGED',      // opt-in Fabric-managed Kusto flag
  'LOOM_LOGIC_LOCATION',            // Logic App region (derived)
  // The THIRD member of the LOOM_LOGIC_* trio, and the one that was never
  // allowlisted — it passed only because deploy-planner/logic-app.bicep:55 says
  // "…into LOOM_LOGIC_RG (== this DLZ RG)" in a COMMENT. Its two siblings
  // (LOOM_LOGIC_SUB, LOOM_LOGIC_LOCATION) are both explicitly allowlisted right
  // here as derived/opt-in, so the guard was treating one third of one gate
  // differently purely by accident of prose. It is derived exactly like they
  // are: lib/install/provisioners/logic-app.ts:86 reads
  // `LOOM_LOGIC_RG || LOOM_DLZ_RG`, and LOOM_DLZ_RG IS bicep-emitted — so a
  // from-scratch deploy resolves a resource group with this var unset. It is an
  // OVERRIDE for installing workflows into a different RG, never a day-one gate.
  'LOOM_LOGIC_RG',
  'LOOM_MIRROR_SOURCE_CONNECTION_ID', // opt-in mirror source binding
  'LOOM_OPEN_MIRROR_POOL',          // opt-in open-mirror pool
  'LOOM_PGVECTOR_DATABASE',         // opt-in pgvector db
  // LOOM_PGVECTOR_HOST was here, reasoned as an "opt-in pgvector host". #3372
  // measured that it was emitted by NO template on ANY cloud (0 occurrences in
  // the compiled deploy-templates/main.json), so "opt-in" described a var the
  // operator had to set by hand — auto-bind-by-default.md §5's exact violation.
  // admin-plane/main.bicep now emits it from the Weave PG server it deploys on
  // every topology, so it is DELIVERED and must stay that way: it is deliberately
  // NOT allowlisted, which makes this guard fail if the emission is ever removed.
  'LOOM_POSTGRES_HOST',             // Lakebase server FQDN — genuinely opt-in/metered (landing-zone/postgres-flexible.bicep is a standalone entrypoint by design); pgvector no longer depends on it, see LOOM_PGVECTOR_HOST above
  'LOOM_PURVIEW_AUTOSCAN',          // opt-in Purview auto-register flag
  'LOOM_PURVIEW_DEFAULT_DOMAIN_NAME', // Purview domain default (code default)
  'LOOM_PURVIEW_ENDPOINT',          // optional operator override: explicit Purview data-plane base URL (default: ARM-derived endpoints → cloud-aware convention host; purview-endpoints.ts)
  'LOOM_PURVIEW_GOVERNANCE_DOMAIN_ID', // derived Purview governance domain
  'LOOM_PURVIEW_MANAGED_VNET',      // opt-in Purview managed VNet flag
  'LOOM_PURVIEW_MANAGED_VNET_IR',   // opt-in Purview managed VNet IR
  'LOOM_PURVIEW_SHIR_IR_NAME',      // Purview SHIR IR name (code default)
  'LOOM_REPORT_CERTIFIERS',         // report certifier list (code default)
  'LOOM_SERVERLESS_DB',             // Synapse serverless db default (code default)
  'LOOM_SWA_RG',                    // opt-in Static Web Apps resource group
  'LOOM_SYNAPSE_LAKEHOUSE_DB',      // Synapse lakehouse db default (code default)
  'LOOM_WAREHOUSE_DB',              // Synapse warehouse db default (code default)
  'LOOM_WAREHOUSE_SERVER',          // derived Synapse SQL endpoint
  'LOOM_WS_IDENTITY_RG',            // opt-in per-workspace identity resource group
  'LOOM_WS_IDENTITY_SUB',           // opt-in per-workspace identity subscription
  'LOOM_LOGIC_SUB',                 // opt-in Logic App subscription
  'LOOM_DLZ_SUB',                   // opt-in data-landing-zone subscription
  'LOOM_AML_SUB',                   // opt-in AML subscription override
  'LOOM_CAPACITY_LCU',              // capacity-unit tuning knob (code default)
  'LOOM_OBO_CLIENT_ID',             // opt-in on-behalf-of flow (default off; EH Phase-1 scaffold)
  'LOOM_OBO_DATA_PLANE',            // opt-in on-behalf-of data-plane target (default off)
  'LOOM_QUERY_CACHE_COSMOS_CONTAINER', // opt-in override of the query-cache Cosmos container id (default 'query-result-cache' when a Cosmos endpoint is set — PSR-5 default-ON)
  'LOOM_QUERY_CACHE_COSMOS_DISABLED', // opt-OUT of the distributed (Cosmos) result-cache tier (PSR-5 default-ON; set '1' to disable)
  'LOOM_QUERY_CACHE_DISABLED',      // query-cache toggle (code default)
  'LOOM_QUERY_CACHE_MAX',           // query-cache size cap (code default)
  'LOOM_ADMIN_CENTER_MCP_ENDPOINT', // opt-in M365 Admin Center MCP
  'LOOM_DATAVERSE_MCP_ENDPOINT',    // opt-in Dataverse MCP
  'LOOM_ONEDRIVE_SHAREPOINT_MCP_ENDPOINT', // opt-in OneDrive/SharePoint MCP
  // AIF-18 — browser-automation tool runner. Opt-in, unset by default (the tool
  // honest-gates). Deploy platform/fiab/bicep/modules/copilot/browser-tool.bicep
  // (ACA Job) and set LOOM_BROWSER_TOOL_JOB to its resource id, or point
  // LOOM_BROWSER_TOOL_ENDPOINT at a synchronous HTTP Playwright runner.
  'LOOM_BROWSER_TOOL_JOB',          // opt-in Playwright ACA-job resource id (default off — honest gate)
  'LOOM_BROWSER_TOOL_ENDPOINT',     // opt-in synchronous Playwright HTTP runner (default off — honest gate)
  // BR-WEBHOOK — outbound webhook delivery. DIRECT HTTPS + HMAC is the zero-infra
  // DEFAULT (default-ON); Event Grid is the opt-in ALTERNATIVE transport. The
  // topic endpoint is unset unless the operator deploys the standalone
  // platform/fiab/bicep/modules/admin-plane/event-grid-webhooks.bicep module
  // (NOT wired into admin-plane/main.bicep — that file is at the 256-param
  // ceiling). LOOM_EVENTGRID_TOPIC_KEY is a secret (matched by the _KEY pattern).
  'LOOM_EVENTGRID_TOPIC_ENDPOINT',  // opt-in Event Grid custom-topic endpoint (default off — direct HTTPS delivery is used)
  'LOOM_ACCESS_REQUEST_WEBHOOK',    // opt-in best-effort Teams/Logic App incoming webhook pinged on a new sign-in access request (lib/access/signin-access-request.ts); unset = silent no-op, the /admin/access-requests queue is the source of truth
  'LOOM_ONBOARDING_ENTRA_GROUP_NAME', // opt-in display override for the onboarding group named in the approve-request instruction (app/api/admin/access-requests/[id]/route.ts); unset = falls back to LOOM_TENANT_ADMIN_GROUP_ID — cosmetic, never a gate
  'LOOM_SELF_BASE_URL',             // derived/ambient override for the server-side same-origin self-call base in demo-deploy (lib/apps/demo-deploy.ts); unset default = http://127.0.0.1:$PORT (the container hairpin), never a deployed literal
  'LOOM_UPDATE_IMAGE_REGISTRY',     // opt-in registry override for the in-place update-apply image resolution (app/api/admin/updates/apply/route.ts); unset default = swap the tag on the app's CURRENT image (its own private ACR), no public-ghcr dependency
  'LOOM_SKILL_LEARNER_MIN_SAMPLES', // CTS-11 opt-in tuning knob: min recurring prompts on a pane before the skill self-evolution learner proposes a SUGGESTED skill (default 5 in lib/azure/skill-learner.ts); admin-reviewed, never auto-published. (LOOM_SKILL_LEARNER_ENABLED matched by /_ENABLED$/, LOOM_SKILL_LEARNER_MAX_* by /_MAX_.../)
  'LOOM_AGENT_MEMORY_RETENTION_DAYS', // B-N14d opt-in tuning knob: default lifetime of an agent memory (default 180 in lib/copilot/agent-memory-core.ts; 0 = keep forever). Read via an injected `env` param, never a gate — unset just uses the code default. (LOOM_AGENT_MEMORY_MAX_RETENTION_DAYS matched by /_MAX_.../; LOOM_AGENT_MEMORY_CAP / _TOPK are read dynamically by the AIF-14 client.)
  'LOOM_AGENT_MEMORY_CAP',          // B-N14d/AIF-14 tuning knob: per-scope memory count cap (default 200); unset = code default, never a gate
  // #3334 sign-in circuit breaker — the counting WINDOW, in seconds. A pure
  // tuning knob with a code default (600, mirroring AUTHFLOW_MAX_AGE_SECS) in
  // lib/auth/auth-breaker.ts, and NOT a gate: the breaker is default-ON and
  // fully functional with all three of its vars unset. Emitting it from bicep
  // would put a value the deploy has no opinion about into the app env, where
  // a bicep re-render could then drift it. The siblings are already matched by
  // the patterns above — LOOM_AUTH_BREAKER_ENABLED by /_ENABLED$/ and
  // LOOM_AUTH_BREAKER_MAX_ATTEMPTS by /_MAX_[A-Z0-9_]+$/.
  'LOOM_AUTH_BREAKER_WINDOW_SECS',
  // Same family, same rationale — surfaced by the comment-blindness fix, which
  // found it "emitted" by landing-zone/cosmos.bicep:295, a comment explaining
  // what the cap DOES. lib/azure/agent-memory-client.ts:26 reads it as
  // `intEnv('LOOM_AGENT_THREAD_CAP', 50)`: a pure tuning knob with a code
  // default that gates nothing.
  'LOOM_AGENT_THREAD_CAP',
  // L2 OpenLineage per-pool principal registrations
  // (`<pool-app-client-id>=<workspace-id>[,…]`). Cannot be a bicep literal by
  // construction: each pair is minted at runtime by
  // scripts/csa-loom/openlineage-pool-setup.sh when an operator registers a
  // Spark pool, so the value does not exist at template-authoring time. It was
  // passing only on admin-plane/main.bicep:4425, a comment naming it alongside
  // the per-workspace token secret. Its sibling LOOM_OPENLINEAGE_AUDIENCE is
  // already allowlisted for the same runtime-only reason. Unset => the ingest
  // rejects an unregistered principal with the exact remediation text.
  'LOOM_OPENLINEAGE_POOL_PRINCIPALS',
  'LOOM_AGENT_MEMORY_TOPK',         // B-N14d/AIF-14 tuning knob: memories packed into one agent turn (default 8); unset = code default, never a gate
]);

// ── Filesystem helpers (no deps) ──
export function walk(dir, exts, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.next' || e.name === 'temp' || e.name === 'dist') continue;
      walk(full, exts, out);
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(full);
    }
  }
  return out;
}

const ENV_READ_RE = /process\.env\.(LOOM_[A-Z0-9_]+)/g;
const LOOM_TOKEN_RE = /LOOM_[A-Z0-9_]+/g;
// Written as a code point so the literal never has to survive a shell heredoc
// or an editor that re-escapes it.
const BACKSLASH = String.fromCharCode(92);

/** Every LOOM_* name read under apps/fiab-console/{app,lib}. */
export function collectReads() {
  const reads = new Set();
  const files = [
    ...walk(path.join(CONSOLE_ROOT, 'app'), ['.ts', '.tsx']),
    ...walk(path.join(CONSOLE_ROOT, 'lib'), ['.ts', '.tsx']),
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    let m;
    ENV_READ_RE.lastIndex = 0;
    while ((m = ENV_READ_RE.exec(src)) !== null) reads.add(m[1]);
  }
  return reads;
}

/**
 * Strip bicep DOCUMENTATION — `//` and block comments, plus the argument of the
 * `@description(…)` / `@metadata(…)` decorators — before scanning for emitted
 * names.
 *
 * WHY (measured 2026-08-04, mutation-proved twice). `collectEmitted()` used to
 * tokenize the RAW file text, so a var merely MENTIONED in prose counted as
 * "emitted by platform bicep" — the one thing this guard exists to establish.
 *
 * Proof, round 1 (comments). With `LOOM_RISINGWAVE_URL` removed from the
 * ALLOWLIST below — i.e. the guard is now supposed to enforce its emission —
 * renaming the SOLE real emission
 *
 *   admin-plane/main.bicep:3796  { name: 'LOOM_RISINGWAVE_URL', value: … }
 *
 * left the guard GREEN, because line 744 of the same file says
 * `// Backs LOOM_RISINGWAVE_URL (the streaming-sql item …)`.
 *
 * Proof, round 2 (decorator docs). With comments stripped, the SAME mutation
 * was STILL green, because data-plane/loom-risingwave-aca.bicep:426 says
 * `@description('Internal FQDN — set on the Console app as LOOM_RISINGWAVE_URL …')`.
 * `@description` is bicep's doc-comment idiom; its argument is prose that no
 * deployment ever emits, so it must be treated exactly like a comment.
 *
 * In both rounds a from-scratch deploy would have shipped the var unset and the
 * guard would not have noticed. Removing an allowlist entry bought NOTHING
 * until both were fixed — the repo's recurring "guard that cannot fail" shape:
 * the check ran, printed a number, and measured prose.
 *
 * ORDINARY string literals are PRESERVED, and must be: the real emission is
 * itself a string (`name: 'LOOM_RISINGWAVE_URL'`), and a bicep author can
 * legitimately assemble an env name inside one. The scanner tracks single-quoted
 * and ''' multi-line strings so a `//` inside a URL literal (`https://…`) is
 * never mistaken for the start of a comment.
 */
export function stripBicepDocs(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  // `@description(` / `@sys.description(` / `@metadata(` / `@sys.metadata(`
  const DOC_DECORATOR = /@(?:sys\.)?(?:description|metadata)\s*\(/y;
  while (i < n) {
    const c = src[i];
    // Documentation decorator: skip its whole argument list, string-aware so a
    // ')' inside the prose does not end it early.
    if (c === '@') {
      DOC_DECORATOR.lastIndex = i;
      if (DOC_DECORATOR.test(src)) {
        let j = DOC_DECORATOR.lastIndex; // just past the '('
        let depth = 1;
        while (j < n && depth > 0) {
          if (src.startsWith("'''", j)) {
            const end = src.indexOf("'''", j + 3);
            j = end === -1 ? n : end + 3;
            continue;
          }
          if (src[j] === "'") {
            let k = j + 1;
            while (k < n && src[k] !== "'" && src[k] !== '\n') {
              if (src[k] === BACKSLASH) k++;
              k++;
            }
            j = Math.min(k + 1, n);
            continue;
          }
          if (src[j] === '(') depth++;
          else if (src[j] === ')') depth--;
          j++;
        }
        i = j;
        continue;
      }
    }
    // ''' multi-line string
    if (c === "'" && src.startsWith("'''", i)) {
      const end = src.indexOf("'''", i + 3);
      const stop = end === -1 ? n : end + 3;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    // single-quoted string (bicep strings never span a newline)
    if (c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== "'" && src[j] !== '\n') {
        if (src[j] === BACKSLASH) j++;
        j++;
      }
      const stop = Math.min(j + 1, n);
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// ── Per-APP delivery (#3012) ────────────────────────────────────────────────
//
// WHY `collectEmitted()` IS NOT ENOUGH. It flattens every LOOM_* token from every
// file under platform/fiab/bicep into ONE set, so a name counts as "emitted"
// when ANY bicep file anywhere references it — including a file that wires a
// COMPLETELY DIFFERENT container app. It cannot tell emission from mention, and
// it cannot tell WHICH app receives the value. Verified concretely on 2026-08-05:
// deleting every `LOOM_ICEBERG_CATALOG_URL` occurrence from admin-plane/main.bicep
// (count -> 0) left this guard exiting 0, because sibling bicep files mention the
// name.
//
// That is the same class as the other guard-blindness incidents in this program:
// a route guard matching a DELETED symbol in prose (#2985); a guard skipping any
// file without a literal `getSession(` (#2995); a deploy guard scoped by FILENAME
// that excluded 11 gov-provision-* workflows. In each case the guard measured a
// proxy instead of the subject.
//
// The subject here is: DOES THE CONSOLE CONTAINER APP ACTUALLY RECEIVE THIS VALUE?
// A var the console reads but the deploy sets on loom-trino / loom-sharing /
// loom-duckdb is UNSET in the console's process — the exact silent config drift
// the guard's own header says it exists to catch.

const ADMIN_PLANE = path.join(BICEP_ROOT, 'modules', 'admin-plane');
/** The apps[] orchestrator that declares the console container app. */
const CONSOLE_APP_FILE = path.join(ADMIN_PLANE, 'main.bicep');
/** The module that materialises apps[] and adds env applied to EVERY app. */
const APP_DEPLOYMENTS_FILE = path.join(ADMIN_PLANE, 'app-deployments.bicep');

const ENV_NAME_RE = /name:\s*'(LOOM_[A-Z0-9_]+)'/g;

/** The balanced `open`..close slice of `text` beginning at index `start`. */
function balancedSlice(text, start, openChar, closeChar) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === openChar) depth++;
    else if (c === closeChar) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

/**
 * The set of LOOM_* names the loom-console container app actually RECEIVES:
 * the `env` of its own `apps[]` entry, plus the env `app-deployments.bicep`
 * applies to every app it deploys.
 *
 * `secretRef` entries count — they still carry `name: 'LOOM_X'`, and a value
 * injected from Key Vault is delivered just as much as a literal.
 */
export function collectConsoleDelivered() {
  const delivered = new Set();

  const main = fs.readFileSync(CONSOLE_APP_FILE, 'utf8');
  const marker = main.indexOf("name: 'loom-console'");
  if (marker < 0) {
    throw new Error(
      "check-env-sync: no `name: 'loom-console'` app entry in admin-plane/main.bicep — " +
        'the console app declaration moved. Fix collectConsoleDelivered(); do not ' +
        'let this guard silently measure nothing.',
    );
  }
  const appObj = balancedSlice(main, main.lastIndexOf('{', marker), '{', '}');
  const envIdx = appObj.indexOf('env:');
  if (envIdx < 0) throw new Error('check-env-sync: loom-console app entry has no env: block.');
  const afterEnv = appObj.slice(envIdx);
  // `env:` is either `concat( … )` or a bare `[ … ]`.
  const paren = afterEnv.indexOf('(');
  const brack = afterEnv.indexOf('[');
  const envBlock =
    paren >= 0 && (brack < 0 || paren < brack)
      ? balancedSlice(afterEnv, paren, '(', ')')
      : balancedSlice(afterEnv, brack, '[', ']');
  let m;
  ENV_NAME_RE.lastIndex = 0;
  while ((m = ENV_NAME_RE.exec(envBlock)) !== null) delivered.add(m[1]);

  const shared = fs.readFileSync(APP_DEPLOYMENTS_FILE, 'utf8');
  ENV_NAME_RE.lastIndex = 0;
  while ((m = ENV_NAME_RE.exec(shared)) !== null) delivered.add(m[1]);

  return delivered;
}

/**
 * KNOWN GAPS — read by the console, but the deploy sets them on a DIFFERENT app.
 * This is a RATCHET, not an allowlist: it is the pre-existing debt this stricter
 * check surfaced on the day it was written. It must only ever SHRINK. Adding a
 * name here is not a fix — the fix is an entry in the loom-console `env` array.
 *
 * Each is genuinely mis-delivered today:
 *   LOOM_LAKE_ACCOUNT      -> set on duckdb-aca + iceberg-catalog-aca, not the console
 *   LOOM_SHARING_ENDPOINT  -> set on loom-sharing-app itself
 *   LOOM_SHARING_BEARER    -> set on loom-sharing-app; its own comment says it should
 *                             also be a secretRef ON THE CONSOLE, which was never done
 *   LOOM_DLZ_SUBSCRIPTION_ID -> named only in an @description + a shell comment in
 *                             landing-zone/hub-console-dlz-env.bicep
 *   LOOM_CONSOLE_PRINCIPAL_ID -> not set by any .bicep at all
 */
export const KNOWN_UNDELIVERED = new Set([
  'LOOM_CONSOLE_PRINCIPAL_ID',
  'LOOM_DLZ_SUBSCRIPTION_ID',
  'LOOM_LAKE_ACCOUNT',
  'LOOM_SHARING_BEARER',
  'LOOM_SHARING_ENDPOINT',
]);

/**
 * Vars that are READ by the console and pass the flat `emitted` check, but are
 * NOT delivered to the console app and are NOT allowlisted / fenced.
 */
export function computeUndelivered() {
  const reads = collectReads();
  const delivered = collectConsoleDelivered();
  const out = [];
  for (const name of [...reads].sort()) {
    if (delivered.has(name)) continue;
    if (isAllowlisted(name)) continue;
    if (KNOWN_UNDELIVERED.has(name)) continue;
    out.push(name);
  }
  return { delivered, undelivered: out };
}

/** Every LOOM_* name referenced in the platform bicep OUTSIDE of documentation. */
export function collectEmitted() {
  const emitted = new Set();
  const files = walk(BICEP_ROOT, ['.bicep', '.bicepparam']);
  for (const f of files) {
    const src = stripBicepDocs(fs.readFileSync(f, 'utf8'));
    let m;
    LOOM_TOKEN_RE.lastIndex = 0;
    while ((m = LOOM_TOKEN_RE.exec(src)) !== null) emitted.add(m[0]);
  }
  return emitted;
}

function isAllowlisted(name) {
  if (ALLOWLIST.has(name)) return true;
  return ALLOWLIST_PATTERNS.some((re) => re.test(name));
}

export function computeMissing() {
  const reads = collectReads();
  const emitted = collectEmitted();
  const missing = [];
  for (const name of [...reads].sort()) {
    if (emitted.has(name)) continue;
    if (isAllowlisted(name)) continue;
    missing.push(name);
  }
  return { reads, emitted, missing };
}

// ══════════════════════════════════════════════════════════════════════════════
// LAYER 3 (#3370/#3371/#3372) — DELIVERED, BUT THE VALUE IS ALWAYS EMPTY.
//
// Layers 1 and 2 above ask "is the NAME in bicep?" and "does the CONSOLE APP get
// an entry for it?". Both pass on this:
//
//     { name: 'LOOM_ONELAKE_URL', value: '' }
//
// The name is in bicep. The console receives the entry. The value is, and can
// only ever be, the empty string — and the bicep comment beside it said, in so
// many words, that the OPERATOR sets the real value afterwards via
// /admin/env-config. That is the literal text auto-bind-by-default.md §5
// forbids: "'Set LOOM_X' as the terminal user-facing state is a violation — the
// value must be produced by the deploy."
//
// So a var could be consumed by the console, emitted by bicep, delivered to the
// right app, pass every guard in this file, and still be guaranteed unset on
// every deploy in both clouds. That is the gap this layer closes.
//
// TWO SHAPES ARE INERT, and both were live in the tree when this was written:
//
//   (a) HARD-CODED EMPTY LITERAL — `value: ''`, or a ternary whose branches are
//       both ''. Found on LOOM_ONELAKE_URL / LOOM_BROKER_URL / LOOM_BROKER_REDIS.
//
//   (b) A PARAM NOBODY PASSES — `value: someParam` where admin-plane declares
//       `param someParam string = ''` and no caller anywhere in the bicep tree
//       ever passes `someParam:`. Found on LOOM_COPYJOB_CONTROL_SQL_SERVER,
//       whose module was additionally gated `if (… && !empty(thatParam))`, so
//       the module could never run either. This shape is strictly nastier than
//       (a) because the declaration LOOKS configurable — you have to check the
//       call sites to learn it is dead.
//
// WHY NOT JUST BAN EMPTY DEFAULTS: a conditional emission
// (`x ? 'https://…' : ''`) is CORRECT and common — it is how a documented
// opt-out honest-gates. The rule is not "never empty", it is "not empty on
// EVERY path". A var with at least one branch that can produce a real value is
// not reported.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Every `{ name: 'LOOM_X', … }` entry in the loom-console `env` block, paired
 * with the raw source text of its `value:` expression (null for `secretRef`
 * entries, which are delivered from Key Vault and carry no inline value).
 *
 * @returns {Map<string, string|null>}
 */
export function collectConsoleEnvExpressions() {
  const main = fs.readFileSync(CONSOLE_APP_FILE, 'utf8');
  const marker = main.indexOf("name: 'loom-console'");
  if (marker < 0) {
    throw new Error(
      "check-env-sync: no `name: 'loom-console'` app entry in admin-plane/main.bicep — " +
        'the console app declaration moved. Fix collectConsoleEnvExpressions(); do not ' +
        'let this guard silently measure nothing.',
    );
  }
  const appObj = balancedSlice(main, main.lastIndexOf('{', marker), '{', '}');
  const envIdx = appObj.indexOf('env:');
  if (envIdx < 0) throw new Error('check-env-sync: loom-console app entry has no env: block.');
  const afterEnv = appObj.slice(envIdx);
  const paren = afterEnv.indexOf('(');
  const brack = afterEnv.indexOf('[');
  const envBlock =
    paren >= 0 && (brack < 0 || paren < brack)
      ? balancedSlice(afterEnv, paren, '(', ')')
      : balancedSlice(afterEnv, brack, '[', ']');

  return parseEnvEntries(envBlock);
}

/**
 * Pure parser, exported so the embedded control can drive it with synthetic
 * input. Splitting it from the file read is what lets the control prove the
 * CLASSIFIER works rather than merely proving the repo is currently clean —
 * a guard whose population happens to be empty must still be able to fail
 * (`guard_with_zero_population_needs_embedded_control`).
 *
 * @param {string} envBlock bicep source of an `env` array
 * @returns {Map<string, string|null>} name → raw `value:` expression, or null
 */
export function parseEnvEntries(envBlock) {
  const out = new Map();
  const nameRe = /name:\s*'(LOOM_[A-Z0-9_]+)'/g;
  let m;
  while ((m = nameRe.exec(envBlock)) !== null) {
    const open = envBlock.lastIndexOf('{', m.index);
    if (open < 0) continue;
    const entry = balancedSlice(envBlock, open, '{', '}');
    if (!entry) continue;
    const vIdx = entry.indexOf('value:');
    if (vIdx < 0) {
      out.set(m[1], null); // secretRef (or any non-inline delivery)
      continue;
    }
    // Everything between `value:` and the entry's closing brace.
    out.set(m[1], entry.slice(vIdx + 'value:'.length, entry.length - 1).trim());
  }
  return out;
}

/** `param foo string = ''` style declarations whose default is the empty string. */
export function collectEmptyDefaultParams(src) {
  const out = new Set();
  const re = /^param\s+([A-Za-z_][A-Za-z0-9_]*)\s+string\s*=\s*''\s*$/gm;
  let m;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
}

/**
 * Param names that SOME bicep file passes as a module argument (`foo: …`).
 * Scanned across the whole tree, excluding the declaring file itself, because a
 * param is only alive if a CALLER supplies it.
 */
export function collectPassedParamNames(excludeFile) {
  const passed = new Set();
  for (const f of walk(BICEP_ROOT, ['.bicep'])) {
    if (path.resolve(f) === path.resolve(excludeFile)) continue;
    const src = stripBicepDocs(fs.readFileSync(f, 'utf8'));
    const re = /^\s{2,}([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\S/gm;
    let m;
    while ((m = re.exec(src)) !== null) passed.add(m[1]);
  }
  return passed;
}

/** True when `expr` is the empty-string literal, or a ternary of empty strings. */
export function isAlwaysEmptyLiteral(expr) {
  const e = String(expr).trim();
  if (e === "''") return true;
  // `cond ? '' : ''` — both branches empty.
  return /^[^?]*\?\s*''\s*:\s*''$/.test(e);
}

/** True when `expr` is a bare identifier (a param/var reference, nothing else). */
export function isBareIdentifier(expr) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(expr).trim());
}

/**
 * PRE-EXISTING INERT VARS — a shrinking RATCHET, not an allowlist.
 *
 * Each entry is a var the deploy delivers to the console with a value that can
 * only ever be ''. Adding a name here is NOT a fix and must be a reviewable act
 * in a diff; the fix is to make the deploy produce the value.
 */
export const KNOWN_INERT = new Map([
  [
    'LOOM_ONELAKE_URL',
    "#3370 — hard-coded ''. compute/loom-onelake-app.bicep exists and apps/loom-onelake has a Dockerfile, but NO orchestrator invokes the module and NO CI lane builds the image (it is absent from the APPS list in build-fiab-images-acr-tasks.yml, full-app-deploy-commercial.yml and gov-provision-dataplane-images.yml). Fixing it means the full #3291 treatment — UAMI + AcrPull + module invocation + image lanes in both clouds — not a one-line wiring change. loom-onelake-client.ts honest-503s and the per-item library path still works, so this is capability loss, not breakage.",
  ],
  [
    'LOOM_BROKER_URL',
    '#3370 — same shape as LOOM_ONELAKE_URL for compute/loom-capacity-broker-app.bicep + apps/loom-capacity-broker. capacity-broker-client.ts reads LOOM_CAPACITY_BROKER_URL || LOOM_BROKER_URL and falls back to unthrottled job submission.',
  ],
  [
    "LOOM_BROKER_REDIS",
    '#3370 — the Redis ledger for the capacity broker, which lives on the compute/hband-shared.bicep substrate no orchestrator deploys. spark-lease-store.ts reads it as one of THREE alternatives (LOOM_SPARK_POOL_REDIS || LOOM_BROKER_REDIS || LOOM_DIRECTLAKE_REDIS) with a documented in-process single-replica fallback, so it is a genuine alternative rather than a required value — but it is still not produced by any deploy.',
  ],
  [
    'LOOM_COPYJOB_CONTROL_SQL_SERVER',
    "#3372 — shape (b): admin-plane declares `param loomCopyJobControlSqlServer string = ''` and gates `module copyJobControl` on `copyJobControlEnabled && !empty(...)`, but NO orchestrator passes either, so the module never runs and the var is always ''. The issue proposed passing 'the Azure SQL logical server the estate already deploys for plan-backing' — MEASURED FALSE: `grep -rn \"Microsoft.Sql/servers@\" platform/fiab/bicep` returns exactly one hit and it is `existing`. No module in this repo creates a SQL logical server, so closing this needs a deliberate decision to deploy one (metered, needs an Entra admin), not a wiring change.",
  ],
]);

/**
 * MEASUREMENT BASELINE — always-empty vars this layer found on the day it was
 * written (2026-08-14) that have NOT been individually triaged.
 *
 * This is deliberately a SEPARATE set from {@link KNOWN_INERT}. Every name in
 * KNOWN_INERT carries a reason someone established. These carry only the
 * measurement, and saying so is the point: deploy-integrity.md R7 forbids
 * asserting a cause that was not established, and writing 31 confident
 * rationales I had not verified would have been exactly that.
 *
 * WHAT IS ACTUALLY KNOWN ABOUT ALL OF THEM: each is bound to an admin-plane
 * `param … string = ''` that NO caller anywhere under platform/fiab/bicep ever
 * passes (or is a hard-coded ''), so the console receives the entry with an
 * empty value on every boundary and every topology.
 *
 * WHAT IS NOT KNOWN: whether each SHOULD be produced by the deploy. Several are
 * plainly BYO/external values the platform cannot invent — a customer's Azure
 * DevOps organisation (LOOM_SQL_GIT_ADO_ORG), their GitHub host, their MLflow
 * tracking URI — and auto-bind-by-default.md §5 is about infra prerequisites the
 * PLATFORM could deploy, not about external coordinates. Others look genuinely
 * derivable and are probably defects; LOOM_CLOUD_TIER is the clearest, because
 * domains-client.ts:536 uses it to block the Fabric Admin API on IL5 (not
 * FedRAMP IL5 approved) and an always-empty value means that compliance gate has
 * never engaged on any deploy. It is filed separately rather than fixed blind.
 *
 * This set may only SHRINK. Triaging one means deleting it here and either
 * fixing the emission or moving it to KNOWN_INERT with a real reason.
 */
export const UNTRIAGED_INERT = new Set([
  'LOOM_ADO_HOST',
  'LOOM_ASA_TEST_WRITE_URI',
  'LOOM_BAP_BASE',
  'LOOM_CLOUD_TIER',
  'LOOM_COPILOT_STUDIO_ENVIRONMENT_ID',
  'LOOM_DATABRICKS_LINEAGE_WAREHOUSE_ID',
  'LOOM_DATABRICKS_SQL_WAREHOUSE_ID',
  'LOOM_DBX_DQ_MONITOR_API',
  'LOOM_DEVCENTER_PROJECT',
  'LOOM_DLZ_TEMPLATE_QUERY_STRING',
  'LOOM_DLZ_TEMPLATE_URI',
  'LOOM_EXTRA_SUBSCRIPTIONS',
  'LOOM_FLOW_BASE',
  'LOOM_GITHUB_HOST',
  'LOOM_HDINSIGHT_LINKED_SERVICE',
  'LOOM_IOT_HUB_RESOURCE_ID',
  'LOOM_MCP_CATALOG_REGISTRY',
  'LOOM_MLFLOW_TRACKING_URI',
  'LOOM_OPS_ADMIN_ENTRA_GROUP',
  'LOOM_PAGINATED_RENDER_URL',
  'LOOM_PARAM_APPCONFIG',
  'LOOM_POSTURE_FUNCTION_URL',
  'LOOM_POWERAPPS_BASE',
  'LOOM_POWERAPPS_PLAYER_BASE',
  'LOOM_PURVIEW_UNIFIED_ACCOUNT',
  'LOOM_REPORT_RENDERER',
  'LOOM_SQL_GIT_ADO_ORG',
  'LOOM_SQL_GIT_ADO_PROJECT',
  'LOOM_SQL_GIT_ADO_REPO',
  'LOOM_SQL_GIT_GITHUB_REPO',
  'LOOM_SQL_GIT_PROVIDER',
]);

/**
 * Vars delivered to the console whose value is always empty and which are not
 * already ratcheted in {@link KNOWN_INERT}.
 */
export function computeInert() {
  const exprs = collectConsoleEnvExpressions();
  const adminSrc = fs.readFileSync(CONSOLE_APP_FILE, 'utf8');
  const emptyDefaults = collectEmptyDefaultParams(adminSrc);
  const passed = collectPassedParamNames(CONSOLE_APP_FILE);

  const inert = [];
  for (const [name, expr] of [...exprs].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (expr === null) continue; // secretRef — delivered from Key Vault
    // The SAME taxonomy layers 1 and 2 use. A var in those categories — a
    // tuning knob with a code default, a backend selector that means
    // "Azure-native default" when unset, a KV-injected secret, a cloud-derived
    // scope/suffix — is SUPPOSED to be empty on a default deploy. Reusing the
    // reviewed categories here instead of hand-writing a fresh reason per var
    // keeps one taxonomy in the file, and keeps this layer aimed at what it is
    // for: a value the PLATFORM could have produced and did not.
    if (isAllowlisted(name)) continue;
    let why = null;
    if (isAlwaysEmptyLiteral(expr)) {
      why = `hard-coded empty value (${expr})`;
    } else if (isBareIdentifier(expr) && emptyDefaults.has(expr) && !passed.has(expr)) {
      why = `bound to param '${expr}', which defaults to '' and no caller ever passes`;
    }
    if (!why) continue;
    if (KNOWN_INERT.has(name)) continue;
    if (UNTRIAGED_INERT.has(name)) continue;
    inert.push({ name, why });
  }
  return { total: exprs.size, inert, exprs, emptyDefaults, passed };
}

/**
 * EMBEDDED CONTROL. Runs the real classifier over synthetic input with KNOWN
 * answers, so the layer cannot report a pass because its parser broke or
 * because the repo happens to be clean. Every case here is a shape that was
 * actually live in the tree (or is the correct-code shape that must NOT be
 * flagged).
 *
 * @returns {string[]} failure descriptions; empty means the control held
 */
export function runInertControl() {
  const failures = [];
  const FIXTURE = `[
    { name: 'LOOM_CONTROL_DEAD_LITERAL', value: '' }
    { name: 'LOOM_CONTROL_DEAD_TERNARY', value: someFlag ? '' : '' }
    { name: 'LOOM_CONTROL_DEAD_PARAM', value: controlNeverPassed }
    { name: 'LOOM_CONTROL_LIVE_CONDITIONAL', value: someFlag ? 'https://\${x.outputs.fqdn}' : '' }
    { name: 'LOOM_CONTROL_LIVE_LITERAL', value: 'entra' }
    { name: 'LOOM_CONTROL_LIVE_PARAM', value: controlIsPassed }
    { name: 'LOOM_CONTROL_SECRETREF', secretRef: 'some-kv-secret' }
  ]`;
  const entries = parseEnvEntries(FIXTURE);

  // The parser must see every entry — a silent parse miss is how this class of
  // guard historically "passed".
  if (entries.size !== 7) {
    failures.push(`parseEnvEntries found ${entries.size} entries in the control fixture, expected 7`);
  }
  if (entries.get('LOOM_CONTROL_SECRETREF') !== null) {
    failures.push('secretRef entry was not recognised as having no inline value');
  }

  const emptyDefaults = new Set(['controlNeverPassed', 'controlIsPassed']);
  const passed = new Set(['controlIsPassed']);
  const verdict = (name) => {
    const expr = entries.get(name);
    if (expr === null || expr === undefined) return false;
    if (isAlwaysEmptyLiteral(expr)) return true;
    return isBareIdentifier(expr) && emptyDefaults.has(expr) && !passed.has(expr);
  };

  const MUST_FLAG = ['LOOM_CONTROL_DEAD_LITERAL', 'LOOM_CONTROL_DEAD_TERNARY', 'LOOM_CONTROL_DEAD_PARAM'];
  const MUST_NOT_FLAG = [
    'LOOM_CONTROL_LIVE_CONDITIONAL',
    'LOOM_CONTROL_LIVE_LITERAL',
    'LOOM_CONTROL_LIVE_PARAM',
    'LOOM_CONTROL_SECRETREF',
  ];
  for (const n of MUST_FLAG) if (!verdict(n)) failures.push(`classifier FAILED to flag ${n}`);
  for (const n of MUST_NOT_FLAG) if (verdict(n)) failures.push(`classifier WRONGLY flagged ${n}`);
  return failures;
}

function main() {
  const { reads, emitted, missing } = computeMissing();
  console.log(`[env-sync] LOOM_* read by console:   ${reads.size}`);
  console.log(`[env-sync] LOOM_* emitted by bicep:   ${emitted.size}`);
  console.log(`[env-sync] read-but-not-emitted (unallowlisted): ${missing.length}`);

  // #3012 — PER-APP DELIVERY. `emitted` above only proves the NAME appears in
  // bicep somewhere; this proves the CONSOLE APP receives it.
  const { delivered, undelivered } = computeUndelivered();
  console.log(`[env-sync] LOOM_* delivered to loom-console: ${delivered.size}`);
  // SELF-CHECK: the console app carries hundreds of env entries. A tiny set means
  // the extraction broke (renamed app, restructured env) and this check is
  // measuring nothing — the failure mode every guard in this repo has had.
  if (delivered.size < 100) {
    console.error(
      `::error::check-env-sync resolved only ${delivered.size} env vars on the ` +
        'loom-console app. That is far too few — the apps[] entry or its env block ' +
        'has been restructured and collectConsoleDelivered() is no longer reading it. ' +
        'Fix the extraction; do not let this check pass on nothing.',
    );
    process.exit(1);
  }
  if (missing.length) {
    console.error('\n[env-sync] FAIL — these LOOM_* vars are read by the console but neither');
    console.error('emitted by platform/fiab/bicep nor allowlisted in scripts/ci/check-env-sync.mjs:');
    for (const n of missing) console.error(`  - ${n}`);
    console.error('\nFix: add the var to the console app env array in');
    console.error('platform/fiab/bicep/modules/admin-plane/main.bicep (or the owning module),');
    console.error('OR, if it is genuinely runtime-only/derived/opt-in, add it to the');
    console.error('ALLOWLIST in scripts/ci/check-env-sync.mjs with a one-line reason.');
    process.exit(1);
  }
  if (undelivered.length) {
    console.error('\n[env-sync] FAIL — these LOOM_* vars are READ by the console but the');
    console.error('deploy never sets them ON THE loom-console APP. They may be referenced in');
    console.error('bicep (so the older name-anywhere check passes) while being delivered to a');
    console.error('DIFFERENT container app — which leaves them UNSET in the console process:');
    for (const n of undelivered) console.error(`  - ${n}`);
    console.error('\nFix: add the var to the loom-console `env` array in');
    console.error('platform/fiab/bicep/modules/admin-plane/main.bicep (or to the shared env in');
    console.error('app-deployments.bicep if every app needs it). Adding it to KNOWN_UNDELIVERED');
    console.error('is NOT a fix — that set is a shrinking ratchet of pre-existing debt.');
    process.exit(1);
  }

  // #3370/#3371/#3372 — LAYER 3: delivered, but the value is always ''.
  // The control runs FIRST and unconditionally: if the classifier is broken,
  // a clean report from it means nothing and must not be printed as a pass.
  const controlFailures = runInertControl();
  if (controlFailures.length) {
    console.error(
      '\n::error::check-env-sync LAYER-3 CONTROL FAILED — the always-empty classifier no ' +
        'longer behaves on inputs with known answers, so its verdict on the real tree is ' +
        'worthless. Fix the classifier; do not let this check pass on a broken matcher.',
    );
    for (const f of controlFailures) console.error(`  - ${f}`);
    process.exit(1);
  }

  const {
    total: envEntryCount,
    inert,
    exprs: consoleEnvExprs,
    emptyDefaults: emptyDefaultParams,
    passed: passedParamNames,
  } = computeInert();
  console.log(`[env-sync] LOOM_* env entries parsed on loom-console: ${envEntryCount}`);
  console.log(`[env-sync] always-empty (unratcheted): ${inert.length}`);
  // SELF-CHECK: same reasoning as the delivered<100 check above. If the entry
  // parser suddenly resolves a handful of entries, it has drifted off the env
  // block and this layer is measuring nothing.
  if (envEntryCount < 100) {
    console.error(
      `::error::check-env-sync parsed only ${envEntryCount} console env entries for the ` +
        'always-empty check. That is far too few — parseEnvEntries() has drifted off the ' +
        'env block. Fix the extraction; do not let this check pass on nothing.',
    );
    process.exit(1);
  }
  // SELF-CHECK: the ratchet must stay attached to reality. If a name in
  // KNOWN_INERT / UNTRIAGED_INERT is no longer even present in the console env
  // block, the set is describing a tree that no longer exists — which is how a
  // stale ratchet turns into silent coverage. Fixing a var means DELETING its
  // entry here.
  const presentNames = new Set(consoleEnvExprs.keys());
  const ratcheted = [...KNOWN_INERT.keys(), ...UNTRIAGED_INERT];
  const staleRatchet = ratcheted.filter((n) => !presentNames.has(n));
  if (staleRatchet.length) {
    console.error(
      '\n::error::check-env-sync ratcheted names that are no longer emitted on the console ' +
        'app at all. Either they were fixed (delete the entry — the ratchet must shrink) or ' +
        'the emission moved and this set is now describing nothing:',
    );
    for (const n of staleRatchet) console.error(`  - ${n}`);
    process.exit(1);
  }
  // SELF-CHECK: the ratchet must also still be DOING something. Every ratcheted
  // name is there because the classifier flags it; if the classifier stopped
  // flagging ALL of them while they are still emitted, it has gone blind and
  // the `inert.length === 0` result below would be a false pass — the exact
  // "gate that measures nothing" failure this repo keeps re-finding.
  const stillFlagged = ratcheted.filter((n) => {
    const expr = consoleEnvExprs.get(n);
    if (expr === null || expr === undefined) return false;
    if (isAllowlisted(n)) return false;
    if (isAlwaysEmptyLiteral(expr)) return true;
    return isBareIdentifier(expr) && emptyDefaultParams.has(expr) && !passedParamNames.has(expr);
  });
  if (ratcheted.length > 0 && stillFlagged.length === 0) {
    console.error(
      '\n::error::check-env-sync LAYER 3 flags NONE of its own ratcheted names, all of which ' +
        'are still emitted. The classifier has gone blind and a clean result here means ' +
        'nothing. Fix it; do not let this check pass on a matcher that detects nothing.',
    );
    process.exit(1);
  }
  if (inert.length) {
    console.error('\n[env-sync] FAIL — these LOOM_* vars ARE delivered to the loom-console app,');
    console.error('but their value can only ever be the empty string, on every boundary and');
    console.error('every topology. The console receives the entry and reads nothing, so the');
    console.error('terminal state is an operator setting the value by hand — the violation');
    console.error('auto-bind-by-default.md §5 names exactly ("the value must be produced by');
    console.error('the deploy"):');
    for (const { name, why } of inert) console.error(`  - ${name}: ${why}`);
    console.error('\nFix: make the deploy produce the value — invoke the module that owns the');
    console.error('resource and emit the var from its output (see the loomDirectLake /');
    console.error('weavePg wiring in admin-plane/main.bicep for the two worked examples).');
    console.error('Adding a name to KNOWN_INERT is NOT a fix; that set is a shrinking ratchet.');
    process.exit(1);
  }

  console.log('[env-sync] OK — every read LOOM_* var is emitted or allowlisted.');
  process.exit(0);
}

// Run main() only when invoked directly (not when imported by check-bicep-sync.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
