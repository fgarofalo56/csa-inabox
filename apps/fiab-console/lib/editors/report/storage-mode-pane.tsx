'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * storage-mode-pane — per-table STORAGE / CONNECTIVITY MODE editor for a Loom
 * report, and the SHARED-CONTRACT source of truth for the `StorageMode` /
 * `ConnectivityMode` TypeScript types (Report Designer · WAVE 2).
 *
 * ── Why this exists (no-fabric-dependency.md, the headline W2 fix) ───────────
 * Power BI lets each model table choose a STORAGE MODE — Import, DirectQuery,
 * Dual, or Direct Lake. Loom maps every one of those 1:1 onto an Azure-native
 * execution, with NO Fabric / Power BI workspace and NO OneLake on the default
 * path:
 *   • DirectQuery → today's live Synapse / connector SQL (byte-identical to the
 *     existing /query path — the default for every table when nothing is set).
 *   • Import      → a MATERIALIZED Delta cache: a Spark batch (the shared
 *     `materialized-lake-view-engine`) writes a managed Delta table that the
 *     report then reads with serverless `OPENROWSET(FORMAT='DELTA')`.
 *   • Dual        → both; the wells→SQL pick uses the cache for aggregations
 *     when it is materialized and falls back to live otherwise.
 *   • DirectLake  → a serverless `OPENROWSET` over the table's OWN Delta in the
 *     lake — no materialization step (only offered when the object is Delta).
 *
 * This pane is where the author makes that choice. It is purely the EDITOR +
 * the type contract; the execution lives in the resolver (`report-model-resolver`)
 * + the cache-vs-live pick (`wells-to-sql`) + the Azure-native refresh route —
 * each of which carries a small string-validated MIRROR of `StorageMode` (a
 * client `'use client'` module can't be imported by those server modules), so
 * this file is the single documented definition the mirrors track. This is the
 * SAME pattern WAVE 1 used to mirror `ReportConnType` across
 * `report-data-source.ts` ↔ `report-model-resolver.ts`.
 *
 * ── What the pane does ──────────────────────────────────────────────────────
 * After a data source is bound (the W1 Get-Data / semantic-model / direct-query
 * / AAS source persisted on `state.dataSource`), it lists the report's model
 * tables (GET `/fields`, the real resolver-introspected schema — never a mock)
 * and renders, per table:
 *   • a constrained StorageMode picker (Dropdown), the choices limited by the
 *     connector's capability (`allowedStorageModes`): SQL-family / ADX /
 *     Databricks → DirectQuery + Import + Dual (+ Direct Lake when Delta);
 *     File / Cosmos / Blob → Import-only (+ Direct Lake when Delta) — exactly
 *     the Power BI convention.  No dead/disabled controls, no JSON.
 *   • a `cache built / live / cache pending` status badge read from
 *     `state.lastRefresh` (served by the refresh route's GET) — an Import/Dual
 *     table with no cache yet shows "Cache pending · Run Refresh to materialize"
 *     (honest, never a blank or a fake "ready").
 *   • the table's source-group label ('primary' for single-source reports) and
 *     the Azure-native mapping caption for the chosen mode.
 * The chosen map persists additively via PUT `/data-source { tableStorage }` —
 * no new persistence model; `state.tableStorage` rides alongside the existing
 * `state.dataSource`.
 *
 * ── Rules compliance ────────────────────────────────────────────────────────
 *  - no-fabric-dependency: every mode maps to an Azure-native backend; nothing
 *    here references api.powerbi.com / onelake / a Fabric workspace. Absent
 *    config ⇒ DirectQuery (live Synapse) — never a Fabric gate.
 *  - no-vaporware: the table list is the real `/fields` schema; the status badge
 *    is the real `state.lastRefresh`; saving hits the real PUT and surfaces the
 *    verbatim backend error / honest gate on failure. No mock arrays, no buttons
 *    without handlers.
 *  - no-freeform-config: the mode picker is a Dropdown constrained to the
 *    allowed set; there is no free text on this surface.
 *  - web3-ui: Fluent v9 + Loom tokens only (no hard-coded px/hex), cards with
 *    elevation, section header + caption, EmptyState for the unbound state,
 *    Spinner for loading.
 *  - back-compat: a report with no `state.tableStorage` shows every table as
 *    DirectQuery in one 'primary' group — identical to today's behaviour.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Caption1, Subtitle2, Text, Title3,
  Field, Dropdown, Option, Divider,
  MessageBar, MessageBarBody, MessageBarTitle, Spinner,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, DocumentTable20Regular, ArrowSync16Regular,
  Checkmark16Regular, DatabaseSearch20Regular, CloudDatabase20Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import {
  type ReportDataSource,
  type ReportConnType,
  isBound,
} from './report-data-source';

/* ============================================================================
 * 1) StorageMode / ConnectivityMode — the W2 SHARED CONTRACT (owned here).
 *    The resolver + wells-to-sql carry string-validated LOCAL mirrors of these,
 *    exactly as W1 mirrors `ReportConnType` across report-data-source.ts ↔ the
 *    resolver (a `'use client'` module can't be imported server-side).
 * ========================================================================== */

/** Power BI storage modes mapped 1:1 to Azure-native execution. */
export type StorageMode =
  | 'DirectQuery'   // live Synapse / connector SQL (TODAY'S DEFAULT — byte-identical)
  | 'Import'        // materialized Delta/Synapse cache (materialized-lake-view-engine)
  | 'Dual'          // both; per-query pick (cache for aggregations, live fallback)
  | 'DirectLake';   // serverless OPENROWSET over the table's own Delta (no materialization)

/** PBI Navigator "connectivity mode" radio per source. */
export type ConnectivityMode = 'import' | 'directQuery';

/** Every `StorageMode`, in picker order (drives `isStorageMode`). */
export const STORAGE_MODES: readonly StorageMode[] = ['DirectQuery', 'Import', 'Dual', 'DirectLake'];

/** True when `v` is one of the recognized `StorageMode` literals. */
export function isStorageMode(v: unknown): v is StorageMode {
  return typeof v === 'string' && (STORAGE_MODES as readonly string[]).includes(v);
}

/** Navigator connectivity → default StorageMode. */
export function storageModeForConnectivity(c: ConnectivityMode): StorageMode {
  return c === 'import' ? 'Import' : 'DirectQuery';
}

/** Per-table storage selection persisted on report `state.tableStorage[table]`. */
export interface TableStorage {
  mode: StorageMode;
  /** Source-group id; default 'primary'. Cross-group = a limited relationship. */
  group?: string;
}
export type TableStorageMap = Record<string, TableStorage>;

/**
 * Allowed modes for a source, constrained by connector capability (the
 * connector-catalog `directQueryCapable` flag): SQL-family / ADX / Databricks →
 * all; File / Cosmos / Blob → Import-only (+ DirectLake when the object is
 * Delta). The pane renders ONLY these, so the picker never offers a mode the
 * backend can't honour.
 */
export function allowedStorageModes(opts: { directQueryCapable: boolean; deltaBacked: boolean }): StorageMode[] {
  const out: StorageMode[] = [];
  if (opts.directQueryCapable) {
    out.push('DirectQuery', 'Import', 'Dual');
  } else {
    out.push('Import');
  }
  if (opts.deltaBacked) out.push('DirectLake');
  return out;
}

/* ============================================================================
 * Helpers — capability derivation + persisted-map parsing (pure, local).
 * ========================================================================== */

/** SQL-family / ADX / Databricks connection types are DirectQuery-capable. */
const DIRECT_QUERY_CONN_TYPES: ReadonlySet<ReportConnType> = new Set<ReportConnType>([
  'azure-sql', 'synapse-dedicated', 'synapse-serverless', 'generic-sql',
  'databricks-sql', 'postgres', 'adx',
]);

/**
 * Derive the connector capability (`directQueryCapable` + `deltaBacked`) from
 * the report's bound data source — the same signal the connector-catalog
 * `directQueryCapable` flag encodes, computed client-side for the picker. In
 * WAVE 2 the whole report binds to one source, so every model table shares this
 * capability (one 'primary' group).
 */
function sourceCapability(ds: ReportDataSource | null | undefined): { directQueryCapable: boolean; deltaBacked: boolean } {
  if (!ds) return { directQueryCapable: true, deltaBacked: false };
  switch (ds.kind) {
    case 'semantic-model':
    case 'aas':
    case 'direct-query':
      // SQL-engine-backed model → live query is always available.
      return { directQueryCapable: true, deltaBacked: false };
    case 'connection': {
      const directQueryCapable = DIRECT_QUERY_CONN_TYPES.has(ds.connType);
      const deltaBacked =
        ds.objectRef?.mode === 'file' && (ds.objectRef.format || '').toLowerCase() === 'delta';
      return { directQueryCapable, deltaBacked };
    }
    case 'file-upload':
      return { directQueryCapable: false, deltaBacked: (ds.format || '').toLowerCase() === 'delta' };
    case 'adls-file':
      return { directQueryCapable: false, deltaBacked: (ds.format || '').toLowerCase() === 'delta' };
    default:
      return { directQueryCapable: true, deltaBacked: false };
  }
}

/**
 * The effective DEFAULT mode the picker shows for a table with no persisted
 * entry. The resolver treats an absent entry as DirectQuery globally, but for an
 * Import-only source (Cosmos / file) DirectQuery isn't an offered option — so
 * the picker defaults those to Import (functionally a live serverless read until
 * a cache is materialized), keeping the dropdown selection always valid.
 */
function defaultMode(cap: { directQueryCapable: boolean }): StorageMode {
  return cap.directQueryCapable ? 'DirectQuery' : 'Import';
}

/** Validate an arbitrary persisted `tableStorage` bag into a `TableStorageMap`. */
function parseTableStorageMap(value: unknown): TableStorageMap {
  if (!value || typeof value !== 'object') return {};
  const out: TableStorageMap = {};
  for (const [table, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (!isStorageMode(r.mode)) continue;
    const group = typeof r.group === 'string' && r.group.trim() ? r.group.trim() : undefined;
    out[table] = { mode: r.mode, ...(group ? { group } : {}) };
  }
  return out;
}

/* ── wire shapes consumed from the routes (local — never import a route file) ── */

/** One table from GET /fields (we only need the name + a column/measure count). */
interface PaneTable { name: string; columnCount: number; measureCount: number }

/** One table's last-materialization record from the refresh route's GET. */
interface LastRefreshEntry { at?: string; batchId?: string; deltaUrl?: string; status?: string }
type LastRefreshMap = Record<string, LastRefreshEntry>;

/* ── mode metadata (labels + Azure-native mapping captions) ──────────────────── */

const MODE_META: Record<StorageMode, { label: string; caption: string }> = {
  DirectQuery: {
    label: 'DirectQuery',
    caption: 'Live Synapse / connector SQL — queried every time. The default; nothing to materialize.',
  },
  Import: {
    label: 'Import',
    caption: 'Materialized Delta cache — a Spark batch writes a managed Delta table, read with serverless OPENROWSET(FORMAT=\'DELTA\').',
  },
  Dual: {
    label: 'Dual',
    caption: 'Both — the cache serves aggregations once materialized; live Synapse is the fallback.',
  },
  DirectLake: {
    label: 'Direct Lake',
    caption: 'Serverless OPENROWSET over the table’s own Delta in the lake — no materialization step.',
  },
};

/** Map a table's mode + last-refresh record to a status badge descriptor. */
function statusBadge(
  mode: StorageMode,
  lr: LastRefreshEntry | undefined,
): { label: string; color: 'success' | 'warning' | 'informative'; hint: string } {
  const needsCache = mode === 'Import' || mode === 'Dual';
  if (!needsCache) {
    return mode === 'DirectLake'
      ? { label: 'Direct Lake', color: 'informative', hint: 'Serverless over Delta — no cache to build.' }
      : { label: 'Live', color: 'informative', hint: 'Live Synapse / connector query.' };
  }
  if (lr && (lr.batchId || lr.deltaUrl || lr.at || lr.status)) {
    if ((lr.status || '').toLowerCase() === 'submitted') {
      return { label: 'Refreshing', color: 'warning', hint: 'Materialization batch submitted to Spark.' };
    }
    const when = lr.at ? ` · ${new Date(lr.at).toLocaleString()}` : '';
    return { label: 'Cache built', color: 'success', hint: `Materialized Delta cache ready${when}.` };
  }
  return { label: 'Cache pending', color: 'warning', hint: 'Run Refresh to materialize this table’s Delta cache.' };
}

// ── styles (Loom tokens only — no hard-coded px) ──────────────────────────────

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0 },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  intro: { color: tokens.colorNeutralForeground3 },
  legend: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  legendRow: { display: 'flex', alignItems: 'baseline', gap: tokens.spacingHorizontalS },
  legendKey: { minWidth: '92px', flexShrink: 0, color: tokens.colorBrandForeground1 },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow',
    transitionDuration: tokens.durationFaster,
    ':hover': { boxShadow: tokens.shadow16 },
  },
  cardTop: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  tableIcon: {
    flexShrink: 0,
    color: tokens.colorBrandForeground1,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: tokens.spacingHorizontalXXL, height: tokens.spacingHorizontalXXL,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  tableName: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  muted: { color: tokens.colorNeutralForeground3 },
  controls: { display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  modeField: { minWidth: '220px' },
  caption: { color: tokens.colorNeutralForeground3 },
  badges: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  saveRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minHeight: tokens.spacingVerticalL },
});

