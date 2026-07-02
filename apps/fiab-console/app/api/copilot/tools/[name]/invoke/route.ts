/**
 * POST /api/copilot/tools/[name]/invoke
 *
 * Body: { args: {...} }
 * Returns: { ok, name, durationMs, result } OR { ok:false, error }
 *
 * Direct tool invoke — lets the /copilot-loom Quick Actions tab call
 * any registered tool with a form-driven args payload, no LLM in the
 * loop. Use case: the user wants the exact effect of a tool (e.g.
 * `synapse_serverless_query`) and shouldn't have to coerce the LLM
 * into selecting it.
 *
 * Same handler the orchestrator uses; the result is whatever the tool
 * itself returns (truncated to 64KB for safety).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getRegistry, NoAoaiDeploymentError, type ToolContext } from '@/lib/azure/copilot-orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_RESULT_BYTES = 64 * 1024;

export async function POST(
  req: NextRequest,
  ctx: { params: { name: string } },
) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  const name = decodeURIComponent(ctx.params.name || '');
  if (!name) {
    return NextResponse.json({ ok: false, error: 'tool name required' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const args = (body && typeof body === 'object' && body.args) || {};

  const reg = getRegistry();
  const tool = reg.get(name);
  if (!tool) {
    return NextResponse.json(
      {
        ok: false,
        error: `Unknown tool: ${name}`,
        available: reg.list().map((t) => t.name),
      },
      { status: 404 },
    );
  }

  const started = Date.now();
  const toolCtx: ToolContext = {
    userOid: session.claims.oid,
    session: { claims: { oid: session.claims.oid, upn: session.claims.upn, email: session.claims.email } },
  };
  try {
    const result = await tool.handler(args, toolCtx);
    const serialized = JSON.stringify(result);
    const truncated = serialized.length > MAX_RESULT_BYTES;
    return NextResponse.json({
      ok: true,
      name: tool.name,
      service: tool.service,
      durationMs: Date.now() - started,
      result: truncated ? JSON.parse(serialized.slice(0, MAX_RESULT_BYTES - 16) + '"}') : result,
      truncated,
    });
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json(
        {
          ok: false,
          error: e.message,
          remediation:
            'This tool indirectly requires AOAI. Deploy a gpt-4o / gpt-4 model to your ' +
            'Foundry hub or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT env vars.',
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: e?.message || String(e),
        name: tool.name,
        service: tool.service,
        durationMs: Date.now() - started,
      },
      { status: 502 },
    );
  }
}
