/**
 * Deployable MCP-server catalog (data only).
 *
 * Authoritative list of Microsoft-official, Anthropic-reference, and vetted
 * community Model Context Protocol servers that are safe to offer for CSA Loom
 * Gov/Federal Azure deployments. Sourced from
 * `temp/mcp-gov-research.md` (research date 2026-06-04), which was compiled
 * against the official MCP registry, the Anthropic/Microsoft repos, and
 * Microsoft Learn (azure-mcp-server, container-apps remote-mcp, functions
 * remote-mcp). Keep in sync with that doc; any drift means the doc is stale
 * (re-fetch via microsoft_docs_search) or this file is.
 *
 * Used by:
 *  - the "External MCP Tools" admin panel's "Browse catalog" picker
 *    (lib/components/admin/mcp-servers-panel.tsx) — a categorized Fluent grid,
 *    mirroring the `+ New item` grid driven by lib/catalog/fabric-item-types.ts
 *  - the catalog → register flow, which pre-fills the typed McpServerForm from
 *    a catalog entry's configSchema (never a freeform JSON box —
 *    loom-no-freeform-config)
 *
 * IMPORTANT (no-vaporware / runtime reality): Loom's MCP runtime
 * (lib/azure/mcp-shim.ts → lib/azure/mcp-client.ts) and the admin form/route
 * (app/api/admin/mcp-servers/route.ts → sanitize() requires a valid URL
 * endpoint) only consume **HTTP/JSON-RPC streamable endpoints**. Almost every
 * upstream server here ships as **stdio** (`npx`/`uvx`/docker). A stdio server
 * is therefore NOT directly connectable — it must first be **hosted** to expose
 * an HTTPS endpoint. Per Microsoft Learn:
 *   - Azure Container Apps supports `npx`/`uvx`/any Linux container and exposes
 *     a streamable HTTP endpoint → the correct default host (`hostVia:
 *     'container-apps'`). Host module lives under
 *     platform/fiab/bicep/modules/** (see deploy/main.bicep precedent at
 *     azure-functions/mcp-server/deploy/main.bicep for the Gov armEndpoint
 *     pattern).
 *   - Azure Functions does NOT support `npx` start commands or OS-level deps
 *     like Playwright → only fits the in-repo Python built-in.
 * Consumers MUST honest-gate any `transport: 'stdio'` entry ("deploy to
 * Container Apps to get an HTTPS endpoint, then register") rather than implying
 * it is already connectable.
 *
 * no-fabric-dependency: Azure MCP + Postgres-on-Azure-Database + Kubernetes/AKS
 * are the Azure-native defaults. The two DEPLOYABLE catalogs in this file
 * (MCP_CATALOG / MCP_DEPLOY_CATALOG — "pull an image, host it as a Container
 * App") reference ZERO Fabric / Power BI hosts on the default path. The ONE
 * Power BI entry — REMOTE_BUILTIN_MCP at the bottom of this file — is a separate
 * "remote built-in" family: an already-hosted Microsoft HTTPS Streamable-HTTP
 * endpoint reached with a per-USER Entra OBO bearer, NOT a deployable image. It
 * is strictly OPT-IN (gated on LOOM_POWERBI_MCP_CLIENT_ID + a PBI-admin tenant
 * setting) and is never wired onto a default code path; Loom's Azure-native
 * semantic-model / report authoring stays the day-one default. See
 * REMOTE_BUILTIN_MCP + isPbiMcpConfigured() below.
 */

/** Capability grouping for the catalog picker. */
export type McpCategory =
  | 'Reference'
  | 'Azure'
  | 'Source Control'
  | 'Database'
  | 'Web & Search'
  | 'Browser Automation'
  | 'Observability'
  | 'Productivity'
  | 'Infrastructure'
  // Added for the Microsoft-official MCP servers (github.com/microsoft/mcp):
  | 'Developer' // Azure DevOps, NuGet, MarkItDown
  | 'Analytics'; // Microsoft Fabric family (explicit opt-in)

/** Upstream packaging / launch mechanism. */
export type McpRuntime = 'npx' | 'uvx' | 'pip' | 'docker';

/**
 * Wire transport the server speaks natively.
 *  - 'stdio' ⇒ must be hosted (see hostVia) before it can be registered with Loom.
 *  - 'http'  ⇒ already exposes an HTTPS JSON-RPC endpoint; directly registrable.
 */
export type McpTransport = 'stdio' | 'http';

/** Where a stdio server gets wrapped into an HTTPS endpoint. */
export type McpHostVia = 'container-apps' | 'azure-functions' | 'already-http';

/** Maintainer tier. */
export type McpSource = 'anthropic' | 'microsoft' | 'vendor' | 'community';

/** SPDX-ish license bucket. Gates the gov license audit (no AGPL/SSPL). */
export type McpLicense = 'Apache-2.0' | 'MIT' | 'BSD' | 'Proprietary';

/** Target cloud boundary for the catalog filter. */
export type GovCloud = 'commercial' | 'gcc' | 'gcc-high' | 'il5';

/**
 * One configurable input for a server. Drives a typed Fluent form field, NOT a
 * JSON textarea (loom-no-freeform-config). A `secret: true` field resolves from
 * Azure Key Vault — the register flow sets McpServerConfig.authMethod to
 * 'key-vault' whenever any field is secret.
 */
export interface McpConfigField {
  /** Env var / arg name the host passes through, e.g. 'GITHUB_TOKEN'. */
  key: string;
  /** Human label for the form field. */
  label: string;
  /** How the value is supplied to the server process. */
  kind: 'env' | 'arg' | 'connection-string';
  /** Secret values are stored/resolved via Key Vault, never echoed back. */
  secret: boolean;
  /** Whether the server cannot start without this value. */
  required: boolean;
  /** Optional inline help shown under the field. */
  hint?: string;
}

/** A catalog entry describing a deployable MCP server. */
export interface DeployableMcpServer {
  /** Stable slug id, e.g. 'filesystem', 'azure'. */
  id: string;
  /** Display name for the picker card. */
  name: string;
  /** One-line summary of what the server does. */
  desc: string;
  /** Capability grouping. */
  category: McpCategory;
  /** OCI image reference when runtime is 'docker'; undefined for npx/uvx/pip. */
  image?: string;
  /** Upstream packaging. */
  runtime: McpRuntime;
  /** Package spec passed to the runtime (npm pkg, PyPI/uvx pkg, github: ref). */
  package?: string;
  /** Native transport. 'stdio' ⇒ hostVia required before register. */
  transport: McpTransport;
  /** How a stdio server is hosted to get an HTTPS endpoint. */
  hostVia?: McpHostVia;
  /** Typed config fields ([] for zero-config servers like Time / Everything). */
  configSchema: McpConfigField[];
  /** Maintainer tier. */
  source: McpSource;
  /** Source repository (org/repo). */
  repo: string;
  /** Safe to offer in a US Gov boundary (✅ / "safe for gov" in research). */
  govSafe: boolean;
  /** Runs with NO external internet calls (the 10 self-contained servers). */
  airGapSafe: boolean;
  /** License bucket. */
  license: McpLicense;
  /** Tier-0 / Tier-1 default recommendation for Loom Gov Phase 1. */
  defaultRecommended: boolean;
  /**
   * External SaaS hosts the server reaches. Non-empty ⇒ must route via an
   * approved gov proxy (or be hidden) in gcc/gcc-high/il5. [] = self-contained.
   */
  externalHosts: string[];
  /**
   * Fabric-family flag (additive, optional). When true this server reaches
   * Microsoft Fabric / Power BI hosts and REQUIRES a Fabric capacity — it is an
   * EXPLICIT opt-in only (govSafe:false + defaultRecommended:false), never on a
   * default code path (no-fabric-dependency). Absent/false for every Azure-native
   * default entry.
   */
  fabricFamily?: boolean;
}

/**
 * The catalog. 25 gov-research entries (temp/mcp-gov-research.md) plus Grafana,
 * whose upstream image already ships a streamable-HTTP transport.
 *
 * Almost every entry is `transport: 'stdio'` (no upstream ships a hosted HTTPS
 * endpoint), so it carries `hostVia: 'container-apps'` — consumers must host
 * before registering. The exception is Grafana (`transport: 'http'`,
 * `hostVia: 'already-http'`): it is directly deployable as a Container App and is
 * the one entry whose id overlaps the operational MCP_DEPLOY_CATALOG below. See
 * file header. This array is the AUTHORITATIVE gov-safety metadata source — the
 * operational deploy catalog joins to it by id via `govMetaFor()`.
 */
