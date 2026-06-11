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
 * are the Azure-native defaults. Zero Fabric / Power BI hosts are referenced.
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
  | 'Infrastructure';

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
}

/**
 * The catalog. 25 entries ranked per temp/mcp-gov-research.md.
 *
 * All entries are `transport: 'stdio'` today (no upstream ships a hosted HTTPS
 * endpoint), so each carries `hostVia: 'container-apps'` — consumers must host
 * before registering. See file header.
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
