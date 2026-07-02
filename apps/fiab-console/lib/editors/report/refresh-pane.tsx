'use client';

/**
 * RefreshPane — Azure-native data refresh for a Loom report (Report-Builder
 * parity, WAVE 2).
 *
 * ── Why this exists (no-fabric-dependency.md, THE headline fix) ──────────────
 * The report "refresh" used to be Power-BI-ONLY: it required a Power BI
 * workspaceId and queued a *dataset* refresh against api.powerbi.com — a
 * default-path Fabric/Power BI dependency, i.e. a rule violation. Wave 2
 * rewrites the route so the DEFAULT path is Azure-native re-materialization
 * (resolve the report's data source, then re-materialize each Import/Dual table
 * via the materialized-lake-view-engine as a real Synapse Spark batch writing a
 * managed Delta table; AAS-bound models take an AAS async/incremental refresh;
 * DirectQuery / Direct-Lake are live and a no-op). The Power BI path survives
 * ONLY behind an explicit opt-in BI backend and is never reached by default —
 * so this pane renders NO Power BI control. We POST `{}` (refresh all) or
 * `{ table }` (refresh one) and let the Azure-native default run.
 *
 * ── What the pane does (no-vaporware.md) ────────────────────────────────────
 *   • Refresh now  — POST /api/items/report/[id]/refresh. Shows the returned
 *     mode verbatim:
 *        'materialize' → a receipt listing each table's REAL Synapse Spark
 *                        Livy batch id + the managed Delta url it writes;
 *        'live'        → "Live source (DirectQuery / Direct Lake) — nothing to
 *                        materialize." (an honest 200 no-op);
 *        gate (412)    → a warning MessageBar with the engine's EXACT
 *                        remediation (the Synapse/ADLS env var / role / quota),
 *                        verbatim — never swallowed into a fake success.
 *   • Last-refreshed badge per table — from GET /refresh `lastRefresh`
 *     (state.lastRefresh): each Import/Dual table shows when it was last
 *     materialized, its batch id, status, and Delta url. An Import/Dual table
 *     with no cache yet is shown as "Run Refresh to materialize" (cache-not-
 *     ready → the resolver falls back to live), never a blank or a mock.
 *   • Scheduled refresh — read-only metadata + an HONEST gate: scheduling a
 *     recurring refresh needs an ADF factory + trigger (set LOOM_ADF_FACTORY);
 *     `buildRefreshAdfPipeline` builds the pipeline but the recurring trigger is
 *     the documented gate until wired. We surface the route's `schedule.gate`
 *     verbatim (or that fallback text) — no dead "Schedule" button.
 *
 * ── Rules ───────────────────────────────────────────────────────────────────
 *   no-fabric-dependency: Azure-native re-materialization is the default; no
 *     Power BI / Fabric control on this surface; api.powerbi.com is never hit
 *     from here.
 *   no-vaporware: every control hits the real route; the materialize receipt
 *     shows the live batch id + Delta url; gates are verbatim; no mock arrays.
 *   no-freeform-config: refresh is a button (+ optional per-table button); the
 *     schedule is read-only metadata behind an honest gate — no JSON, no free
 *     text.
 *   web3-ui: Fluent v9 + Loom design tokens only (no hard-coded px/hex), cards
 *     with elevation, section headers, icons, badges, dark-legible foregrounds,
 *     EmptyState for the live-only case.
 *
 * Back-compat: a report with no `state.tableStorage` has every table on
 * DirectQuery (live) — this pane then reports "all sources are live, nothing to
 * materialize" and Refresh-now returns the honest `live` no-op. Nothing breaks.
 *
 * Mounting: surfaced through `data-source-picker.tsx` (the source-config drawer
 * the designer already mounts) alongside the per-table StorageModePane and the
 * NavigatorDialog. `report-designer.tsx` is reserved for Wave 5 and is NOT
 * edited.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Badge, Button, Caption1, Subtitle2, Title3, Text, Divider, Spinner, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  ArrowClockwise20Regular, ArrowSync16Regular, Clock16Regular,
  DatabaseArrowDown20Regular, CalendarClock20Regular, Flash20Regular,
  Info16Regular, Checkmark16Regular, Copy16Regular, Warning16Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { clientFetch } from '@/lib/client-fetch';

// ── StorageMode — LOCAL string-validated mirror of the SHARED CONTRACT ────────
// `lib/editors/report/storage-mode-pane.tsx` OWNS the canonical StorageMode /
// ConnectivityMode union (the W2 contract; the resolver + wells-to-sql carry the
// same string-validated mirror). This pane keeps a local mirror rather than
// importing the owner so it compiles independently of sibling-file timing and
// never widens its dependency surface — the union is documented as ONE shared
// contract. `coerceMode` tolerates any persisted/wire value.
type StorageMode = 'DirectQuery' | 'Import' | 'Dual' | 'DirectLake';
const STORAGE_MODES: readonly StorageMode[] = ['DirectQuery', 'Import', 'Dual', 'DirectLake'];
function coerceMode(v: unknown): StorageMode {
  return typeof v === 'string' && (STORAGE_MODES as readonly string[]).includes(v)
    ? (v as StorageMode)
    : 'DirectQuery';
}
/** Import + Dual write a managed Delta cache (materialized-lake-view-engine).
 *  DirectQuery + DirectLake are live (serverless over the table's own Delta /
 *  the pinned pool) — nothing to materialize. */