export const MCP_CATALOG: readonly DeployableMcpServer[] = [
  // ── Tier 0: Anthropic reference, fully air-gap safe ────────────────────────
  {
    id: 'filesystem',
    name: 'Filesystem',
    desc: 'Secure file operations with a configurable directory allowlist.',
    category: 'Reference',
    runtime: 'npx',
    package: '@modelcontextprotocol/server-filesystem',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'ALLOWED_DIRECTORIES',
        label: 'Allowed directories',
        kind: 'arg',
        secret: false,
        required: true,
        hint: 'Comma-separated absolute paths the server may access. Prevents directory traversal.',
      },
    ],
    source: 'anthropic',
    repo: 'modelcontextprotocol/servers',
    govSafe: true,
    airGapSafe: true,
    license: 'Apache-2.0',
    defaultRecommended: true,
    externalHosts: [],
  },
  {
    id: 'git',
    name: 'Git',
    desc: 'Repository reading, searching, and git operations (clone, diff, log, blame).',
    category: 'Source Control',
    runtime: 'uvx',
    package: 'mcp-server-git',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'GIT_REPO_PATH',
        label: 'Repository path',
        kind: 'arg',
        secret: false,
        required: true,
        hint: 'Absolute path to the local git repository to operate on.',
      },
    ],
    source: 'anthropic',
    repo: 'modelcontextprotocol/servers',
    govSafe: true,
    airGapSafe: true,
    license: 'Apache-2.0',
    defaultRecommended: true,
    externalHosts: [],
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    desc: 'Dynamic, reflective problem-solving through structured thought sequences.',
    category: 'Reference',
    runtime: 'npx',
    package: '@modelcontextprotocol/server-sequential-thinking',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [],
    source: 'anthropic',
    repo: 'modelcontextprotocol/servers',
    govSafe: true,
    airGapSafe: true,
    license: 'Apache-2.0',
    defaultRecommended: true,
    externalHosts: [],
  },
  {
    id: 'time',
    name: 'Time',
    desc: 'Time and timezone conversion capabilities. Zero external calls.',
    category: 'Reference',
    runtime: 'uvx',
    package: 'mcp-server-time',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'TZ',
        label: 'Default timezone',
        kind: 'env',
        secret: false,
        required: false,
        hint: 'IANA timezone (e.g. America/New_York). Defaults to the system timezone.',
      },
    ],
    source: 'anthropic',
    repo: 'modelcontextprotocol/servers',
    govSafe: true,
    airGapSafe: true,
    license: 'Apache-2.0',
    defaultRecommended: true,
    externalHosts: [],
  },
  {
    id: 'memory',
    name: 'Memory',
    desc: 'Knowledge-graph-based persistent memory. No network access required.',
    category: 'Reference',
    runtime: 'npx',
    package: '@modelcontextprotocol/server-memory',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'MEMORY_FILE_PATH',
        label: 'Memory file path',
        kind: 'env',
        secret: false,
        required: false,
        hint: 'Optional path to persist the knowledge graph; kept in-memory if unset.',
      },
    ],
    source: 'anthropic',
    repo: 'modelcontextprotocol/servers',
    govSafe: true,
    airGapSafe: true,
    license: 'Apache-2.0',
    defaultRecommended: true,
    externalHosts: [],
  },
  {
    id: 'fetch',
    name: 'Fetch',
    desc: 'Web content fetching and conversion to clean markdown for LLM usage.',
    category: 'Web & Search',
    runtime: 'uvx',
    package: 'mcp-server-fetch',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [],
    source: 'anthropic',
    repo: 'modelcontextprotocol/servers',
    govSafe: true,
    airGapSafe: false,
    license: 'Apache-2.0',
    defaultRecommended: false,
    externalHosts: ['(arbitrary outbound URLs — route via an approved gov proxy)'],
  },
  {
    id: 'everything',
    name: 'Everything',
    desc: 'Reference/test server exercising prompts, resources, and tools.',
    category: 'Reference',
    runtime: 'npx',
    package: '@modelcontextprotocol/server-everything',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [],
    source: 'anthropic',
    repo: 'modelcontextprotocol/servers',
    govSafe: true,
    airGapSafe: true,
    license: 'Apache-2.0',
    defaultRecommended: false,
    externalHosts: [],
  },

  // ── Tier 1: Microsoft-official + Azure-native data planes ──────────────────
  {
    id: 'azure',
    name: 'Azure MCP Server',
    desc: 'Query and manage Azure resources via natural language. Authenticates with Entra ID (DefaultAzureCredential / managed identity) — no API key. Targets the cloud-specific ARM endpoint (commercial or usgovcloudapi.net).',
    category: 'Azure',
    runtime: 'npx',
    package: '@azure/mcp',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [],
    source: 'microsoft',
    repo: 'azure/azure-mcp-server',
    govSafe: true,
    airGapSafe: false,
    license: 'MIT',
    defaultRecommended: true,
    externalHosts: [],
  },
  {
    id: 'playwright',
    name: 'Playwright',
    desc: 'Browser automation, scraping, screenshots, and accessibility testing (22 tools, bundled Chromium). Not Azure-Functions hostable — Container Apps only.',
    category: 'Browser Automation',
    runtime: 'npx',
    package: '@playwright/mcp',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [],
    source: 'microsoft',
    repo: 'microsoft/playwright-mcp',
    govSafe: true,
    airGapSafe: true,
    license: 'Apache-2.0',
    defaultRecommended: true,
    externalHosts: [],
  },
  {
    id: 'postgres',
    name: 'Postgres',
    desc: 'SQL query execution, schema exploration, and data analysis against Azure Database for PostgreSQL over the VNet.',
    category: 'Database',
    runtime: 'npx',
    package: '@modelcontextprotocol/server-postgres',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'POSTGRES_CONNECTION_STRING',
        label: 'PostgreSQL connection string',
        kind: 'connection-string',
        secret: true,
        required: true,
        hint: 'postgresql://user:pass@host:5432/db — target Azure Database for PostgreSQL. Prefer a read-only role.',
      },
    ],
    source: 'anthropic',
    repo: 'modelcontextprotocol/servers',
    govSafe: true,
    airGapSafe: true,
    license: 'Apache-2.0',
    defaultRecommended: true,
    externalHosts: [],
  },
  {
    id: 'kubernetes',
    name: 'Kubernetes',
    desc: 'Cluster operations, pod management, and deployments against AKS (in-cluster or kubeconfig). Internal VNet / air-gap OK.',
    category: 'Infrastructure',
    runtime: 'npx',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'KUBECONFIG',
        label: 'Kubeconfig path',
        kind: 'env',
        secret: false,
        required: false,
        hint: 'Path to a kubeconfig file; omit when running in-cluster with a service account.',
      },
    ],
    source: 'community',
    repo: 'manusa/kubernetes-mcp-server',
    govSafe: true,
    airGapSafe: true,
    license: 'Apache-2.0',
    defaultRecommended: true,
    externalHosts: [],
  },

  // ── Tier 2: conditional / vendor-maintained ────────────────────────────────
  {
    id: 'github',
    name: 'GitHub',
    desc: 'PR management, issue triage, code search, and CI/CD analysis against github.com or GitHub Enterprise.',
    category: 'Source Control',
    image: 'ghcr.io/github/github-mcp-server',
    runtime: 'docker',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'GITHUB_TOKEN',
        label: 'GitHub personal access token',
        kind: 'env',
        secret: true,
        required: true,
        hint: 'PAT for github.com or your GitHub Enterprise host. Stored in Key Vault.',
      },
      {
        key: 'GITHUB_HOST',
        label: 'GitHub Enterprise host',
        kind: 'env',
        secret: false,
        required: false,
        hint: 'Base URL for GHE (e.g. https://ghe.example.gov). Omit for github.com.',
      },
    ],
    source: 'vendor',
    repo: 'github/github-mcp-server',
    govSafe: true,
    airGapSafe: false,
    license: 'Proprietary',
    defaultRecommended: false,
    externalHosts: ['github.com (or your GitHub Enterprise host)'],
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    desc: 'Local SQLite database create/read/write operations. Fully file-based, air-gap safe.',
    category: 'Database',
    runtime: 'npx',
    package: 'github:u1pns/sqlite-mcp',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'SQLITE_DB_PATH',
        label: 'SQLite database path',
        kind: 'env',
        secret: false,
        required: true,
        hint: 'Absolute path to the .sqlite/.db file.',
      },
    ],
    source: 'community',
    repo: 'u1pns/sqlite-mcp',
    govSafe: true,
    airGapSafe: true,
    license: 'MIT',
    defaultRecommended: false,
    externalHosts: [],
  },
  {
    id: 'dbhub',
    name: 'Database (dbhub)',
    desc: 'Multi-database support — Postgres, MySQL, SQL Server, MariaDB, SQLite — via one connection string.',
    category: 'Database',
    runtime: 'npx',
    package: '@bytebase/dbhub',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'DSN',
        label: 'Database connection string',
        kind: 'connection-string',
        secret: true,
        required: true,
        hint: 'DSN for Postgres/MySQL/SQL Server/MariaDB/SQLite. Target Azure Database services over the VNet.',
      },
    ],
    source: 'vendor',
    repo: 'bytebase/dbhub',
    govSafe: true,
    airGapSafe: false,
    license: 'MIT',
    defaultRecommended: false,
    externalHosts: [],
  },
  {
    id: 'context7',
    name: 'Context7',
    desc: 'Version-pinned documentation injection for popular frameworks. Reaches the Upstash CDN (cacheable locally).',
    category: 'Reference',
    runtime: 'npx',
    package: '@upstash/context7-mcp',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'CONTEXT7_API_KEY',
        label: 'Context7 API key',
        kind: 'env',
        secret: true,
        required: false,
        hint: 'Optional API key for higher rate limits (free tier works without one).',
      },
    ],
    source: 'vendor',
    repo: 'upstash/context7',
    govSafe: false,
    airGapSafe: false,
    license: 'MIT',
    defaultRecommended: false,
    externalHosts: ['context7.com (Upstash CDN)'],
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    desc: 'Real-time web search via Brave’s independent index over HTTPS.',
    category: 'Web & Search',
    runtime: 'npx',
    package: '@brave/brave-search-mcp-server',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'BRAVE_API_KEY',
        label: 'Brave Search API key',
        kind: 'env',
        secret: true,
        required: true,
        hint: 'API key from Brave Search. Stored in Key Vault.',
      },
    ],
    source: 'vendor',
    repo: 'brave/brave-search-mcp-server',
    govSafe: true,
    airGapSafe: false,
    license: 'MIT',
    defaultRecommended: false,
    externalHosts: ['api.search.brave.com'],
  },
  {
    id: 'sentry',
    name: 'Sentry',
    desc: 'Error tracking, stack-trace debugging, and issue management. Consider self-hosting Sentry on Azure for gov.',
    category: 'Observability',
    runtime: 'npx',
    package: '@sentry/mcp-server',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'SENTRY_AUTH_TOKEN',
        label: 'Sentry auth token',
        kind: 'env',
        secret: true,
        required: true,
        hint: 'Auth token for your Sentry org. Stored in Key Vault.',
      },
      {
        key: 'SENTRY_HOST',
        label: 'Sentry host',
        kind: 'env',
        secret: false,
        required: false,
        hint: 'Base URL for a self-hosted Sentry; omit for sentry.io.',
      },
    ],
    source: 'community',
    repo: 'getsentry/sentry-mcp',
    govSafe: false,
    airGapSafe: false,
    license: 'MIT',
    defaultRecommended: false,
    externalHosts: ['sentry.io (or your self-hosted Sentry host)'],
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    desc: 'JavaScript-rendering web crawling, batch processing, and content extraction. Enterprise self-host possible.',
    category: 'Web & Search',
    runtime: 'npx',
    package: 'firecrawl-mcp',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'FIRECRAWL_API_KEY',
        label: 'Firecrawl API key',
        kind: 'env',
        secret: true,
        required: true,
        hint: 'API key from Firecrawl. Stored in Key Vault.',
      },
    ],
    source: 'vendor',
    repo: 'firecrawl/firecrawl-mcp',
    govSafe: false,
    airGapSafe: false,
    license: 'Proprietary',
    defaultRecommended: false,
    externalHosts: ['api.firecrawl.dev'],
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    desc: 'Workers deployment, R2/KV/D1, Pages, and email routing. Requires a Cloudflare account; prefer in-Azure equivalents for gov.',
    category: 'Infrastructure',
    runtime: 'npx',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'CLOUDFLARE_API_TOKEN',
        label: 'Cloudflare API token',
        kind: 'env',
        secret: true,
        required: true,
        hint: 'Scoped API token. Stored in Key Vault.',
      },
      {
        key: 'CLOUDFLARE_ACCOUNT_ID',
        label: 'Cloudflare account ID',
        kind: 'env',
        secret: false,
        required: true,
      },
    ],
    source: 'vendor',
    repo: 'cloudflare/mcp-server-cloudflare',
    govSafe: false,
    airGapSafe: false,
    license: 'MIT',
    defaultRecommended: false,
    externalHosts: ['api.cloudflare.com'],
  },
  {
    id: 'linear',
    name: 'Linear',
    desc: 'Issue tracking, sprint management, and project sync. Use only if Linear is approved; GitHub Issues is an in-env alternative.',
    category: 'Productivity',
    runtime: 'npx',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'LINEAR_API_KEY',
        label: 'Linear API key',
        kind: 'env',
        secret: true,
        required: true,
        hint: 'Personal/API key from Linear. Stored in Key Vault.',
      },
    ],
    source: 'community',
    repo: 'linear/linear-mcp-server',
    govSafe: false,
    airGapSafe: false,
    license: 'MIT',
    defaultRecommended: false,
    externalHosts: ['api.linear.app'],
  },
  {
    id: 'slack',
    name: 'Slack',
    desc: 'Messaging, channel management, and bot integration. Use only if Slack is approved; Microsoft Teams is an alternative.',
    category: 'Productivity',
    runtime: 'npx',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'SLACK_BOT_TOKEN',
        label: 'Slack bot token',
        kind: 'env',
        secret: true,
        required: true,
        hint: 'Bot user OAuth token (xoxb-...). Stored in Key Vault.',
      },
      {
        key: 'SLACK_TEAM_ID',
        label: 'Slack workspace (team) ID',
        kind: 'env',
        secret: false,
        required: true,
      },
    ],
    source: 'community',
    repo: 'modelcontextprotocol/servers-archived',
    govSafe: false,
    airGapSafe: false,
    license: 'MIT',
    defaultRecommended: false,
    externalHosts: ['slack.com'],
  },
  {
    id: 'notion',
    name: 'Notion',
    desc: 'Documentation queries, database operations, and page creation. Use only if Notion is approved; an Azure-native doc store is preferred.',
    category: 'Productivity',
    runtime: 'npx',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'NOTION_TOKEN',
        label: 'Notion integration token',
        kind: 'env',
        secret: true,
        required: true,
        hint: 'Internal integration token. Stored in Key Vault.',
      },
    ],
    source: 'community',
    repo: 'makenotion/notion-mcp-server',
    govSafe: false,
    airGapSafe: false,
    license: 'MIT',
    defaultRecommended: false,
    externalHosts: ['api.notion.com'],
  },
  {
    id: 'stripe',
    name: 'Stripe',
    desc: 'Customer, subscription, and payment operations (read-only recommended). Use only if Stripe is in use.',
    category: 'Productivity',
    runtime: 'npx',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'STRIPE_API_KEY',
        label: 'Stripe API key',
        kind: 'env',
        secret: true,
        required: true,
        hint: 'Use a restricted, read-only key. Stored in Key Vault.',
      },
    ],
    source: 'community',
    repo: 'stripe/stripe-mcp',
    govSafe: false,
    airGapSafe: false,
    license: 'MIT',
    defaultRecommended: false,
    externalHosts: ['api.stripe.com'],
  },
  {
    id: 'supabase',
    name: 'Supabase',
    desc: 'Postgres queries via Supabase, auth, and realtime. Prefer the native Postgres MCP against Azure Database for PostgreSQL for gov.',
    category: 'Database',
    runtime: 'npx',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'SUPABASE_URL',
        label: 'Supabase project URL',
        kind: 'env',
        secret: false,
        required: true,
      },
      {
        key: 'SUPABASE_KEY',
        label: 'Supabase API key',
        kind: 'env',
        secret: true,
        required: true,
        hint: 'Service or anon key. Stored in Key Vault.',
      },
    ],
    source: 'vendor',
    repo: 'supabase/supabase-mcp',
    govSafe: false,
    airGapSafe: false,
    license: 'MIT',
    defaultRecommended: false,
    externalHosts: ['*.supabase.co'],
  },
  {
    id: 'jira',
    name: 'Jira',
    desc: 'Issue tracking, agile board operations, and epic/sprint sync. Use only on Jira Cloud/Server; Azure DevOps is an alternative.',
    category: 'Productivity',
    runtime: 'npx',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'JIRA_BASE_URL',
        label: 'Jira base URL',
        kind: 'env',
        secret: false,
        required: true,
        hint: 'e.g. https://your-org.atlassian.net',
      },
      {
        key: 'JIRA_EMAIL',
        label: 'Jira account email',
        kind: 'env',
        secret: false,
        required: true,
      },
      {
        key: 'JIRA_API_TOKEN',
        label: 'Jira API token',
        kind: 'env',
        secret: true,
        required: true,
        hint: 'PAT / API token. Stored in Key Vault.',
      },
    ],
    source: 'community',
    repo: 'sooperset/mcp-atlassian',
    govSafe: false,
    airGapSafe: false,
    license: 'MIT',
    defaultRecommended: false,
    externalHosts: ['*.atlassian.net'],
  },
  {
    id: 'grafana',
    name: 'Grafana',
    desc: 'Query dashboards, datasources, Prometheus/Loki, and incidents against a self-hosted Grafana over the VNet. Self-contained to your Grafana instance.',
    category: 'Observability',
    image: 'mcp/grafana:latest',
    runtime: 'docker',
    transport: 'http',
    hostVia: 'already-http',
    configSchema: [
      {
        key: 'GRAFANA_URL',
        label: 'Grafana URL',
        kind: 'env',
        secret: false,
        required: true,
        hint: 'Base URL of your Grafana instance, e.g. https://grafana.example.gov.',
      },
      {
        key: 'GRAFANA_API_KEY',
        label: 'Grafana service-account token',
        kind: 'env',
        secret: true,
        required: true,
        hint: 'Service-account token with Viewer (or higher). Stored in Key Vault.',
      },
    ],
    source: 'community',
    repo: 'grafana/mcp-grafana',
    govSafe: true,
    airGapSafe: false,
    license: 'Apache-2.0',
    defaultRecommended: false,
    externalHosts: [],
  },

  // ── Tier 1 (cont.): Microsoft-official MCP servers (github.com/microsoft/mcp) ──
  // stdio servers → host on Container Apps for an HTTPS endpoint, then register
  // (requiresHosting()). All Azure-native (no Fabric/Power BI host) on the default
  // path. Azure MCP + Playwright are already listed above — left untouched.
  // Confirmed via microsoft_docs_search (2026-06): Azure MCP (@azure/mcp), Azure
  // DevOps (@azure-devops/mcp), SQL via Data API builder, MarkItDown (markitdown-mcp).
  {
    id: 'microsoft-sql',
    name: 'Microsoft SQL (Data API builder)',
    desc: 'Natural-language → SQL over Azure SQL / SQL Server via the SQL MCP Server shipped in Data API builder (DAB 1.7+/2.0). Typed read/query tools backed by DAB entity RBAC + caching — no fragile NL string parsing. Deploy the DAB image as a Container App with your connection string + entity config, then register the resulting /mcp endpoint.',
    category: 'Database',
    image: 'mcr.microsoft.com/azure-databases/data-api-builder:latest',
    runtime: 'docker',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'DATABASE_CONNECTION_STRING',
        label: 'Azure SQL / SQL Server connection string',
        kind: 'connection-string',
        secret: true,
        required: true,
        hint: 'Target Azure SQL Database or SQL Server over the VNet. Prefer a read-only login. Stored in Key Vault.',
      },
    ],
    source: 'microsoft',
    repo: 'Azure/data-api-builder',
    govSafe: true,
    airGapSafe: true,
    license: 'MIT',
    defaultRecommended: false,
    externalHosts: [],
  },
  {
    id: 'azure-devops',
    name: 'Azure DevOps',
    desc: 'Work items, pull requests, pipelines, repos, and wiki for Azure DevOps Services as Copilot tools. Local server runs via `npx @azure-devops/mcp <org>` (Entra ID / PAT) — host on Container Apps for an HTTPS endpoint. A Microsoft-hosted remote variant (https://mcp.dev.azure.com/<org>, Entra OAuth) also exists for clients that support it.',
    category: 'Developer',
    runtime: 'npx',
    package: '@azure-devops/mcp',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'ADO_ORGANIZATION',
        label: 'Azure DevOps organization',
        kind: 'arg',
        secret: false,
        required: true,
        hint: 'Your Azure DevOps org name (e.g. "contoso"). The org must be connected to Microsoft Entra ID.',
      },
    ],
    source: 'microsoft',
    repo: 'microsoft/azure-devops-mcp',
    govSafe: true,
    airGapSafe: false,
    license: 'MIT',
    defaultRecommended: false,
    externalHosts: ['dev.azure.com'],
  },
  {
    id: 'aks',
    name: 'Azure Kubernetes Service (AKS)',
    desc: 'AKS-aware cluster operations — diagnostics, kubectl, and Azure resource correlation — via the Azure aks-mcp server. No first-party PUBLIC OCI image is published yet, so provide an image reference (build from source per the repo) and deploy it as a Container App.',
    category: 'Infrastructure',
    runtime: 'docker',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'IMAGE_REF',
        label: 'Container image reference',
        kind: 'arg',
        secret: false,
        required: true,
        hint: 'No first-party public image yet. Build aks-mcp from source (Azure/aks-mcp), push to your ACR, and set the image ref here.',
      },
    ],
    source: 'microsoft',
    repo: 'Azure/aks-mcp',
    govSafe: true,
    airGapSafe: false,
    license: 'MIT',
    defaultRecommended: false,
    externalHosts: [],
  },
  {
    id: 'markitdown',
    name: 'MarkItDown',
    desc: 'Convert PDFs, Office documents, images, audio, and HTML to clean Markdown for LLM grounding via the markitdown-mcp server. Runs fully locally (no external calls) — host on Container Apps for an HTTPS endpoint.',
    category: 'Developer',
    runtime: 'uvx',
    package: 'markitdown-mcp',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [],
    source: 'microsoft',
    repo: 'microsoft/markitdown',
    govSafe: true,
    airGapSafe: true,
    license: 'MIT',
    defaultRecommended: false,
    externalHosts: [],
  },
  {
    id: 'nuget',
    name: 'NuGet',
    desc: 'Query NuGet package metadata, versions, and dependencies as Copilot tools (NuGet MCP server, run via `dnx`). No first-party PUBLIC OCI image is published yet, so provide an image reference and deploy it as a Container App. Reaches the configured NuGet feed (api.nuget.org by default).',
    category: 'Developer',
    runtime: 'docker',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'IMAGE_REF',
        label: 'Container image reference',
        kind: 'arg',
        secret: false,
        required: true,
        hint: 'No first-party public image yet. Package the NuGet MCP server into an image, push to your ACR, and set the image ref here.',
      },
    ],
    source: 'microsoft',
    repo: 'microsoft/mcp',
    govSafe: true,
    airGapSafe: false,
    license: 'MIT',
    defaultRecommended: false,
    externalHosts: ['api.nuget.org'],
  },

  // ── Fabric family — EXPLICIT opt-in ONLY (no-fabric-dependency) ───────────────
  // These reach api.fabric.microsoft.com and REQUIRE a Microsoft Fabric capacity.
  // govSafe:false + defaultRecommended:false + fabricFamily:true ⇒ filtered out of
  // gov boundaries, never auto-deployed, never on any default code path. Loom's
  // Azure-native analytics (ADX / Synapse / Data API builder) stays the day-one
  // default; these only augment it when an admin explicitly browses + deploys them.
  {
    id: 'fabric',
    name: 'Microsoft Fabric (Core)',
    desc: 'OPT-IN Fabric-family server. Workspace / item / permission / capacity operations against Microsoft Fabric. The Core server is Microsoft-hosted at https://api.fabric.microsoft.com/v1/mcp/core (Entra OAuth); the local server (microsoft/mcp → Fabric.Mcp.Server) has no first-party public image. REQUIRES a Fabric capacity — NOT gov-safe, never on a default path.',
    category: 'Analytics',
    runtime: 'docker',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'IMAGE_REF',
        label: 'Container image reference',
        kind: 'arg',
        secret: false,
        required: true,
        hint: 'No first-party public image. Build Fabric.Mcp.Server from source (microsoft/mcp), push to your ACR, and set the image ref — or point a remote MCP client at the Microsoft-hosted Core endpoint.',
      },
    ],
    source: 'microsoft',
    repo: 'microsoft/mcp',
    govSafe: false,
    airGapSafe: false,
    license: 'MIT',
    defaultRecommended: false,
    externalHosts: ['api.fabric.microsoft.com'],
    fabricFamily: true,
  },
  {
    id: 'fabric-rti',
    name: 'Microsoft Fabric RTI (Real-Time Intelligence)',
    desc: 'OPT-IN Fabric-family server. Eventhouse (NL→KQL) and Activator (rules / alerts) operations against Fabric Real-Time Intelligence, Microsoft-hosted under https://api.fabric.microsoft.com/v1/mcp. REQUIRES a Fabric capacity — NOT gov-safe, never on a default path. Loom\'s Azure-native equivalent is Azure Data Explorer (ADX) + Azure Monitor alerts.',
    category: 'Analytics',
    runtime: 'docker',
    transport: 'stdio',
    hostVia: 'container-apps',
    configSchema: [
      {
        key: 'IMAGE_REF',
        label: 'Container image reference',
        kind: 'arg',
        secret: false,
        required: true,
        hint: 'No first-party public image. Package the Fabric RTI MCP server into an image and set the ref — or point a remote MCP client at the Microsoft-hosted remote endpoint.',
      },
    ],
    source: 'microsoft',
    repo: 'microsoft/mcp',
    govSafe: false,
    airGapSafe: false,
    license: 'MIT',
    defaultRecommended: false,
    externalHosts: ['api.fabric.microsoft.com'],
    fabricFamily: true,
  },
];

