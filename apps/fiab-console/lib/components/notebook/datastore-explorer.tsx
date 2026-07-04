'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * DatastoreExplorer — the AML notebook path's "Data" sidebar.
 *
 * Mirrors the Azure ML studio "Data > Datastores" pane: lists the workspace's
 * datastores (real ARM via /api/aml/datastores) with their type + default
 * badge, and lets the user INSERT the datastore's abfss:// / wasbs:// path into
 * the active notebook cell — by click OR by dragging the tree item onto a code
 * cell (HTML5 drag, text/plain = the path).
 *
 * Honest gate: when the AML workspace isn't configured the route returns
 * { ok: false, configured: false, hint } and we render a Fluent MessageBar
 * naming the exact env vars to set. The surface still renders. No Fabric
 * dependency anywhere on this path.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Spinner, Tree, TreeItem, TreeItemLayout,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Database20Regular, ArrowSync16Regular, Storage20Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalSNudge, marginTop: tokens.spacingVerticalL },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge, width: '100%' },
  path: {
    fontFamily: 'Consolas, monospace', fontSize: '11px',
    color: tokens.colorNeutralForeground3, wordBreak: 'break-all',
  },
  item: { cursor: 'grab' },
});

export interface DatastoreLite {
  name: string;
  datastoreType: string;
  isDefault?: boolean;
  accountName?: string;
  containerName?: string;
  filesystem?: string;
  path: string | null;       // abfss:// or wasbs:// — null for types with no fs path
  abfssPath?: string | null;
  wasbsPath?: string | null;
}

interface Props {
  /** Insert a path string into the active cell (called on click + on drag-drop). */
  onInsertPath: (path: string) => void;
}

export function DatastoreExplorer({ onInsertPath }: Props) {
  const s = useStyles();
  const [stores, setStores] = useState<DatastoreLite[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setHint(null);
    try {
      const r = await clientFetch('/api/aml/datastores');
      const j = await r.json();
      if (j.ok) {
        setStores(j.datastores || []);
        setConfigured(true);
      } else {
        setStores([]);
        setConfigured(j.configured !== false ? true : false);
        setError(j.error || 'Could not list datastores');
        setHint(j.hint || null);
      }
    } catch (e: any) {
      setStores([]); setError(e?.message || String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className={s.wrap}>
      <div className={s.head}>
        <Database20Regular />
        <Subtitle2 style={{ flex: 1 }}>Datastores</Subtitle2>
        <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={load} title="Refresh datastores" />
      </div>

      {loading && <Spinner size="tiny" label="Loading datastores…" />}

      {!loading && !configured && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Azure ML workspace not configured</MessageBarTitle>
            {hint || 'Set LOOM_AML_WORKSPACE + LOOM_AML_REGION to a deployed Azure Machine Learning workspace (deploy-planner mlWorkspace module provisions one), then grant the Console UAMI AzureML Data Scientist.'}
          </MessageBarBody>
        </MessageBar>
      )}

      {!loading && configured && error && (
        <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
      )}

      {!loading && configured && !error && stores && stores.length === 0 && (
        <Caption1>No datastores in this workspace yet.</Caption1>
      )}

      {!loading && configured && stores && stores.length > 0 && (
        <>
          <Caption1>Click or drag a path into a code cell.</Caption1>
          <Tree aria-label="Datastores">
            {stores.map((d) => {
              const insert = d.path || `# ${d.name} (${d.datastoreType}) — no abfss/wasbs path`;
              const draggable = !!d.path;
              return (
                <TreeItem key={d.name} itemType="leaf" value={d.name}>
                  <TreeItemLayout
                    iconBefore={<Storage20Regular />}
                    className={draggable ? s.item : undefined}
                    onClick={() => d.path && onInsertPath(d.path)}
                    {...(draggable ? {
                      draggable: true,
                      onDragStart: (e: React.DragEvent) => {
                        e.dataTransfer.setData('text/plain', d.path!);
                        e.dataTransfer.effectAllowed = 'copy';
                      },
                    } : {})}
                  >
                    <div className={s.row}>
                      <span style={{ flex: 1 }}>
                        {d.isDefault ? <strong>{d.name}</strong> : d.name}
                        {d.isDefault && <Badge appearance="outline" color="brand" size="small" style={{ marginLeft: tokens.spacingHorizontalSNudge }}>default</Badge>}
                        <Badge appearance="tint" color="informative" size="small" style={{ marginLeft: tokens.spacingHorizontalSNudge }}>{d.datastoreType}</Badge>
                      </span>
                    </div>
                  </TreeItemLayout>
                  {d.path && <div className={s.path} style={{ paddingLeft: tokens.spacingHorizontalXXXL }}>{d.path}</div>}
                </TreeItem>
              );
            })}
          </Tree>
        </>
      )}
    </div>
  );
}
