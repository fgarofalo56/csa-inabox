/**
 * Databricks **account-plane** Unity Catalog client.
 *
 * ---------------------------------------------------------------------------
 * Why a separate client from unity-catalog-client.ts
 * ---------------------------------------------------------------------------
 * unity-catalog-client.ts talks to the **workspace** host
 * (`adb-….azuredatabricks.net`) over the UC REST 2.1 surface. That surface can
 * only *read* the single metastore already assigned to the workspace — it
 * cannot *assign* one. Metastore assignment is an **account-level** operation
 * that lives on a completely different plane:
 *
 *   host:  https://accounts.azuredatabricks.net   (Commercial)
 *   base:  /api/2.0/accounts/{account_id}
 *
 * The caller must be a **Databricks account admin** (or metastore admin). This
 * is the same REST the bundled `scripts/csa-loom/enable-unity-catalog.sh` uses:
 *
 *   GET  /api/2.0/accounts/{id}/metastores
 *        → every metastore in the account
 *   GET  /api/2.0/accounts/{id}/workspaces/{wsId}/metastore
 *        → the assignment for one workspace (404 when none assigned)
 *   PUT  /api/2.0/accounts/{id}/workspaces/{wsId}/metastore
 *        body {metastore_id, default_catalog_name}
 *        → assign / re-assign (idempotent — an existing assignment is
 *          overwritten). "the caller must be an account admin."
 *
 * Grounded in:
 *   https://learn.microsoft.com/azure/databricks/dev-tools/cli/reference/account-metastore-assignments-commands
 *   https://learn.microsoft.com/azure/databricks/dev-tools/cli/reference/account-metastores-commands
 *
 * Auth: same chained MI + DefaultAzureCredential as unity-catalog-client.ts,
 * Databricks resource scope (`2ff814a6-…/.default`). The account id comes from
 * `LOOM_DATABRICKS_ACCOUNT_ID`; the host can be overridden with
 * `LOOM_DATABRICKS_ACCOUNT_HOST` for sovereign clouds.
 *
 * No mocks, no `return []` placeholders. Every export hits the real account API
 * or throws a typed error carrying an honest gate (per .claude/rules/no-vaporware.md).
 */
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';

const DBX_SCOPE = '2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

// ============================================================
// Errors
// ============================================================

export interface UnityCatalogAccountNotConfiguredHint {
  missingEnvVar: string;
  bicepModule: string;
  bicepStatus: string;
  followUp: string;
}

/** Thrown when `LOOM_DATABRICKS_ACCOUNT_ID` is not set. The BFF translates this
 *  into an honest MessageBar — metastore *assignment* is opt-in (the registration
 *  still persists + lists catalogs without it). */
export class UnityCatalogAccountNotConfiguredError extends Error {
  hint: UnityCatalogAccountNotConfiguredHint;
  constructor(hint: UnityCatalogAccountNotConfiguredHint) {
    super(`Databricks account API not configured: missing ${hint.missingEnvVar}`);
    this.name = 'UnityCatalogAccountNotConfiguredError';
    this.hint = hint;
  }
}

export class UnityCatalogAccountError extends Error {
  status: number;
  body?: unknown;
  endpoint?: string;
  /** True when the error is a "caller is not an account admin" 403. */
  accountAdmin: boolean;
  constructor(message: string, status: number, body?: unknown, endpoint?: string) {
    super(message);
    this.name = 'UnityCatalogAccountError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
    this.accountAdmin =
      status === 403 && /account.?admin/i.test(message || '');
  }
}

// ============================================================
// Configuration
// ============================================================

function notConfiguredHint(): UnityCatalogAccountNotConfiguredHint {
  return {
    missingEnvVar: 'LOOM_DATABRICKS_ACCOUNT_ID',
    bicepModule: 'platform/fiab/bicep/modules/admin-plane/main.bicep (apps[].env)',
    bicepStatus:
      'Metastore assignment is an account-level operation. Set LOOM_DATABRICKS_ACCOUNT_ID to the ' +
      'Databricks account GUID (find it at accounts.azuredatabricks.net → top-right → Account). ' +
      'The Loom UAMI must be a Databricks account admin (or metastore admin) for assignment to succeed.',
    followUp:
      'Set LOOM_DATABRICKS_ACCOUNT_ID on the Console Container App, then add the Loom UAMI as a ' +
      'Databricks account admin via scripts/csa-loom/enable-unity-catalog.sh (or the account console). ' +
      'Without it, the workspace registration still persists and lists catalogs — only the one-click ' +
      'metastore *attach* is unavailable.',
  };
}

