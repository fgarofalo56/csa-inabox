'use client';

/**
 * Azure Cosmos DB account editor (parity wave 7 + Items Data Explorer).
 *
 * Hosts the CosmosTree Data Explorer navigator (left pane) — databases →
 * containers → stored procedures / triggers / UDFs — over the env-pinned
 * navigator account (LOOM_COSMOS_ACCOUNT, distinct from Loom's own store).
 *
 * The main pane is a two-tab surface mirroring the portal Data Explorer:
 *   - Properties  : the selected database/container's control-plane shape
 *   - Data Explorer (Items) : a real data-plane query grid + JSON CRUD over the
 *     selected container's documents (POST /api/cosmos/items + .../action).
 *
 * Every list/create/delete (control plane) runs on the real ARM REST through
 * /api/cosmos/*; every query / item read-write (data plane) runs on the real
 * Cosmos data plane (documents.azure.com) — no fakes. When the UAMI lacks the
 * data-plane RBAC role the Items tab renders an honest MessageBar naming the
 * role to grant (full surface still renders).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Caption1, Subtitle2, Badge, Button, Divider,
  Tab, TabList,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add20Regular, ArrowSync20Regular, Delete20Regular } from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { CosmosTree, type CosmosSelection } from '@/lib/components/cosmos/cosmos-tree';
import { CosmosDataExplorer } from '@/lib/components/cosmos/cosmos-data-explorer';

const useStyles = makeStyles({
  pad: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', height: '100%', minHeight: '0' },
  tabBody: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' },
  kv: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', alignItems: 'center' },
  k: { color: tokens.colorNeutralForeground3 },
});

type MainTab = 'properties' | 'items';

export function CosmosAccountEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [refreshKey, setRefreshKey] = useState(0);
  const [selected, setSelected] = useState<CosmosSelection | null>(null);
  const [tab, setTab] = useState<MainTab>('properties');

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  // When a container is selected, jump to the Items tab (portal behavior).
  // Selecting a database (no container) returns focus to Properties.
  useEffect(() => {
    if (selected?.container) setTab('items');
    else setTab('properties');
  }, [selected?.db, selected?.container]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Data Explorer', actions: [
        { label: 'Refresh', icon: <ArrowSync20Regular />, onClick: refresh },
      ]},
    ]},
  ], [refresh]);

  const hasContainer = Boolean(selected?.container);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      leftPanel={
        <CosmosTree refreshKey={refreshKey} onSelect={(sel) => setSelected(sel)} />
      }
      main={
        <div className={s.pad}>
          <TabList
            selectedValue={tab}
            onTabSelect={(_, d) => setTab(d.value as MainTab)}
          >
            <Tab value="properties">Properties</Tab>
            <Tab value="items" disabled={!hasContainer}>Data Explorer (Items)</Tab>
          </TabList>

          {tab === 'properties' && (
            <div className={s.tabBody} style={{ gap: 12 }}>
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>Cosmos DB account navigator</MessageBarTitle>
                  The left pane is a live Data Explorer over the env-pinned account
                  (<code>LOOM_COSMOS_ACCOUNT</code> — distinct from Loom&apos;s own
                  store). Databases, containers, throughput (RU/s), and server-side
                  scripts come from the real ARM control plane
                  (<code>Microsoft.DocumentDB/databaseAccounts</code>, api-version
                  2024-11-15). Select a container to query and edit its documents on
                  the <strong>Data Explorer (Items)</strong> tab — backed by the real
                  Cosmos data plane. When the account isn&apos;t configured the
                  navigator shows an honest infra-gate naming the env var + role.
                </MessageBarBody>
              </MessageBar>

              {selected ? (
                <div>
                  <Subtitle2>{selected.container ? `Container: ${selected.container}` : `Database: ${selected.db}`}</Subtitle2>
                  <Divider style={{ margin: '8px 0' }} />
                  <div className={s.kv}>
                    <span className={s.k}>Database</span><span><code>{selected.db}</code></span>
                    {selected.container && (<><span className={s.k}>Container</span><span><code>{selected.container}</code></span></>)}
                    {selected.partitionKey && (<><span className={s.k}>Partition key</span><span><code>{selected.partitionKey}</code></span></>)}
                  </div>
                  {selected.container && (
                    <Button
                      appearance="primary" size="small" style={{ marginTop: 12 }}
                      onClick={() => setTab('items')}
                    >
                      Open Data Explorer (Items)
                    </Button>
                  )}
                  <Caption1 style={{ display: 'block', marginTop: 12, color: tokens.colorNeutralForeground3 }}>
                    Use the tree to create (<Add20Regular fontSize={12} style={{ verticalAlign: 'middle' }} />) or
                    delete (<Delete20Regular fontSize={12} style={{ verticalAlign: 'middle' }} />) databases and
                    containers, and to browse stored procedures, triggers, and UDFs. The indexing /
                    conflict-resolution policy editors are disclosed as honest &quot;coming&quot; rows under the
                    tree&apos;s <strong>Not yet wired</strong> node.
                  </Caption1>
                </div>
              ) : (
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  Select a database or container in the Data Explorer to see its properties.
                </Caption1>
              )}
            </div>
          )}

          {tab === 'items' && (
            <div className={s.tabBody}>
              {hasContainer ? (
                <CosmosDataExplorer
                  key={`${selected!.db}|${selected!.container}`}
                  db={selected!.db}
                  container={selected!.container as string}
                  partitionKey={selected!.partitionKey}
                />
              ) : (
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  Select a container in the Data Explorer tree to browse its documents.
                </Caption1>
              )}
            </div>
          )}
        </div>
      }
    />
  );
}
