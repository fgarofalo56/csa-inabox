'use client';

/**
 * DataWranglerAiPanel — the "AI" tab of the Lakehouse Preview surface (G4), a
 * one-for-one Loom build of Fabric's Data Wrangler AI experience:
 *
 *   1. AI cleaning suggestions — profiles the previewed columns (reusing the
 *      Spark column-statistics already computed for the Table tab) and asks
 *      Azure OpenAI (POST /api/lakehouse/ai-clean-suggest) for concrete cleaning
 *      steps (trim / cast / dedupe / fill-null / outlier-flag), each a runnable
 *      PySpark snippet over the bound DataFrame `df`.
 *   2. NL-to-code — a natural-language box that streams pandas/PySpark from the
 *      notebook-persona Copilot (POST /api/copilot/notebook-assist, command
 *      `generate`), scoped to the active DataFrame + columns, shown as an
 *      approval diff before it is inserted into a notebook / copied.
 *   3. Preview-before-apply — every candidate transform (a suggestion snippet OR
 *      the NL code) can be run against a SAMPLED copy of the source via the
 *      existing Livy plumbing (POST/GET /api/lakehouse/transform-preview) and its
 *      resulting rows rendered back in the same DeltaPreviewGrid before commit.
 *
 * Real Azure OpenAI + real Synapse Spark (Livy) only — honest Fluent MessageBar
 * gates name the exact env / admin action when a backend isn't wired. No mock
 * suggestions, no fake preview rows (per no-vaporware.md); no Microsoft Fabric /
 * Power BI dependency (per no-fabric-dependency.md).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Badge, Body1, Button, Caption1, Divider, Dropdown, Field, MessageBar,
  MessageBarBody, MessageBarTitle, Option, Spinner, Subtitle2, Text, Textarea,
  Tooltip, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Sparkle20Regular, Code20Regular, Play20Regular, Copy20Regular,
  ArrowClockwise20Regular, DocumentAdd20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import type { ColStat } from './delta-preview-grid';

// ── Types ────────────────────────────────────────────────────────────────────
export interface PreviewSource {
  container: string;
  path: string;
  pool?: string;
}

interface Suggestion {
  id: string;
  kind: 'trim' | 'cast' | 'dedupe' | 'fill-null' | 'outlier-flag';
  column: string;
  title: string;
  rationale: string;
  severity: 'info' | 'warning';
  code: string;
}

interface TransformResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  addedColumns: string[];
  removedColumns: string[];
}

export interface DataWranglerAiPanelProps {
  /** Effective grid columns (base + any already-materialized AI columns). */
  columns: string[];
  /** Effective grid rows aligned to `columns`. */
  rows: unknown[][];
  /** Column-statistics from the Table tab (nulls/min/max/type) — feeds the profile. */
  columnStats?: Record<string, ColStat> | null;
  /** Names of columns the grid detected as numeric. */
  numericColNames: string[];
  /** ADLS source of the preview — required for the live transform preview. */
  previewSource?: PreviewSource | null;
  /** DataFrame variable the generated code targets (default `df`). */
  dataframeVar?: string;
  /** When bound to a notebook, insert the code into a cell; otherwise copy-only. */
  onInsertToNotebook?: (code: string, lang: string) => void;
  /** Render the transform-preview rows back in a DeltaPreviewGrid (host-supplied
   *  to avoid a circular import — the host passes its own grid). */
  renderResultGrid: (columns: string[], rows: unknown[][], ms?: number) => React.ReactNode;
}

const KIND_COLOR: Record<Suggestion['kind'], 'brand' | 'warning' | 'danger' | 'success' | 'informative'> = {
  trim: 'informative', cast: 'brand', dedupe: 'warning', 'fill-null': 'success', 'outlier-flag': 'danger',
};

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minHeight: 0, flex: 1 },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  sectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: tokens.spacingHorizontalM },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1, border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow4,
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  code: {
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: tokens.colorNeutralBackground3,
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium,
    maxHeight: '200px', overflow: 'auto', margin: 0,
  },
  cardActions: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  nlBox: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  nlControls: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' },
  previewPanel: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground2, border: `1px solid ${tokens.colorBrandStroke2}`,
  },
  breakText: { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },
});

