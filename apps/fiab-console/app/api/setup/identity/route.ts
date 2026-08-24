/**
 * GET /api/setup/identity  +  POST /api/setup/identity
 *
 * The Setup Wizard's "Identity & Admin" step (deploy-readiness, GH #1383).
 *
 * GET — session-gated scan-and-recommend for the auth domain:
 *   • current MSAL wiring (LOOM_MSAL_CLIENT_ID present?, the configured app id);
 *   • best-effort discovery of existing "CSA Loom Console" Entra app
 *     registrations via Microsoft Graph (so the wizard can offer use-existing);
 *   • the recommended bootstrap admin = the signed-in user's oid (from the
 *     session claims — always available, no Graph call needed);
 *   • the current bootstrap admin oid/group from env.
 *
 * POST — records the operator's choice (existing / new / disable for the app
 *   registration; self / group for the bootstrap admin) and returns the exact
 *   apply path. Changing the Entra app registration + the Console env is a
 *   privileged Graph + Container-App operation the Console UAMI is not granted
 *   on the default path, so this returns an HONEST config-only result (per
 *   no-vaporware.md "honest config-only state"): the precise
 *   scripts/csa-loom/bootstrap-msal-app-reg.sh invocation + deploy params that
 *   realize the choice. No fake "applied" success.
 *
 * No secrets are ever returned (mirrors the env-config masking convention).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * #3610 — INJECTION INTO A COPY-PASTE OPERATOR COMMAND
 * ───────────────────────────────────────────────────────────────────────────
 * POST's response is a command the product tells a PRIVILEGED HUMAN to paste
 * into a terminal, and a set of bicep `deployParams`. Both were assembled by
 * interpolating request text into single-quoted words:
 *
 *     `EXISTING_CLIENT_ID='${body.appRegistration.existingClientId.trim()}'`
 *     `CONSOLE_HOSTS='${consoleHosts}'`
 *     deployParams.loomMsalClientId       = `'${…existingClientId…}'`
 *     deployParams.loomTenantAdminGroupId = `'${adminGroupId}'`
 *
 * with NO validation on any of them. A single `'` closes the quoted word and
 * the rest of the field becomes shell syntax in a command line that already
 * carries KEYVAULT_NAME and CONSOLE_RG and ends in
 * `bash scripts/csa-loom/bootstrap-msal-app-reg.sh`. The same class as the
 * already-fixed GHSA-fj7j-qq8g-hqj8 (wire-existing), with the operator's
 * terminal as the sink instead of `execSync`.
 *
 * NOTE ON POPULATION: the issue named three sinks. There are FOUR
 * caller-controlled ones — it missed `loomTenantAdminGroupId`, fed from
 * `body.bootstrapAdmin.groupId` with only `.trim()`. And `deployParams` is a
 * SECOND paste target (bicep), not merely a duplicate of the shell string, so
 * fixing only the shell command would leave half the surface open.
 *
 * THE FIX — two layers, doing different jobs:
 *
 *   L1  SEMANTIC ALLOW-LISTS AT THE CALLER BOUNDARY (400, refuse — never
 *       escape). Escaping keeps the shell in the loop and is bypass-prone; the
 *       repo already chose refusal for the same class in wire-existing.ts, and
 *       {@link SUBSCRIPTION_ID_RE} — the canonical anchored 8-4-4-4-12 GUID
 *       pattern — is imported from there rather than re-declared, so there is
 *       one pattern to keep correct instead of two that can drift.
 *       What is emitted is the value WE re-assembled from validated tokens
 *       (normalized host list, matched GUID), not the caller's raw text.
 *
 *   L2  AN INERTNESS POST-CONDITION AT EVERY INTERPOLATION SINK ({@link q}).
 *       L1 only protects the fields someone remembered to validate. `q()` is
 *       the control that does not depend on that memory: every value that
 *       reaches a `'…'` word goes through it, and it throws if the value
 *       carries anything outside an inert set — no quote, no whitespace, no
 *       `;`/`|`/`&`/`$`/backtick/newline, nothing bicep would re-parse. A sink
 *       added later without an allow-list fails closed instead of shipping a
 *       hole.
 *
 *       `q()` only helps at sinks that CALL it, so `__tests__/identity-
 *       injection.test.ts` additionally classifies this file's emission sites:
 *       every `deployParams.<key> =` must be a static literal or a `q()` call,
 *       every `${…}` between `const deployParams` and the `return` must be a
 *       `q()` call, and string concatenation is not permitted in that region at
 *       all. The emitted `deployParams` key set is pinned at runtime as a
 *       second, syntax-independent detector.
 *
 *       That test also counts raw `'${…}'` occurrences and `q('` calls. Those
 *       counts are NECESSARY but NOT SUFFICIENT, and the difference was
 *       measured rather than reasoned: a sixth sink written as
 *       `deployParams.x = "'" + caller + "'"` leaves both counts unchanged and
 *       shipped green (RC=0, 36/36) with a live bicep-literal break-out. Do not
 *       read either count as "a sink cannot be added silently".
 *
 *       The emission-site classifier does NOT carry that claim either. Review
 *       round 3 measured where it stops, by mutating this file on disk and
 *       running the real 45-test suite. FOUR shapes stay GREEN at RC=0, 45/45:
 *       a bare expression added as an ELEMENT of the emitted command array; a
 *       `deployParams.<key> =` whose right-hand side only MENTIONS `q(` (rule 1
 *       tests for that substring, not for provenance); a concatenation sink in
 *       the RESPONSE OBJECT, which sits past the region end; and an earlier
 *       response `return`, which relocates the region end and silently shrinks
 *       the region while every floor still passes.
 *
 *       So the honest statement is the narrow one: BETWEEN the region markers,
 *       and only for the three shapes rules 1-3 name, a sink cannot be added
 *       silently. Outside that span nothing here is watching. Widening the
 *       classifier is tracked in #3955.
 *
 * Route-toolkit: the `withSession` wrapper [R3]. The prologue it replaces was
 * `const session = getSession(); if (!session) return NextResponse.json({ ok:
 * false, error: 'unauthenticated' }, { status: 401 })`; `apiUnauthorized()`
 * (lib/api/respond.ts:43) emits that exact body and status — asserted in the
 * test, not assumed.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { graphBase } from '@/lib/auth/msal';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
// The canonical anchored 8-4-4-4-12 GUID pattern, already tested and in use by
// the wire-existing injection fix. Imported (never re-declared) so the two
// injection boundaries cannot drift apart. An Entra application id and an Entra
// group object id are the same GUID shape as a subscription id.
import { SUBSCRIPTION_ID_RE as GUID_RE } from '@/lib/setup/wire-existing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const credential = uamiArmCredential();

interface DiscoveredApp {
  appId: string;
  displayName: string;
  redirectUris: string[];
}

// ───────────────────────────────────────────────────────────────────────────
// L1 — semantic allow-lists (refuse at the boundary)
// ───────────────────────────────────────────────────────────────────────────

/**
 * A single DNS host label set: `loom.example.com`. No scheme, no port, no path
 * — bootstrap-msal-app-reg.sh builds `https://${h}/auth/callback` from each
 * comma-separated element, so anything else is malformed input, not an
 * exotic-but-valid host.
 */
const HOSTNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** Refusal carrying the field name, so the wizard can point at the input. */
class InvalidIdentityInput extends Error {
  readonly field: string;
  constructor(field: string, expected: string) {
    super(`${field} is not valid: expected ${expected}`);
    this.field = field;
  }
}

/** A caller-supplied GUID (Entra app id / group object id) or a refusal. */
function requireGuid(field: string, raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!GUID_RE.test(v)) {
    throw new InvalidIdentityInput(field, 'a GUID (8-4-4-4-12 hexadecimal)');
  }
  return v;
}

/**
 * Normalize a comma-separated host list to a canonical, validated form.
 * Returns '' for an absent/empty list (the field is optional). Every element
 * must be a bare hostname; the emitted string is rebuilt from the accepted
 * tokens rather than echoed from the request.
 */
function normalizeConsoleHosts(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return '';
  const hosts = v.split(',').map((h) => h.trim()).filter(Boolean);
  if (hosts.length === 0) return '';
  for (const h of hosts) {
    if (h.length > 253 || !HOSTNAME_RE.test(h)) {
      throw new InvalidIdentityInput(
        'appRegistration.consoleHosts',
        'a comma-separated list of bare hostnames (no scheme, port or path)',
      );
    }
  }
  return hosts.join(',');
}

// ───────────────────────────────────────────────────────────────────────────
// L2 — inertness post-condition at every interpolation sink
// ───────────────────────────────────────────────────────────────────────────

