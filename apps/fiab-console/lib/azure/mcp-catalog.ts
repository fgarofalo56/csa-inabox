/**
 * mcp-catalog — the VETTED, FIXED allow-list of MCP servers Loom can deploy as
 * Azure Container Apps.
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
 * `mcp/*` namespace, or `mcr.microsoft.com/*` for Microsoft-published servers).
 * Gov / air-gapped deployments mirror these into the Loom ACR and set
 * LOOM_MCP_CATALOG_REGISTRY to the mirror host — `resolveCatalogImage()` then
 * rewrites the bare repo path onto that registry. No Fabric / Power BI
 * dependency anywhere (no-fabric-dependency.md): these are plain OCI images.
 */

/** Egress profile for a catalog server — drives the UI pre-deploy warning. */
export type McpEgressProfile =
  | 'air-gap-safe' // zero external calls; runs fully offline
  | 'azure-internal' // talks only to Azure / in-VNet endpoints (control plane, DB)
  | 'external-saas'; // reaches an external SaaS API (needs an approved egress path)

export interface McpCatalogEntry {
  /** Stable id used as the deploy selector + container-app name stem. Lowercase, DNS-safe. */
  id: string;
  /** Display name. */
  name: string;
  /** One-line description of what the server does. */
  description: string;
  /**
   * Upstream container image reference. Either a fully-qualified host/repo:tag
   * (`mcr.microsoft.com/...`) or a bare `repo[:tag]` resolved against
   * LOOM_MCP_CATALOG_REGISTRY (default: the Docker MCP catalog `docker.io`).
   */
  image: string;
  /** OSS license (all permissive — Apache-2.0 / MIT). */
  license: string;
  /** Upstream maintainer (Anthropic / Microsoft / Community). */
  maintainer: string;
  /** Egress profile — air-gap safe servers are the gov-default Tier-0 set. */
  egress: McpEgressProfile;
  /** Container port the MCP HTTP/SSE transport listens on. */
  port: number;
  /** Liveness/readiness probe path (most MCP servers expose `/` or `/health`). */
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
}

/**
 * The vetted catalog. Tier-0 (air-gap-safe) first, then Azure-internal, then
 * the external-SaaS servers that require an approved egress path.
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
    egress: 'air-gap-safe',
    port: 8080,
    healthPath: '/',
    needsStorage: true,
  },
  {
    id: 'git',
    name: 'Git',
    description: 'Repository reading, searching, and git operations (clone, diff, log, blame). Works offline.',
    image: 'mcp/git',
    license: 'Apache-2.0',
    maintainer: 'Anthropic (official)',
    egress: 'air-gap-safe',
    port: 8080,
    healthPath: '/',
    needsStorage: true,
  },
  {
    id: 'sequentialthinking',
    name: 'Sequential Thinking',
    description: 'Dynamic, reflective problem-solving through structured thought sequences. No external dependencies.',
    image: 'mcp/sequentialthinking',
    license: 'Apache-2.0',
    maintainer: 'Anthropic (official)',
    egress: 'air-gap-safe',
    port: 8080,
    healthPath: '/',
    needsStorage: false,
  },
  {
    id: 'time',
    name: 'Time',
    description: 'Time and timezone conversion capabilities. Zero external calls.',
    image: 'mcp/time',
    license: 'Apache-2.0',
    maintainer: 'Anthropic (official)',
    egress: 'air-gap-safe',
    port: 8080,
    healthPath: '/',
    needsStorage: false,
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'Knowledge-graph-based persistent memory. File-backed; no network access required.',
    image: 'mcp/memory',
    license: 'Apache-2.0',
    maintainer: 'Anthropic (official)',
    egress: 'air-gap-safe',
    port: 8080,
    healthPath: '/',
    needsStorage: true,
  },
  {
    id: 'everything',
    name: 'Everything (reference)',
    description: 'Reference test server exercising prompts, resources, and tools. Educational/demo; no external calls.',
    image: 'mcp/everything',
    license: 'Apache-2.0',
    maintainer: 'Anthropic (official)',
    egress: 'air-gap-safe',
    port: 8080,
    healthPath: '/',
    needsStorage: false,
  },
  // ── Tier 1 — Azure-internal / self-contained ──
  {
    id: 'playwright',
    name: 'Playwright',
    description: 'Browser automation, web scraping, screenshots, and accessibility testing. Bundled Chromium; self-contained.',
    image: 'mcr.microsoft.com/playwright/mcp',
    license: 'Apache-2.0',
    maintainer: 'Microsoft (official)',
    egress: 'azure-internal',
    port: 8080,
    healthPath: '/',
    needsStorage: false,
  },
  {
    id: 'azure',
    name: 'Azure MCP Server',
    description: 'Interact with Azure resources via natural language (list, modify, query). Uses the Azure Identity SDK — gov-cloud aware.',
    image: 'mcr.microsoft.com/azure-sdk/azure-mcp',
    license: 'MIT',
    maintainer: 'Microsoft (official)',
    egress: 'azure-internal',
    port: 8080,
    healthPath: '/',
    needsStorage: false,
  },
  // ── Tier 2 — external SaaS (require an approved egress path; secret-gated) ──
  {
    id: 'github',
    name: 'GitHub MCP Server',
    description: 'PR management, issue triage, code search, and CI/CD analysis. Calls github.com or a GitHub Enterprise endpoint.',
    image: 'mcp/github',
    license: 'MIT',
    maintainer: 'GitHub (vendor)',
    egress: 'external-saas',
    port: 8080,
    healthPath: '/',
    needsStorage: false,
    secretEnv: 'GITHUB_PERSONAL_ACCESS_TOKEN',
  },
  {
    id: 'brave-search',
    name: 'Brave Search MCP',
    description: 'Real-time web search via Brave’s independent index. Calls the Brave Search API over HTTPS.',
    image: 'mcp/brave-search',
    license: 'MIT',
    maintainer: 'Brave (vendor)',
    egress: 'external-saas',
    port: 8080,
    healthPath: '/',
    needsStorage: false,
    secretEnv: 'BRAVE_API_KEY',
  },
] as const;

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
  return MCP_CATALOG.map((e) => ({ ...e }));
}
