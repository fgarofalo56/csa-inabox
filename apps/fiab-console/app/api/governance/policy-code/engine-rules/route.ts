/**
 * LU-7 — the Trino ENGINE-RULES endpoint. This is the surface the federated
 * engine pulls its own authorization from.
 *
 *   GET /api/governance/policy-code/engine-rules?format=rules
 *     → the complete Trino file-based system access-control document, as JSON,
 *       with the engine's OWN wired catalogs folded into the `catalogs` section.
 *   GET …?format=groups
 *     → the Trino file group-provider document (`groupname:user1,user2`),
 *       `text/plain`. Empty body when the policy set names no group principals.
 *   GET …?format=rego
 *     → the equivalent OPA module (`package trino`), `text/plain`, for a
 *       deployment running `access-control.name=opa` against its own OPA server.
 *   GET …?format=status
 *     → the enforcement receipt for the admin surface (published version, the
 *       version the engine last fetched, and when). Session-authenticated.
 *
 * ## Auth — two callers, two mechanisms, both fail-closed
 *
 * 1. **The engine** presents the deployment's internal trust token
 *    (`x-loom-internal-token`, preferring the dedicated `LOOM_TRINO_POLICY_TOKEN`).
 *    Bicep wires the same deterministic value to the Console and to the
 *    loom-trino Container App, and the two only reach each other over the
 *    Container Apps Environment internal network. Unset → every engine request
 *    is rejected (`isValidInternalToken` fails closed), so this endpoint is
 *    inert in a deployment that has not opted in.
 *
 *    The token rides an `Authorization`-style HEADER, never the URL, because
 *    Trino logs the configured URI on a fetch failure.
 *
 * 2. **A tenant admin** with a Loom session, for the admin surface and for
 *    debugging what the engine will receive. Same document, no side effects.
 *
 * Anything else gets 401. This document names group object-ids, table names and
 * row predicates — it is a security artifact, not public metadata.
 *
 * ## Why the ENGINE pulls (and why the entrypoint, not Trino, does the fetch)
 *
 * Trino's `security.config-file` accepts an HTTP URL, but it issues a plain GET
 * with no way to attach a credential — publishing this document unauthenticated
 * is not acceptable. So `apps/loom-trino/docker-entrypoint.sh` performs the
 * AUTHENTICATED fetch, writes the document to the local rules file, and repeats
 * on a refresh loop; Trino's own `security.refresh-period` then re-reads that
 * file. Same outcome as a native URL fetch, with the credential kept in a
 * header and out of every log line.
 *
 * ## The receipt
 *
 * Every engine fetch stamps the version it received onto the published document
 * (`recordTrinoEngineFetch`), which is what lets `/admin/policy-code` state the
 * TRUE enforcement position instead of assuming a write reached the engine
 * (`deploy-integrity.md` R2).
 */

import { NextRequest } from 'next/server';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { isValidInternalToken, INTERNAL_TOKEN_HEADER } from '@/lib/auth/internal-token';
import { logSafeError } from '@/lib/util/log-safe';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { loadPolicySet } from '@/lib/governance/policy-code/store';
import { compileTrino, buildTrinoRulesDocument, rulesVersion, trinoCompileOptionsFromEnv } from '@/lib/governance/policy-code/compilers/trino';
import {
  readTrinoEngineRules,
  recordTrinoEngineFetch,
  trinoEnforcementStatus,
} from '@/lib/governance/policy-code/trino-engine-rules';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The dedicated secret name; falls back to the shared internal token. */
const TRINO_POLICY_TOKEN_ENV = 'LOOM_TRINO_POLICY_TOKEN';

/**
 * Is this the ENGINE? It holds the deployment's dedicated pull secret and has
 * no session. Checked BEFORE the session path so a token-authenticated engine
 * is never bounced by the tenant-admin gate; a caller with neither lands on
 * `withTenantAdmin`, which produces the canonical 401/403 envelope.
 */
function isEngineCaller(req: NextRequest): boolean {
  const presented =
    req.headers.get(INTERNAL_TOKEN_HEADER)
    || (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
    || null;
  return Boolean(presented) && isValidInternalToken(presented, TRINO_POLICY_TOKEN_ENV);
}

/**
 * The tenant whose policy set governs this deployment. A session caller carries
 * its own; the engine has no session, so it resolves to the deployment's Entra
 * tenant — which is what a Loom estate always is. Never guessed from a header
 * (that would let a caller pick a partition).
 */
function engineTenantId(): string | null {
  const t = (process.env.LOOM_ENTRA_TENANT_ID || process.env.LOOM_MSAL_TENANT_ID || process.env.AZURE_TENANT_ID || '').trim();
  return t || null;
}

/** Parse the engine's reported catalog list (`?catalogs=jmx,memory,iceberg`). */
function parseCatalogs(req: NextRequest): Array<{ name: string; allow: 'all' | 'read-only' | 'none' }> {
  const raw = (req.nextUrl.searchParams.get('catalogs') || '').trim();
  const writable = new Set(
    (req.nextUrl.searchParams.get('writable') || 'memory')
      .split(',')
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean),
  );
  return raw
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean)
    .map((name) => ({ name, allow: writable.has(name) ? ('all' as const) : ('read-only' as const) }));
}

