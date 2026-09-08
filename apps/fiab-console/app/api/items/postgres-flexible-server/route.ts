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
 * So the server is RESOLVED FIRST, and — with the name gate added below — there
 * are exactly SIX outcomes, only the last of which writes anything:
 *   - the name is outside the ARM charset, or folds onto another server's
 *     secret → 400, before the vault is even consulted.
 *   - a server of that name exists in this subscription → 409, nothing is
 *     minted and nothing is written. The existing secret is untouched.
 *   - a DIFFERENT server owns the secret slot this name derives → 409, same
 *     refusal, and the message names that server.
 *   - the lookup itself fails → 503, nothing is minted and nothing is written.
 *     Absence was NOT established, so it is not assumed.
 *   - the lookup TRUNCATES → 503, same refusal. See below; this is the third
 *     state that a "did I find it?" boolean cannot represent.
 *   - the lookup completes and the slot is free → mint, write, create.
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
 * ── AND THE CHECK MUST BE KEYED ON WHERE THE WRITE LANDS (re-review, 2026-09-08)
 * Both versions above compared the RAW request name against the listing, while
 * the write went to `sanitizeSecretName('pg-admin-<name>')` — and that map is
 * MANY-TO-ONE: `prod_pg`, `prod.pg`, `prod pg`, `prod--pg`, `prod%pg` and
 * `prod-pg-` all land in `pg-admin-prod-pg`, the slot holding the live
 * `prod-pg` server's credential. None of them equals `prod-pg`, so the exact
 * comparison passed, the mint ran, the write clobbered a live credential, and
 * ARM then rejected the name anyway. Two changes close it, and both are here
 * because each covers a case the other does not:
 *
 *   1. `name` is VALIDATED FIRST against the documented flexible-server rule —
 *      3-63 characters of lowercase letters, digits and hyphens, not starting
 *      or ending with one (`resource-name-rules.md`,
 *      Microsoft.DBforPostgreSQL). Every folding character above is outside
 *      that charset, so the 400 lands before anything is minted or written.
 *      Repeated hyphens are legal at ARM but still fold, so a name whose
 *      derived secret is not itself (`prod--pg`) is refused separately and
 *      says exactly why, rather than being called an invalid server name it
 *      is not.
 *   2. The collision check is keyed on the DESTINATION SLOT, not the input:
 *      an EXISTING server may itself carry a folding name (`prod--pg` is a
 *      legal server), so a brand-new, perfectly legal `prod-pg` would still
 *      write into its slot. Validation alone cannot see that; the slot
 *      comparison can.
 *
 * `adminSecretNameFor()` therefore returns the slot the write actually uses —
 * the folded string `putKeyVaultSecret` would have produced anyway — so every
 * branch that names the secret at risk names the SAME string. Before this, four
 * branches printed the unfolded form and two printed the folded one, for the
 * same slot.
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

/**
 * Azure PostgreSQL flexible-server names: 3-63 characters of lowercase letters,
 * digits and hyphens, not starting or ending with a hyphen — the documented
 * rule for `Microsoft.DBforPostgreSQL` servers (azure-resource-manager
 * `resource-name-rules.md`). ARM enforces it, but only AFTER the Key Vault
 * write in this route's ordering, which is why the route enforces it FIRST.
 */
export const SERVER_NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/**
 * Where the minted password lives, derived from the server it belongs to.
 *
 * This returns the SLOT THE WRITE ACTUALLY USES. `putKeyVaultSecret` runs its
 * argument through `sanitizeSecretName`, so a function that stopped at
 * `pg-admin-${serverName}` would name a secret that does not exist whenever the
 * server name carries a character Key Vault folds. Every branch below reports
 * this string, and the collision check compares it, so the name in the message
 * and the name on the write are the same name (`deploy-integrity.md` R7).
 *
 * WHY THE FOLD IS SPELLED OUT HERE rather than calling `sanitizeSecretName`:
 * this function's whole domain is names ARM already accepts — the request name
 * has passed `SERVER_NAME_RE` before the first call, and every other argument
 * comes back from the ARM listing, so ARM enforced the same rule on it. Over
 * that domain `sanitizeSecretName('pg-admin-' + n)` reduces, term by term, to
 * one hyphen-run collapse:
 *   - `[^0-9a-zA-Z-] -> '-'` is a no-op: `[a-z0-9-]` is inside the kept set;
 *   - `-+ -> '-'` is the only step that can fire, and only inside `n`, since
 *     `n` starts with an alphanumeric so the `pg-admin-` join is never a run;
 *   - trimming a leading/trailing `-` is a no-op: the string starts `p` and
 *     ends on `n`'s last character, which the rule forces to be alphanumeric;
 *   - `slice(0, 127)` is a no-op: 9 + at most 63 characters.
 * `postgres-flexible-server/__tests__/provision-credentials.test.ts` mocks
 * `@/lib/azure/kv-secrets-client` for the write, and a route that imported the
 * sanitizer from that module would be reaching through the mock for a pure
 * string function. The equality above is not assumed: it is asserted against
 * the REAL `sanitizeSecretName` over this whole domain in
 * `app/api/items/__tests__/azure-sql-databases-routes.test.ts`, so a change to
 * the sanitizer turns that test red instead of silently splitting the two.
 *
 * Collapsing is idempotent, so passing this to `putKeyVaultSecret` — which
 * sanitizes again — is a no-op the second time round.
 */
