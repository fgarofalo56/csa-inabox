'use client';

/**
 * GetDataGallery — the Power BI "Get data" experience for the Loom report
 * designer (Fluent UI v9 + Loom design tokens).
 *
 * A report no longer binds only to a semantic-model / direct-query / AAS source.
 * "Get data" lets the author BROWSE the same 32-connector catalog the ADF /
 * Synapse "New linked service" gallery uses (`CONNECTORS` in
 * `lib/pipeline/connector-catalog.ts`), then bind a reusable, Key Vault-backed
 * Loom Connection (GET /api/connections), upload a file (POST
 * /api/lakehouse/upload), or point at an existing ADLS Gen2 path. The chosen
 * source is emitted via `onChosen` as one of the three NEW union members in
 * `report-data-source.ts` — `connection` | `file-upload` | `adls-file` — which
 * flow through the SAME resolver → /fields → /query → /connector-preview
 * pipeline as the existing kinds. The parent (`data-source-picker.tsx`)
 * persists it.
 *
 * Reuse map (NO new credential code, NO new catalog, NO new connection store):
 *  - The connector cards + category grouping are driven by `CONNECTORS` and the
 *    `connectorGlyph` / `ICON_BY_*` / `CATEGORY_ORDER` patterns lifted 1:1 from
 *    `linked-service-gallery.tsx`'s `ConnectorGalleryGrid` (Loom tokens, card
 *    elevation `shadow4`→`shadow16` on hover, `EmptyState`, count `Badge`s).
 *  - Binding selects an EXISTING `LoomConnection` (filtered to the connector's
 *    mapped `ConnectionType`) or launches the existing
 *    `<AddExistingConnectionWizard/>` — credentials are already handled there;
 *    this file NEVER writes secret / credential code.
 *  - File upload reuses the existing `POST /api/lakehouse/upload` route; the
 *    gallery just stores the returned path as a `file-upload` source.
 *
 * Rules compliance:
 *  - no-vaporware: every SUPPORTED connector card binds to a REAL connection and
 *    the resulting source runs a real introspection / query / preview through
 *    the resolver against a real Azure backend. UNSUPPORTED / forward-compat
 *    (adx, mysql) / OneLake-Fabric paths render a styled Fluent MessageBar
 *    naming the exact supported types / opt-in env — NO dead cards, NO mock
 *    arrays.
 *  - no-fabric-dependency: Azure-native is the default everywhere. OneLake /
 *    Fabric lakehouse shortcuts + Power BI semantic models live in a SEPARATE,
 *    clearly-labelled OPT-IN group, never required, never on the default path.
 *  - no-freeform-config: the gallery is a card grid; binding is a Dropdown of
 *    existing connections + the add-existing wizard; the object picker is
 *    schema/table inputs, container/format Dropdowns, or the single sql-guard'd
 *    custom-SELECT escape hatch (identical to direct-query). No raw JSON /
 *    connection-string box.
 *  - web3-ui: Fluent v9 + Loom tokens, an icon per connector, cards with
 *    elevation/hover, EmptyState, Certified/Preview Badges, dark-legible —
 *    visually identical to LinkedServiceGallery.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Badge, Spinner, Caption1, Subtitle2, Subtitle1, Text,
  Field, Input, Textarea, Dropdown, Option, SearchBox, Divider,
  MessageBar, MessageBarBody, MessageBarTitle, TabList, Tab,
  Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Dismiss24Regular, ChevronLeft20Regular, ArrowClockwise20Regular,
  PlugConnected20Regular, DatabaseSearch20Regular, CloudArrowUp20Regular,
  TableSearch20Regular, Sparkle20Regular, History20Regular,
  Storage24Regular, Folder24Regular, Database24Regular, Cloud24Regular,
  Globe24Regular, Apps24Regular, Document24Regular, DataTrending24Regular,
  WeatherSnowflake24Regular, DataUsage24Regular, DocumentTable24Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { CONNECTORS, connectorByType, type ConnectorDef } from '@/lib/pipeline/connector-catalog';
import { AddExistingConnectionWizard } from '@/lib/components/connections/add-existing-wizard';
import { EmptyState } from '@/lib/components/empty-state';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { CONN_TYPE_LABEL, CONN_TILE_SLUG } from '@/lib/azure/connectable-types';
import type { ConnectionType, LoomConnectionView } from '@/lib/azure/connections-store';
import { readOnlySelect } from '@/lib/thread/sql-guard';
import {
  type ReportDataSource, type ReportConnType, type ReportObjectRef,
  REPORT_CONN_TYPE_LABEL,
} from './report-data-source';

// ---------------------------------------------------------------------------
// Icon resolution — lifted from linked-service-gallery so the cards look 1:1.
// The catalog carries a best-effort `icon` string; map it to a real 24px glyph,
// falling back to a per-category default so a missing icon still renders.
// ---------------------------------------------------------------------------

type Glyph = React.FC<{ className?: string }>;

const ICON_BY_NAME: Record<string, Glyph> = {
  CloudDatabase: Storage24Regular,
  CloudDatabaseRegular: Storage24Regular,
  StorageRegular: Storage24Regular,
  FolderRegular: Folder24Regular,
  DatabaseRegular: Database24Regular,
  DatabaseLightningRegular: Database24Regular,
  DataWarehouseRegular: DataUsage24Regular,
  DataTrendingRegular: DataTrending24Regular,
  SnowflakeRegular: WeatherSnowflake24Regular,
  CloudRegular: Cloud24Regular,
  GlobeRegular: Globe24Regular,
  AppsRegular: Apps24Regular,
  DocumentRegular: Document24Regular,
};

const ICON_BY_CATEGORY: Record<ConnectorDef['category'], Glyph> = {
  azure: Cloud24Regular,
  database: Database24Regular,
  file: Folder24Regular,
  nosql: DataUsage24Regular,
  'generic-protocol': Globe24Regular,
  'services-and-apps': Apps24Regular,
};

function connectorGlyph(c: ConnectorDef): Glyph {
  if (c.icon && ICON_BY_NAME[c.icon]) return ICON_BY_NAME[c.icon];
  return ICON_BY_CATEGORY[c.category] ?? DocumentTable24Regular;
}

const CATEGORY_ORDER: ConnectorDef['category'][] = [
  'azure', 'database', 'file', 'nosql', 'generic-protocol', 'services-and-apps',
];
const CATEGORY_LABEL: Record<ConnectorDef['category'], string> = {
  azure: 'Azure',
  database: 'Database',
  file: 'File',
  nosql: 'NoSQL',
  'generic-protocol': 'Generic protocol',
  'services-and-apps': 'Services & apps',
};

// ---------------------------------------------------------------------------
// Connector → Loom report ConnType mapping (the shared-notes table). The gallery
// shows ALL connectors for browse parity; binding is enabled only for the
// supported types — every other card renders an honest MessageBar (no dead
// cards). `adx` / `mysql` are forward-compat / honest-gate (no bindable
// LoomConnection / data-plane client in Wave 1).
// ---------------------------------------------------------------------------

const CONNECTOR_TYPE_TO_CONN_TYPE: Record<string, ReportConnType> = {
  AzureSqlDatabase: 'azure-sql',
  AzureSqlMI: 'azure-sql',
  AzureSqlDW: 'synapse-dedicated',
  SqlServer: 'generic-sql',
  AzureDatabricksDeltaLake: 'databricks-sql',
  AzurePostgreSql: 'postgres',
  PostgreSql: 'postgres',
  AzureBlobFS: 'storage-adls',
  AzureBlobStorage: 'storage-adls',
  AzureFileStorage: 'storage-adls',
  CosmosDb: 'cosmos',
  CosmosDbMongoDbApi: 'cosmos',
  AzureDataExplorer: 'adx',
  AzureMySql: 'mysql',
  MySql: 'mysql',
};

/** ConnTypes that bind to a REAL queryable backend through the resolver. */
const SUPPORTED_REPORT_CONN_TYPES: ReadonlySet<ReportConnType> = new Set<ReportConnType>([
  'azure-sql', 'synapse-dedicated', 'synapse-serverless', 'generic-sql',
  'databricks-sql', 'postgres', 'cosmos', 'storage-adls', 'adx',
]);

