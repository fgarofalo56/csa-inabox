/**
 * `@csa-loom/mcp` core — the shared foundation every Loom MCP server is built
 * on. M1 `loom-catalog` (read-only) is the first consumer; M2–M5 reuse this
 * same surface.
 */
export { createLoomMcpServer, type CreateServerOptions } from './server.js';
export { buildToolHandler, type ToolHandler, type ToolHandlerOptions } from './tool.js';
export { authorize, scopeSatisfies, type AuthzDecision } from './authz.js';
export { resolveAuth, patPrincipal, isTransportAllowed, type ResolveAuthOptions } from './auth.js';
export { scrub, scrubString, isSecretKey } from './scrub.js';
export { normalizeError, toErrorResult, errorResult, type NormalizedError } from './errors.js';
export { emitAudit, hashArgs, stderrAuditSink } from './audit.js';
export {
  loadProfile,
  listProfiles,
  isExpired,
  normalizeApiUrl,
  loomHome,
  type StoredProfile,
} from './credential-store.js';
export type { AuthContext, AuditEvent, AuditSink, ToolResult, ToolSpec, TokenScope } from './types.js';
