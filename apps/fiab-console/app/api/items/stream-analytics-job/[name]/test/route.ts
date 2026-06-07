/**
 * POST /api/items/stream-analytics-job/[name]/test
 *
 * Validate / run a SAQL query produced by the Eventstream transform-node
 * builder against an ASA job.
 *
 *   Body: {
 *     query: string,
 *     mode?: 'compile' | 'run',          // default 'compile'
 *     sampleInput?: { inputAlias: string, events: any[] }[],
 *     inputNames?: string[],             // declared FROM aliases (compile)
 *   }
 *
 *   'compile' → real ASA compileQuery: returns compiler errors/warnings. No
 *               result storage needed — always available with the Query
 *               Tester / Contributor role.
 *   'run'     → real ASA testQuery over the sample events: returns the
 *               produced output rows. Needs LOOM_ASA_TEST_WRITE_URI; honest
 *               501 gate otherwise.
 *
 * No mocks — real ARM. Returns { ok, mode, ... } per no-vaporware.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  compileQuery,
  testTransformation,
  AsaNotConfiguredError,
  AsaTestNotAvailableError,
} from '@/lib/azure/stream-analytics-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HINT =
  'Provision an ASA job (bicep: platform/fiab/bicep/modules/landing-zone/stream-analytics.bicep, ' +
  'flag enableStreamAnalytics=true) and set LOOM_ASA_RG (and LOOM_ASA_SUB if different). ' +
  'Compile/Test Query use the subscription-scoped actions Microsoft.StreamAnalytics/locations/*Query/action — ' +
  'grant the Loom Console UAMI the "Stream Analytics Query Tester" role ' +
  '(1ec5b3c1-b17e-4e25-8312-2acb3c3c5abf) at SUBSCRIPTION scope (one-time tenant action).';

interface TestBody {
  query?: string;
  mode?: 'compile' | 'run';
  sampleInput?: { inputAlias: string; events: any[] }[];
  inputNames?: string[];
}

export async function POST(req: NextRequest, ctx: { params: { name: string } }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const name = ctx.params?.name;
  if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });

  const body = (await req.json().catch(() => null)) as TestBody | null;
  if (!body || typeof body.query !== 'string' || !body.query.trim()) {
    return NextResponse.json({ ok: false, error: 'body must be { query: string }' }, { status: 400 });
  }
  const mode = body.mode === 'run' ? 'run' : 'compile';

  try {
    if (mode === 'run') {
      const sampleInputs = Array.isArray(body.sampleInput) ? body.sampleInput : [];
      const res = await testTransformation(name, body.query, sampleInputs);
      return NextResponse.json({
        ok: true,
        mode: 'run',
        status: res.status,
        outputUri: res.outputUri,
        rows: res.outputRows,
        errors: res.errors,
      });
    }
    const res = await compileQuery(body.query, { inputNames: body.inputNames || [] });
    return NextResponse.json({
      ok: true,
      mode: 'compile',
      valid: res.ok,
      errors: res.errors,
      warnings: res.warnings,
      inputs: res.inputs,
      outputs: res.outputs,
      functions: res.functions,
    });
  } catch (e: any) {
    if (e instanceof AsaNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: HINT }, { status: 501 });
    }
    if (e instanceof AsaTestNotAvailableError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint }, { status: 501 });
    }
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), hint: HINT },
      { status: 502 },
    );
  }
}
