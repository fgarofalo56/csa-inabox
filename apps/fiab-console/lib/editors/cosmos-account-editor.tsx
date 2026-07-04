'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * Azure Cosmos DB **Data Explorer studio** — one-for-one with the live data-plane
 * studio (temp/ref-cosmos-data-explorer-studio.png), not the portal management
 * blade. Two regions:
 *
 *   LEFT  : CosmosTree — the studio databases pane (＋New… split dropdown, a
 *           "Search databases only" box + sort toggle, a Home row, then
 *           databases → containers → Items / Settings / Stored Procedures /
 *           User Defined Functions / Triggers). Every node routes to a
 *           work-area tab.
 *   RIGHT : a real **closable tab strip** work area. Tabs open like the studio:
 *           - Home (Welcome to Azure Cosmos DB + the four action cards)
 *           - Items (Monaco SQL + Execute → real data-plane query, results grid,
 *             live RU request charge, JSON document CRUD)
 *           - a query tab (New SQL Query)
 *           - Scale & Settings (real RU/TTL/pk values + honest write gates)
 *           - script viewers (New/existing Stored Procedure / UDF / Trigger) —
 *             honest-gated where no authoring route exists yet.
 *
 * Multiple tabs stay open at once; each is closable. The Home tab is pinned
 * (always available). Control-plane CRUD runs on real ARM REST; data-plane
 * query / item CRUD runs on the real Cosmos data plane (documents.azure.com).
 * No mocks — unwired surfaces render an honest Fluent MessageBar naming the
 * exact route/role/env needed (per no-vaporware.md + ui-parity.md).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Tooltip, MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Subtitle2, Body1, Caption1, Badge, Divider, Field, Input, Dropdown, Option,
  Switch, Spinner, RadioGroup, Radio,
  Accordion, AccordionItem, AccordionHeader, AccordionPanel,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, Dismiss12Regular,
  Home16Regular, DocumentBulletList16Regular, Settings20Regular,
  Search16Regular, Code16Regular, MathFormula20Regular, Flow20Regular,
  Organization20Regular,
  Table20Regular,
  DataHistogram20Regular,
  Globe20Regular, Options20Regular, CloudArrowUp20Regular, ShieldKeyhole20Regular,
  Add20Regular, Delete20Regular,
} from '@fluentui/react-icons';
import type {
  CosmosAccountManagement, CosmosAccountLocation, CosmosConsistencyLevel,
  CosmosConsistencyPolicy, CosmosBackupPolicy, CosmosVirtualNetworkRule,
} from '@/lib/azure/cosmos-account-client';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { CosmosTree, type CosmosSelection, type CosmosAction } from '@/lib/components/cosmos/cosmos-tree';
import { CosmosDataExplorer } from '@/lib/components/cosmos/cosmos-data-explorer';
import { CosmosHome } from '@/lib/components/cosmos/cosmos-home';
import { CosmosConnectPanel } from '@/lib/components/cosmos/cosmos-connect-panel';
import { GremlinGraphCanvas } from './components/gremlin-graph-canvas';
import { CosmosSettingsPanel } from '@/lib/components/cosmos/cosmos-settings-panel';
import { CosmosContainerWizard } from '@/lib/components/cosmos/cosmos-container-wizard';
import { CosmosScriptEditor } from '@/lib/components/cosmos/cosmos-script-editor';
import { CosmosMetrics } from './components/cosmos-metrics';

