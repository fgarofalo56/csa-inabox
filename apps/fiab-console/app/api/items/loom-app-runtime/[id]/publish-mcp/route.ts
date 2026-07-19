/**
 * POST   /api/items/loom-app-runtime/[id]/publish-mcp  → publish an agent app as MCP
 * DELETE /api/items/loom-app-runtime/[id]/publish-mcp  → unpublish
 *
 * APP-W5 S5. Flips `state.appRuntime.mcpPublished` and returns the MCP endpoint
 * (`.../[id]/mcp`) + the `invoke_<app>` tool name + a ready-to-paste client
 * config. Scoped to `agent-fastapi` apps (the known `POST /invoke` contract);
 * other templates honest-gate with the generic-shim follow-on named. Requires a
 * deployed app (a live URL to proxy to).
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { readAppRuntime, saveAppRuntime, LOOM_APP_RUNTIME_TYPE } from '@/lib/apps/runtime-store';
import { appMcpToolName } from '@/lib/apps/app-mcp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function endpointFor(req: NextRequest, id: string): string {
  let origin = '';
  try { origin = new URL(req.url).origin; } catch { origin = process.env.LOOM_PUBLIC_BASE_URL || ''; }
  return `${origin.replace(/\/+$/, '')}/api/items/loom-app-runtime/${encodeURIComponent(id)}/mcp`;
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const access = await resolveItemAccessByOid(session, id, LOOM_APP_RUNTIME_TYPE);
    if (!access) return apiError('Item not found', 404, { code: 'not_found' });
    if (!access.canWrite) return apiError('Read-only access', 403, { code: 'forbidden' });
    const rt = readAppRuntime(access.item);
    if (rt.templateId !== 'agent-fastapi') {
      return apiError(
        'Publish-as-MCP currently supports the Agent (FastAPI) template — its POST /invoke contract maps to an MCP tool. A generic OpenAPI→MCP shim for other app types is a tracked follow-on; publish those as an API instead.',
        400, { code: 'unsupported_template' },
      );
    }
    let liveUrl = (rt.url || '').trim();
    if (!liveUrl && rt.containerAppName) {
      try { const { getApp } = await import('@/lib/azure/loom-apps-client'); liveUrl = (await getApp(rt.containerAppName)).url || ''; }
      catch { /* honest gate below */ }
    }
    if (!liveUrl) return apiError('Deploy the app first — MCP proxies to its live endpoint.', 409, { code: 'not_deployed' });

    const toolName = appMcpToolName(access.item.displayName || id);
    await saveAppRuntime(access.item, { mcpPublished: true, mcpToolName: toolName, mcpPublishedAt: new Date().toISOString() });
    const endpoint = endpointFor(req, id);
    return apiOk({
      published: true,
      toolName,
      endpoint,
      mcpClientConfig: { mcpServers: { [toolName]: { type: 'http', url: endpoint, headers: { Authorization: 'Bearer loom_pat_<your-token>' } } } },
      note: 'Published as an MCP tool. Point an MCP client at the endpoint with a scoped Loom API token.',
    });
  } catch (e) {
    return apiServerError(e, 'failed to publish the app as MCP');
  }
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const access = await resolveItemAccessByOid(session, id, LOOM_APP_RUNTIME_TYPE);
    if (!access) return apiError('Item not found', 404, { code: 'not_found' });
    if (!access.canWrite) return apiError('Read-only access', 403, { code: 'forbidden' });
    await saveAppRuntime(access.item, { mcpPublished: false });
    return apiOk({ published: false });
  } catch (e) {
    return apiServerError(e, 'failed to unpublish');
  }
}
