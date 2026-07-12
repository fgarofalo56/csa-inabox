'use client';

/**
 * /connections — Loom Connections: reusable, Key Vault-backed data-source
 * connections used by mirroring, ADF/Synapse linked services, and datasets.
 * Enter creds once → the secret lands in Key Vault (only a secretRef is stored).
 * Fluent v9 + Loom tokens; the shared LoomDataTable + the ConnectionBuilder dialog.
 *
 * A Tile | List ViewToggle (tile = ItemTile/TileGrid, list = LoomDataTable)
 * matches the collection surfaces across Loom (/browse, /workspaces, /onelake).
 * The view choice persists per-page to localStorage.
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Caption1, Badge, Button, Spinner, MessageBar, MessageBarBody,
  MessageBarTitle, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  Text, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  PlugConnected24Regular, Add20Regular, Delete20Regular, Key16Regular, ShieldKeyhole16Regular,
  MoreHorizontal20Regular, CloudDatabase20Regular, LinkMultiple20Regular, Table20Regular,
  Edit20Regular, DatabaseSearch20Regular, PlugConnectedCheckmark20Regular,
} from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { ViewToggle, type LoomView } from '@/lib/components/ui/view-toggle';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { useConfirm } from '@/lib/components/confirm-dialog';
import { ConnectionBuilder, type ConnectionView } from '@/lib/components/connections/connection-builder';
import { AnalyzeConnectionDialog } from '@/lib/components/connections/analyze-connection-dialog';
import { AddExistingConnectionWizard } from '@/lib/components/connections/add-existing-wizard';
import type { ConnectionType } from '@/lib/azure/connections-store';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { GuidedEmptyState, type GuidedPath } from '@/lib/components/shared/guided-empty-state';
import { ToolbarCrossLinks, type CrossLink } from '@/lib/components/shared/item-tab-strip';
import { accentForIndex, LOOM_ACCENT } from '@/lib/components/shared/accent-tokens';

const LS_VIEW = 'loom.connections.viewMode.v1';

/** An item that still binds a connection (from GET /api/connections/[id]/dependents). */
interface ConnectionDependent { id: string; itemType: string; displayName: string; workspaceId?: string }

const useStyles = makeStyles({
  loadingBox: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: tokens.spacingVerticalXXXL,
    minHeight: '200px',
  },
  authLine: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  tileFooter: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  hostCode: {
    fontSize: tokens.fontSizeBase100,
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    maxWidth: '100%',
    display: 'inline-block',
  },
  typeIcon: { fontSize: tokens.fontSizeBase400 },
  confirmBody: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  depList: { margin: 0, paddingLeft: tokens.spacingHorizontalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
});

const TYPE_LABEL: Record<string, string> = {
  'azure-sql': 'Azure SQL', 'synapse-dedicated': 'Synapse Dedicated', 'synapse-serverless': 'Synapse Serverless',
  'databricks-sql': 'Databricks SQL', 'postgres': 'PostgreSQL', 'storage-adls': 'ADLS / Storage', 'cosmos': 'Cosmos DB', 'generic-sql': 'SQL Server',
  'event-hub': 'Event Hubs', 'service-bus': 'Service Bus', 'key-vault': 'Key Vault',
};
const METHOD_LABEL: Record<string, string> = {
  'entra-mi': 'Managed identity', 'sql-password': 'SQL password', 'connection-string': 'Connection string',
  'account-key': 'Account key', 'service-principal': 'Service principal',
};

/**
 * Connection-type → item-type-visual slug, so a tile / list row reuses the
 * existing visual registry (icon + brand colour) instead of inventing a slug.
 */
const CONN_TILE_TYPE: Record<string, string> = {
  'azure-sql': 'azure-sql-database',
  'generic-sql': 'azure-sql-database',
  'synapse-dedicated': 'synapse-dedicated-sql-pool',
  'synapse-serverless': 'synapse-serverless-sql-pool',
  'databricks-sql': 'databricks-sql-warehouse',
  'cosmos': 'cosmos-account',
  'storage-adls': 'storage-adls',
  'postgres': 'postgres',
  'event-hub': 'event-hub',
  'service-bus': 'service-bus',
  'key-vault': 'key-vault',
};

