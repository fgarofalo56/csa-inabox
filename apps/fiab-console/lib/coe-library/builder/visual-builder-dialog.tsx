'use client';

/**
 * Visual builder — "New visual" guided builder for a Loom-native dashboard.
 *
 * A guided (no-freeform) builder: name + category + Loom accent on the left, an
 * editable list of tiles in the middle (each tile = title + visualization type +
 * Azure-native data source + category/value field pickers, all dropdowns), and a
 * LIVE preview on the right that renders the in-progress spec against the real
 * Azure estate via POST /api/admin/org-visuals/dashboards/render (the same
 * <ReportCanvas> the CoE templates use). Save → POST/PUT the dashboards BFF.
 *
 * Azure-native: a Loom-native dashboard renders over Cost Management / Azure
 * Resource Graph / Defender / Log Analytics — NO Microsoft Fabric / Power BI
 * workspace required. Every field is a guided picker (no JSON config).
 */

import * as React from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Input, Field, Dropdown, Option, Spinner, Badge, Caption1, Body1, Text,
  MessageBar, MessageBarBody, MessageBarTitle, Switch,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Dismiss20Regular, Add20Regular, Delete20Regular, Save20Regular,
  ChartMultiple20Regular, DataArea20Regular,
} from '@fluentui/react-icons';
import { ReportCanvas } from '../report-render/report-canvas';
import { useReportModel } from '../report-render/use-report';
import {
  newDashboardSpec, newTile, validateSpec, accentBadgeColor,
  TILE_VISUALS, BUILDER_SOURCE_META, getSourceMeta, DASHBOARD_CATEGORIES,
  type DashboardSpec, type DashboardTile, type TileVisual, type DashboardAccent,
} from './dashboard-model';

const ACCENTS: { id: DashboardAccent; label: string }[] = [
  { id: 'brand', label: 'Brand (violet)' },
  { id: 'finops', label: 'FinOps (blue)' },
  { id: 'security', label: 'Security (red)' },
  { id: 'inventory', label: 'Inventory (green)' },
  { id: 'identity', label: 'Identity (purple)' },
  { id: 'data', label: 'Data (teal)' },
  { id: 'ops', label: 'Operations (orange)' },
];

