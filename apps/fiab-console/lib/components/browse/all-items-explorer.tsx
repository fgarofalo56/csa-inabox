'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * AllItemsExplorer — the "everything in Loom" view for /browse. Lists every
 * workspace item across the tenant (real data: /api/items/by-type?types=all)
 * with KPI chips, domain/category/type/workspace filter dropdowns, a group-by
 * toggle, and a color-coded sortable table (itemVisual icon + brand color +
 * type badge). Answers "Browse = everything; Workspaces = the workspace
 * inventory."
 *
 * Loads PROGRESSIVELY: the by-type route pages the tenant-wide scan via a
 * continuation token, and each page is appended to the table (with a live
 * "Scanning…" progress line) instead of all-or-nothing. Fetch failures surface
 * as an honest error — never silently rendered as zero counts (the old
 * `.catch(() => ({}))` swallowed every failure into "0 items").
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  makeStyles, tokens, Badge, Dropdown, Option, Field, Spinner, Body1, Caption1,
  Subtitle2, MessageBar, MessageBarBody,
} from '@fluentui/react-components';
import {
  Open16Regular, OpenFolder16Regular, Copy16Regular, Link16Regular,
} from '@fluentui/react-icons';
import { FABRIC_ITEM_TYPES } from '@/lib/catalog/fabric-item-types';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { BrandedItemIcon } from '@/lib/components/ui/branded-item-icon';
import {
  LoomDataTable, type LoomColumn, type LoomRowAction, type LoomRowMenuItem,
} from '@/lib/components/ui/loom-data-table';
import { PinButton } from '@/lib/components/pin-button';

interface Item {
  id: string; itemType: string; workspaceId: string;
  displayName?: string; description?: string; updatedAt?: string;
  /** Governance-domain id of the item's workspace (attached by the BFF). */
  workspaceDomain?: string;
}
interface WorkspaceLite { id: string; name?: string; displayName?: string }
interface DomainLite { id: string; name: string }
interface Row extends Item { typeLabel: string; category: string; workspaceName: string; domainLabel: string; modifiedMs: number }