// ── component ─────────────────────────────────────────────────────────────────

export interface StorageModePaneProps {
  /** Report item id (Cosmos id or `loom:<id>`); scopes every route call. */
  reportId: string;
  /**
   * The currently-bound data source, if the host already has it. Drives the
   * connector capability (which modes are offered). When omitted, the pane reads
   * the authoritative source from GET /data-source itself.
   */
  dataSource?: ReportDataSource | null;
  /** Notify the host after the storage map is persisted (e.g. to refresh badges). */
  onChange?: (map: TableStorageMap) => void;
}

/**
 * StorageModePane — lists the report's model tables and lets the author set each
 * table's storage mode, persisting `state.tableStorage` via PUT /data-source.
 */
export function StorageModePane({ reportId, dataSource, onChange }: StorageModePaneProps) {
  const styles = useStyles();

  const [boundSource, setBoundSource] = useState<ReportDataSource | null>(dataSource ?? null);
  const [tables, setTables] = useState<PaneTable[] | null>(null);
  const [map, setMap] = useState<TableStorageMap>({});
  const [lastRefresh, setLastRefresh] = useState<LastRefreshMap>({});

  const [loading, setLoading] = useState(false);
  const [gate, setGate] = useState<string | null>(null);   // honest 412 from /fields
  const [error, setError] = useState<string | null>(null);  // hard failure

  const [savingTable, setSavingTable] = useState<string | null>(null);
  const [savedTable, setSavedTable] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // ── load: authoritative data source + tableStorage, then /fields + last-refresh
  const load = useCallback(async () => {
    setLoading(true); setGate(null); setError(null); setSaveErr(null);
    try {
      // 1. /data-source — the authoritative bound source + persisted tableStorage.
      let ds: ReportDataSource | null = dataSource ?? null;
      try {
        const dsRes = await clientFetch(`/api/items/report/${reportId}/data-source`);
        const dsJson = await dsRes.json().catch(() => ({}));
        if (dsJson && typeof dsJson === 'object') {
          if (!ds && dsJson.dataSource) ds = dsJson.dataSource as ReportDataSource;
          setMap(parseTableStorageMap(dsJson.tableStorage));
        }
      } catch { /* fall back to the prop / unbound gate below */ }
      setBoundSource(ds);

      if (!isBound(ds)) { setTables(null); setLoading(false); return; }

      // 2. /fields — the real resolver-introspected schema (no mock).
      const fRes = await clientFetch(`/api/items/report/${reportId}/fields`);
      const fJson = await fRes.json().catch(() => ({}));
      if (!fJson?.ok) {
        if (fRes.status === 412) setGate(fJson?.error || 'This report has no resolvable model schema yet.');
        else setError(fJson?.error || `Could not read the report schema (HTTP ${fRes.status}).`);
        setTables(null);
      } else {
        const list: PaneTable[] = (fJson.tables || []).map((t: any) => ({
          name: String(t?.name ?? ''),
          columnCount: Array.isArray(t?.columns) ? t.columns.length : 0,
          measureCount: Array.isArray(t?.measures) ? t.measures.length : 0,
        })).filter((t: PaneTable) => t.name);
        setTables(list);
      }

      // 3. refresh GET — last-materialization per table (served by the rewritten
      //    Azure-native refresh route). Defensive: absent / 405 ⇒ no cache yet.
      try {
        const rRes = await clientFetch(`/api/items/report/${reportId}/refresh`);
        if (rRes.ok) {
          const rJson = await rRes.json().catch(() => ({}));
          setLastRefresh(rJson?.ok && rJson.lastRefresh && typeof rJson.lastRefresh === 'object'
            ? (rJson.lastRefresh as LastRefreshMap) : {});
        } else {
          setLastRefresh({});
        }
      } catch { setLastRefresh({}); }
    } catch (e: any) {
      setError(e?.message || String(e));
      setTables(null);
    } finally {
      setLoading(false);
    }
  }, [reportId, dataSource]);

  useEffect(() => { load(); }, [load]);

  // ── connector capability (drives the allowed-mode set for every table) ───────
  const cap = useMemo(() => sourceCapability(boundSource), [boundSource]);
  const allowed = useMemo(() => allowedStorageModes(cap), [cap]);

  // ── per-table mode change → optimistic update + persist via PUT /data-source ──
  const changeMode = useCallback(async (table: string, mode: StorageMode) => {
    const next: TableStorageMap = {
      ...map,
      [table]: { mode, group: map[table]?.group || 'primary' },
    };
    setMap(next);
    setSavingTable(table); setSavedTable(null); setSaveErr(null);
    try {
      const res = await clientFetch(`/api/items/report/${reportId}/data-source`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tableStorage: next }),
      });
      const j = await res.json().catch(() => ({}));
      if (!j?.ok) {
        // Honest: surface the verbatim backend error (e.g. validation / gate).
        setSaveErr(j?.error || `Could not save storage mode (HTTP ${res.status}).`);
      } else {
        setSavedTable(table);
        onChange?.(next);
      }
    } catch (e: any) {
      setSaveErr(e?.message || String(e));
    } finally {
      setSavingTable(null);
    }
  }, [map, reportId, onChange]);

  // ── render ─────────────────────────────────────────────────────────────────
  const header = (
    <div className={styles.header}>
      <CloudDatabase20Regular />
      <Title3>Storage mode</Title3>
      <Badge appearance="tint" color="brand" size="small">Azure-native</Badge>
      <div className={styles.spacer} />
      <Button
        size="small"
        appearance="subtle"
        icon={loading ? <Spinner size="tiny" /> : <ArrowSync16Regular />}
        onClick={load}
        disabled={loading}
      >
        {loading ? 'Loading…' : 'Refresh'}
      </Button>
    </div>
  );

  // Unbound → honest EmptyState (the source must be picked first).
  if (!isBound(boundSource) && !loading) {
    return (
      <div className={styles.root}>
        {header}
        <EmptyState
          icon={<DatabaseSearch20Regular />}
          title="Bind a data source first"
          body="Storage mode is set per model table. Pick a data source for this report (Get data, a semantic model, a direct query, or Analysis Services) — then each table can run live (DirectQuery) or as a materialized Delta cache (Import / Dual / Direct Lake), all Azure-native."
        />
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {header}

      <Caption1 className={styles.intro}>
        Each model table runs live or from a materialized cache — mapped 1:1 to an Azure-native backend.
        No Power BI or Fabric workspace. Unset tables run DirectQuery (live Synapse) in one&nbsp;
        <Text weight="semibold">primary</Text> source group.
      </Caption1>

      {/* Mode legend — the Azure-native mapping, shown once. */}
      <div className={styles.legend}>
        {allowed.map((m) => (
          <div key={m} className={styles.legendRow}>
            <Caption1 className={styles.legendKey} as="span"><Text weight="semibold">{MODE_META[m].label}</Text></Caption1>
            <Caption1 className={styles.muted} as="span">{MODE_META[m].caption}</Caption1>
          </div>
        ))}
      </div>

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Model schema not available yet</MessageBarTitle>
            {gate}
          </MessageBarBody>
        </MessageBar>
      )}
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load the report’s tables</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}
      {saveErr && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Storage mode not saved</MessageBarTitle>
            {saveErr}
          </MessageBarBody>
        </MessageBar>
      )}

      {loading && tables === null && <Spinner size="small" label="Reading the report’s model tables…" />}

      {tables && tables.length === 0 && !gate && !error && (
        <EmptyState
          icon={<DocumentTable20Regular />}
          title="No tables to configure"
          body="The bound data source resolved no model tables. Add tables/columns to the semantic model, or adjust the query/connection, then refresh."
        />
      )}

      {tables && tables.length > 0 && (
        <div className={styles.list}>
          {tables.map((t) => {
            const persisted = map[t.name];
            const effective: StorageMode =
              persisted && allowed.includes(persisted.mode) ? persisted.mode : defaultMode(cap);
            const group = persisted?.group || 'primary';
            const badge = statusBadge(effective, lastRefresh[t.name]);
            const isSaving = savingTable === t.name;
            const isSaved = savedTable === t.name && !isSaving;
            return (
              <div key={t.name} className={styles.card}>
                <div className={styles.cardTop}>
                  <span className={styles.tableIcon} aria-hidden><DocumentTable20Regular /></span>
                  <span className={styles.tableName}>
                    <Subtitle2>{t.name}</Subtitle2>
                    <Caption1 className={styles.muted}>
                      {t.columnCount} column{t.columnCount === 1 ? '' : 's'}
                      {t.measureCount ? ` · ${t.measureCount} measure${t.measureCount === 1 ? '' : 's'}` : ''}
                    </Caption1>
                  </span>
                  <div className={styles.spacer} />
                  <div className={styles.badges}>
                    <Badge appearance="outline" color="subtle" size="small">group · {group}</Badge>
                    <Badge appearance="tint" color={badge.color} size="small">{badge.label}</Badge>
                  </div>
                </div>

                <Divider />

                <div className={styles.controls}>
                  <Field
                    className={styles.modeField}
                    label="Storage mode"
                    hint={badge.hint}
                  >
                    <Dropdown
                      aria-label={`${t.name} storage mode`}
                      value={MODE_META[effective].label}
                      selectedOptions={[effective]}
                      disabled={isSaving}
                      onOptionSelect={(_e, d) => {
                        const m = d.optionValue;
                        if (isStorageMode(m) && m !== effective) changeMode(t.name, m);
                      }}
                    >
                      {allowed.map((m) => (
                        <Option key={m} value={m} text={MODE_META[m].label}>
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <Text weight="semibold">{MODE_META[m].label}</Text>
                            <Caption1 className={styles.muted}>{MODE_META[m].caption}</Caption1>
                          </div>
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>

                  <div className={styles.saveRow}>
                    {isSaving && <Spinner size="tiny" label="Saving…" />}
                    {isSaved && (
                      <>
                        <Checkmark16Regular aria-hidden />
                        <Caption1 className={styles.muted}>Saved</Caption1>
                      </>
                    )}
                  </div>
                </div>

                <Caption1 className={styles.caption}>{MODE_META[effective].caption}</Caption1>
              </div>
            );
          })}
        </div>
      )}

      <Caption1 className={styles.muted}>
        <Database20Regular aria-hidden style={{ verticalAlign: 'middle' }} />{' '}
        Import &amp; Dual tables materialize on demand — run <Text weight="semibold">Refresh</Text> to build (or rebuild)
        the Delta cache. DirectQuery &amp; Direct Lake read live and never need a refresh.
      </Caption1>
    </div>
  );
}

export default StorageModePane;
