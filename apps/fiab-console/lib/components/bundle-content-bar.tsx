'use client';

/**
 * BundleContentBar — when an item was created by an app install (state.sourceApp
 * set + state.content populated by lib/apps/content-bundles), surfaces the
 * rich starter content (notebook cells, KQL DDL, dbt models, dashboard
 * tiles, etc.) in a collapsible MessageBar above the per-type editor.
 *
 * This is the front-end half of Phase 1 of the apps-install enrichment.
 * Phase 2 will wire each editor to use the content as its initial state +
 * push to the live backing service on Save. Until then the user can at
 * least browse what the app's bundle contains and copy snippets out.
 */

import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  MessageBar, MessageBarBody, MessageBarTitle,
  Button, Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions, DialogTrigger,
  Tab, TabList,
  Caption1, Body1, Subtitle2,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Open16Regular, AppFolder20Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  preWrap: {
    backgroundColor: tokens.colorNeutralBackground3,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre',
    overflowX: 'auto',
    maxHeight: '360px',
    overflowY: 'auto',
    color: tokens.colorNeutralForeground1,
    margin: 0,
  },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalL },
  sectionTitle: { fontWeight: 600 },
  tileRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: tokens.spacingHorizontalS,
  },
  tile: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  tabPane: { padding: '12px 0' },
});

interface Props {
  itemType: string;
  itemId: string;
}

interface CosmosItem {
  id: string;
  itemType: string;
  displayName: string;
  description?: string;
  state?: {
    content?: any;
    sourceApp?: string;
    template?: string;
    learnDoc?: string;
  };
}

export function BundleContentBar({ itemType, itemId }: Props) {
  const styles = useStyles();
  const [item, setItem] = useState<CosmosItem | null>(null);
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('summary');

  useEffect(() => {
    if (!itemId || itemId === 'new') return;
    let cancel = false;
    (async () => {
      try {
        const r = await fetch(`/api/cosmos-items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}`);
        if (!r.ok) return;
        const j = await r.json();
        if (!cancel && j?.state?.content) setItem(j as CosmosItem);
      } catch { /* silent — bar just won't show */ }
    })();
    return () => { cancel = true; };
  }, [itemType, itemId]);

  const content: any = item?.state?.content;
  const kind = content?.kind as string | undefined;

  const summary = useMemo(() => {
    if (!content) return '';
    switch (kind) {
      case 'notebook':
        return `${(content.cells || []).length} cells (default lang: ${content.defaultLang})`;
      case 'kql-database':
        return `${(content.tables || []).length} tables · ${(content.functions || []).length} functions · ${(content.starterQueries || []).length} starter queries`;
      case 'kql-dashboard':
        return `${(content.tiles || []).length} tiles`;
      case 'eventstream':
        return `${(content.sources || []).length} source(s) → ${(content.destinations || []).length} destination(s)`;
      case 'warehouse':
        return `${(content.dbtModels || []).length} dbt models · ${(content.starterQueries || []).length} starter queries`;
      case 'lakehouse':
        return `${(content.folders || []).length} folders · ${(content.deltaTables || []).length} delta tables`;
      case 'semantic-model':
        return `${(content.tables || []).length} tables · ${(content.measures || []).length} measures`;
      case 'report':
        return `${(content.pages || []).length} pages`;
      case 'activator':
        return content.rule?.name || 'rule defined';
      case 'mirrored-database':
        return `${content.source?.kind} · ${(content.source?.tables || []).length} tables`;
      case 'scorecard':
        return `${(content.okrs || []).length} OKRs`;
      case 'data-product':
        return `${(content.datasets || []).length} datasets · ${(content.glossaryTerms || []).length} glossary terms`;
      case 'ai-search-index':
        return `${(content.schema?.fields || []).length} fields · ${(content.sampleDocs || []).length} sample docs`;
      case 'prompt-flow':
        return `${(content.nodes || []).length} nodes · ${(content.edges || []).length} edges`;
      case 'evaluation':
        return `${(content.metrics || []).length} metrics`;
      case 'ml-model':
        return `${content.algorithm || 'model'} (${content.framework})`;
      case 'synapse-pipeline':
      case 'adf-pipeline':
        return `${(content.activities || []).length} activities`;
      case 'databricks-job':
        return `${(content.tasks || []).length} task(s)`;
      default:
        return 'starter content available';
    }
  }, [content, kind]);

  if (!item || !content) return null;

  return (
    <>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>App-installed starter content</MessageBarTitle>
          From <strong>{item.state?.sourceApp || 'an app'}</strong> — {summary}.
          {' '}
          <Button appearance="primary" size="small" icon={<Open16Regular />} onClick={() => setOpen(true)} style={{ marginLeft: 8 }}>
            View bundle
          </Button>
        </MessageBarBody>
      </MessageBar>
      <BundleDialog
        open={open}
        onClose={() => setOpen(false)}
        item={item}
        content={content}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        styles={styles}
      />
    </>
  );
}

