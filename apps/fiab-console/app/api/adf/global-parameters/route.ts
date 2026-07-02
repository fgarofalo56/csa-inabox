/**
 * Global parameters on the deployment-default Data Factory (the Factory
 * Resources navigator's "Global parameters" group). Backs the global-parameter
 * editor: list / add / edit / remove factory-level global parameters.
 *
 * ADF stores every global parameter in ONE child resource named `default`,
 * whose `properties` is the { name -> { type, value } } dict. The editor manages
 * the whole set client-side and PUTs it back in one call (ADF Studio's publish
 * behaviour). Pure ADF ARM (Microsoft.DataFactory/factories/globalParameters,
 * api-version 2018-06-01) — NOT a Fabric dependency (works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset, Commercial or Gov).
 *
 *   GET /api/adf/global-parameters              → { ok, parameters: { name: {type, value} } }
 *   PUT /api/adf/global-parameters  body { parameters } → replace whole set → { ok, parameters }
 *
 * Factory is the env-pinned default; honest 503 gate when LOOM_SUBSCRIPTION_ID /
 * LOOM_DLZ_RG / LOOM_ADF_NAME aren't set. The Loom UAMI needs Data Factory
 * Contributor on that factory. Real ARM REST. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  adfConfigGate, getGlobalParameters, updateGlobalParameters,
  type AdfGlobalParameterSpec, type AdfGlobalParameterType,
} from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ADF global parameter names cannot contain '-' (breaks @pipeline().globalParameters
// expressions per Learn). Restrict to identifier-safe chars, 1-260.
const PARAM_NAME_RE = /^[A-Za-z0-9_]{1,260}$/;
const VALID_TYPES: AdfGlobalParameterType[] = ['Bool', 'String', 'Int', 'Float', 'Object', 'Array'];

function gate() {
  const g = adfConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Data Factory not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

/**
 * Validate + normalize the incoming { name -> {type, value} } dict. Rejects bad
 * names / types and coerces each value to its declared type so ARM accepts it
 * (Int/Float → number, Bool → boolean, Object/Array → the parsed JSON value).
 */
function validateParams(input: unknown): { params?: Record<string, AdfGlobalParameterSpec>; error?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'parameters must be an object of { name: { type, value } }' };
  }
  const out: Record<string, AdfGlobalParameterSpec> = {};
  for (const [name, rawSpec] of Object.entries(input as Record<string, unknown>)) {
    if (!PARAM_NAME_RE.test(name)) {
      return { error: `invalid parameter name "${name}" — use 1-260 letters, digits or _ (no '-')` };
    }
    const spec = rawSpec as { type?: unknown; value?: unknown };
    const type = String(spec?.type || '');
    if (!VALID_TYPES.includes(type as AdfGlobalParameterType)) {
      return { error: `parameter "${name}" has invalid type "${type}" (Bool|String|Int|Float|Object|Array)` };
    }
    let value = spec?.value;
    // Coerce to the declared type so ARM stores it correctly.
    if (type === 'Int' || type === 'Float') {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return { error: `parameter "${name}" value is not a valid number` };
      value = type === 'Int' ? Math.trunc(n) : n;
    } else if (type === 'Bool') {
      value = value === true || value === 'true';
    } else if (type === 'Object' || type === 'Array') {
      // Object/Array values arrive as already-parsed JSON (the editor parses the
      // JSON textarea before POSTing). Guard the shape.
      if (type === 'Array' && !Array.isArray(value)) return { error: `parameter "${name}" (Array) value must be a JSON array` };
      if (type === 'Object' && (typeof value !== 'object' || value === null || Array.isArray(value))) {
        return { error: `parameter "${name}" (Object) value must be a JSON object` };
      }
    } else {
      // String
      value = value == null ? '' : String(value);
    }
    out[name] = { type, value };
  }
  return { params: out };
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  try {
    const parameters = await getGlobalParameters();
    return NextResponse.json({ ok: true, parameters });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function PUT(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const { params, error } = validateParams(body?.parameters);
  if (error) return NextResponse.json({ ok: false, error }, { status: 400 });
  try {
    const parameters = await updateGlobalParameters(params!);
    return NextResponse.json({ ok: true, parameters });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
