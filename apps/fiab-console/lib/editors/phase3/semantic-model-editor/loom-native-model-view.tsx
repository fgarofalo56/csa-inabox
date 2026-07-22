'use client';

// loom-native-model-view.tsx — LoomNativeModelView, the DEFAULT model surface
// when no Power BI dataset is selected. Extracted byte-for-byte from
// ../semantic-model-editor.tsx.

import { clientFetch } from '@/lib/client-fetch';
import { useEffect, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Card, Spinner,
  Tab, TabList,
  MessageBar, MessageBarBody, MessageBarTitle, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Table20Regular, DatabaseLink20Regular, Database20Regular,
  MathFormula20Regular,
} from '@fluentui/react-icons';
import { EntityDiagram } from '@/lib/components/shared/entity-diagram';
import { GuidedEmptyState } from '@/lib/components/shared/guided-empty-state';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { loomDocUrl } from '@/lib/learn/content';
import { DaxSnippet } from '@/lib/components/editor/dax-snippet';
import { ColumnTypeIcon } from './helpers';
import { useStyles } from '../styles';
import { useSmVisualStyles } from './styles';

// ============================================================================
// Loom-native Model view — the DEFAULT surface when NO Power BI dataset is
// selected (no-fabric-dependency.md). Reads the item's own tabular definition
// (tables + typed columns + relationships + DAX measures) from the Azure-native
// route GET /api/items/semantic-model/{id}/model — which persists to Cosmos and
// needs NO Fabric / Power BI workspace — and renders it as a segmented
// Model / Tables / Measures surface. Model = the shared <EntityDiagram> (table
// cards + cardinality-marked join lines); Tables = per-table column cards with
// type badges; Measures = name + home table + DAX. Before this existed the
// editor rendered only the honest "Power BI embed is opt-in" MessageBar and an
// EMPTY body, stranding the bundle-seeded model — the very violation the rule
// forbids. Power BI-gated authoring (Build / Refresh / XMLA writes) is unchanged.
// ============================================================================
export function LoomNativeModelView({
  id, sub, onSub, onGetData, onBuild,
}: {
  id: string;
  sub: 'model' | 'tables' | 'measures';
  onSub: (v: 'model' | 'tables' | 'measures') => void;
  onGetData: () => void;
  onBuild: () => void;
}) {
  const s = useStyles();
  const sm = useSmVisualStyles();
  const [model, setModel] = useState<{
    modelName?: string;
    tables: Array<{ name: string; columns?: Array<{ name: string; type?: string }> }>;
    relationships: unknown[];
    measures: Array<{ name: string; expression?: string; table: string }>;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setErr(null);
      try {
        const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(id)}/model`);
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!j?.ok) {
          setErr(j?.error || `HTTP ${r.status}`);
          setModel({ tables: [], relationships: [], measures: [] });
          return;
        }
        setModel({
          modelName: j.modelName,
          tables: Array.isArray(j.tables) ? j.tables : [],
          relationships: Array.isArray(j.relationships) ? j.relationships : [],
          measures: Array.isArray(j.measures) ? j.measures : [],
        });
      } catch (e: any) {
        if (!cancelled) { setErr(e?.message || String(e)); setModel({ tables: [], relationships: [], measures: [] }); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  if (loading && !model) {
    return (
      <div className={s.pad}>
        <Spinner size="small" label="Loading model…" labelPosition="after" style={{ justifyContent: 'flex-start' }} />
      </div>
    );
  }

  const tables = model?.tables ?? [];
  const measures = model?.measures ?? [];

  if (tables.length === 0 && measures.length === 0) {
    return (
      <div className={s.pad}>
        {err && (
          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody><MessageBarTitle>Could not read the model definition</MessageBarTitle>{err}</MessageBarBody>
          </MessageBar>
        )}
        <GuidedEmptyState
          title="Build your semantic model"
          intro="This Loom-native tabular model has no tables yet. Ingest data with Power Query (M) → Delta, or design tables, columns, DAX measures and relationships — all Azure-native, no Power BI required."
          heroIcon={Database20Regular}
          paths={[
            { key: 'get-data', title: 'Get data', body: 'Author a Power Query (M) mashup that lands Delta in ADLS and refreshes the tabular model.', icon: DatabaseLink20Regular, onClick: onGetData },
            { key: 'build', title: 'Build model', body: 'Design tables, typed columns, DAX measures and relationships from scratch.', icon: Add20Regular, onClick: onBuild },
          ]}
          learnMoreHref={loomDocUrl('fiab/parity/semantic-model')}
        />
      </div>
    );
  }

  return (
    <>
      <div className={s.tabBar}>
        <TabList selectedValue={sub} onTabSelect={(_: unknown, d: any) => onSub(d.value)}>
          <Tab value="model" icon={<Table20Regular />}>Model</Tab>
          <Tab value="tables">Tables ({tables.length})</Tab>
          <Tab value="measures" icon={<MathFormula20Regular />}>Measures ({measures.length})</Tab>
        </TabList>
      </div>
      <div className={s.pad}>
        {err && <MessageBar intent="warning" layout="multiline"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
        {sub === 'model' && (
          <EntityDiagram source={{ kind: 'semantic-model', itemId: id }} height={560} resizeStorageKey="semantic-model-entity" />
        )}
        {sub === 'tables' && (
          <TileGrid minTileWidth={320}>
            {tables.map((t) => {
              const cols = t.columns ?? [];
              const tblMeasures = measures.filter((m) => m.table === t.name);
              return (
                <Card key={t.name} className={s.card}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalS }}>
                    <Table20Regular />
                    <Subtitle2 style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</Subtitle2>
                    <Badge appearance="tint" color="informative">{cols.length} col{cols.length === 1 ? '' : 's'}</Badge>
                    {tblMeasures.length > 0 && <Badge appearance="tint" color="brand">{tblMeasures.length} measure{tblMeasures.length === 1 ? '' : 's'}</Badge>}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS }}>
                    {cols.length === 0 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No columns defined.</Caption1>}
                    {cols.map((c) => (
                      <div key={c.name} className={sm.gridRow} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalS, paddingBlock: tokens.spacingVerticalXXS, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` }}>
                        <span className={sm.fieldName}>
                          <ColumnTypeIcon dataType={c.type} className={sm.typeIcon} />
                          {c.name}
                        </span>
                        <Badge appearance="outline" color="subtle">{c.type || 'string'}</Badge>
                      </div>
                    ))}
                  </div>
                </Card>
              );
            })}
          </TileGrid>
        )}
        {sub === 'measures' && (
          measures.length === 0 ? (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No DAX measures defined on this model.</Caption1>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              {measures.map((m, i) => (
                <Card key={`${m.table}.${m.name}.${i}`} className={s.card}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalS, minWidth: 0, flexWrap: 'wrap' }}>
                    <span className={sm.measureIcon}><MathFormula20Regular /></span>
                    <Subtitle2 style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</Subtitle2>
                    <Badge appearance="tint" color="informative">{m.table}</Badge>
                    <Badge appearance="outline" color="brand">DAX</Badge>
                  </div>
                  {/* ux-fabric-a W1 — DAX syntax hints (functions / refs / strings
                      colorized) on the read-only measure list, Fabric parity. */}
                  <DaxSnippet expression={m.expression || '—'} ariaLabel={`DAX for ${m.name}`} />
                </Card>
              ))}
            </div>
          )
        )}
      </div>
    </>
  );
}
