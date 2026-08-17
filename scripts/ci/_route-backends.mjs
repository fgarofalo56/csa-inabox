/**
 * SHARED ANALYZER: what BACKEND a route reaches — derived from the tree, not listed.
 * ===========================================================================
 * `generate-route-inventory.mjs` publishes a **Backends** column for every
 * `apps/fiab-console/app/api/**\/route.ts`, whose stated job is to classify each
 * route by backend dependency. This module decides that column.
 *
 * ── THE DEFECT THIS REPLACES (#3592) ───────────────────────────────────────
 * `BACKEND_LABEL` was a hand-maintained object literal mapping a Loom client
 * MODULE NAME to a friendly backend tag, consumed as:
 *
 *     [...dataSrc.matchAll(BACKEND_IMPORT_RE)].map((m) => BACKEND_LABEL[m[1]]).filter(Boolean)
 *
 * That `.filter(Boolean)` is a SILENT DROP: a `@/lib/azure/*` module absent from
 * the map yields `undefined`, is filtered away, and the route publishes `—`
 * ("touches no backend") with no signal at the point of loss. Measured on `main`
 * at b9ca620b, over `app/api/**\/route.ts`:
 *
 *     distinct @/lib/azure modules imported by routes      378
 *     BACKEND_LABEL entries                                 26
 *     …entries imported by at least one route               25   ← effective coverage
 *     …entries imported by ZERO routes                       1   (`keyvault-client`)
 *
 * So the map covered 25 of 378, and one of its entries covered nothing at all —
 * `keyvault-client` was IN the map and imported by no route, while
 * `kv-secrets-client`, which 19 routes use to reach Key Vault, was not. The map
 * LOOKED like it covered Key Vault while covering none of the real population.
 *
 * It produced a false document four times — `data-quality-client` (#3499),
 * `azure-sql-client` (#3529), `kv-secrets-client` (19 routes, Wave 0),
 * `model-serving-client` (6 routes, #3581). Every one was found by a human
 * reading a regenerated diff. None by the gate.
 *
 * It also could not see TRANSITIVE reach (#3545): `sql-objects-client` imports
 * `executeQuery` from `azure-sql-client`, which IS in the map, yet all 24 routes
 * importing the former published `—`. Curating the map is necessary and not
 * sufficient — a name scan cannot follow a delegation.
 *
 * ── WHAT THIS DOES INSTEAD ─────────────────────────────────────────────────
 * Same shape as `_route-auth-scope.mjs` (#3625/#3643) one column over, and it
 * CONSUMES that module's graph rather than building a second traversal.
 *
 * 1. **THE SEEDS ARE AZURE-OWNED IDENTIFIERS, NOT LOOM MODULE NAMES.** A
 *    function reaches a backend when its body names that backend's ARM resource
 *    provider (`providers/Microsoft.Kusto/…`), one of its data-plane DNS
 *    suffixes (`*.kusto.windows.net`), or its client SDK package
 *    (`azure-kusto-data`). Those identifiers belong to Microsoft and are stable;
 *    the POPULATION they classify — which Loom module, which route — is derived.
 *    A NEW Loom client needs no entry here: `lib/azure/whatever-client.ts` that
 *    builds a `Microsoft.Kusto` ARM path derives ADX on the commit that adds it.
 *    That is the property the module-name map never had.
 *
 * 2. **PER FUNCTION, NOT PER MODULE.** Module-level import closure was measured
 *    and is unusable: `kusto-client.ts` and `synapse-sql-client.ts` both import
 *    `attached-target-resolver.ts`, which imports eight further clients, so a
 *    plain module closure put Purview / Synapse / ADLS / Cosmos on 500+ routes
 *    that reach none of them (median 9 backends per route, p90 49). Following
 *    the CALL graph instead — a function reaches B if its body carries a
 *    B-identifier or it calls a function that reaches B — cuts that to a median
 *    of 3, because a client calling one narrow resolver function inherits only
 *    that function's reach.
 *
 * 3. **"TOUCHES NO BACKEND" IS AN ASSERTION, NOT A DEFAULT.** Per
 *    `deploy-integrity.md` R7 the generator says what it does not know. Three
 *    triggers, each naming the module and line:
 *      B1  an Azure identifier that reaches a route and is in NEITHER the label
 *          table NOR `NOT_A_BACKEND` — i.e. a service this vocabulary has never
 *          seen. The DETECTOR is generic (any `Microsoft.*` provider, any host
 *          under a Microsoft cloud DNS namespace, any `@azure/*` package), so a
 *          new backend cannot be dropped: it is detected, fails to translate,
 *          and stops the build naming itself.
 *      B2  a module under `lib/azure/**` that a route reaches, that makes a
 *          NETWORK CALL, and that the derivation attributes NO backend to. That
 *          is "this module talks to something and I cannot name it", which is
 *          exactly how the four instances above published `—`.
 *      B3  a seeded identifier that no longer occurs anywhere in the tree —
 *          the `keyvault-client` shape, a vocabulary entry with zero population,
 *          which verifies nothing while looking like coverage.
 *
 * ── WHAT IS DELIBERATELY *NOT* CLAIMED ─────────────────────────────────────
 * Stated because an unstated limit reads as coverage.
 *
 *   - **Reach is per FILE, not per METHOD**, like the auth column. The walk
 *     starts at every exported verb and unions them.
 *   - **"Reaches" is not "calls on every request."** A backend behind a feature
 *     flag, an `if (backend === 'databricks')` branch, or an error path is
 *     reported. That is the honest direction for a dependency column, and it is
 *     why `model-serving-client` publishes both of its dispatch targets.
 *   - **The ATTRIBUTION BOUNDARY is the call graph, and dynamic dispatch is
 *     invisible.** A client reached only through a value in a map, a thunk, or a
 *     runtime `require` is not followed. B2 is what stops that silence from
 *     reading as "no backend".
 *   - **Module-scope literals that are not bound to a name leak module-wide.**
 *     A host literal inside a class body (which `parseDeclarations` does not
 *     parse) cannot be attributed to one function, so it is attributed to every
 *     function in its module. That is the OVER-report direction, chosen because
 *     the under-report direction is this issue.
 *   - **A host in a COMMENT cannot reach anything** — everything is matched over
 *     `dataCode` (comments blanked, strings kept), because a URL genuinely lives
 *     in a string and a Learn link genuinely lives in a comment.
 *
 * Run the controls:  node --test scripts/ci/__tests__/route-backends.test.mjs
 */
import {
  buildGraph,
  callSites,
  HTTP_METHODS,
  CONSOLE_ROOT,
} from './_route-auth-scope.mjs';

export { buildGraph, CONSOLE_ROOT };

// ───────────────────────────────────────────────────────────────────────────
// 0. SEEDS — identifiers MICROSOFT owns, mapped to the label this doc prints.
//
// This is a vocabulary, not a population. Nothing here names a Loom module, a
// Loom route or a Loom symbol; adding a client to `lib/azure/` requires no edit
// to any table below. What DOES require an edit is Loom reaching an Azure
// service it has never reached before — and B1 makes that a build failure that
// names the service, rather than a row that quietly reads `—`.
// ───────────────────────────────────────────────────────────────────────────

/**
 * ARM resource-provider namespace → the backend it identifies.
 * Read off `providers/<ns>/…` paths and ARM `type` strings in the tree.
 */