// ── Selectors ────────────────────────────────────────────────────────────────

/** Look up a single catalog entry by id. */
export function getMcpServer(id: string): DeployableMcpServer | undefined {
  return MCP_CATALOG.find((s) => s.id === id);
}

/** Tier-0 / Tier-1 servers recommended by default for a Loom Gov Phase 1 deploy. */
export function defaultRecommendedServers(): DeployableMcpServer[] {
  return MCP_CATALOG.filter((s) => s.defaultRecommended);
}

/** Servers that run with no external internet calls (air-gap safe). */
export function airGapSafeServers(): DeployableMcpServer[] {
  return MCP_CATALOG.filter((s) => s.airGapSafe);
}

/** Group the catalog by category for a sectioned picker grid. */
export function serversByCategory(): Record<McpCategory, DeployableMcpServer[]> {
  const out = {} as Record<McpCategory, DeployableMcpServer[]>;
  for (const s of MCP_CATALOG) {
    (out[s.category] ??= []).push(s);
  }
  return out;
}

/**
 * Filter the catalog to the servers allowable in a given cloud boundary.
 *  - commercial: everything
 *  - gcc / gcc-high: gov-safe servers (SaaS ones still carry externalHosts and
 *    must be proxied/approved by the consumer)
 *  - il5: restrict to air-gap-safe servers plus the Azure-native data planes
 *    (Azure MCP, Postgres on Azure Database, Kubernetes/AKS)
 */
