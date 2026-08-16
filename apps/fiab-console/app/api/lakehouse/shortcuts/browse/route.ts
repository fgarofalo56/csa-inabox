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
 *
 * Credentials are read from Key Vault by NAME (never passed in the URL, never
 * echoed). ADLS browses on the Console UAMI (no credential). Returns
 * { ok, data: { entries, prefix, truncated } }. Honest-gate (503) when the KV
 * isn't configured for the credentialed sources — names LOOM_SHORTCUT_KEYVAULT.
 *
 * SECURITY — `kvSecret` is a caller-supplied NAME and the Console resolves it
 * with its own managed identity, so WHICH secret may be read is a policy
 * decision, not the caller's. The read goes through the `shortcut-credential`
 * purpose (lib/azure/kv-secret-purpose.ts), which OWNS the `loom-sc-` /
 * `loom-shortcut-` name-space: anything outside it — every platform credential,
 * every other feature's minted secret — is refused BEFORE a vault token is
 * minted.
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
 * KNOWN RESIDUAL — `kvSecret` is name-scoped, not OWNER-scoped. The name-space
 * policy stops a caller reaching a platform or cross-feature secret, but it does
 * not prove the named shortcut credential belongs to the caller's own item, so
 * this is still a confused deputy between two users' shortcut credentials. The
 * minted names embed UUIDs, which makes enumeration impractical rather than
 * impossible. Closing it properly needs the item id at this endpoint so
 * ownership can be checked the way /api/connections/test checks it — a request
 * contract change, deliberately not bundled into a security fix.
 *
 * Auth: session-required. Runtime: nodejs, force-dynamic.
 * Per .claude/rules/no-vaporware.md — real S3/GCS/ADLS REST, no mock arrays.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getShortcutSecretValue, shortcutKeyVaultConfigGate } from '@/lib/azure/kv-secrets-client';
import { KeyVaultSecretPolicyError } from '@/lib/azure/kv-secret-purpose';
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

function sanitize(e: any): string {
  return (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export const GET = withSession(async (req: NextRequest) => {

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
      const kvSecret = (sp.get('kvSecret') || '').trim();
      if (!kvSecret) {
        return NextResponse.json({ ok: false, error: 'kvSecret (Key Vault secret name) is required' }, { status: 400 });
      }
      // Validate every caller-supplied coordinate that shapes a DESTINATION
      // before the credential is resolved. `region` is interpolated into the S3
      // request authority, so it is checked here rather than after the read —
      // a refused request must not have caused a secret to be read at all.
      const s3Region = sourceType === 's3' ? ((sp.get('region') || 'us-east-1').trim()) : '';
      if (sourceType === 's3') assertValidAwsRegion(s3Region);

      const secretValue = (await getShortcutSecretValue(kvSecret, 'shortcut-credential')).trim();
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
    if (e instanceof KeyVaultSecretPolicyError) {
      // The caller named a secret this surface may not read. Report the NAME it
      // asked for and the reason — never anything read from the vault, because
      // nothing was: the policy runs before the vault token is minted. Routed
      // through the same sanitize() as every other branch, since the message
      // embeds the caller-supplied name and would otherwise be the one reply
      // returned unstripped and unbounded.
      const msg = sanitize(e);
      return NextResponse.json({ ok: false, code: 'kv_secret_not_permitted', error: msg, hint: msg }, { status: 403 });
    }
    if (e instanceof ShortcutSourceError) {
      return NextResponse.json({ ok: false, code: e.code, error: sanitize(e), hint: sanitize(e) }, { status: e.status });
    }
    return NextResponse.json({ ok: false, code: e?.code || 'browse_failed', error: sanitize(e) }, { status: 502 });
  }
});