export const ARM_PROVIDER_BACKEND = new Map([
  ['Microsoft.AlertsManagement', 'Azure Monitor'],
  ['Microsoft.AnalysisServices', 'AAS'],
  ['Microsoft.ApiManagement', 'APIM'],
  ['Microsoft.App', 'Container Apps'],
  ['Microsoft.AppConfiguration', 'App Configuration'],
  ['Microsoft.ApplicationInsights', 'Azure Monitor'],
  ['Microsoft.Authorization', 'Azure RBAC'],
  ['Microsoft.AzureCosmosDB', 'Cosmos'],
  ['Microsoft.Batch', 'Batch'],
  ['Microsoft.Billing', 'Cost Management'],
  ['Microsoft.BotService', 'Bot Service'],
  ['Microsoft.BusinessAppPlatform', 'Power Platform'],
  ['Microsoft.Cache', 'Azure Cache for Redis'],
  ['Microsoft.CognitiveServices', 'Azure AI Services'],
  ['Microsoft.Compute', 'Compute'],
  ['Microsoft.Consumption', 'Cost Management'],
  ['Microsoft.ContainerRegistry', 'ACR'],
  ['Microsoft.ContainerService', 'AKS'],
  ['Microsoft.CostManagement', 'Cost Management'],
  ['Microsoft.Dashboard', 'Azure Managed Grafana'],
  ['Microsoft.DataFactory', 'ADF'],
  ['Microsoft.Databricks', 'Databricks'],
  ['Microsoft.DBforPostgreSQL', 'PostgreSQL'],
  ['Microsoft.DBForPostgreSQL', 'PostgreSQL'], // ARM is case-insensitive; both spellings occur
  ['Microsoft.Devices', 'IoT Hub'],
  ['Microsoft.DigitalTwins', 'Azure Digital Twins'],
  ['Microsoft.DocumentDB', 'Cosmos'],
  ['Microsoft.Dynamics', 'Dataverse'],
  ['Microsoft.EventGrid', 'Event Grid'],
  ['Microsoft.EventHub', 'Event Hubs'],
  ['Microsoft.Insights', 'Azure Monitor'],
  ['Microsoft.KeyVault', 'Key Vault'],
  ['Microsoft.Keyvault', 'Key Vault'], // ditto
  ['Microsoft.Kusto', 'ADX'],
  ['Microsoft.Logic', 'Logic Apps'],
  ['Microsoft.MachineLearningServices', 'AML'],
  ['Microsoft.Maintenance', 'Azure Maintenance'],
  ['Microsoft.ManagedIdentity', 'Managed Identity'],
  ['Microsoft.Management', 'Management Groups'],
  ['Microsoft.Maps', 'Azure Maps'],
  ['Microsoft.Network', 'Azure Networking'],
  ['Microsoft.OperationalInsights', 'Log Analytics'],
  ['Microsoft.PolicyInsights', 'Azure Policy'],
  ['Microsoft.PowerApps', 'Power Platform'],
  ['Microsoft.PowerPlatform', 'Power Platform'],
  ['Microsoft.ProcessSimple', 'Power Automate'],
  ['Microsoft.Purview', 'Purview'],
  ['Microsoft.ResourceGraph', 'Resource Graph'],
  ['Microsoft.ResourceHealth', 'Resource Health'],
  ['Microsoft.Resources', 'ARM'],
  ['Microsoft.Search', 'AI Search'],
  ['Microsoft.Security', 'Defender for Cloud'],
  ['Microsoft.ServiceBus', 'Service Bus'],
  ['Microsoft.Skills', 'AI Search'],
  ['Microsoft.Sql', 'Azure SQL'],
  ['Microsoft.Storage', 'Azure Storage'],
  ['Microsoft.StreamAnalytics', 'Stream Analytics'],
  ['Microsoft.Synapse', 'Synapse'],
  ['Microsoft.Web', 'App Service'],
]);

/**
 * Data-plane / AAD-scope DNS suffix → backend. Matched LONGEST-FIRST, so
 * `ossrdbms-aad.database.windows.net` (the PostgreSQL AAD scope) does not land
 * on `database.windows.net` (Azure SQL), and `adb-1234.7.azuredatabricks.net`
 * lands on `azuredatabricks.net` rather than on a per-workspace shard.
 */
export const HOST_SUFFIX_BACKEND = new Map([
  // Key Vault
  ['vault.azure.net', 'Key Vault'],
  ['vault.usgovcloudapi.net', 'Key Vault'],
  ['vaultcore.azure.net', 'Key Vault'],
  ['vaultcore.usgovcloudapi.net', 'Key Vault'],
  // ADX / Kusto
  ['kusto.windows.net', 'ADX'],
  ['kusto.usgovcloudapi.net', 'ADX'],
  ['kusto.azuresynapse.net', 'ADX'],
  // Storage
  ['dfs.core.windows.net', 'ADLS'],
  ['dfs.core.usgovcloudapi.net', 'ADLS'],
  ['blob.core.windows.net', 'Azure Storage'],
  ['blob.core.usgovcloudapi.net', 'Azure Storage'],
  ['file.core.windows.net', 'Azure Storage'],
  ['file.core.usgovcloudapi.net', 'Azure Storage'],
  ['storage.azure.com', 'Azure Storage'],
  // SQL family
  ['ossrdbms-aad.database.windows.net', 'PostgreSQL'],
  ['database.windows.net', 'Azure SQL'],
  ['database.usgovcloudapi.net', 'Azure SQL'],
  ['postgres.database.azure.com', 'PostgreSQL'],
  ['postgres.database.usgovcloudapi.net', 'PostgreSQL'],
  ['mysql.database.azure.com', 'MySQL'],
  // Synapse
  ['sql.azuresynapse.net', 'Synapse SQL'],
  ['sql.azuresynapse.usgovcloudapi.net', 'Synapse SQL'],
  ['dev.azuresynapse.net', 'Synapse'],
  ['dev.azuresynapse.usgovcloudapi.net', 'Synapse'],
  ['web.azuresynapse.net', 'Synapse'],
  // AI Search
  ['search.windows.net', 'AI Search'],
  ['search.usgovcloudapi.net', 'AI Search'],
  ['search.azure.com', 'AI Search'],
  ['search.azure.us', 'AI Search'],
  // Messaging
  ['servicebus.windows.net', 'Event Hubs / Service Bus'],
  ['servicebus.usgovcloudapi.net', 'Event Hubs / Service Bus'],
  ['servicebus.azure.net', 'Service Bus'],
  ['eventhubs.azure.net', 'Event Hubs'],
  ['eventgrid.azure.net', 'Event Grid'],
  // Cosmos
  ['documents.azure.com', 'Cosmos'],
  ['documents.azure.us', 'Cosmos'],
  ['cosmos.azure.com', 'Cosmos'],
  ['cosmos.azure.us', 'Cosmos'],
  // Purview
  ['purview.azure.com', 'Purview'],
  ['purview.azure.net', 'Purview'],
  ['purview.azure.us', 'Purview'],
  ['purview.microsoft.com', 'Purview'],
  ['purview-service.microsoft.com', 'Purview'],
  // AI
  ['openai.azure.com', 'Azure OpenAI'],
  ['openai.azure.us', 'Azure OpenAI'],
  ['cognitiveservices.azure.com', 'Azure AI Services'],
  ['cognitiveservices.azure.us', 'Azure AI Services'],
  ['contentsafety.cognitive.azure.com', 'Azure AI Services'],
  ['services.ai.azure.com', 'AI Foundry'],
  ['ai.azure.com', 'AI Foundry'],
  ['ai.azure.us', 'AI Foundry'],
  ['ml.azure.com', 'AML'],
  ['ml.azure.us', 'AML'],
  // Databricks
  ['azuredatabricks.net', 'Databricks'],
  ['databricks.azure.us', 'Databricks'],
  // Fabric / Power BI — the hosts `no-fabric-dependency.md` makes a rule-level
  // question. This column is what answers it, so these are labelled distinctly.
  ['fabric.microsoft.com', 'Fabric'],
  ['powerbi.com', 'Power BI'],
  ['powerbigov.us', 'Power BI'],
  ['analysis.windows.net', 'Power BI'], // the Power BI AAD scope host
  ['analysis.usgovcloudapi.net', 'Power BI'],
  ['asazure.windows.net', 'AAS'],
  ['asazure.usgovcloudapi.net', 'AAS'],
  // Power Platform family
  ['bap.microsoft.com', 'Power Platform'],
  ['admin.powerplatform.microsoft.com', 'Power Platform'],
  ['flow.microsoft.com', 'Power Automate'],
  ['make.powerpages.microsoft.com', 'Power Pages'],
  ['copilotstudio.microsoft.com', 'Copilot Studio'],
  ['crm.dynamics.com', 'Dataverse'],
  // Monitor family
  ['monitor.azure.com', 'Azure Monitor'],
  ['monitor.azure.us', 'Azure Monitor'],
  ['loganalytics.azure.com', 'Log Analytics'],
  ['opinsights.azure.us', 'Log Analytics'],
  ['grafana.azure.com', 'Azure Managed Grafana'],
  // ARM control plane
  ['management.azure.com', 'ARM'],
  ['management.usgovcloudapi.net', 'ARM'],
  ['management.core.windows.net', 'ARM'],
  // Misc real data planes
  ['redis.azure.com', 'Azure Cache for Redis'],
  ['redis.azure.net', 'Azure Cache for Redis'],
  ['digitaltwins.azure.net', 'Azure Digital Twins'],
  ['atlas.microsoft.com', 'Azure Maps'],
  ['batch.core.windows.net', 'Batch'],
  ['batch.core.usgovcloudapi.net', 'Batch'],
  ['azconfig.io', 'App Configuration'],
  ['azconfig.azure.us', 'App Configuration'],
  ['azurecr.io', 'ACR'],
  ['logic.azure.com', 'Logic Apps'],
  ['dev.azure.com', 'Azure DevOps'],
  ['devcenter.azure.com', 'Dev Center'],
  ['graph.microsoft.com', 'Microsoft Graph'],
  ['sentinel.microsoft.com', 'Microsoft Sentinel'],
  ['prices.azure.com', 'Retail Prices API'],
]);