export function serversForCloud(cloud: GovCloud): DeployableMcpServer[] {
  switch (cloud) {
    case 'commercial':
      return [...MCP_CATALOG];
    case 'gcc':
    case 'gcc-high':
      return MCP_CATALOG.filter((s) => s.govSafe);
    case 'il5': {
      const il5Allow = new Set(['azure', 'postgres', 'kubernetes']);
      return MCP_CATALOG.filter((s) => s.airGapSafe || il5Allow.has(s.id));
    }
    default:
      return [...MCP_CATALOG];
  }
}

/**
 * True when a server cannot be registered with Loom as-is and must first be
 * hosted (stdio → HTTPS). Consumers use this to drive the honest "deploy to
 * Container Apps first" gate instead of a direct register button.
 */
export function requiresHosting(server: DeployableMcpServer): boolean {
  return server.transport === 'stdio';
}

/** The secret config fields for a server (drive Key Vault-backed form inputs). */
export function secretFields(server: DeployableMcpServer): McpConfigField[] {
  return server.configSchema.filter((f) => f.secret);
}

/**
 * True when registering this server must use authMethod 'key-vault' (it has at
 * least one secret field). Maps a catalog entry onto McpServerConfig.authMethod.
 */
export function requiresKeyVault(server: DeployableMcpServer): boolean {
  return server.configSchema.some((f) => f.secret);
}

/**
 * MCP server catalog — the curated library of deployable Model Context Protocol
 * servers a tenant admin browses in Admin → Tenant settings → External MCP Tools.
 *
 * WHAT THIS IS
 * ------------
 * Each entry describes a REAL, publicly-distributed container image that exposes
 * an MCP tool surface over an HTTP/SSE transport, plus a per-server `configSchema`
 * (one typed field per setting the server needs). The deploy wizard renders one
 * Fluent control per field; the deploy route provisions the image as an internal
 * Azure Container App, wiring:
 *   - `secret: true` fields  → Azure Key Vault secrets (per-field), surfaced to the
 *     container as a `secretRef` env var. The value NEVER lands in Cosmos.
 *   - everything else        → plain Container App env vars.
 * then registers the resulting internal endpoint in the `mcp-servers` Cosmos
 * container so the Copilot orchestrator discovers its tools automatically — zero
 * further user config (per the task goal).
 *
 * NO-VAPORWARE / NO-FABRIC
 * ------------------------
 * Only servers with a real image + a real transport are listed. Entries whose
 * HTTP transport is community-maintained or still being validated are tagged
 * `preview: true` so the catalog never presents a tile that silently can't work
 * (see .claude/rules/no-vaporware.md). Everything here is Azure-native — Container
 * Apps + Key Vault + Cosmos — with no Microsoft Fabric / Power BI dependency.
 */

/** A single typed configuration field for a catalog entry. */
export interface McpDeployConfigField {
  /** Stable key (used in configValues / secretRefs maps). */
  key: string;
  /** Human label shown in the wizard. */
  label: string;
  /** Control type → Fluent control: string/number→Input, bool→Switch, enum→Dropdown. */
  type: 'string' | 'number' | 'bool' | 'enum';
  /** Required to deploy (wizard blocks until provided). */
  required?: boolean;
  /**
   * Secret flag (THE per-field secret flag). When true the value is written to
   * Key Vault and surfaced to the container as a secretRef env var; never stored
   * in Cosmos. When false/absent the value is a plain Container App env var.
   */
  secret?: boolean;
  /** Default value (non-secret only). */
  default?: string;
  /** Inline help text. */
  help?: string;
  /** Allowed values for type:'enum'. */
  options?: string[];
  /** Container env var name this field maps to. */
  envVar: string;
}

/**
 * Egress profile for the catalog grid badge + the pre-deploy SaaS warning.
 *  - 'air-gap-safe'  : zero external calls (self-contained).
 *  - 'azure-internal': talks only to Azure resources over the VNet.
 *  - 'external-saas' : reaches an external SaaS API → must be proxied/approved
 *    on gcc/gcc-high/il5 boundaries.
 */
export type McpEgressProfile = 'air-gap-safe' | 'azure-internal' | 'external-saas';

/** SPDX-ish license bucket surfaced on the catalog card. */
export type McpDeployLicense = 'Apache-2.0' | 'MIT' | 'BSD' | 'Proprietary';

/** A deployable MCP server in the catalog. */
export interface McpCatalogEntry {
  /** Stable id (used as the deploy/catalog key). */
  id: string;
  /** Display name. */
  name: string;
  /** One-line description. */
  description: string;
  /** Category for grouping in the browse grid. */
  category: 'developer' | 'observability' | 'data' | 'productivity' | 'reference';
  /** Real, pullable container image reference (registry/repo:tag). */
  image: string;
  /**
   * Governance metadata (sourced from temp/mcp-gov-research.md). Drives the
   * catalog grid badges + the per-cloud filter (serversForCloud) + the
   * pre-deploy external-SaaS warning. All optional with safe defaults so older
   * entries keep working: license defaults to the upstream's, egress defaults to
   * 'azure-internal', govSafe/airGapSafe default conservatively.
   */
  /** Egress profile → grid badge + SaaS warning. */
  egress?: McpEgressProfile;
  /** License bucket shown on the card. */
  license?: McpDeployLicense;
  /** Maintainer tier shown on the card (anthropic / microsoft / vendor / community). */
  maintainer?: 'anthropic' | 'microsoft' | 'vendor' | 'community';
  /** Safe to offer inside a US-Gov boundary (gcc / gcc-high). */
  govSafe?: boolean;
  /** Runs with NO external internet calls (air-gap safe). */
  airGapSafe?: boolean;
  /** External SaaS hosts this server reaches (drives the pre-deploy warning). */
  externalHosts?: string[];
  /** Transport the server speaks. Loom registers an HTTP(S) endpoint. */
  transport: 'http' | 'sse';
  /** Ingress target port the server listens on inside the container. */
  ingressPort: number;
  /**
   * Path appended to the internal FQDN to form the MCP endpoint Loom registers
   * (e.g. '/mcp' → https://<app>.<caeDomain>/mcp). The MCP client speaks
   * Streamable HTTP: it POSTs JSON-RPC (initialize / tools/list / tools/call)
   * directly to THIS endpoint — there are no `/tools/list` sub-paths.
   */
  mcpPath: string;
  /** Optional container entrypoint override (argv[0]). */
  command?: string[];
  /** Optional container args (e.g. to select the HTTP transport). */
  args?: string[];
  /** Health probe path (optional). */
  healthPath?: string;
  /** Per-field config schema (drives the wizard + secret routing). */
  configSchema: McpDeployConfigField[];
  /** Preview = real image, but HTTP transport is community/needs-validation. */
  preview?: boolean;
  /** Docs / source link. */
  docsUrl?: string;
}

/**
 * The curated catalog. Keep entries REAL — a tile here must map to a pullable
 * image with a working HTTP/SSE transport. Tag `preview` when the transport is
 * community-maintained rather than first-party.
 */
