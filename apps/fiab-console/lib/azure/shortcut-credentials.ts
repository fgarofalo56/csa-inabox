/**
 * Shortcut credential resolution + external-binding helpers.
 *
 * This module closes the read-through binding for external cloud sources
 * (S3 / GCS / Dataverse) on a lakehouse shortcut:
 *
 *   1. Resolve the operator-provisioned secret from Azure Key Vault using the
 *      Console UAMI (Key Vault Secrets User on the vault). Data-plane REST:
 *      GET https://<vault>.vault.azure.net/secrets/<name>?api-version=7.4
 *      (scope https://vault.azure.net/.default). No extra SDK package — uses
 *      @azure/identity (already a dependency) + fetch.
 *
 *   2. Materialise the real external binding on the configured engine:
 *      - Databricks Unity Catalog: a STORAGE CREDENTIAL (AWS IAM role / GCP
 *        service-account key) + an EXTERNAL LOCATION over the s3:// / gs://
 *        prefix, both via the UC REST API. The caller then creates the
 *        EXTERNAL TABLE on top via the normal SQL path.
 *          POST /api/2.1/unity-catalog/storage-credentials
 *          POST /api/2.1/unity-catalog/external-locations
 *        Learn: https://learn.microsoft.com/azure/databricks/connect/unity-catalog/cloud-storage/
 *               https://learn.microsoft.com/azure/databricks/dev-tools/cli/reference/account-storage-credentials-commands
 *      - Synapse Serverless: a DATABASE SCOPED CREDENTIAL ('S3 Access Key')
 *        + an EXTERNAL DATA SOURCE over the s3:// prefix (done in
 *        shortcut-engines.ts; this module only resolves the secret).
 *          Learn: https://learn.microsoft.com/sql/relational-databases/polybase/polybase-configure-s3-compatible
 *
 * Every call hits a real Azure backend. No mock data. Per
 * .claude/rules/no-vaporware.md.
 *
 * ## The Unity Catalog exits here are AUDITED — at this transport (#2622)
 *
 * `securableFetch` below issues the storage-credential + external-location
 * CREATE/DELETE. Those are the securables that hand a workload the right to read
 * a cloud storage account, so every one of them records a Unity Catalog audit row
 * via `recordUnitySecurableAccess` from a `finally` — success, failure, or
 * DENIED. A `catch`-shaped implementation would drop exactly the 403 an ATO
 * reviewer hunts for, which is why it is a `finally`.
 *
 * For three rounds this instrumentation lived one layer up, in the
 * `lib/azure/uc-securable.ts` FACADE, because the recorder could not be added
 * inside this file. That facade REMAINS, and is still the only module permitted
 * to import a UC-mutating symbol from here (guard check 8). The two do not
 * double-record: the facade runs each call inside the async context in
 * `lib/azure/securable-audit-context.ts`, and this transport suppresses its own
 * row inside that context. Suppression is opt-IN, so a future export added here
 * is audited by DEFAULT rather than by having been anticipated — which is the
 * entire reason the transport is instrumented at all. See that module for why it
 * is an async context rather than a parameter or a flag.
 *
 * WHY BOTH LAYERS EXIST. The facade wraps the whole export and therefore sees
 * the POST-RESPONSE outcome: `ucJsonOrThrow` treats a 409 ALREADY_EXISTS as a
 * successful idempotent re-create, and a DELETE tolerates 404. This transport
 * cannot know either without reading the response body, and reading it would
 * consume the stream the caller is about to parse. So the facade's row is the
 * higher-fidelity one and it wins where it applies; this transport's row is the
 * floor that catches everything else.
 *
 * NOTHING FROM AN UPSTREAM ERROR BODY REACHES THE ROW. A Unity Catalog 400
 * routinely echoes the request that caused it, and `ensureUcGcpStorageCredential`
 * POSTs a service-account `private_key`. A mutation row fans out to
 * tenant-registered outbound webhooks (third-party URLs), so
 * `recordUnitySecurableAccess` stamps the extracted STATUS CODE only — see
 * `lib/azure/unity-audit.ts` § 3d.
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { recordUnitySecurableAccess } from '@/lib/azure/unity-audit';
import { securableRecordedByCaller } from '@/lib/azure/securable-audit-context';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
  type TokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: TokenCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

const KV_SCOPE = 'https://vault.azure.net/.default';
const KV_API_VERSION = '7.4';
const DBX_SCOPE = '2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/.default';

/** Honest gate when the Key Vault holding shortcut secrets isn't configured. */
export function keyVaultConfigGate(): { missing: string } | null {
  if (!process.env.LOOM_KEY_VAULT_URI && !process.env.LOOM_KEY_VAULT_NAME) {
    return { missing: 'LOOM_KEY_VAULT_URI (or LOOM_KEY_VAULT_NAME)' };
  }
  return null;
}

