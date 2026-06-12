/**
 * mcp-catalog — the VETTED, FIXED, deployable allow-list of MCP servers Loom can
 * stand up as Azure Container Apps.
 *
 * WHY A FIXED CATALOG (not a free-form image string)
 * --------------------------------------------------
 * Per .claude/rules (no-freeform-config + no-vaporware): the deploy surface
 * must be a curated set of vetted, gov-safe MCP servers chosen from a dropdown
 * — NOT an arbitrary operator-supplied container image. The deploy BFF route
 * validates every request against this allow-list and refuses anything else, so
 * a tenant admin can only stand up servers we've license-/gov-vetted.
 *
 * Source of the vetting: temp/mcp-gov-research.md (2026-06-04) — the top-25
 * industry-standard MCP servers screened for FedRAMP / IL Azure boundaries
 * (permissive licenses only — Apache-2.0 / MIT / BSD; no AGPL/SSPL/commercial).
 * The Tier-0 set is fully air-gap safe (zero external calls); the rest are
 * flagged with their egress profile so the UI can warn before deploy.
 *
 * IMAGE COORDINATES
 * -----------------
 * `image` is the UPSTREAM reference image (the official Docker MCP catalog
 * `mcp/*` namespace, the `mcr.microsoft.com/*` Microsoft-published servers, or a
 * vendor's published OCI image such as `ghcr.io/github/github-mcp-server`).
 * Every entry maps to a REAL, pullable image that exposes an HTTP/SSE transport
 * (no-vaporware) — community-HTTP-transport entries are tagged `preview: true`.
 * Gov / air-gapped deployments mirror these into the Loom ACR and set
 * LOOM_MCP_CATALOG_REGISTRY to the mirror host — `resolveCatalogImage()` then
 * rewrites the bare repo path onto that registry. No Fabric / Power BI
 * dependency anywhere (no-fabric-dependency.md): these are plain OCI images.
 *
 * CONSUMERS
 * ---------
 *  - GET /api/admin/mcp-catalog → catalogForUi() → McpCatalogPanel (deploy grid)
 *  - POST /api/admin/mcp-catalog/deploy → deployMcpContainerApp (mcp-deploy-client)
 *    wires the UAMI identity, internal ingress, secretRef from Key Vault, and the
 *    Azure Files volume (mounted /data) when `needsStorage`.
 *  - platform/fiab/bicep/modules/admin-plane/mcp-catalog-app.bicep (IaC mirror).
 */

/** Egress profile for a catalog server — drives the UI pre-deploy warning. */
export type McpEgressProfile =
  | 'air-gap-safe' // zero external calls; runs fully offline
  | 'azure-internal' // talks only to Azure / in-VNet endpoints (control plane, DB)
  | 'external-saas'; // reaches an external SaaS API (needs an approved egress path)

/** Capability grouping for the deploy grid / catalog filter. */
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

/** Target cloud boundary for the catalog filter. */
export type GovCloud = 'commercial' | 'gcc' | 'gcc-high' | 'il5';