export const MCP_DEPLOY_CATALOG: McpCatalogEntry[] = [
  {
    id: 'github',
    name: 'GitHub',
    description:
      'Official GitHub MCP server — repositories, issues, pull requests, Actions, ' +
      'and code search as Copilot tools. Runs in streamable-HTTP mode.',
    category: 'developer',
    image: 'ghcr.io/github/github-mcp-server:latest',
    transport: 'http',
    ingressPort: 8080,
    mcpPath: '/mcp',
    command: ['./github-mcp-server', 'http', '--host', '0.0.0.0', '--port', '8080'],
    healthPath: '/healthz',
    docsUrl: 'https://github.com/github/github-mcp-server',
    egress: 'external-saas',
    license: 'MIT',
    maintainer: 'vendor',
    govSafe: true,
    airGapSafe: false,
    externalHosts: ['github.com (or your GitHub Enterprise host)'],
    configSchema: [
      {
        key: 'pat',
        label: 'GitHub personal access token',
        type: 'string',
        required: true,
        secret: true,
        envVar: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        help: 'Fine-grained PAT with the scopes the tools need (repo, issues, actions). Stored in Key Vault.',
      },
      {
        key: 'toolsets',
        label: 'Enabled toolsets',
        type: 'enum',
        options: ['all', 'repos', 'issues', 'pull_requests', 'actions', 'code_security'],
        default: 'all',
        envVar: 'GITHUB_TOOLSETS',
        help: 'Which GitHub toolset group to expose. "all" enables every read/write tool group.',
      },
      {
        key: 'readonly',
        label: 'Read-only mode',
        type: 'bool',
        default: 'true',
        envVar: 'GITHUB_READ_ONLY',
        help: 'When on, only read tools are exposed (no write/merge/dispatch).',
      },
      {
        key: 'host',
        label: 'GitHub Enterprise host (optional)',
        type: 'string',
        envVar: 'GITHUB_HOST',
        help: 'For GitHub Enterprise Server, e.g. https://github.example.com. Leave blank for github.com.',
      },
    ],
  },
  {
    id: 'grafana',
    name: 'Grafana',
    description:
      'Grafana MCP server — query dashboards, datasources, Prometheus/Loki, and ' +
      'incidents as Copilot tools. Runs in streamable-HTTP mode.',
    category: 'observability',
    image: 'mcp/grafana:latest',
    transport: 'http',
    ingressPort: 8000,
    mcpPath: '/mcp',
    args: ['--transport', 'streamable-http', '--address', '0.0.0.0:8000'],
    healthPath: '/healthz',
    docsUrl: 'https://github.com/grafana/mcp-grafana',
    egress: 'azure-internal',
    license: 'Apache-2.0',
    maintainer: 'vendor',
    govSafe: true,
    airGapSafe: false,
    externalHosts: ['(your Grafana instance — typically internal/Azure-hosted)'],
    configSchema: [
      {
        key: 'url',
        label: 'Grafana URL',
        type: 'string',
        required: true,
        envVar: 'GRAFANA_URL',
        help: 'Base URL of your Grafana instance, e.g. https://grafana.example.com.',
      },
      {
        key: 'apiKey',
        label: 'Grafana service-account token',
        type: 'string',
        required: true,
        secret: true,
        envVar: 'GRAFANA_API_KEY',
        help: 'Service-account token with Viewer (or higher). Stored in Key Vault.',
      },
    ],
  },
  {
    id: 'fetch',
    name: 'Web Fetch',
    description:
      'Reference MCP "fetch" server — retrieves a URL and converts the page to ' +
      'markdown for grounding. No credentials required.',
    category: 'reference',
    image: 'mcp/fetch:latest',
    transport: 'sse',
    ingressPort: 8000,
    mcpPath: '/sse',
    args: ['--transport', 'sse'],
    preview: true,
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    egress: 'external-saas',
    license: 'MIT',
    maintainer: 'anthropic',
    govSafe: true,
    airGapSafe: false,
    externalHosts: ['(arbitrary outbound URLs — route via an approved gov proxy)'],
    configSchema: [
      {
        key: 'userAgent',
        label: 'Custom User-Agent (optional)',
        type: 'string',
        envVar: 'FETCH_USER_AGENT',
        help: 'Override the User-Agent header used for outbound fetches.',
      },
      {
        key: 'ignoreRobots',
        label: 'Ignore robots.txt',
        type: 'bool',
        default: 'false',
        envVar: 'FETCH_IGNORE_ROBOTS_TXT',
        help: 'When on, fetches ignore robots.txt restrictions.',
      },
    ],
  },
  {
    id: 'time',
    name: 'Time & Timezones',
    description:
      'Reference MCP "time" server — current time, timezone conversion, and date ' +
      'math as tools. No credentials required.',
    category: 'reference',
    image: 'mcp/time:latest',
    transport: 'sse',
    ingressPort: 8000,
    mcpPath: '/sse',
    args: ['--transport', 'sse'],
    preview: true,
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
    egress: 'air-gap-safe',
    license: 'MIT',
    maintainer: 'anthropic',
    govSafe: true,
    airGapSafe: true,
    externalHosts: [],
    configSchema: [
      {
        key: 'localTimezone',
        label: 'Local timezone (optional)',
        type: 'string',
        envVar: 'LOCAL_TIMEZONE',
        help: 'IANA timezone (e.g. America/New_York) used as the default for "now".',
      },
    ],
  },
];

/** Lookup a catalog entry by id. */
export function getCatalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_DEPLOY_CATALOG.find((e) => e.id === id);
}

/**
 * Validate + coerce a wizard's field values against an entry's configSchema.
 * Returns the typed value map (strings — Container App env values are strings)
 * or throws with a precise message naming the first invalid field. Pure — no
 * Azure SDK — so it is unit-testable.
 */
export function validateConfigValues(
  entry: McpCatalogEntry,
  input: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of entry.configSchema) {
    const raw = input?.[f.key];
    const has = raw !== undefined && raw !== null && String(raw).trim() !== '';
    if (!has) {
      if (f.required) throw new Error(`Field "${f.label}" is required.`);
      if (f.default !== undefined) out[f.key] = f.default;
      continue;
    }
    const v = String(raw).trim();
    if (f.type === 'number' && Number.isNaN(Number(v))) {
      throw new Error(`Field "${f.label}" must be a number.`);
    }
    if (f.type === 'bool' && v !== 'true' && v !== 'false') {
      throw new Error(`Field "${f.label}" must be true or false.`);
    }
    if (f.type === 'enum' && f.options && !f.options.includes(v)) {
      throw new Error(`Field "${f.label}" must be one of: ${f.options.join(', ')}.`);
    }
    out[f.key] = v;
  }
  return out;
}

/** Resolved egress profile for an entry (defaults to 'azure-internal'). */
export function entryEgress(entry: McpCatalogEntry): McpEgressProfile {
  return entry.egress ?? 'azure-internal';
}

/** True when deploying this entry should warn about external-SaaS egress. */
export function reachesExternalSaas(entry: McpCatalogEntry): boolean {
  return entryEgress(entry) === 'external-saas';
}

/**
 * Filter the deploy catalog to the entries allowable in a given cloud boundary.
 *  - commercial: everything.
 *  - gcc / gcc-high: gov-safe entries only (SaaS ones still carry the warning).
 *  - il5: air-gap-safe entries only (no external egress permitted).
 * Entries with no govSafe/airGapSafe metadata are treated conservatively
 * (govSafe defaults false → hidden on gov; airGapSafe defaults false → hidden on il5).
 *
 * Named distinctly from `serversForCloud` (which filters the legacy
 * DeployableMcpServer / MCP_CATALOG list) to avoid a duplicate export.
 */
export function deployServersForCloud(
  cloud: 'commercial' | 'gcc' | 'gcc-high' | 'il5',
): McpCatalogEntry[] {
  switch (cloud) {
    case 'commercial':
      return [...MCP_DEPLOY_CATALOG];
    case 'gcc':
    case 'gcc-high':
      return MCP_DEPLOY_CATALOG.filter((e) => e.govSafe === true);
    case 'il5':
      return MCP_DEPLOY_CATALOG.filter((e) => e.airGapSafe === true);
    default:
      return [...MCP_DEPLOY_CATALOG];
  }
}

// ── Bridge: operational catalog ⇄ gov-safety metadata ─────────────────────────
//
// MCP_DEPLOY_CATALOG (above) is the OPERATIONAL catalog — the deployable subset
// with real, pullable HTTP/SSE images that the browse-and-deploy wizard renders
// and the deploy route provisions. MCP_CATALOG (the DeployableMcpServer array at
// the top of this file) is the AUTHORITATIVE gov-safety metadata source compiled
// from temp/mcp-gov-research.md (govSafe / airGapSafe / license / source /
// defaultRecommended). The two are joined by `id` so a deployable tile can show
// its real gov-safety posture without duplicating that data here.

/** The gov-safety facet of a catalog server, projected from MCP_CATALOG. */
export interface McpGovMeta {
  /** Safe to offer inside a US Gov boundary. */
  govSafe: boolean;
  /** Runs with NO external internet calls. */
  airGapSafe: boolean;
  /** License bucket (gates the no-AGPL/SSPL gov audit). */
  license: McpLicense;
  /** Maintainer tier. */
  source: McpSource;
  /** Tier-0 / Tier-1 default recommendation for Loom Gov Phase 1. */
  defaultRecommended: boolean;
  /**
   * External SaaS hosts the server reaches ([] = self-contained). Non-empty ⇒
   * must be proxied/approved in gcc/gcc-high/il5.
   */
  externalHosts: string[];
}

/**
 * Gov-safety metadata for a server id, looked up from the authoritative
 * MCP_CATALOG (research-grounded). Returns undefined when the operational entry
 * has no research-doc provenance yet — callers must treat "unknown" honestly
 * (show no gov badge) rather than assume gov-safe (no-vaporware).
 */
export function govMetaFor(id: string): McpGovMeta | undefined {
  const s = MCP_CATALOG.find((e) => e.id === id);
  if (!s) return undefined;
  return {
    govSafe: s.govSafe,
    airGapSafe: s.airGapSafe,
    license: s.license,
    source: s.source,
    defaultRecommended: s.defaultRecommended,
    externalHosts: s.externalHosts,
  };
}

/**
 * The operational catalog joined to its gov-safety metadata. Each row is a
 * deployable entry plus the (optional) gov facet from MCP_CATALOG — what the
 * browse grid needs to render a tile with an honest Air-gap/Gov-safe/license
 * posture. `gov` is undefined for any deployable server without research-doc
 * provenance.
 */
export function deployCatalogWithGovMeta(): Array<{ entry: McpCatalogEntry; gov: McpGovMeta | undefined }> {
  return MCP_DEPLOY_CATALOG.map((entry) => ({ entry, gov: govMetaFor(entry.id) }));
}

// ── Remote built-in MCP (opt-in) — Power BI remote MCP server ─────────────────
//
// A THIRD catalog family, distinct from BOTH arrays above. The Power BI remote
// MCP server is NOT a deployable image (you do not pull an OCI image and host it
// as a Container App). It is an ALREADY-HOSTED remote HTTPS Streamable-HTTP
// endpoint that Microsoft operates, reached with a per-USER Microsoft Entra ID
// OAuth On-Behalf-Of bearer — delegated, running under the signed-in user's
// Power BI RBAC. Its tools are schema-aware QUERY of Power BI semantic models
// plus Copilot-powered DAX generation (read-only).
//
// WHY IT IS NOT IN MCP_DEPLOY_CATALOG: that catalog's contract is "pull image →
// deploy as a Container App → register the resulting internal endpoint". This
// server has no image to host and no static credential — it carries per-user
// delegated auth. So it extends the EXISTING External-MCP "built-in/connect"
// family as a new `source: 'remote-builtin'` instead of duplicating the deploy
// pipeline. The register flow turns this descriptor into an McpServerConfig row
// with authMethod 'entra-obo' (oboResource = resource, oboScopes =
// delegatedScopes); buildMcpShim then advertises its tools as
// `mcp_powerbiremote_*`, threading the per-user token resolved from the Cosmos
// pbi-user-token-store (mirroring sql-user-token-store) as the `userToken` arg.
//
// no-fabric-dependency: this is the SOLE Power BI / Fabric host in this file and
// it is STRICTLY OPT-IN. It is reachable ONLY when a tenant admin has (a) set
// LOOM_POWERBI_MCP_CLIENT_ID to an Entra app registration that requests the
// three delegated Power BI scopes, and (b) enabled the Power BI admin-portal
// tenant setting named in `tenantSetting`. Absent either, isPbiMcpConfigured()
// is false and the consumer renders an honest Fluent MessageBar gate (naming the
// env var + the tenant setting + the Entra app reg) — never a silent failure,
// never a default-path call to api.fabric.microsoft.com. Loom's Azure-native
// semantic-model / report authoring (the dax-tools / report-tools /
// tabular-read-tool surface) remains the day-one DEFAULT; this endpoint only
// augments it when explicitly connected.
//
// no-vaporware: when configured, the MCP runtime makes a REAL Streamable-HTTP
// JSON-RPC call to `endpoint` with `Authorization: Bearer <user OBO token>`.
// That token is minted at login via acquireTokenSilent against the scope URIs
// from pbiMcpScopeUris() (`${resource}/<scope>`), cached per-user, and refreshed
// on demand — no mock array, no stored secret (the token never lands in
// McpServerConfig or this file).

