/**
 * POST /api/lakehouse/shortcuts/credentials
 *
 * Stash an external-source credential (S3 access key/secret, GCS service-account
 * JSON, ADLS SAS token, Dataverse Synapse-Link path) into Key Vault and return
 * ONLY the secret NAME. The credential value is written straight to KV via the
 * Console UAMI — it is NEVER persisted in Cosmos, NEVER echoed back in the
 * response, and NEVER logged. The shortcut row stores only this `secretName`
 * (credentialRef.keyVaultSecret), exactly like Loom Connections.
 *
 * Body: { lakehouseId, name, sourceType, secretValue }
 *   - secretValue formats (validated, never freeform-JSON in the UI):
 *       s3        → 'AccessKeyId:SecretAccessKey'  (or an IAM role ARN)
 *       gcs       → service-account JSON
 *       adls/sas  → SAS token
 *       dataverse → abfss:// Synapse-Link export path
 *
 * OWNERSHIP IS RECORDED AT MINT. The secret is written with Key Vault tags
 * naming the signed-in principal (oid, UPN, tenant) and the lakehouse it was
 * saved for; lib/azure/shortcut-secret-resolver.ts reads those tags (never the
 * value) before any shortcut route may use the credential. The name ends in a
 * random suffix, so two principals saving a credential for the same lakehouse,
 * source type and shortcut name never write to the same secret.
 *
 * Honest-gate (503) when no Key Vault is configured — names LOOM_SHORTCUT_KEYVAULT.
 * Auth: session-required. Runtime: nodejs, force-dynamic.
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import {
  putShortcutSecret,
  shortcutKeyVaultConfigGate,
  sanitizeSecretName,
  KeyVaultError,
} from '@/lib/azure/kv-secrets-client';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SOURCE_TYPES = ['s3', 'gcs', 'adls', 'dataverse'] as const;
type SourceType = (typeof SOURCE_TYPES)[number];

/** Length of the random suffix (hex characters) every minted name ends in. */
export const SHORTCUT_SECRET_SUFFIX_HEX = 12;

/**
 * A fresh secret name for a shortcut credential:
 * `loom-sc-<sourceType>-<lakehouseId>-<name>-<random>`. The readable prefix is
 * truncated so the random suffix always survives Key Vault's 127-character limit.
 */
export function shortcutSecretName(
  lakehouseId: string,
  sourceType: string,
  name: string,
  suffix: string = randomBytes(SHORTCUT_SECRET_SUFFIX_HEX / 2).toString('hex'),
): string {
  const readable = sanitizeSecretName(`loom-sc-${sourceType}-${lakehouseId}-${name}`)
    .slice(0, 127 - SHORTCUT_SECRET_SUFFIX_HEX - 1)
    .replace(/-+$/, '');
  return `${readable}-${suffix}`;
}

/** Validate the structured value matches the source type (no freeform JSON UI). */
function validate(sourceType: SourceType, value: string): string | null {
  const v = value.trim();
  if (!v) return 'secretValue is required';
  if (sourceType === 's3') {
    const isArn = /^arn:aws[a-z-]*:iam::\d+:role\//i.test(v);
    const isKeyPair = /^[^:\s]+:[^:\s]+$/.test(v);
    if (!isArn && !isKeyPair) return "S3 credential must be 'AccessKeyId:SecretAccessKey' or an IAM role ARN";
  } else if (sourceType === 'gcs') {
    try {
      const sa = JSON.parse(v);
      if (!sa.client_email || !sa.private_key) return 'GCS service-account JSON must include client_email and private_key';
    } catch {
      return 'GCS credential must be the service-account JSON';
    }
  } else if (sourceType === 'dataverse') {
    if (!/^abfss:\/\/[^@]+@[^/]+/i.test(v) && !/^https:\/\//i.test(v)) {
      return 'Dataverse credential must be the Synapse-Link ADLS path (abfss://… or https DFS URL)';
    }
  }
  // adls/sas: any non-empty token is accepted (validated for real on bind/browse).
  return null;
}

export const POST = withSession(async (req: NextRequest, { session }) => {

  const gate = shortcutKeyVaultConfigGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, code: 'key_vault_not_configured', error: gate.detail, hint: gate.detail },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const lakehouseId = (body?.lakehouseId || '').toString().trim();
  const name = (body?.name || '').toString().trim();
  const sourceType = (body?.sourceType || '').toString().trim() as SourceType;
  const secretValue = (body?.secretValue ?? '').toString();

  if (!lakehouseId) return NextResponse.json({ ok: false, error: 'lakehouseId is required' }, { status: 400 });
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  if (!SOURCE_TYPES.includes(sourceType)) {
    return NextResponse.json({ ok: false, error: `sourceType must be one of ${SOURCE_TYPES.join(', ')}` }, { status: 400 });
  }
  const invalid = validate(sourceType, secretValue);
  if (invalid) return NextResponse.json({ ok: false, error: invalid, code: 'bad_credential' }, { status: 400 });

  const secretName = shortcutSecretName(lakehouseId, sourceType, name);
  try {
    const claims = session.claims as { oid?: string; upn?: string; tid?: string; email?: string };
    const { name: stored } = await putShortcutSecret(secretName, secretValue.trim(), {
      oid: claims.oid,
      upn: claims.upn || claims.email,
      tid: claims.tid,
      lakehouseId,
    });
    // Return ONLY the secret name — the value never leaves this function.
    return NextResponse.json({ ok: true, data: { secretName: stored } });
  } catch (e: any) {
    const status = e instanceof KeyVaultError ? e.status : 502;
    const denied = status === 403;
    return NextResponse.json(
      {
        ok: false,
        code: denied ? 'kv_access_denied' : 'kv_write_failed',
        error: denied
          ? 'The Console identity cannot write secrets. Grant it the "Key Vault Secrets Officer" role on the shortcut Key Vault.'
          : `Failed to store credential in Key Vault: ${(e?.message || String(e)).slice(0, 200)}`,
      },
      { status: denied ? 503 : 502 },
    );
  }
});
