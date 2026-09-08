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
 * which is not.
 *
 * ── BUT THE WRITE IS NOT UNCONDITIONAL (blocking review, 2026-09-07) ────────
 * That ordering is sound for a genuinely NEW server and wrong for a reused
 * name, and this route used to make no distinction. Flexible-server names are
 * globally unique — the server answers on `<name>.<pg-suffix>` — so a POST
 * naming a server this estate already created ALWAYS fails at ARM. It failed
 * AFTER `putKeyVaultSecret` had already overwritten `pg-admin-<name>` with a
 * fresh password the live server does not have, and the response then asserted
 * that the secret "belongs to no server", which the code had established
 * nothing about. That is a `deploy-integrity.md` R7 claim and, for the
 * operator, the loss of the working credential of a running server (Key Vault
 * versioning is the only reason it was recoverable at all).
 *
 * So the server is RESOLVED FIRST, and there are exactly FOUR outcomes:
 *   - a server of that name exists in this subscription → 409, nothing is
 *     minted and nothing is written. The existing secret is untouched.
 *   - the lookup itself fails → 503, nothing is minted and nothing is written.
 *     Absence was NOT established, so it is not assumed.
 *   - the lookup TRUNCATES → 503, same refusal. See below; this is the third
 *     state that a "did I find it?" boolean cannot represent.
 *   - the lookup completes and the name is free → mint, write, create.
 *
 * ── AND A LIST IS NOT A LOOKUP UNTIL IT IS WHOLE (re-review, 2026-09-07) ────
 * The first version of that gate called a `listServers()` that read ONE ARM
 * page and returned `res.value` — no `nextLink` walk. So it established only
 * that the name was absent from the FIRST page of the subscription list, and a
 * server on page 2+ took the "free" branch: mint, overwrite `pg-admin-<name>`,
 * fail at ARM, and then assert subscription-wide absence — the exact R7 shape
 * this route was rewritten to remove, reintroduced one layer down.
 * `postgres-flex-client` now walks `nextLink` under the shared `PagingBudget`
 * like every other ARM client here, and `listServersResult()` reports
 * `truncatedBy` so this route can tell "I read every page and it is not there"
 * apart from "I stopped early". TRUNCATED IS NOT ABSENT: it takes the same
 * fail-closed 503 as a lookup that threw, because the cost of guessing is the
 * same overwritten credential either way.
 *
 * The failure text after a create failure now says only what the lookup
 * established, in the scope it established it: no server of that name was
 * VISIBLE TO THE CONSOLE IDENTITY in this subscription across every page ARM
 * returned, at the moment the request began. A server in a subscription or
 * tenant this identity cannot enumerate is invisible to that check and the
 * message says so rather than asserting the secret belongs to nothing.
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
import { listServers, listServersResult, createServer, PostgresError } from '@/lib/azure/postgres-flex-client';
import { kvSecretsConfigGate, putKeyVaultSecret, KeyVaultError } from '@/lib/azure/kv-secrets-client';
import { withSession } from '@/lib/api/route-toolkit';

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

export const GET = withSession(async () => {
  try {
    const servers = await listServers();
    return NextResponse.json({ ok: true, servers });
  } catch (e: any) {
    const status = e instanceof PostgresError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
});

export const POST = withSession(async (req: NextRequest, { session }) => {
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

  /**
   * RESOLVE BEFORE MINTING. `listServersResult()` walks every `nextLink` page of
   * the subscription list under the shared PagingBudget, and reports whether it
   * got to the end. A hit means the ARM create is going to fail on a name
   * collision, so nothing may be minted and nothing written — the secret already
   * under that name is the LIVE server's credential.
   *
   * A direct ARM GET on `<resourceGroup>/<name>` was considered as a complement
   * (404 = absent). It is not added: the KV secret name is RG-independent, so it
   * could not replace the list, and it sees exactly what the list sees — both
   * are the same identity against the same RBAC — so behind a COMPLETE walk it
   * adds a round-trip and no information.
   */
  let existing: Awaited<ReturnType<typeof listServers>>;
  try {
    const lookup = await listServersResult();
    if (lookup.truncatedBy) {
      // The THIRD state. The walk stopped on its own ceiling, not on the end of
      // the list, so the pages it never read may hold this exact name. Refuse
      // for the same reason as a thrown lookup: absence was not established.
      return NextResponse.json(
        {
          ok: false,
          code: 'existence_check_failed',
          error:
            `Could not determine whether a PostgreSQL flexible server named '${name}' already exists in this ` +
            `subscription: the listing stopped on its ${lookup.truncatedBy} budget after ${lookup.pagesFetched} ` +
            'page(s), so pages of the subscription were never read. Nothing was minted, nothing was written to ' +
            'Key Vault, and no server was created — a name on an unread page would have had its live admin ' +
            `password overwritten in '${adminSecretNameFor(name)}'. Raise LOOM_ARM_PAGING_MAX_PAGES or ` +
            'LOOM_ARM_PAGING_BUDGET_MS and retry.',
          truncatedBy: lookup.truncatedBy,
          pagesFetched: lookup.pagesFetched,
        },
        { status: 503 },
      );
    }
    existing = lookup.servers;
  } catch (e: any) {
    // Fail CLOSED. Not finding out is not the same as finding nothing, and the
    // cost of assuming absence here is overwriting a live credential.
    const status = e instanceof PostgresError ? e.status : 502;
    return NextResponse.json(
      {
        ok: false,
        code: 'existence_check_failed',
        error:
          `Could not determine whether a PostgreSQL flexible server named '${name}' already exists in this ` +
          'subscription, so nothing was minted, nothing was written to Key Vault, and no server was created. ' +
          'Creating one blind would overwrite the admin password of an existing server of the same name. ' +
          `The lookup failed with: ${e?.message || String(e)}`,
      },
      { status: status === 401 || status === 403 ? status : 503 },
    );
  }
  const hit = existing.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (hit) {
    return NextResponse.json(
      {
        ok: false,
        code: 'server_exists',
        error:
          `A PostgreSQL flexible server named '${name}' already exists in this subscription ` +
          `(${hit.id}). Flexible-server names are globally unique, so the create would have failed at ARM — ` +
          `and the attempt would have overwritten '${adminSecretNameFor(name)}', which holds that server's ` +
          'live admin password. Nothing was minted, written or created. Choose a different name, or manage ' +
          'the existing server from its item page.',
        existingId: hit.id,
        adminSecretName: adminSecretNameFor(name),
      },
      { status: 409 },
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
          `${result.error} — the admin password had already been written to Key Vault as '${adminSecretName}'. ` +
          `Before it was written, a full listing of THIS subscription (every page ARM returned to the console ` +
          `identity) showed no PostgreSQL flexible server named '${name}', so that secret is not the credential ` +
          'of any server Loom can see here; the next attempt with this name overwrites it. Flexible-server names ' +
          'are globally unique, so if the name is taken in another subscription or tenant — or in a scope this ' +
          'identity cannot enumerate — that server is invisible to this check and may be why the create failed.',
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
});