/**
 * Descriptor for the Power BI remote MCP server. Unlike DeployableMcpServer /
 * McpCatalogEntry (both "pull an image, host it"), this is an already-hosted
 * remote endpoint with per-user Entra OBO auth. Field literal types pin the
 * shared contract the sibling files (mcp-config, mcp-client, pbi-user-token-store,
 * auth/callback) read.
 */
export interface RemoteBuiltinMcp {
  /** Stable slug id. */
  id: 'powerbi-remote';
  /** Display name for the picker card. */
  name: 'Power BI (remote)';
  /** Category label — its own family, intentionally NOT an McpCategory member. */
  category: 'Power BI / Fabric';
  /** Resolved HTTPS endpoint (LOOM_POWERBI_MCP_ENDPOINT override, else defaultEndpoint). */
  endpoint: string;
  /** Native transport — already exposes a Streamable-HTTP JSON-RPC endpoint. */
  transport: 'http';
  /** Per-user Microsoft Entra ID OAuth On-Behalf-Of bearer (delegated). */
  auth: 'entra-obo';
  /** OBO resource (audience) the delegated scopes belong to. */
  resource: 'https://analysis.windows.net/powerbi/api';
  /** The three read-only delegated Power BI scopes (without the resource prefix). */
  delegatedScopes: ['Dataset.Read.All', 'MLModel.Execute.All', 'Workspace.Read.All'];
  /** Env var holding the Entra app (client) id that requests the scopes. Presence ⇒ opted-in. */
  clientIdEnv: 'LOOM_POWERBI_MCP_CLIENT_ID';
  /** Env var that overrides the endpoint. */
  endpointEnv: 'LOOM_POWERBI_MCP_ENDPOINT';
  /** Endpoint used when endpointEnv is unset. */
  defaultEndpoint: 'https://api.fabric.microsoft.com/v1/mcp/powerbi';
  /** The Power BI admin-portal tenant setting a PBI admin must enable. */
  tenantSetting: 'Users can use the Power BI Model Context Protocol server endpoint (preview)';
  /** Preview feature → catalog "Preview" badge. */
  preview: true;
  /** Opt-in only — never wired onto a default code path. */
  optIn: true;
}

/** Default Power BI remote MCP endpoint (Microsoft-hosted) used when the env override is unset. */
export const POWERBI_MCP_DEFAULT_ENDPOINT =
  'https://api.fabric.microsoft.com/v1/mcp/powerbi' as const;

/**
 * The Power BI remote MCP catalog entry (opt-in). `endpoint` resolves from
 * LOOM_POWERBI_MCP_ENDPOINT, falling back to the Microsoft-hosted default. This
 * descriptor is inert until isPbiMcpConfigured() is true — it never triggers a
 * Fabric/Power BI call on its own.
 */
export const REMOTE_BUILTIN_MCP: RemoteBuiltinMcp = {
  id: 'powerbi-remote',
  name: 'Power BI (remote)',
  category: 'Power BI / Fabric',
  endpoint: process.env.LOOM_POWERBI_MCP_ENDPOINT?.trim() || POWERBI_MCP_DEFAULT_ENDPOINT,
  transport: 'http',
  auth: 'entra-obo',
  resource: 'https://analysis.windows.net/powerbi/api',
  delegatedScopes: ['Dataset.Read.All', 'MLModel.Execute.All', 'Workspace.Read.All'],
  clientIdEnv: 'LOOM_POWERBI_MCP_CLIENT_ID',
  endpointEnv: 'LOOM_POWERBI_MCP_ENDPOINT',
  defaultEndpoint: POWERBI_MCP_DEFAULT_ENDPOINT,
  tenantSetting: 'Users can use the Power BI Model Context Protocol server endpoint (preview)',
  preview: true,
  optIn: true,
};

/**
 * True when the Power BI remote MCP server has been OPTED INTO — i.e. an Entra
 * app (client) id is configured via LOOM_POWERBI_MCP_CLIENT_ID. When false, the
 * Power BI MCP is NOT registered or called on ANY path (no-fabric-dependency);
 * consumers must render the honest MessageBar gate naming the env var + the
 * tenant setting + the Entra app reg (no-vaporware).
 *
 * NOTE: the PBI-admin tenant setting (REMOTE_BUILTIN_MCP.tenantSetting) is a
 * runtime grant that cannot be probed from here — surface it in the gate copy
 * alongside this flag, and let the first real Streamable-HTTP call report a 403
 * if the setting is still off.
 */
export function isPbiMcpConfigured(): boolean {
  return !!process.env.LOOM_POWERBI_MCP_CLIENT_ID?.trim();
}

/**
 * The three delegated Power BI scopes as fully-qualified scope URIs
 * (`${resource}/${scope}`) — exactly what acquireTokenSilent / the OBO exchange
 * requests when minting the per-user Power BI token at login. Single-sources the
 * scope list so the token store and MCP client never hard-code it.
 */
export function pbiMcpScopeUris(): string[] {
  return REMOTE_BUILTIN_MCP.delegatedScopes.map(
    (scope) => `${REMOTE_BUILTIN_MCP.resource}/${scope}`,
  );
}

// ── Generalized remote built-in MCP catalog — Microsoft MCP servers ───────────
//
// This GENERALIZES the Power BI remote-builtin pattern above (RemoteBuiltinMcp +
// isPbiMcpConfigured) to the broader set of Microsoft-operated, already-hosted
// HTTPS Streamable-HTTP MCP servers (github.com/microsoft/mcp + Microsoft Learn /
// Graph / Foundry / Sentinel / Azure DevOps / GitHub). It is NOT a parallel
// system: every entry registers as the SAME McpServerConfig shape the Power BI
// path uses (source 'remote-builtin', authMethod 'header' for no-auth, 'entra-obo'
// for delegated, 'key-vault' for a stored PAT), is reached by the SAME mcp-client
// (resolveAuthHeader + threaded userToken), and is advertised by the SAME
// buildMcpShim as `mcp_<slug>_<tool>`. Only the per-server token lookup
// (keyed by oboResource) and the honest gate copy differ.
//
// no-fabric-dependency: Microsoft Learn (auth 'none') is the SOLE default-on
// entry — it has zero Fabric/Power BI dependency and zero config. EVERY other
// entry is opt-in: an entra-obo server stays inert until its enableEnv toggle is
// 'true' AND the shared Loom confidential client (LOOM_MSAL_CLIENT_ID) is present;
// GitHub stays inert until its Key Vault PAT secret name is set. No api.fabric /
// api.powerbi host appears on any default path — the Power BI entry projected in
// below is gated exactly as before (isPbiMcpConfigured()).
//
// no-vaporware: each entry carries a REAL endpoint (confirmed via
// microsoft_docs_search 2026-06 where a GA/preview host exists) or, where the
// host is not yet GA, an EMPTY defaultEndpoint + a required endpointEnv so the
// server can never be reached until an admin supplies the published endpoint.
// `gate` names the exact env var / Key Vault secret / tenant setting / consent
// the consumer's Fluent MessageBar must surface when configured() is false.
// OBO servers carry NO static secret (the per-user token never lands here).

/**
 * A generalized remote built-in MCP server descriptor — broader and string-typed
 * (vs. the literal-typed Power BI `RemoteBuiltinMcp`) so one shape covers Learn
 * (no auth), the Entra-OBO servers (ARM/Foundry/Graph/M365/Teams/OneDrive-
 * SharePoint/Sentinel/Admin-Center/Dataverse), and GitHub (Key Vault PAT). Every
 * entry is an already-hosted HTTPS Streamable-HTTP endpoint — NOT a deployable
 * image — reached per-user; it maps onto McpServerConfig with source
 * 'remote-builtin'.
 */
export interface RemoteBuiltinMcpEntry {
  /** Stable slug id (also the buildMcpShim tool-prefix seed). */
  id: string;
  /** Display name for the picker card. */
  name: string;
  /** Category label (free-form — its own family, not constrained to McpCategory). */
  category: string;
  /** One-line summary of the server's tool surface. */
  desc: string;
  /** Resolved HTTPS endpoint (endpointEnv override, else defaultEndpoint). */
  endpoint: string;
  /** Env var that overrides the endpoint. */
  endpointEnv: string;
  /**
   * Endpoint used when endpointEnv is unset. EMPTY ('') when the Microsoft host
   * is not yet GA — the admin MUST supply endpointEnv before the server is usable
   * (no-vaporware: never a speculative host on a live path).
   */
  defaultEndpoint: string;
  /** Native transport — already exposes a Streamable-HTTP JSON-RPC endpoint. */
  transport: 'http';
  /**
   * Auth model:
   *  - 'none'      ⇒ no Authorization header (Microsoft Learn). Maps to
   *    McpServerConfig.authMethod 'header' with an empty authValue.
   *  - 'entra-obo' ⇒ per-user Entra On-Behalf-Of bearer for oboResource/oboScopes.
   *  - 'key-vault' ⇒ a stored secret (GitHub PAT) resolved from Key Vault.
   */
  auth: 'none' | 'entra-obo' | 'key-vault';
  /** OBO resource (audience) for entra-obo. '' ⇒ derive from the endpoint origin. */
  oboResource?: string;
  /** Delegated scopes (without the resource prefix) for entra-obo. */
  oboScopes?: string[];
  /** Opt-in toggle env var ('true' enables). Absent for Learn's default-on path. */
  enableEnv?: string;
  /** Key Vault secret NAME env var holding the bearer token (GitHub PAT). */
  secretRefEnv?: string;
  /** A tenant/admin setting the consumer must surface in the gate (no probe possible). */
  tenantSetting?: string;
  /** True only for Microsoft Learn — the sole default-on server (no-fabric-dependency). */
  defaultOn: boolean;
  /** Preview feature → catalog "Preview" badge. */
  preview: boolean;
  /** Opt-in only — never wired onto a default code path (false only for Learn). */
  optIn: boolean;
  /** Upstream attribution (repo / Learn doc) shown on the card. */
  attribution: string;
  /** Honest gate copy: the exact env / secret / scope / consent to provision. */
  gate: string;
  /**
   * True when this server is OPTED INTO (mirrors isPbiMcpConfigured()'s contract,
   * per-entry). Read live from process.env so tests/admin toggles take effect
   * without a reload. Learn is configured unless explicitly disabled.
   */
  configured: () => boolean;
}

/** Resolve a remote endpoint: endpointEnv override, else defaultEndpoint. */
function resolveRemoteEndpoint(endpointEnv: string, defaultEndpoint: string): string {
  return process.env[endpointEnv]?.trim() || defaultEndpoint;
}

/** True unless the named env var is explicitly 'false' (case-insensitive). */
function enabledUnlessFalse(env: string): boolean {
  return (process.env[env]?.trim().toLowerCase() ?? 'true') !== 'false';
}

/** True when the named env var is explicitly 'true' (case-insensitive). */
function enabledWhenTrue(env: string): boolean {
  return process.env[env]?.trim().toLowerCase() === 'true';
}

/** The shared Loom confidential client used for every per-user OBO exchange. */
function hasOboClient(): boolean {
  return !!process.env.LOOM_MSAL_CLIENT_ID?.trim();
}

/** Safe origin of a URL ('' on parse failure) — used to derive a per-org OBO audience. */
function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * The Power BI remote MCP entry projected into the generalized shape, UNCHANGED
 * in behavior — same endpoint, same delegated scopes, same opt-in gate
 * (isPbiMcpConfigured()). Lets the admin "Microsoft MCP servers" surface render
 * Power BI alongside the other remote built-ins without duplicating its config.
 */