const useStyles = makeStyles({
  workArea: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
  // Studio tab strip: a row of closable tabs across the top of the work area.
  tabStrip: {
    display: 'flex', alignItems: 'stretch', gap: 0, overflowX: 'auto', flexShrink: 0,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  tab: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS, paddingRight: tokens.spacingHorizontalS, paddingLeft: tokens.spacingHorizontalM,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    borderTop: '2px solid transparent',
    cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none',
    color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase300,
    backgroundColor: 'transparent',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  tabActive: {
    backgroundColor: tokens.colorNeutralBackground1,
    borderTopColor: tokens.colorBrandStroke1,
    color: tokens.colorNeutralForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  tabLabel: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  tabClose: { minWidth: tokens.spacingHorizontalL, width: tokens.spacingHorizontalL, height: tokens.spacingVerticalL, padding: 0 },
  panel: { flex: 1, minHeight: 0, overflow: 'auto', paddingTop: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalM, paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM, display: 'flex', flexDirection: 'column' },
});

/** Account-level management tabs (the portal account blade — not the studio). */
type AccountTabKind = 'globalDistribution' | 'consistency' | 'backup' | 'networking';
type WorkTabKind = CosmosAction | AccountTabKind;

interface WorkTab {
  /** Stable key (one tab per logical surface). */
  key: string;
  kind: WorkTabKind;
  title: string;
  closable: boolean;
  db?: string;
  container?: string;
  partitionKey?: string;
  defaultTtl?: number | null;
  throughput?: CosmosSelection['throughput'];
  scriptName?: string;
  /** Seed query for a New SQL Query / Items tab. */
  seedQuery?: string;
}

const HOME_TAB: WorkTab = { key: 'home', kind: 'home', title: 'Home', closable: false };

const ACCOUNT_TABS: { kind: AccountTabKind; title: string }[] = [
  { kind: 'globalDistribution', title: 'Replicate data globally' },
  { kind: 'consistency', title: 'Default consistency' },
  { kind: 'backup', title: 'Backup & Restore' },
  { kind: 'networking', title: 'Networking' },
];

function tabIcon(kind: WorkTabKind) {
  switch (kind) {
    case 'home': return <Home16Regular />;
    case 'items': return <DocumentBulletList16Regular />;
    case 'settings': return <Settings20Regular />;
    case 'metrics': return <DataHistogram20Regular />;
    case 'newSqlQuery': return <Search16Regular />;
    case 'graph': return <Organization20Regular />;
    case 'globalDistribution': return <Globe20Regular />;
    case 'consistency': return <Options20Regular />;
    case 'backup': return <CloudArrowUp20Regular />;
    case 'networking': return <ShieldKeyhole20Regular />;
    case 'storedProcedure':
    case 'newStoredProcedure': return <Code16Regular />;
    case 'udf':
    case 'newUdf': return <MathFormula20Regular />;
    case 'trigger':
    case 'newTrigger': return <Flow20Regular />;
    default: return <DocumentBulletList16Regular />;
  }
}

export function CosmosAccountEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [refreshKey, setRefreshKey] = useState(0);
  const [tabs, setTabs] = useState<WorkTab[]>([HOME_TAB]);
  const [activeKey, setActiveKey] = useState<string>('home');
  // Bumped when the Home "New Container" card / Connect card needs the tree to act.
  const [treeNewContainer, setTreeNewContainer] = useState(0);
  // Multi-step New Container wizard (richer than the tree's inline create dialog).
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardDatabases, setWizardDatabases] = useState<{ name: string }[]>([]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  /** Open the New Container wizard, loading the live database list first. */
  const openContainerWizard = useCallback(async () => {
    try {
      const res = await clientFetch('/api/cosmos/databases');
      const text = await res.text();
      const body = text ? JSON.parse(text) : {};
      setWizardDatabases(body.ok && Array.isArray(body.databases)
        ? body.databases.map((d: { name: string }) => ({ name: d.name }))
        : []);
    } catch {
      setWizardDatabases([]);
    }
    setWizardOpen(true);
  }, []);

  /** Open (or focus) a work-area tab for a tree selection. */
  const openTab = useCallback((sel: CosmosSelection) => {
    const a = sel.action;
    let tab: WorkTab;
    if (a === 'home') {
      setActiveKey('home');
      return;
    } else if (a === 'items') {
      tab = {
        key: `items:${sel.db}|${sel.container}`, kind: 'items',
        title: `${sel.container} · Items`, closable: true,
        db: sel.db, container: sel.container, partitionKey: sel.partitionKey,
      };
    } else if (a === 'settings') {
      tab = {
        key: `settings:${sel.db}|${sel.container}`, kind: 'settings',
        title: `${sel.container} · Settings`, closable: true,
        db: sel.db, container: sel.container, partitionKey: sel.partitionKey,
        defaultTtl: sel.defaultTtl, throughput: sel.throughput,
      };
    } else if (a === 'metrics') {
      // Container-scoped (or account-level) Azure Monitor RU/storage/429 charts.
      const scope = sel.container ? `${sel.db}|${sel.container}` : (sel.db || 'account');
      tab = {
        key: `metrics:${scope}`, kind: 'metrics',
        title: sel.container ? `${sel.container} · Metrics` : 'Metrics', closable: true,
        db: sel.db, container: sel.container,
      };
    } else if (a === 'newSqlQuery') {
      // A standalone query tab against a chosen db/container (or db only).
      const n = Date.now().toString(36);
      tab = {
        key: `query:${n}`, kind: 'newSqlQuery',
        title: `Query ${tabs.filter((t) => t.kind === 'newSqlQuery').length + 1}`, closable: true,
        db: sel.db, container: sel.container, partitionKey: sel.partitionKey,
        seedQuery: 'SELECT * FROM c',
      };
    } else if (a === 'graph') {
      // Cosmos Gremlin graph explorer — one tab per account (pinned key).
      tab = { key: 'graph', kind: 'graph', title: 'Graph explorer', closable: true };
    } else {
      // Script tabs (existing or new sproc/udf/trigger) — real ARM authoring +
      // data-plane execute (CosmosScriptEditor).
      const label =
        a === 'newStoredProcedure' || a === 'storedProcedure' ? 'Stored Procedure'
          : a === 'newUdf' || a === 'udf' ? 'UDF'
            : 'Trigger';
      const key = sel.scriptName
        ? `script:${a}:${sel.db}|${sel.container}|${sel.scriptName}`
        : `script:${a}:${Date.now().toString(36)}`;
      tab = {
        key, kind: a,
        title: sel.scriptName ? `${sel.scriptName}` : `New ${label}`, closable: true,
        db: sel.db, container: sel.container, partitionKey: sel.partitionKey,
        scriptName: sel.scriptName,
      };
    }

    setTabs((prev) => (prev.some((t) => t.key === tab.key) ? prev : [...prev, tab]));
    setActiveKey(tab.key);
  }, [tabs]);

  const closeTab = useCallback((key: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.key !== key);
      setActiveKey((cur) => {
        if (cur !== key) return cur;
        // Focus the neighbor (prefer the previous tab, fall back to Home).
        const idx = prev.findIndex((t) => t.key === key);
        const neighbor = next[Math.max(0, idx - 1)] || HOME_TAB;
        return neighbor.key;
      });
      return next.length ? next : [HOME_TAB];
    });
  }, []);

  /** Open (or focus) an account-level management tab (pinned key = kind). */
  const openAccountTab = useCallback((kind: AccountTabKind) => {
    const meta = ACCOUNT_TABS.find((t) => t.kind === kind);
    const tab: WorkTab = { key: `account:${kind}`, kind, title: meta?.title || kind, closable: true };
    setTabs((prev) => (prev.some((t) => t.key === tab.key) ? prev : [...prev, tab]));
    setActiveKey(tab.key);
  }, []);

  const active = useMemo(() => tabs.find((t) => t.key === activeKey) || HOME_TAB, [tabs, activeKey]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Data Explorer', actions: [
        { label: 'New Container', icon: <Table20Regular />, onClick: () => { void openContainerWizard(); } },
        { label: 'New SQL Query', icon: <Search16Regular />, onClick: () => openTab({ action: 'newSqlQuery' }) },
        { label: 'Graph explorer', icon: <Organization20Regular />, onClick: () => openTab({ action: 'graph' }) },
        { label: 'Metrics', icon: <DataHistogram20Regular />, onClick: () => openTab({ action: 'metrics' }) },
        { label: 'Refresh', icon: <ArrowSync20Regular />, onClick: refresh },
      ]},
    ]},
    { id: 'account', label: 'Account settings', groups: [
      { label: 'Global distribution', actions: [
        { label: 'Replicate data globally', icon: <Globe20Regular />, onClick: () => openAccountTab('globalDistribution') },
      ]},
      { label: 'Settings', actions: [
        { label: 'Default consistency', icon: <Options20Regular />, onClick: () => openAccountTab('consistency') },
        { label: 'Backup & Restore', icon: <CloudArrowUp20Regular />, onClick: () => openAccountTab('backup') },
        { label: 'Networking', icon: <ShieldKeyhole20Regular />, onClick: () => openAccountTab('networking') },
      ]},
    ]},
  ], [refresh, openTab, openContainerWizard, openAccountTab]);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      leftPanel={
        <CosmosTree
          refreshKey={refreshKey + treeNewContainer}
          onOpen={openTab}
        />
      }
      main={
        <div className={s.workArea}>
          {/* Studio closable tab strip */}
          <div className={s.tabStrip} role="tablist" aria-label="Cosmos Data Explorer tabs">
            {tabs.map((t) => (
              <div
                key={t.key}
                role="tab"
                aria-selected={t.key === activeKey}
                tabIndex={0}
                className={mergeClasses(s.tab, t.key === activeKey && s.tabActive)}
                onClick={() => setActiveKey(t.key)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveKey(t.key); } }}
              >
                <span className={s.tabLabel}>{tabIcon(t.kind)}{t.title}</span>
                {t.closable && (
                  <Tooltip content="Close tab" relationship="label">
                    <Button
                      className={s.tabClose}
                      appearance="subtle" size="small" icon={<Dismiss12Regular />}
                      aria-label={`Close ${t.title}`}
                      onClick={(e) => { e.stopPropagation(); closeTab(t.key); }}
                    />
                  </Tooltip>
                )}
              </div>
            ))}
          </div>

          {/* Active tab panel */}
          <div className={s.panel}>
            {active.kind === 'home' && (
              <CosmosHome
                onNewContainer={() => { void openContainerWizard(); }}
                onConnect={() => openTab({ action: 'settings', db: '', container: '' })}
              />
            )}

            {active.kind === 'items' && active.container && (
              <CosmosDataExplorer
                key={active.key}
                db={active.db as string}
                container={active.container}
                partitionKey={active.partitionKey}
              />
            )}

            {active.kind === 'newSqlQuery' && (
              active.db && active.container ? (
                <CosmosDataExplorer
                  key={active.key}
                  db={active.db}
                  container={active.container}
                  partitionKey={active.partitionKey}
                  initialQuery={active.seedQuery}
                />
              ) : (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Pick a container to query</MessageBarTitle>
                    A SQL query in Cosmos runs against a single container. Expand a database in the
                    tree and choose a container&apos;s <strong>Items</strong> node, or create a
                    container first. (Cosmos NoSQL has no cross-container query surface.)
                  </MessageBarBody>
                </MessageBar>
              )
            )}

            {active.kind === 'graph' && (
              <GremlinExplorerPanel id={id} />
            )}

            {active.kind === 'settings' && active.container && (
              <CosmosSettingsPanel
                key={active.key}
                db={active.db as string}
                container={active.container}
                partitionKey={active.partitionKey}
                defaultTtl={active.defaultTtl}
                throughput={active.throughput}
              />
            )}

            {active.kind === 'settings' && !active.container && (
              <CosmosConnectPanel id={id} />
            )}

            {active.kind === 'metrics' && (
              <CosmosMetrics
                key={active.key}
                id={id}
                db={active.db}
                container={active.container}
              />
            )}

            {active.kind === 'globalDistribution' && <GlobalDistributionPanel key={active.key} />}
            {active.kind === 'consistency' && <ConsistencyPanel key={active.key} />}
            {active.kind === 'backup' && <BackupRestorePanel key={active.key} />}
            {active.kind === 'networking' && <NetworkingPanel key={active.key} />}

            {(active.kind === 'storedProcedure' || active.kind === 'newStoredProcedure'
              || active.kind === 'udf' || active.kind === 'newUdf'
              || active.kind === 'trigger' || active.kind === 'newTrigger') && (
              <CosmosScriptEditor
                key={active.key}
                kind={active.kind}
                db={active.db}
                container={active.container}
                scriptName={active.scriptName}
                partitionKey={active.partitionKey}
                onSaved={() => { refresh(); closeTab(active.key); }}
              />
            )}
          </div>

          {/* Multi-step New Container wizard (Home card / future ribbon entry). */}
          <CosmosContainerWizard
            open={wizardOpen}
            onOpenChange={setWizardOpen}
            databases={wizardDatabases}
            onCreated={(_container, db) => {
              // Refresh the tree so the new container (and its db) appear, then
              // open the new container's Settings tab to show the control-plane receipt.
              setTreeNewContainer((n) => n + 1);
              refresh();
              if (_container?.name) {
                openTab({
                  action: 'settings', db, container: _container.name,
                  partitionKey: _container.partitionKey, defaultTtl: _container.defaultTtl,
                  throughput: _container.throughput,
                });
              }
            }}
          />
        </div>
      }
    />
  );
}

