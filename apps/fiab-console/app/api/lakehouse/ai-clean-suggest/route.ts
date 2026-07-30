/**
 * AI cleaning-suggestion generator for the Data Wrangler AI tab (G4).
 *
 * Profiles the previewed columns — reusing the SAME column-statistics shape the
 * Spark `summary()` job (/api/lakehouse/table-stats) produces (nulls, min/max,
 * mean/stddev, type inference) plus a few sample rows — and asks Azure OpenAI to
 * propose concrete data-cleaning steps as structured suggestion cards:
 *
 *     trim | cast | dedupe | fill-null | outlier-flag
 *
 * Each card carries a REAL runnable PySpark transform over the bound DataFrame
 * (`df`), so the AI tab can (a) show the code as an approval diff and (b) run it
 * against a sampled DataFrame through the existing Livy plumbing
 * (/api/lakehouse/transform-preview) BEFORE the user applies it — preview-before-
 * apply per no-vaporware.md.
 *
 *   POST /api/lakehouse/ai-clean-suggest
 *     body {
 *       columns:   string[],
 *       stats?:    Record<string, ColStat>,   // table-stats output (nulls/min/max/…)
 *       sampleRows?: unknown[][],             // first N rows for format inference
 *       dataframeVar?: string,                // default 'df'
 *       numericCols?: string[],               // client-detected numeric columns
 *     }
 *     → 200 { ok, engine:'aoai', suggestions:[…], model, usage }
 *     → 503 { ok:false, code:'no_aoai', hint }   (no chat deployment)
 *     → 4xx/502 on validation / upstream errors
 *
 * Real Azure OpenAI only (resolveAoaiTarget → tenant admin pick → env → Foundry
 * discovery). No Microsoft Fabric / Power BI dependency (per
 * no-fabric-dependency.md); no mock suggestions (per no-vaporware.md).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { resolveAoaiTarget, NoAoaiDeploymentError } from '@/lib/azure/copilot-orchestrator';
import { aoaiChatJson } from '@/lib/azure/aoai-chat-client';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AOAI_GATE_HINT =
  'AOAI not configured: set LOOM_AOAI_ENDPOINT and LOOM_AOAI_DEPLOYMENT, or pick a chat deployment under ' +
  'Admin → Tenant settings → Copilot & Agents (deploy the AI Foundry project — ' +
  'platform/fiab/bicep/modules/ai/foundry-project.bicep, agentFoundryEnabled=true). No Microsoft Fabric required.';

/** The fixed set of cleaning-step kinds the model may return (server-validated). */
const KINDS = ['trim', 'cast', 'dedupe', 'fill-null', 'outlier-flag'] as const;
type CleanKind = (typeof KINDS)[number];

interface ColStatLite {
  count?: number;
  mean?: number | null;
  stddev?: number | null;
  min?: string | null;
  max?: string | null;
  nullCount?: number;
  histogram?: number[] | null;
}

interface Suggestion {
  id: string;
  kind: CleanKind;
  column: string;
  title: string;
  rationale: string;
  severity: 'info' | 'warning';
  code: string;
}

/** Coerce a cell to the compact string the profile shows the model. */
function cellStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}

/** Build a compact, model-readable column profile from stats + sample rows. */
function buildProfile(
  columns: string[],
  stats: Record<string, ColStatLite>,
  sampleRows: unknown[][],
  numericCols: Set<string>,
): string {
  const lines = columns.map((col, i) => {
    const st = stats[col] || {};
    const parts: string[] = [`- "${col}"`];
    parts.push(numericCols.has(col) ? '(numeric)' : '(string/other)');
    if (typeof st.count === 'number') parts.push(`count=${st.count}`);
    if (typeof st.nullCount === 'number') parts.push(`nulls=${st.nullCount}`);
    if (st.min != null) parts.push(`min=${cellStr(st.min).slice(0, 40)}`);
    if (st.max != null) parts.push(`max=${cellStr(st.max).slice(0, 40)}`);
    if (st.mean != null) parts.push(`mean=${st.mean}`);
    if (st.stddev != null) parts.push(`stddev=${st.stddev}`);
    const samples = sampleRows.slice(0, 5).map((r) => cellStr(r[i])).filter((x) => x !== '');
    if (samples.length) parts.push(`samples=[${samples.map((sV) => JSON.stringify(sV.slice(0, 30))).join(', ')}]`);
    return parts.join(' ');
  });
  return lines.join('\n');
}