/** Extract fenced code blocks from a streamed markdown answer. */
function parseCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /```[a-zA-Z0-9_+-]*\s*\n?([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const code = m[1].replace(/\n+$/, '');
    if (code.trim()) blocks.push(code);
  }
  return blocks;
}

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); } catch { /* insecure context — ignore */ }
}

export function DataWranglerAiPanel(props: DataWranglerAiPanelProps) {
  const s = useStyles();
  const {
    columns, rows, columnStats, numericColNames, previewSource,
    dataframeVar = 'df', onInsertToNotebook, renderResultGrid,
  } = props;

  // ── Cleaning suggestions ──────────────────────────────────────────────────
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [suggestGate, setSuggestGate] = useState<string | null>(null);

  const generateSuggestions = useCallback(async () => {
    setSuggestLoading(true); setSuggestError(null); setSuggestGate(null);
    try {
      const r = await clientFetch('/api/lakehouse/ai-clean-suggest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          columns,
          stats: columnStats || {},
          sampleRows: rows.slice(0, 10),
          numericCols: numericColNames,
          dataframeVar,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        if (r.status === 503 && j.code === 'no_aoai') { setSuggestGate(j.hint || j.error); }
        else setSuggestError(j.error || `HTTP ${r.status}`);
        return;
      }
      setSuggestions(j.suggestions || []);
    } catch (e: any) {
      setSuggestError(e?.message || String(e));
    } finally {
      setSuggestLoading(false);
    }
  }, [columns, columnStats, rows, numericColNames, dataframeVar]);

  // ── NL → code ─────────────────────────────────────────────────────────────
  const [nlText, setNlText] = useState('');
  const [nlLang, setNlLang] = useState<'pyspark' | 'sparksql'>('pyspark');
  const [nlStreaming, setNlStreaming] = useState(false);
  const [nlAnswer, setNlAnswer] = useState('');
  const [nlCode, setNlCode] = useState<string | null>(null);
  const [nlError, setNlError] = useState<string | null>(null);
  const [nlGate, setNlGate] = useState<string | null>(null);

  const generateCode = useCallback(async () => {
    const req = nlText.trim();
    if (!req) return;
    setNlStreaming(true); setNlAnswer(''); setNlCode(null); setNlError(null); setNlGate(null);
    const scoped =
      `Write a ${nlLang === 'sparksql' ? 'Spark SQL query' : 'PySpark transform'} over the already-loaded ` +
      `DataFrame named \`${dataframeVar}\` (columns: ${columns.join(', ')}). ` +
      (nlLang === 'sparksql' ? '' : `Reassign \`${dataframeVar}\`; \`F\` is pyspark.sql.functions. Do not read or write files. `) +
      `Task: ${req}`;
    const contextCell = {
      id: 'wrangler-df',
      type: 'code' as const,
      lang: nlLang,
      source:
        `# Active DataFrame \`${dataframeVar}\`` +
        (previewSource ? ` loaded from ${previewSource.container}/${previewSource.path}` : '') +
        `\n# Columns: ${columns.join(', ')}\n`,
    };
    let full = '';
    try {
      // Streaming endpoint (`-assist`) — bare fetch is the sanctioned path for SSE
      // per check-no-bare-client-fetch (clientFetch's abort is wrong for streams).
      const res = await fetch('/api/copilot/notebook-assist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          command: 'generate',
          cells: [contextCell],
          activeCellId: contextCell.id,
          lang: nlLang,
          text: scoped,
          notebookName: 'Data Wrangler',
        }),
      });
      if (!res.ok && res.headers.get('content-type')?.includes('application/json')) {
        const j = await res.json().catch(() => ({}));
        if (res.status === 503 && j?.code === 'no_aoai') setNlGate(j.hint || j.error || 'Copilot not configured.');
        else setNlError(j?.error || `Request failed (${res.status})`);
        return;
      }
      if (!res.body) { setNlError('No response stream from Copilot.'); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = ''; let event = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trimEnd();
          buffer = buffer.slice(nl + 1);
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) {
            try {
              const d = JSON.parse(line.slice(5).trim());
              if (event === 'chunk' && typeof d?.delta === 'string') { full += d.delta; setNlAnswer(full); }
              else if (event === 'error' && d?.error) setNlError(String(d.error));
            } catch { /* partial frame */ }
          }
        }
      }
      const blocks = parseCodeBlocks(full);
      setNlCode(blocks.length ? blocks.join('\n\n') : full.trim() || null);
    } catch (e: any) {
      setNlError(e?.message || String(e));
    } finally {
      setNlStreaming(false);
    }
  }, [nlText, nlLang, dataframeVar, columns, previewSource]);

  // ── Transform preview (shared, one active candidate) ──────────────────────
  const [previewFor, setPreviewFor] = useState<string | null>(null); // candidate id
  const [previewStatus, setPreviewStatus] = useState<'idle' | 'running' | 'available' | 'error'>('idle');
  const [previewMsg, setPreviewMsg] = useState<string>('');
  const [previewResult, setPreviewResult] = useState<TransformResult | null>(null);
  const [previewGate, setPreviewGate] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) { window.clearTimeout(pollRef.current); pollRef.current = null; }
  }, []);
  useEffect(() => () => stopPolling(), [stopPolling]);

  const pollPreview = useCallback(async (jobId: string) => {
    if (!previewSource) return;
    try {
      const qs = new URLSearchParams({
        jobId, container: previewSource.container, path: previewSource.path,
        ...(previewSource.pool ? { pool: previewSource.pool } : {}),
      });
      const r = await clientFetch(`/api/lakehouse/transform-preview?${qs.toString()}`);
      const j = await r.json();
      if (j.ok && j.status === 'available') {
        setPreviewResult({
          columns: j.columns || [], rows: j.rows || [], rowCount: j.rowCount ?? 0,
          addedColumns: j.addedColumns || [], removedColumns: j.removedColumns || [],
        });
        setPreviewStatus('available');
        setPreviewMsg(`${j.rowCount ?? 0} sample rows · ${Date.now() - startedAtRef.current} ms`);
        return;
      }
      if (!j.ok) {
        if (j.status === 'transform_error') { setPreviewStatus('error'); setPreviewMsg(`Transform error: ${j.error}`); return; }
        if (r.status === 503 && j.code === 'not_configured') { setPreviewStatus('error'); setPreviewGate(j.error); return; }
        setPreviewStatus('error'); setPreviewMsg(j.error || 'Preview failed.'); return;
      }
      // warming / running — keep polling.
      setPreviewMsg(j.status === 'warming' ? 'Warming the Spark pool…' : 'Running transform on a sample…');
      pollRef.current = window.setTimeout(() => void pollPreview(j.jobId || jobId), 3000);
    } catch (e: any) {
      setPreviewStatus('error'); setPreviewMsg(e?.message || String(e));
    }
  }, [previewSource]);

  const runPreview = useCallback(async (candidateId: string, code: string) => {
    if (!previewSource) return;
    stopPolling();
    setPreviewFor(candidateId); setPreviewStatus('running'); setPreviewResult(null);
    setPreviewGate(null); setPreviewMsg('Submitting transform…');
    startedAtRef.current = Date.now();
    try {
      const r = await clientFetch('/api/lakehouse/transform-preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          container: previewSource.container, path: previewSource.path,
          pool: previewSource.pool, code,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        if (r.status === 503 && j.code === 'not_configured') { setPreviewStatus('error'); setPreviewGate(j.error); return; }
        setPreviewStatus('error'); setPreviewMsg(j.error || `HTTP ${r.status}`); return;
      }
      if (j.status === 'available') { void pollPreview(j.jobId); return; }
      pollRef.current = window.setTimeout(() => void pollPreview(j.jobId), 2000);
    } catch (e: any) {
      setPreviewStatus('error'); setPreviewMsg(e?.message || String(e));
    }
  }, [previewSource, stopPolling, pollPreview]);

  const previewDisabledReason = !previewSource
    ? 'Live preview needs a file/table source — open the Table or File tab and select a file first.'
    : null;

  // Inline preview block reused under whichever candidate is active.
  const previewBlock = (candidateId: string) => {
    if (previewFor !== candidateId) return null;
    return (
      <div className={s.previewPanel}>
        <div className={s.sectionHead}>
          <Play20Regular />
          <Subtitle2>Transform preview</Subtitle2>
          {previewStatus === 'running' && <Spinner size="tiny" label={previewMsg} labelPosition="after" />}
          {previewStatus === 'available' && <Badge appearance="tint" color="success">{previewMsg}</Badge>}
        </div>
        {previewResult && (previewResult.addedColumns.length > 0 || previewResult.removedColumns.length > 0) && (
          <div className={s.sectionHead}>
            {previewResult.addedColumns.map((c) => <Badge key={`a${c}`} appearance="outline" color="success" size="small">+ {c}</Badge>)}
            {previewResult.removedColumns.map((c) => <Badge key={`r${c}`} appearance="outline" color="danger" size="small">− {c}</Badge>)}
          </div>
        )}
        {previewGate && (
          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody className={s.breakText}>
              <MessageBarTitle>Spark pool not configured</MessageBarTitle>
              {previewGate}
            </MessageBarBody>
          </MessageBar>
        )}
        {previewStatus === 'error' && !previewGate && (
          <MessageBar intent="error" layout="multiline">
            <MessageBarBody className={s.breakText}><MessageBarTitle>Preview failed</MessageBarTitle>{previewMsg}</MessageBarBody>
          </MessageBar>
        )}
        {previewStatus === 'available' && previewResult && (
          previewResult.columns.length === 0
            ? <Caption1>Transform returned no columns.</Caption1>
            : renderResultGrid(previewResult.columns, previewResult.rows)
        )}
      </div>
    );
  };

  const insertLabel = onInsertToNotebook ? 'Insert to notebook' : 'Copy code';

  return (
    <div className={s.root}>
      {/* ── Cleaning suggestions ─────────────────────────────────────────── */}
      <div className={s.section}>
        <div className={s.sectionHead}>
          <Sparkle20Regular />
          <Subtitle2>AI cleaning suggestions</Subtitle2>
          <div className={s.spacer} />
          <Button
            appearance="primary" size="small" icon={suggestLoading ? <Spinner size="tiny" /> : <Sparkle20Regular />}
            disabled={suggestLoading || columns.length === 0}
            onClick={() => void generateSuggestions()}
          >
            {suggestLoading ? 'Profiling…' : suggestions ? 'Regenerate' : 'Generate cleaning suggestions'}
          </Button>
        </div>
        <Caption1>
          Profiles {columns.length} column(s) with the Spark column statistics and proposes trim / cast / dedupe /
          fill-null / outlier-flag steps via Azure OpenAI. Preview each on a sample before you apply it.
        </Caption1>

        {suggestGate && (
          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody className={s.breakText}>
              <MessageBarTitle>Azure OpenAI not configured</MessageBarTitle>{suggestGate}
            </MessageBarBody>
          </MessageBar>
        )}
        {suggestError && (
          <MessageBar intent="error" layout="multiline">
            <MessageBarBody className={s.breakText}><MessageBarTitle>Suggestions failed</MessageBarTitle>{suggestError}</MessageBarBody>
          </MessageBar>
        )}
        {suggestions && suggestions.length === 0 && !suggestLoading && (
          <MessageBar intent="success"><MessageBarBody>No cleaning issues found in the profiled columns.</MessageBarBody></MessageBar>
        )}

        {suggestions && suggestions.length > 0 && (
          <div className={s.cards}>
            {suggestions.map((sg) => (
              <div key={sg.id} className={s.card}>
                <div className={s.cardHead}>
                  <Badge appearance="filled" color={KIND_COLOR[sg.kind]}>{sg.kind}</Badge>
                  <Text weight="semibold" truncate title={sg.column}>{sg.column}</Text>
                </div>
                <Body1>{sg.title}</Body1>
                {sg.rationale && <Caption1>{sg.rationale}</Caption1>}
                <pre className={s.code}>{sg.code}</pre>
                <div className={s.cardActions}>
                  <Tooltip content={previewDisabledReason || 'Run this transform on a sample'} relationship="label">
                    <Button
                      appearance="outline" size="small" icon={<Play20Regular />}
                      disabled={!previewSource || (previewStatus === 'running' && previewFor === sg.id)}
                      onClick={() => void runPreview(sg.id, sg.code)}
                    >
                      Preview
                    </Button>
                  </Tooltip>
                  <Button
                    appearance="subtle" size="small" icon={<DocumentAdd20Regular />}
                    onClick={() => (onInsertToNotebook ? onInsertToNotebook(sg.code, 'pyspark') : void copy(sg.code))}
                  >
                    {insertLabel}
                  </Button>
                </div>
                {previewBlock(sg.id)}
              </div>
            ))}
          </div>
        )}
      </div>

      <Divider />

      {/* ── NL → code ────────────────────────────────────────────────────── */}
      <div className={s.section}>
        <div className={s.sectionHead}>
          <Code20Regular />
          <Subtitle2>Generate transform code from natural language</Subtitle2>
        </div>
        <Caption1>
          Describe the transform in plain English — the notebook Copilot returns runnable code scoped to the
          <Text weight="semibold"> {dataframeVar}</Text> DataFrame, grounded in the real lakehouse schema. Review the diff, preview it, then insert.
        </Caption1>
        <div className={s.nlBox}>
          <Textarea
            value={nlText}
            onChange={(_, d) => setNlText(d.value)}
            placeholder="e.g. drop rows where amount is null, then add a month column from the order_date"
            rows={2} resize="vertical"
          />
          <div className={s.nlControls}>
            <Field label="Language">
              <Dropdown
                value={nlLang === 'pyspark' ? 'PySpark' : 'Spark SQL'}
                selectedOptions={[nlLang]}
                onOptionSelect={(_, d) => { if (d.optionValue) setNlLang(d.optionValue as any); }}
                style={{ minWidth: '140px' }}
              >
                <Option value="pyspark" text="PySpark">PySpark</Option>
                <Option value="sparksql" text="Spark SQL">Spark SQL</Option>
              </Dropdown>
            </Field>
            <div className={s.spacer} />
            <Button
              appearance="primary" icon={nlStreaming ? <Spinner size="tiny" /> : <Code20Regular />}
              disabled={nlStreaming || !nlText.trim()}
              onClick={() => void generateCode()}
            >
              {nlStreaming ? 'Generating…' : 'Generate code'}
            </Button>
          </div>
        </div>

        {nlGate && (
          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody className={s.breakText}><MessageBarTitle>Copilot not configured</MessageBarTitle>{nlGate}</MessageBarBody>
          </MessageBar>
        )}
        {nlError && (
          <MessageBar intent="error" layout="multiline">
            <MessageBarBody className={s.breakText}><MessageBarTitle>Code generation failed</MessageBarTitle>{nlError}</MessageBarBody>
          </MessageBar>
        )}
        {nlStreaming && nlAnswer && <pre className={s.code}>{nlAnswer}</pre>}
        {!nlStreaming && nlCode && (
          <div className={s.card}>
            <div className={s.cardHead}>
              <Badge appearance="tint" color="brand">{nlLang}</Badge>
              <Text weight="semibold">Generated transform</Text>
              <div className={s.spacer} />
              <Caption1>Review before applying</Caption1>
            </div>
            <pre className={s.code}>{nlCode}</pre>
            <div className={s.cardActions}>
              {nlLang === 'pyspark' && (
                <Tooltip content={previewDisabledReason || 'Run this transform on a sample'} relationship="label">
                  <Button
                    appearance="outline" size="small" icon={<Play20Regular />}
                    disabled={!previewSource || (previewStatus === 'running' && previewFor === 'nl')}
                    onClick={() => void runPreview('nl', nlCode)}
                  >
                    Preview
                  </Button>
                </Tooltip>
              )}
              <Button
                appearance="subtle" size="small" icon={<DocumentAdd20Regular />}
                onClick={() => (onInsertToNotebook ? onInsertToNotebook(nlCode, nlLang) : void copy(nlCode))}
              >
                {insertLabel}
              </Button>
              <Button appearance="subtle" size="small" icon={<Copy20Regular />} onClick={() => void copy(nlCode)}>Copy</Button>
              <Button appearance="subtle" size="small" icon={<ArrowClockwise20Regular />} onClick={() => void generateCode()}>Regenerate</Button>
            </div>
            {previewBlock('nl')}
          </div>
        )}
      </div>
    </div>
  );
}

export default DataWranglerAiPanel;