/**
 * Graph explorer tab — the Cosmos DB Gremlin (graph) API surface. Renders a
 * read-only endpoint chip (server-bound, per no-vaporware.md) plus the live
 * force-directed canvas + Gremlin editor. The canvas runs `g.V().limit(25)`
 * on mount and surfaces the real BFF honest-gate inline when the account
 * isn't Gremlin-enabled or the runtime endpoint isn't wired.
 */
function GremlinExplorerPanel({ id }: { id: string }) {
  // Server-bound endpoint (read-only). The BFF drives the real runtime via
  // LOOM_COSMOS_GREMLIN_ENDPOINT; this client mirror is informational only.
  const endpoint = process.env.NEXT_PUBLIC_LOOM_COSMOS_GREMLIN_ENDPOINT || '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, flex: 1, minHeight: 0 }}>
      <MessageBar intent={endpoint ? 'info' : 'warning'}>
        <MessageBarBody>
          <MessageBarTitle>Cosmos Gremlin (graph) API</MessageBarTitle>
          {endpoint ? (
            <>Connected to <code style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{endpoint}</code> (server-bound via <code style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>LOOM_COSMOS_GREMLIN_ENDPOINT</code>).
              Run a traversal below — <code>g.V()</code>/<code>g.E()</code> results render on the
              force-directed canvas; <code>addV</code>/<code>addE</code> persist to the live graph.</>
          ) : (
            <>No Gremlin runtime endpoint is bound. The Gremlin API needs a dedicated
              <strong> EnableGremlin</strong> account (deploy{' '}
              <code style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>cosmos-graph-vector.bicep</code>), then set <code style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>LOOM_COSMOS_GREMLIN_ENDPOINT</code>
              {' '}on the Console Container App. The canvas below still renders and reports the precise
              gate returned by the backend.</>
          )}
        </MessageBarBody>
      </MessageBar>
      <GremlinGraphCanvas itemId={id} />
    </div>
  );
}