/**
 * Characters that survive BOTH target grammars unchanged: a POSIX shell word
 * and a bicep string literal. Deliberately excludes every quote, all
 * whitespace and every line terminator, `;` `|` `&` `$` `` ` `` `(` `)` `<`
 * `>` `{` `}` `\` `!` `*` `?` `#` `~` `=` `+` `%` `[` `]` `^` — i.e. anything
 * either grammar could re-parse. A value matching this cannot end its quoted
 * word no matter which of the two contexts it lands in.
 */
const INERT_VALUE_RE = /^[A-Za-z0-9._:,/-]*$/;

/** Thrown when a value reaches a sink without having passed an allow-list. */
export class UnsafeInterpolationError extends Error {
  readonly field: string;
  constructor(field: string) {
    // Deliberately does NOT echo the offending value — this message can reach a
    // log, and per deploy-integrity.md R7 it states only what was established.
    super(`refusing to emit ${field}: the value is not inert for a shell/bicep literal`);
    this.field = field;
  }
}

/**
 * Quote `value` for emission into a shell word or a bicep string literal,
 * asserting first that it cannot escape either. EVERY interpolated value in
 * this route goes through this function today, and that is asserted — but by a
 * classifier with a MEASURED boundary, not a universal one:
 * __tests__/identity-injection.test.ts classifies every `deployParams.<key> =`
 * write file-wide, and every interpolation and concatenation BETWEEN
 * `const deployParams` and the first response `return`. It does not reach
 * command-array elements, the response object, or anything above that first
 * marker; see the note on L2 in the module docblock for the four shapes that
 * were measured GREEN, and #3955 for the widening. The emitted `deployParams`
 * key set is additionally pinned at runtime, which catches an added key
 * whatever syntax produced it — but only for the request shapes the suite
 * drives.
 */
function q(field: string, value: string): string {
  if (!INERT_VALUE_RE.test(value)) throw new UnsafeInterpolationError(field);
  return `'${value}'`;
}

/** Best-effort Graph discovery of existing Loom Console app registrations.
 * Returns [] (with reachable=false) when the UAMI lacks Application.Read.All —
 * the wizard then still offers provision-new / BYO without a hard error. */
async function discoverApps(): Promise<{ reachable: boolean; apps: DiscoveredApp[] }> {
  try {
    const graph = graphBase();
    const t = await credential.getToken(`${graph}/.default`);
    if (!t?.token) return { reachable: false, apps: [] };
    const url =
      `${graph}/v1.0/applications?$select=appId,displayName,web` +
      `&$filter=${encodeURIComponent("startswith(displayName,'CSA Loom Console')")}`;
    const r = await fetch(url, { headers: { authorization: `Bearer ${t.token}` }, cache: 'no-store' });
    if (!r.ok) return { reachable: false, apps: [] };
    const j: any = await r.json().catch(() => null);
    const apps: DiscoveredApp[] = (j?.value || []).map((a: any) => ({
      appId: a.appId,
      displayName: a.displayName,
      redirectUris: a?.web?.redirectUris || [],
    }));
    return { reachable: true, apps };
  } catch {
    return { reachable: false, apps: [] };
  }
}

export const GET = withSession(async (_req, { session }) => {
  const configuredClientId = (process.env.LOOM_MSAL_CLIENT_ID || '').trim();
  const msalConfigured = !!configuredClientId && !!(process.env.LOOM_MSAL_CLIENT_SECRET || '').trim();
  const adminOid = (process.env.LOOM_TENANT_ADMIN_OID || '').trim();
  const adminGroupId = (process.env.LOOM_TENANT_ADMIN_GROUP_ID || '').trim();

  const { reachable, apps } = await discoverApps();

  return NextResponse.json({
    ok: true,
    msal: {
      configured: msalConfigured,
      configuredClientId: configuredClientId || undefined,
      tenantId: (process.env.AZURE_TENANT_ID || process.env.LOOM_MSAL_TENANT_ID || '').trim() || undefined,
      // Recommendation: provision-new when nothing is wired, else keep current.
      recommendation: msalConfigured ? 'existing' : 'new',
    },
    appRegistrations: { reachable, items: apps },
    bootstrapAdmin: {
      currentOid: adminOid || undefined,
      currentGroupId: adminGroupId && !adminGroupId.startsWith('<') ? adminGroupId : undefined,
      // Recommendation: the signed-in user is the safest first admin.
      recommendedOid: session.claims.oid,
      recommendedUpn: session.claims.upn,
      configured: !!adminOid || (!!adminGroupId && !adminGroupId.startsWith('<')),
    },
    session: { value: true },
  });
});

