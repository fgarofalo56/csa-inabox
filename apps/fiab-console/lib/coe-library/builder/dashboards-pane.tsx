'use client';

/**
 * Loom-native dashboards pane — the builder library inside Organizational Visuals.
 *
 * Lists builder-authored dashboards (GET /api/admin/org-visuals/dashboards),
 * with "New visual" (open the builder), Open (render via <ReportViewerDialog>
 * over the real Azure estate), Edit, Publish/unpublish to the org gallery, and
 * Delete. Azure-native — no Microsoft Fabric / Power BI workspace required.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Button, Text,
  MessageBar, MessageBarBody, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add24Regular, Open20Regular, Edit20Regular, Delete20Regular,
  Share20Regular, ChannelShare20Regular, ArrowSync24Regular, ChartMultiple24Regular,
} from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { ReportViewerDialog } from '@/lib/coe-library/report-render/report-viewer-dialog';
import { VisualBuilderDialog } from './visual-builder-dialog';
import { TemplateIconChip } from '@/lib/coe-library/template-icons';
import { accentBadgeColor, type DashboardSpec } from './dashboard-model';

interface DashboardDoc {
  id: string;
  name: string;
  description?: string;
  category: string;
  spec: DashboardSpec;
  tileCount: number;
  published?: boolean;
  publishedAt?: string;
  updatedAt: string;
  updatedBy: string;
}

const useStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: tokens.spacingHorizontalL },
  card: {
    display: 'flex', flexDirection: 'column', borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    overflow: 'hidden', boxShadow: tokens.shadow4,
    transition: 'box-shadow .15s ease, transform .15s ease',
    ':hover': { boxShadow: tokens.shadow16, transform: 'translateY(-2px)' },
  },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, padding: tokens.spacingHorizontalM, paddingBottom: tokens.spacingVerticalXS },
  headText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  title: { fontWeight: tokens.fontWeightSemibold, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, padding: tokens.spacingHorizontalM, paddingTop: 0, flexGrow: 1 },
  meta: { color: tokens.colorNeutralForeground3 },
  metaRow: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  actions: { display: 'flex', gap: tokens.spacingHorizontalXS, padding: tokens.spacingHorizontalM, paddingTop: 0, flexWrap: 'wrap' },
  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalXXL, textAlign: 'center', color: tokens.colorNeutralForeground3,
    border: `1px dashed ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
  },
});

function fmt(iso?: string) { if (!iso) return '—'; const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(); }

export function DashboardsPane(): React.ReactElement {
  const s = useStyles();
  const [dashboards, setDashboards] = useState<DashboardDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [edit, setEdit] = useState<{ id: string; spec: DashboardSpec } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/admin/org-visuals/dashboards');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed to load dashboards'); return; }
      setDashboards(j.dashboards || []);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function openNew() { setEdit(null); setBuilderOpen(true); }
  function openEdit(d: DashboardDoc) { setEdit({ id: d.id, spec: d.spec }); setBuilderOpen(true); }

  async function togglePublish(d: DashboardDoc) {
    const publish = !d.published;
    setBusyId(d.id); setError(null); setOkMsg(null);
    try {
      const r = await fetch('/api/admin/org-visuals/dashboards', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: publish ? 'publish' : 'unpublish', id: d.id }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setOkMsg(publish
        ? `Published “${d.name}” to your organization. It now appears in Organization reports.`
        : `Unpublished “${d.name}”.`);
      await load();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusyId(null); }
  }

  async function remove(d: DashboardDoc) {
    if (!confirm(`Delete “${d.name}”?`)) return;
    setBusyId(d.id); setError(null);
    try {
      const r = await fetch(`/api/admin/org-visuals/dashboards?id=${encodeURIComponent(d.id)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      await load();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusyId(null); }
  }

  const openDash = useMemo(() => dashboards.find((d) => d.id === openId) || null, [dashboards, openId]);

  return (
    <>
      <Section
        title="Your visuals — Loom-native dashboards"
        actions={
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
            <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
            <Button appearance="primary" icon={<Add24Regular />} onClick={openNew}>New visual</Button>
          </div>
        }
      >
        <Body1 style={{ color: tokens.colorNeutralForeground2, lineHeight: 1.5, marginBottom: tokens.spacingVerticalM }}>
          Build a new organizational visual from scratch as a <strong>Loom-native dashboard</strong> — name it, pick a
          category and theme, then add tiles that each bind one Azure-native data source (Cost Management, Azure
          Resource Graph, Defender for Cloud, Log Analytics) to a visualization (KPI, bar, line, donut, table). It
          renders against your own Azure estate day-one. <strong>No Microsoft Fabric or Power BI workspace is required.</strong>
        </Body1>

        {error && <MessageBar intent="error" style={{ marginBottom: 12 }}><MessageBarBody>{error}</MessageBarBody></MessageBar>}
        {okMsg && <MessageBar intent="success" style={{ marginBottom: 12 }}><MessageBarBody>{okMsg}</MessageBarBody></MessageBar>}

        {loading ? (
          <Spinner label="Loading dashboards…" />
        ) : dashboards.length === 0 ? (
          <div className={s.empty}>
            <ChartMultiple24Regular />
            <Text weight="semibold">No Loom-native dashboards yet</Text>
            <Caption1>Click <strong>New visual</strong> to build one from your Azure estate.</Caption1>
            <Button appearance="primary" icon={<Add24Regular />} onClick={openNew} style={{ marginTop: tokens.spacingVerticalS }}>New visual</Button>
          </div>
        ) : (
          <div className={s.grid}>
            {dashboards.map((d) => (
              <div key={d.id} className={s.card}>
                <div className={s.head}>
                  <TemplateIconChip category={d.category} size="md" />
                  <div className={s.headText}>
                    <span className={s.title} title={d.name}>{d.name}</span>
                    <Caption1 className={s.meta}>{d.tileCount} tile{d.tileCount === 1 ? '' : 's'}</Caption1>
                  </div>
                </div>
                <div className={s.body}>
                  <div className={s.metaRow}>
                    <Badge appearance="tint" color={accentBadgeColor(d.spec?.accent || 'brand')} size="small">{d.category}</Badge>
                    {d.published && <Badge appearance="tint" color="success" size="small" icon={<ChannelShare20Regular />}>Published</Badge>}
                  </div>
                  {d.description && <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>{d.description}</Caption1>}
                  <Caption1 className={s.meta}>Updated {fmt(d.updatedAt)} by {d.updatedBy}</Caption1>
                </div>
                <div className={s.actions}>
                  <Button size="small" appearance="primary" icon={<Open20Regular />} onClick={() => setOpenId(d.id)}>Open</Button>
                  <Button size="small" appearance="secondary" icon={<Edit20Regular />} onClick={() => openEdit(d)}>Edit</Button>
                  <Button size="small" appearance={d.published ? 'subtle' : 'secondary'}
                    icon={busyId === d.id ? <Spinner size="tiny" /> : <Share20Regular />}
                    disabled={busyId === d.id} onClick={() => togglePublish(d)}>
                    {d.published ? 'Unpublish' : 'Publish'}
                  </Button>
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={busyId === d.id} onClick={() => remove(d)}>Delete</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <VisualBuilderDialog
        open={builderOpen}
        edit={edit}
        onClose={() => setBuilderOpen(false)}
        onSaved={(name) => { setOkMsg(`Saved “${name}”.`); load(); }}
      />

      <ReportViewerDialog
        open={!!openDash}
        onClose={() => setOpenId(null)}
        fetchUrl={openDash ? `/api/admin/org-visuals/dashboards/render?id=${encodeURIComponent(openDash.id)}` : null}
        title={openDash?.name}
        defaultLive
      />
    </>
  );
}

export default DashboardsPane;