export interface McpCatalogEntry {
  /** Stable id used as the deploy selector + container-app name stem. Lowercase, DNS-safe. */
  id: string;
  /** Display name. */
  name: string;
  /** One-line description of what the server does. */
  description: string;
  /**
   * Upstream container image reference. Either a fully-qualified host/repo:tag
   * (`mcr.microsoft.com/...`, `ghcr.io/...`) or a bare `repo[:tag]` resolved
   * against LOOM_MCP_CATALOG_REGISTRY (default: the Docker MCP catalog `docker.io`).
   */
  image: string;
  /** OSS license (all permissive — Apache-2.0 / MIT / BSD-3-Clause). */
  license: string;
  /** Upstream maintainer (Anthropic / Microsoft / GitHub / Community). */
  maintainer: string;
  /** Capability grouping for the deploy grid. */
  category: McpCategory;
  /** Egress profile — air-gap safe servers are the gov-default Tier-0 set. */
  egress: McpEgressProfile;
  /** Container port the MCP HTTP/SSE transport listens on. */
  port: number;
  /** Liveness/readiness probe path (separate from the MCP endpoint per Learn). */
  healthPath: string;
  /** Whether this server benefits from a persistent Azure Files volume (mounted at /data). */
  needsStorage: boolean;
  /**
   * Optional secret the server reads from an environment variable. When set, the
   * deploy request may supply a Key Vault secret name; the deploy route wires it
   * as a Container Apps `secretRef` (resolved by the MCP UAMI, which holds Key
   * Vault Secrets User) and projects it into this env var.
   */
  secretEnv?: string;
  /** Safe to offer in a US Gov boundary (gov license + no disallowed egress). */
  govSafe: boolean;
  /** Runs with NO external internet calls (the self-contained set). */
  airGapSafe: boolean;
  /** Tier-0 / Tier-1 default recommendation for a Loom Gov Phase 1 deploy. */
  defaultRecommended: boolean;
  /**
   * External SaaS hosts the server reaches. Non-empty ⇒ must route via an
   * approved gov proxy (or be hidden) in gcc-high/il5. [] = self-contained.
   */
  externalHosts: string[];
  /**
   * Preview = real image, but the HTTP/SSE transport is community-maintained /
   * still being validated. The UI tags these so a tile never silently can't work.
   */
  preview?: boolean;
}

/**
 * The vetted, deployable catalog — exactly 25 servers. Tier-0 (air-gap-safe)
 * first, then Azure-internal, then the external-SaaS servers that require an
 * approved egress path. Every `image` is a real, pullable HTTP/SSE-capable image
 * (Docker MCP catalog `mcp/*`, `mcr.microsoft.com/*`, or a vendor OCI image).
 */
