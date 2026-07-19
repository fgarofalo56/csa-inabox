/**
 * POST /api/items/loom-app-runtime/[id]/mcp — MCP server for a published app.
 *
 * JSON-RPC 2.0 (initialize / ping / tools/list / tools/call). PAT-aware
 * (getApiSession) so an MCP client authenticates with a scoped Loom token; the
 * `invoke_<app>` tool proxies to the deployed agent app's `POST /invoke`. Gated
 * on `state.appRuntime.mcpPublished` (Publish-as-MCP flips it). The app itself
 * is Entra-gated — an auth failure calling `/invoke` returns an honest isError
 * tool result naming the fix, never a fabricated answer (no-vaporware).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getApiSession, enforcePatAccess } from '@/lib/auth/api-session';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { readAppRuntime, LOOM_APP_RUNTIME_TYPE } from '@/lib/apps/runtime-store';
import { handleAppMcpMethod, appMcpToolName, RPC } from '@/lib/apps/app-mcp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function rpcErr(id: unknown, code: number, message: string, status = 200) {
  return NextResponse.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { status });
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = await getApiSession(req);
  if (!session) return NextResponse.json({ jsonrpc: '2.0', id: null, error: { code: RPC.INTERNAL, message: 'unauthenticated' } }, { status: 401 });
  const patBlock = enforcePatAccess(session, req.method);
  if (patBlock) return patBlock;

  const access = await resolveItemAccessByOid(session, id, LOOM_APP_RUNTIME_TYPE);
  if (!access) return rpcErr(null, RPC.INTERNAL, 'app not found', 404);
  const rt = readAppRuntime(access.item);
  if (!rt.mcpPublished || !rt.url) {
    return rpcErr(null, RPC.INTERNAL, 'This app is not published as MCP (or is not deployed). Publish it from the app editor.', 409);
  }

  const appUrl = rt.url.replace(/\/+$/, '');
  const toolName = rt.mcpToolName || appMcpToolName(access.item.displayName || id);

  // Forward the caller's bearer to the app when present (the app's own
  // Entra-gate decides); honest error on auth/other failure.
  const authHeader = req.headers.get('authorization') || '';
  const ctx = {
    toolName,
    appName: access.item.displayName || 'App',
    invoke: async (input: string): Promise<string> => {
      const r = await fetch(`${appUrl}/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(authHeader ? { authorization: authHeader } : {}) },
        body: JSON.stringify({ input }),
      });
      const text = await r.text();
      if (!r.ok) {
        if (r.status === 401 || r.status === 403) {
          throw new Error(`The app rejected the call (${r.status}) — it is Entra-gated. Configure app-to-app auth or run the app un-gated to expose it as an MCP tool.`);
        }
        throw new Error(`App /invoke failed (${r.status}): ${text.slice(0, 300)}`);
      }
      try { const j = JSON.parse(text); return String(j.output ?? j.answer ?? text); } catch { return text; }
    },
  };

  const body = await req.json().catch(() => ({}));
  // Support a JSON-RPC batch (array) or a single request.
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((b) => handleAppMcpMethod(b, ctx)))).filter(Boolean);
    return NextResponse.json(out);
  }
  const res = await handleAppMcpMethod(body, ctx);
  if (res === null) return new NextResponse(null, { status: 204 }); // notification
  return NextResponse.json(res);
}
