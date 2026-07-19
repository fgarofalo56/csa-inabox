'use client';

/**
 * ObjectExplorerPanel (Foundry-parity row 2.6) — cross-type object browse +
 * facets + link traversal + saved explorations, over the shipped Weave AGE
 * store (via /api/items/ontology/[id]/explore). Fluent v9 + Loom tokens; honest
 * weave-gate + empty states. No Fabric — Apache AGE on PG.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Input, Badge, Spinner, Body1, Caption1, Subtitle2, Text,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Search20Regular, Cube20Regular, BranchFork20Regular, Save20Regular,
  ArrowSync20Regular, Dismiss16Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';

const useStyles = makeStyles({
  wrap: { display: 'flex', gap: tokens.spacingHorizontalL, minWidth: 0 },
  rail: { flex: '0 0 220px', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  railItem: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, borderRadius: tokens.borderRadiusMedium, cursor: 'pointer', border: `1px solid transparent` },
  railItemActive: { border: `1px solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2 },
  main: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  props: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2, overflowWrap: 'anywhere' },
  saved: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', alignItems: 'center' },
});

interface Obj { id: string; objectType: string; properties: Record<string, unknown> }
interface Facet { objectType: string; count: number }
interface Neighbor { linkType: string; direction: 'out' | 'in'; neighbor: Obj }
interface Saved { name: string; type: string; q?: string }

function propsPreview(p: Record<string, unknown>): string {
  return Object.entries(p || {}).filter(([k]) => !k.startsWith('_')).slice(0, 5).map(([k, v]) => `${k}=${String(v)}`).join('  ');
}

export function ObjectExplorerPanel({ ontologyId }: { ontologyId: string }) {
  const s = useStyles();
  const api = useCallback((p: string) => `/api/items/ontology/${encodeURIComponent(ontologyId)}${p}`, [ontologyId]);

  const [gate, setGate] = useState<string | null>(null);
  const [facets, setFacets] = useState<Facet[]>([]);
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [objects, setObjects] = useState<Obj[]>([]);
  const [busy, setBusy] = useState(false);
  const [neighbors, setNeighbors] = useState<{ from: Obj; items: Neighbor[] } | null>(null);
  const [saved, setSaved] = useState<Saved[]>([]);

  const loadFacets = useCallback(async () => {
    setBusy(true); setGate(null);
    try {
      const r = await clientFetch(api('/explore?mode=facets'));
      const j = await r.json();
      if (j.ok === false) { if (j.code === 'weave_not_configured') setGate(j.remediation || j.error); return; }
      setFacets(j.facets || []);
      if (!type && j.facets?.[0]) setType(j.facets[0].objectType);
    } catch { /* keep empty */ } finally { setBusy(false); }
  }, [api, type]);

  const loadSaved = useCallback(async () => {
    try { const r = await clientFetch(api('/explore?mode=saved')); const j = await r.json(); if (j.ok !== false) setSaved(j.explorations || []); } catch { /* */ }
  }, [api]);

  const search = useCallback(async (t = type, query = q) => {
    if (!t) return;
    setBusy(true); setNeighbors(null);
    try {
      const r = await clientFetch(api(`/explore?mode=search&type=${encodeURIComponent(t)}&q=${encodeURIComponent(query)}&top=200`));
      const j = await r.json();
      setObjects(j.ok === false ? [] : (j.objects || []));
    } catch { setObjects([]); } finally { setBusy(false); }
  }, [api, type, q]);

  const traverse = useCallback(async (o: Obj) => {
    setBusy(true);
    try {
      const r = await clientFetch(api(`/explore?mode=traverse&type=${encodeURIComponent(o.objectType)}&from=${encodeURIComponent(o.id)}`));
      const j = await r.json();
      setNeighbors({ from: o, items: j.ok === false ? [] : (j.neighbors || []) });
    } catch { setNeighbors({ from: o, items: [] }); } finally { setBusy(false); }
  }, [api]);

  const saveExploration = useCallback(async () => {
    if (!type) return;
    const name = `${type}${q ? `: ${q}` : ''}`.slice(0, 60);
    await clientFetch(api('/explore'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, type, q }) });
    await loadSaved();
  }, [api, type, q, loadSaved]);

  const removeSaved = useCallback(async (name: string) => {
    await clientFetch(api(`/explore?name=${encodeURIComponent(name)}`), { method: 'DELETE' });
    await loadSaved();
  }, [api, loadSaved]);

  useEffect(() => { void loadFacets(); void loadSaved(); }, [loadFacets, loadSaved]);
  useEffect(() => { if (type) void search(type, ''); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [type]);

  const columns = useMemo(() => {
    const keys = new Set<string>();
    for (const o of objects.slice(0, 20)) for (const k of Object.keys(o.properties || {})) if (!k.startsWith('_')) keys.add(k);
    return [...keys].slice(0, 6);
  }, [objects]);

  if (gate) {
    return (
      <MessageBar intent="warning" layout="multiline">
        <MessageBarBody>
          <MessageBarTitle>Object graph not configured</MessageBarTitle>
          {gate}
        </MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
      <div className={s.row}>
        <Subtitle2>Object Explorer</Subtitle2>
        <Button size="small" icon={<ArrowSync20Regular />} onClick={() => { void loadFacets(); void search(); }} disabled={busy}>Refresh</Button>
      </div>
      <Body1>Browse object instances across every type, search their properties, and traverse links — over the live Weave graph (Apache AGE on Postgres).</Body1>

      {saved.length > 0 && (
        <div className={s.saved}>
          <Caption1>Saved:</Caption1>
          {saved.map((sv) => (
            <Badge key={sv.name} appearance="tint" color="brand" style={{ cursor: 'pointer' }}
              onClick={() => { setType(sv.type); setQ(sv.q || ''); void search(sv.type, sv.q || ''); }}>
              {sv.name}
              <Dismiss16Regular style={{ marginLeft: tokens.spacingHorizontalXS, cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); void removeSaved(sv.name); }} />
            </Badge>
          ))}
        </div>
      )}

      <div className={s.wrap}>
        <div className={s.rail}>
          <Caption1>Object types</Caption1>
          {facets.length === 0 && !busy && <Caption1>No instances yet.</Caption1>}
          {facets.map((f) => (
            <div key={f.objectType} className={`${s.railItem} ${type === f.objectType ? s.railItemActive : ''}`}
              onClick={() => setType(f.objectType)}>
              <span><Cube20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalSNudge }} />{f.objectType}</span>
              <Badge appearance="tint" size="small">{f.count}</Badge>
            </div>
          ))}
        </div>

        <div className={s.main}>
          <div className={s.row}>
            <Input contentBefore={<Search20Regular />} placeholder={`Search ${type || 'objects'} properties…`} value={q}
              onChange={(_, d) => setQ(d.value)} onKeyDown={(e) => { if (e.key === 'Enter') void search(); }} style={{ minWidth: '280px' }} />
            <Button appearance="primary" icon={<Search20Regular />} onClick={() => void search()} disabled={busy || !type}>Search</Button>
            <Button size="small" icon={<Save20Regular />} onClick={saveExploration} disabled={!type}>Save exploration</Button>
            {busy && <Spinner size="tiny" />}
          </div>

          {objects.length === 0 && !busy ? (
            <Caption1>No objects — pick a type on the left, or create instances in the ontology.</Caption1>
          ) : (
            <Table size="small" aria-label="Objects">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>id</TableHeaderCell>
                  {columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
                  <TableHeaderCell />
                </TableRow>
              </TableHeader>
              <TableBody>
                {objects.slice(0, 200).map((o) => (
                  <TableRow key={o.id}>
                    <TableCell><Caption1>{o.id}</Caption1></TableCell>
                    {columns.map((c) => <TableCell key={c}><span className={s.props}>{String(o.properties?.[c] ?? '')}</span></TableCell>)}
                    <TableCell><Button size="small" icon={<BranchFork20Regular />} onClick={() => void traverse(o)}>Traverse</Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {neighbors && (
            <div>
              <Text weight="semibold">Links from object {neighbors.from.id}</Text>
              {neighbors.items.length === 0 ? (
                <Caption1 style={{ display: 'block' }}>No links from this object.</Caption1>
              ) : (
                <Table size="small" aria-label="Neighbors">
                  <TableHeader><TableRow><TableHeaderCell>Link</TableHeaderCell><TableHeaderCell>Dir</TableHeaderCell><TableHeaderCell>Neighbor type</TableHeaderCell><TableHeaderCell>Neighbor</TableHeaderCell></TableRow></TableHeader>
                  <TableBody>
                    {neighbors.items.map((n, i) => (
                      <TableRow key={i}>
                        <TableCell><Badge appearance="tint">{n.linkType}</Badge></TableCell>
                        <TableCell>{n.direction === 'out' ? '→' : '←'}</TableCell>
                        <TableCell>{n.neighbor.objectType}</TableCell>
                        <TableCell><span className={s.props}>{propsPreview(n.neighbor.properties)}</span></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