function BundleDialog({
  open, onClose, item, content, activeTab, setActiveTab, styles,
}: {
  open: boolean;
  onClose: () => void;
  item: CosmosItem;
  content: any;
  activeTab: string;
  setActiveTab: (v: string) => void;
  styles: ReturnType<typeof useStyles>;
}) {
  const tabs = useMemo(() => buildTabs(content), [content]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: '90vw', width: 1100 }}>
        <DialogBody>
          <DialogTitle>
            <AppFolder20Regular style={{ verticalAlign: 'middle', marginRight: 8 }} />
            {item.displayName} — Bundle content
          </DialogTitle>
          <DialogContent style={{ maxHeight: '70vh', overflow: 'auto' }}>
            <Caption1 style={{ display: 'block', marginBottom: 8 }}>
              {item.description}
            </Caption1>
            {tabs.length > 1 && (
              <TabList selectedValue={activeTab} onTabSelect={(_, d) => setActiveTab(String(d.value))} size="small">
                {tabs.map((t) => (
                  <Tab key={t.id} value={t.id}>{t.label}</Tab>
                ))}
              </TabList>
            )}
            <div className={styles.tabPane}>
              {(tabs.find((t) => t.id === activeTab) || tabs[0])?.render(styles)}
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger>
              <Button appearance="secondary">Close</Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

interface RenderableTab {
  id: string;
  label: string;
  render: (styles: ReturnType<typeof useStyles>) => React.JSX.Element;
}

function pre(text: string, styles: ReturnType<typeof useStyles>) {
  return <pre className={styles.preWrap}>{text}</pre>;
}

