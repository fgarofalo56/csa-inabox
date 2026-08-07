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
import { getSession } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { isValidInternalToken, INTERNAL_TOKEN_HEADER } from '@/lib/auth/internal-token';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { loadPolicySet } from '@/lib/governance/policy-code/store';
import { compileTrino, buildTrinoRulesDocument, rulesVersion } from '@/lib/governance/policy-code/compilers/trino';
import {
  readTrinoEngineRules,
  recordTrinoEngineFetch,
  trinoEnforcementStatus,
} from '@/lib/governance/policy-code/trino-engine-rules';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The dedicated secret name; falls back to the shared internal token. */
const TRINO_POLICY_TOKEN_ENV = 'LOOM_TRINO_POLICY_TOKEN';

type Caller =
  | { kind: 'engine'; who: string }
  | { kind: 'admin'; who: string; tenantId: string }
  | { kind: 'denied' };

function authenticate(req: NextRequest): Caller {
  // 1. The engine — internal trust token, dedicated secret preferred.
  const presented =
    req.headers.get(INTERNAL_TOKEN_HEADER)
    || (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
    || null;
  if (presented && isValidInternalToken(presented, TRINO_POLICY_TOKEN_ENV)) {
    return { kind: 'engine', who: 'loom-trino (internal token)' };
  }
  // 2. A tenant admin with a Loom session.
  const s = getSession();
  if (s && isTenantAdmin(s)) {
    return { kind: 'admin', who: s.claims.upn || s.claims.oid, tenantId: s.claims.tid || s.claims.oid };
  }
  return { kind: 'denied' };
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

export async function GET(req: NextRequest) {
  const caller = authenticate(req);
  if (caller.kind === 'denied') {
    return apiError(
      'unauthenticated — this endpoint serves the Trino engine (internal trust token) and tenant admins only',
      401,
    );
  }

  const format = (req.nextUrl.searchParams.get('format') || 'rules').trim().toLowerCase();
  const tenantId = caller.kind === 'admin' ? caller.tenantId : engineTenantId();
  if (!tenantId) {
    return apiError(
      'The deployment tenant could not be resolved (LOOM_ENTRA_TENANT_ID / AZURE_TENANT_ID are unset), so the '
      + 'engine rules cannot be scoped to a policy set. The admin-plane deployment sets this.',
      503,
    );
  }

  try {
    // Status is the admin receipt — never served to the engine (it does not
    // need it, and it would be a needless disclosure).
    if (format === 'status') {
      if (caller.kind !== 'admin') return apiError('format=status is for tenant admins', 403);
      const doc = await readTrinoEngineRules(tenantId);
      return apiOk({ status: trinoEnforcementStatus(doc), published: doc ? { version: doc.version, publishedAt: doc.publishedAt, policySetName: doc.policySetName } : null });
    }

    // Compile fresh from the stored policy set so the engine always receives the
    // CURRENT policy — a stale publication can never be served as authoritative.
    const { set } = await loadPolicySet(tenantId);
    const docOptions = {
      trinoSessionUser: (process.env.LOOM_TRINO_SESSION_USER || '').trim() || undefined,
      trinoDefaultCatalog: (process.env.LOOM_TRINO_ICEBERG_CATALOG || '').trim() || undefined,
      trinoGroupProvider: true,
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
      const published = await readTrinoEngineRules(tenantId);
      return new Response(published?.groupFile || '', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    const rules = buildTrinoRulesDocument(artifact, docOptions);
    const version = rulesVersion(rules);

    if (caller.kind === 'engine') {
      // The receipt. Best-effort: a Cosmos hiccup must never make the engine
      // fall back to a stale local file, so a stamp failure is logged and the
      // document is still served.
      await recordTrinoEngineFetch(tenantId, {
        at: new Date().toISOString(),
        version,
        catalogs: docOptions.catalogs.map((c) => c.name),
        by: caller.who,
      }).catch((e) => {
        // eslint-disable-next-line no-console
        console.warn('[trino-engine-rules] fetch receipt not recorded: %s', (e as Error)?.message || e);
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
  } catch (e) {
    return apiServerError(e, 'Failed to compile the Trino engine rules');
  }
}