/** Resolve the vault base URL from LOOM_KEY_VAULT_URI or LOOM_KEY_VAULT_NAME. */
function vaultBaseUrl(): string {
  const uri = process.env.LOOM_KEY_VAULT_URI;
  if (uri) return uri.replace(/\/+$/, '');
  const name = process.env.LOOM_KEY_VAULT_NAME;
  if (name) return `https://${name}.vault.azure.net`;
  throw Object.assign(
    new Error('Key Vault not configured — set LOOM_KEY_VAULT_URI or LOOM_KEY_VAULT_NAME'),
    { code: 'kv_not_configured' },
  );
}

/**
 * Read a Key Vault secret's value via the data-plane REST API on the Console
 * UAMI. The UAMI must have the "Key Vault Secrets User" role on the vault.
 * Throws with code 'kv_secret_unreachable' (403/404 surfaced verbatim).
 */
export async function getKeyVaultSecret(secretName: string): Promise<string> {
  const base = vaultBaseUrl();
  const token = await credential.getToken(KV_SCOPE);
  if (!token?.token) {
    throw Object.assign(new Error('Failed to acquire Key Vault AAD token'), { code: 'kv_token' });
  }
  const url = `${base}/secrets/${encodeURIComponent(secretName)}?api-version=${KV_API_VERSION}`;
  const res = await fetchWithTimeout(url, { headers: { authorization: `Bearer ${token.token}` } });
  if (!res.ok) {
    const text = await res.text();
    throw Object.assign(
      new Error(`Key Vault secret '${secretName}' unreachable ${res.status}: ${text.slice(0, 300)}`),
      { code: res.status === 403 ? 'kv_forbidden' : 'kv_secret_unreachable', status: res.status },
    );
  }
  const body = (await res.json()) as { value?: string };
  if (typeof body.value !== 'string') {
    throw Object.assign(new Error(`Key Vault secret '${secretName}' has no value`), { code: 'kv_empty' });
  }
  return body.value;
}

// ============================================================
// Databricks Unity Catalog — storage credential + external location (REST)
// ============================================================

function dbxHost(): string {
  const h = process.env.LOOM_DATABRICKS_HOSTNAME;
  if (!h) throw Object.assign(new Error('LOOM_DATABRICKS_HOSTNAME not configured'), { code: 'dbx_not_configured' });
  return h.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

async function dbxToken(): Promise<string> {
  const t = await credential.getToken(DBX_SCOPE);
  if (!t?.token) throw new Error('Failed to acquire Databricks AAD token');
  return t.token;
}

/**
 * The Unity Catalog transport for this module — and the audited choke point for
 * its securable exits (issue #2622, gap 1 residual).
 *
 * The recorder is called from `finally`, so a refusal produces a row even though
 * this function's caller re-throws. `fetchWithTimeout` resolves on a 4xx/5xx
 * rather than throwing, so a non-ok response is reported here as the failure —
 * carrying ONLY the status code, which is the one thing this layer actually
 * established about it. Nothing is read from the body: the caller has not parsed
 * it yet, and it may echo a posted credential.
 *
 * `target` is the securable NAME from the caller's structured params. A CREATE
 * POSTs to the COLLECTION, so the path carries no name and this is the only place
 * the target can come from — it is never parsed out of a response or an error.
 */
async function securableFetch(path: string, init: RequestInit | undefined, target: string): Promise<Response> {
  const startedAt = Date.now();
  let res: Response | undefined;
  let failure: unknown;
  try {
    const token = await dbxToken();
    res = await fetchWithTimeout(`https://${dbxHost()}${path}`, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
    });
    return res;
  } catch (e) {
    failure = e;
    throw e;
  } finally {
    if (!securableRecordedByCaller()) {
      recordUnitySecurableAccess({
        path,
        method: init?.method || 'GET',
        target,
        durationMs: Date.now() - startedAt,
        error: failure ?? (res && !res.ok ? { status: res.status } : undefined),
      });
    }
  }
}

async function ucJsonOrThrow<T>(res: Response, op: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    // UC returns 409 ...ALREADY_EXISTS for idempotent re-create — treat as success.
    if (res.status === 409 && /already.?exist/i.test(text)) {
      return {} as T;
    }
    throw Object.assign(new Error(`${op} failed ${res.status}: ${text.slice(0, 400)}`), {
      status: res.status,
      body: text,
    });
  }
  return (text ? JSON.parse(text) : ({} as T)) as T;
}

/** AWS IAM-role storage credential — the read-only S3 cross-cloud pattern. */
export interface UcAwsStorageCredentialSpec {
  name: string;
  roleArn: string;
  comment?: string;
  readOnly?: boolean;
}

