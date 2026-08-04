/**
 * PURE catalog + builder for the Loom MCP servers the extension contributes
 * (no `vscode` import) so the blast-radius policy is unit-testable without the
 * extension host. The thin `vscode`-facing wrapper (`mcp-provider.ts`) turns the
 * descriptors this file produces into `vscode.McpStdioServerDefinition`s.
 *
 * Phase 4 / PRP M1+M5: the extension registers the SHIPPED `apps/loom-mcp`
 * servers, split by blast radius, so a single leaked token never grants
 * everything:
 *
 *   • loom-catalog — read metadata            (safe, default ON)
 *   • loom-query   — read bounded data rows   (safe, default ON)
 *   • loom-author  — create/modify items      (WRITE — opt-in only)
 *   • loom-ops     — runs/logs + start/cancel (WRITE — opt-in only)
 *   • loom-admin   — provision/grant access   (ADMIN — opt-in only, default-OFF)
 *
 * The two read-only servers are the ONLY ones enabled by default. The write /
 * admin servers require an explicit user opt-in (the `loom.mcp.enabledServers`
 * setting, set via the `CSA Loom: Manage MCP servers` command). This module is
 * the single source of truth for that policy — the provider never emits a
 * server whose id is not in the caller-supplied `enabled` list.
 */

/** The five shipped `apps/loom-mcp` servers, by stdio bin id. */
export type McpServerId = 'loom-catalog' | 'loom-query' | 'loom-author' | 'loom-ops' | 'loom-admin';

export type McpScope = 'read-only' | 'read-write' | 'admin';

export interface McpServerSpec {
  id: McpServerId;
  /** The bundled entry basename shipped in the .vsix under `dist/mcp/`. */
  bundle: string;
  /** Human label shown in the client's MCP list. */
  label: string;
  /** One-line blast-radius description (mirrors `apps/loom-mcp/README.md`). */
  blastRadius: string;
  /** The `LOOM_TOKEN_SCOPE` the server needs (its authorization floor). */
  minScope: McpScope;
  /** true → a read-only server that is safe to enable by default. */
  safeDefault: boolean;
  /** true → the server contains at least one mutating tool. */
  writes: boolean;
  /** true → the admin server, which additionally needs `LOOM_MCP_ADMIN_ENABLED`. */
  requiresAdminEnv?: boolean;
}

/**
 * The server catalog, in blast-radius order. `bundle` names the esbuild output
 * the extension ships (see `build.mjs`, which bundles each `apps/loom-mcp`
 * server bin into `dist/mcp/<bundle>`).
 */
export const MCP_SERVERS: readonly McpServerSpec[] = [
  {
    id: 'loom-catalog',
    bundle: 'loom-catalog.mjs',
    label: 'Loom Catalog (read metadata)',
    blastRadius: 'Read metadata — workspaces, items, catalog search. No data rows, no writes.',
    minScope: 'read-only',
    safeDefault: true,
    writes: false,
  },
  {
    id: 'loom-query',
    bundle: 'loom-query.mjs',
    label: 'Loom Query (read data — bounded)',
    blastRadius: 'Read bounded, row/byte-capped data rows (SQL/KQL/preview). Read-only by construction.',
    minScope: 'read-only',
    safeDefault: true,
    writes: false,
  },
  {
    id: 'loom-author',
    bundle: 'loom-author.mjs',
    label: 'Loom Author (write — dry-run default)',
    blastRadius: 'WRITE — create/modify items (dry-run unless apply:true). Needs a read-write token.',
    minScope: 'read-write',
    safeDefault: false,
    writes: true,
  },
  {
    id: 'loom-ops',
    bundle: 'loom-ops.mjs',
    label: 'Loom Ops (runs/logs + start/cancel)',
    blastRadius: 'MIXED — read runs/logs, start/cancel runs. Write tools need a read-write token.',
    minScope: 'read-write',
    safeDefault: false,
    writes: true,
  },
  {
    id: 'loom-admin',
    bundle: 'loom-admin.mjs',
    label: 'Loom Admin (provision/grant — default-OFF)',
    blastRadius: 'ADMIN — grant access, resolve gates. Default-OFF; refuses a PAT server-side.',
    minScope: 'admin',
    safeDefault: false,
    writes: true,
    requiresAdminEnv: true,
  },
];

/** The blast-radius default: the two read-only servers, and ONLY those. */
export const DEFAULT_ENABLED_SERVERS: readonly McpServerId[] = MCP_SERVERS.filter(
  (s) => s.safeDefault,
).map((s) => s.id);