export function adminSecretNameFor(serverName: string): string {
  return `pg-admin-${serverName}`.replace(/-+/g, '-');
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

  /**
   * NAME BEFORE ANYTHING ELSE. Everything downstream — the collision check, the
   * mint, the Key Vault write — assumes `name` identifies exactly one secret
   * slot. `sanitizeSecretName` is many-to-one over arbitrary strings, so that
   * assumption only holds once the name is inside the charset ARM allows.
   * Rejecting here costs the caller a 400 on a name ARM would have rejected
   * anyway; NOT rejecting costs a live server its recorded password.
   */
  if (!SERVER_NAME_RE.test(name)) {
    return NextResponse.json(
      {
        ok: false,
        code: 'invalid_name',
        error:
          `'${name}' is not a valid PostgreSQL flexible-server name: Azure requires 3-63 characters of ` +
          'lowercase letters, digits and hyphens, not starting or ending with a hyphen. Nothing was minted, ' +
          'nothing was written to Key Vault, and no server was created — the name is refused here rather than ' +
          'at ARM because the admin-password secret is written before the create, and characters outside that ' +
          "set collapse onto another server's secret.",
      },
      { status: 400 },
    );
  }
  const adminSecretSlot = adminSecretNameFor(name);
  if (adminSecretSlot !== `pg-admin-${name}`) {
    // A legal server name that still FOLDS. Repeated hyphens are the only case
    // that survives the charset check, and it is a real one: `prod--pg` is a
    // name ARM accepts whose secret slot is `pg-admin-prod-pg`. Calling it an
    // invalid server name would be false, so it gets its own reason.
    return NextResponse.json(
      {
        ok: false,
        code: 'ambiguous_secret_name',
        error:
          `'${name}' is a legal server name, but Key Vault secret names collapse repeated hyphens, so its ` +
          `admin password would be stored in '${adminSecretSlot}' — the same secret another server's name ` +
          'maps to. Loom will not write a credential into a slot that does not identify one server. Nothing ' +
          'was minted, nothing was written to Key Vault, and no server was created. Choose a name without ' +
          'repeated hyphens.',
        adminSecretName: adminSecretSlot,
      },
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
            `password overwritten in '${adminSecretSlot}'. Raise LOOM_ARM_PAGING_MAX_PAGES or ` +
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
  /**
   * COLLISION IS A PROPERTY OF THE SLOT, NOT OF THE NAME. `name` is already
   * known to derive its own slot one-to-one (validated above), but an EXISTING
   * server need not: `prod--pg` is a legal server whose slot is
   * `pg-admin-prod-pg`, so a brand-new, perfectly legal `prod-pg` would write
   * over its credential. Comparing slots catches that; comparing names cannot.
   * The exact-name hit is looked for first only so the 409 can say which of the
   * two things happened.
   */
  const named = existing.find((s) => s.name.toLowerCase() === name.toLowerCase());
  const slotOwner = named ?? existing.find(
    (s) => adminSecretNameFor(s.name).toLowerCase() === adminSecretSlot.toLowerCase(),
  );
  if (slotOwner) {
    return NextResponse.json(
      {
        ok: false,
        code: named ? 'server_exists' : 'secret_slot_taken',
        error: named
          ? `A PostgreSQL flexible server named '${name}' already exists in this subscription ` +
            `(${slotOwner.id}). Flexible-server names are globally unique, so the create would have failed at ` +
            `ARM — and the attempt would have overwritten '${adminSecretSlot}', which holds that server's ` +
            'live admin password. Nothing was minted, written or created. Choose a different name, or manage ' +
            'the existing server from its item page.'
          : `The admin password for '${name}' would be stored in '${adminSecretSlot}', and that secret already ` +
            `holds the live admin password of a DIFFERENT server in this subscription, '${slotOwner.name}' ` +
            `(${slotOwner.id}): Key Vault collapses repeated hyphens, so both names map onto the one slot. ` +
            'Nothing was minted, written or created. Choose a name that differs by more than a repeated hyphen.',
        existingId: slotOwner.id,
        existingName: slotOwner.name,
        adminSecretName: adminSecretSlot,
      },
      { status: 409 },
    );
  }

  const administratorLoginPassword = mintAdminPassword();
  let adminSecretName: string;
  try {
    ({ name: adminSecretName } = await putKeyVaultSecret(adminSecretSlot, administratorLoginPassword));
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
          `identity) showed no PostgreSQL flexible server whose admin-password secret is '${adminSecretName}' — ` +
          `neither one named '${name}' nor one whose name folds onto the same secret — so that secret is not ` +
          'the credential of any server Loom can see here; the next attempt with this name overwrites it. ' +
          'Flexible-server names are globally unique, so if the name is taken in another subscription or ' +
          'tenant — or in a scope this identity cannot enumerate — that server is invisible to this check and ' +
          'may be why the create failed.',
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