/** SQL-dialect families that share the schema/table + custom-SELECT object picker. */
const SQL_FAMILY: ReadonlySet<ReportConnType> = new Set<ReportConnType>([
  'azure-sql', 'synapse-dedicated', 'synapse-serverless', 'generic-sql',
  'databricks-sql', 'postgres',
]);

/** The connector's mapped report ConnType (undefined → unsupported as a source). */
function reportConnTypeOf(c: ConnectorDef): ReportConnType | undefined {
  return CONNECTOR_TYPE_TO_CONN_TYPE[c.type];
}

/** Acceptable LoomConnection.type(s) to offer when binding a given ConnType. */
function acceptableConnTypes(rct: ReportConnType): ConnectionType[] {
  switch (rct) {
    case 'azure-sql': return ['azure-sql'];
    case 'synapse-dedicated': return ['synapse-dedicated', 'synapse-serverless'];
    case 'synapse-serverless': return ['synapse-serverless', 'synapse-dedicated'];
    case 'generic-sql': return ['generic-sql'];
    case 'databricks-sql': return ['databricks-sql'];
    case 'postgres': return ['postgres'];
    case 'cosmos': return ['cosmos'];
    case 'storage-adls': return ['storage-adls'];
    case 'adx': return ['adx'];
    default: return [];
  }
}

/** A LoomConnection.type → report ConnType (only the queryable ones). */
function connTypeToReportConnType(t: ConnectionType): ReportConnType | undefined {
  if (SUPPORTED_REPORT_CONN_TYPES.has(t as ReportConnType)) return t as ReportConnType;
  return undefined;
}

/** A representative connector (icon + name) for a report ConnType (for recents). */
function representativeConnector(rct: ReportConnType): ConnectorDef | undefined {
  const byType: Partial<Record<ReportConnType, string>> = {
    'azure-sql': 'AzureSqlDatabase',
    'synapse-dedicated': 'AzureSqlDW',
    'synapse-serverless': 'AzureSqlDW',
    'generic-sql': 'SqlServer',
    'databricks-sql': 'AzureDatabricksDeltaLake',
    'postgres': 'AzurePostgreSql',
    'cosmos': 'CosmosDb',
    'storage-adls': 'AzureBlobFS',
    'adx': 'AzureDataExplorer',
  };
  const t = byType[rct];
  return t ? connectorByType(t) : undefined;
}

/** Tabular file formats serverless OPENROWSET understands. */
const FILE_FORMATS = ['delta', 'parquet', 'csv', 'json'] as const;
/** Loom landing containers (matches adls-client KNOWN_CONTAINERS). */
const ADLS_CONTAINERS = ['bronze', 'silver', 'gold', 'landing', 'csv-imports'] as const;
/** Where uploads stage in the landing container. */
const UPLOAD_CONTAINER = 'landing';

// ---------------------------------------------------------------------------

