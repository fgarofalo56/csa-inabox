'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * Data product editors — Template gallery + Instance detail.
 *
 * - DataProductTemplateEditor: lists all CSA curated templates as a grid;
 *   click → detail with components, est. cost, instructions/next-steps, a
 *   CUSTOMIZABLE component checklist (toggle/rename), and "Spawn into
 *   workspace" which POSTs to /api/items/data-product-template/[slug]/
 *   instantiate then NAVIGATES to the spawned instance + refreshes the tree.
 * - DataProductInstanceEditor: shows spawned components, a "Provision all"
 *   action that deploys them to real Azure backends, and live deploy + health.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Checkbox, Switch, Link as FLink,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell, Input, Label,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions, Spinner, Skeleton, SkeletonItem,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  BoxToolbox20Regular, Rocket20Regular, Search20Regular,
  AppsListDetail20Regular, GridDots20Regular, HeartPulse20Regular, Box20Regular,
  Open16Regular, BookInformation20Regular, CloudArrowUp20Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingHorizontalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: tokens.spacingHorizontalM },
  card: {
    padding: tokens.spacingHorizontalM,
    cursor: 'pointer',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    backgroundColor: tokens.colorNeutralBackground1,
    transition: 'box-shadow 0.15s ease, transform 0.15s ease, border-color 0.15s ease',
    minWidth: 0,
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    ':hover': {
      boxShadow: tokens.shadow16,
      transform: 'translateY(-2px)',
      border: `1px solid ${tokens.colorBrandStroke1}`,
    },
  },
  treePad: { padding: tokens.spacingHorizontalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  tableWrap: { overflow: 'auto', maxHeight: '360px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusSmall },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  searchInput: { maxWidth: '420px' },
  guide: { padding: tokens.spacingHorizontalM, backgroundColor: tokens.colorNeutralBackground2, borderRadius: tokens.borderRadiusLarge, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  rename: { minWidth: 0, maxWidth: '220px' },
});

interface Template {
  slug: string;
  displayName: string;
  description: string;
  category: string;
  estimatedMonthlyCostUsd: number;
  components: Array<{ slug: string; label: string; description: string }>;
  instructions?: string;
  nextSteps?: string[];
  references?: Array<{ label: string; href: string }>;
}

interface WorkspaceLite { id: string; name: string }

function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const r = await clientFetch('/api/loom/workspaces');
        const j = await r.json();
        if (!j.ok) { setError(j.error || `HTTP ${r.status}`); setWorkspaces([]); }
        else { setWorkspaces(j.workspaces || []); }
      } catch (e: any) {
        setError(e?.message || String(e));
        setWorkspaces([]);
      } finally { setLoading(false); }
    })();
  }, []);
  return { workspaces, error, loading };
}