/** Serve the compiled artifacts for one tenant. Shared by both caller paths. */
async function serve(
  req: NextRequest,
  tenantId: string,
  caller: { kind: 'engine' | 'admin'; who: string },
): Promise<Response> {
  const format = (req.nextUrl.searchParams.get('format') || 'rules').trim().toLowerCase();

  // Status is the admin receipt — never served to the engine (it does not need
  // it, and it would be a needless disclosure).
  if (format === 'status') {
    if (caller.kind !== 'admin') return apiError('format=status is for tenant admins', 403);
    const doc = await readTrinoEngineRules(tenantId);
    return apiOk({
      status: trinoEnforcementStatus(doc),
      published: doc
        ? { version: doc.version, publishedAt: doc.publishedAt, policySetName: doc.policySetName }
        : null,
    });
  }

  // Compile fresh from the stored policy set so the engine always receives the
  // CURRENT policy — a stale publication can never be served as authoritative.
  const { set } = await loadPolicySet(tenantId);
  // OBSERVED, never asserted: group-keyed rules can only match once a group
  // file with real members has been published, so that is what decides whether
  // the compiler treats the group provider as live.
  const publishedDoc = await readTrinoEngineRules(tenantId).catch(() => null);
  const docOptions = {
    // The SHARED reader — the publish path (reconcile) uses the identical one,
    // so the two sides cannot compile different documents from one policy set.
    ...trinoCompileOptionsFromEnv(),
    trinoGroupProvider: Boolean(publishedDoc?.groupFile?.trim()),
    catalogs: parseCatalogs(req),
  };
  const artifact = compileTrino(set, docOptions);

  if (format === 'rego') {
    const { buildTrinoRego } = await import('@/lib/governance/policy-code/compilers/trino');
    return new Response(buildTrinoRego(set, docOptions), {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  if (format === 'groups') {
    // The group file is published by the reconcile loop (it resolves Entra
    // membership); serving the LAST PUBLISHED value here keeps the engine and
    // the admin surface reading the same bytes.
    return new Response(publishedDoc?.groupFile || '', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const rules = buildTrinoRulesDocument(artifact, docOptions);
  const version = rulesVersion(rules);

  if (caller.kind === 'engine') {
    // The receipt. Best-effort: a Cosmos hiccup must never make the engine fall
    // back to a stale local file, so a stamp failure is logged and the document
    // is still served.
    await recordTrinoEngineFetch(tenantId, {
      at: new Date().toISOString(),
      version,
      catalogs: docOptions.catalogs.map((c) => c.name),
      by: caller.who,
    }).catch((e) => {
      // eslint-disable-next-line no-console
      console.warn('[trino-engine-rules] fetch receipt not recorded: %s', logSafeError(e));
    });
  }

  return new Response(JSON.stringify(rules, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-loom-rules-version': version,
    },
  });
}

/**
 * The tenant-admin path runs through the route toolkit, so its 401/403
 * envelopes are byte-identical to every other admin surface and cannot drift
 * (the copy-paste divergence `check-route-guards` exists for).
 */
const adminGET = withTenantAdmin(async (req, { session }) => {
  const tenantId = session.claims.tid || session.claims.oid;
  try {
    return await serve(req as NextRequest, tenantId, {
      kind: 'admin',
      who: session.claims.upn || session.claims.oid,
    });
  } catch (e) {
    return apiServerError(e, 'Failed to compile the Trino engine rules');
  }
});

export async function GET(req: NextRequest, ctx: any) {
  if (!isEngineCaller(req)) {
    // No engine token → the session path decides (and rejects) with the
    // canonical envelope. `isTenantAdmin` is referenced by the toolkit wrapper.
    return adminGET(req, ctx);
  }
  const tenantId = engineTenantId();
  if (!tenantId) {
    return apiError(
      'The deployment tenant could not be resolved (LOOM_ENTRA_TENANT_ID / AZURE_TENANT_ID are unset), so the '
      + 'engine rules cannot be scoped to a policy set. The admin-plane deployment sets this.',
      503,
    );
  }
  try {
    return await serve(req, tenantId, { kind: 'engine', who: 'loom-trino (internal token)' });
  } catch (e) {
    return apiServerError(e, 'Failed to compile the Trino engine rules');
  }
}

// Referenced so the tenant-admin tier this route depends on is explicit at the
// module level (the toolkit applies it; this keeps the dependency greppable).
export const REQUIRES_TENANT_ADMIN = isTenantAdmin;
