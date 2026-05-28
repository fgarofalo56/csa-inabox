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
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add20Regular, BoxToolbox20Regular, Rocket20Regular } from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 },
  card: { padding: 12, cursor: 'pointer', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6 },
  cardActive: { padding: 12, border: `2px solid ${tokens.colorBrandStroke1}`, borderRadius: 6, background: tokens.colorBrandBackground2 },
  treePad: { padding: 12, display: 'flex', flexDirection: 'column', gap: 8 },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  tableWrap: { overflow: 'auto', maxHeight: 360, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
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
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Library', actions: [
        { label: 'Browse', disabled: true, title: 'cross-catalog template browser deferred (only curated templates surfaced today)' },
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
          <Subtitle2>Templates ({templates.length})</Subtitle2>
          <Caption1>CSA-curated push-button patterns. Click a card to inspect components + est. cost.</Caption1>
        </div>
      }
      main={
        <div className={s.pad}>
          {!selected ? (
            <div className={s.grid}>
              {templates.map((t) => (
                <div key={t.slug} className={s.card} onClick={() => setSelected(t)}>
                  <Subtitle2>{t.displayName}</Subtitle2>
                  <Caption1>{t.category} · ~${t.estimatedMonthlyCostUsd.toLocaleString()}/mo</Caption1>
                  <Body1 style={{ marginTop: 6 }}>{t.description}</Body1>
                  <Caption1 style={{ marginTop: 6 }}>{t.components.length} components</Caption1>
                </div>
              ))}
            </div>
          ) : (
            <>
              <div>
                <Button onClick={() => setSelected(null)}>← Back to library</Button>
              </div>
              <Subtitle2>{selected.displayName}</Subtitle2>
              <Caption1>{selected.category} · estimated ~${selected.estimatedMonthlyCostUsd.toLocaleString()}/mo</Caption1>
              <Body1>{selected.description}</Body1>
              <Subtitle2 style={{ marginTop: 10 }}>Components</Subtitle2>
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
                        <TableCell><code style={{ fontSize: 12 }}>{c.slug}</code></TableCell>
                        <TableCell>{c.description}</TableCell>
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
                  style={{ padding: 6, borderRadius: 4, border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}
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
                      {ws.error}
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
                      : (result.error || 'Unknown error')}
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
        <Subtitle2>Instance</Subtitle2>
        <Caption1>{instance?.displayName || '—'}</Caption1>
        <Caption1>Template: <code>{instance?.state?.template || '—'}</code></Caption1>
        <Button size="small" onClick={refreshHealth} style={{ marginTop: 8, alignSelf: 'flex-start' }}>Check component health</Button>
      </div>}
      main={
        <div className={s.pad}>
          {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
          <Subtitle2>Components ({components.length})</Subtitle2>
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
                      <TableCell><a href={`/items/${c.slug}/${c.itemId}`}>{c.displayName}</a></TableCell>
                      <TableCell><code style={{ fontSize: 12 }}>{c.slug}</code></TableCell>
                      <TableCell><code style={{ fontSize: 11 }}>{c.itemId}</code></TableCell>
                      <TableCell>
                        {!h && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Click "Check component health"</Caption1>}
                        {h?.status === 'ok' && <Badge appearance="filled" color="success">OK</Badge>}
                        {h?.status === 'stale' && <Badge appearance="filled" color="warning">Stale</Badge>}
                        {h?.status === 'missing' && <Badge appearance="filled" color="danger">Missing</Badge>}
                        {h?.status === 'unknown' && <Badge appearance="outline">Unknown</Badge>}
                        {h?.detail && <Caption1 style={{ marginLeft: 6, color: tokens.colorNeutralForeground3 }}>{h.detail}</Caption1>}
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
                {errors.map((e, i) => (<div key={i}><code>{e.slug}</code>: {e.error}</div>))}
              </MessageBarBody>
            </MessageBar>
          )}
        </div>
      }
    />
  );
}