const META = new Map(FABRIC_ITEM_TYPES.map((t) => [t.slug, t]));
/** Items-per-page for the progressive tenant scan. */
const PAGE_SIZE = 500;
/** Hard ceiling on pages so a runaway continuation can never loop forever. */
const MAX_PAGES = 40;
const NO_DOMAIN = '(No domain)';

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
  const router = useRouter();
  const [items, setItems] = useState<Item[] | null>(null);
  const [scanning, setScanning] = useState(true);
  const [wsMap, setWsMap] = useState<Map<string, string>>(new Map());
  const [domainMap, setDomainMap] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const [domain, setDomain] = useState('All');
  const [category, setCategory] = useState('All');
  const [type, setType] = useState('All');
  const [workspace, setWorkspace] = useState('All');
  const [groupBy, setGroupBy] = useState<'none' | 'category' | 'type' | 'workspace'>('category');

  useEffect(() => {
    let alive = true;

    // Workspace names + governance domains load alongside the item scan; a
    // failure of either enrichment never blanks the item list (names fall back
    // to raw ids), but is NOT swallowed into fake zeros either.
    (async () => {
      try {
        const wr = await clientFetch('/api/workspaces').then((r) => r.json());
        if (!alive) return;
        const wl: WorkspaceLite[] = Array.isArray(wr) ? wr : (wr?.workspaces || []);
        setWsMap(new Map(wl.map((w) => [w.id, w.name || w.displayName || w.id])));
      } catch { /* names fall back to workspace ids */ }
    })();
    (async () => {
      try {
        const dr = await clientFetch('/api/governance/domains').then((r) => r.json());
        if (!alive) return;
        const dl: DomainLite[] = Array.isArray(dr?.domains) ? dr.domains : [];
        setDomainMap(new Map(dl.map((d) => [d.id, d.name || d.id])));
      } catch { /* domain labels fall back to domain ids */ }
    })();

    // Progressive tenant-wide item scan: page the by-type route by continuation
    // token, appending each page so counts/rows build up live.
    (async () => {
      try {
        let continuation: string | undefined;
        let loaded: Item[] = [];
        for (let page = 0; page < MAX_PAGES; page++) {
          const r = await clientFetch(`/api/items/by-type?types=all&pageSize=${PAGE_SIZE}`, {
            headers: continuation ? { 'x-loom-continuation': continuation } : undefined,
          });
          const j = await r.json().catch(() => null);
          if (!r.ok || j?.ok !== true || !Array.isArray(j.items)) {
            throw new Error(j?.error || `item scan failed (HTTP ${r.status})`);
          }
          if (!alive) return;
          loaded = [...loaded, ...j.items];
          setItems(loaded);
          continuation = typeof j.continuation === 'string' && j.continuation ? j.continuation : undefined;
          if (!continuation) break;
        }
        if (alive) setScanning(false);
      } catch (e: any) {
        if (!alive) return;
        setError(e?.message || String(e));
        setScanning(false);
      }
    })();

    return () => { alive = false; };
  }, []);

  const rows: Row[] = useMemo(() => (items || []).map((it) => ({
    ...it,
    typeLabel: META.get(it.itemType)?.displayName || it.itemType,
    category: META.get(it.itemType)?.category || 'Other',
    workspaceName: wsMap.get(it.workspaceId) || it.workspaceId,
    domainLabel: it.workspaceDomain ? (domainMap.get(it.workspaceDomain) || it.workspaceDomain) : NO_DOMAIN,
    modifiedMs: it.updatedAt ? Date.parse(it.updatedAt) : 0,
  })), [items, wsMap, domainMap]);

  const domains = useMemo(() => ['All', ...Array.from(new Set(rows.map((r) => r.domainLabel))).sort()], [rows]);
  const categories = useMemo(() => ['All', ...Array.from(new Set(rows.map((r) => r.category))).sort()], [rows]);
  const types = useMemo(() => ['All', ...Array.from(new Set(rows.map((r) => r.typeLabel))).sort()], [rows]);
  const workspaces = useMemo(() => ['All', ...Array.from(new Set(rows.map((r) => r.workspaceName))).sort()], [rows]);

  const filtered = useMemo(() => rows.filter((r) =>
    (domain === 'All' || r.domainLabel === domain) &&
    (category === 'All' || r.category === category) &&
    (type === 'All' || r.typeLabel === type) &&
    (workspace === 'All' || r.workspaceName === workspace),
  ), [rows, domain, category, type, workspace]);

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
      render: (r) => (
        <Link href={`/items/${r.itemType}/${r.id}`} className={s.nameCell} style={{ textDecoration: 'none', color: 'inherit' }}>
          <BrandedItemIcon type={r.itemType} size="sm" />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.displayName || '(unnamed)'}</span>
        </Link>
      ),
    },
    { key: 'typeLabel', label: 'Type', sortable: true, filterable: true, width: 200, render: (r) => <TypeBadge type={r.itemType} /> },
    { key: 'category', label: 'Category', sortable: true, filterable: true, width: 170, render: (r) => <Caption1>{r.category}</Caption1> },
    { key: 'workspaceName', label: 'Workspace', sortable: true, filterable: true, width: 200, render: (r) => <Caption1>{r.workspaceName}</Caption1> },
    { key: 'domainLabel', label: 'Domain', sortable: true, filterable: true, width: 160, render: (r) => <Caption1>{r.domainLabel}</Caption1> },
    {
      key: 'modifiedMs', label: 'Modified', sortable: true, width: 150,
      getValue: (r) => r.modifiedMs,
      render: (r) => <Caption1>{r.updatedAt ? new Date(r.updatedAt).toLocaleDateString() : '—'}</Caption1>,
    },
    {
      key: 'pin', label: '', sortable: false, width: 44,
      render: (r) => (
        <PinButton
          pin={{
            id: `item:${r.itemType}:${r.id}`,
            label: r.displayName || r.typeLabel,
            href: `/items/${r.itemType}/${r.id}`,
            type: r.itemType,
          }}
        />
      ),
    },
  ];

  const hrefFor = (r: Row) => `/items/${r.itemType}/${r.id}`;

  // Fabric-style inline hover actions — appear on row hover/focus.
  const rowActions = (): LoomRowAction<Row>[] => [
    { key: 'open', label: 'Open', icon: <Open16Regular />, onClick: (row) => router.push(hrefFor(row)) },
  ];

  // Fabric-style right-click context menu — real actions only.
  const rowMenu = (): LoomRowMenuItem<Row>[] => [
    { key: 'open', label: 'Open', icon: <Open16Regular />, onClick: (row) => router.push(hrefFor(row)) },
    {
      key: 'open-new', label: 'Open in new tab', icon: <OpenFolder16Regular />,
      onClick: (row) => window.open(hrefFor(row), '_blank', 'noopener,noreferrer'),
    },
    {
      key: 'copy-link', label: 'Copy link', icon: <Link16Regular />, divider: true,
      onClick: (row) => { void navigator.clipboard?.writeText(new URL(hrefFor(row), window.location.origin).href); },
    },
    {
      key: 'copy-id', label: 'Copy item ID', icon: <Copy16Regular />,
      onClick: (row) => { void navigator.clipboard?.writeText(row.id); },
    },
  ];

  if (error) {
    return (
      <MessageBar intent="error" layout="multiline">
        <MessageBarBody>
          Could not load the tenant item inventory: {error}. Retry by refreshing the page; if it
          persists, check the console&apos;s Cosmos DB connectivity (items container).
        </MessageBarBody>
      </MessageBar>
    );
  }
  if (!items) return <Spinner label="Loading every item in your tenant…" />;

  return (
    <div className={s.root}>
      <div className={s.kpis}>
        <div className={s.kpi}><span className={s.kpiNum}>{rows.length}</span><Caption1>Items</Caption1></div>
        <div className={s.kpi}><span className={s.kpiNum}>{new Set(rows.map((r) => r.itemType)).size}</span><Caption1>Types</Caption1></div>
        <div className={s.kpi}><span className={s.kpiNum}>{new Set(rows.map((r) => r.category)).size}</span><Caption1>Categories</Caption1></div>
        <div className={s.kpi}><span className={s.kpiNum}>{new Set(rows.map((r) => r.workspaceId)).size}</span><Caption1>Workspaces</Caption1></div>
        {scanning && (
          <div className={s.kpi} role="status">
            <Spinner size="tiny" label={`Scanning tenant… ${rows.length} items so far`} />
          </div>
        )}
      </div>

      <div className={s.filters}>
        <Field label="Domain"><Dropdown value={domain} selectedOptions={[domain]} onOptionSelect={(_, d) => setDomain(d.optionValue || 'All')}>{domains.map((c) => <Option key={c} value={c}>{c}</Option>)}</Dropdown></Field>
        <Field label="Category"><Dropdown value={category} selectedOptions={[category]} onOptionSelect={(_, d) => setCategory(d.optionValue || 'All')}>{categories.map((c) => <Option key={c} value={c}>{c}</Option>)}</Dropdown></Field>
        <Field label="Type"><Dropdown value={type} selectedOptions={[type]} onOptionSelect={(_, d) => setType(d.optionValue || 'All')}>{types.map((c) => <Option key={c} value={c}>{c}</Option>)}</Dropdown></Field>
        <Field label="Workspace"><Dropdown value={workspace} selectedOptions={[workspace]} onOptionSelect={(_, d) => setWorkspace(d.optionValue || 'All')}>{workspaces.map((c) => <Option key={c} value={c}>{c}</Option>)}</Dropdown></Field>
        <Field label="Group by"><Dropdown value={groupBy} selectedOptions={[groupBy]} onOptionSelect={(_, d) => setGroupBy((d.optionValue as any) || 'none')}>{['none', 'category', 'type', 'workspace'].map((c) => <Option key={c} value={c}>{c}</Option>)}</Dropdown></Field>
      </div>

      {filtered.length === 0 ? (
        <Body1>{scanning ? 'Scanning your tenant for items…' : 'No items match these filters.'}</Body1>
      ) : grouped.map((g) => (
        <div key={g.key || 'all'}>
          {g.key && (
            <div className={s.groupHead}>
              {groupBy === 'type' && <span className={s.swatch} style={{ backgroundColor: itemVisual(g.rows[0].itemType).color }} />}
              <Subtitle2>{g.key}</Subtitle2>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{g.rows.length}</Caption1>
            </div>
          )}
          <LoomDataTable
            columns={columns}
            rows={g.rows}
            getRowId={(r) => r.id}
            ariaLabel="All items"
            density="compact"
            rowActions={rowActions}
            rowMenu={rowMenu}
          />
        </div>
      ))}
    </div>
  );
}
