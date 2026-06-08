'use client';

/**
 * LinkedResourcesPanel — F10 "Linked resources" surface for the data-product
 * editor. Three sections, each with an ellipsis (⋯) Remove per row:
 *
 *   1. Glossary terms — attach REAL Purview classic-glossary terms (keyword +
 *      domain/glossary filter, multi-select Add). Persists to the item's
 *      state.glossaryLinks[] via /api/data-products/[id]/glossary-terms and
 *      best-effort assigns the term to the registered Purview product.
 *   2. OKRs — Loom-native objectives & key results in the Cosmos `okrs`
 *      container via /api/data-products/[id]/okrs.
 *   3. Critical Data Elements (read-only) — auto-derived from the Purview
 *      classifications on mapped assets via /api/data-products/[id]/cdes.
 *
 * Azure-native default — no Fabric/Power BI dependency. Honest infra-gates via
 * Fluent MessageBar when Purview is unprovisioned.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Input, Textarea, Field, Dropdown, Option, Checkbox,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, MoreHorizontal20Regular, Delete20Regular,
  Library20Regular, Target20Regular, ShieldTask20Regular,
} from '@fluentui/react-icons';

interface GlossaryLink { name: string; guid?: string; glossaryGuid?: string; }
interface OkrDoc {
  id: string; dataProductId: string; name: string; description?: string;
  metric?: string; target?: string; current?: string; status: string;
  createdAt: string; updatedAt: string;
}
interface Cde { typeName: string; displayName: string; assetGuid: string; assetName?: string; }
interface PurviewTerm { guid: string; name?: string; qualifiedName?: string; }

const OKR_STATUSES = [
  { value: 'on-track', label: 'On track', color: 'success' as const },
  { value: 'behind', label: 'Behind', color: 'warning' as const },
  { value: 'at-risk', label: 'At risk', color: 'danger' as const },
];

function RemoveMenu({ onRemove, label = 'Remove' }: { onRemove: () => void; label?: string }) {
  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <Button size="small" appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label="More actions" />
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItem icon={<Delete20Regular />} onClick={onRemove}>{label}</MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

// ============================================================
// Glossary terms section
// ============================================================

function GlossarySection({
  dataProductId, links, onLinksChange,
}: {
  dataProductId: string;
  links: GlossaryLink[];
  onLinksChange: (links: GlossaryLink[]) => void;
}) {
  const [glossaries, setGlossaries] = useState<{ guid: string; name: string }[]>([]);
  const [glossaryGuid, setGlossaryGuid] = useState<string>('');
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<PurviewTerm[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // Load glossaries (the "domain" filter) once.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/admin/security/purview/glossary?list=glossaries');
        const j = await r.json();
        if (r.status === 501) { setGate('Purview not provisioned (LOOM_PURVIEW_ACCOUNT unset) — glossary search is unavailable, but you can still manage already-linked terms.'); return; }
        if (j?.ok) setGlossaries(j.glossaries || []);
      } catch { /* leave empty */ }
    })();
  }, []);

  const search = useCallback(async () => {
    setSearching(true); setMsg(null); setGate(null);
    try {
      const qs = new URLSearchParams();
      if (glossaryGuid) qs.set('glossaryGuid', glossaryGuid);
      if (keyword.trim()) qs.set('keyword', keyword.trim());
      const r = await fetch(`/api/admin/security/purview/glossary?${qs.toString()}`);
      const j = await r.json();
      if (r.status === 501) { setGate('Purview not provisioned (LOOM_PURVIEW_ACCOUNT unset) — set the env var to search the live glossary.'); setResults([]); return; }
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); setResults([]); return; }
      setResults(j.terms || []);
      setSelected(new Set());
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setSearching(false); }
  }, [glossaryGuid, keyword]);

  const toggle = (guid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(guid)) next.delete(guid); else next.add(guid);
      return next;
    });
  };

  const addSelected = useCallback(async () => {
    if (selected.size === 0) return;
    setAdding(true); setMsg(null);
    let current = links;
    let added = 0;
    try {
      for (const guid of selected) {
        const term = results.find((t) => t.guid === guid);
        if (!term) continue;
        const r = await fetch(`/api/data-products/${encodeURIComponent(dataProductId)}/glossary-terms`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ termGuid: term.guid, name: term.name || term.qualifiedName || term.guid, glossaryGuid: glossaryGuid || undefined }),
        });
        const j = await r.json();
        if (!j.ok) { setMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); break; }
        current = j.links || current;
        added++;
      }
      onLinksChange(current);
      setSelected(new Set());
      if (added > 0) setMsg({ intent: 'success', text: `Linked ${added} glossary term${added === 1 ? '' : 's'} to this data product.` });
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setAdding(false); }
  }, [selected, results, links, dataProductId, glossaryGuid, onLinksChange]);

  const removeLink = useCallback(async (link: GlossaryLink) => {
    setMsg(null);
    try {
      const qs = new URLSearchParams();
      if (link.guid) qs.set('termGuid', link.guid); else qs.set('name', link.name);
      const r = await fetch(`/api/data-products/${encodeURIComponent(dataProductId)}/glossary-terms?${qs.toString()}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      onLinksChange(j.links || []);
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
  }, [dataProductId, onLinksChange]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Library20Regular />
        <Subtitle2>Glossary terms</Subtitle2>
      </div>
      <Body1>Search the Microsoft Purview business glossary and attach terms to this data product. Filter by glossary (domain) and keyword, multi-select, then Add.</Body1>

      {gate && <MessageBar intent="warning"><MessageBarBody>{gate}</MessageBarBody></MessageBar>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr auto', gap: 12, alignItems: 'flex-end' }}>
        <Field label="Glossary (domain)">
          <Dropdown
            placeholder={glossaries.length === 0 ? 'Default glossary' : 'All glossaries'}
            value={glossaries.find((g) => g.guid === glossaryGuid)?.name || 'All glossaries'}
            selectedOptions={glossaryGuid ? [glossaryGuid] : ['']}
            onOptionSelect={(_, d) => setGlossaryGuid(d.optionValue || '')}
          >
            <Option value="">All glossaries</Option>
            {glossaries.map((g) => <Option key={g.guid} value={g.guid}>{g.name}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Keyword">
          <Input value={keyword} onChange={(_, d) => setKeyword(d.value)} placeholder="revenue, customer, PII…"
            onKeyDown={(e) => { if (e.key === 'Enter') search(); }} />
        </Field>
        <Button appearance="primary" icon={<ArrowSync20Regular />} onClick={search} disabled={searching}>
          {searching ? 'Searching…' : 'Search'}
        </Button>
      </div>

      {results.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{results.length} term{results.length === 1 ? '' : 's'} — select to attach</Caption1>
          <Table size="small" aria-label="Glossary search results">
            <TableHeader><TableRow>
              <TableHeaderCell style={{ width: 40 }} />
              <TableHeaderCell>Term</TableHeaderCell>
              <TableHeaderCell>Qualified name</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {results.map((t) => (
                <TableRow key={t.guid}>
                  <TableCell><Checkbox checked={selected.has(t.guid)} onChange={() => toggle(t.guid)} aria-label={`Select ${t.name || t.guid}`} /></TableCell>
                  <TableCell><strong>{t.name || '(unnamed)'}</strong></TableCell>
                  <TableCell><code style={{ fontSize: 11 }}>{t.qualifiedName || t.guid}</code></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Button appearance="primary" icon={<Add20Regular />} onClick={addSelected} disabled={adding || selected.size === 0} style={{ alignSelf: 'flex-start' }}>
            {adding ? 'Adding…' : `Add ${selected.size || ''} selected`.trim()}
          </Button>
        </div>
      )}

      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}

      <Subtitle2 style={{ marginTop: 4 }}>Linked terms ({links.length})</Subtitle2>
      <Table size="small" aria-label="Linked glossary terms">
        <TableHeader><TableRow>
          <TableHeaderCell>Term</TableHeaderCell>
          <TableHeaderCell>GUID</TableHeaderCell>
          <TableHeaderCell style={{ width: 56 }} />
        </TableRow></TableHeader>
        <TableBody>
          {links.length === 0 && <TableRow><TableCell>No glossary terms linked yet.</TableCell><TableCell /><TableCell /></TableRow>}
          {links.map((l) => (
            <TableRow key={l.guid || l.name}>
              <TableCell><strong>{l.name}</strong></TableCell>
              <TableCell><code style={{ fontSize: 11 }}>{l.guid?.slice(0, 12) || '—'}</code></TableCell>
              <TableCell><RemoveMenu onRemove={() => removeLink(l)} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ============================================================
// OKRs section
// ============================================================

function OkrSection({ dataProductId }: { dataProductId: string }) {
  const [okrs, setOkrs] = useState<OkrDoc[] | null>(null);
  const [name, setName] = useState('');
  const [metric, setMetric] = useState('');
  const [target, setTarget] = useState('');
  const [current, setCurrent] = useState('');
  const [status, setStatus] = useState('on-track');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/data-products/${encodeURIComponent(dataProductId)}/okrs`);
      const j = await r.json();
      if (j.ok) setOkrs(j.okrs || []); else { setOkrs([]); setMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); }
    } catch (e: any) { setOkrs([]); setMsg({ intent: 'error', text: e?.message || String(e) }); }
  }, [dataProductId]);

  useEffect(() => { load(); }, [load]);

  const add = useCallback(async () => {
    if (!name.trim()) { setMsg({ intent: 'error', text: 'OKR name is required.' }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/data-products/${encodeURIComponent(dataProductId)}/okrs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), metric: metric.trim() || undefined, target: target.trim() || undefined, current: current.trim() || undefined, status, description: description.trim() || undefined }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      setName(''); setMetric(''); setTarget(''); setCurrent(''); setDescription(''); setStatus('on-track');
      setMsg({ intent: 'success', text: `Added OKR '${j.okr?.name}'.` });
      load();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [name, metric, target, current, status, description, dataProductId, load]);

  const remove = useCallback(async (okrId: string) => {
    setMsg(null);
    try {
      const r = await fetch(`/api/data-products/${encodeURIComponent(dataProductId)}/okrs?okrId=${encodeURIComponent(okrId)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      load();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
  }, [dataProductId, load]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Target20Regular />
        <Subtitle2>OKRs</Subtitle2>
      </div>
      <Body1>Track the objectives & key results this data product supports.</Body1>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr', gap: 12, alignItems: 'flex-end' }}>
        <Field label="Objective"><Input value={name} onChange={(_, d) => setName(d.value)} placeholder="Improve data freshness" /></Field>
        <Field label="Metric"><Input value={metric} onChange={(_, d) => setMetric(d.value)} placeholder="Lag (min)" /></Field>
        <Field label="Target"><Input value={target} onChange={(_, d) => setTarget(d.value)} placeholder="15" /></Field>
        <Field label="Current"><Input value={current} onChange={(_, d) => setCurrent(d.value)} placeholder="42" /></Field>
        <Field label="Status">
          <Dropdown value={OKR_STATUSES.find((s) => s.value === status)?.label || ''} selectedOptions={[status]} onOptionSelect={(_, d) => d.optionValue && setStatus(d.optionValue)}>
            {OKR_STATUSES.map((s) => <Option key={s.value} value={s.value}>{s.label}</Option>)}
          </Dropdown>
        </Field>
      </div>
      <Field label="Description (optional)"><Textarea value={description} onChange={(_, d) => setDescription(d.value)} rows={2} /></Field>
      <Button appearance="primary" icon={<Add20Regular />} onClick={add} disabled={busy} style={{ alignSelf: 'flex-start' }}>
        {busy ? 'Adding…' : 'Add OKR'}
      </Button>
      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
      {okrs === null ? <Spinner size="tiny" label="Loading OKRs…" /> : (
        <Table size="small" aria-label="OKRs">
          <TableHeader><TableRow>
            <TableHeaderCell>Objective</TableHeaderCell>
            <TableHeaderCell>Metric</TableHeaderCell>
            <TableHeaderCell>Target</TableHeaderCell>
            <TableHeaderCell>Current</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableHeaderCell style={{ width: 56 }} />
          </TableRow></TableHeader>
          <TableBody>
            {okrs.length === 0 && <TableRow><TableCell>No OKRs yet.</TableCell><TableCell /><TableCell /><TableCell /><TableCell /><TableCell /></TableRow>}
            {okrs.map((o) => {
              const st = OKR_STATUSES.find((s) => s.value === o.status);
              return (
                <TableRow key={o.id}>
                  <TableCell><strong>{o.name}</strong>{o.description && <><br /><Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{o.description}</Caption1></>}</TableCell>
                  <TableCell>{o.metric || '—'}</TableCell>
                  <TableCell>{o.target || '—'}</TableCell>
                  <TableCell>{o.current || '—'}</TableCell>
                  <TableCell><Badge appearance="filled" color={st?.color || 'informative'}>{st?.label || o.status}</Badge></TableCell>
                  <TableCell><RemoveMenu onRemove={() => remove(o.id)} /></TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// ============================================================
// Critical Data Elements section (read-only)
// ============================================================

function CdeSection({ dataProductId, refreshKey }: { dataProductId: string; refreshKey: number }) {
  const [cdes, setCdes] = useState<Cde[] | null>(null);
  const [gated, setGated] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null); setGated(null); setNote(null);
    try {
      const r = await fetch(`/api/data-products/${encodeURIComponent(dataProductId)}/cdes`);
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); setCdes([]); return; }
      setCdes(j.cdes || []);
      if (j.gated) setGated(j.hint || 'Purview not provisioned.');
      if (j.note) setNote(j.note);
    } catch (e: any) { setErr(e?.message || String(e)); setCdes([]); }
  }, [dataProductId]);

  useEffect(() => { load(); }, [load, refreshKey]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ShieldTask20Regular />
        <Subtitle2>Critical Data Elements</Subtitle2>
        <Badge appearance="outline">read-only</Badge>
        <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} onClick={load}>Refresh</Button>
      </div>
      <Body1>CDEs are auto-derived from the Microsoft Purview classifications carried by the assets mapped on the Datasets tab. They cannot be edited here.</Body1>
      {gated && <MessageBar intent="info"><MessageBarBody>{gated}</MessageBarBody></MessageBar>}
      {note && !gated && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{note}</Caption1>}
      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
      {cdes === null ? <Spinner size="tiny" label="Loading CDEs…" /> : (
        <Table size="small" aria-label="Critical data elements">
          <TableHeader><TableRow>
            <TableHeaderCell>Critical data element</TableHeaderCell>
            <TableHeaderCell>Classification</TableHeaderCell>
            <TableHeaderCell>Source asset</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {cdes.length === 0 && <TableRow><TableCell>No CDEs detected on mapped assets.</TableCell><TableCell /><TableCell /></TableRow>}
            {cdes.map((c) => (
              <TableRow key={c.typeName}>
                <TableCell><strong>{c.displayName}</strong></TableCell>
                <TableCell><code style={{ fontSize: 11 }}>{c.typeName}</code></TableCell>
                <TableCell>{c.assetName || <code style={{ fontSize: 11 }}>{c.assetGuid.slice(0, 12)}</code>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// ============================================================
// Panel
// ============================================================

export function LinkedResourcesPanel({
  dataProductId, glossaryLinks, onGlossaryLinksChange, datasetsKey,
}: {
  dataProductId: string;
  glossaryLinks: GlossaryLink[];
  onGlossaryLinksChange: (links: GlossaryLink[]) => void;
  /** Bump to re-derive CDEs after the Datasets tab maps a new asset. */
  datasetsKey: number;
}) {
  const isNew = dataProductId === 'new';
  if (isNew) {
    return (
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Save the data product first</MessageBarTitle>
          Linked resources (glossary terms, OKRs, CDEs) attach to a persisted data product. Create it, then return to this tab.
        </MessageBarBody>
      </MessageBar>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <GlossarySection dataProductId={dataProductId} links={glossaryLinks} onLinksChange={onGlossaryLinksChange} />
      <OkrSection dataProductId={dataProductId} />
      <CdeSection dataProductId={dataProductId} refreshKey={datasetsKey} />
    </div>
  );
}
