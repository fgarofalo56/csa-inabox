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
 * Auth: session-required. Runtime: nodejs, force-dynamic.
 * Per .claude/rules/no-vaporware.md — real S3/GCS/ADLS REST, no mock arrays.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getShortcutSecretValue, shortcutKeyVaultConfigGate } from '@/lib/azure/kv-secrets-client';
import {
  listS3Objects,
  listGcsObjects,
  browseAdls,
  listDataverseEntities,
  ShortcutSourceError,
  type BrowseResult,
  type GcsServiceAccount,
} from '@/lib/azure/shortcut-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SOURCE_TYPES = ['s3', 'gcs', 'adls', 'dataverse'] as const;
type SourceType = (typeof SOURCE_TYPES)[number];

function sanitize(e: any): string {
  return (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

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
      const secretValue = (await getShortcutSecretValue(kvSecret)).trim();
      if (!secretValue) {
        return NextResponse.json(
          { ok: false, code: 'kv_secret_empty', error: `Key Vault secret '${kvSecret}' is empty — re-save the credential.` },
          { status: 502 },
        );
      }

      if (sourceType === 's3') {
        const bucket = (sp.get('bucket') || '').trim();
        const region = (sp.get('region') || 'us-east-1').trim();
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
    if (e instanceof ShortcutSourceError) {
      return NextResponse.json({ ok: false, code: e.code, error: sanitize(e), hint: sanitize(e) }, { status: e.status });
    }
    return NextResponse.json({ ok: false, code: e?.code || 'browse_failed', error: sanitize(e) }, { status: 502 });
  }
}