/** All ids (for the manage-servers picker). */
export const ALL_SERVER_IDS: readonly McpServerId[] = MCP_SERVERS.map((s) => s.id);

/** Look up a server spec by id. */
export function serverSpec(id: McpServerId): McpServerSpec | undefined {
  return MCP_SERVERS.find((s) => s.id === id);
}

/** The subset of the deployment model this module needs (avoids a config import cycle). */
export interface McpDeployment {
  id: string;
  name: string;
  apiUrl: string;
  cloud: string;
}

/**
 * A per-(deployment × server) definition descriptor — pure data, NO secret. The
 * token is injected later, at resolve time, by {@link resolveServerEnv}.
 */
export interface McpDefinitionDescriptor {
  deploymentId: string;
  deploymentName: string;
  apiUrl: string;
  cloud: string;
  server: McpServerSpec;
  /** Stable label shown in the MCP list AND used to look the descriptor back up at resolve. */
  label: string;
}

export interface BuildServerDefinitionsOptions {
  /** Server ids the user has enabled (from `loom.mcp.enabledServers`). */
  enabled: readonly McpServerId[];
}

/** The stable label for a descriptor — unique per (server, deployment). */
export function descriptorLabel(server: McpServerSpec, dep: McpDeployment): string {
  return `CSA Loom · ${server.id} · ${dep.name}`;
}

/**
 * Build the descriptor list for the given deployments, filtered to the enabled
 * server ids. A server whose id is NOT in `opts.enabled` is never emitted — this
 * is the blast-radius gate: with the default enabled set only the read-only
 * catalog/query servers are produced; author/ops/admin appear ONLY after an
 * explicit opt-in.
 */
export function buildServerDefinitions(
  deployments: readonly McpDeployment[],
  opts: BuildServerDefinitionsOptions,
): McpDefinitionDescriptor[] {
  const enabled = new Set(opts.enabled);
  const out: McpDefinitionDescriptor[] = [];
  for (const dep of deployments) {
    for (const server of MCP_SERVERS) {
      if (!enabled.has(server.id)) continue;
      out.push({
        deploymentId: dep.id,
        deploymentName: dep.name,
        apiUrl: dep.apiUrl,
        cloud: dep.cloud,
        server,
        label: descriptorLabel(server, dep),
      });
    }
  }
  return out;
}

/** The environment handed to a spawned Loom MCP server (mirrors `apps/loom-mcp` §Auth). */
export interface McpServerEnv {
  LOOM_API_URL: string;
  LOOM_TOKEN?: string;
  LOOM_TOKEN_SCOPE: McpScope;
  LOOM_MCP_ADMIN_ENABLED?: string;
}

/**
 * Resolve the spawn environment for a descriptor. The PAT is looked up BY THIS
 * DESCRIPTOR'S deployment id — so a token can never reach a server pointed at a
 * different deployment (the security invariant the unit test mutation-proves).
 *
 * `LOOM_API_URL` and `LOOM_TOKEN_SCOPE` are non-secret and always set; the token
 * is set only when one exists for that deployment (a PAT session). The admin
 * server additionally opts into `LOOM_MCP_ADMIN_ENABLED` (its own server-side
 * gate still refuses a PAT — this env only unlocks the local default-OFF check).
 */
export function resolveServerEnv(
  desc: McpDefinitionDescriptor,
  tokensByDeployment: Readonly<Record<string, string | undefined>>,
): McpServerEnv {
  const token = tokensByDeployment[desc.deploymentId];
  const env: McpServerEnv = {
    LOOM_API_URL: desc.apiUrl,
    LOOM_TOKEN_SCOPE: desc.server.minScope,
  };
  if (token) env.LOOM_TOKEN = token;
  if (desc.server.requiresAdminEnv) env.LOOM_MCP_ADMIN_ENABLED = '1';
  return env;
}

/** Coerce an arbitrary settings value into a valid, de-duplicated enabled-id list. */
export function coerceEnabledServers(raw: unknown): McpServerId[] {
  if (!Array.isArray(raw)) return [...DEFAULT_ENABLED_SERVERS];
  const valid = new Set(ALL_SERVER_IDS);
  const seen = new Set<McpServerId>();
  const out: McpServerId[] = [];
  for (const v of raw) {
    if (typeof v === 'string' && valid.has(v as McpServerId) && !seen.has(v as McpServerId)) {
      seen.add(v as McpServerId);
      out.push(v as McpServerId);
    }
  }
  return out;
}
