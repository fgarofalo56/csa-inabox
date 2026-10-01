/**
 * GET /api/lakehouse/shortcuts/browse
 *
 * Live remote-tree browse for the shortcut wizard. Lists ONE level of an
 * external source so the user can click into the real folder structure before
 * creating the shortcut — Azure-native parity with Fabric OneLake's "Browse"
 * step, NO Fabric dependency.
 *
 * Query:
 *   sourceType = s3 | gcs | adls | dataverse   (required)
 *   prefix     = path/inside/the/source        (optional)
 *   kvSecret   = Key Vault secret NAME with the credential   (s3/gcs/dataverse)
 *   bucket     = bucket name                    (s3/gcs)
 *   region     = AWS region                     (s3)
 *   account    = storage account                (adls)
 *   container  = filesystem/container           (adls)
 *   lakehouseId = the lakehouse the wizard is creating the shortcut in
 *                 (required for every source; 400 item_required without it)
 *
 * Credentials are read from Key Vault by NAME (never passed in the URL, never
 * echoed). ADLS browses on the Console UAMI (no credential). Returns
 * { ok, data: { entries, prefix, truncated } }. Honest-gate (503) when the KV
 * isn't configured for the credentialed sources — names LOOM_SHORTCUT_KEYVAULT.
 *
 * SECURITY — `kvSecret` is a caller-supplied NAME and the Console resolves it
 * with its own managed identity, so WHICH secret may be read is a policy
 * decision, not the caller's. The read goes through
 * lib/azure/shortcut-secret-resolver.ts: the Key Vault name grammar (exact, not
 * trimmed), the `shortcut-credential` purpose policy (lib/azure/kv-secret-purpose.ts)
 * and the ownership check for the signed-in principal — a `loom-sc-` credential
 * must have been saved by this caller (mint record), a `loom-dsp-` credential
 * must belong to a registered data share provider. Every refusal happens before
 * the value is read.
 *
 * That check is load-bearing rather than defensive, and not because of a code
 * fallback: `admin-plane/main.bicep` SETS `LOOM_SHORTCUT_KEYVAULT` on the
 * Console to the admin-plane vault whenever `loomShortcutKeyVaultUri` is empty,
 * and no params file in any boundary supplies that override. So the shortcut
 * vault IS the main Loom vault in every shipped deployment, by explicit
 * deploy-time wiring.
 *
 * Two matching rules follow from the same principle and live with their
 * sources: a resolved value is never interpolated into an error (parseAbfss),
 * and `region` cannot move the S3 request to another authority (listS3Objects).
 *
 * Every credentialed browse names `lakehouseId`, and the ownership check
 * compares the lakehouse the credential was saved for, as the create and Test
 * routes do. The parameter can only narrow the check: it never grants a read
 * the principal check refuses, so it needs no item authorization of its own.
 *
 * ADLS browse is scoped to the containers bound to the caller's workspace. It
 * runs on the Console identity, so the account and container it may list are
 * decided here: the caller must be able to read `lakehouseId` (the same
 * `authorizeLakehouse` check the lakehouse routes use, 404 otherwise), and the
 * account + container must be one of
 *   (a) this deployment's lake containers (`deploymentLakeAccounts` with
 *       `configuredContainerNames`), or
 *   (b) a container a lakehouse in that lakehouse's workspace records
 *       (`state.storageAccount`, `adlsContainer`, `ownedContainers`, the
 *       provisioning receipt) when the caller can read that lakehouse.
 * A tenant admin may browse any account. Anything else is 403
 * `adls_browse_not_permitted` before any storage call; a lookup that fails is
 * 503 `adls_browse_unverified`, never an allow.
 *
 * Auth: session-required. Runtime: nodejs, force-dynamic.
 * Per .claude/rules/no-vaporware.md — real S3/GCS/ADLS REST, no mock arrays.
 */