export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  // ── Tier 0 — fully air-gap safe (Anthropic reference servers, Apache-2.0) ──
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Secure file operations with a configurable directory allow-list. Reference implementation, no external calls.',
    image: 'mcp/filesystem',
    license: 'Apache-2.0',
    maintainer: 'Anthropic (official)',
    category: 'Reference',
    egress: 'air-gap-safe',
    port: 8080,
    healthPath: '/health',
    needsStorage: true,
    govSafe: true,
    airGapSafe: true,
    defaultRecommended: true,
    externalHosts: [],
  },
  {
    id: 'git',
    name: 'Git',
    description: 'Repository reading, searching, and git operations (clone, diff, log, blame). Works offline.',
    image: 'mcp/git',
    license: 'Apache-2.0',
    maintainer: 'Anthropic (official)',
    category: 'Source Control',
    egress: 'air-gap-safe',
    port: 8080,
    healthPath: '/health',
    needsStorage: true,
    govSafe: true,
    airGapSafe: true,
    defaultRecommended: true,
    externalHosts: [],
  },
  {
    id: 'sequentialthinking',
    name: 'Sequential Thinking',
    description: 'Dynamic, reflective problem-solving through structured thought sequences. No external dependencies.',
    image: 'mcp/sequentialthinking',
    license: 'Apache-2.0',
    maintainer: 'Anthropic (official)',
    category: 'Reference',
    egress: 'air-gap-safe',
    port: 8080,
    healthPath: '/health',
    needsStorage: false,
    govSafe: true,
    airGapSafe: true,
    defaultRecommended: true,
    externalHosts: [],
  },
  {
    id: 'time',
    name: 'Time',
    description: 'Time and timezone conversion capabilities. Zero external calls.',
    image: 'mcp/time',
    license: 'Apache-2.0',
    maintainer: 'Anthropic (official)',
    category: 'Reference',
    egress: 'air-gap-safe',
    port: 8080,
    healthPath: '/health',
    needsStorage: false,
    govSafe: true,
    airGapSafe: true,
    defaultRecommended: true,
    externalHosts: [],
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'Knowledge-graph-based persistent memory. File-backed; no network access required.',
    image: 'mcp/memory',
    license: 'Apache-2.0',
    maintainer: 'Anthropic (official)',
    category: 'Reference',
    egress: 'air-gap-safe',
    port: 8080,
    healthPath: '/health',
    needsStorage: true,
    govSafe: true,
    airGapSafe: true,
    defaultRecommended: true,
    externalHosts: [],
  },
  {
    id: 'everything',
    name: 'Everything (reference)',
    description: 'Reference test server exercising prompts, resources, and tools. Educational/demo; no external calls.',
    image: 'mcp/everything',
    license: 'Apache-2.0',
    maintainer: 'Anthropic (official)',
    category: 'Reference',
    egress: 'air-gap-safe',
    port: 8080,
    healthPath: '/health',
    needsStorage: false,
    govSafe: true,
    airGapSafe: true,
    defaultRecommended: false,
    externalHosts: [],
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Local SQLite database create/read/write operations. Fully file-based; air-gap safe.',
    image: 'mcp/sqlite',
    license: 'MIT',
    maintainer: 'Community (Docker MCP)',
    category: 'Database',
    egress: 'air-gap-safe',
    port: 8080,
    healthPath: '/health',
    needsStorage: true,
    govSafe: true,
    airGapSafe: true,
    defaultRecommended: false,
    externalHosts: [],
    preview: true,
  },

  // ── Tier 1 — Microsoft-official + Azure-internal / self-contained ──────────
  {
    id: 'playwright',
    name: 'Playwright',
    description: 'Browser automation, web scraping, screenshots, and accessibility testing. Bundled Chromium; self-contained.',
    image: 'mcr.microsoft.com/playwright/mcp',
    license: 'Apache-2.0',
    maintainer: 'Microsoft (official)',
    category: 'Browser Automation',
    egress: 'azure-internal',
    port: 8080,
    healthPath: '/health',
    needsStorage: false,
    govSafe: true,
    airGapSafe: true,
    defaultRecommended: true,
    externalHosts: [],
  },
  {
    id: 'azure',
    name: 'Azure MCP Server',
    description: 'Interact with Azure resources via natural language (list, modify, query). Uses the Azure Identity SDK — gov-cloud aware.',
    image: 'mcr.microsoft.com/azure-sdk/azure-mcp',
    license: 'MIT',
    maintainer: 'Microsoft (official)',
    category: 'Azure',
    egress: 'azure-internal',
    port: 8080,
    healthPath: '/health',
    needsStorage: false,
    govSafe: true,
    airGapSafe: false,
    defaultRecommended: true,
    externalHosts: [],
  },
  {
    id: 'postgres',
    name: 'Postgres',
    description: 'SQL query execution, schema exploration, and data analysis against Azure Database for PostgreSQL over the VNet.',
    image: 'mcp/postgres',
    license: 'MIT',
    maintainer: 'Anthropic (official)',
    category: 'Database',
    egress: 'azure-internal',
    port: 8080,
    healthPath: '/health',
    needsStorage: false,
    govSafe: true,
    airGapSafe: true,
    defaultRecommended: true,
    externalHosts: [],
    secretEnv: 'POSTGRES_CONNECTION_STRING',
  },
  {
    id: 'kubernetes',
    name: 'Kubernetes',
    description: 'Cluster operations, pod management, and deployments against AKS (in-cluster or kubeconfig). Internal VNet / air-gap OK.',
    image: 'mcp/kubernetes',
    license: 'Apache-2.0',
    maintainer: 'Community (manusa)',
    category: 'Infrastructure',
    egress: 'azure-internal',
    port: 8080,
    healthPath: '/health',
    needsStorage: false,
    govSafe: true,
    airGapSafe: true,
    defaultRecommended: true,
    externalHosts: [],
    preview: true,
  },
  {
    id: 'redis',
    name: 'Redis',
    description: 'Key/value, hash, and stream operations against Azure Cache for Redis over the VNet.',
    image: 'mcp/redis',
    license: 'MIT',
    maintainer: 'Redis (vendor)',
    category: 'Database',
    egress: 'azure-internal',
    port: 8080,
    healthPath: '/health',
    needsStorage: false,
    govSafe: true,
    airGapSafe: true,
    defaultRecommended: false,
    externalHosts: [],
    secretEnv: 'REDIS_URL',
    preview: true,
  },
  {
    id: 'dbhub',
    name: 'Database (dbhub)',
    description: 'Multi-database support — Postgres, MySQL, SQL Server, MariaDB, SQLite — via one DSN. Target Azure Database services over the VNet.',
    image: 'mcp/dbhub',
    license: 'MIT',
    maintainer: 'Bytebase (vendor)',
    category: 'Database',
    egress: 'azure-internal',
    port: 8080,
    healthPath: '/health',
    needsStorage: false,
    govSafe: true,
    airGapSafe: false,
    defaultRecommended: false,
    externalHosts: [],
    secretEnv: 'DSN',
    preview: true,
  },

  // ── Tier 2 — external SaaS (require an approved egress path; secret-gated) ──
  {
    id: 'azure-devops',
    name: 'Azure DevOps',
    description: 'Work items, repos, pipelines, and pull requests against an Azure DevOps organization. Gov-friendly Microsoft alternative to SaaS issue trackers.',
    image: 'mcp/azure-devops',
    license: 'MIT',
    maintainer: 'Microsoft (official)',
    category: 'Source Control',
    egress: 'external-saas',
    port: 8080,
    healthPath: '/health',
    needsStorage: false,
    govSafe: true,
    airGapSafe: false,
    defaultRecommended: false,
    externalHosts: ['dev.azure.com (or your Azure DevOps Server host)'],
    secretEnv: 'AZURE_DEVOPS_PAT',
    preview: true,
  },
  {
    id: 'github',
    name: 'GitHub MCP Server',
    description: 'PR management, issue triage, code search, and CI/CD analysis. Calls github.com or a GitHub Enterprise endpoint.',
    image: 'ghcr.io/github/github-mcp-server',
    license: 'MIT',
    maintainer: 'GitHub (official)',
    category: 'Source Control',
    egress: 'external-saas',
    port: 8080,
    healthPath: '/healthz',
    needsStorage: false,
    govSafe: true,
    airGapSafe: false,
    defaultRecommended: false,
    externalHosts: ['github.com (or your GitHub Enterprise host)'],
    secretEnv: 'GITHUB_PERSONAL_ACCESS_TOKEN',
  },
  {
    id: 'grafana',
    name: 'Grafana',
    description: 'Query dashboards, datasources, Prometheus/Loki, and incidents. Calls your Grafana instance over HTTPS.',
    image: 'mcp/grafana',
    license: 'Apache-2.0',
    maintainer: 'Grafana Labs (official)',
    category: 'Observability',
    egress: 'external-saas',
    port: 8000,
    healthPath: '/healthz',
    needsStorage: false,
    govSafe: true,
    airGapSafe: false,
    defaultRecommended: false,
    externalHosts: ['your Grafana host'],
    secretEnv: 'GRAFANA_API_KEY',
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: 'Retrieve a URL and convert the page to clean markdown for grounding. Reaches arbitrary outbound URLs.',
    image: 'mcp/fetch',
    license: 'Apache-2.0',
    maintainer: 'Anthropic (official)',
    category: 'Web & Search',
    egress: 'external-saas',
    port: 8080,
    healthPath: '/health',
    needsStorage: false,
    govSafe: true,
    airGapSafe: false,
    defaultRecommended: false,
    externalHosts: ['(arbitrary outbound URLs — route via an approved gov proxy)'],
    preview: true,
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Real-time web search via Brave’s independent index. Calls the Brave Search API over HTTPS.',
    image: 'mcp/brave-search',
    license: 'MIT',
    maintainer: 'Brave (vendor)',
    category: 'Web & Search',
    egress: 'external-saas',
    port: 8080,
    healthPath: '/health',
    needsStorage: false,
    govSafe: true,
    airGapSafe: false,
    defaultRecommended: false,
    externalHosts: ['api.search.brave.com'],
    secretEnv: 'BRAVE_API_KEY',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Error tracking, stack-trace debugging, and issue management. Self-host Sentry on Azure for gov.',
    image: 'mcp/sentry',
    license: 'MIT',
    maintainer: 'Sentry (official)',
    category: 'Observability',
    egress: 'external-saas',
    port: 8080,
    healthPath: '/health',
    needsStorage: false,
    govSafe: false,
    airGapSafe: false,
    defaultRecommended: false,
    externalHosts: ['sentry.io (or your self-hosted Sentry host)'],
    secretEnv: 'SENTRY_AUTH_TOKEN',
    preview: true,
  },
  {
    id: 'atlassian',
    name: 'Atlassian (Jira / Confluence)',
    description: 'Jira issue tracking and Confluence pages. Use only on approved Atlassian Cloud/Server; Azure DevOps is an alternative.',
    image: 'mcp/atlassian',
    license: 'MIT',
    maintainer: 'Community (sooperset)',
    category: 'Productivity',
    egress: 'external-saas',
    port: 8080,
    healthPath: '/health',
    needsStorage: false,
    govSafe: false,
    airGapSafe: false,
    defaultRecommended: false,
    externalHosts: ['*.atlassian.net'],
    secretEnv: 'JIRA_API_TOKEN',
    preview: true,
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Messaging, channel management, and bot integration. Use only if Slack is approved; Microsoft Teams is an alternative.',
    image: 'mcp/slack',
    license: 'MIT',
    maintainer: 'Community (Docker MCP)',
    category: 'Productivity',
    egress: 'external-saas',
    port: 8080,
    healthPath: '/health',
    needsStorage: false,
    govSafe: false,
    airGapSafe: false,
    defaultRecommended: false,
    externalHosts: ['slack.com'],
    secretEnv: 'SLACK_BOT_TOKEN',
    preview: true,
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Documentation queries, database operations, and page creation. Use only if Notion is approved.',
    image: 'mcp/notion',
    license: 'MIT',
    maintainer: 'Notion (official)',
    category: 'Productivity',
    egress: 'external-saas',
    port: 8080,
    healthPath: '/health',
    needsStorage: false,
    govSafe: false,
    airGapSafe: false,
    defaultRecommended: false,
    externalHosts: ['api.notion.com'],
    secretEnv: 'NOTION_TOKEN',
    preview: true,
  },
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Customer, subscription, and payment operations (read-only recommended). Use only if Stripe is in use.',
    image: 'mcp/stripe',
    license: 'MIT',
    maintainer: 'Stripe (official)',
    category: 'Productivity',
    egress: 'external-saas',
    port: 8080,
    healthPath: '/health',
    needsStorage: false,
    govSafe: false,
    airGapSafe: false,
    defaultRecommended: false,
    externalHosts: ['api.stripe.com'],
    secretEnv: 'STRIPE_API_KEY',
    preview: true,
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Issue tracking, sprint management, and project sync. Use only if Linear is approved; GitHub Issues is an in-env alternative.',
    image: 'mcp/linear',
    license: 'MIT',
    maintainer: 'Community (Docker MCP)',
    category: 'Productivity',
    egress: 'external-saas',
    port: 8080,
    healthPath: '/health',
    needsStorage: false,
    govSafe: false,
    airGapSafe: false,
    defaultRecommended: false,
    externalHosts: ['api.linear.app'],
    secretEnv: 'LINEAR_API_KEY',
    preview: true,
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    description: 'JavaScript-rendering web crawling, batch processing, and content extraction. Enterprise self-host possible.',
    image: 'mcp/firecrawl',
    license: 'MIT',
    maintainer: 'Firecrawl (official)',
    category: 'Web & Search',
    egress: 'external-saas',
    port: 8080,
    healthPath: '/health',
    needsStorage: false,
    govSafe: false,
    airGapSafe: false,
    defaultRecommended: false,
    externalHosts: ['api.firecrawl.dev'],
    secretEnv: 'FIRECRAWL_API_KEY',
    preview: true,
  },
] as const;

