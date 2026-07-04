'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * TransformDataDrawer — the report builder's "Transform Data" surface (Wave 4).
 *
 * Power Query "Transform Data", reusing the PROVEN Dataflow Gen2 authoring host
 * (`PowerQueryHost`) — the same ribbon / formula bar / Queries pane / Applied-
 * Steps pane / View tab the dataflow editor mounts — so a report gains the full
 * Power Query Online surface with ZERO new authoring code and no regression to
 * the dataflow editor (it mounts the host with the same additive props all
 * defaulted off).
 *
 * What this drawer adds on top of the shared host:
 *   1. SEED — builds an M `section` for the bound report source: a single opaque
 *      `Source` step the host treats verbatim (the server substitutes the real
 *      resolved relation when folding), plus any persisted `appliedSteps` so a
 *      transform round-trips. The structured dialogs / ribbon then append every
 *      step through `m-script.appendStep` (no raw-typed M — no-freeform-config).
 *   2. WIRES the host's report-route hooks:
 *        • onProfile          → POST /api/items/report/[id]/profile  (real
 *          aggregate SQL on Synapse over the folded relation — rendered by
 *          data-profiling.tsx; an honest gate when the backend isn't ready).
 *        • onViewNativeQuery  → GET  /api/items/report/[id]/native-query (the
 *          REAL compiled SQL for the bound dialect); falls back to the host's
 *          local `foldAppliedStepsToSql` over a symbolic source so View-native-
 *          query always shows REAL folded SQL + the honest not-foldable gate,
 *          never a stub.
 *        • Manage parameters  → host-owned (its built-in ManageParametersDialog
 *          edits THIS transform's M — no extra route needed).
 *   3. CONNECTIVITY radio — DirectQuery (default: fold the steps to SQL at read
 *      time) vs Import (materialize a Delta cache via the report /refresh run,
 *      then fold over the cache). Non-foldable steps REQUIRE Import; DirectQuery
 *      surfaces the honest "switch to Import" gate (computed locally via
 *      `foldAppliedStepsToSql`, exactly like the read path).
 *   4. APPLY — PUT /api/items/report/[id]/data-source with the bound source +
 *      `appliedSteps` (the authored M) + `transformMode`; when Import, also POST
 *      /api/items/report/[id]/refresh to materialize the Delta cache, surfacing
 *      the honest "run refresh" receipt/gate.
 *
 * Read-only for an unsaved report (`reportId === 'new'`): authoring + persistence
 * need a real item, so the host renders read-only with an honest "save first"
 * gate. View-native-query still previews locally (real fold) even when new.
 *
 * Rules compliance:
 *  - no-vaporware: the transform really shapes data — DirectQuery folds to real
 *    SQL, Import materializes a real Synapse-Spark Delta cache via the existing
 *    /refresh route, profiling runs real aggregate SQL, native-query returns the
 *    real compiled SQL. No mock columns, no `return []`, no stub tabs. Routes that
 *    aren't deployed yet surface an honest, named gate — never fabricated data.
 *  - no-freeform-config: every transform is a structured ribbon/dialog step
 *    emitted through `appendStep`; the only free text is literal values bound as
 *    M literals. No raw-M textbox here.
 *  - no-fabric-dependency: Synapse / ADF (wrangling-dataflow) backends only — no
 *    api.fabric / api.powerbi / onelake host on any path.
 *  - web3-ui: Fluent v9 + Loom tokens + the canvas-node-kit `transform` accent,
 *    matching the PowerQueryHost it embeds and the data-source picker it opens
 *    alongside.
 *
 * ADDITIVE: this file only consumes the shared host + report-data-source +
 * m-script contracts (all already shipped). It does NOT touch report-designer.tsx
 * (Wave 5), the semantic-model files (Wave 3), or report-model-resolver /
 * storage-mode-pane (W2), and does not change the dataflow editor mount.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  OverlayDrawer, DrawerHeader, DrawerHeaderTitle, DrawerBody, DrawerFooter,
  Button, Caption1, Subtitle2, Body1Strong, Badge, Divider,
  RadioGroup, Radio,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Spinner, makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Dismiss20Regular, Checkmark16Regular, TableSettings20Regular,
  ArrowSync16Regular,
} from '@fluentui/react-icons';
import {
  PowerQueryHost,
  type TransformColumn,
  type NativeQueryResult,
} from '@/lib/components/pipeline/dataflow/power-query-host';
import type { ProfileResponse } from '@/lib/components/pipeline/dataflow/data-profiling';
import {
  parseSharedQueries,
  foldAppliedStepsToSql,
} from '@/lib/components/pipeline/dataflow/m-script';
import {
  hasTransformDialog,
  renderTransformDialog,
} from '@/lib/components/pipeline/dataflow/pq-transform-dialogs';
import {
  type ReportDataSource,
  isBound,
  hasTransform,
  reportTransformMode,
  describeSource,
} from './report-data-source';
import { CATEGORY_ACCENT, accentTint } from '@/lib/components/canvas/canvas-node-kit';
import { EmptyState } from '@/lib/components/empty-state';

/** Power Query is a data-wrangling surface → the kit's `transform` accent (violet),
 *  the SAME accent the embedded PowerQueryHost + data-profiling use. */
const ACCENT = CATEGORY_ACCENT.transform;

type TransformMode = 'directQuery' | 'import';

// ── pure seed helpers (no fabricated data — an opaque source ref + chained M) ──

/** M string literal (double embedded quotes), so describeSource text is safe in M. */
function mString(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

/**
 * Build the opaque `Source` step expression for the bound report source. The host
 * treats this step VERBATIM and the server substitutes the real resolved relation
 * when folding the chained steps (the Source step is never evaluated as M —
 * DirectQuery folds to SQL, Import materializes the base table via /refresh). It is
 * kept syntactically valid M (balanced brackets, no top-level commas/semicolons) so
 * `parseSharedQueries` / `parseLetBody` round-trip it cleanly.
 */
function buildSourceRefExpr(ds: ReportDataSource): string {
  return `Loom.Source([Kind = ${mString(ds.kind)}, Ref = ${mString(describeSource(ds))}])`;
}

/**
 * Seed the Transform host's M for a bound source: re-use the persisted full M
 * section when a transform already exists (round-trip), else start a fresh single-
 * step `let Source = <opaque ref> in Source` the ribbon/dialogs append onto.
 */
function seedMScript(ds: ReportDataSource): string {
  if (hasTransform(ds) && ds.appliedSteps && ds.appliedSteps.trim()) return ds.appliedSteps;
  return `section Section1;\n\nshared Query = let\n    Source = ${buildSourceRefExpr(ds)}\nin\n    Source;\n`;
}

/** Flatten the /fields response's tables → a deduped TransformColumn[] for the dialogs. */
function flattenFieldColumns(tables: unknown): TransformColumn[] {
  if (!Array.isArray(tables)) return [];
  const out: TransformColumn[] = [];
  const seen = new Set<string>();
  for (const t of tables) {
    const cols = (t && typeof t === 'object' ? (t as { columns?: unknown }).columns : null);
    if (!Array.isArray(cols)) continue;
    for (const c of cols) {
      if (!c || typeof c !== 'object') continue;
      const name = (c as { name?: unknown }).name;
      if (typeof name !== 'string' || !name || seen.has(name)) continue;
      seen.add(name);
      const dataType = (c as { dataType?: unknown }).dataType;
      out.push({ name, ...(typeof dataType === 'string' && dataType ? { dataType } : {}) });
    }
  }
  return out;
}

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0 },
  intro: { color: tokens.colorNeutralForeground3 },
  // Accent header-icon chip, mirroring the PowerQueryHost / data-profiling chrome.
  headerTitle: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  headerIcon: {
    flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '28px', height: '28px', borderRadius: tokens.borderRadiusMedium,
    background: accentTint(ACCENT, 14), color: ACCENT,
  },
  // Elevated connectivity card — same elevated-card language as the host panels.
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  radios: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  radioHint: { color: tokens.colorNeutralForeground3, marginLeft: tokens.spacingHorizontalXL },
  // The host fills a comfortable, bounded region; its own ResizableCanvasRegion
  // owns the canvas height, so this wrapper just gives it room to render.
  hostWrap: { display: 'flex', flexDirection: 'column', minHeight: '52vh', minWidth: 0, flex: 1 },
  footer: { display: 'flex', gap: tokens.spacingHorizontalS, justifyContent: 'flex-end', alignItems: 'center' },
  footerSpacer: { flex: 1 },
  breakText: { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },
});

