'use client';

/**
 * DataSourcePicker — choose the DATA SOURCE that backs a Loom report.
 *
 * Report Designer v2 (no-fabric-dependency.md): a report is no longer wired to
 * Azure Analysis Services only. This drawer lets the author pick a source kind,
 * persisted on the report item's `state.dataSource` as a discriminated union
 * (the parent PUTs the chosen value to `/api/items/report/[id]/data-source`):
 *
 *   (★) Get data       — PRIMARY. Opens the connector gallery (<GetDataGallery/>)
 *       over the 32-connector catalog. The author binds a reusable KV-backed Loom
 *       Connection (Azure SQL / Synapse / Databricks SQL / PostgreSQL / Cosmos /
 *       ADLS), uploads a file, or points at an ADLS path. Yields one of three NEW
 *       union kinds — `connection` | `file-upload` | `adls-file` — that flow
 *       through the SAME resolver→/fields→/query pipeline as the kinds below.
 *   (a) Semantic model  — DEFAULT, Azure-native. A Loom `semantic-model` item
 *       (itself Loom-native SQL over a warehouse/lakehouse, or AAS-bound). The
 *       dropdown is populated from GET /api/items/by-type?types=semantic-model.
 *   (b) Direct query    — a guarded read-only SELECT over the Azure-native
 *       warehouse (Synapse dedicated pool) or lakehouse (serverless over Delta).
 *       On first save the designer scaffolds a real `semantic-model` item from
 *       it; here the "Preview columns" button hits the scaffold route in dry-run
 *       so the author sees the REAL inferred schema before committing.
 *   (c) Advanced — Azure Analysis Services: the existing XMLA binding
 *       (server URI + database). Strictly advanced; AAS stays one source kind.
 *
 * Power BI / Fabric semantic models are NOT a default source kind here — they
 * remain strictly opt-in (surfaced inside the gallery's clearly-labelled opt-in
 * group, never required on the default path) per no-fabric-dependency.md.
 *
 * Rules: no-vaporware (every control hits a real route; unconfigured branches
 * surface the verbatim backend error / honest gate — never a mock schema),
 * no-freeform-config (kind + model + target are pickers; the only free text is
 * the allowed SQL escape hatch, guarded by `readOnlySelect`, and the advanced
 * AAS XMLA URI), web3-ui (Fluent v9 + Loom tokens, cards/elevation, EmptyState,
 * no hard-coded px).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import {
  OverlayDrawer, DrawerHeader, DrawerHeaderTitle, DrawerBody, DrawerFooter,
  Badge, Button, Caption1, Subtitle2, Text,
  RadioGroup, Radio, Field, Dropdown, Option, Input, Textarea, Divider,
  MessageBar, MessageBarBody, MessageBarTitle, Spinner,
  Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  Dismiss20Regular, Database20Regular, DocumentTable20Regular,
  Server20Regular, ArrowSync16Regular, Checkmark16Regular, TableSearch20Regular,
  DatabaseSearch20Regular, DatabasePlugConnected20Regular, CloudArrowUp20Regular,
  TableSettings20Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { readOnlySelect } from '@/lib/thread/sql-guard';
// ── WAVE 4 — Power Query "Transform Data" host ────────────────────────────────
// The report Transform surface is the SAME PowerQueryHost the Dataflow Gen2 editor
// mounts, wrapped by TransformDataDrawer (sibling file): ribbon + formula bar +
// Queries/Applied-Steps panes + View tab, with the structured (column-aware)
// transform dialogs, data-profiling, and View-native-query all wired to the report
// /profile + /native-query routes. Every step is REAL validated M (m-script
// appendStep — no hand-typed M); DirectQuery folds to real SQL, Import materializes
// a Delta cache via the W2 /refresh Synapse-Spark batch. No Fabric / Power BI host.
// The picker mounts it over the bound source and re-persists appliedSteps via its
// own onChange (the same /data-source PUT the source itself persists through).
import { TransformDataDrawer } from './transform-data';
// Get Data connector gallery (Wave 1, sibling file in this chunk). Browses the
// 32-connector catalog and returns a connection/file/ADLS-backed ReportDataSource
// via onChosen — the picker mounts it as an overlay drawer and persists the result.
import { GetDataGallery } from './get-data-gallery';

// ── data-source model (single source of truth) ───────────────────────────────
// The discriminated union + helpers come from the SHARED CONTRACT,
// lib/editors/report/report-data-source.ts — the module this file's header
// designates as the source of truth (the Get Data gallery already imports from
// it). Wave 1's connection-/file-backed kinds (`connection` | `file-upload` |
// `adls-file`), the connType/objectRef types, and the `isBound` / `describeSource`
// helpers all live there and flow through the SAME resolver→/fields→/query
// pipeline. We IMPORT them rather than re-declare a local copy — a duplicate
// silently diverges from the SoT on any future edit (it only compiled before
// because the two declarations happened to be structurally identical).
import {
  type ReportDataSource,
  type ReportDataSourceKind,
  type ConnectionDataSource,
  type FileUploadDataSource,
  type AdlsFileDataSource,
  type DirectQueryTarget,
  isBound,
  describeSource,
  hasTransform,
} from './report-data-source';

// ── WAVE 2 surfaces (sibling files, this chunk) ───────────────────────────────
// Mounted inside this drawer once a source is bound. StorageModePane OWNS the
// shared StorageMode / TableStorageMap contract (per-table storage); NavigatorDialog
// browses a bound connection's real objects (tree + TOP-100 preview) and returns a
// primary ConnectionDataSource + a tableStorage seed; RefreshPane runs the
// Azure-native refresh (re-materialize Import/Dual Delta caches) + last-refreshed
// badges + the honest schedule gate. All persist via the SAME /data-source +
// /refresh routes — no new persistence model, no Power BI / Fabric workspace.
import { StorageModePane, type TableStorageMap } from './storage-mode-pane';
import { NavigatorDialog, type NavigatorResult } from './navigator-dialog';
import { RefreshPane } from './refresh-pane';

/** Local alias so existing call sites keep reading `DirectTarget`
 *  (= the SoT's `DirectQueryTarget`); the target dropdown binds to this. */