// A compile-time check that we ship exactly the curated 25 (a missing/extra
// entry trips the integrity test in __tests__/mcp-catalog.test.ts).
export const MCP_CATALOG_SIZE = MCP_CATALOG.length;

/** Look up a catalog entry by id. Returns undefined when not in the allow-list. */
export function getCatalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((e) => e.id === id);
}

/**
 * Resolve the deployable image reference for a catalog entry.
 *
 * - A fully-qualified image (contains a registry host with a dot before the
 *   first slash, e.g. `mcr.microsoft.com/...`) is returned unchanged unless a
 *   mirror registry is configured, in which case the bare repo path is rebased
 *   onto the mirror (so air-gapped ACR mirrors of MS images work too).
 * - A bare `repo[:tag]` is rebased onto LOOM_MCP_CATALOG_REGISTRY (default the
 *   public Docker MCP catalog on docker.io). A missing `:tag` defaults to `:latest`.
 */
export function resolveCatalogImage(entry: McpCatalogEntry): string {
  const mirror = (process.env.LOOM_MCP_CATALOG_REGISTRY || '').trim().replace(/\/+$/, '');
  const raw = entry.image.trim();
  const firstSeg = raw.split('/')[0];
  const isQualified = firstSeg.includes('.') || firstSeg.includes(':');
  const lastSeg = raw.split('/').pop() || raw;
  const withTag = lastSeg.includes(':') ? raw : `${raw}:latest`;
  if (isQualified) {
    if (!mirror) return withTag;
    // Rebase the trailing repo path (drop the original host) onto the mirror.
    const repoPath = withTag.split('/').slice(1).join('/');
    return `${mirror}/${repoPath}`;
  }
  // Bare repo path → mirror or public docker.io.
  return mirror ? `${mirror}/${withTag}` : `docker.io/${withTag}`;
}