/** npm client SDK → backend. An import of the SDK IS the dependency. */
export const PACKAGE_BACKEND = new Map([
  ['@azure/cosmos', 'Cosmos'],
  ['@azure/storage-file-datalake', 'ADLS'],
  ['@azure/storage-blob', 'Azure Storage'],
  ['mssql', 'Azure SQL'],
]);

/**
 * Identifiers that are detected and are NOT a backend dependency. Each was read
 * where it occurs; this is the only place a detected identifier may be dropped,
 * and dropping one anywhere else is the `.filter(Boolean)` defect returning.
 *
 * It stays SMALL and every entry states what the identifier actually is.
 */
export const NOT_A_BACKEND = new Map([
  ['pkg:@azure/identity', 'the Entra credential chain — how a client authenticates TO a backend, not a backend. Present in 132 modules; treating it as one would put a label on 1,573 of 1,680 routes and mean nothing.'],
  ['pkg:@azure/msal-node', 'MSAL — sign-in / token acquisition, same reason as @azure/identity.'],
  ['host:login.microsoftonline.com', 'the Entra token endpoint. Every authenticated call touches it; it is authentication, not a data plane.'],
  ['host:sts.windows.net', 'the Entra v1 token issuer, used for issuer VALIDATION in entra-bearer-verify.ts.'],
  ['host:learn.microsoft.com', 'a documentation link, in a comment or a help string rendered in the UI. Never fetched.'],
  ['host:azure.microsoft.com', 'a marketing / pricing page link rendered in the deploy planner. Never fetched.'],
  ['host:www.microsoft.com', 'a documentation link (the MIP file-inject spec). Never fetched.'],
  ['host:developer.microsoft.com', 'a documentation link in the AAS client header. Never fetched.'],
  ['host:schemas.microsoft.com', 'an XML/JSON namespace URI — an identifier, never fetched.'],
  ['host:schema.management.azure.com', 'the ARM TEMPLATE SCHEMA document host ($schema of a Logic App / ARM definition). Not the ARM control plane, which is management.azure.com.'],
  ['host:portal.azure.com', 'an Azure portal deep link rendered in the UI.'],
  ['host:portal.azure.us', 'an Azure portal deep link rendered in the UI.'],
  ['host:admin.microsoft.com', 'a Microsoft 365 admin-center deep link rendered in the UI.'],
  ['host:compliance.microsoft.com', 'a Purview compliance-portal deep link rendered in the UI.'],
  ['host:app.fabric.microsoft.com', 'a Fabric PORTAL deep link (the API host api.fabric.microsoft.com is a separate entry and IS a backend).'],
  ['host:adf.azure.com', 'the ADF STUDIO portal host, used by adfStudioBase() to build a deep link. The ADF control plane is Microsoft.DataFactory over ARM and is a separate entry.'],
  ['host:adf.azure.us', 'the Gov ADF Studio portal host — same as above.'],
  ['host:mcr.microsoft.com', 'a container image reference in the MCP server catalog — an image name, not a call.'],
  ['host:azurewebsites.net', 'the default App Service hostname, used to derive a site URL for display in a placeholder example.'],
  ['arm:Microsoft.Default', 'not a resource provider — the literal `Microsoft.Default` content-filter policy name in an Azure OpenAI deployment payload.'],
  ['arm:Microsoft.DefaultV2', 'ditto, the v2 content-filter policy name.'],
  ['arm:Microsoft.Azure', 'not a resource provider — a prefix fragment (e.g. `Microsoft.Azure.Search` skillset type names) with no ARM path behind it.'],
  // ── BARE sovereign-cloud namespaces ──────────────────────────────────────
  // Each of these occurs ALONE, as a boundary DISCRIMINATOR — `endsWith(
  // '.usgovcloudapi.net')` in trigger-param-resolver.ts, the GOV_SUFFIXES list
  // in lib/copilot/agent-registry.ts — never as a service endpoint. A real Gov
  // endpoint always carries its service label in front (vault.usgovcloudapi.net,
  // dfs.core.usgovcloudapi.net, database.usgovcloudapi.net …) and longest-suffix
  // matching lands on THAT, so nothing real is dropped here.
  ['host:usgovcloudapi.net', 'a bare sovereign-cloud DNS namespace used to TEST which boundary a URI belongs to, not an endpoint.'],
  ['host:azure.us', 'ditto — the bare Gov namespace, listed beside `openai.azure.us` in a suffix-classification table.'],
  ['host:microsoftonline.com', 'the bare Entra namespace in the same suffix table; the token endpoint itself is login.microsoftonline.com and is recorded above.'],
]);

/**
 * Modules whose reach does NOT propagate to their callers.
 *
 * A cut can only ever REMOVE a label, which is the direction that produced this
 * issue — so there is exactly one, it names a chaos-test facility rather than a
 * product dependency, and it is published in the generated document.
 *
 * MEASURED: `cosmos-client.ts::ensure` calls `injectCosmosFault()`, which can
 * emit an audit event, which posts to the Azure Monitor ingestion endpoint. That
 * chain is real but it is the FAULT-INJECTION harness (`LOOM_FAULT_INJECTION`),
 * and because every Cosmos read passes through it, it put **Azure Monitor on
 * 1,564 of 1,680 routes** — a label on 93% of the table that says nothing about
 * any of them. Cutting it takes Azure Monitor to 389, which are routes that
 * reach Monitor through a Monitor client or an audit write. The AUDIT sink
 * itself is deliberately NOT cut: a route that writes an audit event really does
 * write to that backend.
 */
export const PROPAGATION_CUTS = new Map([
  [
    `${CONSOLE_ROOT}/lib/resilience/fault-injection.ts`,
    'the chaos/fault-injection harness. It hangs off every Cosmos operation and can emit an audit event, so its ' +
      'reach propagated Azure Monitor onto 1,564 of 1,680 routes. It is a test facility gated on ' +
      'LOOM_FAULT_INJECTION, not a dependency of any route.',
  ],
]);

/**
 * `lib/azure/**` modules that make a network call and carry NO Azure identifier
 * the derivation can read — the B2 residue, each read at its definition.
 *
 * THIS IS THE ONLY PLACE A MODULE IS NAMED, and it is bounded from the other
 * side: B2 FAILS on any such module that is not here, so the list cannot
 * silently under-report the way `BACKEND_LABEL` did. `backend: null` means the
 * module genuinely depends on no backend; a non-null value names what the code
 * reaches through a host that only exists in configuration at runtime.
 */
