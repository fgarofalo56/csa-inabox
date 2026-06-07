/**
 * POST /api/lakehouse/load-to-table — the backend for the Lakehouse
 * "Load to Table" (F6) wizard.
 *
 * Submits a PySpark job to a Synapse Spark pool (via the Livy API on
 * dev.azuresynapse.net) that reads a CSV / Parquet / JSON file from ADLS Gen2
 * and writes it as a managed Delta table under the container's `Tables/`
 * folder. The table then appears in the Lakehouse editor's Tables tab and is
 * queryable from a notebook / Spark SQL.
 *
 * Azure-native, NO Fabric dependency: the Livy endpoint is the Synapse
 * workspace dev host, pool discovery is ARM. Works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 *
 * Body (collected by the wizard's dropdowns + inputs — no raw JSON):
 *   { container, path, tableName, writeMode, poolName, format? }
 *
 * Response:
 *   { ok: true, job: { id, state, poolName, tableName, rowCount: number|null, output? } }
 *   { ok: false, error }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { KNOWN_CONTAINERS, getAccountName } from '@/lib/azure/adls-client';
import {
  listSparkPools,
  submitLivyBatch,
  getLivyStatement,
} from '@/lib/azure/synapse-dev-client';
import { detectSparkFormat } from '@/lib/azure/spark-format-detect';
import {
  SUPPORTED_LOAD_FORMATS,
  type LoadFormat,
  buildLoadToTablePySpark,
  validateLoadTableName,
  parseLoadRowCount,
} from '@/lib/azure/load-to-table-codegen';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  container?: string;
  path?: string;
  tableName?: string;
  writeMode?: 'overwrite' | 'append';
  poolName?: string;
  format?: string;
}

function resolveFormat(requested: string | undefined, path: string): LoadFormat | null {
  const candidate = (requested && requested !== 'auto'
    ? requested
    : detectSparkFormat(path).format
  ).toLowerCase();
  return (SUPPORTED_LOAD_FORMATS as readonly string[]).includes(candidate)
    ? (candidate as LoadFormat)
    : null;
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Body;
  const { container, path, tableName, poolName } = body;
  const writeMode = body.writeMode === 'append' ? 'append' : 'overwrite';

  // ---- validation (no freeform: container + pool come from dropdowns) -----
  const missing: string[] = [];
  if (!container) missing.push('container');
  if (!path) missing.push('path');
  if (!tableName) missing.push('tableName');
  if (!poolName) missing.push('poolName');
  if (missing.length) {
    return NextResponse.json({ ok: false, error: `Missing: ${missing.join(', ')}` }, { status: 400 });
  }

  if (!(KNOWN_CONTAINERS as readonly string[]).includes(container!)) {
    return NextResponse.json(
      { ok: false, error: `Unknown container '${container}'. Expected one of: ${KNOWN_CONTAINERS.join(', ')}.` },
      { status: 400 },
    );
  }

  const nameErr = validateLoadTableName(tableName!);
  if (nameErr) return NextResponse.json({ ok: false, error: nameErr }, { status: 400 });

  const format = resolveFormat(body.format, path!);
  if (!format) {
    const detected = detectSparkFormat(path!);
    const connector = detected.connector ? ` (needs connector ${detected.connector})` : '';
    return NextResponse.json(
      {
        ok: false,
        error: `Cannot load '${detected.label}'${connector} via the no-code wizard. Supported: CSV, Parquet, JSON, ORC, Avro, text. Use a notebook for other formats.`,
      },
      { status: 400 },
    );
  }

  // Resolve the ADLS account — honest infra gate if no container URL is set.
  let account: string;
  try {
    account = getAccountName();
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'ADLS account is not configured. Set one of LOOM_BRONZE_URL / LOOM_SILVER_URL / LOOM_GOLD_URL / LOOM_LANDING_URL (deployed by platform/fiab/bicep/modules/landing-zone/storage*.bicep).',
      },
      { status: 503 },
    );
  }

  // Synapse workspace required for Livy — honest infra gate.
  if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'No Synapse workspace configured. Set LOOM_SYNAPSE_WORKSPACE and deploy a Spark pool (platform/fiab/bicep/modules/landing-zone/synapse.bicep, deploySparkPool=true).',
      },
      { status: 503 },
    );
  }

  // Validate the chosen Spark pool exists (prevents freeform compute).
  let pools: Awaited<ReturnType<typeof listSparkPools>>;
  try {
    pools = await listSparkPools();
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `Could not list Spark pools: ${e?.message || String(e)}` },
      { status: 502 },
    );
  }
  if (!pools.some((p) => p.name === poolName)) {
    const names = pools.map((p) => p.name).join(', ') || '(none)';
    return NextResponse.json(
      {
        ok: false,
        error: pools.length
          ? `Spark pool '${poolName}' not found. Available: ${names}.`
          : 'No Synapse Spark pools deployed. Deploy the loompool pool (synapse.bicep, deploySparkPool=true) before loading tables.',
      },
      { status: 400 },
    );
  }

  // ---- build + submit the PySpark job ------------------------------------
  let code: string;
  try {
    code = buildLoadToTablePySpark({ container: container!, account, path: path!, tableName: tableName!, writeMode, format });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 400 });
  }

  let batch: Awaited<ReturnType<typeof submitLivyBatch>>;
  try {
    batch = await submitLivyBatch({
      poolName: poolName!,
      code,
      kind: 'pyspark',
      jobName: `loom-load-${tableName}-${Date.now()}`,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `Spark job submission failed: ${e?.message || String(e)}` },
      { status: 502 },
    );
  }

  // batch.id is "<sessionId>.<statementId>" — poll the statement to completion
  // so the receipt can carry the real row count (best-effort, time-bounded).
  let rowCount: number | null = null;
  let finalState = batch.state;
  let outputText: string | undefined;
  let runError: string | undefined;
  const [sessIdStr, stmtIdStr] = batch.id.split('.');
  const sessionId = Number(sessIdStr);
  const stmtId = Number(stmtIdStr);
  if (Number.isFinite(sessionId) && Number.isFinite(stmtId)) {
    for (let i = 0; i < 40; i++) {
      try {
        const stmt = await getLivyStatement(poolName!, sessionId, stmtId);
        finalState = stmt.state;
        if (stmt.state === 'available') {
          const out = (stmt as any).output || {};
          if (out.status === 'error') {
            runError = `${out.ename || 'SparkError'}: ${out.evalue || 'statement failed'}`;
          } else {
            outputText = out.data?.['text/plain'];
            rowCount = parseLoadRowCount(outputText);
          }
          break;
        }
        if (stmt.state === 'error' || stmt.state === 'cancelled') {
          runError = `statement entered state '${stmt.state}'`;
          break;
        }
      } catch {
        // Transient poll error — keep going; the job is already submitted.
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  if (runError) {
    return NextResponse.json(
      { ok: false, error: `Load job ${batch.id} failed: ${runError}`, job: { id: batch.id, state: finalState, poolName, tableName } },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    job: {
      id: batch.id,
      state: finalState,
      poolName,
      tableName,
      writeMode,
      format,
      rowCount,
      output: outputText,
    },
  });
}
