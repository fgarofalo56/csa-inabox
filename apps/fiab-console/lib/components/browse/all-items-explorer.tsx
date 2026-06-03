'use client';

/**
 * AllItemsExplorer — the "everything in Loom" view for /browse. Lists every
 * workspace item across the tenant (real data: /api/items/by-type over all known
 * item types) with KPI chips, category/type/workspace filter dropdowns, a
 * group-by toggle, and a color-coded sortable table (itemVisual icon + brand
 * color + type badge). Answers "Browse = everything; Workspaces = the workspace
 * inventory."
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  makeStyles, tokens, Badge, Dropdown, Option, Field, Spinner, Body1, Caption1,
  Subtitle2, Divider,
} from '@fluentui/react-components';
import { FABRIC_ITEM_TYPES } from '@/lib/catalog/fabric-item-types';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

interface Item {
  id: string; itemType: string; workspaceId: string;
  displayName?: string; description?: string; updatedAt?: string;
}
interface WorkspaceLite { id: string; name?: string; displayName?: string }
interface Row extends Item { typeLabel: string; category: string; workspaceName: string; modifiedMs: number }

const META = new Map(FABRIC_ITEM_TYPES.map((t) => [t.slug, t]));
const ALL_TYPES = FABRIC_ITEM_TYPES.map((t) => t.slug);

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 },
  kpis: { display: 'flex', gap: '12px', flexWrap: 'wrap' },
  kpi: {
    display: 'flex', flexDirection: 'column', gap: '2px', padding: '10px 16px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1, minWidth: '110px', boxShadow: tokens.shadow2,
  },
  kpiNum: { fontSize: '22px', fontWeight: tokens.fontWeightSemibold, color: tokens.colorBrandForeground1 },
  filters: { display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' },
  groupHead: {
    display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px',
    padding: '6px 8px', borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  swatch: { width: '10px', height: '10px', borderRadius: '3px', flexShrink: 0 },
  nameCell: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 },
  nameIcon: { display: 'flex', flexShrink: 0 },
});

function TypeBadge({ type }: { type: string }) {
  const v = itemVisual(type);
  return <Badge appearance="tint" style={{ backgroundColor: `${v.color}22`, color: v.color }}>{META.get(type)?.displayName || type}</Badge>;
}

export function AllItemsExplorer() {
  const s = useStyles();
  const [items, setItems] = useState<Item[] | null>(null);
  const [wsMap, setWsMap] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const [category, setCategory] = useState('All');
  const [type, setType] = useState('All');
  const [workspace, setWorkspace] = useState('All');
  const [groupBy, setGroupBy] = useState<'none' | 'category' | 'type' | 'workspace'>('category');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const qs = ALL_TYPES.map((t) => `type=${encodeURIComponent(t)}`).join('&');
        const [ir, wr] = await Promise.all([
          fetch(`/api/items/by-type?${qs}`).then((r) => r.json()).catch(() => ({})),
          fetch('/api/workspaces').then((r) => r.json()).catch(() => ({})),
        ]);
        if (!alive) return;
        setItems(Array.isArray(ir?.items) ? ir.items : (ir?.value || []));
        const wl: WorkspaceLite[] = Array.isArray(wr) ? wr : (wr?.workspaces || []);
        setWsMap(new Map(wl.map((w) => [w.id, w.name || w.displayName || w.id])));
      } catch (e: any) { if (alive) setError(e?.message || String(e)); }
    })();
    return () => { alive = false; };
  }, []);

  const rows: Row[] = useMemo(() => (items || []).map((it) => ({
    ...it,
    typeLabel: META.get(it.itemType)?.displayName || it.itemType,
    category: META.get(it.itemType)?.category || 'Other',
    workspaceName: wsMap.get(it.workspaceId) || it.workspaceId,
    modifiedMs: it.updatedAt ? Date.parse(it.updatedAt) : 0,
  })), [items, wsMap]);

  const categories = useMemo(() => ['All', ...Array.from(new Set(rows.map((r) => r.category))).sort()], [rows]);
  const types = useMemo(() => ['All', ...Array.from(new Set(rows.map((r) => r.typeLabel))).sort()], [rows]);
  const workspaces = useMemo(() => ['All', ...Array.from(new Set(rows.map((r) => r.workspaceName))).sort()], [rows]);

  const filtered = useMemo(() => rows.filter((r) =>
    (category === 'All' || r.category === category) &&
    (type === 'All' || r.typeLabel === type) &&
    (workspace === 'All' || r.workspaceName === workspace),
  ), [rows, category, type, workspace]);

  const grouped = useMemo(() => {
    if (groupBy === 'none') return [{ key: '', rows: filtered }];
    const m = new Map<string, Row[]>();
    for (const r of filtered) {
      const k = groupBy === 'category' ? r.category : groupBy === 'type' ? r.typeLabel : r.workspaceName;
      (m.get(k) || m.set(k, []).get(k)!).push(r);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([key, rs]) => ({ key, rows: rs }));
  }, [filtered, groupBy]);

  const columns: LoomColumn<Row>[] = [
    {
      key: 'displayName', label: 'Name', sortable: true, filterable: true, width: 280,
      getValue: (r) => r.displayName || '(unnamed)',
      render: (r) => {
        const v = itemVisual(r.itemType); const Icon = v.icon;
        return (
          <Link href={`/items/${r.itemType}/${r.id}`} className={s.nameCell} style={{ textDecoration: 'none', color: 'inherit' }}>
            <span className={s.nameIcon} style={{ color: v.color }}><Icon /></span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.displayName || '(unnamed)'}</span>
          </Link>
        );
      },
    },
    { key: 'typeLabel', label: 'Type', sortable: true, filterable: true, width: 200, render: (r) => <TypeBadge type={r.itemType} /> },
    { key: 'category', label: 'Category', sortable: true, filterable: true, width: 170, render: (r) => <Caption1>{r.category}</Caption1> },
    { key: 'workspaceName', label: 'Workspace', sortable: true, filterable: true, width: 200, render: (r) => <Caption1>{r.workspaceName}</Caption1> },
    {
      key: 'modifiedMs', label: 'Modified', sortable: true, width: 150,
      getValue: (r) => r.modifiedMs,
      render: (r) => <Caption1>{r.updatedAt ? new Date(r.updatedAt).toLocaleDateString() : '—'}</Caption1>,
    },
  ];

  if (error) return <Body1>Could not load items: {error}</Body1>;
  if (!items) return <Spinner label="Loading every item in your tenant…" />;

  return (
    <div className={s.root}>
      <div className={s.kpis}>
        <div className={s.kpi}><span className={s.kpiNum}>{rows.length}</span><Caption1>Items</Caption1></div>
        <div className={s.kpi}><span className={s.kpiNum}>{new Set(rows.map((r) => r.itemType)).size}</span><Caption1>Types</Caption1></div>
        <div className={s.kpi}><span className={s.kpiNum}>{new Set(rows.map((r) => r.category)).size}</span><Caption1>Categories</Caption1></div>
        <div className={s.kpi}><span className={s.kpiNum}>{new Set(rows.map((r) => r.workspaceId)).size}</span><Caption1>Workspaces</Caption1></div>
      </div>

      <div className={s.filters}>
        <Field label="Category"><Dropdown value={category} selectedOptions={[category]} onOptionSelect={(_, d) => setCategory(d.optionValue || 'All')}>{categories.map((c) => <Option key={c} value={c}>{c}</Option>)}</Dropdown></Field>
        <Field label="Type"><Dropdown value={type} selectedOptions={[type]} onOptionSelect={(_, d) => setType(d.optionValue || 'All')}>{types.map((c) => <Option key={c} value={c}>{c}</Option>)}</Dropdown></Field>
        <Field label="Workspace"><Dropdown value={workspace} selectedOptions={[workspace]} onOptionSelect={(_, d) => setWorkspace(d.optionValue || 'All')}>{workspaces.map((c) => <Option key={c} value={c}>{c}</Option>)}</Dropdown></Field>
        <Field label="Group by"><Dropdown value={groupBy} selectedOptions={[groupBy]} onOptionSelect={(_, d) => setGroupBy((d.optionValue as any) || 'none')}>{['none', 'category', 'type', 'workspace'].map((c) => <Option key={c} value={c}>{c}</Option>)}</Dropdown></Field>
      </div>

      {filtered.length === 0 ? (
        <Body1>No items match these filters.</Body1>
      ) : grouped.map((g) => (
        <div key={g.key || 'all'}>
          {g.key && (
            <div className={s.groupHead}>
              {groupBy === 'type' && <span className={s.swatch} style={{ backgroundColor: itemVisual(g.rows[0].itemType).color }} />}
              <Subtitle2>{g.key}</Subtitle2>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{g.rows.length}</Caption1>
            </div>
          )}
          <LoomDataTable columns={columns} rows={g.rows} getRowId={(r) => r.id} ariaLabel="All items" />
        </div>
      ))}
    </div>
  );
}