type DirectTarget = DirectQueryTarget;

/** The Get Data kinds (connection-/file-backed). */
type GetDataSource = ConnectionDataSource | FileUploadDataSource | AdlsFileDataSource;
const GET_DATA_KINDS: ReadonlySet<ReportDataSourceKind> = new Set(['connection', 'file-upload', 'adls-file']);
function isGetDataKind(k: ReportDataSourceKind): boolean { return GET_DATA_KINDS.has(k); }
function isGetDataSource(ds: ReportDataSource | null | undefined): ds is GetDataSource {
  return !!ds && (ds.kind === 'connection' || ds.kind === 'file-upload' || ds.kind === 'adls-file');
}

/** A semantic-model item as returned by /api/items/by-type. */
interface ModelItem {
  id: string;
  displayName?: string;
  description?: string;
  workspaceId?: string;
}

/** One column from the scaffold dry-run (real inferred schema, never mock). */
interface PreviewColumn { name: string; dataType?: string; summarizeBy?: string }

const TARGETS: { value: DirectTarget; label: string; hint: string }[] = [
  { value: 'warehouse', label: 'Warehouse', hint: 'Synapse dedicated SQL pool' },
  { value: 'lakehouse', label: 'Lakehouse', hint: 'Serverless SQL over Delta' },
];

// ── styles (Loom tokens only — no hard-coded px) ──────────────────────────────

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0 },
  options: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  optionRow: {
    display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalS,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
    transitionProperty: 'box-shadow, border-color',
    transitionDuration: tokens.durationFaster,
    cursor: 'pointer',
    ':hover': { boxShadow: tokens.shadow8 },
  },
  optionRowActive: {
    border: `${tokens.strokeWidthThick} solid ${tokens.colorBrandStroke1}`,
    boxShadow: tokens.shadow16,
    backgroundColor: tokens.colorBrandBackground2,
  },
  // PRIMARY "Get data" entry — a brand-accented card-button above the kind list.
  getDataRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalM,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorBrandBackground2,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow, border-color',
    transitionDuration: tokens.durationFaster,
    cursor: 'pointer',
    width: '100%', textAlign: 'left',
    ':hover': { boxShadow: tokens.shadow16 },
  },
  getDataRowActive: {
    border: `${tokens.strokeWidthThick} solid ${tokens.colorBrandStroke1}`,
    boxShadow: tokens.shadow16,
  },
  optionIcon: {
    flexShrink: 0,
    color: tokens.colorBrandForeground1,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: tokens.spacingHorizontalXXXL, height: tokens.spacingHorizontalXXXL,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  optionText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0, flex: 1 },
  muted: { color: tokens.colorNeutralForeground3 },
  panel: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  sqlArea: { fontFamily: tokens.fontFamilyMonospace },
  previewWrap: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    maxHeight: '40vh', overflow: 'auto',
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    padding: tokens.spacingVerticalS,
  },
  footer: { display: 'flex', gap: tokens.spacingHorizontalS, justifyContent: 'flex-end' },

  // ── WAVE 4 — Transform data entry card ──────────────────────────────────────
  // Card-button (sibling to the bound-source affordances) that opens the Power
  // Query Transform host (TransformDataDrawer) over the bound source. Mirrors the
  // brand-accented card chrome so it reads as the same product (web3-ui).
  transformRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalM,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow, border-color',
    transitionDuration: tokens.durationFaster,
    cursor: 'pointer',
    width: '100%', textAlign: 'left',
    ':hover': { boxShadow: tokens.shadow16 },
  },
});