export default function ConnectionsPage() {
  const s = useStyles();
  const { confirm, dialog } = useConfirm();
  const [conns, setConns] = useState<ConnectionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [presetType, setPresetType] = useState<string | undefined>(undefined);
  const [addExistingOpen, setAddExistingOpen] = useState(false);
  const [view, setView] = useState<LoomView>('tile');
  // Edit + Analyze (browse/preview) dialogs for a saved connection.
  const [editConn, setEditConn] = useState<ConnectionView | null>(null);
  const [analyzeConn, setAnalyzeConn] = useState<ConnectionView | null>(null);
  // Inline "Test connection" state — a real reachability probe per saved connection.
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; name: string; ok: boolean; detail: string } | null>(null);

  // Open the builder, optionally locked to a connector type chosen from the
  // guided connector gallery (Fabric "Get data" per-source parity, UX-1008 SC-4).
  const openBuilder = useCallback((type?: string) => {
    setPresetType(type);
    setBuilderOpen(true);
  }, []);
  const closeBuilder = useCallback(() => {
    setBuilderOpen(false);
    setPresetType(undefined);
  }, []);

  // Hydrate + persist the view choice (SSR-safe; ignore quota / private mode).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LS_VIEW);
      if (raw === 'tile' || raw === 'list') setView(raw);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem(LS_VIEW, view); } catch { /* ignore */ }
  }, [view]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await clientFetch('/api/connections');
      const j = await r.json();
      if (!r.ok || j?.ok === false) { setError(j?.error || `HTTP ${r.status}`); setConns([]); return; }
      setConns(j.connections || []);
    } catch (e: any) { setError(e?.message || String(e)); setConns([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const remove = useCallback(async (c: ConnectionView) => {
    // Pre-fetch dependents so the themed confirm dialog can LIST what still binds
    // this connection (Azure-parity "in use" disclosure). The DELETE route also
    // enforces a 409 server-side, so this is disclosure + a friendlier gate — the
    // server stays authoritative even if this check races.
    let dependents: ConnectionDependent[] = [];
    try {
      const r = await clientFetch(`/api/connections/${encodeURIComponent(c.id)}/dependents`);
      const j = await r.json();
      if (r.ok && j?.ok) dependents = Array.isArray(j.dependents) ? j.dependents : [];
    } catch { /* fall through — the DELETE 409 guard is authoritative */ }

    const inUse = dependents.length > 0;
    const body = inUse ? (
      <div className={s.confirmBody}>
        <Text>
          <strong>{c.name}</strong> is still used by {dependents.length} item{dependents.length !== 1 ? 's' : ''}.
          Remove these references first — deleting it would orphan them and drop its Key Vault secret.
        </Text>
        <MessageBar intent="warning">
          <MessageBarBody>
            <ul className={s.depList}>
              {dependents.map((d) => (
                <li key={d.id}>{d.displayName} <Caption1>({d.itemType})</Caption1></li>
              ))}
            </ul>
          </MessageBarBody>
        </MessageBar>
      </div>
    ) : (
      <Text>Delete connection <strong>{c.name}</strong>? Its Key Vault secret is also removed. This can’t be undone.</Text>
    );

    await confirm({
      title: inUse ? 'Connection in use' : 'Delete connection?',
      body,
      danger: true,
      confirmLabel: 'Delete',
      onConfirm: async () => {
        const r = await clientFetch(`/api/connections?id=${encodeURIComponent(c.id)}`, { method: 'DELETE' });
        const j = await r.json().catch(() => ({} as any));
        if (!r.ok || j?.ok === false) {
          // Surface the server's honest message (incl. the referential-integrity
          // 409) inline in the dialog — never a silent failure.
          throw new Error(j?.error || `Delete failed (HTTP ${r.status}).`);
        }
        await load();
      },
    });
  }, [confirm, load, s]);

  // Real reachability probe for a SAVED connection (POST /api/connections/[id]/test).
  // Result is surfaced inline via a MessageBar — never a silent no-op.
  const testConn = useCallback(async (c: ConnectionView) => {
    setTestingId(c.id);
    setTestResult(null);
    try {
      const r = await clientFetch(`/api/connections/${encodeURIComponent(c.id)}/test`, { method: 'POST' });
      const j = await r.json().catch(() => ({} as any));
      if (!r.ok || j?.ok === false) {
        const hint = j?.hint ? ` — ${j.hint}` : '';
        setTestResult({ id: c.id, name: c.name, ok: false, detail: `${j?.error || `HTTP ${r.status}`}${hint}` });
      } else {
        setTestResult({ id: c.id, name: c.name, ok: true, detail: j?.detail || 'Connection reachable.' });
      }
    } catch (e: any) {
      setTestResult({ id: c.id, name: c.name, ok: false, detail: e?.message || String(e) });
    } finally {
      setTestingId(null);
    }
  }, []);

  // Connection types with a browsable, tabular schema (the Analyze dialog reads
  // these). ADLS/Storage + non-tabular types (Event Hubs / Service Bus / Key
  // Vault) have no SQL-style tree, so "Analyze data" isn't offered for them.
  const analyzable = useCallback(
    (t: string) => ['azure-sql', 'synapse-dedicated', 'synapse-serverless', 'generic-sql', 'databricks-sql', 'postgres', 'cosmos', 'adx'].includes(t),
    [],
  );

  // Shared per-connection action menu — reused by the list row and the tile.
  const connActions = useCallback((c: ConnectionView) => (
    <MenuList>
      <MenuItem icon={<PlugConnectedCheckmark20Regular />} onClick={() => void testConn(c)}>Test connection</MenuItem>
      <MenuItem icon={<Edit20Regular />} onClick={() => setEditConn(c)}>Edit</MenuItem>
      {analyzable(c.type) && (
        <MenuItem icon={<DatabaseSearch20Regular />} onClick={() => setAnalyzeConn(c)}>Analyze data</MenuItem>
      )}
      <MenuItem icon={<Delete20Regular />} onClick={() => remove(c)}>Delete</MenuItem>
    </MenuList>
  ), [analyzable, testConn, remove]);

  const columns: LoomColumn<ConnectionView>[] = [
    { key: 'name', label: 'Name', sortable: true, filterable: true, getValue: (c) => c.name, render: (c) => <strong>{c.name}</strong> },
    {
      key: 'type', label: 'Type', sortable: true, filterable: true, getValue: (c) => TYPE_LABEL[c.type] || c.type,
      render: (c) => {
        const TypeIcon = itemVisual(CONN_TILE_TYPE[c.type] ?? c.type).icon;
        return (
          <span className={s.authLine}>
            <TypeIcon className={s.typeIcon} />
            <Badge appearance="tint" color="brand" size="small">{TYPE_LABEL[c.type] || c.type}</Badge>
          </span>
        );
      },
    },
    {
      key: 'authMethod', label: 'Auth', sortable: true, filterable: true, getValue: (c) => METHOD_LABEL[c.authMethod] || c.authMethod,
      render: (c) => (
        <span className={s.authLine}>
          {c.hasSecret ? <Key16Regular /> : <ShieldKeyhole16Regular />}
          <Caption1>{METHOD_LABEL[c.authMethod] || c.authMethod}</Caption1>
          {c.hasSecret && <Badge appearance="outline" size="small" color="success">Key Vault</Badge>}
        </span>
      ),
    },
    { key: 'host', label: 'Host', sortable: true, filterable: true, getValue: (c) => c.host || '—', render: (c) => <code className={s.hostCode}>{c.host || '—'}</code> },
    { key: 'database', label: 'Database', sortable: true, filterable: true, getValue: (c) => c.database || '—', render: (c) => c.database || '—' },
    {
      key: 'actions', label: '', sortable: false, filterable: false, width: 120,
      render: (c) => (
        <span className={s.authLine}>
          <Button
            size="small" appearance="subtle"
            icon={testingId === c.id ? <Spinner size="tiny" /> : <PlugConnectedCheckmark20Regular />}
            disabled={testingId === c.id}
            onClick={() => void testConn(c)}
            aria-label={`Test ${c.name}`}
          />
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button size="small" appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label={`Actions for ${c.name}`} />
            </MenuTrigger>
            <MenuPopover>{connActions(c)}</MenuPopover>
          </Menu>
        </span>
      ),
    },
  ];

  const hasRows = !!conns && conns.length > 0;

  // Guided connector gallery — one card per common data source, each opening the
  // ConnectionBuilder locked to that type (Fabric "Get data" source-picker parity).
  const galleryPaths = useMemo<GuidedPath[]>(() => {
    const GALLERY: string[] = [
      'azure-sql', 'storage-adls', 'databricks-sql', 'synapse-serverless',
      'cosmos', 'postgres', 'event-hub', 'key-vault',
    ];
    const sourceCards: GuidedPath[] = GALLERY.map((t, i) => ({
      key: t,
      title: TYPE_LABEL[t] || t,
      body: `Connect to ${TYPE_LABEL[t] || t} — credentials land in Key Vault.`,
      icon: itemVisual(CONN_TILE_TYPE[t] ?? t).icon,
      accent: accentForIndex(i),
      onClick: () => openBuilder(t),
    }));
    return [
      ...sourceCards,
      {
        key: 'add-existing',
        title: 'Add an existing connection',
        body: 'Import a data source already provisioned in your Azure subscription.',
        icon: CloudDatabase20Regular,
        accent: LOOM_ACCENT.blue,
        onClick: () => setAddExistingOpen(true),
      },
    ];
  }, [openBuilder]);

  return (
    <PageShell
      title="Connections"
      subtitle="Reusable, Key Vault-backed connections to your data sources — credentials entered once, reused by mirroring, ADF / Synapse linked services, and datasets."
      actions={
        <>
          <Button appearance="primary" icon={<Add20Regular />} onClick={() => openBuilder()}>New connection</Button>
          <Button appearance="secondary" icon={<CloudDatabase20Regular />} onClick={() => setAddExistingOpen(true)}>Add existing</Button>
        </>
      }
    >
      <ToolbarCrossLinks
        ariaLabel="Related surfaces"
        links={[
          { key: 'onelake', label: 'OneLake catalog', icon: <CloudDatabase20Regular />, href: '/onelake' },
          { key: 'marketplace', label: 'Marketplace', icon: <LinkMultiple20Regular />, href: '/marketplace' },
          { key: 'browse', label: 'Browse items', icon: <Table20Regular />, href: '/browse' },
        ] satisfies CrossLink[]}
      />
      <TeachingBanner
        surfaceKey="connections-hub"
        title="Enter credentials once, reuse everywhere"
        message="A connection stores how to reach a data source — the secret goes into Key Vault and only a reference is kept here. Mirroring, ADF / Synapse linked services and datasets all reuse these connections, so you never re-enter a password. Pick a source from the gallery to get started."
        accent={LOOM_ACCENT.teal}
        learnMoreHref="https://learn.microsoft.com/fabric/data-factory/connector-overview"
      />

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load connections</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {testResult && (
        <MessageBar
          intent={testResult.ok ? 'success' : 'error'}
          layout="multiline"
          politeness="assertive"
        >
          <MessageBarBody>
            <MessageBarTitle>
              {testResult.ok ? 'Connection reachable' : 'Connection test failed'} — {testResult.name}
            </MessageBarTitle>
            {testResult.detail}
          </MessageBarBody>
          <Button size="small" appearance="transparent" onClick={() => setTestResult(null)}>Dismiss</Button>
        </MessageBar>
      )}

      <Section
        title="Data source connections"
        actions={
          hasRows ? <ViewToggle value={view} onChange={setView} ariaLabel="Connection view" /> : undefined
        }
        bare={view === 'tile' && hasRows}
      >
        {conns == null ? (
          <div className={s.loadingBox}>
            <Spinner label="Loading connections…" />
          </div>
        ) : !hasRows ? (
          <GuidedEmptyState
            title="Connect a data source"
            intro="Pick a source to open the connection builder — or add a connection someone already provisioned in Azure. Credentials are stored in Key Vault; only a reference is kept here."
            heroIcon={PlugConnected24Regular}
            paths={galleryPaths}
            learnMoreHref="https://learn.microsoft.com/fabric/data-factory/connector-overview"
            ariaLabel="Connector gallery"
          />
        ) : view === 'tile' ? (
          <TileGrid>
            {conns.map((c) => (
              <ItemTile
                key={c.id}
                type={CONN_TILE_TYPE[c.type] ?? c.type}
                title={c.name}
                subtitle={TYPE_LABEL[c.type] || c.type}
                meta={c.host || '—'}
                badge={c.hasSecret ? <Badge appearance="outline" size="small" color="success">Key Vault</Badge> : undefined}
                overflowMenu={
                  <Menu>
                    <MenuTrigger disableButtonEnhancement>
                      <Button size="small" appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label={`Actions for ${c.name}`} />
                    </MenuTrigger>
                    <MenuPopover>{connActions(c)}</MenuPopover>
                  </Menu>
                }
                footer={
                  <span className={s.tileFooter}>
                    {c.hasSecret ? <Key16Regular /> : <ShieldKeyhole16Regular />}
                    <Caption1>{METHOD_LABEL[c.authMethod] || c.authMethod}</Caption1>
                    {c.database && <Badge appearance="outline" size="small">{c.database}</Badge>}
                  </span>
                }
              />
            ))}
          </TileGrid>
        ) : (
          <LoomDataTable<ConnectionView>
            columns={columns}
            rows={conns}
            getRowId={(c) => c.id}
            empty="No connections yet. Click “New connection” to create a Key Vault-backed connection."
          />
        )}
      </Section>

      <ConnectionBuilder open={builderOpen} lockType={presetType} onClose={closeBuilder} onCreated={() => void load()} />
      <ConnectionBuilder
        open={!!editConn}
        editConnection={editConn ?? undefined}
        onClose={() => setEditConn(null)}
        onSaved={() => { setEditConn(null); void load(); }}
      />
      <AddExistingConnectionWizard open={addExistingOpen} onClose={() => setAddExistingOpen(false)} onImported={() => void load()} />
      {analyzeConn && (
        <AnalyzeConnectionDialog
          open={!!analyzeConn}
          connectionId={analyzeConn.id}
          connectionName={analyzeConn.name}
          connType={analyzeConn.type as ConnectionType}
          onDismiss={() => setAnalyzeConn(null)}
        />
      )}
      {dialog}
    </PageShell>
  );
}
