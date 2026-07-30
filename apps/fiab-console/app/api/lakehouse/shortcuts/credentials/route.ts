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
 * Honest-gate (503) when no Key Vault is configured — names LOOM_SHORTCUT_KEYVAULT.
 * Auth: session-required. Runtime: nodejs, force-dynamic.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  putShortcutSecret,
  shortcutKeyVaultConfigGate,
  sanitizeSecretName,
  KeyVaultError,
} from '@/lib/azure/kv-secrets-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SOURCE_TYPES = ['s3', 'gcs', 'adls', 'dataverse'] as const;
type SourceType = (typeof SOURCE_TYPES)[number];

/** Deterministic, collision-resistant secret name for a shortcut credential. */
export function shortcutSecretName(lakehouseId: string, sourceType: string, name: string): string {
  return sanitizeSecretName(`loom-sc-${sourceType}-${lakehouseId}-${name}`);
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

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

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
    const { name: stored } = await putShortcutSecret(secretName, secretValue.trim());
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
}