const POWERBI_REMOTE_ENTRY: RemoteBuiltinMcpEntry = {
  id: REMOTE_BUILTIN_MCP.id,
  name: REMOTE_BUILTIN_MCP.name,
  category: REMOTE_BUILTIN_MCP.category,
  desc: 'Schema-aware query of Power BI semantic models + Copilot DAX generation (read-only) via the Microsoft-hosted Power BI remote MCP server. OPT-IN Fabric/Power BI family — never on a default path (no-fabric-dependency); Loom\'s Azure-native semantic-model / report authoring is the day-one default.',
  endpoint: REMOTE_BUILTIN_MCP.endpoint,
  endpointEnv: REMOTE_BUILTIN_MCP.endpointEnv,
  defaultEndpoint: REMOTE_BUILTIN_MCP.defaultEndpoint,
  transport: 'http',
  auth: 'entra-obo',
  oboResource: REMOTE_BUILTIN_MCP.resource,
  oboScopes: [...REMOTE_BUILTIN_MCP.delegatedScopes],
  enableEnv: REMOTE_BUILTIN_MCP.clientIdEnv,
  tenantSetting: REMOTE_BUILTIN_MCP.tenantSetting,
  defaultOn: false,
  preview: REMOTE_BUILTIN_MCP.preview,
  optIn: REMOTE_BUILTIN_MCP.optIn,
  attribution: 'learn.microsoft.com (Power BI MCP)',
  gate: 'Opt-in. Set LOOM_POWERBI_MCP_CLIENT_ID to an Entra app that requests the read-only Power BI delegated scopes (Dataset.Read.All, MLModel.Execute.All, Workspace.Read.All) and enable the Power BI admin-portal MCP tenant setting. OPT-IN Fabric/Power BI family — never on a default path.',
  configured: () => isPbiMcpConfigured(),
};

/**
 * The generalized remote built-in MCP catalog. Microsoft Learn is the SOLE
 * default-on entry (no auth, no config, no Fabric dependency); everything else is
 * opt-in and inert until its gate is satisfied. The Power BI entry is projected
 * in at the end, unchanged.
 *
 * Endpoint provenance (microsoft_docs_search, 2026-06):
 *  - ms-learn       : https://learn.microsoft.com/api/mcp                 (GA, no auth) ✅
 *  - ms-foundry     : https://mcp.ai.azure.com                            (preview)    ✅
 *  - github         : https://api.githubcopilot.com/mcp                   (GA)         ✅
 *  - ms-graph       : https://mcp.svc.cloud.microsoft/enterprise          (preview)    ✅
 *  - ms-sentinel    : https://sentinel.microsoft.com/mcp/data-exploration (preview)    ✅
 *  - dataverse      : https://<org>.crm.dynamics.com/api/mcp              (per-org)    ✅
 *  - azure-arm      : self-hosted Azure MCP w/ OBO (no fixed Microsoft host) → endpoint-env-gated
 *  - m365 / teams / onedrive-sharepoint / admin-center : remote host not yet GA → endpoint-env-gated
 *
 * NOTE on dataverse: confirmation showed the Dataverse MCP server is a REMOTE,
 * already-hosted per-environment endpoint (https://<org>.crm.dynamics.com/api/mcp)
 * with delegated Entra auth — NOT a pull-an-image deployable. Per no-vaporware it
 * is modeled here in the remote family (where it fits the real auth/transport)
 * rather than fabricated as a deployable image in MCP_CATALOG.
 */