import { NextRequest, NextResponse } from 'next/server';
import { shortcutKeyVaultConfigGate } from '@/lib/azure/kv-secrets-client';
import { resolveShortcutSecret, isShortcutSecretRefusal } from '@/lib/azure/shortcut-secret-resolver';
import { redactErrorText } from '@/lib/azure/shortcut-error-hygiene';
import {
  listS3Objects,
  listGcsObjects,
  browseAdls,
  listDataverseEntities,
  assertValidAwsRegion,
  ShortcutSourceError,
  type BrowseResult,
  type GcsServiceAccount,
} from '@/lib/azure/shortcut-client';
import { withSession } from '@/lib/api/route-toolkit';
import { authorizeLakehouse } from '../../_lib/item-scope';
import { deploymentLakeAccounts } from '@/app/api/storage/_lib/authorize';
import { configuredContainerNames, getAccountName } from '@/lib/azure/adls-client';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import type { SessionPayload } from '@/lib/auth/session';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SOURCE_TYPES = ['s3', 'gcs', 'adls', 'dataverse'] as const;
type SourceType = (typeof SOURCE_TYPES)[number];

/** HTML stripped, whitespace collapsed, URL query strings / credentials removed. */
function sanitize(e: any): string {
  return redactErrorText((e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 500);
}

/** The storage coordinates a lakehouse item records, as read by {@link adlsBrowseScope}. */
interface LakehouseStorageRow {
  id: string;
  storageAccount?: unknown;
  adlsContainer?: unknown;
  ownedContainers?: unknown;
  provContainer?: unknown;
  provAdlsRoot?: unknown;
}

/** This deployment's primary lake account, lower-cased, or null when none is configured. */
function primaryLakeAccount(): string | null {
  try {
    return getAccountName().toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Every (account, container) pair a lakehouse row records. The account is
 * `state.storageAccount` when set, else the primary lake account; the
 * provisioning receipt's abfss URI names its own account.
 */
function recordedLocations(row: LakehouseStorageRow, primary: string | null): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const explicit = typeof row.storageAccount === 'string' ? row.storageAccount.trim().toLowerCase() : '';
  const account = explicit || primary;
  const owned = Array.isArray(row.ownedContainers) ? row.ownedContainers : [];
  if (account) {
    for (const c of [row.adlsContainer, row.provContainer, ...owned]) {
      if (typeof c === 'string' && c.trim()) out.push([account, c.trim()]);
    }
  }
  if (typeof row.provAdlsRoot === 'string') {
    const m = /^abfss:\/\/([^@/]+)@([^./]+)\./i.exec(row.provAdlsRoot.trim());
    if (m) out.push([m[2].toLowerCase(), m[1]]);
  }
  return out;
}

type AdlsBrowseScope = 'allowed' | 'not-bound' | 'unverified';

/**
 * May a non-admin caller who can read `lakehouse` browse `container` on
 * `account`? See the header: this deployment's lake containers, or a container
 * a lakehouse in the same workspace records and the caller can read. A failed
 * lookup is `unverified`, which the route refuses.
 */
async function adlsBrowseScope(
  session: SessionPayload,
  lakehouse: WorkspaceItem,
  accountRaw: string,
  container: string,
): Promise<AdlsBrowseScope> {
  const account = accountRaw.toLowerCase();
  if (deploymentLakeAccounts().has(account) && (configuredContainerNames() as string[]).includes(container)) {
    return 'allowed';
  }
  try {
    const items = await itemsContainer();
    const { resources } = await items.items
      .query<LakehouseStorageRow>(
        {
          query:
            'SELECT c.id, c.state.storageAccount AS storageAccount, c.state.adlsContainer AS adlsContainer, '
            + 'c.state.ownedContainers AS ownedContainers, '
            + 'c.state.provisioning.secondaryIds.container AS provContainer, '
            + 'c.state.provisioning.secondaryIds.adlsRoot AS provAdlsRoot '
            + "FROM c WHERE c.workspaceId = @ws AND c.itemType = 'lakehouse' "
            + 'AND (NOT IS_DEFINED(c.state._recycled) OR c.state._recycled = null)',
          parameters: [{ name: '@ws', value: lakehouse.workspaceId }],
        },
        { partitionKey: lakehouse.workspaceId },
      )
      .fetchAll();
    const primary = primaryLakeAccount();
    for (const row of resources) {
      if (!recordedLocations(row, primary).some(([a, c]) => a === account && c === container)) continue;
      // The lakehouse in the request is already authorized; another one must be readable too.
      if (row.id === lakehouse.id) return 'allowed';
      if (await resolveItemAccessByOid(session, row.id, 'lakehouse')) return 'allowed';
    }
  } catch {
    return 'unverified';
  }
  return 'not-bound';
}

/** The refusal for an ADLS browse {@link adlsBrowseScope} did not allow. */
function adlsBrowseRefusal(scope: Exclude<AdlsBrowseScope, 'allowed'>): NextResponse {
  if (scope === 'unverified') {
    const error = 'Loom could not confirm that this container is bound to this workspace, so it did not browse it. '
      + 'Retry in a moment; if it persists, ask a tenant admin.';
    return NextResponse.json({ ok: false, code: 'adls_browse_unverified', error, hint: error }, { status: 503 });
  }
  const error = 'ADLS browse is scoped to the containers bound to this workspace, and this storage account and '
    + "container are not one of them, so Loom did not browse it. Pick a container bound to this workspace (this "
    + "deployment's lake containers, or one a lakehouse in this workspace is bound to), or ask a tenant admin.";
  return NextResponse.json({ ok: false, code: 'adls_browse_not_permitted', error, hint: error }, { status: 403 });
}

export const GET = withSession(async (req: NextRequest, { session }) => {

  const sp = req.nextUrl.searchParams;
  const sourceType = (sp.get('sourceType') || '').trim() as SourceType;
  const prefix = (sp.get('prefix') || '').trim();
  if (!SOURCE_TYPES.includes(sourceType)) {
    return NextResponse.json({ ok: false, error: `sourceType must be one of ${SOURCE_TYPES.join(', ')}` }, { status: 400 });
  }

  // Credentialed sources require a configured Key Vault + a secret name.
  const credentialed = sourceType === 's3' || sourceType === 'gcs' || sourceType === 'dataverse';
  if (credentialed) {
    const gate = shortcutKeyVaultConfigGate();
    if (gate) {
      return NextResponse.json(
        { ok: false, code: 'key_vault_not_configured', error: gate.detail, hint: gate.detail },
        { status: 503 },
      );
    }
  }

  try {
    let result: BrowseResult;

    if (sourceType === 'adls') {
      const account = (sp.get('account') || '').trim();
      const container = (sp.get('container') || '').trim();
      if (!account || !container) {
        return NextResponse.json({ ok: false, error: 'account and container are required for ADLS browse' }, { status: 400 });
      }
      // The lakehouse names the workspace whose bound containers bound this browse.
      const lakehouseId = (sp.get('lakehouseId') || '').trim();
      if (!lakehouseId) {
        return NextResponse.json(
          { ok: false, code: 'item_required', error: 'lakehouseId is required to browse a storage account.' },
          { status: 400 },
        );
      }
      const access = await authorizeLakehouse(session, lakehouseId);
      if (access instanceof NextResponse) return access;
      if (!isTenantAdmin(session)) {
        const scope = await adlsBrowseScope(session, access.item, account, container);
        if (scope !== 'allowed') return adlsBrowseRefusal(scope);
      }
      result = await browseAdls({ account, container, prefix });
    } else {
      // Not trimmed: the resolver refuses a padded name rather than reading a
      // different one than the caller sent.
      const kvSecret = sp.get('kvSecret') || '';
      if (!kvSecret) {
        return NextResponse.json({ ok: false, error: 'kvSecret (Key Vault secret name) is required' }, { status: 400 });
      }
      // The lakehouse is required whenever a saved credential is resolved, so
      // the ownership check always compares the lakehouse it was saved for.
      const lakehouseId = (sp.get('lakehouseId') || '').trim();
      if (!lakehouseId) {
        return NextResponse.json(
          { ok: false, code: 'item_required', error: 'lakehouseId is required to browse with a saved credential.' },
          { status: 400 },
        );
      }
      // Validate every caller-supplied coordinate that shapes a DESTINATION
      // before the credential is resolved. `region` is interpolated into the S3
      // request authority, so it is checked here rather than after the read —
      // a refused request must not have caused a secret to be read at all.
      const s3Region = sourceType === 's3' ? ((sp.get('region') || 'us-east-1').trim()) : '';
      if (sourceType === 's3') assertValidAwsRegion(s3Region);

      const claims = session.claims as { oid?: string; upn?: string; email?: string; tid?: string };
      const secretValue = (await resolveShortcutSecret(
        kvSecret,
        {
          kind: 'principal', via: 'request', oid: claims.oid, upn: claims.upn || claims.email, tid: claims.tid,
          lakehouseId, targetType: sourceType,
        },
        { vault: 'shortcut' },
      )).trim();
      if (!secretValue) {
        return NextResponse.json(
          { ok: false, code: 'kv_secret_empty', error: `Key Vault secret '${kvSecret}' is empty — re-save the credential.` },
          { status: 502 },
        );
      }

      if (sourceType === 's3') {
        const bucket = (sp.get('bucket') || '').trim();
        const region = s3Region;
        if (!bucket) return NextResponse.json({ ok: false, error: 'bucket is required for S3 browse' }, { status: 400 });
        if (/^arn:aws/i.test(secretValue)) {
          return NextResponse.json(
            {
              ok: false,
              code: 's3_iam_role_browse_unsupported',
              error:
                'This S3 shortcut uses an IAM role ARN (Unity Catalog engine). Live browse needs an access key/secret. ' +
                'Create with an Access Key/Secret credential to browse, or create the shortcut and query it after binding.',
            },
            { status: 503 },
          );
        }
        const [accessKeyId, secretAccessKey] = secretValue.split(':');
        result = await listS3Objects({ bucket, region, prefix, accessKeyId, secretAccessKey });
      } else if (sourceType === 'gcs') {
        const bucket = (sp.get('bucket') || '').trim();
        if (!bucket) return NextResponse.json({ ok: false, error: 'bucket is required for GCS browse' }, { status: 400 });
        let serviceAccount: GcsServiceAccount;
        try {
          serviceAccount = JSON.parse(secretValue);
        } catch {
          return NextResponse.json(
            { ok: false, code: 'gcs_bad_service_account', error: `Key Vault secret '${kvSecret}' is not valid service-account JSON.` },
            { status: 400 },
          );
        }
        result = await listGcsObjects({ bucket, prefix, serviceAccount });
      } else {
        // dataverse — the KV secret holds the Synapse-Link export abfss path.
        result = await listDataverseEntities({ exportAbfssUri: secretValue, prefix });
      }
    }

    return NextResponse.json({ ok: true, data: result });
  } catch (e: any) {
    if (isShortcutSecretRefusal(e)) {
      // The caller named a secret this surface may not read (malformed name,
      // outside the shortcut name-space, or not theirs). Report the NAME and the
      // reason — never anything read from the vault, because nothing was: every
      // check runs before the value is read. Routed through the same sanitize()
      // as every other branch, since the message embeds the caller-supplied name.
      const msg = sanitize(e);
      const status = e instanceof Error && (e as { status?: number }).status === 400 ? 400 : 403;
      return NextResponse.json({ ok: false, code: 'kv_secret_not_permitted', error: msg, hint: msg }, { status });
    }
    if (e instanceof ShortcutSourceError) {
      return NextResponse.json({ ok: false, code: e.code, error: sanitize(e), hint: sanitize(e) }, { status: e.status });
    }
    return NextResponse.json({ ok: false, code: e?.code || 'browse_failed', error: sanitize(e) }, { status: 502 });
  }
});
