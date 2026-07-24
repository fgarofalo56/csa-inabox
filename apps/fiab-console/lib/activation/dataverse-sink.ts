/**
 * N7c — Dataverse activation sink (real S2S Web API writes).
 *
 * Pushes activated rows INTO Dataverse/Dynamics with idempotent upserts. The
 * upsert is a PATCH to `entityset(<keyAttribute>='<value>')`: Dataverse creates
 * the row when the key value is new and updates it when it exists (the platform's
 * native Upsert). Re-running the same batch is a no-op — the same key PATCHes to
 * the same state — so a retried or replayed sync never duplicates rows. Deletes
 * (CDF `delete` change rows) issue a DELETE on the same key URL and tolerate a
 * 404 (already gone) so they are idempotent too.
 *
 * Auth reuses the estate's already-wired Dataverse Application User: a
 * confidential SP (LOOM_DATAVERSE_CLIENT_ID/_SECRET/_TENANT_ID, falling back to
 * the registered MSAL Web App SP) — UAMI tokens are not valid Dataverse
 * Application Users (Microsoft platform restriction), which is exactly why the
 * powerplatform-client uses the same SP for every `<org>.crm.dynamics.com`
 * scope. The environment's org URL is resolved from the BAP admin API via the
 * shared `getEnvironment`.
 *
 * IL5: a real Dynamics/Dataverse org is a SaaS destination — honest-gated
 * (dataverseConfigGate + a 401/403 remediation hint), never required for the
 * item to exist or for the webhook / Event Grid / Service Bus destinations to
 * run air-gapped.
 */

import { ClientSecretCredential, type TokenCredential } from '@azure/identity';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { getEnvironment, dataverseConfigGate } from '@/lib/azure/powerplatform-client';
import { escapeSqlLiteral } from '@/lib/sql/quoting';

const DATAVERSE_API = 'v9.2';

/** Thrown when a Dataverse write fails; carries the status for the BFF layer. */
export class DataverseSinkError extends Error {
  status: number;
  hint?: string;
  constructor(message: string, status: number, hint?: string) {
    super(message);
    this.name = 'DataverseSinkError';
    this.status = status;
    this.hint = hint;
  }
}

/** Build the SP credential the same way powerplatform-client does for Dataverse. */
function dataverseCredential(): TokenCredential | null {
  const clientId = process.env.LOOM_DATAVERSE_CLIENT_ID || process.env.LOOM_MSAL_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.LOOM_DATAVERSE_CLIENT_SECRET || process.env.LOOM_MSAL_CLIENT_SECRET || process.env.AZURE_CLIENT_SECRET;
  const tenantId = process.env.LOOM_DATAVERSE_TENANT_ID || process.env.AZURE_TENANT_ID;
  if (clientId && clientSecret && tenantId) return new ClientSecretCredential(tenantId, clientId, clientSecret);
  return null;
}

/** Format an alternate-key value for the URL: quote strings, leave numbers bare. */
export function formatKeyValue(value: unknown): string {
  if (value === null || value === undefined) return "''";
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  // String (and everything else) — single-quote and URL-encode, doubling any
  // embedded single quote per OData literal rules.
  // OData $filter single-quote doubling is byte-identical to the SQL rule, so
  // reuse the central escaper (sql-quoting guard RULE A forbids inline copies).
  const s = escapeSqlLiteral(String(value));
  return `'${encodeURIComponent(s)}'`;
}

/** A single upsert/delete unit the engine hands to the sink. */
export interface DataverseWriteRow {
  /** The alternate-key value (from the mapped keyColumn). */
  keyValue: unknown;
  /** Mapped attribute → value payload (already renamed to Dataverse field names). */
  fields: Record<string, unknown>;
  /** 'delete' issues a DELETE; anything else upserts. */
  op: 'upsert' | 'delete';
}

export interface DataverseSinkConfig {
  environmentId: string;
  entitySetName: string;
  keyAttribute: string;
  /** Optional pre-resolved org URL to skip the BAP round-trip. */
  instanceUrl?: string;
}

export interface DataverseSinkResult {
  upserts: number;
  deletes: number;
  errors: number;
  /** First error message (for the run detail) — full set is logged upstream. */
  firstError?: string;
}

