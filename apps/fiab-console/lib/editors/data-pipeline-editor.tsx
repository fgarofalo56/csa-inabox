'use client';

/**
 * DataPipelineEditor — React-Flow-style canvas with activity palette.
 * Uses styled divs as nodes (no React Flow dep). Palette categorizes
 * the 33 pipeline activities from datapipeline-definition into the
 * 6 groups described in the inventory.
 */

import { useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const PALETTE: { group: string; items: string[] }[] = [
  { group: 'Move & transform', items: ['Copy', 'InvokeCopyJob', 'RefreshDataFlow', 'Script', 'DataLakeAnalyticsScope'] },
  { group: 'General', items: ['WebActivity', 'Lookup', 'GetMetadata', 'Wait', 'Fail', 'SetVariable', 'AppendVariable'] },
  { group: 'Orchestration', items: ['ExecutePipeline', 'TridentNotebook', 'SparkJobDefinition', 'AzureFunction', 'Custom', 'WebHook'] },
  { group: 'Iteration & conditionals', items: ['IfCondition', 'Switch', 'ForEach', 'Until', 'Filter'] },
  { group: 'Databricks / HDInsight', items: ['DatabricksNotebook', 'AzureHDInsight', 'AzureMLExecutePipeline'] },
  { group: 'SQL / SSIS', items: ['SqlServerStoredProcedure', 'ExecuteSSISPackage', 'Delete', 'KustoQueryLanguage'] },
  { group: 'Notifications', items: ['Email', 'Office365Email', 'MicrosoftTeams', 'Teams', 'PBISemanticModelRefresh'] },
];

interface CanvasNode {
  id: string;
  type: string;
  x: number;
  y: number;
}

const STARTER_NODES: CanvasNode[] = [
  { id: 'n1', type: 'Lookup', x: 60, y: 80 },
  { id: 'n2', type: 'ForEach', x: 260, y: 80 },
  { id: 'n3', type: 'Copy', x: 460, y: 80 },
  { id: 'n4', type: 'SqlServerStoredProcedure', x: 660, y: 80 },
];

const useStyles = makeStyles({
  layout: { display: 'grid', gridTemplateColumns: '240px 1fr', height: '100%', minHeight: '500px' },
  palette: {
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    padding: '12px',
    overflow: 'auto',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  paletteGroup: { marginBottom: '12px' },
  paletteItem: {
    display: 'block',
    padding: '6px 8px',
    border: `1px solid ${tokens.colorNeutralStroke3}`,
    borderRadius: '4px',
    marginTop: '4px',
    cursor: 'grab',
    backgroundColor: tokens.colorNeutralBackground1,
    fontSize: '12px',
    ':hover': { borderColor: tokens.colorBrandStroke1 },
  },
  canvas: {
    position: 'relative',
    backgroundColor: tokens.colorNeutralBackground3,
    backgroundImage: `radial-gradient(${tokens.colorNeutralStroke3} 1px, transparent 1px)`,
    backgroundSize: '20px 20px',
    overflow: 'auto',
    minHeight: '500px',
  },
  node: {
    position: 'absolute',
    width: '160px',
    minHeight: '60px',
    padding: '10px 12px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorBrandStroke1}`,
    borderRadius: '6px',
    boxShadow: tokens.shadow4,
    cursor: 'grab',
  },
  edge: {
    position: 'absolute',
    height: '2px',
    backgroundColor: tokens.colorBrandStroke1,
    transformOrigin: '0 0',
  },
});

const RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Activities', actions: [{ label: 'Add activity' }, { label: 'Copy' }, { label: 'Notebook' }, { label: 'Pipeline' }] },
    { label: 'Run', actions: [{ label: 'Run' }, { label: 'Debug' }, { label: 'Schedule' }, { label: 'Triggers' }] },
    { label: 'View', actions: [{ label: 'Variables' }, { label: 'Parameters' }, { label: 'Output' }] },
  ]},
  { id: 'view', label: 'View', groups: [
    { label: 'Layout', actions: [{ label: 'Auto-layout' }, { label: 'Zoom to fit' }, { label: 'Validate' }] },
  ]},
];

interface Props { item: FabricItemType; id: string; }

export function DataPipelineEditor({ item, id }: Props) {
  const styles = useStyles();
  const [nodes] = useState<CanvasNode[]>(STARTER_NODES);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={RIBBON}
      main={
        <div className={styles.layout}>
          <aside className={styles.palette} aria-label="Activity palette">
            <Subtitle2>Activities</Subtitle2>
            {PALETTE.map((g) => (
              <div key={g.group} className={styles.paletteGroup}>
                <Caption1 style={{ color: tokens.colorNeutralForeground3, textTransform: 'uppercase' }}>{g.group}</Caption1>
                {g.items.map((act) => (
                  <span key={act} className={styles.paletteItem} draggable>{act}</span>
                ))}
              </div>
            ))}
          </aside>
          <div className={styles.canvas} role="region" aria-label="Pipeline canvas">
            {nodes.map((n, i) => (
              <div key={n.id} className={styles.node} style={{ left: n.x, top: n.y }}>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{n.type}</Caption1>
                <Body1 style={{ fontWeight: 600 }}>{n.type === 'Copy' ? 'Copy customers' : n.type}</Body1>
                {i < nodes.length - 1 && (
                  <div className={styles.edge} style={{ left: 160, top: 30, width: 40 }} />
                )}
              </div>
            ))}
            <div style={{ position: 'absolute', bottom: 16, right: 16 }}>
              <Badge appearance="filled">{nodes.length} activities · valid</Badge>
            </div>
          </div>
        </div>
      }
    />
  );
}