// ===========================================================================
// Account-level MANAGEMENT panels — the portal Cosmos DB *account* blade (the
// surfaces the Data Explorer studio does NOT expose): Replicate-data-globally,
// default Consistency, Backup & Restore, Networking. Each reads the real ARM
// account shape (GET /api/cosmos/account-management) and writes a targeted
// section via PATCH (section-scoped "Database Accounts - Update"). No mocks; a
// read-only UAMI surfaces the ARM 403 as an honest "DocumentDB Account
// Contributor" gate (per no-vaporware.md / ui-parity.md).
// ===========================================================================

const MGMT_ROUTE = '/api/cosmos/account-management';

/** Azure regions offered by the "add region" dropdown (Commercial + US Gov).
 *  ARM validates against the subscription's actually-available regions and
 *  returns an honest 400 if one isn't offered. */
const AZURE_REGIONS: string[] = [
  'East US', 'East US 2', 'Central US', 'North Central US', 'South Central US', 'West Central US',
  'West US', 'West US 2', 'West US 3', 'Canada Central', 'Canada East',
  'Brazil South', 'North Europe', 'West Europe', 'UK South', 'UK West',
  'France Central', 'Germany West Central', 'Switzerland North', 'Norway East', 'Sweden Central',
  'East Asia', 'Southeast Asia', 'Australia East', 'Australia Southeast',
  'Central India', 'South India', 'Japan East', 'Japan West', 'Korea Central',
  'UAE North', 'South Africa North',
  'USGov Virginia', 'USGov Texas', 'USGov Arizona', 'US DoD Central', 'US DoD East',
];

const CONSISTENCY_LEVELS: { value: CosmosConsistencyLevel; label: string; hint: string }[] = [
  { value: 'Strong', label: 'Strong', hint: 'Linearizable reads — always the latest committed write. Requires bounded regions.' },
  { value: 'BoundedStaleness', label: 'Bounded staleness', hint: 'Reads lag writes by at most K versions or T seconds (you set the bounds below).' },
  { value: 'Session', label: 'Session', hint: 'Default. Read-your-own-writes consistency within a session token.' },
  { value: 'ConsistentPrefix', label: 'Consistent prefix', hint: 'Reads never see out-of-order writes; may lag.' },
  { value: 'Eventual', label: 'Eventual', hint: 'Lowest latency / cost; no ordering guarantee. Reads converge over time.' },
];

const useMgmtStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, paddingTop: tokens.spacingVerticalS, paddingBottom: tokens.spacingVerticalS, paddingLeft: tokens.spacingHorizontalXS, paddingRight: tokens.spacingHorizontalXS, overflow: 'auto', height: '100%' },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  actionRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalXS, flexWrap: 'wrap' },
  note: { color: tokens.colorNeutralForeground3 },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  listRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalS, paddingRight: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  grow: { flex: 1, minWidth: 0 },
  addRow: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
});

type MgmtMsg = { intent: 'success' | 'error' | 'info' | 'warning'; text: string } | null;

interface MgmtState {
  loading: boolean;
  data: CosmosAccountManagement | null;
  gate: { missing?: string; hint?: string } | null;
  error: string | null;
}

/** Shared loader for every account-management panel: real ARM GET + section PATCH. */
function useAccountManagement() {
  const [state, setState] = useState<MgmtState>({ loading: true, data: null, gate: null, error: null });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const res = await fetch(MGMT_ROUTE, { cache: 'no-store' });
      const j = await res.json().catch(() => ({}));
      if (res.status === 503 && j?.code === 'not_configured') {
        setState({ loading: false, data: null, gate: { missing: j.missing, hint: j.hint }, error: null });
        return;
      }
      if (!res.ok || j?.ok === false) {
        setState({ loading: false, data: null, gate: null, error: j?.error || j?.hint || `Failed to load account (HTTP ${res.status})` });
        return;
      }
      setState({ loading: false, data: j.management as CosmosAccountManagement, gate: null, error: null });
    } catch (e) {
      setState({ loading: false, data: null, gate: null, error: (e as Error)?.message || 'Failed to load account' });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** PATCH one section; on success swap in the re-read management shape. */
  const patch = useCallback(async (payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(MGMT_ROUTE, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok !== false) {
        if (j.management) setState((s) => ({ ...s, data: j.management as CosmosAccountManagement }));
        return { ok: true };
      }
      return { ok: false, error: j?.error || j?.hint || `Update failed (HTTP ${res.status})` };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message || 'Update failed' };
    }
  }, []);

  return { ...state, reload: load, patch };
}