export interface TransformDataDrawerProps {
  /** Whether the drawer is open. */
  open: boolean;
  /** Report item id. `'new'` ⇒ read-only (save the report first). */
  reportId: string;
  /** The bound report data source the transform sits on top of (null ⇒ unbound gate). */
  dataSource: ReportDataSource | null;
  /** Notified with the transformed source after a successful Apply (parent updates
   *  its in-memory `state.dataSource` so the ribbon badge + read path reflect it). */
  onApplied?: (next: ReportDataSource) => void;
  /** Close the drawer. */
  onDismiss: () => void;
}

export function TransformDataDrawer({
  open, reportId, dataSource, onApplied, onDismiss,
}: TransformDataDrawerProps) {
  const s = useStyles();

  const bound = isBound(dataSource);
  const isNew = reportId === 'new';

  const [mScript, setMScript] = useState('');
  const [mode, setMode] = useState<TransformMode>('directQuery');
  const [activeQuery, setActiveQuery] = useState('');
  const [schema, setSchema] = useState<TransformColumn[] | undefined>(undefined);

  const [applying, setApplying] = useState(false);
  const [applyNote, setApplyNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<{ ok: boolean; text: string; missing?: string[] } | null>(null);

  // Latest values mirrored into refs so the host hooks (onProfile / onViewNativeQuery)
  // stay STABLE — they read the current M / mode / active query without churning the
  // host or refiring the data-profiling auto-run.
  const mRef = useRef(mScript);
  const modeRef = useRef<TransformMode>(mode);
  const activeQRef = useRef(activeQuery);
  useEffect(() => { mRef.current = mScript; }, [mScript]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { activeQRef.current = activeQuery; }, [activeQuery]);

  // (Re)seed the host from the bound source whenever the drawer opens.
  useEffect(() => {
    if (!open) return;
    if (dataSource && isBound(dataSource)) {
      setMScript(seedMScript(dataSource));
      setMode(reportTransformMode(dataSource));
    } else {
      setMScript('');
    }
    setApplyNote(null);
    setRefreshNote(null);
    setSchema(undefined);
    // Re-seed on each open; dataSource is read intentionally without being a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A stable signature of the BOUND source + its persisted transform. The schema
  // fetch re-introspects whenever THIS changes (Apply persisted a new transform,
  // or the parent rebound the source) — but NOT on every live M keystroke (the host
  // edits local `mScript`, which is intentionally absent here). So the structured
  // dialogs' column pickers always offer the REAL, current columns the `/fields`
  // route resolves (post-fold `transformed:true` columns once a DirectQuery
  // transform is applied), with no churn while the user is mid-edit.
  const sourceSignature = useMemo(() => {
    if (!dataSource || !isBound(dataSource)) return '';
    return [
      dataSource.kind,
      describeSource(dataSource),
      hasTransform(dataSource) ? reportTransformMode(dataSource) : 'none',
      dataSource.appliedSteps ?? '',
    ].join('');
  }, [dataSource]);

  // Fetch the source schema (real /fields introspection) so the structured transform
  // dialogs offer REAL column names — the column pickers consume `schema` (passed to
  // the host below) instead of letting the user type column names. Best-effort: a
  // non-ok response (412 unbound / 409 a persisted non-foldable DirectQuery step)
  // clears the list so the dialogs fall back to honest free entry rather than
  // offering a previous source's stale columns — it never blocks authoring.
  useEffect(() => {
    if (!open || !bound || isNew) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await clientFetch(`/api/items/report/${encodeURIComponent(reportId)}/fields`);
        const j = await r.json().catch(() => null);
        if (cancelled) return;
        setSchema(j && j.ok ? flattenFieldColumns(j.tables) : undefined);
      } catch { /* schema is optional — dialogs still render with free column entry */ }
    })();
    return () => { cancelled = true; };
  }, [open, bound, isNew, reportId, sourceSignature]);

  // ── host hook: real column profiling (POST /profile) ────────────────────────
  const onProfile = useCallback(async (): Promise<ProfileResponse> => {
    if (isNew) {
      return { ok: false, code: 'unbound', error: 'Save the report first to profile its data on Synapse.' };
    }
    try {
      const r = await clientFetch(`/api/items/report/${encodeURIComponent(reportId)}/profile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          appliedSteps: mRef.current,
          transformMode: modeRef.current,
          queryName: activeQRef.current,
        }),
      });
      const j = await r.json().catch(() => null);
      if (j && typeof j === 'object' && 'ok' in j) return j as ProfileResponse;
      return { ok: false, error: `Column profiling unavailable (HTTP ${r.status}).` };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }, [isNew, reportId]);

  // ── host hook: real native query (GET /native-query) with local-fold fallback ──
  const onViewNativeQuery = useCallback(async (queryName: string): Promise<NativeQueryResult> => {
    // 1) Real route — the compiled SQL for the bound dialect + resolved relation.
    if (!isNew) {
      try {
        const r = await clientFetch(`/api/items/report/${encodeURIComponent(reportId)}/native-query`);
        if (r.ok) {
          const j = await r.json().catch(() => null);
          if (j?.ok && typeof j.sql === 'string') {
            return { ok: true, dialect: j.dialect, sql: j.sql, foldable: true };
          }
          if (j && j.ok === false && (j.code === 'not-foldable' || j.code === 'unbound')) {
            return { ok: false, code: j.code, error: j.error, unfoldableStep: j.unfoldableStep };
          }
        }
      } catch { /* fall through to the local fold */ }
    }
    // 2) Local fold over a symbolic source — reflects the CURRENT (unsaved) steps;
    //    REAL fold logic + the honest not-foldable gate (never a fabricated query).
    const q = parseSharedQueries(mRef.current).find((x) => x.name === queryName);
    const folded = foldAppliedStepsToSql('SELECT * FROM [source]', q?.body ?? '');
    return folded.ok
      ? { ok: true, sql: folded.sql, foldable: true }
      : {
          ok: false,
          code: 'not-foldable',
          unfoldableStep: folded.unfoldableStep,
          error: `Step '${folded.unfoldableStep}' can't fold to a native query — switch this query to Import.`,
        };
  }, [isNew, reportId]);

  // ── DirectQuery foldability of the active query (the honest read-path gate) ───
  const foldStatus = useMemo(() => {
    const qs = parseSharedQueries(mScript);
    const q = qs.find((x) => x.name === activeQuery) || qs[0];
    return foldAppliedStepsToSql('SELECT * FROM [source]', q?.body ?? '');
  }, [mScript, activeQuery]);

  // ── Import materialization (existing W2 /refresh route, unchanged) ───────────
  const runRefresh = useCallback(async () => {
    if (isNew) return;
    setRefreshing(true);
    setRefreshNote(null);
    try {
      const r = await clientFetch(`/api/items/report/${encodeURIComponent(reportId)}/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const j = await r.json().catch(() => ({} as any));
      if (!r.ok || !j?.ok) {
        setRefreshNote({
          ok: false,
          text: j?.error || `Refresh unavailable (HTTP ${r.status}).`,
          ...(Array.isArray(j?.missing) ? { missing: j.missing } : {}),
        });
        return;
      }
      if (j.mode === 'live') {
        setRefreshNote({
          ok: true,
          text:
            'No table is set to Import storage yet, so nothing was materialized. DirectQuery folding is ' +
            'active in the meantime; set a table to Import in Storage mode, then Refresh to write its Delta cache.',
        });
      } else if (j.mode === 'materialize') {
        const n = Array.isArray(j.refreshed) ? j.refreshed.length : 0;
        setRefreshNote({
          ok: true,
          text:
            `Materialization dispatched on Synapse Spark — ${n} table${n === 1 ? '' : 's'} writing to ADLS Delta. ` +
            'The report reads the cache once the batch lands.',
        });
      } else {
        setRefreshNote({ ok: true, text: `Refresh dispatched (${j.mode || 'ok'}).` });
      }
    } catch (e: any) {
      setRefreshNote({ ok: false, text: e?.message || String(e) });
    } finally {
      setRefreshing(false);
    }
  }, [isNew, reportId]);

  // ── Apply — persist the transform (PUT /data-source); Import → also /refresh ──
  const apply = useCallback(async () => {
    if (isNew || !dataSource || !isBound(dataSource)) return;
    setApplying(true);
    setApplyNote(null);
    setRefreshNote(null);
    // The transform rides ALONGSIDE the already-bound source (additive mixin):
    // spread the source + the authored M + the connectivity choice.
    const next = { ...dataSource, appliedSteps: mScript, transformMode: mode } as ReportDataSource;
    try {
      const r = await clientFetch(`/api/items/report/${encodeURIComponent(reportId)}/data-source`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dataSource: next }),
      });
      const j = await r.json().catch(() => ({} as any));
      if (!r.ok || !j?.ok) {
        setApplyNote({ ok: false, text: j?.error || `Could not save the transform (HTTP ${r.status}).` });
        return;
      }
      onApplied?.(next);
      setApplyNote({
        ok: true,
        text: mode === 'import'
          ? 'Transform saved (Import). Materializing the Delta cache via the Azure-native run…'
          : 'Transform saved. DirectQuery folds these applied steps to native SQL at read time.',
      });
      if (mode === 'import') await runRefresh();
    } catch (e: any) {
      setApplyNote({ ok: false, text: e?.message || String(e) });
    } finally {
      setApplying(false);
    }
  }, [isNew, dataSource, reportId, mScript, mode, onApplied, runRefresh]);

  const directQueryUnfoldable = mode === 'directQuery' && !foldStatus.ok;

  return (
    <OverlayDrawer
      open={open}
      onOpenChange={(_e, d) => { if (!d.open) onDismiss(); }}
      position="end"
      size="large"
      style={{ width: 'min(1120px, 96vw)' }}
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={<Button appearance="subtle" icon={<Dismiss20Regular />} aria-label="Close Transform data" onClick={onDismiss} />}
        >
          <span className={s.headerTitle}>
            <span className={s.headerIcon} aria-hidden="true"><TableSettings20Regular /></span>
            Transform data
          </span>
        </DrawerHeaderTitle>
      </DrawerHeader>

      <DrawerBody>
        <div className={s.body}>
          <Caption1 className={s.intro}>
            Shape this report&apos;s source with Power Query — the same authoring surface as Dataflow Gen2.
            Every step is structured (no hand-typed M); DirectQuery folds the steps to native SQL, Import
            materializes a Delta cache. 100% Azure-native (Synapse / ADF) — no Power BI or Fabric workspace.
          </Caption1>

          {!bound ? (
            <EmptyState
              icon={<TableSettings20Regular />}
              title="No data source bound"
              body="Pick a data source for this report first (the Data source panel) — Transform data shapes the bound source with Power Query."
            />
          ) : (
            <>
              {isNew && (
                <MessageBar intent="info">
                  <MessageBarBody className={s.breakText}>
                    <MessageBarTitle>Save the report to author a transform</MessageBarTitle>
                    Transform data persists onto the saved report item. Save this report once, then reopen
                    Transform data to author + apply Power Query steps. You can still preview the folded
                    native query below.
                  </MessageBarBody>
                </MessageBar>
              )}

              {/* Connectivity — DirectQuery (fold) vs Import (materialize). */}
              <div className={s.card}>
                <div className={s.cardHead}>
                  <Subtitle2>Data connectivity mode</Subtitle2>
                  <Badge appearance="tint" color={mode === 'import' ? 'warning' : 'brand'}>
                    {mode === 'import' ? 'Import' : 'DirectQuery'}
                  </Badge>
                  <div className={s.spacer} />
                  {mode === 'import' && !isNew && (
                    <Button
                      size="small" appearance="subtle" icon={<ArrowSync16Regular />}
                      onClick={runRefresh} disabled={refreshing}
                    >
                      {refreshing ? 'Refreshing…' : 'Run refresh'}
                    </Button>
                  )}
                </div>
                <RadioGroup
                  value={mode}
                  onChange={(_e, d) => setMode(d.value as TransformMode)}
                  aria-label="Data connectivity mode"
                  disabled={isNew}
                >
                  <div className={s.radios}>
                    <Radio value="directQuery" label="DirectQuery (fold to SQL)" />
                    <Caption1 className={s.radioHint}>
                      Fold the applied steps into a native SQL query executed live at read time. Default,
                      lowest latency to fresh data. Foldable steps only.
                    </Caption1>
                    <Radio value="import" label="Import (materialize a Delta cache)" />
                    <Caption1 className={s.radioHint}>
                      Materialize the result to ADLS Delta via the Azure-native dataflow run, then read the
                      cache. Required for steps that can&apos;t fold to SQL.
                    </Caption1>
                  </div>
                </RadioGroup>
              </div>

              {/* Honest read-path gate: a non-foldable step under DirectQuery. */}
              {directQueryUnfoldable && (
                <MessageBar intent="warning">
                  <MessageBarBody className={s.breakText}>
                    <MessageBarTitle>Step &ldquo;{foldStatus.unfoldableStep}&rdquo; can&apos;t fold to SQL</MessageBarTitle>
                    DirectQuery shapes data by folding the applied steps into native SQL, but this step has no
                    SQL equivalent. Switch this query to <strong>Import</strong> to materialize it via the
                    Azure-native dataflow run, or remove the step.
                  </MessageBarBody>
                  <MessageBarActions>
                    <Button size="small" appearance="subtle" onClick={() => setMode('import')}>Switch to Import</Button>
                  </MessageBarActions>
                </MessageBar>
              )}

              {applyNote && (
                <MessageBar intent={applyNote.ok ? 'success' : 'error'}>
                  <MessageBarBody className={s.breakText}>{applyNote.text}</MessageBarBody>
                </MessageBar>
              )}
              {refreshNote && (
                <MessageBar intent={refreshNote.ok ? 'success' : 'warning'}>
                  <MessageBarBody className={s.breakText}>
                    {refreshNote.text}
                    {refreshNote.missing && refreshNote.missing.length > 0 && (
                      <> {' '}Set: <code>{refreshNote.missing.join(', ')}</code>.</>
                    )}
                  </MessageBarBody>
                </MessageBar>
              )}

              <Divider />

              {/* The shared Dataflow Gen2 Power Query host — additive report hooks. */}
              <div className={s.hostWrap}>
                <PowerQueryHost
                  mScript={mScript}
                  onChange={setMScript}
                  readOnly={isNew}
                  onActiveQueryChange={setActiveQuery}
                  schema={schema}
                  onProfile={onProfile}
                  onViewNativeQuery={onViewNativeQuery}
                  hasTransformDialog={hasTransformDialog}
                  renderTransformDialog={renderTransformDialog}
                />
              </div>
            </>
          )}
        </div>
      </DrawerBody>

      <DrawerFooter>
        <div className={s.footer}>
          {applying && <Spinner size="tiny" label="Saving…" />}
          <div className={s.footerSpacer} />
          <Button appearance="secondary" onClick={onDismiss} disabled={applying}>Close</Button>
          <Button
            appearance="primary"
            icon={applying ? <Spinner size="tiny" /> : <Checkmark16Regular />}
            onClick={apply}
            disabled={!bound || isNew || applying}
          >
            {applying ? 'Applying…' : 'Apply transform'}
          </Button>
        </div>
      </DrawerFooter>
    </OverlayDrawer>
  );
}

export default TransformDataDrawer;