const KIND_META: { kind: ReportDataSourceKind; label: string; hint: string; icon: ReactElement }[] = [
  { kind: 'semantic-model', label: 'Semantic model', hint: 'Recommended · reusable, governed, Azure-native', icon: <Database20Regular /> },
  { kind: 'direct-query', label: 'Direct query', hint: 'Build a model from a SELECT over a warehouse / lakehouse', icon: <DocumentTable20Regular /> },
  { kind: 'aas', label: 'Advanced · Azure Analysis Services', hint: 'Bind an existing XMLA tabular model', icon: <Server20Regular /> },
];

// ── component ─────────────────────────────────────────────────────────────────

export interface DataSourcePickerProps {
  open: boolean;
  /** Report item id (used only to scope the parent PUT — passed through to onChange). */
  reportId?: string;
  /** Currently-persisted data source, if any (pre-selects the form). */
  value?: ReportDataSource | null;
  /** Parent persists the chosen source (PUT /api/items/report/[id]/data-source). */
  onChange: (ds: ReportDataSource) => void;
  onDismiss: () => void;
  /** True while the parent is persisting — disables Confirm + shows a spinner. */
  saving?: boolean;
}

export function DataSourcePicker({ open, reportId, value, onChange, onDismiss, saving }: DataSourcePickerProps) {
  const styles = useStyles();

  const [kind, setKind] = useState<ReportDataSourceKind>(value?.kind ?? 'semantic-model');

  // (a) semantic-model
  const [models, setModels] = useState<ModelItem[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsErr, setModelsErr] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string>(value?.kind === 'semantic-model' ? value.itemId : '');

  // (b) direct-query
  const [target, setTarget] = useState<DirectTarget>(value?.kind === 'direct-query' ? value.target : 'warehouse');
  const [sql, setSql] = useState<string>(value?.kind === 'direct-query' ? value.sql : '');
  const [previewCols, setPreviewCols] = useState<PreviewColumn[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  // (c) aas
  const [aasServer, setAasServer] = useState<string>(value?.kind === 'aas' ? value.server : '');
  const [aasDatabase, setAasDatabase] = useState<string>(value?.kind === 'aas' ? value.database : '');

  // (d) Get data — connection / file-upload / adls-file (chosen in the gallery)
  const [getData, setGetData] = useState<GetDataSource | null>(isGetDataSource(value) ? value : null);
  const [galleryOpen, setGalleryOpen] = useState(false);

  // (e) WAVE 2 — Navigator dialog + the per-table storage map (mirrored locally so
  // the RefreshPane rows reflect edits immediately; persisted via PUT /data-source).
  const [navigatorOpen, setNavigatorOpen] = useState(false);
  const [tableStorage, setTableStorage] = useState<TableStorageMap>({});

  // (f) WAVE 4 — Transform data host (Power Query) over the bound source.
  const [transformOpen, setTransformOpen] = useState(false);

  // Re-seed the form whenever the drawer (re)opens against a (possibly new) value.
  useEffect(() => {
    if (!open) { setGalleryOpen(false); setNavigatorOpen(false); setTransformOpen(false); return; }
    setKind(value?.kind ?? 'semantic-model');
    setModelId(value?.kind === 'semantic-model' ? value.itemId : '');
    setTarget(value?.kind === 'direct-query' ? value.target : 'warehouse');
    setSql(value?.kind === 'direct-query' ? value.sql : '');
    setAasServer(value?.kind === 'aas' ? value.server : '');
    setAasDatabase(value?.kind === 'aas' ? value.database : '');
    setGetData(isGetDataSource(value) ? value : null);
    setGalleryOpen(false);
    setNavigatorOpen(false);
    setTransformOpen(false);
    setTableStorage({});
    setPreviewCols(null); setPreviewErr(null);
  }, [open, value]);

  // ── load semantic-model items (real route; honest error on failure) ─────────
  const loadModels = useCallback(async () => {
    setModelsLoading(true); setModelsErr(null);
    try {
      const r = await fetch('/api/items/by-type?types=semantic-model');
      const j = await r.json();
      if (!j.ok) { setModels([]); setModelsErr(j.error || `HTTP ${r.status}`); return; }
      const items: ModelItem[] = (j.items || []).map((it: any) => ({
        id: it.id, displayName: it.displayName, description: it.description, workspaceId: it.workspaceId,
      }));
      setModels(items);
      // Keep a valid selection: clear if the persisted id is no longer present.
      if (modelId && !items.some((m) => m.id === modelId)) setModelId('');
    } catch (e: any) { setModels([]); setModelsErr(e?.message || String(e)); }
    finally { setModelsLoading(false); }
  }, [modelId]);

  useEffect(() => { if (open) loadModels(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);

  // ── direct-query: preview the REAL inferred schema (scaffold dry-run) ────────
  const sqlGuard = useMemo(() => readOnlySelect(sql), [sql]);

  const previewColumns = useCallback(async () => {
    const guard = readOnlySelect(sql);
    if (!guard.ok) { setPreviewErr(guard.error); setPreviewCols(null); return; }
    setPreviewLoading(true); setPreviewErr(null); setPreviewCols(null);
    try {
      const r = await fetch('/api/items/semantic-model/scaffold', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun: true, target, sql: guard.sql }),
      });
      const j = await r.json();
      if (!j.ok) {
        // Honest gate: name the exact remediation the route returns (env var /
        // role / login failure), never swallow it into a fake column list.
        const gate = j.gate?.missing ? ` (missing: ${j.gate.missing})` : '';
        setPreviewErr((j.error || `HTTP ${r.status}`) + gate);
        return;
      }
      setPreviewCols((j.columns || []) as PreviewColumn[]);
    } catch (e: any) { setPreviewErr(e?.message || String(e)); }
    finally { setPreviewLoading(false); }
  }, [sql, target]);

  // ── confirm ──────────────────────────────────────────────────────────────────
  const draft: ReportDataSource | null = useMemo(() => {
    if (kind === 'semantic-model') return modelId ? { kind, itemId: modelId } : null;
    if (kind === 'direct-query') return sqlGuard.ok ? { kind, target, sql: sqlGuard.sql } : null;
    if (kind === 'aas') {
      const s = aasServer.trim(); const d = aasDatabase.trim();
      return s && d ? { kind, server: s, database: d } : null;
    }
    // Get data kinds: the gallery already produced a complete source; surface it
    // as the draft only when it is locally bound (honest completeness).
    if (isGetDataKind(kind)) return getData && isBound(getData) ? getData : null;
    return null;
  }, [kind, modelId, sqlGuard, target, aasServer, aasDatabase, getData]);

  const confirm = useCallback(() => { if (draft) onChange(draft); }, [draft, onChange]);

  // ── Get data gallery: the chosen connection/file source persists immediately ──
  // (parent PUTs to /data-source) and re-seeds the picker so the confirm summary
  // reflects it. The gallery owns its own "choose" affordance, so onChosen IS the
  // commit — identical to the existing confirm() contract, just driven by the card.
  const onGalleryChosen = useCallback((ds: ReportDataSource) => {
    if (isGetDataSource(ds)) { setGetData(ds); setKind(ds.kind); }
    setGalleryOpen(false);
    onChange(ds);
  }, [onChange]);

  // ── WAVE 2 — bound-source signals + storage/Navigator wiring ────────────────
  // A source is "bound" for W2 once it is fully specified — the persisted `value`,
  // or the gallery/Navigator choice the parent has just persisted. Storage mode +
  // refresh apply to ANY bound source; the Navigator additionally needs a bound
  // CONNECTION (it browses that connection's live objects). Both memos keep a
  // stable identity across re-renders, so the child panes don't refetch on churn.
  const boundForW2: ReportDataSource | null = useMemo(() => {
    if (isBound(value)) return value;
    if (isBound(getData)) return getData;
    return null;
  }, [value, getData]);
  const w2Visible = boundForW2 !== null;

  const connSource: ConnectionDataSource | null = useMemo(() => {
    if (getData && getData.kind === 'connection') return getData;
    if (value && value.kind === 'connection') return value;
    return null;
  }, [getData, value]);

  // Seed the persisted per-table storage map (drives the RefreshPane rows) once a
  // source is bound + the report is saved. StorageModePane reads this too, but we
  // fetch it here so RefreshPane reflects Import/Dual tables that have NOT been
  // materialized yet (those wouldn't surface from GET /refresh's lastRefresh alone).
  useEffect(() => {
    if (!open || !reportId || !w2Visible) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/items/report/${reportId}/data-source`);
        const j = await r.json().catch(() => ({}));
        if (!cancelled && j && typeof j === 'object' && j.tableStorage && typeof j.tableStorage === 'object') {
          setTableStorage(j.tableStorage as TableStorageMap);
        }
      } catch { /* RefreshPane still derives its rows from its own GET /refresh */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reportId, w2Visible]);

  // Per-table storage persists additively through the SAME PUT /data-source the W1
  // source uses (the route accepts a body carrying only `{ tableStorage }` and
  // merges it alongside `state.dataSource` — no new persistence model).
  const persistTableStorage = useCallback(async (map: TableStorageMap) => {
    if (!reportId) return;
    try {
      await fetch(`/api/items/report/${reportId}/data-source`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tableStorage: map }),
      });
    } catch {
      // Best-effort: StorageModePane re-persists on any per-table edit, and the
      // local mirror keeps the UI honest in the meantime. No silent data loss.
    }
  }, [reportId]);

  // StorageModePane persists each per-table change itself; mirror its map locally
  // so the RefreshPane rows reflect the change without a round-trip.
  const onStorageChange = useCallback((map: TableStorageMap) => {
    setTableStorage(map);
  }, []);

  // Navigator confirm → a complete primary ConnectionDataSource (the first
  // selection) + a one-group tableStorage seed at the chosen connectivity's
  // StorageMode. Persist the source through the existing onChange (parent PUT
  // /data-source) and merge + persist the storage seed so the Import/DirectQuery
  // choice the author made in the Navigator sticks.
  const onNavigatorConfirm = useCallback((result: NavigatorResult) => {
    setNavigatorOpen(false);
    setGetData(result.primarySource);
    setKind('connection');
    onChange(result.primarySource);
    const merged: TableStorageMap = { ...tableStorage, ...(result.tableStorage as TableStorageMap) };
    setTableStorage(merged);
    void persistTableStorage(merged);
  }, [onChange, tableStorage, persistTableStorage]);

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <>
    <OverlayDrawer open={open} onOpenChange={(_e, d) => { if (!d.open) onDismiss(); }} position="end" size="medium">
      <DrawerHeader>
        <DrawerHeaderTitle
          action={<Button appearance="subtle" icon={<Dismiss20Regular />} aria-label="Close data source picker" onClick={onDismiss} />}
        >
          Report data source
        </DrawerHeaderTitle>
      </DrawerHeader>

      <DrawerBody>
        <div className={styles.body}>
          <Caption1 className={styles.muted}>
            Pick what this report reads from. The default is a Loom semantic model over Azure (Synapse / lakehouse) —
            no Power BI or Fabric workspace required.
          </Caption1>

          {/* PRIMARY — Get data: browse the connector catalog and bind a reusable
              Loom Connection / uploaded file / ADLS path (real Azure backend). */}
          <button
            type="button"
            className={mergeClasses(styles.getDataRow, isGetDataKind(kind) && styles.getDataRowActive)}
            onClick={() => setGalleryOpen(true)}
            aria-label="Get data — browse the connector gallery"
          >
            <span className={styles.optionIcon} aria-hidden><DatabaseSearch20Regular /></span>
            <span className={styles.optionText}>
              <Subtitle2>Get data</Subtitle2>
              <Caption1 className={styles.muted}>
                Browse the connector gallery — bind a reusable connection, upload a file, or read an ADLS path.
                Real Azure backend, no Fabric required.
              </Caption1>
            </span>
            <Badge appearance="filled" color="brand" size="small">Connectors</Badge>
          </button>

          <Caption1 className={styles.muted}>Or build from an existing Loom model, a query, or Analysis Services:</Caption1>

          <RadioGroup
            value={isGetDataKind(kind) ? '' : kind}
            onChange={(_e, d) => setKind(d.value as ReportDataSourceKind)}
            aria-label="Data source kind"
          >
            <div className={styles.options}>
              {KIND_META.map((k) => (
                <label
                  key={k.kind}
                  className={mergeClasses(styles.optionRow, kind === k.kind && styles.optionRowActive)}
                  htmlFor={`ds-kind-${k.kind}`}
                >
                  <span className={styles.optionIcon} aria-hidden>{k.icon}</span>
                  <span className={styles.optionText}>
                    <Subtitle2>{k.label}</Subtitle2>
                    <Caption1 className={styles.muted}>{k.hint}</Caption1>
                  </span>
                  <Radio id={`ds-kind-${k.kind}`} value={k.kind} aria-label={k.label} />
                </label>
              ))}
            </div>
          </RadioGroup>

          <Divider />

          {/* (d) Get data — connection / file-upload / adls-file ───────────── */}
          {isGetDataKind(kind) && (
            <div className={styles.panel}>
              <div className={styles.toolbar}>
                <Subtitle2>Get data source</Subtitle2>
                <Badge appearance="tint" color="brand" size="small">Connection-backed</Badge>
                <div className={styles.spacer} />
                {getData?.kind === 'connection' && (
                  <Button size="small" appearance="subtle" icon={<TableSearch20Regular />} onClick={() => setNavigatorOpen(true)}>
                    Browse with Navigator
                  </Button>
                )}
                {getData && isBound(getData) && (
                  <Button size="small" appearance="subtle" icon={<TableSettings20Regular />} onClick={() => setTransformOpen(true)}>
                    Transform data{hasTransform(getData) ? ' ·' : ''}
                  </Button>
                )}
                <Button size="small" appearance="subtle" icon={<DatabaseSearch20Regular />} onClick={() => setGalleryOpen(true)}>
                  Change source
                </Button>
              </div>
              {getData && isBound(getData) ? (
                <MessageBar intent="success">
                  <MessageBarBody>
                    <MessageBarTitle>
                      {getData.kind === 'connection'
                        ? <><DatabasePlugConnected20Regular /> {describeSource(getData)}</>
                        : <><CloudArrowUp20Regular /> {describeSource(getData)}</>}
                    </MessageBarTitle>
                    Reads through the Loom resolver against a real Azure backend — introspect, query, and preview all
                    run server-side. No Power BI / Fabric workspace.
                  </MessageBarBody>
                </MessageBar>
              ) : (
                <EmptyState
                  icon={<DatabaseSearch20Regular />}
                  title="No source chosen yet"
                  body="Browse the connector gallery to bind a reusable connection, upload a file, or point at an ADLS Gen2 path."
                  primaryAction={{ label: 'Open Get data', onClick: () => setGalleryOpen(true) }}
                />
              )}
            </div>
          )}

          {/* (a) Semantic model ───────────────────────────────────────────── */}
          {kind === 'semantic-model' && (
            <div className={styles.panel}>
              <div className={styles.toolbar}>
                <Subtitle2>Semantic model</Subtitle2>
                <Badge appearance="tint" color="brand" size="small">Azure-native default</Badge>
                <div className={styles.spacer} />
                <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={loadModels} disabled={modelsLoading}>
                  {modelsLoading ? 'Loading…' : 'Refresh'}
                </Button>
              </div>

              {modelsErr && (
                <MessageBar intent="error"><MessageBarBody>{modelsErr}</MessageBarBody></MessageBar>
              )}
              {modelsLoading && models === null && <Spinner size="tiny" label="Loading semantic models…" />}

              {models && models.length === 0 && !modelsErr && (
                <EmptyState
                  icon={<Database20Regular />}
                  title="No semantic models yet"
                  body="A report binds to a semantic model (a dataset). Build one from a warehouse/lakehouse table or a SQL query via Weave, or switch to Direct query below to scaffold one inline."
                  primaryAction={{ label: 'Build from a query / table', onClick: () => setKind('direct-query') }}
                />
              )}

              {models && models.length > 0 && (
                <Field label="Model" required hint="Reports can share one governed model. Lineage (Thread) + Purview onboarding fire when the model is created.">
                  <Dropdown
                    placeholder="Choose a semantic model"
                    value={models.find((m) => m.id === modelId)?.displayName || ''}
                    selectedOptions={modelId ? [modelId] : []}
                    onOptionSelect={(_e, d) => setModelId(String(d.optionValue || ''))}
                  >
                    {models.map((m) => (
                      <Option key={m.id} value={m.id} text={m.displayName || m.id}>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <Text weight="semibold">{m.displayName || m.id}</Text>
                          {m.description && <Caption1 className={styles.muted}>{m.description}</Caption1>}
                        </div>
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              )}
            </div>
          )}

          {/* (b) Direct query ─────────────────────────────────────────────── */}
          {kind === 'direct-query' && (
            <div className={styles.panel}>
              <Subtitle2>Direct query</Subtitle2>
              <Caption1 className={styles.muted}>
                On first save the designer mints a real, reusable <strong>semantic-model</strong> item from this SELECT
                (Azure-native scaffold over {target === 'warehouse' ? 'Synapse' : 'serverless SQL'}). No Power BI / Fabric.
              </Caption1>

              <Field label="Source" required>
                <Dropdown
                  value={TARGETS.find((t) => t.value === target)?.label || ''}
                  selectedOptions={[target]}
                  onOptionSelect={(_e, d) => { setTarget(d.optionValue as DirectTarget); setPreviewCols(null); setPreviewErr(null); }}
                >
                  {TARGETS.map((t) => (
                    <Option key={t.value} value={t.value} text={t.label}>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <Text weight="semibold">{t.label}</Text>
                        <Caption1 className={styles.muted}>{t.hint}</Caption1>
                      </div>
                    </Option>
                  ))}
                </Dropdown>
              </Field>

              <Field
                label="SQL query"
                required
                validationState={sql && !sqlGuard.ok ? 'error' : 'none'}
                validationMessage={sql && !sqlGuard.ok ? sqlGuard.error : undefined}
                hint="A single read-only SELECT (the allowed escape hatch). Guarded against writes; wrapped as a derived table — never injected."
              >
                <Textarea
                  className={styles.sqlArea}
                  resize="vertical"
                  placeholder="SELECT category, SUM(amount) AS total FROM dbo.Sales GROUP BY category"
                  value={sql}
                  onChange={(_e, d) => { setSql(d.value); setPreviewCols(null); setPreviewErr(null); }}
                  textarea={{ rows: 7 }}
                  aria-label="SQL query"
                />
              </Field>

              <div className={styles.toolbar}>
                <Button
                  appearance="secondary"
                  icon={<TableSearch20Regular />}
                  onClick={previewColumns}
                  disabled={previewLoading || !sqlGuard.ok}
                >
                  {previewLoading ? 'Previewing…' : 'Preview columns'}
                </Button>
                <Caption1 className={styles.muted}>Runs the scaffold in dry-run to infer the real schema.</Caption1>
              </div>

              {previewErr && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Could not infer the schema</MessageBarTitle>
                    {previewErr}
                  </MessageBarBody>
                </MessageBar>
              )}
              {previewCols && previewCols.length > 0 && (
                <div className={styles.previewWrap}>
                  <Caption1 className={styles.muted}>{previewCols.length} column(s) inferred</Caption1>
                  <Table size="small" aria-label="Inferred columns">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>Column</TableHeaderCell>
                        <TableHeaderCell>Type</TableHeaderCell>
                        <TableHeaderCell>Summarize by</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {previewCols.map((c) => (
                        <TableRow key={c.name}>
                          <TableCell>{c.name}</TableCell>
                          <TableCell>{c.dataType || '—'}</TableCell>
                          <TableCell>{c.summarizeBy || '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {previewCols && previewCols.length === 0 && !previewErr && (
                <Caption1 className={styles.muted}>The query returned no columns.</Caption1>
              )}
            </div>
          )}

          {/* (c) Advanced — Azure Analysis Services ───────────────────────── */}
          {kind === 'aas' && (
            <div className={styles.panel}>
              <Subtitle2>Azure Analysis Services (advanced)</Subtitle2>
              <Caption1 className={styles.muted}>
                Bind an existing XMLA tabular model. Visuals render with DAX (no Power BI workspace).
                The Console UAMI must be a server admin on the AAS instance.
              </Caption1>
              <Field label="XMLA server URI" required hint="e.g. asazure://eastus2.asazure.windows.net/my-server">
                <Input
                  value={aasServer}
                  placeholder="asazure://<region>.asazure.windows.net/<server>"
                  onChange={(_e, d) => setAasServer(d.value)}
                />
              </Field>
              <Field label="Database (model name)" required>
                <Input value={aasDatabase} placeholder="my-tabular-model" onChange={(_e, d) => setAasDatabase(d.value)} />
              </Field>
            </div>
          )}

          {/* ── WAVE 2 — per-table storage modes + Azure-native refresh ──────────
              After a source is bound, surface the per-table StorageModePane (live
              DirectQuery vs a materialized Import/Dual/Direct-Lake Delta cache) and
              the RefreshPane (re-materialize on demand + last-refreshed + the honest
              schedule gate). Both are 100% Azure-native — no Power BI / Fabric
              workspace — and persist through the SAME /data-source + /refresh
              routes. The map persists additively; the existing W1 flow is intact. */}
          {w2Visible && (
            <>
              <Divider />
              {/* ── WAVE 4 — Transform data (Power Query) ───────────────────────
                  A card-button (sibling to the bound-source affordances) that opens
                  the SAME PowerQueryHost the Dataflow Gen2 editor uses, over the
                  bound source. Every ribbon step is real validated M (appendStep);
                  DirectQuery folds to real SQL, Import materializes via the W2
                  /refresh Spark batch. Shows "· transformed" once steps exist. */}
              <button
                type="button"
                className={styles.transformRow}
                onClick={() => setTransformOpen(true)}
                aria-label="Transform data with Power Query"
              >
                <span className={styles.optionIcon} aria-hidden><TableSettings20Regular /></span>
                <span className={styles.optionText}>
                  <Subtitle2>Transform data</Subtitle2>
                  <Caption1 className={styles.muted}>
                    Shape this source with Power Query — split / merge / pivot / group / conditional columns and more.
                    Real M, folded to SQL (DirectQuery) or materialized to Delta (Import). No Power BI / Fabric.
                  </Caption1>
                </span>
                {hasTransform(boundForW2) && (
                  <Badge appearance="filled" color="brand" size="small">Transformed</Badge>
                )}
              </button>
              <Caption1 className={styles.muted}>
                Storage &amp; refresh — set each model table to run live (DirectQuery) or as a materialized Delta cache
                (Import / Dual / Direct Lake), then refresh the caches on demand. All Azure-native; no Power BI or
                Fabric workspace.
              </Caption1>
              {reportId ? (
                <>
                  <StorageModePane reportId={reportId} dataSource={boundForW2} onChange={onStorageChange} />
                  <Divider />
                  <RefreshPane reportId={reportId} tableStorage={tableStorage} bound={isBound(boundForW2)} />
                </>
              ) : (
                <MessageBar intent="info">
                  <MessageBarBody>
                    <MessageBarTitle>Save the report to configure storage &amp; refresh</MessageBarTitle>
                    Storage mode and data refresh are configured per saved report. Save this report once, then reopen
                    this drawer to set each table&apos;s storage mode and materialize its Delta cache.
                  </MessageBarBody>
                </MessageBar>
              )}
            </>
          )}
        </div>
      </DrawerBody>

      <DrawerFooter>
        <div className={styles.footer}>
          <Button appearance="secondary" onClick={onDismiss} disabled={saving}>Cancel</Button>
          <Button
            appearance="primary"
            icon={saving ? <Spinner size="tiny" /> : <Checkmark16Regular />}
            onClick={confirm}
            disabled={!draft || saving}
          >
            {saving ? 'Saving…' : 'Use this source'}
          </Button>
        </div>
      </DrawerFooter>
      </OverlayDrawer>

      {/* Get Data connector gallery — overlay drawer over the 32-connector catalog.
          onChosen returns a connection/file/ADLS-backed ReportDataSource which we
          persist immediately (parent PUT) and reflect in the summary panel above. */}
      <GetDataGallery
        open={galleryOpen}
        reportId={reportId}
        onChosen={onGalleryChosen}
        onDismiss={() => setGalleryOpen(false)}
      />

      {/* Navigator — browse the bound connection's REAL objects (catalog → schema
          → tables/views), preview TOP-100 rows, multi-select + an Import-vs-
          DirectQuery connectivity radio. onConfirm returns a primary
          ConnectionDataSource + a tableStorage seed we persist (source via the
          parent PUT, seed via the additive /data-source PUT). Rendered only for a
          bound CONNECTION — the Navigator introspects one live connection. */}
      {connSource && (
        <NavigatorDialog
          open={navigatorOpen}
          reportId={reportId}
          connectionId={connSource.connectionId}
          connType={connSource.connType}
          connectionLabel={describeSource(connSource)}
          onConfirm={onNavigatorConfirm}
          onDismiss={() => setNavigatorOpen(false)}
        />
      )}

      {/* WAVE 4 — Transform data host. Mounts the canonical TransformDataDrawer (the
          SAME PowerQueryHost the Dataflow Gen2 editor uses) over the currently-bound
          source. onApplied is the picker's OWN onChange (parent PUT
          /api/items/report/[id]/data-source) — the transform (appliedSteps +
          transformMode) rides on the persisted union, re-persisted via the SAME route
          as the source itself. `reportId` falls back to 'new' ⇒ the drawer is
          read-only until the report is saved (honest gate, no silent no-op). Mounted
          only while a source is bound. */}
      {boundForW2 && (
        <TransformDataDrawer
          open={transformOpen}
          reportId={reportId || 'new'}
          dataSource={boundForW2}
          onApplied={onChange}
          onDismiss={() => setTransformOpen(false)}
        />
      )}
    </>
  );
}

export default DataSourcePicker;
