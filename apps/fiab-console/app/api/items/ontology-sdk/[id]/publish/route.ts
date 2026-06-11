/**
 * Ontology SDK (PMF-44/63 — OSDK parity) — publish the ontology API to APIM.
 *
 * POST /api/items/ontology-sdk/[id]/publish  body: { serviceUrl?, path? }
 *   → { ok, api: { id, name, path, displayName }, gate? }
 *
 * Generates an OpenAPI document from the bound ontology's entity types (one
 * GET collection + GET-by-key operation per type) and imports it into Azure
 * API Management via the real ARM import path (importApiFromOpenApi) — the same
 * APIM-first surface the data-product marketplace uses. `serviceUrl` points at
 * the Data API builder runtime (Container Apps) that actually serves the
 * ontology data. 100% Azure-native (APIM + DAB), no Fabric/Power BI.
 *
 * Honest gate (503) when APIM isn't configured (apimConfigGate). On success a
 * Thread edge ontology-sdk → apim-api is recorded.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import { ontologyEntityTypes } from '../../../_lib/ontology-binding';
import { importApiFromOpenApi, apimConfigGate, ApimError } from '@/lib/azure/apim-client';
import { recordThreadEdge } from '@/lib/thread/thread-edges';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'ontology-sdk';

function err(error: string, status: number, code?: string, gate?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}), ...(gate ? { gate } : {}) }, { status });
}

function slug(s: string): string {
  return (s || 'ontology').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'ontology';
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the Ontology SDK item first', 400, 'no_id');
  const body = await req.json().catch(() => ({} as { serviceUrl?: string; path?: string }));

  const item = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!item) return err('Ontology SDK item not found', 404, 'not_found');
  const state = (item.state || {}) as Record<string, unknown>;
  const boundOntologyId = String(state.boundOntologyId || '');
  if (!boundOntologyId) return err('Bind an ontology to this SDK first.', 409, 'no_ontology');
  const onto = await loadOwnedItem(boundOntologyId, 'ontology', s.claims.oid);
  if (!onto) return err('bound ontology not found', 404, 'ontology_not_found');
  const entityTypes = ontologyEntityTypes(onto);
  if (entityTypes.length === 0) return err('The bound ontology has no entity types.', 409, 'empty_ontology');

  const gate = apimConfigGate();
  if (gate) {
    return err(
      `Azure API Management not configured: set ${gate.missing}.`,
      503, 'apim_not_configured',
      { reason: 'The ontology API is published through Azure API Management (APIM-first).', remediation: `Set ${gate.missing} on the Console. No Microsoft Fabric required.` },
    );
  }

  const apiPath = slug(String((body as { path?: string })?.path || item.displayName || 'ontology')) + '-osdk';
  const serviceUrl = String((body as { serviceUrl?: string })?.serviceUrl || state.serviceUrl || '').trim() || undefined;
  const displayName = `${item.displayName || 'Ontology'} (OSDK)`;

  // Build a minimal OpenAPI 3.0 document — collection + by-key per entity type.
  const paths: Record<string, unknown> = {};
  for (const t of entityTypes) {
    paths[`/${t}`] = {
      get: { summary: `List ${t}`, operationId: `list_${t}`, responses: { '200': { description: 'OK' } } },
    };
    paths[`/${t}/{key}`] = {
      get: {
        summary: `Get ${t} by key`, operationId: `get_${t}`,
        parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
      },
    };
  }
  const openApi = {
    openapi: '3.0.1',
    info: { title: displayName, version: '1.0', description: `Auto-generated ontology object API (OSDK parity) over ${entityTypes.length} entity type(s).` },
    paths,
  };

  try {
    const api = await importApiFromOpenApi({
      apiId: apiPath,
      displayName,
      path: apiPath,
      format: 'openapi+json',
      value: JSON.stringify(openApi),
    });
    // importApiFromOpenApi materialises the operations; the serviceUrl (the DAB
    // runtime origin) is persisted on the item and editable from the APIM editor.
    await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, {
      state: { ...state, publishedApiId: api.name, publishedApiPath: api.path, ...(serviceUrl ? { serviceUrl } : {}) },
    });
    await recordThreadEdge(s, {
      fromItemId: id, fromType: ITEM_TYPE, fromName: item.displayName,
      toItemId: api.name || apiPath, toType: 'apim-api', toName: displayName,
      action: 'osdk-publish-apim',
    });
    return NextResponse.json({ ok: true, api: { id: api.id, name: api.name, path: api.path, displayName: api.displayName } });
  } catch (e: unknown) {
    const status = e instanceof ApimError ? (e.status || 502) : 502;
    return err(`APIM publish failed: ${e instanceof Error ? e.message : String(e)}`, status, 'publish_failed');
  }
}