/** Injectable seams so the engine's Dataverse path is unit-testable. */
export interface DataverseSinkDeps {
  fetchImpl?: typeof fetch;
  getToken?: (scope: string) => Promise<string>;
  resolveInstanceUrl?: (environmentId: string) => Promise<string>;
}

async function defaultInstanceUrl(environmentId: string): Promise<string> {
  const env = await getEnvironment(environmentId);
  const url = env.instanceUrl?.replace(/\/$/, '');
  if (!url) {
    throw new DataverseSinkError(
      `Power Platform environment ${environmentId} has no Dataverse instance — pick an environment with Dataverse provisioned.`,
      404,
      'Create or select a Dataverse-enabled environment in the Power Platform admin centre.',
    );
  }
  return url;
}

async function defaultToken(scope: string): Promise<string> {
  const cred = dataverseCredential();
  if (!cred) {
    const gate = dataverseConfigGate();
    throw new DataverseSinkError(
      `Dataverse is not configured for writes: set ${gate?.missing || 'LOOM_DATAVERSE_CLIENT_ID / _CLIENT_SECRET'}.`,
      503,
      'The Dataverse Application User SP (LOOM_DATAVERSE_CLIENT_ID/_SECRET/_TENANT_ID, or the MSAL Web App SP fallback) must be registered as an Application User with a write role on the target environment.',
    );
  }
  const t = await cred.getToken(scope);
  if (!t?.token) throw new DataverseSinkError('Failed to acquire a Dataverse token.', 401);
  return t.token;
}

/**
 * Apply a batch of upsert/delete rows to Dataverse. Rows are applied
 * sequentially (each is an independent, idempotent PATCH/DELETE) and per-row
 * failures are counted rather than aborting the whole run — a poison row must
 * not strand the rest of a batch. A hard auth/config failure (401/403/503)
 * throws so the run reports an honest gate.
 */
export async function writeToDataverse(
  config: DataverseSinkConfig,
  rows: DataverseWriteRow[],
  deps: DataverseSinkDeps = {},
): Promise<DataverseSinkResult> {
  const fetchImpl = deps.fetchImpl ?? ((url: any, init?: any) => fetchWithTimeout(url, init));
  const resolveInstanceUrl = deps.resolveInstanceUrl ?? defaultInstanceUrl;
  const getToken = deps.getToken ?? defaultToken;

  const instanceUrl = (config.instanceUrl?.replace(/\/$/, '')) || (await resolveInstanceUrl(config.environmentId));
  const scope = `${instanceUrl}/.default`;
  const token = await getToken(scope); // throws on hard auth/config failure

  const result: DataverseSinkResult = { upserts: 0, deletes: 0, errors: 0 };
  const base = `${instanceUrl}/api/data/${DATAVERSE_API}`;

  for (const row of rows) {
    const keyExpr = `${config.keyAttribute}=${formatKeyValue(row.keyValue)}`;
    const url = `${base}/${config.entitySetName}(${keyExpr})`;
    try {
      if (row.op === 'delete') {
        const res = await fetchImpl(url, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          cache: 'no-store',
        } as RequestInit);
        if (res.ok || res.status === 404) { result.deletes += 1; }
        else { result.errors += 1; result.firstError ??= await shortError(res); }
      } else {
        const res = await fetchImpl(url, {
          method: 'PATCH',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json',
            'OData-MaxVersion': '4.0', 'OData-Version': '4.0',
          },
          body: JSON.stringify(row.fields),
          cache: 'no-store',
        } as RequestInit);
        // 204 (updated) / 201 (created) are both success for an upsert.
        if (res.ok || res.status === 204 || res.status === 201) { result.upserts += 1; }
        else if (res.status === 401 || res.status === 403) {
          throw new DataverseSinkError(
            await shortError(res),
            res.status,
            'The Dataverse Application User SP must hold a role (System Customizer / a custom role) granting write on this table in the target environment.',
          );
        } else { result.errors += 1; result.firstError ??= await shortError(res); }
      }
    } catch (e) {
      if (e instanceof DataverseSinkError) throw e; // hard gate — stop the run
      result.errors += 1;
      result.firstError ??= (e as Error)?.message || String(e);
    }
  }
  return result;
}

async function shortError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* text */ }
  return (json?.error?.message || json?.message || text || `HTTP ${res.status}`).toString().slice(0, 300);
}
