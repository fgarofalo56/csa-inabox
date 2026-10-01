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
 *                 (required for s3/gcs/dataverse; 400 item_required without it)
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
 * ADLS browse resolves no credential and does not take it.
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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SOURCE_TYPES = ['s3', 'gcs', 'adls', 'dataverse'] as const;
type SourceType = (typeof SOURCE_TYPES)[number];

/** HTML stripped, whitespace collapsed, URL query strings / credentials removed. */
function sanitize(e: any): string {
  return redactErrorText((e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 500);
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