export const REMOTE_BUILTIN_MCP_CATALOG: RemoteBuiltinMcpEntry[] = [
  {
    id: 'ms-learn',
    name: 'Microsoft Learn',
    category: 'Reference',
    desc: 'Search + fetch official Microsoft / Azure documentation and code samples (microsoft_docs_search / microsoft_docs_fetch / microsoft_code_sample_search). Microsoft-hosted, GA, NO authentication — live day-one with zero config.',
    endpoint: resolveRemoteEndpoint('LOOM_MS_LEARN_MCP_ENDPOINT', 'https://learn.microsoft.com/api/mcp'),
    endpointEnv: 'LOOM_MS_LEARN_MCP_ENDPOINT',
    defaultEndpoint: 'https://learn.microsoft.com/api/mcp',
    transport: 'http',
    auth: 'none',
    enableEnv: 'LOOM_MS_LEARN_MCP_ENABLED',
    defaultOn: true,
    preview: false,
    optIn: false,
    attribution: 'github.com/microsoftdocs/mcp',
    gate: 'On by default (no auth, no config). Set LOOM_MS_LEARN_MCP_ENABLED=false to disable, or LOOM_MS_LEARN_MCP_ENDPOINT to override the endpoint (e.g. add ?maxTokenBudget=2000).',
    configured: () => enabledUnlessFalse('LOOM_MS_LEARN_MCP_ENABLED'),
  },
  {
    id: 'azure-arm',
    name: 'Azure Resources (ARM)',
    category: 'Azure',
    desc: 'Manage / query Azure resources via natural language (Azure MCP Server) under your delegated Entra identity. Self-host the Azure MCP server with on-behalf-of auth on Container Apps, then set its HTTPS endpoint.',
    endpoint: resolveRemoteEndpoint('LOOM_AZURE_ARM_MCP_ENDPOINT', ''),
    endpointEnv: 'LOOM_AZURE_ARM_MCP_ENDPOINT',
    defaultEndpoint: '',
    transport: 'http',
    auth: 'entra-obo',
    oboResource: 'https://management.azure.com',
    oboScopes: ['user_impersonation'],
    enableEnv: 'LOOM_AZURE_ARM_MCP_ENABLED',
    defaultOn: false,
    preview: true,
    optIn: true,
    attribution: 'github.com/microsoft/mcp',
    gate: 'Opt-in. Self-host the Azure MCP server with OBO (learn.microsoft.com → azure-mcp-server / deploy-remote-mcp-server-on-behalf-of), then set LOOM_AZURE_ARM_MCP_ENDPOINT and LOOM_AZURE_ARM_MCP_ENABLED=true. Reuses the Loom confidential client (LOOM_MSAL_CLIENT_ID) for the per-user OBO exchange against https://management.azure.com/user_impersonation.',
    configured: () =>
      enabledWhenTrue('LOOM_AZURE_ARM_MCP_ENABLED') &&
      hasOboClient() &&
      !!process.env.LOOM_AZURE_ARM_MCP_ENDPOINT?.trim(),
  },
  {
    id: 'ms-foundry',
    name: 'Microsoft Foundry',
    category: 'Azure',
    desc: 'Interact with Microsoft Foundry projects / agents via the Microsoft-hosted Foundry MCP Server (https://mcp.ai.azure.com). Preview; delegated Entra auth against https://ai.azure.com.',
    endpoint: resolveRemoteEndpoint('LOOM_FOUNDRY_MCP_ENDPOINT', 'https://mcp.ai.azure.com'),
    endpointEnv: 'LOOM_FOUNDRY_MCP_ENDPOINT',
    defaultEndpoint: 'https://mcp.ai.azure.com',
    transport: 'http',
    auth: 'entra-obo',
    oboResource: 'https://ai.azure.com',
    oboScopes: ['.default'],
    enableEnv: 'LOOM_FOUNDRY_MCP_ENABLED',
    defaultOn: false,
    preview: true,
    optIn: true,
    attribution: 'learn.microsoft.com/azure/foundry/mcp',
    gate: 'Opt-in (preview). Set LOOM_FOUNDRY_MCP_ENABLED=true. Reuses the Loom confidential client (LOOM_MSAL_CLIENT_ID) for the per-user OBO exchange against https://ai.azure.com/.default. Note: the hosted Foundry MCP server does not support network isolation (public endpoint only).',
    configured: () => enabledWhenTrue('LOOM_FOUNDRY_MCP_ENABLED') && hasOboClient(),
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'Source Control',
    desc: 'Repositories, issues, pull requests, Actions, and code search via the Microsoft-hosted GitHub MCP server (https://api.githubcopilot.com/mcp). Uses GitHub OAuth / PAT (NOT Entra) — supply a PAT via Key Vault.',
    endpoint: resolveRemoteEndpoint('LOOM_GITHUB_MCP_ENDPOINT', 'https://api.githubcopilot.com/mcp'),
    endpointEnv: 'LOOM_GITHUB_MCP_ENDPOINT',
    defaultEndpoint: 'https://api.githubcopilot.com/mcp',
    transport: 'http',
    auth: 'key-vault',
    secretRefEnv: 'LOOM_GITHUB_MCP_PAT_SECRET',
    enableEnv: 'LOOM_GITHUB_MCP_ENABLED',
    defaultOn: false,
    preview: false,
    optIn: true,
    attribution: 'github.com/github/github-mcp-server',
    gate: 'Opt-in. Store a GitHub PAT in Key Vault and set LOOM_GITHUB_MCP_PAT_SECRET to the secret NAME (sent as Authorization: Bearer <PAT>). GitHub uses GitHub OAuth / PAT, not Entra — there is no OBO exchange. Optionally override the endpoint via LOOM_GITHUB_MCP_ENDPOINT for GitHub Enterprise.',
    configured: () => !!process.env.LOOM_GITHUB_MCP_PAT_SECRET?.trim(),
  },
  {
    id: 'ms-graph',
    name: 'Microsoft Graph (Enterprise)',
    category: 'Productivity',
    desc: 'Query Microsoft Entra tenant data (users, groups, apps, devices) in natural language via the Microsoft MCP Server for Enterprise (https://mcp.svc.cloud.microsoft/enterprise → Microsoft Graph). Preview, read-only; delegated Entra auth (MCP.* admin consent).',
    endpoint: resolveRemoteEndpoint('LOOM_MS_GRAPH_MCP_ENDPOINT', 'https://mcp.svc.cloud.microsoft/enterprise'),
    endpointEnv: 'LOOM_MS_GRAPH_MCP_ENDPOINT',
    defaultEndpoint: 'https://mcp.svc.cloud.microsoft/enterprise',
    transport: 'http',
    auth: 'entra-obo',
    oboResource: 'https://graph.microsoft.com',
    oboScopes: ['.default'],
    enableEnv: 'LOOM_MS_GRAPH_MCP_ENABLED',
    defaultOn: false,
    preview: true,
    optIn: true,
    attribution: 'learn.microsoft.com/graph/mcp-server',
    gate: 'Opt-in (preview). Grant the Loom app the MCP.* delegated Graph permissions + admin consent, then set LOOM_MS_GRAPH_MCP_ENABLED=true. Reuses LOOM_MSAL_CLIENT_ID for the per-user OBO exchange against https://graph.microsoft.com/.default. Read-only; respects the signed-in user\'s Graph permissions (100 calls/min/user).',
    configured: () => enabledWhenTrue('LOOM_MS_GRAPH_MCP_ENABLED') && hasOboClient(),
  },
  {
    id: 'm365',
    name: 'Microsoft 365',
    category: 'Productivity',
    desc: 'Microsoft 365 productivity data (mail, calendar, files) via a Microsoft 365 remote MCP endpoint over Microsoft Graph. Endpoint not yet GA — supply it explicitly. Preview, delegated Entra auth.',
    endpoint: resolveRemoteEndpoint('LOOM_M365_MCP_ENDPOINT', ''),
    endpointEnv: 'LOOM_M365_MCP_ENDPOINT',
    defaultEndpoint: '',
    transport: 'http',
    auth: 'entra-obo',
    oboResource: 'https://graph.microsoft.com',
    oboScopes: ['.default'],
    enableEnv: 'LOOM_M365_MCP_ENABLED',
    defaultOn: false,
    preview: true,
    optIn: true,
    attribution: 'github.com/microsoft/mcp',
    gate: 'Opt-in (preview). The Microsoft 365 remote MCP endpoint is not yet GA — set LOOM_M365_MCP_ENDPOINT to the published endpoint and LOOM_M365_MCP_ENABLED=true. Reuses LOOM_MSAL_CLIENT_ID for the per-user OBO exchange against https://graph.microsoft.com/.default.',
    configured: () =>
      enabledWhenTrue('LOOM_M365_MCP_ENABLED') &&
      hasOboClient() &&
      !!process.env.LOOM_M365_MCP_ENDPOINT?.trim(),
  },
  {
    id: 'teams',
    name: 'Microsoft Teams',
    category: 'Productivity',
    desc: 'Microsoft Teams chats, channels, and meeting context via a Teams remote MCP endpoint over Microsoft Graph. Endpoint not yet GA — supply it explicitly. Preview, delegated Entra auth.',
    endpoint: resolveRemoteEndpoint('LOOM_TEAMS_MCP_ENDPOINT', ''),
    endpointEnv: 'LOOM_TEAMS_MCP_ENDPOINT',
    defaultEndpoint: '',
    transport: 'http',
    auth: 'entra-obo',
    oboResource: 'https://graph.microsoft.com',
    oboScopes: ['.default'],
    enableEnv: 'LOOM_TEAMS_MCP_ENABLED',
    defaultOn: false,
    preview: true,
    optIn: true,
    attribution: 'github.com/microsoft/mcp',
    gate: 'Opt-in (preview). The Microsoft Teams remote MCP endpoint is not yet GA — set LOOM_TEAMS_MCP_ENDPOINT and LOOM_TEAMS_MCP_ENABLED=true. Reuses LOOM_MSAL_CLIENT_ID for the per-user OBO exchange against https://graph.microsoft.com/.default.',
    configured: () =>
      enabledWhenTrue('LOOM_TEAMS_MCP_ENABLED') &&
      hasOboClient() &&
      !!process.env.LOOM_TEAMS_MCP_ENDPOINT?.trim(),
  },
  {
    id: 'onedrive-sharepoint',
    name: 'OneDrive & SharePoint',
    category: 'Productivity',
    desc: 'OneDrive / SharePoint document search and retrieval via a remote MCP endpoint over Microsoft Graph. Endpoint not yet GA — supply it explicitly. Preview, delegated Entra auth.',
    endpoint: resolveRemoteEndpoint('LOOM_ONEDRIVE_SHAREPOINT_MCP_ENDPOINT', ''),
    endpointEnv: 'LOOM_ONEDRIVE_SHAREPOINT_MCP_ENDPOINT',
    defaultEndpoint: '',
    transport: 'http',
    auth: 'entra-obo',
    oboResource: 'https://graph.microsoft.com',
    oboScopes: ['.default'],
    enableEnv: 'LOOM_ONEDRIVE_SHAREPOINT_MCP_ENABLED',
    defaultOn: false,
    preview: true,
    optIn: true,
    attribution: 'github.com/microsoft/mcp',
    gate: 'Opt-in (preview). The OneDrive / SharePoint remote MCP endpoint is not yet GA — set LOOM_ONEDRIVE_SHAREPOINT_MCP_ENDPOINT and LOOM_ONEDRIVE_SHAREPOINT_MCP_ENABLED=true. Reuses LOOM_MSAL_CLIENT_ID for the per-user OBO exchange against https://graph.microsoft.com/.default.',
    configured: () =>
      enabledWhenTrue('LOOM_ONEDRIVE_SHAREPOINT_MCP_ENABLED') &&
      hasOboClient() &&
      !!process.env.LOOM_ONEDRIVE_SHAREPOINT_MCP_ENDPOINT?.trim(),
  },
  {
    id: 'ms-sentinel',
    name: 'Microsoft Sentinel',
    category: 'Observability',
    desc: 'Natural-language threat hunting and data exploration over the Microsoft Sentinel data lake + Defender via the Microsoft-hosted Sentinel MCP server (https://sentinel.microsoft.com/mcp/data-exploration). Preview; delegated Entra auth (Security Reader+).',
    endpoint: resolveRemoteEndpoint('LOOM_SENTINEL_MCP_ENDPOINT', 'https://sentinel.microsoft.com/mcp/data-exploration'),
    endpointEnv: 'LOOM_SENTINEL_MCP_ENDPOINT',
    defaultEndpoint: 'https://sentinel.microsoft.com/mcp/data-exploration',
    transport: 'http',
    auth: 'entra-obo',
    oboResource: 'https://sentinel.microsoft.com',
    oboScopes: ['.default'],
    enableEnv: 'LOOM_SENTINEL_MCP_ENABLED',
    defaultOn: false,
    preview: true,
    optIn: true,
    attribution: 'learn.microsoft.com/azure/sentinel/datalake/sentinel-mcp-overview',
    gate: 'Opt-in (preview). Requires at least the Security Reader role on the Sentinel data lake. Set LOOM_SENTINEL_MCP_ENABLED=true. Reuses LOOM_MSAL_CLIENT_ID for the per-user OBO exchange against https://sentinel.microsoft.com/.default. Optionally point LOOM_SENTINEL_MCP_ENDPOINT at a custom tool collection (.../mcp/custom/<name>).',
    configured: () => enabledWhenTrue('LOOM_SENTINEL_MCP_ENABLED') && hasOboClient(),
  },
  {
    id: 'admin-center',
    name: 'Microsoft 365 Admin Center',
    category: 'Productivity',
    desc: 'Microsoft 365 admin / tenant management insights via a Microsoft admin-center remote MCP endpoint over Microsoft Graph. Endpoint not yet GA — supply it explicitly. Preview, delegated Entra auth.',
    endpoint: resolveRemoteEndpoint('LOOM_ADMIN_CENTER_MCP_ENDPOINT', ''),
    endpointEnv: 'LOOM_ADMIN_CENTER_MCP_ENDPOINT',
    defaultEndpoint: '',
    transport: 'http',
    auth: 'entra-obo',
    oboResource: 'https://graph.microsoft.com',
    oboScopes: ['.default'],
    enableEnv: 'LOOM_ADMIN_CENTER_MCP_ENABLED',
    defaultOn: false,
    preview: true,
    optIn: true,
    attribution: 'github.com/microsoft/mcp',
    gate: 'Opt-in (preview). The Microsoft 365 Admin Center remote MCP endpoint is not yet GA — set LOOM_ADMIN_CENTER_MCP_ENDPOINT and LOOM_ADMIN_CENTER_MCP_ENABLED=true. Reuses LOOM_MSAL_CLIENT_ID for the per-user OBO exchange against https://graph.microsoft.com/.default.',
    configured: () =>
      enabledWhenTrue('LOOM_ADMIN_CENTER_MCP_ENABLED') &&
      hasOboClient() &&
      !!process.env.LOOM_ADMIN_CENTER_MCP_ENDPOINT?.trim(),
  },
  {
    id: 'dataverse',
    name: 'Microsoft Dataverse',
    category: 'Database',
    desc: 'Query / insert / update Dataverse tables + schema in natural language via the Microsoft-hosted Dataverse MCP server (per-environment https://<org>.crm.dynamics.com/api/mcp). Delegated Entra auth; respects Dataverse security roles + row-level security.',
    endpoint: resolveRemoteEndpoint('LOOM_DATAVERSE_MCP_ENDPOINT', ''),
    endpointEnv: 'LOOM_DATAVERSE_MCP_ENDPOINT',
    defaultEndpoint: '',
    transport: 'http',
    auth: 'entra-obo',
    oboResource: '', // per-org — derived from the endpoint origin at OBO time
    oboScopes: ['.default'],
    enableEnv: 'LOOM_DATAVERSE_MCP_ENABLED',
    tenantSetting:
      'Power Platform admin center → Environment → Settings → Product → Features → Dataverse Model Context Protocol → "Allow MCP clients to interact with Dataverse MCP server"',
    defaultOn: false,
    preview: true,
    optIn: true,
    attribution: 'learn.microsoft.com/power-apps/maker/data-platform/data-platform-mcp',
    gate: 'Opt-in (preview). Set LOOM_DATAVERSE_MCP_ENDPOINT to your environment URL + /api/mcp (e.g. https://contoso.crm.dynamics.com/api/mcp), enable the Dataverse MCP tenant setting in the Power Platform admin center, and set LOOM_DATAVERSE_MCP_ENABLED=true. Reuses LOOM_MSAL_CLIENT_ID for the per-user OBO exchange (audience = your org origin + /.default).',
    configured: () =>
      enabledWhenTrue('LOOM_DATAVERSE_MCP_ENABLED') &&
      hasOboClient() &&
      !!process.env.LOOM_DATAVERSE_MCP_ENDPOINT?.trim(),
  },
  // Power BI projected in unchanged (gated by isPbiMcpConfigured()).
  POWERBI_REMOTE_ENTRY,
];

// ── Selectors (mirror the Power BI helpers, generalized over the catalog) ──────

/** Look up a single remote built-in entry by id. */
export function msRemoteMcp(id: string): RemoteBuiltinMcpEntry | undefined {
  return REMOTE_BUILTIN_MCP_CATALOG.find((e) => e.id === id);
}

/**
 * True when the named remote built-in server is OPTED INTO / live (generalized
 * isPbiMcpConfigured()). False (or unknown id) ⇒ the consumer renders the honest
 * MessageBar gate from entry.gate; the server is registered/called on NO path.
 */
export function msRemoteMcpConfigured(id: string): boolean {
  return msRemoteMcp(id)?.configured() ?? false;
}

/**
 * Fully-qualified OBO scope URIs (`${resource}/${scope}`) for an entra-obo entry —
 * exactly what the per-user OBO exchange requests (generalized pbiMcpScopeUris()).
 * For a per-org server (oboResource '', e.g. Dataverse) the resource is derived
 * from the configured endpoint's origin. Returns [] for non-OBO entries or when
 * the resource cannot be resolved.
 */
export function msRemoteMcpScopeUris(id: string): string[] {
  const e = msRemoteMcp(id);
  if (!e || e.auth !== 'entra-obo') return [];
  const base =
    e.oboResource && e.oboResource.trim()
      ? e.oboResource.trim()
      : e.endpoint
        ? safeOrigin(e.endpoint)
        : '';
  if (!base) return [];
  const resource = base.replace(/\/+$/, '');
  return (e.oboScopes ?? []).map((scope) => `${resource}/${scope}`);
}

/**
 * The remote built-in servers that are LIVE day-one with zero per-server config —
 * i.e. defaultOn AND currently configured(). In practice this is Microsoft Learn
 * (unless LOOM_MS_LEARN_MCP_ENABLED=false). listMcpServers / buildMcpShim inject
 * these as synthetic enabled rows so their tools are advertised without any admin
 * action (no-fabric-dependency: Learn is the SOLE default-on server).
 */
export function defaultOnRemoteMcps(): RemoteBuiltinMcpEntry[] {
  return REMOTE_BUILTIN_MCP_CATALOG.filter((e) => e.defaultOn && e.configured());
}