const useStyles = makeStyles({
  surface: { maxWidth: '97vw', width: '1340px' },
  layout: { display: 'grid', gridTemplateColumns: 'minmax(420px, 1fr) minmax(520px, 1.3fr)', gap: tokens.spacingHorizontalL, alignItems: 'start' },
  leftCol: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  rightCol: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  metaGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacingHorizontalM },
  tilesHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  tileCard: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground2,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
  },
  tileHeadRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  tileGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacingHorizontalS },
  sourceHint: { color: tokens.colorNeutralForeground3 },
  previewWrap: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingHorizontalM, backgroundColor: tokens.colorNeutralBackground1, minHeight: '420px',
  },
  previewHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacingVerticalS },
  emptyTiles: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalL, textAlign: 'center', color: tokens.colorNeutralForeground3,
    border: `1px dashed ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
  },
});

export interface VisualBuilderDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful save (parent reloads its list). */
  onSaved: (name: string) => void;
  /** Editing an existing dashboard (id + spec) vs. creating a new one. */
  edit?: { id: string; spec: DashboardSpec } | null;
}

/** Live preview: POSTs the in-progress spec and renders it with <ReportCanvas>. */
function BuilderPreview({ spec, live }: { spec: DashboardSpec; live: boolean }) {
  const s = useStyles();
  // Only request tiles that are complete enough to render (real source + value).
  const renderable = React.useMemo(
    () => spec.tiles.filter((t) => t.sourceId && t.value && (t.visual === 'kpi' || t.category)),
    [spec.tiles],
  );
  const body = React.useMemo(
    () => ({ spec: { ...spec, tiles: renderable }, mode: live ? 'live' : 'sample' }),
    [spec, renderable, live],
  );
  const fetchSpec = renderable.length
    ? { url: '/api/admin/org-visuals/dashboards/render', method: 'POST' as const, body }
    : null;
  const { data, loading, error } = useReportModel(fetchSpec);

  if (!renderable.length) {
    return (
      <div className={s.emptyTiles}>
        <ChartMultiple20Regular />
        <Caption1>Add a tile with a data source and value to see a live preview.</Caption1>
      </div>
    );
  }
  if (loading) return <Spinner label={live ? 'Rendering live preview…' : 'Rendering preview…'} />;
  if (error) return <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>;
  if (!data) return <Spinner label="Rendering preview…" />;

  const liveMode = live && !!data.dataSources;
  const renderData = liveMode ? (data.live || data.sample) : data.sample;
  return (
    <ReportCanvas model={data.model} sample={renderData} dataSources={data.dataSources} liveMode={liveMode} />
  );
}

export function VisualBuilderDialog({ open, onClose, onSaved, edit }: VisualBuilderDialogProps): React.ReactElement {
  const s = useStyles();
  const [spec, setSpec] = React.useState<DashboardSpec>(newDashboardSpec());
  const [livePreview, setLivePreview] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [blobGate, setBlobGate] = React.useState<any | null>(null);

  React.useEffect(() => {
    if (open) {
      setSpec(edit?.spec ? structuredClone(edit.spec) : newDashboardSpec());
      setErr(null); setBlobGate(null); setLivePreview(true);
    }
  }, [open, edit]);

  function patch(p: Partial<DashboardSpec>) { setSpec((prev) => ({ ...prev, ...p })); }
  function addTile() { setSpec((prev) => ({ ...prev, tiles: [...prev.tiles, newTile({ title: `Tile ${prev.tiles.length + 1}` })] })); }
  function removeTile(id: string) { setSpec((prev) => ({ ...prev, tiles: prev.tiles.filter((t) => t.id !== id) })); }
  function patchTile(id: string, p: Partial<DashboardTile>) {
    setSpec((prev) => ({ ...prev, tiles: prev.tiles.map((t) => (t.id === id ? { ...t, ...p } : t)) }));
  }
  /** When a source changes, default its category/value to the source's suggestions. */
  function pickSource(id: string, sourceId: string) {
    const meta = getSourceMeta(sourceId);
    patchTile(id, {
      sourceId,
      category: meta?.defaultCategory,
      value: meta?.defaultValue || '',
    });
  }

  async function save() {
    const invalid = validateSpec(spec);
    if (invalid) { setErr(invalid); return; }
    setSaving(true); setErr(null); setBlobGate(null);
    try {
      const url = edit ? `/api/admin/org-visuals/dashboards?id=${encodeURIComponent(edit.id)}` : '/api/admin/org-visuals/dashboards';
      const r = await fetch(url, {
        method: edit ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spec }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      if (j.blobGate) { setBlobGate(j.blobGate); }
      onSaved(spec.name);
      onClose();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle action={<Button appearance="subtle" icon={<Dismiss20Regular />} aria-label="Close" onClick={onClose} />}>
            {edit ? `Edit “${edit.spec.name}”` : 'New visual — Loom-native dashboard'}
          </DialogTitle>
          <DialogContent>
            <Body1 style={{ color: tokens.colorNeutralForeground2, marginBottom: tokens.spacingVerticalM, lineHeight: 1.5 }}>
              Build a dashboard from your own Azure estate — Cost Management, Azure Resource Graph, Defender for Cloud
              and Log Analytics. Each tile binds one source to one visualization. <strong>No Microsoft Fabric or Power BI
              workspace is required.</strong>
            </Body1>

            {err && <MessageBar intent="error" style={{ marginBottom: 12 }}><MessageBarBody>{err}</MessageBarBody></MessageBar>}
            {blobGate && (
              <MessageBar intent="warning" style={{ marginBottom: 12 }}>
                <MessageBarBody>
                  <MessageBarTitle>Saved (metadata only)</MessageBarTitle>
                  The spec was saved to your library but not copied to Blob storage because <code>{blobGate.missingEnvVar}</code> is not set.
                </MessageBarBody>
              </MessageBar>
            )}

            <div className={s.layout}>
              {/* ---- left: spec + tiles ------------------------------------ */}
              <div className={s.leftCol}>
                <div className={s.metaGrid}>
                  <Field label="Name" required>
                    <Input value={spec.name} onChange={(_, d) => patch({ name: d.value })} placeholder="e.g. FinOps overview" />
                  </Field>
                  <Field label="Category">
                    <Dropdown
                      value={spec.category}
                      selectedOptions={[spec.category]}
                      onOptionSelect={(_, d) => patch({ category: d.optionValue || spec.category })}
                    >
                      {DASHBOARD_CATEGORIES.map((c) => <Option key={c} value={c}>{c}</Option>)}
                    </Dropdown>
                  </Field>
                </div>
                <div className={s.metaGrid}>
                  <Field label="Description (optional)">
                    <Input value={spec.description || ''} onChange={(_, d) => patch({ description: d.value })} placeholder="What this dashboard shows" />
                  </Field>
                  <Field label="Theme accent">
                    <Dropdown
                      value={ACCENTS.find((a) => a.id === spec.accent)?.label || 'Brand (violet)'}
                      selectedOptions={[spec.accent]}
                      onOptionSelect={(_, d) => patch({ accent: (d.optionValue as DashboardAccent) || 'brand' })}
                    >
                      {ACCENTS.map((a) => <Option key={a.id} value={a.id}>{a.label}</Option>)}
                    </Dropdown>
                  </Field>
                </div>

                <div className={s.tilesHead}>
                  <Text weight="semibold">Tiles ({spec.tiles.length})</Text>
                  <Button size="small" appearance="primary" icon={<Add20Regular />} onClick={addTile}>Add tile</Button>
                </div>

                {spec.tiles.length === 0 ? (
                  <div className={s.emptyTiles}>
                    <DataArea20Regular />
                    <Caption1>No tiles yet. Add a tile and bind it to an Azure-native data source.</Caption1>
                  </div>
                ) : (
                  spec.tiles.map((tile) => {
                    const meta = getSourceMeta(tile.sourceId);
                    const cols = meta?.columns || [];
                    return (
                      <div key={tile.id} className={s.tileCard}>
                        <div className={s.tileHeadRow}>
                          <Field style={{ flex: 1 }}>
                            <Input value={tile.title} onChange={(_, d) => patchTile(tile.id, { title: d.value })} placeholder="Tile title" />
                          </Field>
                          <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label="Remove tile" onClick={() => removeTile(tile.id)} />
                        </div>
                        <div className={s.tileGrid}>
                          <Field label="Visualization">
                            <Dropdown
                              value={TILE_VISUALS.find((v) => v.id === tile.visual)?.label || 'KPI card'}
                              selectedOptions={[tile.visual]}
                              onOptionSelect={(_, d) => patchTile(tile.id, { visual: (d.optionValue as TileVisual) || 'kpi' })}
                            >
                              {TILE_VISUALS.map((v) => <Option key={v.id} value={v.id}>{v.label}</Option>)}
                            </Dropdown>
                          </Field>
                          <Field label="Data source">
                            <Dropdown
                              placeholder="Choose a source…"
                              value={meta?.label || ''}
                              selectedOptions={tile.sourceId ? [tile.sourceId] : []}
                              onOptionSelect={(_, d) => pickSource(tile.id, d.optionValue || '')}
                            >
                              {BUILDER_SOURCE_META.map((src) => <Option key={src.id} value={src.id} text={src.label}>{src.label}</Option>)}
                            </Dropdown>
                          </Field>
                        </div>
                        {meta && (
                          <Caption1 className={s.sourceHint}>
                            <Badge appearance="outline" size="small" style={{ marginRight: 6 }}>{meta.plane}</Badge>
                            {meta.description} Needs <strong>{meta.requiredRole}</strong> for live data.
                          </Caption1>
                        )}
                        {tile.sourceId && (
                          <div className={s.tileGrid}>
                            {tile.visual !== 'kpi' && (
                              <Field label="Category (group by)">
                                <Dropdown
                                  placeholder="Column…"
                                  value={tile.category || ''}
                                  selectedOptions={tile.category ? [tile.category] : []}
                                  onOptionSelect={(_, d) => patchTile(tile.id, { category: d.optionValue })}
                                >
                                  {cols.map((c) => <Option key={c} value={c}>{c}</Option>)}
                                </Dropdown>
                              </Field>
                            )}
                            <Field label="Value (measure)">
                              <Dropdown
                                placeholder="Column…"
                                value={tile.value || ''}
                                selectedOptions={tile.value ? [tile.value] : []}
                                onOptionSelect={(_, d) => patchTile(tile.id, { value: d.optionValue || '' })}
                              >
                                {cols.map((c) => <Option key={c} value={c}>{c}</Option>)}
                              </Dropdown>
                            </Field>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {/* ---- right: live preview ----------------------------------- */}
              <div className={s.rightCol}>
                <div className={s.previewHead}>
                  <Text weight="semibold">Preview</Text>
                  <Switch checked={livePreview} onChange={(_, d) => setLivePreview(!!d.checked)} label={livePreview ? 'Live data' : 'Sample data'} />
                </div>
                <div className={s.previewWrap}>
                  <BuilderPreview spec={spec} live={livePreview} />
                </div>
                <Caption1 className={s.sourceHint}>
                  Live preview renders against this deployment&apos;s own Azure estate. Each tile is labelled with its
                  true provenance (live / sample / honest gate). No Microsoft Fabric or Power BI workspace is used.
                </Caption1>
              </div>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button appearance="primary" icon={saving ? <Spinner size="tiny" /> : <Save20Regular />} disabled={saving} onClick={save}>
              {saving ? 'Saving…' : edit ? 'Save changes' : 'Save dashboard'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default VisualBuilderDialog;