interface IdentityChoice {
  appRegistration?: { mode?: 'existing' | 'new' | 'disable'; existingClientId?: string; consoleHosts?: string };
  bootstrapAdmin?: { mode?: 'self' | 'group'; groupId?: string };
}

export const POST = withSession(async (req: NextRequest, { session }) => {
  const body = (await req.json().catch(() => ({}))) as IdentityChoice;
  const appMode = body.appRegistration?.mode || 'new';
  const adminMode = body.bootstrapAdmin?.mode || 'self';

  // L1 — validate every caller-controlled field that can reach an emitted
  // string, and refuse the whole request rather than escaping or dropping it.
  let existingClientId = '';
  let adminGroupId = '';
  let consoleHosts = '';
  try {
    // Only validated where it is actually EMITTED: the wizard always sends
    // `existingClientId`, so requiring it in 'new'/'disable' mode would refuse
    // legitimate requests for a value that is never used.
    if (appMode === 'existing') {
      existingClientId = requireGuid('appRegistration.existingClientId', body.appRegistration?.existingClientId);
    }
    if (adminMode === 'group') {
      adminGroupId = requireGuid('bootstrapAdmin.groupId', body.bootstrapAdmin?.groupId);
    }
    consoleHosts = normalizeConsoleHosts(body.appRegistration?.consoleHosts);
  } catch (e) {
    if (e instanceof InvalidIdentityInput) {
      return NextResponse.json({ ok: false, error: e.message, field: e.field }, { status: 400 });
    }
    throw e;
  }

  // Session-derived, therefore NOT part of the caller-controlled population —
  // but it is still interpolated, so it still goes through the L2 sink guard.
  const adminOid = adminMode === 'group' ? '' : session.claims.oid;

  // Honest config-only result: emit the precise apply path. Changing the Entra
  // app registration + Console env requires Graph app-admin + Container-App
  // write that the Console UAMI is not granted by default, so we DO NOT fake an
  // "applied" success. The operator (or CI) runs the bootstrap script + deploy.
  const deployParams: Record<string, string> = {};
  if (appMode === 'disable') {
    deployParams.loomMsalClientId = "''";
    deployParams.loomMsalAppReg = "{ enabled: false }";
  } else if (appMode === 'existing') {
    deployParams.loomMsalClientId = q('appRegistration.existingClientId', existingClientId);
    deployParams.loomMsalAppReg = '{ enabled: true }';
  } else {
    deployParams.loomMsalAppReg = '{ enabled: true }';
  }
  if (adminOid) deployParams.loomTenantAdminOid = q('session.claims.oid', adminOid);
  if (adminGroupId) deployParams.loomTenantAdminGroupId = q('bootstrapAdmin.groupId', adminGroupId);

  const bootstrapCmd =
    appMode === 'disable'
      ? null
      : [
          'KEYVAULT_NAME=<kv-loom-*>',
          consoleHosts ? `CONSOLE_HOSTS=${q('appRegistration.consoleHosts', consoleHosts)}` : null,
          appMode === 'existing'
            ? `EXISTING_CLIENT_ID=${q('appRegistration.existingClientId', existingClientId)}`
            : null,
          'CONSOLE_APP_NAME=loom-console CONSOLE_RG=<admin-rg>',
          'bash scripts/csa-loom/bootstrap-msal-app-reg.sh',
        ]
          .filter(Boolean)
          .join(' ');

  return NextResponse.json({
    ok: true,
    status: 'config-recorded',
    applied: false,
    appRegistration: { mode: appMode },
    bootstrapAdmin: { mode: adminMode, oid: adminOid || undefined, groupId: adminGroupId || undefined },
    apply: {
      deployParams,
      bootstrapScript: bootstrapCmd,
      note:
        'Provisioning the Entra app registration + setting the Console env is a ' +
        'privileged Graph + Container-App action. Run the bootstrapScript above ' +
        '(or re-deploy with the deployParams) to realize this choice; the ' +
        'push-button deploy + post-deploy bootstrap do this automatically.',
    },
  });
});