const useStyles = makeStyles({
  surface: { maxWidth: '1080px', width: '94vw' },
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  titleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  scroll: { maxHeight: '70vh', overflowY: 'auto', paddingRight: tokens.spacingHorizontalXS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  search: { width: '100%', maxWidth: '440px' },

  // category gallery (lifted from linked-service-gallery)
  categoryBlock: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  categoryHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  countBadge: { marginInlineStart: tokens.spacingHorizontalXS },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    gap: tokens.spacingHorizontalM,
    minWidth: 0,
  },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM, textAlign: 'left', alignItems: 'flex-start',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
    cursor: 'pointer', height: '100%', minWidth: 0, width: '100%',
    transitionProperty: 'box-shadow, border-color, transform', transitionDuration: tokens.durationNormal,
    ':hover': { boxShadow: tokens.shadow16, border: `1px solid ${tokens.colorBrandStroke1}` },
  },
  cardHeadRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, width: '100%', minWidth: 0 },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorBrandForeground1, minWidth: 0, flex: 1 },
  cardName: { minWidth: 0, overflowWrap: 'anywhere' },
  cardDesc: {
    color: tokens.colorNeutralForeground3, minWidth: 0, overflowWrap: 'anywhere',
    display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
  },
  cardIcon: { fontSize: '24px', flexShrink: 0 },

  // recent connections
  recentGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
  recentCard: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalS, paddingInline: tokens.spacingHorizontalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow2,
    cursor: 'pointer', textAlign: 'left', width: '100%', minWidth: 0,
    transitionProperty: 'box-shadow, border-color', transitionDuration: tokens.durationFaster,
    ':hover': { boxShadow: tokens.shadow8, border: `1px solid ${tokens.colorBrandStroke1}` },
  },
  recentIcon: { fontSize: '20px', flexShrink: 0, display: 'inline-flex' },
  recentText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  recentName: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },

  // opt-in (Fabric / Power BI) group — clearly demarcated
  optInBlock: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0,
    padding: tokens.spacingVerticalM,
    border: `1px dashed ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2,
  },

  // bind step
  bindHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0, maxWidth: '620px' },
  connRow: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalS, minWidth: 0, flexWrap: 'wrap' },
  connGrow: { flex: 1, minWidth: '240px' },
  sqlArea: { fontFamily: tokens.fontFamilyMonospace },
  inlineFields: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  inlineField: { flex: 1, minWidth: '180px' },
  actions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  muted: { color: tokens.colorNeutralForeground3 },
  previewWrap: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    maxHeight: '36vh', overflow: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2, padding: tokens.spacingVerticalS,
  },
  hiddenInput: { display: 'none' },
});

// ===========================================================================
// Connector gallery (browse + search + recents + opt-in group).
// ===========================================================================

interface GalleryPick {
  /** A connector card was chosen. */
  def: ConnectorDef;
}
interface RecentPick {
  /** A recent connection was chosen — bind that connection directly. */
  connType: ReportConnType;
  def: ConnectorDef;
  connectionId: string;
}

function ConnectorGallery({
  connections, connsLoading, connsErr, onReloadConns, onOpenWizard,
  onPickConnector, onPickRecent,
}: {
  connections: LoomConnectionView[] | null;
  connsLoading: boolean;
  connsErr: string | null;
  onReloadConns: () => void;
  onOpenWizard: () => void;
  onPickConnector: (def: ConnectorDef) => void;
  onPickRecent: (pick: RecentPick) => void;
}) {
  const s = useStyles();
  const [q, setQ] = useState('');
  const [optInNote, setOptInNote] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return CONNECTORS;
    return CONNECTORS.filter((c) =>
      c.name.toLowerCase().includes(needle)
      || c.type.toLowerCase().includes(needle)
      || (c.description || '').toLowerCase().includes(needle));
  }, [q]);

  const byCategory = useMemo(() => {
    const map = new Map<ConnectorDef['category'], ConnectorDef[]>();
    for (const c of filtered) {
      const list = map.get(c.category) || [];
      list.push(c);
      map.set(c.category, list);
    }
    return map;
  }, [filtered]);

  // Recent: queryable connections, most-recently-updated first, top 6.
  const recents = useMemo(() => {
    if (!connections) return [];
    return [...connections]
      .filter((c) => !!connTypeToReportConnType(c.type))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
      .slice(0, 6);
  }, [connections]);

  return (
    <div className={s.root}>
      <SearchBox
        className={s.search}
        placeholder="Search connectors (name, type, description)…"
        value={q}
        onChange={(_, d) => setQ(d.value)}
        aria-label="Search connectors"
      />

      <div className={s.scroll}>
        {/* Recent connections — jump straight to binding one you already have. */}
        {!q && recents.length > 0 && (
          <div className={s.categoryBlock}>
            <div className={s.categoryHead}>
              <History20Regular />
              <Subtitle2>Recent connections</Subtitle2>
              <Badge className={s.countBadge} appearance="tint" color="informative">{recents.length}</Badge>
            </div>
            <div className={s.recentGrid}>
              {recents.map((c) => {
                const rct = connTypeToReportConnType(c.type)!;
                const def = representativeConnector(rct);
                const visual = itemVisual(CONN_TILE_SLUG[c.type] || c.type);
                const Icon = visual.icon;
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={s.recentCard}
                    onClick={() => def && onPickRecent({ connType: rct, def, connectionId: c.id })}
                    aria-label={`Use connection ${c.name}`}
                  >
                    <span className={s.recentIcon} style={{ color: visual.color }}><Icon /></span>
                    <span className={s.recentText}>
                      <Text weight="semibold" className={s.recentName} title={c.name}>{c.name}</Text>
                      <Caption1 className={s.muted}>{CONN_TYPE_LABEL[c.type] || c.type}</Caption1>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {connsErr && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Could not list your connections</MessageBarTitle>
              {connsErr} — you can still pick a connector below and add one.
            </MessageBarBody>
          </MessageBar>
        )}

        {/* Connector catalog — every connector renders (browse parity). */}
        {filtered.length === 0 ? (
          <EmptyState
            icon={<DatabaseSearch20Regular />}
            title={`No connectors match “${q}”`}
            body="Try a different term — e.g. “sql”, “blob”, “cosmos”, “databricks”, or a connector type."
          />
        ) : (
          CATEGORY_ORDER.filter((cat) => byCategory.has(cat)).map((cat) => {
            const list = byCategory.get(cat) || [];
            return (
              <div key={cat} className={s.categoryBlock}>
                <div className={s.categoryHead}>
                  <Subtitle2>{CATEGORY_LABEL[cat]}</Subtitle2>
                  <Badge className={s.countBadge} appearance="tint" color="informative">{list.length}</Badge>
                </div>
                <div className={s.grid}>
                  {list.map((c) => {
                    const G = connectorGlyph(c);
                    const rct = reportConnTypeOf(c);
                    const supported = !!rct && SUPPORTED_REPORT_CONN_TYPES.has(rct);
                    const forwardCompat = !!rct && !supported; // adx / mysql
                    return (
                      <button
                        key={c.type}
                        type="button"
                        className={s.card}
                        onClick={() => onPickConnector(c)}
                        aria-label={`Get data from ${c.name}`}
                      >
                        <span className={s.cardHeadRow}>
                          <span className={s.cardHead}>
                            <G className={s.cardIcon} />
                            <Text weight="semibold" className={s.cardName}>{c.name}</Text>
                          </span>
                          {supported && <Badge appearance="tint" color="success" size="small">Certified</Badge>}
                          {forwardCompat && <Badge appearance="tint" color="warning" size="small">Preview</Badge>}
                        </span>
                        <Caption1 className={s.cardDesc}>{c.description}</Caption1>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}

        {/* OPT-IN ONLY — OneLake / Fabric & Power BI. Never required, never on
            the default path (no-fabric-dependency). Clearly demarcated; clicking
            surfaces an honest opt-in note rather than binding a Fabric backend. */}
        {!q && (
          <div className={s.optInBlock}>
            <div className={s.categoryHead}>
              <Sparkle20Regular />
              <Subtitle2>OneLake / Fabric &amp; Power BI (optional)</Subtitle2>
              <Badge appearance="outline" color="subtle" size="small">Opt-in</Badge>
            </div>
            <Caption1 className={s.muted}>
              Loom reports work 100% on Azure-native sources above — no Fabric or Power BI workspace required.
              These sources are available only when a Fabric / Power BI backend is explicitly bound.
            </Caption1>
            <div className={s.recentGrid}>
              {[
                { key: 'onelake', name: 'OneLake lakehouse shortcut', icon: Storage24Regular,
                  note: 'OneLake shortcuts are opt-in. Bind a Fabric backend (set LOOM_LAKEHOUSE_BACKEND=fabric and a workspace) to read a OneLake shortcut. The Azure-native default is ADLS Gen2 / Delta via the connectors above — no Fabric needed.' },
                { key: 'powerbi', name: 'Power BI semantic model', icon: DataTrending24Regular,
                  note: 'Power BI semantic models are opt-in. Bind a Power BI workspace (the report semantic-model / AAS path) to use one. The Azure-native default is a Loom semantic model over Synapse / lakehouse — no Power BI workspace needed.' },
              ].map((o) => {
                const Icon = o.icon;
                return (
                  <button
                    key={o.key}
                    type="button"
                    className={s.recentCard}
                    onClick={() => setOptInNote(o.note)}
                    aria-label={o.name}
                  >
                    <span className={s.recentIcon} style={{ color: tokens.colorNeutralForeground3 }}><Icon /></span>
                    <span className={s.recentText}>
                      <Text weight="semibold" className={s.recentName}>{o.name}</Text>
                      <Caption1 className={s.muted}>Optional · requires a bound Fabric / Power BI backend</Caption1>
                    </span>
                  </button>
                );
              })}
            </div>
            {optInNote && (
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>Opt-in source</MessageBarTitle>
                  {optInNote}
                </MessageBarBody>
              </MessageBar>
            )}
          </div>
        )}
      </div>

      <div className={s.actions}>
        <Button appearance="secondary" icon={<Add20Regular />} onClick={onOpenWizard}>
          Add existing connection
        </Button>
        <Button appearance="subtle" icon={<ArrowClockwise20Regular />} disabled={connsLoading} onClick={onReloadConns}>
          {connsLoading ? 'Refreshing…' : 'Refresh connections'}
        </Button>
      </div>
    </div>
  );
}

// ===========================================================================
// Bind step — pick the connection + the object inside it, emit the source.
// ===========================================================================

type StorageMode = 'adls' | 'upload' | 'connection';
type SqlMode = 'table' | 'query';

function BindStep({
  connType, def, connections, connsLoading, reportId,
  preselectConnectionId, onReloadConns, onOpenWizard, onBack, onChosen,
}: {
  /** Mapped report ConnType, or undefined when the connector is not a source. */
  connType?: ReportConnType;
  def: ConnectorDef;
  connections: LoomConnectionView[] | null;
  connsLoading: boolean;
  reportId?: string;
  preselectConnectionId?: string;
  onReloadConns: () => void;
  onOpenWizard: () => void;
  onBack: () => void;
  onChosen: (ds: ReportDataSource) => void;
}) {
  const s = useStyles();
  const G = connectorGlyph(def);

  const supported = !!connType && SUPPORTED_REPORT_CONN_TYPES.has(connType);
  const isSql = !!connType && SQL_FAMILY.has(connType);
  const isCosmos = connType === 'cosmos';
  const isStorage = connType === 'storage-adls';
  const isAdx = connType === 'adx';

  // Eligible existing connections for this connType.
  const eligible = useMemo(() => {
    if (!connections || !connType) return [];
    const accept = new Set(acceptableConnTypes(connType));
    return connections.filter((c) => accept.has(c.type));
  }, [connections, connType]);

  const [connectionId, setConnectionId] = useState(preselectConnectionId || '');

  // SQL-family object picker.
  const [sqlMode, setSqlMode] = useState<SqlMode>('table');
  const [schema, setSchema] = useState('');
  const [table, setTable] = useState('');
  const [sql, setSql] = useState('');

  // Cosmos object picker.
  const [collection, setCollection] = useState('');

  // Azure Data Explorer (Kusto) object picker — a table OR an advanced raw KQL query.
  const [adxMode, setAdxMode] = useState<'table' | 'kql'>('table');
  const [adxTable, setAdxTable] = useState('');
  const [adxKql, setAdxKql] = useState('');

  // Storage object picker.
  const [storageMode, setStorageMode] = useState<StorageMode>('adls');
  const [container, setContainer] = useState<string>('bronze');
  const [filePath, setFilePath] = useState('');
  const [format, setFormat] = useState<string>('delta');
  const [uploaded, setUploaded] = useState<{ fileName: string; containerPath: string; format: string } | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Optional live preview (only when a reportId is in scope).
  const [preview, setPreview] = useState<{ columns: string[]; rows: Record<string, unknown>[]; truncated: boolean } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  // Keep the selection valid if the eligible list changes (e.g. after import).
  useEffect(() => {
    if (connectionId && !eligible.some((c) => c.id === connectionId)) setConnectionId('');
  }, [eligible, connectionId]);

  const selectedConn = eligible.find((c) => c.id === connectionId);
  const sqlGuard = useMemo(() => readOnlySelect(sql), [sql]);

  // Build the source from the current picker state (null until complete).
  const draft: ReportDataSource | null = useMemo(() => {
    if (!connType || !supported) return null;

    if (isStorage) {
      if (storageMode === 'adls') {
        return container && filePath.trim() && format
          ? { kind: 'adls-file', container, path: filePath.trim(), format }
          : null;
      }
      if (storageMode === 'upload') {
        return uploaded && uploaded.containerPath && uploaded.format
          ? { kind: 'file-upload', fileName: uploaded.fileName, format: uploaded.format, containerPath: uploaded.containerPath }
          : null;
      }
      // via storage connection → connection source, file object ref
      if (storageMode === 'connection') {
        return connectionId && filePath.trim() && format
          ? { kind: 'connection', connectionId, connType, objectRef: { mode: 'file', containerPath: filePath.trim(), format } }
          : null;
      }
      return null;
    }

    if (isCosmos) {
      return connectionId && collection.trim()
        ? { kind: 'connection', connectionId, connType, objectRef: { mode: 'table', table: collection.trim() } }
        : null;
    }

    if (isSql) {
      if (!connectionId) return null;
      if (sqlMode === 'query') {
        return sqlGuard.ok
          ? { kind: 'connection', connectionId, connType, objectRef: { mode: 'query', sql: sqlGuard.sql } }
          : null;
      }
      const ref: ReportObjectRef = schema.trim()
        ? { mode: 'table', schema: schema.trim(), table: table.trim() }
        : { mode: 'table', table: table.trim() };
      return table.trim()
        ? { kind: 'connection', connectionId, connType, objectRef: ref }
        : null;
    }

    if (isAdx) {
      if (!connectionId) return null;
      if (adxMode === 'kql') {
        return adxKql.trim()
          ? { kind: 'connection', connectionId, connType, objectRef: { mode: 'kql', kql: adxKql.trim() } }
          : null;
      }
      return adxTable.trim()
        ? { kind: 'connection', connectionId, connType, objectRef: { mode: 'table', table: adxTable.trim() } }
        : null;
    }

    return null;
  }, [
    supported, isStorage, isCosmos, isSql, isAdx, storageMode, container, filePath, format,
    uploaded, connectionId, connType, collection, sqlMode, sqlGuard, schema, table,
    adxMode, adxTable, adxKql,
  ]);

  const upload = useCallback(async (file: File) => {
    setUploadBusy(true); setUploadErr(null); setUploaded(null); setPreview(null);
    try {
      const form = new FormData();
      form.append('container', UPLOAD_CONTAINER);
      form.append('path', `report-uploads/${reportId || 'adhoc'}/${file.name}`);
      form.append('file', file);
      const r = await clientFetch('/api/lakehouse/upload', { method: 'POST', credentials: 'include', body: form });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) { setUploadErr(j?.error || `HTTP ${r.status}`); return; }
      const fmt = String(j?.sparkFormat?.format || '').toLowerCase();
      setUploaded({
        fileName: String(j.filename || file.name),
        containerPath: String(j.abfssPath || `${j.container}/${j.path}`),
        // OPENROWSET reads delta/parquet/csv/json; map unknown spark formats to parquet-ish default.
        format: FILE_FORMATS.includes(fmt as (typeof FILE_FORMATS)[number]) ? fmt : (fmt || 'parquet'),
      });
    } catch (e: any) {
      setUploadErr(e?.message || String(e));
    } finally {
      setUploadBusy(false);
    }
  }, [reportId]);

  const runPreview = useCallback(async () => {
    if (!reportId || !draft) return;
    setPreviewBusy(true); setPreviewErr(null); setPreview(null);
    try {
      const r = await clientFetch(
        `/api/items/report/${encodeURIComponent(reportId)}/connector-preview`,
        {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: draft, limit: 50 }),
        },
        30000,
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) {
        const miss = j?.missing ? ` (set ${j.missing})` : '';
        setPreviewErr((j?.error || `HTTP ${r.status}`) + miss);
        return;
      }
      setPreview({ columns: j.columns || [], rows: j.rows || [], truncated: !!j.truncated });
    } catch (e: any) {
      setPreviewErr(e?.message || String(e));
    } finally {
      setPreviewBusy(false);
    }
  }, [reportId, draft]);

  // ── honest gates for non-bindable connectors ───────────────────────────────
  function gateMessage(): { title: string; body: string } {
    if (connType === 'mysql') {
      return {
        title: 'MySQL is not yet a Loom report source',
        body: 'There is no MySQL data-plane client in Wave 1. Available report sources: Azure SQL, Synapse, Databricks SQL, PostgreSQL, Cosmos DB, and ADLS / Blob files. Mirror MySQL into the lake (Bronze Delta) and report off that.',
      };
    }
    return {
      title: `${def.name} is not yet a Loom report source`,
      body: 'Available report sources: Azure SQL, Synapse, Databricks SQL, PostgreSQL, Cosmos DB, and ADLS / Blob files. Land this data in the lake (e.g. via a Copy / mirror) and report off ADLS or a SQL connection.',
    };
  }

  const needsConnection = isSql || isCosmos || isAdx || (isStorage && storageMode === 'connection');
  const connLabel = connType ? (REPORT_CONN_TYPE_LABEL[connType] || def.name) : def.name;

  return (
    <div className={s.root}>
      <div className={s.bindHead}>
        <Button appearance="subtle" icon={<ChevronLeft20Regular />} onClick={onBack}>Back</Button>
        <G className={s.cardIcon} />
        <Subtitle2>Get data · {def.name}</Subtitle2>
      </div>
      <Caption1 className={s.muted}>{def.description}</Caption1>

      {!supported ? (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>{gateMessage().title}</MessageBarTitle>
            {gateMessage().body}
          </MessageBarBody>
        </MessageBar>
      ) : (
        <div className={s.form}>
          {/* Connection picker (SQL / Cosmos / storage-via-connection) ──────── */}
          {needsConnection && (
            <>
              <div className={s.connRow}>
                <Field label={`${connLabel} connection`} required className={s.connGrow}
                  hint="A reusable, Key Vault-backed Loom Connection. Credentials are entered once in the wizard — never here.">
                  <Dropdown
                    placeholder={connsLoading ? 'Loading connections…' : eligible.length ? 'Select a connection' : 'No matching connections'}
                    disabled={connsLoading || eligible.length === 0}
                    value={selectedConn?.name || ''}
                    selectedOptions={connectionId ? [connectionId] : []}
                    onOptionSelect={(_, d) => { setConnectionId(String(d.optionValue || '')); setPreview(null); }}
                  >
                    {eligible.map((c) => (
                      <Option key={c.id} value={c.id} text={c.name}>
                        {c.name}{c.host ? ` · ${c.host}` : ''}{c.database ? ` · ${c.database}` : ''}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <Button appearance="secondary" icon={<Add20Regular />} onClick={onOpenWizard}>Add existing</Button>
              </div>
              {!connsLoading && eligible.length === 0 && (
                <MessageBar intent="info">
                  <MessageBarBody>
                    <MessageBarTitle>No {connLabel} connections yet</MessageBarTitle>
                    Use “Add existing” to import an Azure resource you can already reach (your RBAC), or refresh after creating one.
                  </MessageBarBody>
                </MessageBar>
              )}
            </>
          )}

          {/* SQL-family object picker ──────────────────────────────────────── */}
          {isSql && (
            <>
              <TabList selectedValue={sqlMode} onTabSelect={(_, d) => { setSqlMode(d.value as SqlMode); setPreview(null); }}>
                <Tab value="table" icon={<TableSearch20Regular />}>Table / view</Tab>
                <Tab value="query" icon={<DatabaseSearch20Regular />}>Custom query</Tab>
              </TabList>
              {sqlMode === 'table' ? (
                <div className={s.inlineFields}>
                  <Field label="Schema" className={s.inlineField} hint="Optional (e.g. dbo / SalesLT).">
                    <Input value={schema} placeholder="dbo" onChange={(_, d) => { setSchema(d.value); setPreview(null); }} />
                  </Field>
                  <Field label="Table / view" required className={s.inlineField}>
                    <Input value={table} placeholder="Customer" onChange={(_, d) => { setTable(d.value); setPreview(null); }} />
                  </Field>
                </div>
              ) : (
                <Field
                  label="SQL query" required
                  validationState={sql && !sqlGuard.ok ? 'error' : 'none'}
                  validationMessage={sql && !sqlGuard.ok ? sqlGuard.error : undefined}
                  hint="A single read-only SELECT (the allowed escape hatch). Guarded against writes; wrapped as a derived table server-side."
                >
                  <Textarea
                    className={s.sqlArea}
                    resize="vertical"
                    placeholder="SELECT category, SUM(amount) AS total FROM dbo.Sales GROUP BY category"
                    value={sql}
                    onChange={(_, d) => { setSql(d.value); setPreview(null); }}
                    textarea={{ rows: 6 }}
                    aria-label="SQL query"
                  />
                </Field>
              )}
            </>
          )}

          {/* Cosmos object picker ──────────────────────────────────────────── */}
          {isCosmos && (
            <Field label="Container (collection)" required
              hint="The database comes from the connection; pick the container to read. Visuals compile to Cosmos SQL with GROUP BY.">
              <Input value={collection} placeholder="orders" onChange={(_, d) => { setCollection(d.value); setPreview(null); }} />
            </Field>
          )}

          {/* Azure Data Explorer (Kusto) object picker ──────────────────────── */}
          {isAdx && (
            <>
              <TabList selectedValue={adxMode} onTabSelect={(_, d) => { setAdxMode(d.value as 'table' | 'kql'); setPreview(null); }}>
                <Tab value="table" icon={<TableSearch20Regular />}>Table</Tab>
                <Tab value="kql" icon={<DatabaseSearch20Regular />}>KQL query</Tab>
              </TabList>
              {adxMode === 'table' ? (
                <Field label="Kusto table" required
                  hint="The database comes from the connection; pick the table to read. Field wells compile to a real KQL pipeline (summarize / where / top).">
                  <Input value={adxTable} placeholder="StormEvents" onChange={(_, d) => { setAdxTable(d.value); setPreview(null); }} />
                </Field>
              ) : (
                <Field
                  label="KQL query" required
                  hint="An advanced raw KQL query, run verbatim against the cluster (you own the shaping — summarize, render, etc.)."
                >
                  <Textarea
                    className={s.sqlArea}
                    resize="vertical"
                    placeholder={'StormEvents\n| summarize Count = count() by State\n| top 10 by Count desc'}
                    value={adxKql}
                    onChange={(_, d) => { setAdxKql(d.value); setPreview(null); }}
                    textarea={{ rows: 6 }}
                    aria-label="KQL query"
                  />
                </Field>
              )}
            </>
          )}

          {/* Storage / file object picker ───────────────────────────────────── */}
          {isStorage && (
            <>
              <TabList selectedValue={storageMode} onTabSelect={(_, d) => { setStorageMode(d.value as StorageMode); setPreview(null); }}>
                <Tab value="adls" icon={<Folder24Regular />}>ADLS path</Tab>
                <Tab value="upload" icon={<CloudArrowUp20Regular />}>Upload a file</Tab>
                <Tab value="connection" icon={<PlugConnected20Regular />}>Via connection</Tab>
              </TabList>

              {storageMode === 'adls' && (
                <div className={s.inlineFields}>
                  <Field label="Container" required className={s.inlineField}>
                    <Dropdown value={container} selectedOptions={[container]}
                      onOptionSelect={(_, d) => { setContainer(String(d.optionValue || 'bronze')); setPreview(null); }}>
                      {ADLS_CONTAINERS.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Path" required className={s.inlineField} hint="Folder (Delta) or file within the container.">
                    <Input value={filePath} placeholder="sales/orders" onChange={(_, d) => { setFilePath(d.value); setPreview(null); }} />
                  </Field>
                  <Field label="Format" required className={s.inlineField}>
                    <Dropdown value={format} selectedOptions={[format]}
                      onOptionSelect={(_, d) => { setFormat(String(d.optionValue || 'delta')); setPreview(null); }}>
                      {FILE_FORMATS.map((f) => <Option key={f} value={f} text={f}>{f}</Option>)}
                    </Dropdown>
                  </Field>
                </div>
              )}

              {storageMode === 'upload' && (
                <div className={s.form}>
                  <input
                    ref={fileInputRef}
                    type="file"
                    className={s.hiddenInput}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }}
                  />
                  <div className={s.actions}>
                    <Button appearance="secondary" icon={uploadBusy ? <Spinner size="tiny" /> : <CloudArrowUp20Regular />}
                      disabled={uploadBusy} onClick={() => fileInputRef.current?.click()}>
                      {uploadBusy ? 'Uploading…' : uploaded ? 'Replace file' : 'Choose a file'}
                    </Button>
                    <Caption1 className={s.muted}>Staged to the landing container; read via serverless OPENROWSET.</Caption1>
                  </div>
                  {uploadErr && <MessageBar intent="error"><MessageBarBody>{uploadErr}</MessageBarBody></MessageBar>}
                  {uploaded && (
                    <MessageBar intent="success">
                      <MessageBarBody>
                        <MessageBarTitle>{uploaded.fileName}</MessageBarTitle>
                        {uploaded.format.toUpperCase()} · {uploaded.containerPath}
                      </MessageBarBody>
                    </MessageBar>
                  )}
                </div>
              )}

              {storageMode === 'connection' && (
                <div className={s.inlineFields}>
                  <Field label="Path within the storage account" required className={s.inlineField}
                    hint="Container/path or abfss URL to the Delta folder / file.">
                    <Input value={filePath} placeholder="bronze/sales/orders" onChange={(_, d) => { setFilePath(d.value); setPreview(null); }} />
                  </Field>
                  <Field label="Format" required className={s.inlineField}>
                    <Dropdown value={format} selectedOptions={[format]}
                      onOptionSelect={(_, d) => { setFormat(String(d.optionValue || 'delta')); setPreview(null); }}>
                      {FILE_FORMATS.map((f) => <Option key={f} value={f} text={f}>{f}</Option>)}
                    </Dropdown>
                  </Field>
                </div>
              )}
            </>
          )}

          {/* Optional live preview (only when a reportId is in scope) ────────── */}
          {reportId && draft && (
            <div className={s.actions}>
              <Button appearance="secondary" icon={previewBusy ? <Spinner size="tiny" /> : <TableSearch20Regular />}
                disabled={previewBusy} onClick={runPreview}>
                {previewBusy ? 'Previewing…' : 'Preview data'}
              </Button>
              <Caption1 className={s.muted}>Runs a real TOP-N read against the Azure backend.</Caption1>
            </div>
          )}
          {previewErr && (
            <MessageBar intent="warning">
              <MessageBarBody><MessageBarTitle>Could not preview</MessageBarTitle>{previewErr}</MessageBarBody>
            </MessageBar>
          )}
          {preview && preview.columns.length > 0 && (
            <div className={s.previewWrap}>
              <Caption1 className={s.muted}>{preview.rows.length} row(s){preview.truncated ? ' (truncated)' : ''}</Caption1>
              <Table size="small" aria-label="Preview rows">
                <TableHeader>
                  <TableRow>{preview.columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow>
                </TableHeader>
                <TableBody>
                  {preview.rows.map((row, i) => (
                    <TableRow key={i}>
                      {preview.columns.map((c) => <TableCell key={c}>{formatCell(row[c])}</TableCell>)}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <Divider />
          <div className={s.actions}>
            <Button appearance="primary" icon={<PlugConnected20Regular />} disabled={!draft}
              onClick={() => { if (draft) onChosen(draft); }}>
              Use this source
            </Button>
            <Button appearance="subtle" onClick={onBack}>Cancel</Button>
            {needsConnection && (
              <Button appearance="subtle" icon={<ArrowClockwise20Regular />} disabled={connsLoading} onClick={onReloadConns}>
                Refresh connections
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Render a cell value compactly (objects → JSON, null → em dash). */
function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}

// ===========================================================================
// <GetDataGallery /> — the dialog wrapper + view state machine.
// ===========================================================================

export interface GetDataGalleryProps {
  open: boolean;
  /** Report item id — scopes uploads + enables the optional live preview. */
  reportId?: string;
  /** Fires with the chosen connection / file-upload / adls-file source. */
  onChosen: (ds: ReportDataSource) => void;
  onDismiss: () => void;
}

type View =
  | { step: 'gallery' }
  | { step: 'bind'; connType?: ReportConnType; def: ConnectorDef; preselectConnectionId?: string };

export function GetDataGallery({ open, reportId, onChosen, onDismiss }: GetDataGalleryProps) {
  const s = useStyles();
  const [view, setView] = useState<View>({ step: 'gallery' });
  const [wizardOpen, setWizardOpen] = useState(false);

  // Connections are loaded once at the gallery level and shared with the bind
  // step (so the dropdown + recents stay in sync after an import).
  const [connections, setConnections] = useState<LoomConnectionView[] | null>(null);
  const [connsLoading, setConnsLoading] = useState(false);
  const [connsErr, setConnsErr] = useState<string | null>(null);

  const loadConnections = useCallback(async () => {
    setConnsLoading(true); setConnsErr(null);
    try {
      const r = await clientFetch('/api/connections', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) { setConnsErr(j?.error || `HTTP ${r.status}`); setConnections([]); return; }
      setConnections(Array.isArray(j.connections) ? j.connections : []);
    } catch (e: any) {
      setConnsErr(e?.message || String(e)); setConnections([]);
    } finally {
      setConnsLoading(false);
    }
  }, []);

  // Reset to the gallery + (re)load connections whenever the dialog opens.
  useEffect(() => {
    if (open) { setView({ step: 'gallery' }); void loadConnections(); }
  }, [open, loadConnections]);

  const pickConnector = useCallback((def: ConnectorDef) => {
    // Unsupported connectors (no mapped ConnType) still open a bind step that
    // shows the honest "not yet a report source" gate — never a dead card.
    setView({ step: 'bind', connType: reportConnTypeOf(def), def });
  }, []);

  const pickRecent = useCallback((pick: RecentPick) => {
    setView({ step: 'bind', connType: pick.connType, def: pick.def, preselectConnectionId: pick.connectionId });
  }, []);

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onDismiss(); }}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle
            action={<Button appearance="subtle" icon={<Dismiss24Regular />} aria-label="Close Get data" onClick={onDismiss} />}>
            <span className={s.titleRow}>
              <DatabaseSearch20Regular />
              <Subtitle1>Get data</Subtitle1>
              <Badge appearance="tint" color="brand" size="small">Azure-native · no Fabric required</Badge>
            </span>
          </DialogTitle>
          <DialogContent>
            {view.step === 'gallery' ? (
              <ConnectorGallery
                connections={connections}
                connsLoading={connsLoading}
                connsErr={connsErr}
                onReloadConns={loadConnections}
                onOpenWizard={() => setWizardOpen(true)}
                onPickConnector={pickConnector}
                onPickRecent={pickRecent}
              />
            ) : (
              <BindStep
                connType={view.connType}
                def={view.def}
                connections={connections}
                connsLoading={connsLoading}
                reportId={reportId}
                preselectConnectionId={view.preselectConnectionId}
                onReloadConns={loadConnections}
                onOpenWizard={() => setWizardOpen(true)}
                onBack={() => setView({ step: 'gallery' })}
                onChosen={onChosen}
              />
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onDismiss}>Cancel</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>

      {/* Reuse the existing credential wizard — NO new credential code here.
          On import we refetch so the new connection appears in the dropdown. */}
      <AddExistingConnectionWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onImported={() => void loadConnections()}
      />
    </Dialog>
  );
}

export default GetDataGallery;