export const CLIENT_WITHOUT_AZURE_IDENTIFIER = new Map([
  [
    `${CONSOLE_ROOT}/lib/azure/arm-credential.ts`,
    {
      backend: null,
      why:
        'acquires an ARM-scoped token from the UAMI → DefaultAzureCredential chain and returns it. The ARM base ' +
        'URL it is used WITH lives in cloud-endpoints (armBase()), which is where the ARM label is derived; this ' +
        'module reaches no service of its own.',
    },
  ],
  [
    `${CONSOLE_ROOT}/lib/azure/fetch-with-timeout.ts`,
    { backend: null, why: 'a generic AbortController wrapper around fetch(). The URL is the caller\'s.' },
  ],
  [
    `${CONSOLE_ROOT}/lib/azure/aca-managed-identity.ts`,
    {
      backend: null,
      why:
        'a custom TokenCredential that GETs the Container Apps managed-identity endpoint ($IDENTITY_ENDPOINT, a ' +
        'localhost-side IMDS-style URL) because @azure/identity cannot parse the ACA response. It mints a token; ' +
        'the service the token is spent on is attributed at the client that spends it.',
    },
  ],
  [
    `${CONSOLE_ROOT}/lib/azure/data-access-mode.ts`,
    {
      backend: null,
      why:
        'the (default-OFF) switchboard choosing between the shared Console UAMI and a per-user OBO credential. It ' +
        'selects an IDENTITY; the service that identity is used against is attributed at the client that calls it.',
    },
  ],
  [
    `${CONSOLE_ROOT}/lib/azure/obo-token-store.ts`,
    { backend: null, why: 'the (default-OFF) On-Behalf-Of token exchange + in-process cache. Entra token acquisition, not a data plane.' },
  ],
  [
    `${CONSOLE_ROOT}/lib/azure/entra-bearer-verify.ts`,
    {
      backend: null,
      why:
        'verifies an INBOUND Entra bearer token. Its only fetch is the tenant JWKS from the Entra OIDC metadata ' +
        'document — authentication, and inbound at that.',
    },
  ],
  [
    `${CONSOLE_ROOT}/lib/azure/openlineage-auth.ts`,
    { backend: null, why: 'the same shape for OpenLineage ingest: it fetches the tenant JWKS to validate an inbound token.' },
  ],
  [
    `${CONSOLE_ROOT}/lib/azure/script-context.ts`,
    {
      backend: null,
      why:
        'reads deployment values out of the environment so a surfaced remediation command carries real values ' +
        'instead of placeholders. Its one ARM fallback resolves the UAMI principal id through arm-credential.',
    },
  ],
  [
    `${CONSOLE_ROOT}/lib/azure/databricks-scale-client.ts`,
    {
      backend: 'Databricks',
      why:
        'instance pools / environment libraries / Spark conf over the Databricks workspace REST API — ' +
        '`fetchWithTimeout(`https://${host()}${path}`)` where `host()` is `LOOM_DATABRICKS_HOSTNAME`. The host is ' +
        'deployment configuration, so no `azuredatabricks.net` literal appears in the module and the derivation ' +
        'cannot read it. The AAD resource id it authenticates against (2ff814a6-…) IS the Azure Databricks ' +
        'first-party app.',
    },
  ],
  [
    `${CONSOLE_ROOT}/lib/azure/capacity-broker-client.ts`,
    {
      backend: 'Loom service',
      why:
        'POSTs /admit to the `loom-capacity-broker` Container App at `LOOM_CAPACITY_BROKER_URL` — one of Loom\'s ' +
        'OWN services, not an Azure backing service. Whatever Azure resources the broker itself uses are ' +
        'attributed in that app, not on the calling route.',
    },
  ],
  [
    `${CONSOLE_ROOT}/lib/azure/loom-onelake-client.ts`,
    {
      backend: 'Loom service',
      why:
        'resolves a `loom://` address through the `loom-onelake` Container App at `LOOM_ONELAKE_URL`. It reaches ' +
        'ADLS only INDIRECTLY, through that service; per no-fabric-dependency.md it deliberately never touches an ' +
        'onelake.dfs.fabric host.',
    },
  ],
  [
    `${CONSOLE_ROOT}/lib/azure/scc-labels-client.ts`,
    {
      backend: 'Loom service',
      why:
        'calls the `azure-functions/scc-labels` PowerShell sidecar at `LOOM_SCC_LABELS_ENDPOINT`, because ' +
        'sensitivity-label CRUD exists ONLY in Security & Compliance PowerShell and has no app-only Graph ' +
        'surface. The route\'s dependency is the sidecar; the SCC endpoint is reached from there.',
    },
  ],
]);

// ───────────────────────────────────────────────────────────────────────────
// 1. DETECTION — generic, so an UNKNOWN service is detected and then fails.
// ───────────────────────────────────────────────────────────────────────────

/**
 * The Microsoft cloud DNS namespaces a data-plane host can live under. A host
 * matched here whose suffix is in NEITHER table is a B1 unknown, so this list
 * bounds what can be SEEN — it does not bound what can be labelled. It is kept
 * broad for that reason.
 */
const CLOUD_TLDS = [
  'azure\\.com', 'azure\\.net', 'azure\\.us', 'windows\\.net', 'usgovcloudapi\\.net',
  'microsoft\\.com', 'microsoftonline\\.com', 'powerbi\\.com', 'powerbigov\\.us',
  'azuredatabricks\\.net', 'azuresynapse\\.net', 'databricks\\.com', 'dynamics\\.com',
  'azure-api\\.net', 'azurewebsites\\.net', 'azconfig\\.io', 'azurecr\\.io',
  'cloudapp\\.azure\\.com', 'microsoftazure\\.us', 'azureedge\\.net', 'office\\.com',
];
/**
 * A hostname under one of those namespaces.
 *
 * The leading labels are OPTIONAL (`*` not `+`), and that was a measured
 * blind spot rather than a style choice: `model-serving-client` builds
 * `https://${process.env.LOOM_DBX}.azuredatabricks.net/serving-endpoints/…`,
 * where the subdomain is an interpolation. With a required leading label the
 * regex saw `}.azuredatabricks.net` and matched NOTHING, so a client whose host
 * is assembled at runtime — which is most of them — reported no backend. This is
 * the `\.replaceAll?\(` trap: a detector keyed to a shape that does not occur
 * returns a reassuring zero.
 */
