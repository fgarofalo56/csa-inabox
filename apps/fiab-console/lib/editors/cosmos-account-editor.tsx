'use client';

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

import { useCallback, useMemo, useState } from 'react';
import {
  Button, Tooltip, Caption1, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, Dismiss12Regular,
  Home16Regular, DocumentBulletList16Regular, Settings20Regular,
  Search16Regular, Code16Regular, MathFormula20Regular, Flow20Regular,
  Organization20Regular,
  Table20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { CosmosTree, type CosmosSelection, type CosmosAction } from '@/lib/components/cosmos/cosmos-tree';
import { CosmosDataExplorer } from '@/lib/components/cosmos/cosmos-data-explorer';
import { CosmosHome } from '@/lib/components/cosmos/cosmos-home';
import { GremlinGraphCanvas } from './components/gremlin-graph-canvas';
import { CosmosSettingsPanel } from '@/lib/components/cosmos/cosmos-settings-panel';
import { CosmosContainerWizard } from '@/lib/components/cosmos/cosmos-container-wizard';

const useStyles = makeStyles({
  workArea: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
  // Studio tab strip: a row of closable tabs across the top of the work area.
  tabStrip: {
    display: 'flex', alignItems: 'stretch', gap: 0, overflowX: 'auto', flexShrink: 0,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  tab: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px 6px 12px',
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
  tabLabel: { display: 'flex', alignItems: 'center', gap: 6 },
  tabClose: { minWidth: 16, width: 16, height: 16, padding: 0 },
  panel: { flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column' },
});

interface WorkTab {
  /** Stable key (one tab per logical surface). */
  key: string;
  kind: CosmosAction;
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

function tabIcon(kind: CosmosAction) {
  switch (kind) {
    case 'home': return <Home16Regular />;
    case 'items': return <DocumentBulletList16Regular />;
    case 'settings': return <Settings20Regular />;
    case 'newSqlQuery': return <Search16Regular />;
    case 'graph': return <Organization20Regular />;
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
      const res = await fetch('/api/cosmos/databases');
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
      // Script tabs (existing or new sproc/udf/trigger) — honest-gated authoring.
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
        db: sel.db, container: sel.container, scriptName: sel.scriptName,
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

  const active = useMemo(() => tabs.find((t) => t.key === activeKey) || HOME_TAB, [tabs, activeKey]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Data Explorer', actions: [
        { label: 'New Container', icon: <Table20Regular />, onClick: () => { void openContainerWizard(); } },
        { label: 'New SQL Query', icon: <Search16Regular />, onClick: () => openTab({ action: 'newSqlQuery' }) },
        { label: 'Graph explorer', icon: <Organization20Regular />, onClick: () => openTab({ action: 'graph' }) },
        { label: 'Refresh', icon: <ArrowSync20Regular />, onClick: refresh },
      ]},
    ]},
  ], [refresh, openTab, openContainerWizard]);

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
              <ConnectPanel />
            )}

            {(active.kind === 'storedProcedure' || active.kind === 'newStoredProcedure'
              || active.kind === 'udf' || active.kind === 'newUdf'
              || active.kind === 'trigger' || active.kind === 'newTrigger') && (
              <ScriptGate kind={active.kind} db={active.db} container={active.container} scriptName={active.scriptName} />
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

/** Connect card → live account-info surface (real document endpoint). */
function ConnectPanel() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Connect</MessageBarTitle>
          The account chip in the Data Explorer pane shows the live account name + region from{' '}
          <code>/api/cosmos/account</code> (the real <code>documentEndpoint</code> on{' '}
          <code>documents.azure.com</code>). Loom drives the data plane with the Console managed
          identity (AAD token), so there is no key/connection-string to copy — the SDK connect
          pattern is <code>new CosmosClient(endpoint, new DefaultAzureCredential())</code>.
        </MessageBarBody>
      </MessageBar>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        Account keys are intentionally not surfaced here; Loom uses RBAC (AAD) data-plane access, not
        primary keys, per the deployment&apos;s security posture.
      </Caption1>
    </div>
  );
}

/** Honest gate for script authoring/viewing (no data-plane script route yet). */
function ScriptGate({ kind, db, container, scriptName }: { kind: CosmosAction; db?: string; container?: string; scriptName?: string }) {
  const isNew = kind === 'newStoredProcedure' || kind === 'newUdf' || kind === 'newTrigger';
  const noun =
    kind === 'newStoredProcedure' || kind === 'storedProcedure' ? 'stored procedure'
      : kind === 'newUdf' || kind === 'udf' ? 'user-defined function'
        : 'trigger';
  const restLeaf =
    noun === 'stored procedure' ? 'storedProcedures'
      : noun === 'user-defined function' ? 'userDefinedFunctions' : 'triggers';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>
            {isNew ? `New ${noun}` : scriptName} — script authoring not yet wired
          </MessageBarTitle>
          The studio opens a Monaco JS editor here to {isNew ? 'create' : 'view, edit, or execute'} the{' '}
          {noun}{scriptName ? <> <code>{scriptName}</code></> : null}
          {container ? <> on container <code>{db}/{container}</code></> : null}. The navigator already
          <strong> lists</strong> existing scripts (read-only) from{' '}
          <code>…/containers/{container || '{container}'}/{restLeaf}</code>; create/edit/execute needs a
          script read+write route (data-plane <code>/{restLeaf}</code> + <code>x-ms-documentdb</code>
          headers). Not wired yet — surfaced honestly per no-vaporware.md rather than faked.
        </MessageBarBody>
      </MessageBar>
    </div>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
      <MessageBar intent={endpoint ? 'info' : 'warning'}>
        <MessageBarBody>
          <MessageBarTitle>Cosmos Gremlin (graph) API</MessageBarTitle>
          {endpoint ? (
            <>Connected to <code>{endpoint}</code> (server-bound via <code>LOOM_COSMOS_GREMLIN_ENDPOINT</code>).
              Run a traversal below — <code>g.V()</code>/<code>g.E()</code> results render on the
              force-directed canvas; <code>addV</code>/<code>addE</code> persist to the live graph.</>
          ) : (
            <>No Gremlin runtime endpoint is bound. The Gremlin API needs a dedicated
              <strong> EnableGremlin</strong> account (deploy{' '}
              <code>cosmos-graph-vector.bicep</code>), then set <code>LOOM_COSMOS_GREMLIN_ENDPOINT</code>
              {' '}on the Console Container App. The canvas below still renders and reports the precise
              gate returned by the backend.</>
          )}
        </MessageBarBody>
      </MessageBar>
      <GremlinGraphCanvas itemId={id} />
    </div>
  );
}
