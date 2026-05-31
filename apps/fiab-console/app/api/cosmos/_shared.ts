/**
 * Shared helpers for the Cosmos DB account navigator BFF routes.
 *
 * Every route:
 *   1. validates the session cookie (401 when absent),
 *   2. checks cosmosConfigGate() and emits an HONEST 503
 *      { ok:false, code:'not_configured', missing, hint } when the navigator
 *      account isn't wired (per no-vaporware.md — never a fake list),
 *   3. otherwise calls the real ARM control plane via cosmos-account-client.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { cosmosConfigGate, CosmosArmError } from '@/lib/azure/cosmos-account-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 401 response when there is no valid session. */
export function requireSession(): NextResponse | null {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  return null;
}

/** Honest 503 gate response when the navigator account env isn't configured. */
export function gateResponse(): NextResponse | null {
  const gate = cosmosConfigGate();
  if (!gate) return null;
  return NextResponse.json(
    { ok: false, code: 'not_configured', missing: gate.missing, hint: gate.hint },
    { status: 503 },
  );
}

/** Map a thrown error (ARM or otherwise) to a structured { ok:false } JSON. */
export function errorResponse(e: unknown): NextResponse {
  if (e instanceof CosmosArmError) {
    // 403 from ARM almost always means the UAMI lacks the Cosmos role.
    const hint = e.status === 403
      ? ' — the Console UAMI likely lacks the "Cosmos DB Operator" / "DocumentDB Account Contributor" role at the account scope.'
      : '';
    return NextResponse.json(
      { ok: false, error: `${e.message}${hint}`, status: e.status },
      { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
    );
  }
  const msg = (e as any)?.message || String(e);
  return NextResponse.json({ ok: false, error: msg }, { status: 502 });
}

/** Read + parse the JSON body of a request, tolerating empty bodies. */
export async function readBody<T = any>(req: Request): Promise<T> {
  try {
    const text = await req.text();
    return text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    return {} as T;
  }
}
