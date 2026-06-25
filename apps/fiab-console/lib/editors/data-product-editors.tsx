'use client';

/**
 * Data product editors — Template gallery + Instance detail.
 *
 * - DataProductTemplateEditor: lists all CSA curated templates as a grid;
 *   click → detail with components, est. cost, and "Instantiate" button
 *   which POSTs to /api/items/data-product-template/[slug]/instantiate.
 * - DataProductInstanceEditor: shows the components that were spawned for
 *   this instance + a status table. Health column is best-effort (peeks
 *   at child items' updatedAt).
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Card, CardHeader, Input, Label,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, Spinner, Skeleton, SkeletonItem,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, BoxToolbox20Regular, Rocket20Regular, Search20Regular,
  AppsListDetail20Regular, GridDots20Regular, HeartPulse20Regular, Box20Regular,
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
  cardActive: {
    padding: tokens.spacingHorizontalM,
    border: `2px solid ${tokens.colorBrandStroke1}`,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow16,
    backgroundColor: tokens.colorBrandBackground2,
    minWidth: 0,
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
  },
  treePad: { padding: tokens.spacingHorizontalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  tableWrap: { overflow: 'auto', maxHeight: '360px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusSmall },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  searchInput: { maxWidth: '420px' },
});

interface Template {
  slug: string;
  displayName: string;
  description: string;
  category: string;
  estimatedMonthlyCostUsd: number;
  components: Array<{ slug: string; label: string; description: string }>;
}

interface WorkspaceLite { id: string; name: string }

function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/loom/workspaces');
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
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selected, setSelected] = useState<Template | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string>('');
  const [displayName, setDisplayName] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [filter, setFilter] = useState('');
  const ws = useWorkspaces();

  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await fetch(`/api/items/data-product-template`);
      const j = await r.json();
      if (j.ok) {
        const curated: Template[] = j.curated || [];
        setTemplates(curated);
        // Auto-select the first template so the instantiate form (and the
        // primary "Spawn into workspace" action) is reachable on /new without
        // the user having to dig through the grid first.
        setSelected((cur) => cur ?? curated[0] ?? null);
      }
    } finally { setRefreshing(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Default the target workspace to the first available one so the primary
  // "Spawn into workspace" action is enabled as soon as a name is entered.
  useEffect(() => {
    if (!workspaceId && (ws.workspaces?.length ?? 0) > 0) {
      setWorkspaceId(ws.workspaces![0].id);
    }
  }, [ws.workspaces, workspaceId]);

  // Seed a sensible default instance name from the selected template so the
  // primary action is clickable without manual typing (user can still edit it).
  useEffect(() => {
    if (selected && !displayName) setDisplayName(`${selected.displayName} (prod)`);
  }, [selected, displayName]);

  const instantiate = useCallback(async () => {
    if (!selected || !workspaceId || !displayName) return;
    setBusy(true); setResult(null);
    try {
      const r = await fetch(`/api/items/data-product-template/${selected.slug}/instantiate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, displayName }),
      });
      setResult(await r.json());
    } finally { setBusy(false); }
  }, [selected, workspaceId, displayName]);

  const canSpawn = !!selected && !!workspaceId && !!displayName && !busy;
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
          <Caption1>CSA-curated push-button patterns. Click a card to inspect components + est. cost.</Caption1>
        </div>
      }
      main={
        <div className={s.pad}>
          {!selected ? (
            <>
            <Input
              value={filter}
              onChange={(_, d) => setFilter(d.value)}
              placeholder="Search templates by name, category, or component…"
              contentBefore={<Search20Regular />}
              className={s.searchInput}
            />
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
              <EmptyState
                icon={filter ? <Search20Regular /> : <BoxToolbox20Regular />}
                title={filter ? 'No matching templates' : 'No templates available'}
                body={filter
                  ? `No templates match "${filter}". Try a different name, category, or component.`
                  : 'CSA-curated data-product templates will appear here. Use Refresh to reload the library.'}
                primaryAction={filter ? { label: 'Clear search', onClick: () => setFilter(''), appearance: 'secondary' } : undefined}
              />
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
              <div>
                <Button onClick={() => setSelected(null)}>← Back to library</Button>
              </div>
              <Subtitle2>{selected.displayName}</Subtitle2>
              <Caption1>{selected.category} · estimated ~${selected.estimatedMonthlyCostUsd.toLocaleString()}/mo</Caption1>
              <Body1>{selected.description}</Body1>
              <Subtitle2 className={s.sectionHeader} style={{ marginTop: tokens.spacingVerticalM }}><BoxToolbox20Regular />Components</Subtitle2>
              <div className={s.tableWrap}>
                <Table size="small">
                  <TableHeader><TableRow>
                    <TableHeaderCell>Label</TableHeaderCell>
                    <TableHeaderCell>Item type</TableHeaderCell>
                    <TableHeaderCell>Description</TableHeaderCell>
                  </TableRow></TableHeader>
                  <TableBody>
                    {selected.components.map((c, i) => (
                      <TableRow key={i}>
                        <TableCell><strong>{c.label}</strong></TableCell>
                        <TableCell><code style={{ fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{c.slug}</code></TableCell>
                        <TableCell style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{c.description}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <MessageBar intent="info"><MessageBarBody>
                Instantiate creates <strong>{selected.components.length}</strong> child items in the workspace
                + one <code>data-product-instance</code> parent that links them.
              </MessageBarBody></MessageBar>

              <div className={s.field}><Label>Target workspace</Label>
                <select
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                  disabled={ws.loading || (ws.workspaces?.length ?? 0) === 0}
                  style={{ padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusSmall, border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}
                >
                  {ws.loading && <option value="">Loading workspaces…</option>}
                  {!ws.loading && (ws.workspaces?.length ?? 0) === 0 && (
                    <option value="">{ws.error ? 'Workspace discovery failed' : 'No workspaces — create one first'}</option>
                  )}
                  {!ws.loading && (ws.workspaces?.length ?? 0) > 0 && !workspaceId && (
                    <option value="">Select a workspace</option>
                  )}
                  {(ws.workspaces || []).map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
                {ws.error && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>Workspaces not reachable</MessageBarTitle>
                      <span style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{ws.error}</span>
                    </MessageBarBody>
                  </MessageBar>
                )}
              </div>
              <div className={s.field}><Label>Instance display name</Label>
                <Input value={displayName} onChange={(_, d) => setDisplayName(d.value)} placeholder={`${selected.displayName} (prod)`} />
              </div>
              <Button appearance="primary" icon={<Rocket20Regular />} disabled={busy || !workspaceId || !displayName} onClick={instantiate}>
                Instantiate in workspace
              </Button>
              {result && (
                <MessageBar intent={result.ok ? 'success' : 'error'}>
                  <MessageBarBody>
                    <MessageBarTitle>{result.ok ? 'Instantiated' : 'Instantiation failed'}</MessageBarTitle>
                    {result.ok
                      ? <>Created <strong>{result.created?.length || 0}</strong> child items.{(result.errors?.length || 0) > 0 && ` ${result.errors.length} component(s) failed.`}</>
                      : <span style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{result.error || 'Unknown error'}</span>}
                  </MessageBarBody>
                </MessageBar>
              )}
            </>
          )}
        </div>
      }
    />
  );
}

interface ComponentHealth {
  status: 'ok' | 'stale' | 'missing' | 'unknown';
  detail?: string;
  lastUpdated?: string;
}

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

  const loadInstance = useCallback(async () => {
    // Pre-save gate: /items/data-product-instance/new fires this before any
    // Cosmos record exists. Skip the fetch — the editor's empty-state UI
    // will guide the user to instantiate from a template.
    if (!id || id === 'new') return;
    try {
      const r = await fetch(`/api/items/data-product-instance/${id}`);
      const j = await r.json();
      if (j.ok) { setInstance(j.item); setErr(null); }
      else setErr(j.error);
    } catch (e: any) { setErr(String(e)); }
  }, [id]);

  useEffect(() => { loadInstance(); }, [loadInstance]);

  const components: Array<{ slug: string; itemId: string; displayName: string }> = instance?.state?.components || [];
  const errors: Array<{ slug: string; error: string }> = instance?.state?.errors || [];

  // v3.27: wire the Health ribbon button + render the previously-claimed
  // Health column. Peeks at each child item's updatedAt via /api/cosmos-items.
  const refreshHealth = useCallback(async () => {
    const next: Record<string, ComponentHealth> = {};
    await Promise.all(components.map(async (c) => {
      try {
        const r = await fetch(`/api/cosmos-items/${encodeURIComponent(c.slug)}/${encodeURIComponent(c.itemId)}`);
        if (r.status === 404) { next[c.itemId] = { status: 'missing', detail: 'item not found in Cosmos' }; return; }
        const j = await r.json();
        next[c.itemId] = j.ok ? classifyHealth(j.item?.updatedAt) : { status: 'unknown', detail: j.error };
      } catch (e: any) {
        next[c.itemId] = { status: 'unknown', detail: e?.message || String(e) };
      }
    }));
    setHealth(next);
  }, [components]);

  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={[{ id: 'home', label: 'Home', groups: [{ label: 'Manage', actions: [
        { label: 'Refresh', onClick: loadInstance },
        { label: 'Health', onClick: refreshHealth },
      ] }] }]}
      leftPanel={<div className={s.treePad}>
        <Subtitle2 className={s.sectionHeader}><Box20Regular />Instance</Subtitle2>
        <Caption1>{instance?.displayName || '—'}</Caption1>
        <Caption1>Template: <code>{instance?.state?.template || '—'}</code></Caption1>
        <Button size="small" icon={<HeartPulse20Regular />} onClick={refreshHealth} style={{ marginTop: tokens.spacingVerticalS, alignSelf: 'flex-start' }}>Check component health</Button>
      </div>}
      main={
        <div className={s.pad}>
          {err && <MessageBar intent="error"><MessageBarBody><span style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{err}</span></MessageBarBody></MessageBar>}
          {id !== 'new' && !instance && !err ? (
            <Spinner size="small" label="Loading instance…" labelPosition="after" style={{ justifyContent: 'flex-start' }} />
          ) : components.length === 0 ? (
            <EmptyState
              icon={<BoxToolbox20Regular />}
              title="No components yet"
              body="This data product has no spawned components. Instantiate from a CSA-curated template to populate this instance with its child items."
              primaryAction={{ label: 'Browse templates', href: '/items/data-product-template/new' }}
            />
          ) : (
          <>
          <Subtitle2 className={s.sectionHeader}><GridDots20Regular />Components ({components.length})</Subtitle2>
          <div className={s.tableWrap}>
            <Table size="small">
              <TableHeader><TableRow>
                <TableHeaderCell>Display name</TableHeaderCell>
                <TableHeaderCell>Item type</TableHeaderCell>
                <TableHeaderCell>Item id</TableHeaderCell>
                <TableHeaderCell>Health</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {components.map((c) => {
                  const h = health[c.itemId];
                  return (
                    <TableRow key={c.itemId}>
                      <TableCell style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}><a href={`/items/${c.slug}/${c.itemId}`}>{c.displayName}</a></TableCell>
                      <TableCell><code style={{ fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{c.slug}</code></TableCell>
                      <TableCell><code style={{ fontSize: tokens.fontSizeBase100, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{c.itemId}</code></TableCell>
                      <TableCell>
                        {!h && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Click "Check component health"</Caption1>}
                        {h?.status === 'ok' && <Badge appearance="filled" color="success">OK</Badge>}
                        {h?.status === 'stale' && <Badge appearance="filled" color="warning">Stale</Badge>}
                        {h?.status === 'missing' && <Badge appearance="filled" color="danger">Missing</Badge>}
                        {h?.status === 'unknown' && <Badge appearance="outline">Unknown</Badge>}
                        {h?.detail && <Caption1 style={{ marginLeft: tokens.spacingHorizontalXS, color: tokens.colorNeutralForeground3, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{h.detail}</Caption1>}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {errors.length > 0 && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Partial failures during instantiation</MessageBarTitle>
                {errors.map((e, i) => (<div key={i} style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}><code>{e.slug}</code>: {e.error}</div>))}
              </MessageBarBody>
            </MessageBar>
          )}
          </>
          )}
        </div>
      }
    />
  );
}