const SYSTEM_PROMPT =
  'You are the CSA Loom Data Wrangler AI, an assistant that inspects a tabular DataFrame profile and ' +
  'proposes concrete, safe data-cleaning steps — one per issue you can justify from the profile. ' +
  'You return ONLY JSON matching this shape:\n' +
  '{ "suggestions": [ { "kind": "trim|cast|dedupe|fill-null|outlier-flag", "column": "<exact column name>", ' +
  '"title": "<short imperative>", "rationale": "<1 sentence grounded in the profile stats>", ' +
  '"severity": "info|warning", "code": "<PySpark>" } ] }\n\n' +
  'Rules:\n' +
  '- code MUST be runnable PySpark that reads the DataFrame variable named DATAFRAME_VAR and REASSIGNS it, ' +
  'e.g. `df = df.withColumn("x", F.trim(F.col("x")))`. `F` is pyspark.sql.functions (already imported). ' +
  'Do not import anything, do not create a SparkSession, do not read/write files.\n' +
  '- trim: strip whitespace on string columns that show leading/trailing spaces in samples.\n' +
  '- cast: cast a column whose samples look numeric/boolean/date but is typed as string.\n' +
  '- dedupe: `df = df.dropDuplicates(["colA", ...])` only when duplicates are plausible (e.g. an id/key column).\n' +
  '- fill-null: only when nulls>0; fill with a sensible default (0 for numeric, "unknown"/"" for string, or the mean).\n' +
  '- outlier-flag: for numeric columns with a stddev, ADD a boolean column "<col>_outlier" = value beyond mean±3*stddev.\n' +
  '- Reference ONLY the exact column names given. Never invent columns. Return AT MOST 8 suggestions, highest-value first. ' +
  'If the profile is clean, return an empty suggestions array.';

function sanitizeCode(raw: unknown, dfVar: string): string {
  let code = typeof raw === 'string' ? raw.trim() : '';
  // Strip accidental markdown fences.
  code = code.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
  // Normalize the model's DataFrame variable to the caller's actual variable.
  if (dfVar !== 'df') code = code.replace(/\bdf\b/g, dfVar);
  code = code.replace(/\bDATAFRAME_VAR\b/g, dfVar);
  return code;
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { body = {}; }

  const columns: string[] = Array.isArray(body?.columns)
    ? body.columns.map((x: unknown) => String(x)).filter(Boolean)
    : [];
  if (!columns.length) {
    return NextResponse.json({ ok: false, error: 'columns[] is required' }, { status: 400 });
  }
  const stats: Record<string, ColStatLite> =
    body?.stats && typeof body.stats === 'object' ? body.stats : {};
  const sampleRows: unknown[][] = Array.isArray(body?.sampleRows)
    ? body.sampleRows.filter((r: unknown) => Array.isArray(r)).slice(0, 10)
    : [];
  const numericCols = new Set<string>(
    Array.isArray(body?.numericCols) ? body.numericCols.map((x: unknown) => String(x)) : [],
  );
  const dfVar = typeof body?.dataframeVar === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(body.dataframeVar.trim())
    ? body.dataframeVar.trim()
    : 'df';

  // Honor the admin-picked tenant Copilot deployment; honest 503 gate when none.
  const tenantConfig = await loadTenantCopilotConfig(session.claims.oid).catch(() => null);
  try {
    await resolveAoaiTarget(tenantConfig);
  } catch (e: any) {
    const hint = e instanceof NoAoaiDeploymentError ? e.message : AOAI_GATE_HINT;
    return NextResponse.json(
      { ok: false, code: 'no_aoai', gated: true, error: e?.message || String(e), hint },
      { status: 503 },
    );
  }

  const profile = buildProfile(columns, stats, sampleRows, numericCols);
  const userContent =
    `DataFrame variable name: ${dfVar}\n` +
    `Column profile (${columns.length} columns):\n${profile}\n\n` +
    'Propose cleaning steps as JSON per the system contract.';

  try {
    const raw = await aoaiChatJson<{ suggestions?: unknown[]; usage?: any; model?: string }>({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      maxCompletionTokens: 2048,
      temperature: 0.1,
      cfg: tenantConfig,
    });

    const known = new Set(columns);
    const suggestions: Suggestion[] = [];
    const arr = Array.isArray((raw as any)?.suggestions) ? (raw as any).suggestions : [];
    arr.forEach((s: any, idx: number) => {
      if (!s || typeof s !== 'object') return;
      const kind = String(s.kind || '').trim() as CleanKind;
      if (!(KINDS as readonly string[]).includes(kind)) return;
      const column = String(s.column || '').trim();
      // outlier-flag may name a column that doesn't yet exist as its output; the
      // SOURCE column must still be a real one — validate against the input set.
      if (column && !known.has(column)) return;
      const code = sanitizeCode(s.code, dfVar);
      if (!code) return;
      suggestions.push({
        id: `sug-${idx}-${kind}-${column || 'row'}`,
        kind,
        column: column || '(row)',
        title: String(s.title || `${kind} ${column}`).slice(0, 120),
        rationale: String(s.rationale || '').slice(0, 300),
        severity: s.severity === 'warning' ? 'warning' : 'info',
        code,
      });
    });

    return NextResponse.json({
      ok: true,
      engine: 'aoai',
      dataframeVar: dfVar,
      suggestions,
      model: (raw as any)?.model,
    });
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json(
        { ok: false, code: 'no_aoai', gated: true, error: e.message, hint: AOAI_GATE_HINT },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, engine: 'aoai', error: e?.message || String(e) }, { status: 502 });
  }
}
