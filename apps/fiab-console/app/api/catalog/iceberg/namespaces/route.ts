/**
 * GET  /api/catalog/iceberg/namespaces[?parent=<dotted-ns>]
 *   — list Iceberg namespaces (`GET <prefix>/v1/namespaces`).
 * POST /api/catalog/iceberg/namespaces   body: { namespace, properties? }
 *   — create a namespace (`POST <prefix>/v1/namespaces`).
 *
 * Real backend: the internal-ingress Unity Catalog OSS container. Entra auth is
 * injected server-side. Auth: cookie session OR a scoped Loom API token (a
 * read-only token cannot POST — enforced by `enforcePatAccess`).
 *
 * Audited: `namespace.list` (aggregated — one row carrying `resultCount`) and
 * `namespace.create` data-access rows.
 */
import { NextResponse } from 'next/server';
import { withIrcCaller, auditedIrc } from '../_lib/irc-proxy';
import {
  createNamespace,
  listNamespaces,
  namespaceToDotted,
} from '@/lib/azure/iceberg-catalog-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withIrcCaller(async (req, ctx) => {
  const parent = (req.nextUrl.searchParams.get('parent') || '').trim();
  const result = await auditedIrc(
    ctx,
    'namespace.list',
    { namespace: parent || undefined },
    () => listNamespaces(parent || undefined),
    (r) => (r.namespaces || []).length,
  );
  return NextResponse.json({
    ok: true,
    parent: parent || null,
    namespaces: (result.namespaces || []).map((levels) => ({
      levels,
      name: namespaceToDotted(levels),
    })),
    nextPageToken: result['next-page-token'] ?? null,
  });
});

export const POST = withIrcCaller(async (req, ctx) => {
  const body = (await req.json().catch(() => ({}))) as {
    namespace?: string;
    properties?: Record<string, string>;
  };
  const namespace = String(body?.namespace ?? '').trim();
  if (!namespace) {
    return NextResponse.json({ ok: false, error: 'namespace is required' }, { status: 400 });
  }
  const properties: Record<string, string> = {};
  for (const [k, v] of Object.entries(body?.properties || {})) {
    if (typeof v === 'string') properties[String(k)] = v;
  }
  const created = await auditedIrc(ctx, 'namespace.create', { namespace }, () =>
    createNamespace(namespace, properties));
  return NextResponse.json({ ok: true, namespace, created });
});