export const HOST_RE = new RegExp(`\\b((?:[a-z0-9-]+\\.)*(?:${CLOUD_TLDS.join('|')}))\\b`, 'g');
/** An ARM resource-provider namespace. */
export const PROVIDER_RE = /\bMicrosoft\.[A-Za-z][A-Za-z0-9]*/g;
/** A first-party Azure/data client SDK import. */
export const PACKAGE_RE =
  /from\s+['"]((?:@azure\/[a-z0-9-]+)|mssql|pg|azure-kusto-data|azure-kusto-ingest|tedious|ioredis)['"]/g;

/**
 * Longest-first over BOTH tables. Taking it from the label table alone was a
 * measured bug: `my-fn.azurewebsites.net` did not reduce to `azurewebsites.net`
 * (which is recorded as a non-backend), so a placeholder hostname in a doc
 * example was reported as an unknown Azure service.
 */
const HOST_SUFFIXES_LONGEST_FIRST = [
  ...HOST_SUFFIX_BACKEND.keys(),
  ...[...NOT_A_BACKEND.keys()].filter((k) => k.startsWith('host:')).map((k) => k.slice(5)),
].sort((a, b) => b.length - a.length);

/** Canonical identifier token for a host: its longest KNOWN suffix, else itself. */
export function canonicalHost(host) {
  for (const s of HOST_SUFFIXES_LONGEST_FIRST) if (host === s || host.endsWith(`.${s}`)) return s;
  return host;
}

/**
 * Azure identifiers in one blob of masked source (`dataCode`: comments blanked,
 * strings kept). Returns canonical tokens — `arm:*` / `host:*` / `pkg:*`.
 *
 * A host preceded by WHITESPACE is prose, not an endpoint, and is dropped. That
 * is not a guess either: `lib/mcp/catalog.ts` carries the description string
 * "Targets the cloud-specific ARM endpoint (commercial or usgovcloudapi.net)",
 * which is help text shown in the UI, and it reached routes as an unrecognised
 * Azure service. A real endpoint is always preceded by `/`, `.`, a quote, `$`,
 * `{` or `=` — never by a space. Comments are already gone; this handles PROSE
 * INSIDE A STRING, which comment-stripping cannot.
 */
export function detectIdentifiers(dataCode) {
  const out = new Set();
  for (const m of dataCode.matchAll(PROVIDER_RE)) out.add(`arm:${m[0]}`);
  for (const m of dataCode.matchAll(HOST_RE)) {
    if (m.index > 0 && /\s/.test(dataCode[m.index - 1])) continue;
    out.add(`host:${canonicalHost(m[1])}`);
  }
  for (const m of dataCode.matchAll(PACKAGE_RE)) out.add(`pkg:${m[1]}`);
  return out;
}

/** The label an identifier publishes, `null` when it is a recorded non-backend,
 *  `undefined` when the vocabulary has never seen it (a B1 unknown). */
export function labelFor(id) {
  if (NOT_A_BACKEND.has(id)) return null;
  if (id.startsWith('arm:')) return ARM_PROVIDER_BACKEND.get(id.slice(4));
  if (id.startsWith('host:')) return HOST_SUFFIX_BACKEND.get(id.slice(5));
  if (id.startsWith('pkg:')) return PACKAGE_BACKEND.get(id.slice(4));
  // A B2 residue module whose backend was READ AT ITS DEFINITION because the
  // code names a host only present in runtime configuration.
  if (id.startsWith('declared:')) {
    const e = CLIENT_WITHOUT_AZURE_IDENTIFIER.get(id.slice(9));
    return e ? e.backend : undefined;
  }
  return undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// 2. DERIVATION — which FUNCTION reaches which backend
// ───────────────────────────────────────────────────────────────────────────

export const keyOf = (file, name) => `${file}::${name}`;

/**
 * A module-scope binding — `const NAME = <initialiser>;`.
 *
 * These are NODES in the reach graph, not decoration, and two measured defects
 * are why:
 *
 *   (a) `graph-identity-client.ts` reaches Microsoft Graph through
 *       `const GRAPH_BASE = getGraphHost();` — a CALL at module scope. A walk
 *       that only looks inside function bodies sees nothing, and the module
 *       (plus every route reaching it) published no backend.
 *   (b) `cloud-endpoints.ts` exports `SEARCH_AAD_SCOPE =
 *       'https://search.azure.com/.default'`. Attributing a module-scope literal
 *       to EVERY function in its file put AI Search on `armBase()`, which nearly
 *       everything calls — 1,090 of 1,680 routes published AI Search. Measured.
 *
 * So a binding gets its own node, seeded with the identifiers in its
 * initialiser and edged to whatever that initialiser calls; a function inherits
 * it only by REFERENCING the name.
 */
const MODULE_CONST_RE = /(?:^|[\n;}])(\s*(?:export\s+)?(?:const|let|var)\s+)([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^;]*);/g;

/** A module that talks to the network — the B2 precondition. */
const NETWORK_CALL_RE =
  /\bfetchWithTimeout\s*\(|\bfetch\s*\(|\bazureFetch\s*\(|\barmRequest\s*\(|\bnew\s+ConnectionPool\b|\bgetToken\s*\(|\bfrom\s+['"]@azure\//;

/**
 * `import * as adf from '@/lib/azure/adf-client'` — the NAMESPACE alias.
 *
 * `buildGraph` deliberately strips these (`.replace(/\*\s+as\s+…/)`), and
 * `callSites` deliberately ignores member calls, so `adf.listLinkedServices()`
 * is invisible to both halves of the edge builder. That is the DELEGATION trap:
 * a canonical client reached under a local alias, which no name scan sees.
 * Measured: `lib/copilot/pipeline-tools.ts` reaches ADF and Synapse this way and
 * this way only, so `items/adf-pipeline/[id]/connections` and
 * `items/data-pipeline/[id]/connections` published `—` while listing real linked
 * services. Resolved per MEMBER (`alias.member` -> `targetFile::member`), not
 * per module, so a namespace import of a hub does not drag the hub in.
 */
const NAMESPACE_IMPORT_RE = /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"]/g;

/**
 * Derive, for every declared function and module-scope binding in the console,
 * the set of backend identifiers it reaches.
 *
 * @returns {{ fnReach: Map<string,Map<string,string|null>>, declsOf: Map<string,Map>,
 *             origins: Map<string,Set<string>>, networkModules: Set<string>, edges: Map<string,Set<string>> }}
 *   `fnReach` maps a `file::name` key to `identifier -> via`, where `via` is the
 *   node the identifier arrived through, or `null` when seeded on that node.
 */
export function deriveBackendReach(graph) {
  const declsOf = new Map();
  const seed = new Map();
  const edges = new Map();
  const spansOf = new Map(); // file -> Map(name -> {start,end})  decls + bindings
  const origins = new Map(); // identifier -> Set(file) where it is SEEDED
  const networkModules = new Set();

  const noteOrigin = (id, file) => {
    if (!origins.has(id)) origins.set(id, new Set());
    origins.get(id).add(file);
  };

  for (const mod of graph.modules.values()) {
    // STRUCTURE comes from `code` (comments AND strings blanked); IDENTIFIERS
    // come from `dataCode` (strings kept). Both are offset-preserving, so one
    // indexes the other — and mixing them up is not a style point:
    // `parseDeclarations` matches brackets, and a `{` or `(` inside a STRING
    // literal throws the depth count off. Measured: parsing over `dataCode`
    // lost `export async function POST` in
    // `items/synapse-dedicated-sql-pool/[id]/clone/route.ts` entirely, so the
    // route reached nothing and published `—` while running a live
    // `executeQuery` against a Synapse dedicated pool. `mod.decls` is already
    // parsed correctly by the shared graph, so it is reused rather than redone.
    const decls = mod.decls;
    declsOf.set(mod.file, decls);
    if (NETWORK_CALL_RE.test(mod.dataCode)) networkModules.add(mod.file);

    // Module scope = everything outside a declaration body. Blanked with spaces
    // so offsets still index mod.code / mod.dataCode.
    //
    // THE LEADING DELIMITER IS PRESERVED, and that is not cosmetic.
    // `parseDeclarations` anchors on `(?:^|[\n;{}])`, so a declaration's span
    // STARTS at the `;` that terminates the statement before it. Blanking the
    // span whole ate that `;`, MODULE_CONST_RE (which needs it) failed to match
    // the preceding `const`, and its identifiers fell into `leftover` — where
    // they leak module-wide. Measured on the control: `SEARCH_AAD_SCOPE` sitting
    // one line above `export function armBase()` put AI Search on armBase, which
    // is the exact 1,090-route conflation this analyzer exists to avoid.
    let scopeCode = mod.code;
    for (const s of [...decls.values()].sort((a, b) => b.start - a.start)) {
      let from = s.start;
      while (from < s.end && /[\n;{}\s]/.test(scopeCode[from])) from++;
      scopeCode = scopeCode.slice(0, from) + ' '.repeat(s.end - from) + scopeCode.slice(s.end);
    }

    const spans = new Map([...decls].map(([n, s]) => [n, { start: s.start, end: s.end }]));
    for (const m of scopeCode.matchAll(MODULE_CONST_RE)) {
      const name = m[2];
      if (spans.has(name)) continue; // a real declaration wins
      const start = m.index + m[1].length + (m[0].startsWith(m[1]) ? 0 : 1);
      spans.set(name, { start, end: m.index + m[0].length });
    }
    spansOf.set(mod.file, spans);

    // A package import is module-wide by construction — it IS the dependency.
    const pkgIds = new Set([...mod.dataCode.matchAll(PACKAGE_RE)].map((m) => `pkg:${m[1]}`));
    // Anything left once EVERY named span is blanked could not be attributed to
    // a name (a class body, a decorator, a bare top-level statement). It leaks
    // module-wide, which is the OVER-report direction — see the header's
    // statement of limits.
    let unnamedScope = mod.dataCode;
    for (const s of [...spans.values()].sort((a, b) => b.start - a.start)) {
      unnamedScope = unnamedScope.slice(0, s.start) + ' '.repeat(s.end - s.start) + unnamedScope.slice(s.end);
    }
    const leftover = new Set([...detectIdentifiers(unnamedScope)].filter((id) => !pkgIds.has(id)));
    const declared = CLIENT_WITHOUT_AZURE_IDENTIFIER.get(mod.file)?.backend ? [`declared:${mod.file}`] : [];

    for (const [name, span] of spans) {
      const ids = detectIdentifiers(mod.dataCode.slice(span.start, span.end));
      for (const id of leftover) ids.add(id);
      for (const id of pkgIds) ids.add(id);
      for (const id of declared) ids.add(id);
      for (const id of ids) noteOrigin(id, mod.file);
      seed.set(keyOf(mod.file, name), ids);
    }
    // A module with no parsed spans still counts as evidence for B3.
    if (!spans.size) for (const id of new Set([...detectIdentifiers(mod.dataCode), ...pkgIds])) noteOrigin(id, mod.file);
  }

  // Edges: what each node CALLS, plus what it REFERENCES by name. The reference
  // half is load-bearing — `GRAPH_V1` carries Graph and is used, never called.
  //
  // Resolution CANNOT go through `graph.resolveLocal` alone. That resolver was
  // built for the auth column and bottoms out on `parseDeclarations`, which only
  // knows FUNCTIONS — so an imported module-scope BINDING resolves to nothing
  // and its edge is silently dropped. Measured: `azure-sql-client.ts` exports
  // `export const liveRequests: Map<string, sql.Request> = new Map()`, and
  // `items/azure-sql-database/[id]/query/cancel` does `liveRequests.get(id)
  // .cancel()` — a TDS ATTENTION packet to Azure SQL. With only the shared
  // resolver that route published `—`, which is this issue's own defect
  // reproduced by its fix. `resolveBinding` below extends resolution to the
  // binding table without changing the shared analyzer.
  const resolveBinding = (file, name, seen = new Set()) => {
    const viaFn = graph.resolveLocal(file, name);
    if (viaFn && viaFn.file) return viaFn;
    const mod = graph.modules.get(file);
    if (!mod) return null;
    const key = `${file}::${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const imp = mod.imports.get(name);
    if (imp) return imp.target.file ? resolveExportedBinding(imp.target.file, imp.imported, seen) : null;
    if (spansOf.get(file)?.has(name)) return { file, name };
    return null;
  };
  const resolveExportedBinding = (file, name, seen) => {
    const mod = graph.modules.get(file);
    if (!mod) return null;
    if (spansOf.get(file)?.has(name)) return { file, name };
    const imp = mod.imports.get(name);
    if (imp) return imp.target.file ? resolveExportedBinding(imp.target.file, imp.imported, seen) : null;
    for (const rx of mod.reexports) {
      if (rx.exported !== name || !rx.target.file) continue;
      const r = resolveExportedBinding(rx.target.file, rx.imported, seen);
      if (r) return r;
    }
    for (const st of mod.stars) {
      if (!st.file || seen.has(`${st.file}::${name}`)) continue;
      seen.add(`${st.file}::${name}`);
      const r = resolveExportedBinding(st.file, name, seen);
      if (r) return r;
    }
    return null;
  };

  for (const mod of graph.modules.values()) {
    const spans = spansOf.get(mod.file);
    const candidates = [...new Set([...mod.imports.keys(), ...spans.keys()])];
    const namespaces = new Map();
    for (const m of mod.dataCode.matchAll(NAMESPACE_IMPORT_RE)) {
      const t = graph.resolveSpec(m[2], mod.file);
      if (t.file) namespaces.set(m[1], t.file);
    }
    for (const [name, span] of spans) {
      const out = new Set();
      const take = (r) => {
        if (!r || !r.file || PROPAGATION_CUTS.has(r.file)) return;
        out.add(keyOf(r.file, r.name));
      };
      for (const site of callSites(mod.code, span.start, span.end)) {
        if (site.name === name) continue;
        take(resolveBinding(mod.file, site.name));
      }
      const body = mod.code.slice(span.start, span.end);
      for (const [alias, target] of namespaces) {
        const re = new RegExp(`(?:^|[^\\w$.])${alias}\\.([A-Za-z_$][\\w$]*)`, 'g');
        for (const m of body.matchAll(re)) if (spansOf.get(target)?.has(m[1])) out.add(keyOf(target, m[1]));
      }
      for (const cand of candidates) {
        if (cand === name) continue;
        if (!new RegExp(`(?:^|[^\\w$.])${cand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`).test(body)) continue;
        if (spans.has(cand) && !mod.imports.has(cand)) { out.add(keyOf(mod.file, cand)); continue; }
        take(resolveBinding(mod.file, cand));
      }
      if (out.size) edges.set(keyOf(mod.file, name), out);
    }
  }

  const fnReach = new Map();
  for (const [k, ids] of seed) fnReach.set(k, new Map([...ids].map((id) => [id, null])));
  for (let pass = 0; pass < 40; pass++) {
    let changed = false;
    for (const [k, outs] of edges) {
      const mine = fnReach.get(k);
      if (!mine) continue;
      for (const o of outs) {
        const theirs = fnReach.get(o);
        if (!theirs) continue;
        for (const id of theirs.keys()) {
          if (mine.has(id)) continue;
          mine.set(id, o);
          changed = true;
        }
      }
    }
    if (!changed) return { fnReach, declsOf, spansOf, origins, networkModules, edges };
  }
  throw new Error('[route-backends] backend derivation did not reach a fixpoint in 40 passes');
}

// ───────────────────────────────────────────────────────────────────────────
// 3. ROUTE CLASSIFICATION
// ───────────────────────────────────────────────────────────────────────────

/** Names declared in a route file that are reachable from an exported verb. */
function reachableNames(mod, spans) {
  const seen = new Set();
  const stack = HTTP_METHODS.filter((m) => spans.has(m));
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    const span = spans.get(n);
    if (!span) continue;
    for (const site of callSites(mod.code, span.start, span.end))
      if (spans.has(site.name) && !seen.has(site.name)) stack.push(site.name);
  }
  return seen;
}

/**
 * Classify ONE route file.
 *
 * @returns {{ backends:string[], identifiers:string[], why:Map<string,string[]>,
 *             unknowns:{kind:string,identifier?:string,module:string,line:number,note:string}[] }}
 */
/**
 * Follow an identifier's `via` chain back to the node that SEEDED it.
 *
 * The immediate `via` is the last hop, which is usually a shared helper and
 * tells a reader nothing. `deploy-integrity.md` R7 is about messages that are
 * true AND actionable: "read it where it occurs" needs the module where it
 * actually occurs.
 */
export function originOf(derivation, id, fromKey) {
  let node = fromKey;
  const seen = new Set();
  for (let i = 0; i < 64 && node && !seen.has(node); i++) {
    seen.add(node);
    const next = derivation.fnReach.get(node)?.get(id);
    if (!next) return node;
    node = next;
  }
  return node;
}

/**
 * Classify ONE route file.
 *
 * @returns {{ backends:string[], identifiers:string[], why:Map<string,string[]>,
 *             unknowns:{kind:string,identifier:string,module:string,note:string}[] }}
 */
export function classifyRouteBackends(graph, derivation, file) {
  const mod = graph.modules.get(file);
  if (!mod) throw new Error(`[route-backends] ${file} is not in the module graph`);
  const { fnReach, spansOf } = derivation;
  const names = reachableNames(mod, spansOf.get(file));

  const ids = new Map(); // identifier -> the node it arrived through
  for (const n of names) {
    for (const [id, via] of fnReach.get(keyOf(file, n)) ?? []) if (!ids.has(id)) ids.set(id, via ?? keyOf(file, n));
  }

  const labels = new Set();
  const unknowns = [];
  const why = new Map();
  for (const [id, via] of ids) {
    const label = labelFor(id);
    if (label === undefined) {
      const origin = originOf(derivation, id, via);
      unknowns.push({
        kind: 'unknown-azure-identifier',
        identifier: id,
        module: origin.slice(0, origin.lastIndexOf('::')),
        note:
          `reaches the Azure identifier \`${id.replace(/^[a-z]+:/, '')}\`, seeded at \`${origin}\`, which is in ` +
          'neither ARM_PROVIDER_BACKEND / HOST_SUFFIX_BACKEND / PACKAGE_BACKEND nor NOT_A_BACKEND. Read it where ' +
          'it occurs and record it in scripts/ci/_route-backends.mjs — as the backend it identifies, or as a ' +
          'non-backend with the reason. Publishing `—` on an unrecognised Azure service is the #3592 defect.',
      });
      continue;
    }
    if (label === null) continue;
    labels.add(label);
    if (!why.has(label)) why.set(label, []);
    why.get(label).push(`${id} ← ${originOf(derivation, id, via)}`);
  }

  return { backends: [...labels].sort(), identifiers: [...ids.keys()].sort(), why, unknowns };
}

// ───────────────────────────────────────────────────────────────────────────
// 4. TREE-WIDE ASSERTIONS
// ───────────────────────────────────────────────────────────────────────────

/**
 * B3 — a seeded identifier with ZERO population in the tree.
 *
 * This is the `keyvault-client` shape that made Wave 0's instance invisible: a
 * vocabulary entry that LOOKS like coverage while covering nothing. Reported for
 * the label tables only; `NOT_A_BACKEND` is deliberately exempt, because an
 * entry there exists to record a JUDGEMENT ("this is not a backend") that stays
 * true after the last occurrence is deleted.
 */
export function unpopulatedSeeds(origins) {
  const seen = new Set(origins.keys());
  const dead = [];
  for (const k of ARM_PROVIDER_BACKEND.keys()) if (!seen.has(`arm:${k}`)) dead.push(`arm:${k}`);
  for (const k of HOST_SUFFIX_BACKEND.keys()) if (!seen.has(`host:${k}`)) dead.push(`host:${k}`);
  for (const k of PACKAGE_BACKEND.keys()) if (!seen.has(`pkg:${k}`)) dead.push(`pkg:${k}`);
  return dead;
}

/**
 * B2 — modules under `lib/azure/**` that a route reaches, that make a network
 * call, and to which the derivation attributes no backend at all.
 *
 * This is what makes `—` an ASSERTION. A route publishes "touches no backend"
 * only when every client module it reaches has been NAMED: either the
 * derivation read an Azure identifier out of it, or it is recorded in
 * `CLIENT_WITHOUT_AZURE_IDENTIFIER` with the verdict read at its definition.
 * A module in neither state stops the generator.
 */
export function unnamedClientModules(graph, derivation, routeFiles) {
  const { fnReach, spansOf, networkModules } = derivation;
  const reached = new Set();
  for (const f of routeFiles) {
    const mod = graph.modules.get(f);
    if (!mod) continue;
    for (const n of reachableNames(mod, spansOf.get(f))) {
      const stack = [keyOf(f, n)];
      const seen = new Set(stack);
      while (stack.length) {
        const k = stack.pop();
        reached.add(k.slice(0, k.lastIndexOf('::')));
        for (const out of derivation.edges.get(k) ?? []) if (!seen.has(out)) { seen.add(out); stack.push(out); }
      }
    }
  }
  const bad = [];
  for (const file of reached) {
    if (!file.startsWith(`${CONSOLE_ROOT}/lib/azure/`)) continue;
    if (!networkModules.has(file)) continue;
    if (CLIENT_WITHOUT_AZURE_IDENTIFIER.has(file)) continue;
    let any = false;
    for (const [name] of spansOf.get(file) ?? []) {
      for (const id of (fnReach.get(keyOf(file, name)) ?? new Map()).keys()) {
        // An identifier the vocabulary does not know is B1's business, and B1
        // already names the module. Reporting it here as well would be a second
        // failure for one cause — the "annotation that fires when nothing new is
        // wrong" habit `check-external-origin-urls` records.
        if (labelFor(id) !== null) { any = true; break; }
      }
      if (any) break;
    }
    if (!any) bad.push(file);
  }
  return bad.sort();
}

/**
 * Every module NAMED in this file must still exist — the #2977 control, one
 * analyzer over. A cut or an exemption whose module was renamed or deleted goes
 * on silently suppressing or excusing nothing, and the next module to need it
 * gets no protection.
 */
export function staleModuleReferences(graph) {
  const bad = [];
  for (const f of PROPAGATION_CUTS.keys())
    if (!graph.modules.has(f)) bad.push(`${f} — PROPAGATION_CUTS names a module that is not a tracked console source`);
  for (const f of CLIENT_WITHOUT_AZURE_IDENTIFIER.keys())
    if (!graph.modules.has(f))
      bad.push(`${f} — CLIENT_WITHOUT_AZURE_IDENTIFIER names a module that is not a tracked console source`);
  return bad;
}

// ───────────────────────────────────────────────────────────────────────────
// 5. EMBEDDED CONTROLS — run BEFORE the repo is judged.
//
// A taxonomy from a classifier that has stopped classifying is not a taxonomy.
// The controls that matter most here are the NEGATIVE ones — a host in a
// comment, a doc link, a credential SDK, a module-scope literal the function
// never references — because a control set that only models the working case
// passes on the very tree that produced #3592 (`guard_keyed_to_the_unsafe_
// pattern`, and #3468 one guard over).
// ───────────────────────────────────────────────────────────────────────────

const CONTROL_ROUTE = 'apps/fiab-console/app/api/items/control/[id]/route.ts';

/** Stubs shared by every control, shaped like the real modules they stand for. */
const STUB_MODULES = {
  // The endpoint registry — per-service resolvers, exactly as cloud-endpoints.ts
  // is written. `armBase()` must NOT carry the AI Search scope that sits beside
  // it at module scope; that conflation was measured at 1,090 routes.
  'apps/fiab-console/lib/azure/cloud-endpoints.ts': [
    "export const SEARCH_AAD_SCOPE = 'https://search.azure.com/.default';",
    "export function armBase() { return 'https://management.azure.com'; }",
    "export function kustoSuffix() { return 'kusto.windows.net'; }",
    'export function searchAadScope() { return SEARCH_AAD_SCOPE; }',
    "export function getGraphHost() { return 'https://graph.microsoft.com'; }",
  ].join('\n'),
  // A canonical data-plane client: an ARM path with a provider namespace.
  'apps/fiab-console/lib/azure/kusto-client.ts': [
    "import { armBase, kustoSuffix } from '@/lib/azure/cloud-endpoints';",
    'export async function listDatabases(cluster) {',
    '  const url = `${armBase()}/subscriptions/x/providers/Microsoft.Kusto/clusters/${cluster}`;',
    '  return fetch(url);',
    '}',
    'export async function executeKql(cluster, kql) {',
    '  return fetch(`https://${cluster}.${kustoSuffix()}/v2/rest/query`, { body: kql });',
    '}',
  ].join('\n'),
  // The #3545 shape: a client that reaches its backend ONLY through a sibling.
  'apps/fiab-console/lib/azure/azure-sql-client.ts': [
    "import sql from 'mssql';",
    'export async function executeQuery(target, text) { return sql.query(target, text); }',
  ].join('\n'),
  'apps/fiab-console/lib/azure/sql-objects-client.ts': [
    "import { executeQuery } from './azure-sql-client';",
    'export async function listTables(target) { return executeQuery(target, SELECT_TABLES); }',
  ].join('\n'),
};

const L = (...lines) => lines.join('\n');

/** Build a synthetic graph and classify one route in it. */
export function analyzeSynthetic(files, route = CONTROL_ROUTE) {
  const all = { ...STUB_MODULES, ...files };
  const graph = buildGraph({ repoRoot: '/synthetic', files: Object.keys(all), readFile: (f) => all[f] });
  const derivation = deriveBackendReach(graph);
  const result = classifyRouteBackends(graph, derivation, route);
  return { ...result, unnamed: unnamedClientModules(graph, derivation, [route]), graph, derivation };
}

export const CONTROLS = [
  // ── MUST publish a backend ───────────────────────────────────────────────
  {
    name: 'canonical: the route calls a client whose ARM path names Microsoft.Kusto',
    files: {
      [CONTROL_ROUTE]: L(
        "import { listDatabases } from '@/lib/azure/kusto-client';",
        'export async function GET(req, ctx) { return json(await listDatabases(ctx.params.id)); }',
      ),
    },
    expect: { has: ['ADX', 'ARM'], hasNot: [], unknown: false },
  },
  {
    name:
      'TRANSITIVE (#3545) — the route imports sql-objects-client, which reaches Azure SQL only through ' +
      'azure-sql-client. All 24 routes in this shape published `—` under the module-name map, which HAD ' +
      'azure-sql-client in it',
    files: {
      [CONTROL_ROUTE]: L(
        "import { listTables } from '@/lib/azure/sql-objects-client';",
        'export async function GET(req, ctx) { return json(await listTables(ctx.params.id)); }',
      ),
    },
    expect: { has: ['Azure SQL'], hasNot: [], unknown: false },
  },
  {
    name:
      'DELEGATION — the canonical client is reached through a route-local `_lib` helper under a LOCAL ALIAS. ' +
      'A name scan over the route file sees no @/lib/azure import at all',
    files: {
      'apps/fiab-console/app/api/items/_lib/adx-helper.ts': L(
        "import { executeKql as runKql } from '@/lib/azure/kusto-client';",
        'export async function queryItem(cluster, kql) { return runKql(cluster, kql); }',
      ),
      [CONTROL_ROUTE]: L(
        "import { queryItem } from '@/app/api/items/_lib/adx-helper';",
        'export async function POST(req, ctx) { return json(await queryItem(ctx.params.id, req.kql)); }',
      ),
    },
    expect: { has: ['ADX'], hasNot: [], unknown: false },
  },
  {
    name:
      'MODULE-SCOPE CALL — `const GRAPH_BASE = getGraphHost();` at module scope. A walk that only reads ' +
      'function BODIES sees nothing, which is why graph-identity-client.ts and 14 other clients published no ' +
      'backend on the first draft of this analyzer',
    files: {
      'apps/fiab-console/lib/azure/graph-identity-client.ts': L(
        "import { getGraphHost } from '@/lib/azure/cloud-endpoints';",
        'const GRAPH_BASE = getGraphHost();',
        'const GRAPH_V1 = `${GRAPH_BASE}/v1.0`;',
        'export async function listGroups() { return fetch(`${GRAPH_V1}/groups`); }',
      ),
      [CONTROL_ROUTE]: L(
        "import { listGroups } from '@/lib/azure/graph-identity-client';",
        'export async function GET() { return json(await listGroups()); }',
      ),
    },
    expect: { has: ['Microsoft Graph'], hasNot: [], unknown: false },
  },
  {
    name:
      'DUAL DISPATCH — a client that reaches EITHER backend depending on deployment configuration publishes ' +
      'both. This is the model-serving-client shape the old map had to hand-write as one fused label',
    files: {
      'apps/fiab-console/lib/azure/model-serving-client.ts': L(
        "import { armBase } from '@/lib/azure/cloud-endpoints';",
        'export async function invoke(name, body) {',
        "  if (process.env.LOOM_MODEL_SERVING_BACKEND === 'databricks') {",
        '    return fetch(`https://${process.env.LOOM_DBX}.azuredatabricks.net/serving-endpoints/${name}`, body);',
        '  }',
        '  return fetch(`${armBase()}/subscriptions/x/providers/Microsoft.MachineLearningServices/workspaces/w/onlineEndpoints/${name}`, body);',
        '}',
      ),
      [CONTROL_ROUTE]: L(
        "import { invoke } from '@/lib/azure/model-serving-client';",
        'export async function POST(req, ctx) { return json(await invoke(ctx.params.id, req.body)); }',
      ),
    },
    expect: { has: ['AML', 'Databricks'], hasNot: [], unknown: false },
  },
  // ── MUST NOT publish a backend ───────────────────────────────────────────
  {
    name:
      'A HOST IN A COMMENT CANNOT REACH ANYTHING. `azure-sql-database/[id]/query` is the precedent one column ' +
      'over: stripping every code-level owner token left the published row byte-identical because both ' +
      'occurrences were in comments',
    files: {
      [CONTROL_ROUTE]: L(
        '/**',
        ' * Was: fetch(`https://${cluster}.kusto.windows.net/v2/rest/query`)',
        ' * See providers/Microsoft.Kusto/clusters for the ARM shape.',
        ' */',
        'export async function GET() { return json({ ok: true }); }',
      ),
    },
    expect: { has: [], hasNot: ['ADX'], unknown: false },
  },
  {
    name: 'a LEARN DOC LINK in a string is not a backend dependency',
    files: {
      [CONTROL_ROUTE]: L(
        "const HELP = 'https://learn.microsoft.com/azure/data-explorer/kusto/query/';",
        'export async function GET() { return json({ ok: true, help: HELP }); }',
      ),
    },
    expect: { has: [], hasNot: [], unknown: false },
  },
  {
    name:
      'the CREDENTIAL SDK is not a backend — @azure/identity is how a client authenticates TO one. Counting it ' +
      'would put a label on 1,573 of 1,680 routes',
    files: {
      [CONTROL_ROUTE]: L(
        "import { DefaultAzureCredential } from '@azure/identity';",
        'export async function GET() { const c = new DefaultAzureCredential(); return json({ ok: !!c }); }',
      ),
    },
    expect: { has: [], hasNot: [], unknown: false },
  },
  {
    name: 'a client called only from a helper the route NEVER calls is not the route’s dependency',
    files: {
      [CONTROL_ROUTE]: L(
        "import { executeKql } from '@/lib/azure/kusto-client';",
        'async function unusedHelper(c, k) { return executeKql(c, k); }',
        'export async function GET() { return json({ ok: true }); }',
      ),
    },
    expect: { has: [], hasNot: ['ADX'], unknown: false },
  },
  {
    name:
      'THE MEASURED CONFLATION — `armBase()` sits beside `SEARCH_AAD_SCOPE` at module scope in the SAME file. ' +
      'A route that reaches only armBase() must publish ARM and NOT AI Search. Attributing module-scope ' +
      'literals to every function in their module put AI Search on 1,090 of 1,680 routes',
    files: {
      [CONTROL_ROUTE]: L(
        "import { armBase } from '@/lib/azure/cloud-endpoints';",
        'export async function GET() { return json({ base: armBase() }); }',
      ),
    },
    expect: { has: ['ARM'], hasNot: ['AI Search'], unknown: false },
  },
  {
    name:
      'NAMESPACE ALIAS — `import * as adf` + `adf.listLinkedServices()`. buildGraph strips namespace imports and ' +
      'callSites ignores member calls, so this is invisible to BOTH halves of the edge builder. Measured: ' +
      'lib/copilot/pipeline-tools.ts reaches ADF only this way, and two connections routes published `—` while ' +
      'listing real linked services',
    files: {
      'apps/fiab-console/lib/azure/adf-client.ts': L(
        "import { armBase } from '@/lib/azure/cloud-endpoints';",
        'export async function listLinkedServices() {',
        '  return fetch(`${armBase()}/subscriptions/x/providers/Microsoft.DataFactory/factories/f/linkedservices`);',
        '}',
      ),
      'apps/fiab-console/lib/copilot/pipeline-tools.ts': L(
        "import * as adf from '@/lib/azure/adf-client';",
        'export async function handlePipelineListConnections() { return adf.listLinkedServices(); }',
      ),
      [CONTROL_ROUTE]: L(
        "import { handlePipelineListConnections } from '@/lib/copilot/pipeline-tools';",
        'export async function GET() { return json(await handlePipelineListConnections()); }',
      ),
    },
    expect: { has: ['ADF'], hasNot: [], unknown: false },
  },
  {
    name:
      'PROSE INSIDE A STRING is not an endpoint. `lib/mcp/catalog.ts` carries the UI help text "Targets the ' +
      'cloud-specific ARM endpoint (commercial or usgovcloudapi.net)" — comment-stripping cannot help, because ' +
      'it IS a string, and it reached routes as an unrecognised Azure service. THE PROSE HOST HERE IS A ' +
      'LABELLED one on purpose: the first draft of this control quoted only the BARE `usgovcloudapi.net`, which ' +
      'is recorded as a non-backend anyway, so removing the prose filter changed nothing and the mutation ' +
      'survived. A control has to name a host that WOULD publish',
    files: {
      [CONTROL_ROUTE]: L(
        "const DESC = 'Query Azure resources. Targets the cloud-specific ARM endpoint — management.azure.com in " +
          "commercial, or usgovcloudapi.net in Gov — using DefaultAzureCredential.';",
        'export async function GET() { return json({ ok: true, desc: DESC }); }',
      ),
    },
    expect: { has: [], hasNot: ['ARM'], unknown: false },
  },
  // ── UNKNOWN, not a guess ─────────────────────────────────────────────────
  {
    name:
      'B1 — an Azure host this vocabulary has never seen must FAIL naming it, not publish `—`. This is the ' +
      'whole inversion: the DETECTOR is generic, so a new service is seen even when it cannot be labelled',
    files: {
      'apps/fiab-console/lib/azure/brand-new-client.ts': L(
        'export async function ping() { return fetch(`https://${process.env.X}.brandnewservice.azure.com/v1/ping`); }',
      ),
      [CONTROL_ROUTE]: L(
        "import { ping } from '@/lib/azure/brand-new-client';",
        'export async function GET() { return json(await ping()); }',
      ),
    },
    expect: { has: [], hasNot: [], unknown: true },
  },
  {
    name:
      'B2 — a lib/azure client that FETCHES and names no Azure identifier is reported as unnamed rather than ' +
      'silently contributing nothing. This is the shape all four false-document instances had',
    files: {
      'apps/fiab-console/lib/azure/mystery-client.ts': L(
        'const HOST = process.env.LOOM_MYSTERY_HOST;',
        'export async function callIt(p) { return fetch(`https://${HOST}/${p}`); }',
      ),
      [CONTROL_ROUTE]: L(
        "import { callIt } from '@/lib/azure/mystery-client';",
        'export async function GET(req, ctx) { return json(await callIt(ctx.params.id)); }',
      ),
    },
    expect: { has: [], hasNot: [], unknown: false, unnamed: ['apps/fiab-console/lib/azure/mystery-client.ts'] },
  },
];

/** Run every control; returns the failures (empty is good). */
export function selfTest() {
  const failures = [];
  for (const c of CONTROLS) {
    let got;
    try {
      got = analyzeSynthetic(c.files);
    } catch (e) {
      failures.push(`${c.name} — threw ${e.message}`);
      continue;
    }
    for (const b of c.expect.has ?? [])
      if (!got.backends.includes(b)) failures.push(`${c.name} — expected backend "${b}", got [${got.backends.join(', ')}]`);
    for (const b of c.expect.hasNot ?? [])
      if (got.backends.includes(b)) failures.push(`${c.name} — must NOT publish "${b}", got [${got.backends.join(', ')}]`);
    // PARENTHESISED DELIBERATELY. `got.unknowns.length > 0 !== c.expect.unknown`
    // parses as `got.unknowns.length > (0 !== c.expect.unknown)`, i.e.
    // `length > 1` — which is false for the one-unknown case in BOTH directions,
    // so the check could never fire. It shipped that way in this file's first
    // draft and the falsification suite is what found it: mutation 1 survived
    // because the control watching it was arithmetic, not a comparison.
    if (c.expect.unknown !== undefined && (got.unknowns.length > 0) !== c.expect.unknown)
      failures.push(
        `${c.name} — expected unknown=${c.expect.unknown}, got ${got.unknowns.length > 0} ` +
          `(${got.unknowns.map((u) => u.identifier).join(', ') || 'none'})`,
      );
    if (c.expect.unnamed && JSON.stringify(got.unnamed) !== JSON.stringify(c.expect.unnamed))
      failures.push(`${c.name} — expected unnamed=[${c.expect.unnamed.join(', ')}], got [${got.unnamed.join(', ')}]`);
    if (!c.expect.unnamed && got.unnamed.length)
      failures.push(`${c.name} — unexpected unnamed client module(s): [${got.unnamed.join(', ')}]`);
  }
  return failures;
}