/** Loading / config-gate / error frame shared by the panels (null when ready). */
function MgmtGate({ loading, gate, error, hasData, onRetry }: {
  loading: boolean; gate: MgmtState['gate']; error: string | null; hasData: boolean; onRetry: () => void;
}) {
  const s = useMgmtStyles();
  if (loading) return <div className={s.root}><Spinner size="small" label="Loading account settings…" /></div>;
  if (gate) {
    return (
      <div className={s.root}>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Cosmos DB account not configured</MessageBarTitle>
            {gate.hint || `Set ${gate.missing} on the Console Container App.`}
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }
  if (error) {
    return (
      <div className={s.root}>
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Couldn&apos;t load account settings</MessageBarTitle>{error}</MessageBarBody>
          <MessageBarActions>
            <Button appearance="transparent" icon={<ArrowSync20Regular />} onClick={onRetry}>Retry</Button>
          </MessageBarActions>
        </MessageBar>
      </div>
    );
  }
  if (!hasData) return <div className={s.root}><Spinner size="small" label="Loading account settings…" /></div>;
  return null;
}

/** Normalize failover priorities to a contiguous 0..n-1 by current order (ARM requires this). */
function normalizeLocations(locs: CosmosAccountLocation[]): CosmosAccountLocation[] {
  return locs
    .slice()
    .sort((a, b) => a.failoverPriority - b.failoverPriority)
    .map((l, i) => ({ ...l, failoverPriority: i }));
}

// ---------------------------------------------------------------------------
// Replicate data globally (regions + multi-write + automatic failover)
// ---------------------------------------------------------------------------

function GlobalDistributionPanel() {
  const s = useMgmtStyles();
  const { loading, data, gate, error, reload, patch } = useAccountManagement();

  const [locs, setLocs] = useState<CosmosAccountLocation[]>([]);
  const [newRegion, setNewRegion] = useState<string>('');
  const [newZoneRedundant, setNewZoneRedundant] = useState(false);
  const [multiWrite, setMultiWrite] = useState(false);
  const [autoFailover, setAutoFailover] = useState(false);
  const [regionBusy, setRegionBusy] = useState(false);
  const [replBusy, setReplBusy] = useState(false);
  const [regionMsg, setRegionMsg] = useState<MgmtMsg>(null);
  const [replMsg, setReplMsg] = useState<MgmtMsg>(null);

  useEffect(() => {
    if (!data) return;
    setLocs(normalizeLocations(data.locations || []));
    setMultiWrite(data.enableMultipleWriteLocations);
    setAutoFailover(data.enableAutomaticFailover);
  }, [data]);

  const takenRegions = useMemo(() => new Set(locs.map((l) => l.locationName)), [locs]);
  const availableRegions = useMemo(() => AZURE_REGIONS.filter((r) => !takenRegions.has(r)), [takenRegions]);

  const addRegion = useCallback(() => {
    if (!newRegion) return;
    setLocs((prev) => normalizeLocations([
      ...prev,
      { locationName: newRegion, failoverPriority: prev.length, isZoneRedundant: newZoneRedundant },
    ]));
    setNewRegion('');
    setNewZoneRedundant(false);
  }, [newRegion, newZoneRedundant]);

  const removeRegion = useCallback((name: string) => {
    setLocs((prev) => normalizeLocations(prev.filter((l) => l.locationName !== name)));
  }, []);

  const saveRegions = useCallback(async () => {
    setRegionBusy(true); setRegionMsg(null);
    const r = await patch({ section: 'globalDistribution', locations: locs });
    setRegionMsg(r.ok
      ? { intent: 'success', text: 'Region topology update accepted. Adding or removing a region is long-running — the region list shows each region\'s provisioning state as it settles.' }
      : { intent: 'error', text: r.error || 'Region update failed.' });
    setRegionBusy(false);
  }, [patch, locs]);

  const saveReplication = useCallback(async () => {
    setReplBusy(true); setReplMsg(null);
    const r = await patch({ section: 'globalDistribution', enableMultipleWriteLocations: multiWrite, enableAutomaticFailover: autoFailover });
    setReplMsg(r.ok ? { intent: 'success', text: 'Replication settings updated.' } : { intent: 'error', text: r.error || 'Replication update failed.' });
    setReplBusy(false);
  }, [patch, multiWrite, autoFailover]);

  const frame = <MgmtGate loading={loading} gate={gate} error={error} hasData={!!data} onRetry={reload} />;
  if (frame) return frame;

  const dirtyRegions = JSON.stringify(normalizeLocations(data!.locations || [])) !== JSON.stringify(locs);
  const dirtyRepl = multiWrite !== data!.enableMultipleWriteLocations || autoFailover !== data!.enableAutomaticFailover;

  return (
    <div className={s.root}>
      <div className={s.head}>
        <Globe20Regular />
        <Subtitle2>Replicate data globally</Subtitle2>
        <Badge appearance="tint">{data!.name}</Badge>
        {data!.provisioningState && <Badge appearance="outline">{data!.provisioningState}</Badge>}
      </div>
      <Body1>
        Associate the account with more Azure regions for global reach, resilience, and low-latency
        reads. The first region (failover priority 0) is the write region.
      </Body1>

      <Accordion multiple collapsible defaultOpenItems={['regions', 'replication']}>
        <AccordionItem value="regions">
          <AccordionHeader>Regions ({locs.length})</AccordionHeader>
          <AccordionPanel>
            <div className={s.section}>
              {locs.map((l) => (
                <div key={l.locationName} className={s.listRow}>
                  <Globe20Regular />
                  <div className={s.grow}><Body1>{l.locationName}</Body1></div>
                  <Badge appearance="tint" color={l.failoverPriority === 0 ? 'brand' : 'informative'}>
                    {l.failoverPriority === 0 ? 'Write' : `Read · priority ${l.failoverPriority}`}
                  </Badge>
                  {l.isZoneRedundant && <Badge appearance="outline" color="success">Zone redundant</Badge>}
                  {l.provisioningState && l.provisioningState !== 'Succeeded' && (
                    <Badge appearance="outline" color="warning">{l.provisioningState}</Badge>
                  )}
                  <Tooltip content={l.failoverPriority === 0 ? 'The write region cannot be removed' : 'Remove region'} relationship="label">
                    <Button
                      appearance="subtle" icon={<Delete20Regular />}
                      aria-label={`Remove ${l.locationName}`}
                      disabled={l.failoverPriority === 0}
                      onClick={() => removeRegion(l.locationName)}
                    />
                  </Tooltip>
                </div>
              ))}

              <Divider />
              <div className={s.addRow}>
                <Field label="Add region">
                  <Dropdown
                    placeholder="Choose an Azure region"
                    value={newRegion}
                    selectedOptions={newRegion ? [newRegion] : []}
                    onOptionSelect={(_, d) => setNewRegion(d.optionValue || '')}
                  >
                    {availableRegions.map((r) => <Option key={r} value={r} text={r}>{r}</Option>)}
                  </Dropdown>
                </Field>
                <Switch
                  label="Availability zones"
                  checked={newZoneRedundant}
                  onChange={(_, d) => setNewZoneRedundant(d.checked)}
                />
                <Button icon={<Add20Regular />} disabled={!newRegion} onClick={addRegion}>Add</Button>
              </div>

              <div className={s.actionRow}>
                <Button appearance="primary" disabled={regionBusy || !dirtyRegions} onClick={saveRegions}>
                  {regionBusy ? <Spinner size="tiny" label="Saving…" labelPosition="after" /> : 'Save regions'}
                </Button>
                {dirtyRegions && <Caption1 className={s.note}>Unsaved region changes.</Caption1>}
              </div>
              {regionMsg && <MessageBar intent={regionMsg.intent}><MessageBarBody>{regionMsg.text}</MessageBarBody></MessageBar>}
            </div>
          </AccordionPanel>
        </AccordionItem>

        <AccordionItem value="replication">
          <AccordionHeader>Replication settings</AccordionHeader>
          <AccordionPanel>
            <div className={s.section}>
              <Switch
                label="Multi-region writes (write to every region)"
                checked={multiWrite}
                onChange={(_, d) => setMultiWrite(d.checked)}
              />
              <Caption1 className={s.note}>
                Turns every region into a write region (active-active). Conflict-resolution policy on
                each container then governs concurrent writes.
              </Caption1>
              <Switch
                label="Service-managed failover (automatic failover)"
                checked={autoFailover}
                onChange={(_, d) => setAutoFailover(d.checked)}
              />
              <Caption1 className={s.note}>
                Lets Azure automatically fail the write region over to the next read region during a
                regional outage. Applies to single-write-region accounts.
              </Caption1>
              <div className={s.actionRow}>
                <Button appearance="primary" disabled={replBusy || !dirtyRepl} onClick={saveReplication}>
                  {replBusy ? <Spinner size="tiny" label="Saving…" labelPosition="after" /> : 'Save replication settings'}
                </Button>
              </div>
              {replMsg && <MessageBar intent={replMsg.intent}><MessageBarBody>{replMsg.text}</MessageBarBody></MessageBar>}
            </div>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>

      <Divider />
      <Caption1 className={s.note}>
        Region and replication changes are written to the real ARM control plane
        (<code>PATCH Microsoft.DocumentDB/databaseAccounts/&#123;acct&#125;</code>, api-version
        2024-11-15) and re-read. Adding or removing a region is long-running (minutes) — the region
        list reflects each region&apos;s provisioning state.
      </Caption1>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Default consistency
// ---------------------------------------------------------------------------

function ConsistencyPanel() {
  const s = useMgmtStyles();
  const { loading, data, gate, error, reload, patch } = useAccountManagement();

  const [level, setLevel] = useState<CosmosConsistencyLevel>('Session');
  const [prefix, setPrefix] = useState<string>('100000');
  const [staleSeconds, setStaleSeconds] = useState<string>('300');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<MgmtMsg>(null);

  useEffect(() => {
    if (!data) return;
    const c = data.consistencyPolicy;
    setLevel(c.defaultConsistencyLevel);
    if (typeof c.maxStalenessPrefix === 'number') setPrefix(String(c.maxStalenessPrefix));
    if (typeof c.maxIntervalInSeconds === 'number') setStaleSeconds(String(c.maxIntervalInSeconds));
  }, [data]);

  const save = useCallback(async () => {
    setBusy(true); setMsg(null);
    const policy: CosmosConsistencyPolicy = { defaultConsistencyLevel: level };
    if (level === 'BoundedStaleness') {
      const p = parseInt(prefix, 10);
      const i = parseInt(staleSeconds, 10);
      if (!(p >= 10)) { setMsg({ intent: 'error', text: 'Max staleness (operations) must be at least 10.' }); setBusy(false); return; }
      if (!(i >= 5)) { setMsg({ intent: 'error', text: 'Max staleness (time) must be at least 5 seconds.' }); setBusy(false); return; }
      policy.maxStalenessPrefix = p;
      policy.maxIntervalInSeconds = i;
    }
    const r = await patch({ section: 'consistency', consistencyPolicy: policy });
    setMsg(r.ok ? { intent: 'success', text: 'Default consistency updated.' } : { intent: 'error', text: r.error || 'Consistency update failed.' });
    setBusy(false);
  }, [patch, level, prefix, staleSeconds]);

  const frame = <MgmtGate loading={loading} gate={gate} error={error} hasData={!!data} onRetry={reload} />;
  if (frame) return frame;

  return (
    <div className={s.root}>
      <div className={s.head}>
        <Options20Regular />
        <Subtitle2>Default consistency</Subtitle2>
        <Badge appearance="tint">{data!.consistencyPolicy.defaultConsistencyLevel}</Badge>
      </div>
      <Body1>
        The default consistency level applies to every read that does not override it per-request.
        Stronger consistency costs more RU/s and latency; weaker is cheaper and faster.
      </Body1>

      <RadioGroup value={level} onChange={(_, d) => setLevel(d.value as CosmosConsistencyLevel)}>
        {CONSISTENCY_LEVELS.map((c) => (
          <div key={c.value} className={s.section} style={{ gap: tokens.spacingVerticalXXS }}>
            <Radio value={c.value} label={c.label} />
            <Caption1 className={s.note} style={{ marginLeft: tokens.spacingHorizontalXXL }}>{c.hint}</Caption1>
          </div>
        ))}
      </RadioGroup>

      {level === 'BoundedStaleness' && (
        <div className={s.section}>
          <Divider />
          <Field label="Maximum lag (operations)">
            <Input type="number" value={prefix} onChange={(_, d) => setPrefix(d.value)} />
          </Field>
          <Field label="Maximum lag (seconds)">
            <Input type="number" value={staleSeconds} onChange={(_, d) => setStaleSeconds(d.value)} />
          </Field>
          <Caption1 className={s.note}>
            Reads lag writes by at most this many operations OR this many seconds, whichever comes
            first. Multi-region accounts enforce higher minimums (100,000 operations / 300 seconds);
            ARM returns an honest error if a bound is below the account&apos;s allowed range.
          </Caption1>
        </div>
      )}

      <div className={s.actionRow}>
        <Button appearance="primary" disabled={busy} onClick={save}>
          {busy ? <Spinner size="tiny" label="Saving…" labelPosition="after" /> : 'Save consistency'}
        </Button>
      </div>
      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}

      <Divider />
      <Caption1 className={s.note}>
        Written to the real ARM control plane (<code>consistencyPolicy</code> on
        <code> Microsoft.DocumentDB/databaseAccounts</code>) and re-read to confirm.
      </Caption1>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Backup & Restore
// ---------------------------------------------------------------------------

function BackupRestorePanel() {
  const s = useMgmtStyles();
  const { loading, data, gate, error, reload, patch } = useAccountManagement();

  const [type, setType] = useState<'Periodic' | 'Continuous'>('Periodic');
  const [intervalMin, setIntervalMin] = useState<string>('240');
  const [retentionHr, setRetentionHr] = useState<string>('8');
  const [redundancy, setRedundancy] = useState<'Geo' | 'Local' | 'Zone'>('Geo');
  const [tier, setTier] = useState<'Continuous7Days' | 'Continuous30Days'>('Continuous30Days');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<MgmtMsg>(null);

  useEffect(() => {
    if (!data) return;
    const b = data.backupPolicy;
    setType(b.type);
    if (typeof b.backupIntervalInMinutes === 'number') setIntervalMin(String(b.backupIntervalInMinutes));
    if (typeof b.backupRetentionIntervalInHours === 'number') setRetentionHr(String(b.backupRetentionIntervalInHours));
    if (b.backupStorageRedundancy) setRedundancy(b.backupStorageRedundancy);
    if (b.tier) setTier(b.tier);
  }, [data]);

  const currentType = data?.backupPolicy.type;
  // Periodic → Continuous is a one-way migration in Azure.
  const wouldMigrateToContinuous = currentType === 'Periodic' && type === 'Continuous';
  const revertBlocked = currentType === 'Continuous' && type === 'Periodic';

  const save = useCallback(async () => {
    setBusy(true); setMsg(null);
    let policy: CosmosBackupPolicy;
    if (type === 'Continuous') {
      policy = { type: 'Continuous', tier };
    } else {
      const iv = parseInt(intervalMin, 10);
      const rt = parseInt(retentionHr, 10);
      if (!(iv >= 60 && iv <= 1440)) { setMsg({ intent: 'error', text: 'Backup interval must be 60–1440 minutes.' }); setBusy(false); return; }
      if (!(rt >= 8 && rt <= 720)) { setMsg({ intent: 'error', text: 'Retention must be 8–720 hours.' }); setBusy(false); return; }
      policy = { type: 'Periodic', backupIntervalInMinutes: iv, backupRetentionIntervalInHours: rt, backupStorageRedundancy: redundancy };
    }
    const r = await patch({ section: 'backup', backupPolicy: policy });
    setMsg(r.ok ? { intent: 'success', text: 'Backup policy updated.' } : { intent: 'error', text: r.error || 'Backup policy update failed.' });
    setBusy(false);
  }, [patch, type, tier, intervalMin, retentionHr, redundancy]);

  const frame = <MgmtGate loading={loading} gate={gate} error={error} hasData={!!data} onRetry={reload} />;
  if (frame) return frame;

  return (
    <div className={s.root}>
      <div className={s.head}>
        <CloudArrowUp20Regular />
        <Subtitle2>Backup &amp; Restore</Subtitle2>
        <Badge appearance="tint">{currentType}</Badge>
      </div>
      <Body1>
        Choose how the account is backed up. <strong>Periodic</strong> takes snapshots on a schedule
        (restore via a support-assisted request). <strong>Continuous</strong> enables point-in-time
        restore (PITR) to any second in the retention window.
      </Body1>

      <Field label="Backup mode">
        <RadioGroup value={type} onChange={(_, d) => setType(d.value as 'Periodic' | 'Continuous')}>
          <Radio value="Periodic" label="Periodic (scheduled snapshots)" />
          <Radio value="Continuous" label="Continuous (point-in-time restore)" disabled={false} />
        </RadioGroup>
      </Field>

      {type === 'Periodic' ? (
        <div className={s.section}>
          <Field label="Backup interval (minutes)">
            <Input type="number" value={intervalMin} onChange={(_, d) => setIntervalMin(d.value)} />
          </Field>
          <Field label="Backup retention (hours)">
            <Input type="number" value={retentionHr} onChange={(_, d) => setRetentionHr(d.value)} />
          </Field>
          <Field label="Backup storage redundancy">
            <Dropdown
              value={redundancy}
              selectedOptions={[redundancy]}
              onOptionSelect={(_, d) => setRedundancy((d.optionValue as 'Geo' | 'Local' | 'Zone') || 'Geo')}
            >
              <Option value="Geo" text="Geo-redundant">Geo-redundant</Option>
              <Option value="Zone" text="Zone-redundant">Zone-redundant</Option>
              <Option value="Local" text="Locally-redundant">Locally-redundant</Option>
            </Dropdown>
          </Field>
        </div>
      ) : (
        <div className={s.section}>
          <Field label="Continuous backup tier">
            <Dropdown
              value={tier === 'Continuous7Days' ? '7 days' : '30 days'}
              selectedOptions={[tier]}
              onOptionSelect={(_, d) => setTier((d.optionValue as 'Continuous7Days' | 'Continuous30Days') || 'Continuous30Days')}
            >
              <Option value="Continuous7Days" text="7 days">Continuous — 7 days (free)</Option>
              <Option value="Continuous30Days" text="30 days">Continuous — 30 days</Option>
            </Dropdown>
          </Field>
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>Point-in-time restore</MessageBarTitle>
              With continuous backup, a PITR restore provisions a <strong>new</strong> Cosmos DB
              account from a chosen timestamp (ARM <code>createMode: Restore</code>) — it never
              overwrites this account in place. Because it is a heavy, account-creating operation,
              run it from a dedicated restore workflow or the portal / <code>az cosmosdb restore</code>;
              this panel governs the backup <em>policy</em> that makes those restores possible.
            </MessageBarBody>
          </MessageBar>
        </div>
      )}

      {wouldMigrateToContinuous && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>One-way migration</MessageBarTitle>
            Switching Periodic → Continuous cannot be reversed. The account stays on continuous
            backup afterward.
          </MessageBarBody>
        </MessageBar>
      )}
      {revertBlocked && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Continuous → Periodic is not supported</MessageBarTitle>
            Azure does not allow reverting a continuous-backup account to periodic. ARM will reject
            this change; leave the mode on Continuous.
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={s.actionRow}>
        <Button appearance="primary" disabled={busy || revertBlocked} onClick={save}>
          {busy ? <Spinner size="tiny" label="Saving…" labelPosition="after" /> : 'Save backup policy'}
        </Button>
      </div>
      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}

      <Divider />
      <Caption1 className={s.note}>
        Written to the real ARM control plane (<code>backupPolicy</code> on
        <code> Microsoft.DocumentDB/databaseAccounts</code>) and re-read to confirm.
      </Caption1>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Networking (public access + IP firewall + VNet rules + private endpoints)
// ---------------------------------------------------------------------------

function NetworkingPanel() {
  const s = useMgmtStyles();
  const { loading, data, gate, error, reload, patch } = useAccountManagement();

  const [publicAccess, setPublicAccess] = useState(true);
  const [vnetFilter, setVnetFilter] = useState(false);
  const [ipRules, setIpRules] = useState<string[]>([]);
  const [vnetRules, setVnetRules] = useState<CosmosVirtualNetworkRule[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<MgmtMsg>(null);

  useEffect(() => {
    if (!data) return;
    setPublicAccess((data.publicNetworkAccess || 'Enabled') !== 'Disabled');
    setVnetFilter(data.isVirtualNetworkFilterEnabled);
    setIpRules(data.ipRules || []);
    setVnetRules(data.virtualNetworkRules || []);
  }, [data]);

  const save = useCallback(async () => {
    setBusy(true); setMsg(null);
    const r = await patch({
      section: 'networking',
      publicNetworkAccess: publicAccess ? 'Enabled' : 'Disabled',
      isVirtualNetworkFilterEnabled: vnetFilter,
      ipRules: ipRules.map((x) => x.trim()).filter(Boolean),
      virtualNetworkRules: vnetRules.filter((v) => (v.id || '').trim()),
    });
    setMsg(r.ok ? { intent: 'success', text: 'Networking updated.' } : { intent: 'error', text: r.error || 'Networking update failed.' });
    setBusy(false);
  }, [patch, publicAccess, vnetFilter, ipRules, vnetRules]);

  const frame = <MgmtGate loading={loading} gate={gate} error={error} hasData={!!data} onRetry={reload} />;
  if (frame) return frame;

  const pecs = data!.privateEndpointConnections || [];

  return (
    <div className={s.root}>
      <div className={s.head}>
        <ShieldKeyhole20Regular />
        <Subtitle2>Networking</Subtitle2>
        <Badge appearance="tint" color={publicAccess ? 'informative' : 'success'}>
          {publicAccess ? 'Public access' : 'Public access disabled'}
        </Badge>
      </div>

      <Accordion multiple collapsible defaultOpenItems={['public', 'firewall', 'vnet', 'pe']}>
        <AccordionItem value="public">
          <AccordionHeader>Public network access</AccordionHeader>
          <AccordionPanel>
            <div className={s.section}>
              <Switch
                label={publicAccess ? 'Public access enabled' : 'Public access disabled (private endpoints only)'}
                checked={publicAccess}
                onChange={(_, d) => setPublicAccess(d.checked)}
              />
              <Caption1 className={s.note}>
                When disabled, the account is reachable only through private endpoints. The IP
                firewall and VNet rules below apply only while public access is enabled.
              </Caption1>
            </div>
          </AccordionPanel>
        </AccordionItem>

        <AccordionItem value="firewall">
          <AccordionHeader>IP firewall ({ipRules.length})</AccordionHeader>
          <AccordionPanel>
            <div className={s.section}>
              {ipRules.length === 0 && (
                <Caption1 className={s.note}>
                  No IP rules — with public access on and no rules, all networks may reach the account
                  (subject to auth). Add a rule to restrict access to specific IPs/CIDR ranges.
                </Caption1>
              )}
              {ipRules.map((rule, i) => (
                <div key={i} className={s.row}>
                  <div className={s.grow}>
                    <Input
                      value={rule}
                      placeholder="e.g. 13.91.6.132 or 40.83.0.0/16"
                      onChange={(_, d) => setIpRules((prev) => prev.map((x, j) => (j === i ? d.value : x)))}
                    />
                  </div>
                  <Tooltip content="Remove IP rule" relationship="label">
                    <Button appearance="subtle" icon={<Delete20Regular />} aria-label={`Remove IP rule ${i + 1}`}
                      onClick={() => setIpRules((prev) => prev.filter((_, j) => j !== i))} />
                  </Tooltip>
                </div>
              ))}
              <div>
                <Button icon={<Add20Regular />} onClick={() => setIpRules((prev) => [...prev, ''])}>Add IP rule</Button>
              </div>
            </div>
          </AccordionPanel>
        </AccordionItem>

        <AccordionItem value="vnet">
          <AccordionHeader>Virtual network rules ({vnetRules.length})</AccordionHeader>
          <AccordionPanel>
            <div className={s.section}>
              <Switch
                label="Enable virtual-network filter"
                checked={vnetFilter}
                onChange={(_, d) => setVnetFilter(d.checked)}
              />
              {vnetRules.map((v, i) => (
                <div key={i} className={s.row}>
                  <div className={s.grow}>
                    <Input
                      value={v.id}
                      placeholder="/subscriptions/…/virtualNetworks/<vnet>/subnets/<subnet>"
                      onChange={(_, d) => setVnetRules((prev) => prev.map((x, j) => (j === i ? { ...x, id: d.value } : x)))}
                    />
                  </div>
                  <Tooltip content="Remove VNet rule" relationship="label">
                    <Button appearance="subtle" icon={<Delete20Regular />} aria-label={`Remove VNet rule ${i + 1}`}
                      onClick={() => setVnetRules((prev) => prev.filter((_, j) => j !== i))} />
                  </Tooltip>
                </div>
              ))}
              <div>
                <Button icon={<Add20Regular />} onClick={() => setVnetRules((prev) => [...prev, { id: '' }])}>Add subnet</Button>
              </div>
              <Caption1 className={s.note}>
                Each rule is a subnet resource id. The subnet must have the
                <code> Microsoft.AzureCosmosDB</code> service endpoint enabled, or enable the VNet
                filter and let ARM add it.
              </Caption1>
            </div>
          </AccordionPanel>
        </AccordionItem>

        <AccordionItem value="pe">
          <AccordionHeader>Private endpoint connections ({pecs.length})</AccordionHeader>
          <AccordionPanel>
            <div className={s.section}>
              {pecs.length === 0 ? (
                <Caption1 className={s.note}>No private endpoint connections on this account.</Caption1>
              ) : (
                pecs.map((p) => (
                  <div key={p.id || p.name} className={s.listRow}>
                    <ShieldKeyhole20Regular />
                    <div className={s.grow}>
                      <Body1>{p.name}</Body1>
                      {p.privateEndpointId && (
                        <Caption1 className={s.note} style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                          {p.privateEndpointId.split('/').pop()}
                        </Caption1>
                      )}
                    </div>
                    {p.status && (
                      <Badge appearance="tint" color={p.status === 'Approved' ? 'success' : p.status === 'Pending' ? 'warning' : 'danger'}>
                        {p.status}
                      </Badge>
                    )}
                  </div>
                ))
              )}
              <Caption1 className={s.note}>
                Private endpoint connections are read here. Creating a private endpoint (and its
                approval workflow) is a Networking/Private-Link operation — provision it from the DLZ
                bicep or the portal, then it appears in this list.
              </Caption1>
            </div>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>

      <div className={s.actionRow}>
        <Button appearance="primary" disabled={busy} onClick={save}>
          {busy ? <Spinner size="tiny" label="Saving…" labelPosition="after" /> : 'Save networking'}
        </Button>
      </div>
      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}

      <Divider />
      <Caption1 className={s.note}>
        Firewall / VNet / public-access changes are written to the real ARM control plane
        (<code>ipRules</code>, <code>virtualNetworkRules</code>, <code>isVirtualNetworkFilterEnabled</code>,
        <code> publicNetworkAccess</code> on <code>Microsoft.DocumentDB/databaseAccounts</code>) and
        re-read to confirm.
      </Caption1>
    </div>
  );
}
