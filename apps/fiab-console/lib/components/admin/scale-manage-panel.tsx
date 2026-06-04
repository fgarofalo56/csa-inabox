'use client';

/**
 * ScaleManagePanel — Admin → Capacity & compute "Scale & manage".
 *
 * Web-3.0 cards over the Azure-native compute Loom runs on, wired to the real
 * scaling engine at /api/admin/scaling/compute:
 *   - ADX cluster        → change SKU (+ implicit capacity) via a dropdown
 *   - Synapse SQL pool    → Pause / Resume
 *   - Self-hosted IR VMSS → Start (scale to 4) / Stop (scale to 0)
 *
 * GET lists only the resources present in this deployment (honest — unconfigured
 * ones are simply absent). Every action POSTs real ARM through the route; the
 * card shows live state, a busy state, and verbatim errors. No mock data, no
 * Fabric. Fluent v9 + Loom tokens.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Badge, Button, Caption1, Body1, Subtitle2, Spinner, Select,
  MessageBar, MessageBarBody, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Play16Regular, Pause16Regular, ArrowSync16Regular, ArrowUp16Regular,
  DatabasePerson24Regular, Server24Regular, Flash24Regular,
} from '@fluentui/react-icons';

interface Scalable {
  kind: 'adx' | 'synapse-pool' | 'shir-vmss';
  name: string;
  sku?: string;
  capacity?: number;
  state?: string;
  skuOptions?: string[];
  actions: string[];
}

const KIND_META: Record<Scalable['kind'], { label: string; icon: ReactNode; accent: string }> = {
  'adx': { label: 'Azure Data Explorer cluster', icon: <Flash24Regular />, accent: '#1f6feb' },
  'synapse-pool': { label: 'Synapse dedicated SQL pool', icon: <DatabasePerson24Regular />, accent: '#7d6cff' },
  'shir-vmss': { label: 'Self-hosted integration runtime', icon: <Server24Regular />, accent: '#21c08a' },
};

const useStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: tokens.spacingHorizontalL },
  card: {
    position: 'relative', overflow: 'hidden',
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
  },
  accent: { position: 'absolute', insetInlineStart: 0, insetBlockStart: 0, insetBlockEnd: 0, width: '4px' },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  iconWrap: {
    width: '40px', height: '40px', borderRadius: tokens.borderRadiusMedium, flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
  },
  meta: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', marginTop: '2px' },
  controls: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', marginTop: tokens.spacingVerticalS },
});

function stateColor(s?: string): 'success' | 'warning' | 'danger' | 'informative' {
  const v = (s || '').toLowerCase();
  if (/running|online|available|succeeded|\bnodes\b/.test(v)) return 'success';
  if (/start|resum|scal|updat|pend|provision/.test(v)) return 'warning';
  if (/paus|stop|offline|fail/.test(v)) return 'danger';
  return 'informative';
}

export function ScaleManagePanel() {
  const s = useStyles();
  const [items, setItems] = useState<Scalable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ id: string; text: string; ok: boolean } | null>(null);
  const [skuSel, setSkuSel] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch('/api/admin/scaling/compute', { cache: 'no-store' });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); setItems([]); return; }
      setItems(j.resources || []);
    } catch (e: any) { setError(e?.message || String(e)); setItems([]); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = useCallback(async (it: Scalable, body: Record<string, unknown>) => {
    setBusy(it.kind + it.name); setMsg(null);
    try {
      const r = await fetch('/api/admin/scaling/compute', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: it.kind, ...body }),
      });
      const j = await r.json();
      setMsg({ id: it.kind + it.name, text: j.ok ? (j.message || 'Requested.') : (j.error || 'failed'), ok: !!j.ok });
      if (j.ok) setTimeout(() => { void load(); }, 1500);
    } catch (e: any) { setMsg({ id: it.kind + it.name, text: e?.message || String(e), ok: false }); }
    finally { setBusy(null); }
  }, [load]);

  if (items === null) return <Spinner size="tiny" label="Reading Azure-native compute…" />;
  if (error) return <MessageBar intent="warning"><MessageBarBody>Couldn’t read scalable compute: {error}. The Console UAMI needs Contributor on the ADX / Synapse / VMSS resources.</MessageBarBody></MessageBar>;
  if (items.length === 0) {
    return <MessageBar intent="info"><MessageBarBody>No Azure-native scalable compute detected in this deployment (ADX cluster, Synapse dedicated pool, or self-hosted IR). They appear here once provisioned.</MessageBarBody></MessageBar>;
  }

  return (
    <div className={s.grid}>
      {items.map((it) => {
        const id = it.kind + it.name;
        const m = KIND_META[it.kind];
        const isBusy = busy === id;
        const sel = skuSel[id] ?? it.sku ?? it.skuOptions?.[0] ?? '';
        return (
          <div key={id} className={s.card}>
            <div className={s.accent} style={{ backgroundColor: m.accent }} aria-hidden />
            <div className={s.head}>
              <span className={s.iconWrap} style={{ backgroundColor: m.accent }} aria-hidden>{m.icon}</span>
              <div style={{ minWidth: 0 }}>
                <Subtitle2 style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</Subtitle2>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{m.label}</Caption1>
              </div>
            </div>
            <div className={s.meta}>
              <Badge appearance="filled" color={stateColor(it.state)}>{it.state || 'unknown'}</Badge>
              {it.sku && <Caption1>SKU: <code>{it.sku}</code></Caption1>}
              {typeof it.capacity === 'number' && <Caption1>· capacity {it.capacity}</Caption1>}
            </div>

            <div className={s.controls}>
              {it.kind === 'adx' && it.skuOptions && (
                <>
                  <Select value={sel} onChange={(_, d) => setSkuSel((p) => ({ ...p, [id]: d.value }))} disabled={isBusy} style={{ flex: 1, minWidth: 180 }}>
                    {it.skuOptions.map((o) => <option key={o} value={o}>{o}</option>)}
                  </Select>
                  <Button size="small" appearance="primary" icon={<ArrowUp16Regular />} disabled={isBusy || sel === it.sku}
                    onClick={() => act(it, { action: 'scale', sku: sel })}>
                    {isBusy ? 'Scaling…' : 'Apply SKU'}
                  </Button>
                </>
              )}
              {it.kind === 'synapse-pool' && (
                <>
                  <Button size="small" appearance="primary" icon={<Play16Regular />} disabled={isBusy || /online|resum/i.test(it.state || '')}
                    onClick={() => act(it, { action: 'resume' })}>Resume</Button>
                  <Button size="small" icon={<Pause16Regular />} disabled={isBusy || /paus/i.test(it.state || '')}
                    onClick={() => act(it, { action: 'pause' })}>Pause</Button>
                </>
              )}
              {it.kind === 'shir-vmss' && (
                <>
                  <Button size="small" appearance="primary" icon={<Play16Regular />} disabled={isBusy || (it.capacity ?? 0) > 0}
                    onClick={() => act(it, { action: 'scale', capacity: 4 })}>Start (4)</Button>
                  <Button size="small" icon={<Pause16Regular />} disabled={isBusy || (it.capacity ?? 0) === 0}
                    onClick={() => act(it, { action: 'scale', capacity: 0 })}>Stop (0)</Button>
                </>
              )}
              <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={load} disabled={isBusy} title="Refresh" />
            </div>

            {msg && msg.id === id && (
              <MessageBar intent={msg.ok ? 'success' : 'error'} style={{ marginTop: tokens.spacingVerticalXS }}>
                <MessageBarBody>{msg.text}</MessageBarBody>
              </MessageBar>
            )}
          </div>
        );
      })}
    </div>
  );
}
