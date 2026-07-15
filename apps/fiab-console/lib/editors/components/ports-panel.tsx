'use client';

/**
 * DP-8 — Ports panel for the data-product editor.
 *
 * Declares the product's input / output / management ports (the ODPS/Bitol mesh
 * model). Each port is a structured row: a name, a kind constrained to its
 * direction (dropdown, never freeform), and a reference (upstream product /
 * asset / endpoint). Input ports that point at another data product resolve to
 * that upstream's contract summary. Backed by GET /ports (resolve) + PATCH the
 * product's `ports` model. Azure-native Cosmos; no Fabric dependency.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  Badge, Body1Strong, Button, Caption1, Dropdown, Field, Input, Option, Spinner, Text,
  MessageBar, MessageBarBody,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add20Regular, Dismiss16Regular, Save20Regular, ArrowImport20Regular, ArrowExport20Regular, Wrench20Regular } from '@fluentui/react-icons';
import {
  PORT_DIRECTIONS, PORT_KINDS_BY_DIRECTION, emptyPorts,
  type PortsModel, type Port, type PortDirection, type PortKind,
} from '@/lib/dataproducts/ports';

const useStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, padding: tokens.spacingHorizontalL, maxWidth: '900px' },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  row: {
    display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap',
    padding: tokens.spacingHorizontalS, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  grow: { flex: 1, minWidth: '160px' },
  resolved: { color: tokens.colorNeutralForeground3 },
  saveBar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' },
});

const DIR_META: Record<PortDirection, { label: string; hint: string; icon: ReactNode }> = {
  input: { label: 'Input ports', hint: 'Upstream dependencies this product consumes.', icon: <ArrowImport20Regular /> },
  output: { label: 'Output ports', hint: 'Contract-bound interfaces this product exposes.', icon: <ArrowExport20Regular /> },
  management: { label: 'Management ports', hint: 'Health / lineage / DQ control endpoints.', icon: <Wrench20Regular /> },
};

type ResolvedPort = Port & { resolved?: { productName: string; contractVersion?: string; columnCount: number } | { error: string } };

export function PortsPanel({ id, isNew }: { id: string; isNew?: boolean }) {
  const s = useStyles();
  const [model, setModel] = useState<PortsModel>(emptyPorts());
  const [resolved, setResolved] = useState<Record<string, ResolvedPort['resolved']>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await clientFetch(`/api/data-products/${encodeURIComponent(id)}/ports`);
      const j = await r.json();
      if (j.ok) {
        setModel({
          input: (j.ports.input as ResolvedPort[]).map(({ resolved: _r, ...p }) => p),
          output: j.ports.output, management: j.ports.management,
        });
        const rmap: Record<string, ResolvedPort['resolved']> = {};
        for (const p of j.ports.input as ResolvedPort[]) if (p.resolved) rmap[p.id] = p.resolved;
        setResolved(rmap);
      }
    } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { if (!isNew) load(); else setLoading(false); }, [isNew, load]);

  const addPort = (dir: PortDirection) => setModel((m) => ({
    ...m,
    [dir]: [...m[dir], { id: `${dir}-${Date.now()}`, name: '', direction: dir, kind: PORT_KINDS_BY_DIRECTION[dir][0] } as Port],
  }));
  const updatePort = (dir: PortDirection, i: number, patch: Partial<Port>) => setModel((m) => ({
    ...m, [dir]: m[dir].map((p, pi) => pi === i ? { ...p, ...patch } : p),
  }));
  const removePort = (dir: PortDirection, i: number) => setModel((m) => ({ ...m, [dir]: m[dir].filter((_, pi) => pi !== i) }));

  const save = useCallback(async () => {
    setSaving(true); setNote(null);
    try {
      const r = await clientFetch(`/api/data-products/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ports: model }),
      });
      const j = await r.json();
      setNote(j.ok ? 'Ports saved.' : (j.error || `HTTP ${r.status}`));
      if (j.ok) await load();
    } finally { setSaving(false); }
  }, [id, model, load]);

  if (isNew) return <div className={s.wrap}><MessageBar intent="info"><MessageBarBody>Save the data product first, then declare its ports.</MessageBarBody></MessageBar></div>;
  if (loading) return <div className={s.wrap}><Spinner size="tiny" label="Loading ports…" /></div>;

  return (
    <div className={s.wrap}>
      {PORT_DIRECTIONS.map((dir) => (
        <div key={dir} className={s.section}>
          <div className={s.head}>{DIR_META[dir].icon}<Body1Strong>{DIR_META[dir].label}</Body1Strong>
            <Badge appearance="tint">{model[dir].length}</Badge></div>
          <Caption1>{DIR_META[dir].hint}</Caption1>
          {model[dir].map((p, i) => (
            <div key={p.id} className={s.row}>
              <Field label="Name" className={s.grow}>
                <Input value={p.name} onChange={(_, d) => updatePort(dir, i, { name: d.value })} placeholder="e.g. curated-sales" />
              </Field>
              <Field label="Kind">
                <Dropdown selectedOptions={[p.kind]} value={p.kind}
                  onOptionSelect={(_, d) => updatePort(dir, i, { kind: (d.optionValue as PortKind) || PORT_KINDS_BY_DIRECTION[dir][0] })}>
                  {PORT_KINDS_BY_DIRECTION[dir].map((k) => (<Option key={k} value={k}>{k}</Option>))}
                </Dropdown>
              </Field>
              <Field label={dir === 'input' ? 'Upstream ref (product id / asset)' : 'Reference'} className={s.grow}>
                <Input value={p.ref || ''} onChange={(_, d) => updatePort(dir, i, { ref: d.value })} placeholder={dir === 'input' ? 'dp-123 or abfss://…' : 'endpoint / path'} />
              </Field>
              <Button icon={<Dismiss16Regular />} appearance="subtle" aria-label="Remove port" onClick={() => removePort(dir, i)} />
              {dir === 'input' && resolved[p.id] && (
                <Caption1 className={s.resolved} style={{ flexBasis: '100%' }}>
                  {'error' in resolved[p.id]! ? `⚠ ${(resolved[p.id] as any).error}` :
                    `↳ ${(resolved[p.id] as any).productName} · contract v${(resolved[p.id] as any).contractVersion || '—'} · ${(resolved[p.id] as any).columnCount} cols`}
                </Caption1>
              )}
            </div>
          ))}
          <Button icon={<Add20Regular />} appearance="secondary" onClick={() => addPort(dir)}>Add {dir} port</Button>
        </div>
      ))}
      <div className={s.saveBar}>
        <Button appearance="primary" icon={<Save20Regular />} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save ports'}</Button>
        {note && <Text>{note}</Text>}
      </div>
    </div>
  );
}

export default PortsPanel;
