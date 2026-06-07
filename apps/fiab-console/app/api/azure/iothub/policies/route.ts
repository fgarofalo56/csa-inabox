/**
 * GET /api/azure/iothub/policies?iotHubId=<armResourceId>
 * -------------------------------------------------------
 * Lists the shared-access policy NAMES + rights on an IoT Hub, so the KQL
 * Database data-connection wizard can populate its "Shared access policy"
 * dropdown. ADX ingestion needs a policy with `ServiceConnect` rights
 * (built-ins: `iothubowner` or `service`).
 *
 * Backend: real ARM `POST {arm}/{iotHubId}/listkeys?api-version=2023-06-30`.
 * Keys are NEVER returned to the browser — only `{ name, rights }`.
 *
 * Credential ladder mirrors /api/azure/resources: user ARM token (per-user
 * RBAC) → Loom UAMI fallback. If neither identity can read keys (403), this is
 * NOT a hard gate: the wizard still works. We return ok:false + a curated
 * `fallback` list of the built-in IoT Hub policies so the dropdown is usable,
 * and the UI shows an info-level note. Real REST. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getUserArmToken } from '@/lib/azure/user-token-store';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { armBase, armScope } from '@/lib/azure/arm-endpoint';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const IOTHUB_API = '2023-06-30';
const IOTHUB_ID_RE =
  /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Devices\/IotHubs\/[^/]+$/i;

// Built-in shared-access policies present on every IoT Hub. Used as the
// usable fallback list when the identity can't enumerate keys.
const BUILTIN_POLICIES = [
  { name: 'iothubowner', rights: 'RegistryWrite, ServiceConnect, DeviceConnect' },
  { name: 'service', rights: 'ServiceConnect' },
  { name: 'device', rights: 'DeviceConnect' },
  { name: 'registryRead', rights: 'RegistryRead' },
  { name: 'registryReadWrite', rights: 'RegistryWrite' },
];

function uamiCredential(): ChainedTokenCredential | DefaultAzureCredential {
  const clientId = process.env.LOOM_UAMI_CLIENT_ID;
  return clientId
    ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId }), new DefaultAzureCredential())
    : new DefaultAzureCredential();
}

interface PolicyRow { name: string; rights?: string }

/** POST listkeys with one bearer token. Returns rows (key material stripped). */
async function listKeys(
  token: string,
  iotHubId: string,
): Promise<{ ok: true; rows: PolicyRow[] } | { ok: false; status: number; error: string }> {
  const url = `${armBase()}${iotHubId}/listkeys?api-version=${IOTHUB_API}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      cache: 'no-store',
    });
  } catch (e: any) {
    return { ok: false, status: 502, error: String(e?.message || e).slice(0, 300) };
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text)?.error?.message || text; } catch { /* non-JSON */ }
    return { ok: false, status: res.status, error: String(msg).slice(0, 300) };
  }
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { return { ok: false, status: 502, error: 'non-JSON listkeys body' }; }
  const value: any[] = Array.isArray(body?.value) ? body.value : [];
  // Strip primaryKey / secondaryKey — only the policy name + rights leave the server.
  const rows: PolicyRow[] = value.map((k) => ({ name: String(k?.keyName || ''), rights: k?.rights }))
    .filter((p) => p.name);
  return { ok: true, rows };
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const iotHubId = (req.nextUrl.searchParams.get('iotHubId') || '').trim();
  if (!iotHubId) {
    return NextResponse.json({ ok: false, code: 'bad_request', error: 'Missing required query param `iotHubId`.' }, { status: 400 });
  }
  if (!IOTHUB_ID_RE.test(iotHubId)) {
    return NextResponse.json({ ok: false, code: 'bad_request', error: 'iotHubId is not a valid Microsoft.Devices/IotHubs resource id.' }, { status: 400 });
  }

  let lastErr: string | undefined;

  // (a) User ARM token (per-user RBAC)
  try {
    const userToken = await getUserArmToken(session.claims.oid);
    if (userToken) {
      const r = await listKeys(userToken, iotHubId);
      if (r.ok) return NextResponse.json({ ok: true, policies: r.rows, via: 'user' });
      lastErr = r.error;
    }
  } catch { /* fall through to UAMI */ }

  // (b) UAMI fallback
  try {
    const tok = await uamiCredential().getToken(armScope());
    if (tok?.token) {
      const r = await listKeys(tok.token, iotHubId);
      if (r.ok) return NextResponse.json({ ok: true, policies: r.rows, via: 'uami' });
      lastErr = r.error;
    }
  } catch (e: any) {
    lastErr = String(e?.message || e).slice(0, 300);
  }

  // Neither identity could enumerate keys — honest, NON-blocking fallback so
  // the wizard dropdown still works with the built-in policies.
  return NextResponse.json({
    ok: false,
    code: 'no_key_read',
    error:
      'Could not enumerate shared-access policies from the IoT Hub (the identity lacks ' +
      'Microsoft.Devices/IotHubs/IotHubKeys/read). Showing the built-in defaults — pick a policy with ' +
      'ServiceConnect rights (iothubowner or service) for ADX ingestion.' + (lastErr ? ` [${lastErr}]` : ''),
    fallback: BUILTIN_POLICIES,
  }, { status: 200 });
}
