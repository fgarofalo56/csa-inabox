/**
 * User Power BI-token store — caches the signed-in user's Power BI / Fabric
 * data-plane access token (the `https://analysis.windows.net/powerbi/api`
 * audience) so the remote Power BI MCP server can be called On-Behalf-Of the
 * USER's own identity (their Power BI RBAC) instead of the Loom console
 * service principal/UAMI.
 *
 * This is the Power BI-audience sibling of `user-token-store.ts` (ARM audience)
 * and `sql-user-token-store.ts` (Azure SQL audience). All three live in the
 * same Cosmos `tenant-settings` container to avoid provisioning another
 * container — they differ only by doc id prefix and `kind`.
 *
 * WHERE IT FITS (the shared contract):
 *   - The "Power BI (remote)" REMOTE_BUILTIN_MCP catalog entry (lib/mcp/catalog.ts)
 *     registers an McpServerConfig row with authMethod 'entra-obo', oboResource
 *     'https://analysis.windows.net/powerbi/api' and the three delegated scopes
 *     (Dataset.Read.All / MLModel.Execute.All / Workspace.Read.All).
 *   - At login (app/auth/callback) acquireTokenSilent is run against those PBI
 *     delegated scopes (only when LOOM_POWERBI_MCP_CLIENT_ID is set) and the
 *     resulting token is persisted here via savePbiUserToken.
 *   - At chat time buildMcpShim resolves getPbiUserToken(oid) for every
 *     entra-obo server and threads it through listMcpTools/callMcpTool as the
 *     per-user `userToken`; mcp-client sends it as `Bearer <token>` on the real
 *     Streamable-HTTP call to the PBI MCP endpoint. No mock — a missing/expired
 *     token surfaces an honest "sign in again / consent Power BI scopes" gate.
 *
 * OPT-IN / NO-FABRIC: this store only ever holds a token when the operator has
 * explicitly opted into the Power BI remote MCP (LOOM_POWERBI_MCP_CLIENT_ID set
 * + the PBI tenant setting enabled). On the default code path no PBI scope is
 * requested, nothing is cached here, and the Azure-native semantic-model/report
 * authoring path is used. This file never reaches a Fabric/Power BI host itself
 * — it only caches the delegated token the MCP client later presents.
 *
 * SECURITY:
 *   - The token is encrypted AT REST with AES-256-GCM (a key derived from
 *     SESSION_SECRET via a distinct HKDF label — see lib/auth/session.ts).
 *   - It is NEVER returned to the browser; only server-side MCP/copilot code
 *     calls getPbiUserToken() and hands it straight to the outbound MCP request.
 *   - It is NEVER logged.
 *
 * STORAGE: one doc per user in the Cosmos `tenant-settings` container
 * (partition key /tenantId), id `pbiusertoken:<oid>`, partition = oid (same
 * partition-by-oid trick the ARM + SQL token stores use).
 *
 * EXPIRY: Power BI access tokens live ~60–90 min. We store the expiry and treat
 * the token as missing once it's within a 60s safety margin of expiring, so
 * callers surface an honest "sign in again" gate rather than failing mid-call.
 *
 * BEST-EFFORT WRITE: savePbiUserToken swallows its own errors and degrades to
 * "no cached token" rather than throwing — the auth callback MUST keep working
 * (login succeeds) even when the PBI scope wasn't consented or Cosmos is down.
 */
import { tenantSettingsContainer } from './cosmos-client';
import { encryptAtRest, decryptAtRest } from '@/lib/auth/session';

const SAFETY_MARGIN_MS = 60_000;

interface PbiUserTokenDoc {
  id: string; // pbiusertoken:<oid>
  tenantId: string; // == oid (partition key)
  kind: 'pbiusertoken';
  enc: string; // AES-256-GCM(base64url) of the raw Power BI access token
  expiresOn: number; // unix ms — when the token itself expires
  updatedAt: string;
}

function docId(oid: string): string {
  return `pbiusertoken:${oid}`;
}

/**
 * Persist the user's Power BI delegated access token (encrypted) for later
 * server-side use by the remote Power BI MCP client. Best-effort: returns false
 * instead of throwing on any failure so the auth callback can proceed with
 * login regardless of whether the PBI scope was consented.
 */
export async function savePbiUserToken(
  oid: string,
  token: string,
  expiresOn: Date | number | null | undefined,
): Promise<boolean> {
  if (!oid || !token) return false;
  try {
    const expMs =
      expiresOn instanceof Date
        ? expiresOn.getTime()
        : typeof expiresOn === 'number'
          ? expiresOn
          : Date.now() + 60 * 60 * 1000; // default 60m if MSAL didn't give one
    const c = await tenantSettingsContainer();
    const doc: PbiUserTokenDoc = {
      id: docId(oid),
      tenantId: oid,
      kind: 'pbiusertoken',
      enc: encryptAtRest(token),
      expiresOn: expMs,
      updatedAt: new Date().toISOString(),
    };
    await c.items.upsert(doc);
    return true;
  } catch {
    // Never surface — login must not break on a cache write failure.
    return false;
  }
}

/**
 * Return a still-valid cached Power BI access token for the user, or null if
 * there is no token, it's expired (within the safety margin), or anything goes
 * wrong. The raw token is decrypted only here, server-side, and handed straight
 * to the outbound Power BI MCP request (Authorization: Bearer) by the caller —
 * a null result is the signal for the honest "sign in again / consent Power BI
 * scopes" MessageBar gate.
 */
export async function getPbiUserToken(oid: string): Promise<string | null> {
  if (!oid) return null;
  try {
    const c = await tenantSettingsContainer();
    const { resource } = await c.item(docId(oid), oid).read<PbiUserTokenDoc>();
    if (!resource || resource.kind !== 'pbiusertoken') return null;
    if (!resource.expiresOn || resource.expiresOn - SAFETY_MARGIN_MS <= Date.now()) return null;
    const tok = decryptAtRest(resource.enc);
    return tok || null;
  } catch {
    return null;
  }
}
