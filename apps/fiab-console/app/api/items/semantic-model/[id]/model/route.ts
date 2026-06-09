/**
 * GET / PATCH /api/items/semantic-model/[id]/model
 *
 * The Azure-native column-metadata surface for the Semantic model editor's
 * Tables tab. Reads + writes the Tabular model via the XMLA protocol (TMSL
 * Execute + TMSCHEMA Discover) against the configured backend:
 *   - Azure Analysis Services  (LOOM_AAS_SERVER_URL)  — the Azure-native DEFAULT
 *   - Power BI Premium XMLA    (LOOM_POWERBI_XMLA_ENDPOINT) — opt-in alternative
 *
 * This path requires NO Microsoft Fabric / Power BI *workspace* (AAS is a
 * standalone Azure resource) — per .claude/rules/no-fabric-dependency.md. When
 * neither backend is configured the route returns `{ ok: false, gate }` with a
 * precise reason (env var to set / cloud-availability note) so the editor can
 * render an honest Fluent MessageBar instead of fabricated data
 * (.claude/rules/no-vaporware.md).
 *
 * GET → { ok: true, backend, tables: ModelTable[] }
 *     | { ok: false, gate: { missing, detail } }  (HTTP 200 — honest gate)
 *     | { ok: false, error }                       (HTTP 4xx/5xx)
 *
 * PATCH body (discriminated by `op`):
 *   { op: 'alter-column',          tableName, columnName, column: TmslColumnDef }
 *   { op: 'add-calculated-column', tableName, column: TmslCalcColumnDef }
 *   { op: 'add-calculated-table',  tableName, expression }
 * PATCH → { ok: true, tmsl }  (tmsl = the exact TMSL sent — the merge receipt)
 *     | { ok: false, gate } | { ok: false, error, status }
 *
 * The Alter command requires the COMPLETE column object (all read-write
 * properties), per the TMSL Alter contract — the UI merges current values with
 * the user's edits and sends the full object; this route forwards it verbatim.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  aasConfigGate,
  aasXmlaConfig,
  readModel,
  command,
  buildAlterColumnTmsl,
  buildCreateCalcColumnTmsl,
  buildCreateCalcTableTmsl,
  AasError,
  type TmslColumnDef,
  type TmslCalcColumnDef,
} from '@/lib/azure/aas-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const gate = aasConfigGate();
  if (gate) return NextResponse.json({ ok: false, gate }, { status: 200 });

  const cfg = aasXmlaConfig()!;
  try {
    const tables = await readModel(cfg.database);
    return NextResponse.json({ ok: true, backend: cfg.backend, database: cfg.database, tables });
  } catch (e: any) {
    const status = e instanceof AasError ? (e.status === 401 ? 401 : 502) : 500;
    const hint =
      e instanceof AasError && e.status === 401
        ? ' (check the Console UAMI is an Analysis Services server administrator on the AAS server)'
        : '';
    return NextResponse.json({ ok: false, error: `${e?.message || String(e)}${hint}`, status }, { status });
  }
}

interface AlterColumnBody {
  op: 'alter-column';
  tableName?: string;
  columnName?: string;
  column?: TmslColumnDef;
}
interface AddCalcColumnBody {
  op: 'add-calculated-column';
  tableName?: string;
  column?: TmslCalcColumnDef;
}
interface AddCalcTableBody {
  op: 'add-calculated-table';
  tableName?: string;
  expression?: string;
}
type ModelPatch = AlterColumnBody | AddCalcColumnBody | AddCalcTableBody;

export async function PATCH(req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const gate = aasConfigGate();
  if (gate) return NextResponse.json({ ok: false, gate }, { status: 200 });

  const cfg = aasXmlaConfig()!;
  const body = (await req.json().catch(() => ({}))) as ModelPatch;

  try {
    if (body.op === 'alter-column') {
      if (!body.tableName || !body.column?.name || !body.column?.dataType) {
        return NextResponse.json(
          { ok: false, error: 'alter-column requires tableName and a complete column object (name + dataType)' },
          { status: 400 },
        );
      }
      const { tmsl } = await command(buildAlterColumnTmsl(cfg.database, body.tableName, body.column), cfg.database);
      return NextResponse.json({ ok: true, tmsl });
    }

    if (body.op === 'add-calculated-column') {
      if (!body.tableName || !body.column?.name || !body.column?.expression || !body.column?.dataType) {
        return NextResponse.json(
          { ok: false, error: 'add-calculated-column requires tableName and column { name, dataType, expression }' },
          { status: 400 },
        );
      }
      const { tmsl } = await command(buildCreateCalcColumnTmsl(cfg.database, body.tableName, body.column), cfg.database);
      return NextResponse.json({ ok: true, tmsl });
    }

    if (body.op === 'add-calculated-table') {
      if (!body.tableName || !body.expression) {
        return NextResponse.json(
          { ok: false, error: 'add-calculated-table requires tableName and a DAX expression' },
          { status: 400 },
        );
      }
      const { tmsl } = await command(buildCreateCalcTableTmsl(cfg.database, body.tableName, body.expression), cfg.database);
      return NextResponse.json({ ok: true, tmsl });
    }

    return NextResponse.json({ ok: false, error: `unknown op "${(body as any).op}"` }, { status: 400 });
  } catch (e: any) {
    const status = e instanceof AasError ? (e.status === 401 ? 401 : 502) : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }
}