/** True when the account API is configured (does NOT prove the UAMI is an admin). */
export function isAccountApiConfigured(): boolean {
  return !!process.env.LOOM_DATABRICKS_ACCOUNT_ID;
}

function accountId(): string {
  const v = process.env.LOOM_DATABRICKS_ACCOUNT_ID;
  if (!v) throw new UnityCatalogAccountNotConfiguredError(notConfiguredHint());
  return v.trim();
}

/** Databricks account control-plane host. Defaults to the Commercial host;
 *  `LOOM_DATABRICKS_ACCOUNT_HOST` overrides for sovereign clouds. */
function accountHost(): string {
  return (process.env.LOOM_DATABRICKS_ACCOUNT_HOST || 'accounts.azuredatabricks.net')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
}

async function dbxToken(): Promise<string> {
  const t = await credential.getToken(DBX_SCOPE);
  if (!t?.token) throw new UnityCatalogAccountError('Failed to acquire Databricks AAD token', 401);
  return t.token;
}

async function acctFetch<T = any>(
  path: string,
  init?: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown },
): Promise<T> {
  const token = await dbxToken();
  const url = `https://${accountHost()}/api/2.0/accounts/${accountId()}${path}`;
  const res = await fetch(url, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    const msg =
      json?.message ||
      json?.error_code ||
      (typeof json === 'string' ? json : `${init?.method ?? 'GET'} ${path} failed ${res.status}`);
    throw new UnityCatalogAccountError(msg, res.status, json, url);
  }
  return (json as T) ?? ({} as T);
}

// ============================================================
// Types
// ============================================================

export interface AccountMetastore {
  metastore_id: string;
  name: string;
  region?: string;
  storage_root?: string;
  owner?: string;
  cloud?: string;
  created_at?: number;
}

export interface MetastoreAssignment {
  workspace_id: string;
  metastore_id: string;
  default_catalog_name?: string;
}

// ============================================================
// Account metastores + assignment
// ============================================================

/** GET /metastores — every metastore in the Databricks account. Requires the
 *  caller to be an account admin; a 403 surfaces as `UnityCatalogAccountError`
 *  with `.accountAdmin === true`. */
export async function listAccountMetastores(): Promise<AccountMetastore[]> {
  const j = await acctFetch<{ metastores?: any[] }>('/metastores');
  return (j.metastores || []).map((m) => ({
    metastore_id: m.metastore_id,
    name: m.name,
    region: m.region,
    storage_root: m.storage_root,
    owner: m.owner,
    cloud: m.cloud,
    created_at: m.created_at,
  }));
}

/** GET /workspaces/{wsId}/metastore — the metastore currently assigned to a
 *  workspace. Returns null when none is assigned (the API 404s). */
export async function getWorkspaceMetastoreAssignment(
  workspaceId: string | number,
): Promise<MetastoreAssignment | null> {
  if (!workspaceId) throw new UnityCatalogAccountError('workspaceId is required', 400);
  try {
    const j = await acctFetch<any>(`/workspaces/${workspaceId}/metastore`);
    const a = j?.metastore_assignment || j;
    if (!a?.metastore_id) return null;
    return {
      workspace_id: String(a.workspace_id ?? workspaceId),
      metastore_id: a.metastore_id,
      default_catalog_name: a.default_catalog_name,
    };
  } catch (e) {
    if (e instanceof UnityCatalogAccountError && e.status === 404) return null;
    throw e;
  }
}

/**
 * PUT /workspaces/{wsId}/metastore — attach (or re-attach) a workspace to a UC
 * metastore. Idempotent: "If an assignment for the same workspace_id exists, it
 * will be overwritten." The caller must be a Databricks account admin.
 *
 * Mirrors the REST body used by scripts/csa-loom/enable-unity-catalog.sh:
 *   {metastore_id, default_catalog_name}
 */
export async function assignMetastore(
  workspaceId: string | number,
  metastoreId: string,
  defaultCatalog = 'main',
): Promise<MetastoreAssignment> {
  if (!workspaceId) throw new UnityCatalogAccountError('workspaceId is required', 400);
  if (!metastoreId) throw new UnityCatalogAccountError('metastoreId is required', 400);
  await acctFetch(`/workspaces/${workspaceId}/metastore`, {
    method: 'PUT',
    body: { metastore_id: metastoreId, default_catalog_name: defaultCatalog },
  });
  return { workspace_id: String(workspaceId), metastore_id: metastoreId, default_catalog_name: defaultCatalog };
}