/** A trimmed, UI-safe view of the catalog (a stable copy callers can serialise). */
export function catalogForUi(): McpCatalogEntry[] {
  return MCP_CATALOG.map((e) => ({ ...e, externalHosts: [...e.externalHosts] }));
}

/** Servers recommended by default for a Loom Gov Phase 1 deploy. */
export function defaultRecommendedServers(): McpCatalogEntry[] {
  return MCP_CATALOG.filter((e) => e.defaultRecommended).map((e) => ({ ...e, externalHosts: [...e.externalHosts] }));
}

/** Servers that run with no external internet calls (air-gap safe). */
export function airGapSafeServers(): McpCatalogEntry[] {
  return MCP_CATALOG.filter((e) => e.airGapSafe).map((e) => ({ ...e, externalHosts: [...e.externalHosts] }));
}

/**
 * Filter the catalog to the servers allowable in a given cloud boundary.
 *  - commercial: everything
 *  - gcc / gcc-high: gov-safe servers (SaaS ones still carry externalHosts and
 *    must be proxied/approved by the consumer)
 *  - il5: restrict to air-gap-safe servers plus the Azure-native data planes
 *    (Azure MCP, Postgres on Azure Database, Kubernetes/AKS) so IL5 admins
 *    never see ungated SaaS tiles.
 */
export function serversForCloud(cloud: GovCloud): McpCatalogEntry[] {
  const copy = (e: McpCatalogEntry) => ({ ...e, externalHosts: [...e.externalHosts] });
  switch (cloud) {
    case 'commercial':
      return MCP_CATALOG.map(copy);
    case 'gcc':
    case 'gcc-high':
      return MCP_CATALOG.filter((e) => e.govSafe).map(copy);
    case 'il5': {
      const il5Allow = new Set(['azure', 'postgres', 'kubernetes', 'redis', 'dbhub']);
      return MCP_CATALOG.filter((e) => e.airGapSafe || il5Allow.has(e.id)).map(copy);
    }
    default:
      return MCP_CATALOG.map(copy);
  }
}