function isMaterializable(mode: StorageMode): boolean {
  return mode === 'Import' || mode === 'Dual';
}
const MODE_LABEL: Record<StorageMode, string> = {
  DirectQuery: 'DirectQuery',
  Import: 'Import',
  Dual: 'Dual',
  DirectLake: 'Direct Lake',
};

// ── Route contract (GET + POST /api/items/report/[id]/refresh) ────────────────

/** One table's persisted materialization receipt (report state.lastRefresh[table]). */
interface LastRefreshEntry {
  at?: string;
  batchId?: string;
  deltaUrl?: string;
  status?: string;
  trigger?: string;
}
type LastRefreshMap = Record<string, LastRefreshEntry>;

/** GET /refresh schedule block — `configured:false` + an honest ADF gate in W2. */
interface ScheduleInfo {
  configured: boolean;
  cron?: string;
  gate?: { error?: string; missing?: string };
}

/** GET /refresh body. */
interface RefreshStatus {
  mode?: string;
  lastRefresh: LastRefreshMap;
  schedule: ScheduleInfo;
}

/** Parsed outcome of a Refresh-now POST (the surfaced result banner). */
type RefreshResult =
  | { kind: 'materialize'; refreshed: { table: string; batchId?: string; deltaUrl?: string }[] }
  | { kind: 'live'; message: string }
  | { kind: 'gate'; error: string; missing?: string }
  | { kind: 'error'; error: string };

/** A table row the pane renders: its storage mode + (optional) last receipt. */
interface TableRow {
  name: string;
  mode: StorageMode;
  group?: string;
  last?: LastRefreshEntry;
}

// ── time helpers (pure) ───────────────────────────────────────────────────────

/** Compact relative time ("just now", "5m ago", "3h ago", "2d ago"); '' if invalid. */
function relativeTime(iso?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
/** Full local timestamp for the badge tooltip; falls back to the raw string. */
function absoluteTime(iso?: string): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
}

// ── styles (Loom tokens only — no hard-coded px/hex) ──────────────────────────

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  header: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  headerRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  spacer: { flex: 1, minWidth: 0 },
  muted: { color: tokens.colorNeutralForeground3 },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  sectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  card: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalM,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow',
    transitionDuration: tokens.durationFaster,
    minWidth: 0,
    ':hover': { boxShadow: tokens.shadow16 },
  },
  cardLive: { backgroundColor: tokens.colorNeutralBackground2, boxShadow: tokens.shadow2 },
  cardIcon: {
    flexShrink: 0,
    color: tokens.colorBrandForeground1,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: tokens.spacingHorizontalXXXL, height: tokens.spacingHorizontalXXXL,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  cardBody: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0, flex: 1 },
  cardTitleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  tableName: { fontFamily: tokens.fontFamilyMonospace, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
  receiptRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  mono: {
    fontFamily: tokens.fontFamilyMonospace,
    color: tokens.colorNeutralForeground2,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    maxWidth: '100%',
  },
  cardActions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexShrink: 0 },
  receiptList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, marginTop: tokens.spacingVerticalXS },
  receiptItem: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
});

