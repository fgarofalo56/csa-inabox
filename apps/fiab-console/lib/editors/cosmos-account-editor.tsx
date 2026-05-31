'use client';

/**
 * Azure Cosmos DB account editor (parity wave 7).
 *
 * Hosts the CosmosTree Data Explorer navigator (left pane) — databases →
 * containers → stored procedures / triggers / UDFs — over the env-pinned
 * navigator account (LOOM_COSMOS_ACCOUNT, distinct from Loom's own store).
 *
 * The main pane shows the selected database/container's properties (real ARM
 * shape surfaced by the navigator routes) plus an honest disclosure of which
 * portal Data Explorer surfaces are wired vs. coming. Every list/create/delete
 * runs on the real ARM control plane through /api/cosmos/* — no fakes.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  Caption1, Subtitle2, Badge, Button, Divider,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add20Regular, ArrowSync20Regular, Delete20Regular } from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { CosmosTree } from '@/lib/components/cosmos/cosmos-tree';

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12 },
  kv: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', alignItems: 'center' },
  k: { color: tokens.colorNeutralForeground3 },
});

export function CosmosAccountEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [refreshKey, setRefreshKey] = useState(0);
  const [selected, setSelected] = useState<{ db: string; container?: string } | null>(null);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Data Explorer', actions: [
        { label: 'Refresh', icon: <ArrowSync20Regular />, onClick: refresh },
      ]},
    ]},
  ], [refresh]);

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
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>Cosmos DB account navigator</MessageBarTitle>
              The left pane is a live Data Explorer over the env-pinned account
              (<code>LOOM_COSMOS_ACCOUNT</code> — distinct from Loom&apos;s own
              store). Databases, containers, throughput (RU/s), and server-side
              scripts come from the real ARM control plane
              (<code>Microsoft.DocumentDB/databaseAccounts</code>, api-version
              2024-11-15). When the account isn&apos;t configured the navigator
              shows an honest infra-gate naming the env var + role.
            </MessageBarBody>
          </MessageBar>

          {selected ? (
            <div>
              <Subtitle2>{selected.container ? `Container: ${selected.container}` : `Database: ${selected.db}`}</Subtitle2>
              <Divider style={{ margin: '8px 0' }} />
              <div className={s.kv}>
                <span className={s.k}>Database</span><span><code>{selected.db}</code></span>
                {selected.container && (<><span className={s.k}>Container</span><span><code>{selected.container}</code></span></>)}
              </div>
              <Caption1 style={{ display: 'block', marginTop: 12, color: tokens.colorNeutralForeground3 }}>
                Use the tree to create (<Add20Regular fontSize={12} style={{ verticalAlign: 'middle' }} />) or
                delete (<Delete20Regular fontSize={12} style={{ verticalAlign: 'middle' }} />) databases and
                containers, and to browse stored procedures, triggers, and UDFs. The document grid + indexing /
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
      }
    />
  );
}