/**
 * Create (idempotent) a UC STORAGE CREDENTIAL backed by an AWS IAM role.
 * POST /api/2.1/unity-catalog/storage-credentials
 *   { name, aws_iam_role: { role_arn }, read_only, comment, skip_validation }
 * Learn: https://learn.microsoft.com/azure/databricks/connect/unity-catalog/cloud-storage/s3/s3-external-location-manual
 */
export async function ensureUcAwsStorageCredential(spec: UcAwsStorageCredentialSpec): Promise<{ name: string }> {
  const body: Record<string, unknown> = {
    name: spec.name,
    aws_iam_role: { role_arn: spec.roleArn },
    read_only: spec.readOnly ?? true,
    skip_validation: false,
  };
  if (spec.comment) body.comment = spec.comment;
  const res = await securableFetch(
    '/api/2.1/unity-catalog/storage-credentials',
    { method: 'POST', body: JSON.stringify(body) },
    spec.name,
  );
  await ucJsonOrThrow<unknown>(res, 'createUcStorageCredential(aws)');
  return { name: spec.name };
}

/** GCP service-account-key storage credential (the GCS pattern). */
export interface UcGcpStorageCredentialSpec {
  name: string;
  /** Parsed GCS service-account JSON (the file the operator stored in KV). */
  serviceAccountJson: { client_email?: string; private_key_id?: string; private_key?: string };
  comment?: string;
  readOnly?: boolean;
}

/**
 * Create (idempotent) a UC STORAGE CREDENTIAL backed by a GCP service-account
 * key, derived from the service-account JSON resolved out of Key Vault.
 * POST /api/2.1/unity-catalog/storage-credentials
 *   { name, gcp_service_account_key: { email, private_key_id, private_key }, ... }
 * Learn: https://learn.microsoft.com/azure/databricks/dev-tools/cli/reference/account-storage-credentials-commands
 */
export async function ensureUcGcpStorageCredential(spec: UcGcpStorageCredentialSpec): Promise<{ name: string }> {
  const sa = spec.serviceAccountJson;
  if (!sa?.client_email || !sa?.private_key_id || !sa?.private_key) {
    throw Object.assign(
      new Error('GCS service-account JSON is missing client_email / private_key_id / private_key'),
      { code: 'bad_gcs_secret' },
    );
  }
  const body: Record<string, unknown> = {
    name: spec.name,
    gcp_service_account_key: {
      email: sa.client_email,
      private_key_id: sa.private_key_id,
      private_key: sa.private_key,
    },
    read_only: spec.readOnly ?? true,
    skip_validation: false,
  };
  if (spec.comment) body.comment = spec.comment;
  const res = await securableFetch(
    '/api/2.1/unity-catalog/storage-credentials',
    { method: 'POST', body: JSON.stringify(body) },
    spec.name,
  );
  await ucJsonOrThrow<unknown>(res, 'createUcStorageCredential(gcp)');
  return { name: spec.name };
}

/**
 * Create (idempotent) a UC EXTERNAL LOCATION over a cloud-storage URL prefix,
 * bound to a storage credential.
 * POST /api/2.1/unity-catalog/external-locations { name, url, credential_name, read_only }
 * Learn: https://learn.microsoft.com/azure/databricks/sql/language-manual/sql-ref-syntax-ddl-create-location
 */
export async function ensureUcExternalLocation(args: {
  name: string;
  url: string;
  credentialName: string;
  readOnly?: boolean;
  comment?: string;
}): Promise<{ name: string }> {
  const body: Record<string, unknown> = {
    name: args.name,
    url: args.url,    credential_name: args.credentialName,
    read_only: args.readOnly ?? true,
    skip_validation: false,
  };
  if (args.comment) body.comment = args.comment;
  const res = await securableFetch(
    '/api/2.1/unity-catalog/external-locations',
    { method: 'POST', body: JSON.stringify(body) },
    args.name,
  );
  await ucJsonOrThrow<unknown>(res, 'createUcExternalLocation');
  return { name: args.name };
}

/** Best-effort delete a UC external location (drop a shortcut). Never deletes source bytes. */
export async function deleteUcExternalLocation(name: string, force = true): Promise<void> {
  const qs = force ? '?force=true' : '';
  const res = await securableFetch(
    `/api/2.1/unity-catalog/external-locations/${encodeURIComponent(name)}${qs}`,
    { method: 'DELETE' },
    name,
  );
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`deleteUcExternalLocation failed ${res.status}: ${text.slice(0, 300)}`);
  }
}

/** Best-effort delete a UC storage credential. */
export async function deleteUcStorageCredential(name: string, force = true): Promise<void> {
  const qs = force ? '?force=true' : '';
  const res = await securableFetch(
    `/api/2.1/unity-catalog/storage-credentials/${encodeURIComponent(name)}${qs}`,
    { method: 'DELETE' },
    name,
  );
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`deleteUcStorageCredential failed ${res.status}: ${text.slice(0, 300)}`);
  }
}