function buildTabs(content: any): RenderableTab[] {
  const kind = content?.kind;
  switch (kind) {
    case 'notebook':
      return [
        {
          id: 'cells', label: `Cells (${(content.cells || []).length})`,
          render: (s) => (
            <div>
              {(content.cells || []).map((c: any, i: number) => (
                <div key={c.id || i} className={s.section}>
                  <Subtitle2>Cell {i + 1} · {c.type}{c.lang ? ` · ${c.lang}` : ''}</Subtitle2>
                  {pre(c.source || '', s)}
                </div>
              ))}
            </div>
          ),
        },
      ];
    case 'kql-database':
      return [
        {
          id: 'tables', label: `Tables (${(content.tables || []).length})`,
          render: (s) => (
            <div>
              {(content.tables || []).map((t: any) => (
                <div key={t.name} className={s.section}>
                  <Subtitle2>{t.name}</Subtitle2>
                  {pre(
                    `.create-merge table ${t.name} (\n` +
                    (t.columns || []).map((c: any) => `  ${c.name}: ${c.type}`).join(',\n') +
                    '\n)',
                    s,
                  )}
                </div>
              ))}
            </div>
          ),
        },
        {
          id: 'functions', label: `Functions (${(content.functions || []).length})`,
          render: (s) => (
            <div>
              {(content.functions || []).map((f: any) => (
                <div key={f.name} className={s.section}>
                  <Subtitle2>{f.name}</Subtitle2>
                  {pre(f.body || '', s)}
                </div>
              ))}
            </div>
          ),
        },
        {
          id: 'queries', label: `Starter queries (${(content.starterQueries || []).length})`,
          render: (s) => (
            <div>
              {(content.starterQueries || []).map((q: any) => (
                <div key={q.name} className={s.section}>
                  <Subtitle2>{q.name}</Subtitle2>
                  {pre(q.kql || '', s)}
                </div>
              ))}
            </div>
          ),
        },
      ];
    case 'kql-dashboard':
      return [
        {
          id: 'tiles', label: `Tiles (${(content.tiles || []).length})`,
          render: (s) => (
            <div className={s.tileRow}>
              {(content.tiles || []).map((t: any, i: number) => (
                <div key={i} className={s.tile}>
                  <Subtitle2>{t.title}</Subtitle2>
                  <Caption1>{t.viz}</Caption1>
                  {pre(t.kql || '', s)}
                </div>
              ))}
            </div>
          ),
        },
      ];
    case 'eventstream':
      return [
        {
          id: 'pipeline', label: 'Pipeline',
          render: (s) => (
            <div>
              <Subtitle2>Sources</Subtitle2>
              {pre(JSON.stringify(content.sources || [], null, 2), s)}
              <Subtitle2 style={{ marginTop: 12 }}>Transforms</Subtitle2>
              {pre(JSON.stringify(content.transforms || [], null, 2), s)}
              <Subtitle2 style={{ marginTop: 12 }}>Destinations</Subtitle2>
              {pre(JSON.stringify(content.destinations || [], null, 2), s)}
            </div>
          ),
        },
      ];
    case 'warehouse':
      return [
        {
          id: 'ddl', label: 'DDL',
          render: (s) => pre(content.ddl || '', s),
        },
        {
          id: 'dbt', label: `dbt models (${(content.dbtModels || []).length})`,
          render: (s) => (
            <div>
              {content.dbtProject && (
                <div className={s.section}>
                  <Subtitle2>dbt_project.yml</Subtitle2>
                  {pre(content.dbtProject, s)}
                </div>
              )}
              {(content.dbtModels || []).map((m: any) => (
                <div key={m.name} className={s.section}>
                  <Subtitle2>{m.layer}/{m.name}.sql</Subtitle2>
                  {pre(m.sql || '', s)}
                </div>
              ))}
            </div>
          ),
        },
        {
          id: 'queries', label: `Starter queries (${(content.starterQueries || []).length})`,
          render: (s) => (
            <div>
              {(content.starterQueries || []).map((q: any) => (
                <div key={q.name} className={s.section}>
                  <Subtitle2>{q.name}</Subtitle2>
                  {pre(q.sql || '', s)}
                </div>
              ))}
            </div>
          ),
        },
      ];
    case 'lakehouse':
      return [
        {
          id: 'folders', label: `Folders (${(content.folders || []).length})`,
          render: (s) => (
            <div>
              {(content.folders || []).map((f: any) => (
                <div key={f.path}>
                  <Body1>{f.path}</Body1>
                  {f.description && <Caption1 style={{ display: 'block', marginBottom: 6 }}>{f.description}</Caption1>}
                </div>
              ))}
            </div>
          ),
        },
        {
          id: 'tables', label: `Delta tables (${(content.deltaTables || []).length})`,
          render: (s) => (
            <div>
              {(content.deltaTables || []).map((t: any) => (
                <div key={t.name} className={s.section}>
                  <Subtitle2>{t.name}</Subtitle2>
                  {pre(t.ddl || '', s)}
                  {t.sampleRows && pre(`-- Sample rows\n${JSON.stringify(t.sampleRows, null, 2)}`, s)}
                </div>
              ))}
            </div>
          ),
        },
        ...(content.shortcuts?.length ? [{
          id: 'shortcuts', label: `Shortcuts (${content.shortcuts.length})`,
          render: (s: any) => pre(JSON.stringify(content.shortcuts, null, 2), s),
        }] : []),
      ];
    case 'semantic-model':
      return [
        {
          id: 'tables', label: `Tables (${(content.tables || []).length})`,
          render: (s) => pre(JSON.stringify(content.tables || [], null, 2), s),
        },
        {
          id: 'measures', label: `Measures (${(content.measures || []).length})`,
          render: (s) => (
            <div>
              {(content.measures || []).map((m: any, i: number) => (
                <div key={i} className={s.section}>
                  <Subtitle2>{m.table}.[{m.name}]</Subtitle2>
                  {pre(m.expression || '', s)}
                  {m.formatString && <Caption1>Format: {m.formatString}</Caption1>}
                </div>
              ))}
            </div>
          ),
        },
        ...(content.relationships?.length ? [{
          id: 'rel', label: 'Relationships',
          render: (s: any) => pre(JSON.stringify(content.relationships, null, 2), s),
        }] : []),
      ];
    case 'report':
      return [
        {
          id: 'pages', label: `Pages (${(content.pages || []).length})`,
          render: (s) => (
            <div>
              {(content.pages || []).map((p: any) => (
                <div key={p.name} className={s.section}>
                  <Subtitle2>{p.name}</Subtitle2>
                  {pre(JSON.stringify(p.visuals || [], null, 2), s)}
                </div>
              ))}
            </div>
          ),
        },
      ];
    case 'activator':
      return [
        {
          id: 'rule', label: 'Rule',
          render: (s) => pre(JSON.stringify(content.rule || {}, null, 2), s),
        },
      ];
    case 'mirrored-database':
      return [
        {
          id: 'source', label: 'Source',
          render: (s) => pre(JSON.stringify(content.source || {}, null, 2), s),
        },
      ];
    case 'scorecard':
      return [
        {
          id: 'okrs', label: `OKRs (${(content.okrs || []).length})`,
          render: (s) => (
            <div>
              {(content.okrs || []).map((o: any) => (
                <div key={o.id} className={s.section}>
                  <Subtitle2>{o.id} — {o.name}</Subtitle2>
                  {o.description && <Caption1 style={{ display: 'block', marginBottom: 4 }}>{o.description}</Caption1>}
                  <Body1>Target: {o.target} · Current: {o.current ?? '—'} · Metric: {o.metric}</Body1>
                </div>
              ))}
            </div>
          ),
        },
      ];
    case 'data-product':
      return [
        {
          id: 'datasets', label: `Datasets (${(content.datasets || []).length})`,
          render: (s) => (
            <div>
              {(content.datasets || []).map((d: any) => (
                <div key={d.id} className={s.section}>
                  <Subtitle2>{d.name} <small>· {d.classification}</small></Subtitle2>
                  <Body1>{d.description}</Body1>
                </div>
              ))}
            </div>
          ),
        },
        {
          id: 'glossary', label: `Glossary (${(content.glossaryTerms || []).length})`,
          render: (s) => (
            <div>
              {(content.glossaryTerms || []).map((t: any, i: number) => (
                <div key={i} className={s.section}>
                  <Subtitle2>{t.term}</Subtitle2>
                  <Body1>{t.definition}</Body1>
                </div>
              ))}
            </div>
          ),
        },
      ];
    case 'ai-search-index':
      return [
        {
          id: 'schema', label: 'Schema',
          render: (s) => pre(JSON.stringify(content.schema || {}, null, 2), s),
        },
        ...(content.sampleDocs?.length ? [{
          id: 'docs', label: `Sample docs (${content.sampleDocs.length})`,
          render: (s: any) => pre(JSON.stringify(content.sampleDocs, null, 2), s),
        }] : []),
        ...(content.vectorConfig ? [{
          id: 'vector', label: 'Vector config',
          render: (s: any) => pre(JSON.stringify(content.vectorConfig, null, 2), s),
        }] : []),
      ];
    case 'prompt-flow':
      return [
        {
          id: 'graph', label: 'Graph',
          render: (s) => (
            <div>
              <Subtitle2>Nodes</Subtitle2>
              {pre(JSON.stringify(content.nodes || [], null, 2), s)}
              <Subtitle2 style={{ marginTop: 12 }}>Edges</Subtitle2>
              {pre(JSON.stringify(content.edges || [], null, 2), s)}
              {content.systemPrompt && (
                <>
                  <Subtitle2 style={{ marginTop: 12 }}>System prompt</Subtitle2>
                  {pre(content.systemPrompt, s)}
                </>
              )}
            </div>
          ),
        },
      ];
    case 'evaluation':
      return [
        {
          id: 'metrics', label: `Metrics (${(content.metrics || []).length})`,
          render: (s) => (
            <div>
              {(content.metrics || []).map((m: any, i: number) => (
                <div key={i} className={s.section}>
                  <Subtitle2>{m.name}</Subtitle2>
                  <Body1>{m.description}</Body1>
                </div>
              ))}
              {content.baseline && (
                <div className={s.section}>
                  <Subtitle2>Baseline</Subtitle2>
                  {pre(JSON.stringify(content.baseline, null, 2), s)}
                </div>
              )}
            </div>
          ),
        },
      ];
    case 'ml-model':
      return [
        {
          id: 'spec', label: 'Model spec',
          render: (s) => (
            <div>
              <Body1><strong>Algorithm:</strong> {content.algorithm} · <strong>Framework:</strong> {content.framework}</Body1>
              {content.target && <Body1><strong>Target:</strong> {content.target}</Body1>}
              <Subtitle2 style={{ marginTop: 12 }}>Hyperparameters</Subtitle2>
              {pre(JSON.stringify(content.hyperparameters || {}, null, 2), s)}
              {content.features?.length && (
                <>
                  <Subtitle2 style={{ marginTop: 12 }}>Features</Subtitle2>
                  {pre(JSON.stringify(content.features, null, 2), s)}
                </>
              )}
              {content.trainingCode && (
                <>
                  <Subtitle2 style={{ marginTop: 12 }}>Training code</Subtitle2>
                  {pre(content.trainingCode, s)}
                </>
              )}
            </div>
          ),
        },
      ];
    case 'synapse-pipeline':
    case 'adf-pipeline':
      return [
        {
          id: 'activities', label: `Activities (${(content.activities || []).length})`,
          render: (s) => pre(JSON.stringify(content.activities || [], null, 2), s),
        },
        ...(content.parameters && Object.keys(content.parameters).length ? [{
          id: 'params', label: 'Parameters',
          render: (s: any) => pre(JSON.stringify(content.parameters, null, 2), s),
        }] : []),
      ];
    case 'databricks-job':
      return [
        {
          id: 'tasks', label: `Tasks (${(content.tasks || []).length})`,
          render: (s) => pre(JSON.stringify(content.tasks || [], null, 2), s),
        },
        {
          id: 'cluster', label: 'Cluster',
          render: (s) => pre(JSON.stringify(content.cluster || {}, null, 2), s),
        },
      ];
    default:
      return [
        { id: 'raw', label: 'Raw', render: (s) => pre(JSON.stringify(content, null, 2), s) },
      ];
  }
}