export function DataProductTemplateEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const router = useRouter();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selected, setSelected] = useState<Template | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string>('');
  const [displayName, setDisplayName] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [filter, setFilter] = useState('');
  const [deploy, setDeploy] = useState(false);
  // Customization: include flag + optional rename, keyed by component index.
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [renames, setRenames] = useState<Record<number, string>>({});
  const ws = useWorkspaces();

  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await clientFetch(`/api/items/data-product-template`);
      const j = await r.json();
      if (j.ok) {
        const curated: Template[] = j.curated || [];
        setTemplates(curated);
        setSelected((cur) => cur ?? curated[0] ?? null);
      }
    } finally { setRefreshing(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!workspaceId && (ws.workspaces?.length ?? 0) > 0) setWorkspaceId(ws.workspaces![0].id);
  }, [ws.workspaces, workspaceId]);

  useEffect(() => {
    if (selected && !displayName) setDisplayName(`${selected.displayName} (prod)`);
    setExcluded(new Set()); setRenames({});
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const instantiate = useCallback(async () => {
    if (!selected || !workspaceId || !displayName) return;
    setBusy(true); setResult(null);
    try {
      const components = selected.components
        .map((c, i) => excluded.has(i) ? null : { slug: c.slug, label: c.label, renameTo: renames[i] })
        .filter(Boolean);
      const r = await clientFetch(`/api/items/data-product-template/${selected.slug}/instantiate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, displayName, components, provision: deploy }),
      });
      const j = await r.json();
      setResult(j);
      if (j.ok && j.instance?.id) {
        try { window.dispatchEvent(new CustomEvent('loom:item-saved', { detail: { label: displayName } })); } catch {}
        // Land the user ON the new product so the spawned items are visible.
        router.push(`/items/data-product-instance/${j.instance.id}`);
      }
    } finally { setBusy(false); }
  }, [selected, workspaceId, displayName, excluded, renames, deploy, router]);

  const includedCount = selected ? selected.components.length - excluded.size : 0;
  const canSpawn = !!selected && !!workspaceId && !!displayName && includedCount > 0 && !busy;
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((t) =>
      t.displayName.toLowerCase().includes(q) ||
      t.category.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.components.some((c) => c.label.toLowerCase().includes(q) || c.slug.toLowerCase().includes(q)),
    );
  }, [templates, filter]);
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Library', actions: [
        { label: 'Browse all', onClick: () => setSelected(null) },
        { label: refreshing ? 'Refreshing…' : 'Refresh', onClick: refreshing ? undefined : refresh, disabled: refreshing },
      ]},
      { label: 'Instantiate', actions: [
        { label: busy ? 'Spawning…' : 'Spawn into workspace', onClick: canSpawn ? instantiate : undefined, disabled: !canSpawn },
      ]},
    ]},
  ], [refreshing, refresh, busy, canSpawn, instantiate]);

  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 className={s.sectionHeader}><AppsListDetail20Regular />Templates ({templates.length})</Subtitle2>
          <Caption1>CSA-curated push-button patterns. Click a card to inspect components, customize, and spawn.</Caption1>
        </div>
      }
      main={
        <div className={s.pad}>
          {!selected ? (
            <>
            <Input value={filter} onChange={(_, d) => setFilter(d.value)}
              placeholder="Search templates by name, category, or component…"
              contentBefore={<Search20Regular />} className={s.searchInput} />
            {refreshing && templates.length === 0 ? (
              <div className={s.grid} aria-busy="true">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className={s.card} style={{ cursor: 'default' }}>
                    <Skeleton aria-label="Loading templates">
                      <SkeletonItem size={24} style={{ width: '70%', marginBottom: tokens.spacingVerticalS }} />
                      <SkeletonItem size={16} style={{ width: '50%', marginBottom: tokens.spacingVerticalS }} />
                      <SkeletonItem size={16} style={{ width: '90%', marginBottom: tokens.spacingVerticalXS }} />
                      <SkeletonItem size={16} style={{ width: '40%' }} />
                    </Skeleton>
                  </div>
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState icon={filter ? <Search20Regular /> : <BoxToolbox20Regular />}
                title={filter ? 'No matching templates' : 'No templates available'}
                body={filter ? `No templates match "${filter}".` : 'CSA-curated data-product templates will appear here.'}
                primaryAction={filter ? { label: 'Clear search', onClick: () => setFilter(''), appearance: 'secondary' } : undefined} />
            ) : (
              <div className={s.grid}>
                {filtered.map((t) => (
                  <div key={t.slug} className={s.card} onClick={() => setSelected(t)}>
                    <Subtitle2>{t.displayName}</Subtitle2>
                    <Caption1>{t.category} · ~${t.estimatedMonthlyCostUsd.toLocaleString()}/mo</Caption1>
                    <Body1 style={{ marginTop: tokens.spacingVerticalS }}>{t.description}</Body1>
                    <Caption1 style={{ marginTop: tokens.spacingVerticalS }}>{t.components.length} components</Caption1>
                  </div>
                ))}
              </div>
            )}
            </>
          ) : (
            <>
              <div><Button onClick={() => setSelected(null)}>← Back to library</Button></div>
              <Subtitle2>{selected.displayName}</Subtitle2>
              <Caption1>{selected.category} · estimated ~${selected.estimatedMonthlyCostUsd.toLocaleString()}/mo</Caption1>
              <Body1>{selected.description}</Body1>

              {selected.instructions && (
                <div className={s.guide}>
                  <Subtitle2 className={s.sectionHeader}><BookInformation20Regular />What this builds</Subtitle2>
                  <Body1>{selected.instructions}</Body1>
                  {(selected.nextSteps?.length ?? 0) > 0 && (
                    <ol style={{ margin: `${tokens.spacingVerticalS} 0 0`, paddingLeft: tokens.spacingHorizontalXL }}>
                      {selected.nextSteps!.map((n, i) => <li key={i}><Caption1>{n}</Caption1></li>)}
                    </ol>
                  )}
                  {(selected.references?.length ?? 0) > 0 && (
                    <Caption1 style={{ marginTop: tokens.spacingVerticalXS }}>Reference: {selected.references!.map((r, i) => (
                      <span key={i}>{i > 0 ? ' · ' : ''}<FLink href={r.href} target="_blank">{r.label}</FLink></span>))}</Caption1>
                  )}
                </div>
              )}

              <Subtitle2 className={s.sectionHeader} style={{ marginTop: tokens.spacingVerticalM }}><BoxToolbox20Regular />Components — select & rename ({includedCount}/{selected.components.length})</Subtitle2>
              <div className={s.tableWrap}>
                <Table size="small">
                  <TableHeader><TableRow>
                    <TableHeaderCell>Include</TableHeaderCell>
                    <TableHeaderCell>Label</TableHeaderCell>
                    <TableHeaderCell>Item type</TableHeaderCell>
                    <TableHeaderCell>Rename</TableHeaderCell>
                  </TableRow></TableHeader>
                  <TableBody>
                    {selected.components.map((c, i) => (
                      <TableRow key={i}>
                        <TableCell><Checkbox checked={!excluded.has(i)} onChange={(_, d) => setExcluded((prev) => { const n = new Set(prev); if (d.checked) n.delete(i); else n.add(i); return n; })} /></TableCell>
                        <TableCell><strong>{c.label}</strong><br /><Caption1>{c.description}</Caption1></TableCell>
                        <TableCell><code style={{ fontSize: tokens.fontSizeBase200 }}>{c.slug}</code></TableCell>
                        <TableCell><Input className={s.rename} size="small" value={renames[i] ?? ''} placeholder={c.label} disabled={excluded.has(i)} onChange={(_, d) => setRenames((p) => ({ ...p, [i]: d.value }))} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className={s.field}><Label>Target workspace</Label>
                <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}
                  disabled={ws.loading || (ws.workspaces?.length ?? 0) === 0}
                  style={{ padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusSmall, border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}>
                  {ws.loading && <option value="">Loading workspaces…</option>}
                  {!ws.loading && (ws.workspaces?.length ?? 0) === 0 && <option value="">{ws.error ? 'Workspace discovery failed' : 'No workspaces — create one first'}</option>}
                  {!ws.loading && (ws.workspaces?.length ?? 0) > 0 && !workspaceId && <option value="">Select a workspace</option>}
                  {(ws.workspaces || []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </div>
              <div className={s.field}><Label>Instance display name</Label>
                <Input value={displayName} onChange={(_, d) => setDisplayName(d.value)} placeholder={`${selected.displayName} (prod)`} />
              </div>
              <Switch checked={deploy} onChange={(_, d) => setDeploy(!!d.checked)} label="Deploy to live Azure backends now (else create as scaffold)" />
              <Button appearance="primary" icon={<Rocket20Regular />} disabled={!canSpawn} onClick={instantiate}>
                {busy ? 'Spawning…' : `Instantiate ${includedCount} component${includedCount === 1 ? '' : 's'}`}
              </Button>
              {result && !result.ok && (
                <MessageBar intent="error"><MessageBarBody>
                  <MessageBarTitle>Instantiation failed</MessageBarTitle>
                  <span style={{ overflowWrap: 'anywhere' }}>{result.error || 'Unknown error'}</span>
                </MessageBarBody></MessageBar>
              )}
              {result?.ok && (
                <MessageBar intent="success"><MessageBarBody>
                  <MessageBarTitle>Instantiated — opening the data product…</MessageBarTitle>
                  Created <strong>{result.created?.length || 0}</strong> items.
                </MessageBarBody>
                <MessageBarActions><FLink href={`/items/data-product-instance/${result.instance?.id}`}>Open data product</FLink></MessageBarActions>
                </MessageBar>
              )}
            </>
          )}
        </div>
      }
    />
  );
}

interface ComponentHealth { status: 'ok' | 'stale' | 'missing' | 'unknown'; detail?: string; lastUpdated?: string; }

function classifyHealth(updatedAt?: string): ComponentHealth {
  if (!updatedAt) return { status: 'unknown', detail: 'no updatedAt' };
  const ms = Date.now() - new Date(updatedAt).getTime();
  if (Number.isNaN(ms)) return { status: 'unknown', detail: 'invalid timestamp' };
  const days = ms / (1000 * 60 * 60 * 24);
  if (days < 7) return { status: 'ok', detail: `updated ${days.toFixed(1)}d ago`, lastUpdated: updatedAt };
  if (days < 30) return { status: 'stale', detail: `updated ${days.toFixed(0)}d ago`, lastUpdated: updatedAt };
  return { status: 'stale', detail: `last updated ${days.toFixed(0)}d ago — likely abandoned`, lastUpdated: updatedAt };
}

export function DataProductInstanceEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [instance, setInstance] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, ComponentHealth>>({});
  const [provisioning, setProvisioning] = useState(false);
  const [provMsg, setProvMsg] = useState<string | null>(null);

  const loadInstance = useCallback(async () => {
    if (!id || id === 'new') return;
    try {
      const r = await clientFetch(`/api/items/data-product-instance/${id}`);
      const j = await r.json();
      if (j.ok) { setInstance(j.item); setErr(null); }
      else setErr(j.error);
    } catch (e: any) { setErr(String(e)); }
  }, [id]);

  useEffect(() => { loadInstance(); }, [loadInstance]);

  const components: Array<{ slug: string; itemId: string; displayName: string }> = instance?.state?.components || [];
  const errors: Array<{ slug: string; error: string }> = instance?.state?.errors || [];
  const provSteps: Array<{ cosmosItemId: string; result: { status: string; error?: string } }> = instance?.state?.provisionReport?.steps || [];
  const provByItem = useMemo(() => Object.fromEntries(provSteps.map((s2) => [s2.cosmosItemId, s2.result])), [provSteps]);

  const refreshHealth = useCallback(async () => {
    const next: Record<string, ComponentHealth> = {};
    await Promise.all(components.map(async (c) => {
      try {
        const r = await clientFetch(`/api/cosmos-items/${encodeURIComponent(c.slug)}/${encodeURIComponent(c.itemId)}`);
        if (r.status === 404) { next[c.itemId] = { status: 'missing', detail: 'item not found in Cosmos' }; return; }
        const j = await r.json();
        next[c.itemId] = j.ok ? classifyHealth(j.item?.updatedAt) : { status: 'unknown', detail: j.error };
      } catch (e: any) { next[c.itemId] = { status: 'unknown', detail: e?.message || String(e) }; }
    }));
    setHealth(next);
  }, [components]);

  const provisionAll = useCallback(async () => {
    if (id === 'new') return;
    setProvisioning(true); setProvMsg(null);
    try {
      const r = await clientFetch(`/api/items/data-product-instance/${id}/provision`, { method: 'POST' });
      const j = await r.json();
      setProvMsg(j.ok ? `Provision ${j.report?.outcome || 'done'} — ${(j.report?.steps || []).length} component(s).` : (j.error || 'failed'));
      await loadInstance();
    } finally { setProvisioning(false); }
  }, [id, loadInstance]);

  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={[{ id: 'home', label: 'Home', groups: [{ label: 'Manage', actions: [
        { label: 'Refresh', onClick: loadInstance },
        { label: provisioning ? 'Provisioning…' : 'Provision all', onClick: provisioning ? undefined : provisionAll, disabled: provisioning || components.length === 0 },
        { label: 'Health', onClick: refreshHealth },
      ] }] }]}
      leftPanel={<div className={s.treePad}>
        <Subtitle2 className={s.sectionHeader}><Box20Regular />Instance</Subtitle2>
        <Caption1>{instance?.displayName || '—'}</Caption1>
        <Caption1>Template: <code>{instance?.state?.template || '—'}</code></Caption1>
        <Button size="small" icon={<CloudArrowUp20Regular />} disabled={provisioning || components.length === 0} onClick={provisionAll} style={{ marginTop: tokens.spacingVerticalS, alignSelf: 'flex-start' }}>{provisioning ? 'Provisioning…' : 'Provision all'}</Button>
        <Button size="small" icon={<HeartPulse20Regular />} onClick={refreshHealth} style={{ alignSelf: 'flex-start' }}>Check health</Button>
      </div>}
      main={
        <div className={s.pad}>
          {err && <MessageBar intent="error"><MessageBarBody><span style={{ overflowWrap: 'anywhere' }}>{err}</span></MessageBarBody></MessageBar>}
          {provMsg && <MessageBar intent="info"><MessageBarBody>{provMsg}</MessageBarBody></MessageBar>}
          {id !== 'new' && !instance && !err ? (
            <Spinner size="small" label="Loading instance…" labelPosition="after" style={{ justifyContent: 'flex-start' }} />
          ) : components.length === 0 ? (
            <EmptyState icon={<BoxToolbox20Regular />} title="No components yet"
              body="This data product has no spawned components. Instantiate from a CSA-curated template to populate it."
              primaryAction={{ label: 'Browse templates', href: '/items/data-product-template/new' }} />
          ) : (
          <>
          <Subtitle2 className={s.sectionHeader}><GridDots20Regular />Components ({components.length})</Subtitle2>
          <div className={s.tableWrap}>
            <Table size="small">
              <TableHeader><TableRow>
                <TableHeaderCell>Display name</TableHeaderCell>
                <TableHeaderCell>Item type</TableHeaderCell>
                <TableHeaderCell>Deploy</TableHeaderCell>
                <TableHeaderCell>Health</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {components.map((c) => {
                  const h = health[c.itemId]; const p = provByItem[c.itemId];
                  return (
                    <TableRow key={c.itemId}>
                      <TableCell style={{ overflowWrap: 'anywhere' }}><a href={`/items/${c.slug}/${c.itemId}`}>{c.displayName}</a> <Open16Regular /></TableCell>
                      <TableCell><code style={{ fontSize: tokens.fontSizeBase200 }}>{c.slug}</code></TableCell>
                      <TableCell>
                        {!p && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Not provisioned</Caption1>}
                        {p?.status === 'created' && <Badge appearance="filled" color="success">Deployed</Badge>}
                        {p?.status === 'skipped' && <Badge appearance="outline">Skipped</Badge>}
                        {p?.status === 'remediation' && <Badge appearance="filled" color="warning">Needs config</Badge>}
                        {p?.status === 'failed' && <Badge appearance="filled" color="danger">Failed</Badge>}
                      </TableCell>
                      <TableCell>
                        {!h && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>—</Caption1>}
                        {h?.status === 'ok' && <Badge appearance="filled" color="success">OK</Badge>}
                        {h?.status === 'stale' && <Badge appearance="filled" color="warning">Stale</Badge>}
                        {h?.status === 'missing' && <Badge appearance="filled" color="danger">Missing</Badge>}
                        {h?.status === 'unknown' && <Badge appearance="outline">Unknown</Badge>}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {errors.length > 0 && (
            <MessageBar intent="warning"><MessageBarBody>
              <MessageBarTitle>Partial failures during instantiation</MessageBarTitle>
              {errors.map((e, i) => (<div key={i} style={{ overflowWrap: 'anywhere' }}><code>{e.slug}</code>: {e.error}</div>))}
            </MessageBarBody></MessageBar>
          )}
          </>
          )}
        </div>
      }
    />
  );
}
