/**
 * GET /api/realtime-hub/keyvault-certificates
 *
 * Lists the certificate objects in the eventstream mTLS Key Vault so the
 * MQTT / Kafka secure-connection dialog's CA + client certificate pickers can
 * render REAL choices (Azure-native — no Microsoft Fabric, per
 * no-fabric-dependency.md). Each entry is { name, id, enabled, expires }.
 *
 * Vault resolution: LOOM_EVENTSTREAM_CERT_VAULT (full URI or bare name),
 * falling back to LOOM_KEY_VAULT_URI / _NAME. When no vault is configured the
 * route returns a 200 honest-gate payload ({ ok:true, configured:false, gate })
 * so the dialog can show a Fluent MessageBar naming the exact env var to set
 * and role to grant — the full mTLS panel still renders. A real KV 403/404 is
 * surfaced verbatim so the user sees the precise role to grant
 * ("Key Vault Certificate User").
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listKeyVaultCertificates,
  certVaultConfigGate,
  certVaultUrl,
  KeyVaultError,
} from '@/lib/azure/kv-secrets-client';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // Honest infra-gate: no cert vault configured. Return 200 so the UI keeps the
  // full panel and shows the precise remediation (per no-vaporware.md).
  const gate = certVaultConfigGate();
  if (gate) {
    return NextResponse.json({
      ok: true,
      configured: false,
      vaultUri: null,
      certificates: [],
      gate,
    });
  }

  try {
    const certificates = await listKeyVaultCertificates();
    return NextResponse.json({
      ok: true,
      configured: true,
      vaultUri: certVaultUrl(),
      certificates,
    });
  } catch (e: any) {
    if (e instanceof KeyVaultError) {
      const hint =
        e.status === 403
          ? 'Grant the Console identity the "Key Vault Certificate User" role on the eventstream cert vault.'
          : undefined;
      return NextResponse.json({ ok: false, error: e.message, hint }, { status: e.status });
    }
    return apiServerError(e);
  }
}
