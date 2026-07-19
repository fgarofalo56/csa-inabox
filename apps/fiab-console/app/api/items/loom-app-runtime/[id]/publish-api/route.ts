/**
 * Publish a deployed Loom App's HTTP endpoint as an Azure API Management API
 * (APP-W5 S3 — "publish app as API"). Near-copies the proven
 * ontology-sdk/[id]/publish flow: generate a minimal OpenAPI doc whose
 * serviceUrl is the app's live ACA URL, import it into APIM
 * (importApiFromOpenApi), record a Thread edge, gate on apimConfigGate. The
 * published API then shows up in the /marketplace APIs tab automatically.
 *
 * POST { path?, operations? }  → { ok, api }
 *   - agent-fastapi apps expose the known `POST /invoke` contract by default.
 *   - other apps get a passthrough `GET /` (edit operations in the APIM editor).
 * Azure-native (APIM + Container Apps) — no Fabric/Power BI.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { readAppRuntime, saveAppRuntime, LOOM_APP_RUNTIME_TYPE } from '@/lib/apps/runtime-store';
import { importApiFromOpenApi, apimConfigGate, ApimError } from '@/lib/azure/apim-client';
import { recordThreadEdge } from '@/lib/thread/thread-edges';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function slug(s: string): string {
  return (s || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 55) || 'app';
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized();
  if (!id || id === 'new') return apiError('Deploy the app first.', 400, { code: 'no_id' });
  try {
    const access = await resolveItemAccessByOid(session, id, LOOM_APP_RUNTIME_TYPE);
    if (!access) return apiError('Item not found', 404, { code: 'not_found' });
    if (!access.canWrite) return apiError('Read-only access', 403, { code: 'forbidden' });
    const rt = readAppRuntime(access.item);
    // Prefer the persisted URL; fall back to the LIVE container app's URL when
    // state is stale (deployed but rt.url not persisted — live receipt
    // 2026-07-19: the Overview showed the URL from the ACA fetch while rt.url
    // was empty, so publish wrongly reported "not deployed").
    let serviceUrl = (rt.url || '').trim();
    if (!serviceUrl && rt.containerAppName) {
      try { const { getApp } = await import('@/lib/azure/loom-apps-client'); serviceUrl = (await getApp(rt.containerAppName)).url || ''; }
      catch { /* fall through to the honest gate below */ }
    }
    if (!serviceUrl) return apiError('The app is not deployed yet — Deploy it, then publish its API.', 409, { code: 'not_deployed' });

    const gate = apimConfigGate();
    if (gate) {
      return apiError(`Azure API Management not configured: set ${gate.missing}.`, 503, {
        code: 'apim_not_configured',
        gate: { reason: 'The app API is published through Azure API Management (APIM-first).', remediation: `Set ${gate.missing} on the Console. No Microsoft Fabric required.` },
      });
    }

    const body = (await req.json().catch(() => ({}))) as { path?: string };
    const apiPath = slug(body.path || access.item.displayName || 'app') + '-app';
    const displayName = `${access.item.displayName || 'App'} (API)`;

    // Contract: agent-fastapi ships POST /invoke; anything else = root passthrough.
    const isAgent = rt.templateId === 'agent-fastapi';
    const paths: Record<string, unknown> = isAgent
      ? {
          '/invoke': {
            post: {
              summary: 'Invoke the agent',
              operationId: 'invoke',
              requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } } } },
              responses: { '200': { description: 'OK' } },
            },
          },
          '/health': { get: { summary: 'Health', operationId: 'health', responses: { '200': { description: 'OK' } } } },
        }
      : {
          '/': { get: { summary: 'App root', operationId: 'root', responses: { '200': { description: 'OK' } } } },
        };

    const openApi = {
      openapi: '3.0.1',
      info: { title: displayName, version: '1.0', description: `Loom App "${access.item.displayName}" published as an API (${rt.templateId || 'runtime'}).` },
      servers: [{ url: serviceUrl }],
      paths,
    };

    try {
      const api = await importApiFromOpenApi({
        apiId: apiPath, displayName, path: apiPath, format: 'openapi+json', value: JSON.stringify(openApi),
        serviceUrl,
      });
      await saveAppRuntime(access.item, { publishedApiId: api.name, publishedApiPath: api.path });
      await recordThreadEdge(session, {
        fromItemId: id, fromType: LOOM_APP_RUNTIME_TYPE, fromName: access.item.displayName,
        toItemId: api.name || apiPath, toType: 'apim-api', toName: displayName, action: 'app-publish-apim',
      });
      return apiOk({ api: { id: api.id, name: api.name, path: api.path, displayName: api.displayName }, serviceUrl, note: 'Published to Azure API Management — find it in the Marketplace → APIs tab.' });
    } catch (e: unknown) {
      const status = e instanceof ApimError ? (e.status || 502) : 502;
      return apiError(`APIM publish failed: ${e instanceof Error ? e.message : String(e)}`, status, { code: 'publish_failed' });
    }
  } catch (e) {
    return apiServerError(e, 'failed to publish the app API');
  }
}
