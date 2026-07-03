/**
 * POST /api/internal/copilot/tools/[name]/invoke
 *
 * Internal, token-gated tool dispatch for the MAF orchestration tier
 * (`loom-copilot-maf`). The MAF app calls Gov AOAI directly, but when the model
 * requests a tool it POSTs here so the EXACT SAME handler runs — same Azure
 * backends, same Cosmos containers, same per-user ownership — as the Foundry
 * tier's in-process dispatch. This is what makes the MAF tier "same tool
 * dispatch + OBO" rather than a re-implementation.
 *
 * Body:   { args: {...} }
 * Auth:   `x-loom-internal-token` === LOOM_INTERNAL_TOKEN (shared secret).
 * OBO:    `x-user-oid` is the signed-in user's oid (forwarded by the Console
 *         orchestrator → MAF → here). It becomes the ToolContext identity so
 *         build-assist tools create/configure items OWNED by that user.
 * Returns { ok, name, service, durationMs, result } OR { ok:false, error }.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  getRegistry,
  NoAoaiDeploymentError,
  type ToolContext,
} from '@/lib/azure/copilot-orchestrator';
import {
  isValidInternalToken,
  validateInternalOid,
  INTERNAL_TOKEN_HEADER,
  INTERNAL_USER_OID_HEADER,
} from '@/lib/auth/internal-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_RESULT_BYTES = 64 * 1024;

export async function POST(req: NextRequest, ctx: { params: { name: string } }) {
  if (!isValidInternalToken(req.headers.get(INTERNAL_TOKEN_HEADER))) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  // Even past the trust-token gate, constrain the acting identity: the oid must
  // be a well-formed Entra object-id (and, when LOOM_INTERNAL_ALLOWED_OIDS is
  // configured, a known automation principal). It is the OBO / ownership
  // identity for every tool this dispatches, so a malformed value is rejected
  // rather than trusted as a partition key (rel-T10/B3).
  const userOid = validateInternalOid(req.headers.get(INTERNAL_USER_OID_HEADER));
  if (!userOid) {
    return NextResponse.json(
      { ok: false, error: `${INTERNAL_USER_OID_HEADER} header required (a valid Entra object-id)` },
      { status: 400 },
    );
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
      { ok: false, error: `Unknown tool: ${name}`, available: reg.list().map((t) => t.name) },
      { status: 404 },
    );
  }

  // Same per-user identity the in-process orchestrator builds — preserves OBO /
  // ownership semantics across the MAF → Console hop.
  const toolCtx: ToolContext = {
    userOid,
    session: { claims: { oid: userOid, upn: userOid } },
  };

  const started = Date.now();
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
        { ok: false, error: e.message, name: tool.name, service: tool.service },
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