// ── component ─────────────────────────────────────────────────────────────────

export interface RefreshPaneProps {
  /** Report item id — used to scope every /refresh call. Pane is inert until set. */
  reportId?: string;
  /**
   * Per-table storage selection (report `state.tableStorage`). Optional and
   * additive: absent ⇒ every table is DirectQuery (live) and only tables that
   * have already been materialized (from GET /refresh) appear. We accept the
   * loose `{ mode; group? }` shape so this pane never hard-imports the
   * StorageMode owner — `mode` is string-validated via `coerceMode`.
   */
  tableStorage?: Record<string, { mode?: string; group?: string }>;
  /**
   * Whether the report has a bound data source. When false the pane shows an
   * honest "bind a source first" note instead of pretending it can materialize.
   */
  bound?: boolean;
  /**
   * Called with the route's updated `lastRefresh` after a successful refresh so
   * the parent can persist `state.lastRefresh`. Optional.
   */
  onRefreshed?: (lastRefresh: LastRefreshMap) => void;
}

export function RefreshPane({ reportId, tableStorage, bound, onRefreshed }: RefreshPaneProps) {
  const styles = useStyles();

  const [status, setStatus] = useState<RefreshStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  /** null = idle; '' = refresh-all in flight; '<table>' = that table in flight. */
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<RefreshResult | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // ── load current refresh status (GET /refresh) ──────────────────────────────
  const load = useCallback(async () => {
    if (!reportId) { setStatus(null); return; }
    setLoading(true); setLoadErr(null);
    try {
      const r = await clientFetch(`/api/items/report/${encodeURIComponent(reportId)}/refresh`, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) { setLoadErr(j?.error || `HTTP ${r.status}`); return; }
      setStatus({
        mode: typeof j?.mode === 'string' ? j.mode : undefined,
        lastRefresh: (j?.lastRefresh && typeof j.lastRefresh === 'object' ? j.lastRefresh : {}) as LastRefreshMap,
        schedule: {
          configured: !!j?.schedule?.configured,
          cron: typeof j?.schedule?.cron === 'string' ? j.schedule.cron : undefined,
          gate: j?.schedule?.gate && typeof j.schedule.gate === 'object'
            ? { error: j.schedule.gate.error, missing: j.schedule.gate.missing }
            : undefined,
        },
      });
    } catch (e: any) {
      setLoadErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [reportId]);

  useEffect(() => { load(); }, [load]);

  // ── Refresh now (POST /refresh, Azure-native default; no Power BI control) ───
  const runRefresh = useCallback(async (table?: string) => {
    if (!reportId) return;
    setBusy(table ?? '');
    setResult(null);
    try {
      const r = await clientFetch(
        `/api/items/report/${encodeURIComponent(reportId)}/refresh`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Azure-native default: NO biBackend / workspaceId. Optional single-table scope.
          body: JSON.stringify(table ? { table } : {}),
        },
        // A Spark batch submission is heavier than a UI round-trip; give it room.
        60000,
      );
      const j = await r.json().catch(() => ({}));

      // 412 → honest engine gate (Synapse/ADLS env var / role / quota), verbatim.
      if (r.status === 412 || j?.code === 'gate') {
        setResult({ kind: 'gate', error: j?.error || `HTTP ${r.status}`, missing: j?.missing });
        return;
      }
      if (!r.ok || j?.ok === false) {
        setResult({ kind: 'error', error: j?.error || `HTTP ${r.status}` });
        return;
      }
      if (j?.mode === 'materialize') {
        setResult({ kind: 'materialize', refreshed: Array.isArray(j?.refreshed) ? j.refreshed : [] });
      } else {
        // 'live' (or any other ok mode) → honest no-op message.
        setResult({
          kind: 'live',
          message: j?.message || 'Live source (DirectQuery / Direct Lake) — nothing to materialize.',
        });
      }
      // Refresh the badges from the persisted state and notify the parent.
      if (j?.lastRefresh && typeof j.lastRefresh === 'object') onRefreshed?.(j.lastRefresh as LastRefreshMap);
      await load();
    } catch (e: any) {
      setResult({ kind: 'error', error: e?.message || String(e) });
    } finally {
      setBusy(null);
    }
  }, [reportId, onRefreshed, load]);

  const copyDelta = useCallback(async (url: string) => {
    try { await navigator.clipboard?.writeText(url); setCopied(url); setTimeout(() => setCopied((c) => (c === url ? null : c)), 1500); }
    catch { /* clipboard blocked — the url is selectable inline, so this is non-fatal */ }
  }, []);

  // ── derive the rows to render (storage modes ∪ already-materialized tables) ──
  const rows: TableRow[] = useMemo(() => {
    const map = new Map<string, TableRow>();
    for (const [name, ts] of Object.entries(tableStorage ?? {})) {
      map.set(name, { name, mode: coerceMode(ts?.mode), group: ts?.group });
    }
    for (const [name, last] of Object.entries(status?.lastRefresh ?? {})) {
      const ex = map.get(name);
      // A table present in lastRefresh was materialized at least once ⇒ it is
      // (or was) an Import/Dual table; default an unseen one to Import.
      if (ex) ex.last = last;
      else map.set(name, { name, mode: 'Import', last });
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [tableStorage, status]);

  const materializable = useMemo(() => rows.filter((r) => isMaterializable(r.mode)), [rows]);
  const liveRows = useMemo(() => rows.filter((r) => !isMaterializable(r.mode)), [rows]);

  const refreshingAll = busy === '';
  const canRefresh = !!reportId && bound !== false && busy === null;

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div className={styles.root}>
      {/* Header + Refresh-now (refresh ALL Import/Dual tables) ───────────────── */}
      <div className={styles.header}>
        <div className={styles.headerRow}>
          <Title3>Data refresh</Title3>
          <div className={styles.spacer} />
          <Button
            appearance="subtle"
            size="small"
            icon={<ArrowSync16Regular />}
            onClick={load}
            disabled={!reportId || loading || busy !== null}
          >
            {loading ? 'Checking…' : 'Refresh status'}
          </Button>
          <Button
            appearance="primary"
            icon={refreshingAll ? <Spinner size="tiny" /> : <ArrowClockwise20Regular />}
            onClick={() => runRefresh()}
            disabled={!canRefresh}
          >
            {refreshingAll ? 'Refreshing…' : 'Refresh now'}
          </Button>
        </div>
        <Caption1 className={styles.muted}>
          Re-materializes every <strong>Import</strong> / <strong>Dual</strong> table as a Synapse Spark batch writing a
          managed Delta cache (read back via serverless OPENROWSET). <strong>DirectQuery</strong> / <strong>Direct Lake</strong>
          {' '}tables are live — nothing to materialize. Azure-native, no Power BI or Fabric workspace.
        </Caption1>
      </div>

      {/* Honest "bind a source first" note ───────────────────────────────────── */}
      {bound === false && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>No data source bound</MessageBarTitle>
            Bind a data source (Get data) first. Once a connection is bound and a table is set to Import or Dual storage,
            Refresh now will materialize its Delta cache here.
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Last POST result — verbatim mode / gate (no-vaporware receipt) ───────── */}
      {result?.kind === 'materialize' && (
        <MessageBar intent="success">
          <MessageBarBody>
            <MessageBarTitle>Refresh submitted</MessageBarTitle>
            {result.refreshed.length === 0
              ? 'No Import / Dual tables to materialize.'
              : `Submitted ${result.refreshed.length} Synapse Spark batch${result.refreshed.length === 1 ? '' : 'es'}.`}
            {result.refreshed.length > 0 && (
              <div className={styles.receiptList}>
                {result.refreshed.map((t) => (
                  <div key={t.table} className={styles.receiptItem}>
                    <Badge appearance="tint" color="brand" size="small">{t.table}</Badge>
                    {t.batchId && <Caption1 className={styles.mono}>batch {t.batchId}</Caption1>}
                    {t.deltaUrl && renderDeltaUrl(t.deltaUrl)}
                  </div>
                ))}
              </div>
            )}
          </MessageBarBody>
        </MessageBar>
      )}
      {result?.kind === 'live' && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Live source — nothing to materialize</MessageBarTitle>
            {result.message}
          </MessageBarBody>
        </MessageBar>
      )}
      {result?.kind === 'gate' && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Refresh needs Azure setup</MessageBarTitle>
            {result.error}{result.missing ? ` (set ${result.missing})` : ''}
          </MessageBarBody>
        </MessageBar>
      )}
      {result?.kind === 'error' && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Refresh failed</MessageBarTitle>
            {result.error}
          </MessageBarBody>
          <MessageBarActions>
            <Button size="small" appearance="transparent" onClick={() => runRefresh()} disabled={!canRefresh}>Retry</Button>
          </MessageBarActions>
        </MessageBar>
      )}

      {loadErr && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load refresh status</MessageBarTitle>
            {loadErr}
          </MessageBarBody>
          <MessageBarActions>
            <Button size="small" appearance="transparent" onClick={load}>Retry</Button>
          </MessageBarActions>
        </MessageBar>
      )}

      {/* Materialized (Import / Dual) tables ─────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <DatabaseArrowDown20Regular />
          <Subtitle2>Materialized tables</Subtitle2>
          {materializable.length > 0 && <Badge appearance="tint" color="informative" size="small">{materializable.length}</Badge>}
        </div>

        {loading && status === null ? (
          <Spinner size="tiny" label="Loading refresh status…" />
        ) : materializable.length === 0 ? (
          <EmptyState
            icon={<Flash20Regular />}
            title="All sources are live"
            body={bound === false
              ? 'Bind a data source, then set a table to Import or Dual storage to cache it as Delta — it will appear here with a last-refreshed badge.'
              : 'Every table is DirectQuery / Direct Lake — queried live, nothing to materialize. Set a table to Import or Dual in Storage mode to cache it as Delta and it will appear here.'}
          />
        ) : (
          <div className={styles.list}>
            {materializable.map((row) => {
              const rel = relativeTime(row.last?.at);
              const inFlight = busy === row.name;
              return (
                <div key={row.name} className={styles.card}>
                  <span className={styles.cardIcon} aria-hidden><DatabaseArrowDown20Regular /></span>
                  <div className={styles.cardBody}>
                    <div className={styles.cardTitleRow}>
                      <Text weight="semibold" className={styles.tableName}>{row.name}</Text>
                      <Badge appearance="tint" color="brand" size="small">{MODE_LABEL[row.mode]}</Badge>
                      {row.group && row.group !== 'primary' && (
                        <Badge appearance="outline" color="informative" size="small">{row.group}</Badge>
                      )}
                    </div>
                    {row.last?.at ? (
                      <div className={styles.receiptRow}>
                        <Tooltip
                          relationship="description"
                          withArrow
                          content={`Last materialized ${absoluteTime(row.last.at)}${row.last.status ? ` · ${row.last.status}` : ''}${row.last.trigger ? ` · ${row.last.trigger}` : ''}`}
                        >
                          <Badge appearance="tint" color="success" size="small" icon={<Clock16Regular />}>
                            {rel ? `Refreshed ${rel}` : 'Refreshed'}
                          </Badge>
                        </Tooltip>
                        {row.last.batchId && <Caption1 className={styles.mono}>batch {row.last.batchId}</Caption1>}
                        {row.last.deltaUrl && renderDeltaUrl(row.last.deltaUrl, copied === row.last.deltaUrl, () => copyDelta(row.last!.deltaUrl!))}
                      </div>
                    ) : (
                      <div className={styles.receiptRow}>
                        <Badge appearance="tint" color="warning" size="small" icon={<Warning16Regular />}>
                          Not yet materialized
                        </Badge>
                        <Caption1 className={styles.muted}>Cache not ready — queried live until you Run Refresh.</Caption1>
                      </div>
                    )}
                  </div>
                  <div className={styles.cardActions}>
                    <Tooltip relationship="label" withArrow content={`Refresh ${row.name}`}>
                      <Button
                        size="small"
                        appearance="secondary"
                        icon={inFlight ? <Spinner size="tiny" /> : <ArrowClockwise20Regular />}
                        onClick={() => runRefresh(row.name)}
                        disabled={!reportId || bound === false || busy !== null}
                        aria-label={`Refresh ${row.name}`}
                      >
                        {inFlight ? 'Refreshing…' : 'Refresh'}
                      </Button>
                    </Tooltip>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Live (DirectQuery / Direct Lake) tables — disclosed, not refreshable ── */}
      {liveRows.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <Flash20Regular />
            <Subtitle2>Live sources</Subtitle2>
            <Badge appearance="tint" color="informative" size="small">{liveRows.length}</Badge>
          </div>
          <Caption1 className={styles.muted}>Queried directly each render — no cache, always current.</Caption1>
          <div className={styles.list}>
            {liveRows.map((row) => (
              <div key={row.name} className={mergeClasses(styles.card, styles.cardLive)}>
                <span className={styles.cardIcon} aria-hidden><Flash20Regular /></span>
                <div className={styles.cardBody}>
                  <div className={styles.cardTitleRow}>
                    <Text weight="semibold" className={styles.tableName}>{row.name}</Text>
                    <Badge appearance="outline" color="informative" size="small">{MODE_LABEL[row.mode]}</Badge>
                  </div>
                  <Caption1 className={styles.muted}>
                    {row.mode === 'DirectLake'
                      ? 'Serverless OPENROWSET over the table’s own Delta — live, no materialization.'
                      : 'Live Synapse / connector SQL — nothing to materialize.'}
                  </Caption1>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <Divider />

      {/* Scheduled refresh — read-only metadata + honest ADF gate ────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <CalendarClock20Regular />
          <Subtitle2>Scheduled refresh</Subtitle2>
          <Badge appearance="tint" color={status?.schedule?.configured ? 'success' : 'subtle'} size="small">
            {status?.schedule?.configured ? 'Configured' : 'Not configured'}
          </Badge>
        </div>
        {status?.schedule?.configured ? (
          <MessageBar intent="success">
            <MessageBarBody>
              <MessageBarTitle>Recurring refresh active</MessageBarTitle>
              {status.schedule.cron
                ? <>Trigger schedule: <Text className={styles.mono}>{status.schedule.cron}</Text></>
                : 'A recurring ADF trigger is materializing the Import/Dual caches on a schedule.'}
            </MessageBarBody>
          </MessageBar>
        ) : (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Scheduling requires an ADF factory + trigger</MessageBarTitle>
              {status?.schedule?.gate?.error
                || 'Recurring refresh runs as an Azure Data Factory schedule trigger. Set LOOM_ADF_FACTORY (the pipeline is built by buildRefreshAdfPipeline; the recurring trigger is the wiring gate).'}
              {status?.schedule?.gate?.missing ? ` (set ${status.schedule.gate.missing})` : ''}
            </MessageBarBody>
          </MessageBar>
        )}
        <Caption1 className={styles.muted}>
          <Info16Regular /> Until a schedule is wired, use <strong>Refresh now</strong> above to materialize on demand.
        </Caption1>
      </div>
    </div>
  );
}

/**
 * Render a Delta url as a selectable, copyable monospace chip. abfss:// urls
 * aren't clickable, so we show the real path (truncated, full value in a native
 * title) plus a Copy button — the no-vaporware receipt: the exact managed Delta
 * the Spark batch wrote. `onCopy`/`copied` are optional (the materialize-receipt
 * banner renders it read-only).
 */
function renderDeltaUrl(url: string, copied?: boolean, onCopy?: () => void): ReactElement {
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
        padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
        borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3,
        maxWidth: '100%', minWidth: 0,
      }}
    >
      <Tooltip relationship="description" withArrow content={url}>
        <Caption1
          title={url}
          style={{
            fontFamily: tokens.fontFamilyMonospace, color: tokens.colorNeutralForeground2,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '28ch',
          }}
        >
          {url}
        </Caption1>
      </Tooltip>
      {onCopy && (
        <Tooltip relationship="label" withArrow content={copied ? 'Copied' : 'Copy Delta URL'}>
          <Button
            size="small"
            appearance="transparent"
            icon={copied ? <Checkmark16Regular /> : <Copy16Regular />}
            onClick={onCopy}
            aria-label="Copy Delta URL"
          />
        </Tooltip>
      )}
    </span>
  );
}

export default RefreshPane;
