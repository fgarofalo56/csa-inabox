/**
 * GET  /api/items/postgres-flexible-server          — list all PostgreSQL flexible servers in the subscription (ARM REST)
 * POST /api/items/postgres-flexible-server          — provision a new flexible server (ARM PUT, long-running)
 *      body { name, resourceGroup, location, administratorLogin, skuName, tier, version?, storageGb? }
 *      →    { ok, id, provisioningState, provisionedBy, adminSecretName }
 *
 * ── THE ADMIN PASSWORD IS MINTED HERE, NOT ASKED FOR (#3626) ────────────────
 * This route used to REQUIRE `administratorLoginPassword` in the request body,
 * so the editor carried an "Admin password" box: the operator invented a
 * credential, typed it into a browser, and then had to remember it — while the
 * platform, which holds a Key Vault and a Secrets Officer role assignment on
 * it, did nothing. `auto-bind-by-default.md` §5 says the platform provisions
 * and binds; a password is the clearest case of a value it can produce itself.
 *
 * So: 24 bytes from `crypto.randomBytes` rendered base64url, plus one character
 * from each of the four classes Azure's PostgreSQL complexity policy requires
 * (upper, lower, digit, punctuation) — base64url alone can, with small
 * probability, contain no digit — then stored in Key Vault under a name derived
 * from the server. The VALUE never leaves this function: it goes to ARM and to
 * Key Vault, and the response carries only the secret NAME so the editor can
 * tell the operator where to find it.
 *
 * ORDER MATTERS, and it is deliberate. The secret is written BEFORE the ARM
 * call. If the write fails the server is never created, which is recoverable;
 * the other order would create a server whose admin password exists nowhere,
 * which is not. When the ARM create fails after a successful write, the
 * response says so in those words rather than implying the secret is unused —
 * a stale secret under a server that does not exist is harmless and is
 * overwritten by the next attempt with the same name.
 *
 * NO KEY VAULT MEANS NO PROVISION. `kvSecretsConfigGate()` is checked first and
 * returned as an honest gate naming the exact env var and role
 * (`no-vaporware.md`). Falling back to "mint it and show it once" would put a
 * live credential in an HTTP response body and in a browser, and falling back
 * to asking the user would reinstate the box this change removes.
 *
 * CLOUD PARITY: nothing here branches on boundary. `kv-secrets-client` resolves
 * the vault host through `cloud-endpoints` (`kvSuffix`/`kvScope`) and
 * `postgres-flex-client` resolves ARM the same way, so Commercial, GCC,
 * GCC-High, IL5 and DoD take the identical code path (`cloud-parity.md`).
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomBytes, randomInt } from 'node:crypto';
import { getSession } from '@/lib/auth/session';
import { listServers, createServer, PostgresError } from '@/lib/azure/postgres-flex-client';
import { kvSecretsConfigGate, putKeyVaultSecret, KeyVaultError } from '@/lib/azure/kv-secrets-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A password Azure PostgreSQL Flexible Server will accept: 8-128 chars drawn
 * from at least three of upper / lower / digit / non-alphanumeric. Entropy
 * comes from `randomBytes(24)`; the four appended characters only GUARANTEE the
 * classes, so a run of base64url that happens to be all letters is still valid.
 * `randomInt` (not `Math.random`) picks them, so no part of the value comes
 * from a predictable source.
 */
export function mintAdminPassword(): string {
  const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const LOWER = 'abcdefghijkmnopqrstuvwxyz';
  const DIGIT = '23456789';
  const PUNCT = '-_.~';
  const core = randomBytes(24).toString('base64url');
  const pick = (s: string) => s[randomInt(s.length)];
  return `${core}${pick(UPPER)}${pick(LOWER)}${pick(DIGIT)}${pick(PUNCT)}`;
}

/** Where the minted password lives, derived from the server it belongs to. */
export function adminSecretNameFor(serverName: string): string {
  return `pg-admin-${serverName}`;
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const servers = await listServers();
    return NextResponse.json({ ok: true, servers });
  } catch (e: any) {
    const status = e instanceof PostgresError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const name = String(body?.name || '').trim();
  const resourceGroup = String(body?.resourceGroup || '').trim();
  const location = String(body?.location || '').trim();
  const administratorLogin = String(body?.administratorLogin || '').trim();
  const skuName = String(body?.skuName || '').trim();
  const tier = String(body?.tier || '').trim();
  if (!name || !resourceGroup || !location || !administratorLogin || !skuName || !tier) {
    return NextResponse.json(
      { ok: false, error: 'name, resourceGroup, location, administratorLogin, skuName, tier are required' },
      { status: 400 },
    );
  }

  const kvGate = kvSecretsConfigGate();
  if (kvGate) {
    return NextResponse.json(
      {
        ok: false,
        code: 'kv_not_configured',
        error:
          'The admin password for a new PostgreSQL flexible server is minted by Loom and stored in Key Vault, ' +
          `and no vault is configured, so the server was NOT created. ${kvGate.detail}`,
        missing: kvGate.missing,
      },
      { status: 503 },
    );
  }

  const administratorLoginPassword = mintAdminPassword();
  let adminSecretName: string;
  try {
    ({ name: adminSecretName } = await putKeyVaultSecret(adminSecretNameFor(name), administratorLoginPassword));
  } catch (e: any) {
    const status = e instanceof KeyVaultError ? e.status : 502;
    return NextResponse.json(
      {
        ok: false,
        code: 'secret_write_failed',
        error:
          'Could not store the minted admin password in Key Vault, so the server was NOT created ' +
          `(nothing was provisioned): ${e?.message || String(e)}`,
      },
      { status },
    );
  }

  const result = await createServer({
    name, resourceGroup, location, administratorLogin, administratorLoginPassword,
    skuName, tier: tier as any,
    version: body?.version ? String(body.version).trim() : undefined,
    storageGb: typeof body?.storageGb === 'number' ? body.storageGb : undefined,
  });
  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        error:
          `${result.error} — the admin password had already been written to Key Vault as '${adminSecretName}'; ` +
          'it belongs to no server and the next attempt with this name overwrites it.',
        adminSecretName,
      },
      { status: result.status },
    );
  }
  return NextResponse.json(
    {
      ok: true,
      id: result.id,
      provisioningState: result.provisioningState,
      provisionedBy: session.claims.upn,
      adminSecretName,
    },
    { status: 201 },
  );
}
