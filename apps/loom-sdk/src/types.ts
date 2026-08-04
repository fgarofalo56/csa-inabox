/**
 * Typed models for the Loom API, mirroring the shapes in the OpenAPI 3.1
 * contract (`GET /api/openapi.json`). Kept intentionally close to the wire so
 * the SDK stays a thin, predictable layer over the REST surface.
 */

/** The identity + token scope returned by `whoami()`. */
export interface WhoAmI {
  ok: true;
  auth: 'cookie' | 'pat';
  oid: string;
  upn?: string;
  name?: string;
  tenantId: string;
  /** Present only for a PAT session. */
  scope?: 'read-only' | 'read-write' | 'admin';
  /** Present only for a PAT session. */
  tokenId?: string;
}

export interface Workspace {
  id: string;
  name: string;
  description?: string;
  capacity?: string;
  domain?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Present only when listing with `{ count: true }`. */
  itemCount?: number;
}

export interface CreateWorkspaceInput {
  name: string;
  description?: string;
  capacity?: string;
  /** Governance domain id (defaults server-side to `default`). */
  domain?: string;
}

export interface Item {
  id: string;
  workspaceId: string;
  itemType: string;
  displayName: string;
  description?: string;
  state?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateItemInput {
  itemType: string;
  displayName: string;
  description?: string;
}

/** Body for the type-scoped create route (`POST /api/cosmos-items/{type}`). */
export interface CreateByTypeInput {
  workspaceId: string;
  displayName: string;
  description?: string;
  /** Initial item definition/state (structured; the route stores it verbatim). */
  state?: Record<string, unknown>;
}

export interface UpdateItemInput {
  displayName?: string;
  description?: string;
  state?: Record<string, unknown>;
}

export interface CatalogHit {
  source: 'purview' | 'unity-catalog' | 'onelake';
  id: string;
  display_name: string;
  type: string;
  description?: string;
  owner?: string;
  workspace_name?: string;
  workspace_id?: string;
  domain?: string;
}

export interface CatalogSearchResult {
  ok: boolean;
  total?: number;
  hits: CatalogHit[];
  sources?: Record<string, { ok: boolean; count?: number; error?: string; hint?: string }>;
}

export interface CatalogSearchOptions {
  /** Comma-separated or array source filter: purview, unity-catalog, onelake. */
  source?: string | string[];
  /** Per-source result cap (max 100). */
  limit?: number;
}

/** A Loom Thread (Weave) lineage edge. Shape is open — from → to metadata. */
export type ThreadEdge = Record<string, unknown>;

export type TokenScope = 'read-only' | 'read-write' | 'admin';

export interface TokenView {
  id: string;
  name: string;
  scope: TokenScope;
  createdByUpn?: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
  revoked: boolean;
  expired: boolean;
}

export interface CreateTokenInput {
  name: string;
  scope: TokenScope;
  /** Lifetime in days (default 30, max 90). */
  ttlDays?: number;
}

export interface CreateTokenResult {
  ok: boolean;
  /** The full token string — shown ONCE, unrecoverable after. */
  token: string;
  tokenInfo: TokenView;
}

/** Result of a session-minting auth flow. */
export interface SessionResult {
  cookie: string;
  expiresAt: number;
  claims?: { oid?: string; name?: string; upn?: string; email?: string };
}

// ─── Admin (M5 loom-admin escalation surface) ────────────────────────────────
// These wrap the Console's real, server-side-guarded admin routes. The BFF is
// the authoritative escalation boundary — each route re-checks tenant/workspace
// admin (`isTenantAdmin` / `enforceCapability` / PDP) and caps the grant to the
// caller's own rights server-side. The SDK is a thin, typed caller.

/** Principal kind for a workspace role assignment. */
export type WorkspacePrincipalType = 'User' | 'Group' | 'ServicePrincipal';
/** Workspace RBAC role names (`POST /api/workspaces/{id}/role-assignments`). */
export type WorkspaceRoleName = 'Admin' | 'Member' | 'Contributor' | 'Viewer';

export interface AssignWorkspaceRoleInput {
  principalId: string;
  principalType: WorkspacePrincipalType;
  displayName: string;
  role: WorkspaceRoleName;
}

/** Feature-capability role (`POST /api/admin/permissions/grants`). */
export type FeatureRole = 'Reader' | 'Contributor' | 'Admin';

export interface GrantCapabilityInput {
  capabilityId: string;
  principalId: string;
  /** `user` (default) or `group`. */
  principalType?: 'user' | 'group';
  role: FeatureRole;
  principalDisplayName?: string;
  principalUpn?: string;
}

/** Open result shapes — the admin routes return heterogeneous envelopes. */
export type AdminResult = { ok: boolean; [k: string]: unknown };
