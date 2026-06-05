'use client';

/**
 * /governance/catalog — REAL data asset inventory. Backed by
 * /api/governance/catalog which enumerates the tenant's data items
 * (lakehouse / warehouse / KQL DB / semantic model / mirrored DB /
 * data-product / vector store etc) from Cosmos.
 *
 * No Purview required. When Purview is bound a future iteration merges
 * Purview-only classifications into each row.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Input, Button, Subtitle2, Title3,
  MessageBar, MessageBarBody, MessageBarTitle,
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Field, Dropdown, Option, Textarea, Divider,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Search24Regular, ArrowSync24Regular, Open16Regular, Dismiss24Regular,
  ShieldCheckmark16Regular, BranchFork16Regular, Key16Regular, Open20Regular,
} from '@fluentui/react-icons';
import { useRouter } from 'next/navigation';
import { GovernanceShell } from '@/lib/components/governance-shell';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

interface Asset {
  id: string;
  displayName: string;
  itemType: string;
  workspaceId: string;
  workspaceName: string;
  owner: string;
  ownerUpn?: string | null;
  classifications: string[];
  sensitivity: string | null;
  endorsement?: string | null;
  description?: string | null;
  updatedAt: string;
  rowCount?: number;
  sizeBytes?: number;
}

const useStyles = makeStyles({
  toolbar: {
    display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12,
    paddingBottom: 12, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  spacer: { flex: 1 },
  filterChip: {
    fontSize: 12,
    color: tokens.colorNeutralForeground3,
    padding: '4px 10px', borderRadius: 999,
    backgroundColor: tokens.colorNeutralBackground2,
    cursor: 'pointer',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  filterChipActive: {
    backgroundColor: tokens.colorBrandBackground2,
    borderColor: tokens.colorBrandStroke2,
    color: tokens.colorBrandForeground1,
  },
  classChips: { display: 'flex', gap: 4, flexWrap: 'wrap' },
  classChip: {
    fontSize: 11, padding: '2px 8px', borderRadius: 999,
    backgroundColor: tokens.colorPaletteBlueBackground2,
    color: tokens.colorPaletteBlueForeground2,
  },
  tableWrap: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 8, overflow: 'auto',
  },
  clickRow: { cursor: 'pointer' },
  drawer: { width: '440px', maxWidth: '94vw' },
  drawerBody: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, paddingBottom: tokens.spacingVerticalXXL },
  metaGrid: { display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: tokens.spacingVerticalS, columnGap: tokens.spacingHorizontalM, alignItems: 'center' },
  metaLabel: { color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  actionRow: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
});

const TYPE_ORDER = ['lakehouse', 'warehouse', 'semantic-model', 'kql-database', 'eventhouse', 'mirrored-database', 'data-product', 'vector-store'];
function typeLabel(t: string): string {
  return t.replace(/-/g, ' ');
}

function fmtBytes(b?: number): string {
  if (!b || b <= 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = b;
  while (v > 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

export default function GovernanceCatalogPage() {
  const s = useStyles();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState('');
  // Asset detail drawer + request-access form.
  const [selected, setSelected] = useState<Asset | null>(null);
  const [reqPerm, setReqPerm] = useState<'read' | 'write' | 'admin'>('read');
  const [reqJustify, setReqJustify] = useState('');
  const [reqBusy, setReqBusy] = useState(false);
  const [reqResult, setReqResult] = useState<{ ok: boolean; message: string } | null>(null);

  const openAsset = useCallback((a: Asset) => {
    setSelected(a); setReqPerm('read'); setReqJustify(''); setReqResult(null);
  }, []);

  const requestAccess = useCallback(async () => {
    if (!selected) return;
    setReqBusy(true); setReqResult(null);
    try {
      const r = await fetch('/api/catalog/request-access', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          assetId: selected.id, assetName: selected.displayName, itemType: selected.itemType,
          ownerUpn: selected.ownerUpn || selected.owner, permission: reqPerm, justification: reqJustify,
        }),
      });
      const j = await r.json();
      setReqResult({ ok: !!j.ok, message: j.ok ? j.message : (j.error || `HTTP ${r.status}`) });
    } catch (e: any) {
      setReqResult({ ok: false, message: e?.message || String(e) });
    } finally { setReqBusy(false); }
  }, [selected, reqPerm, reqJustify]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (typeFilter) params.set('type', typeFilter);
      const r = await fetch(`/api/governance/catalog?${params.toString()}`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setAssets(j.assets || []);
      setSource(j.source || 'cosmos');
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setLoading(false); }
  }, [q, typeFilter]);

  useEffect(() => { load(); }, [load]);

  const typeCounts = useMemo(() => {
    const out = new Map<string, number>();
    for (const a of (assets || [])) out.set(a.itemType, (out.get(a.itemType) || 0) + 1);
    return out;
  }, [assets]);

  const typeChips = useMemo(() => {
    const seen = Array.from(typeCounts.keys());
    return [...TYPE_ORDER.filter((t) => seen.includes(t)), ...seen.filter((t) => !TYPE_ORDER.includes(t))];
  }, [typeCounts]);

  // Sortable / filterable / resizable columns for the shared LoomDataTable.
  const catalogColumns: LoomColumn<Asset>[] = useMemo(() => [
    {
      key: 'displayName', label: 'Name', sortable: true, filterable: true,
      getValue: (a) => a.displayName,
      render: (a) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <strong>{a.displayName}</strong>
          {a.endorsement && (
            <Badge appearance="tint" color={a.endorsement === 'Certified' ? 'success' : 'brand'} size="small" icon={<ShieldCheckmark16Regular />}>
              {a.endorsement}
            </Badge>
          )}
        </span>
      ),
    },
    { key: 'itemType', label: 'Type', sortable: true, filterable: true, getValue: (a) => typeLabel(a.itemType), render: (a) => typeLabel(a.itemType) },
    { key: 'workspaceName', label: 'Workspace', sortable: true, filterable: true, getValue: (a) => a.workspaceName },
    { key: 'owner', label: 'Owner', sortable: true, filterable: true, getValue: (a) => a.ownerUpn || a.owner, render: (a) => a.ownerUpn || a.owner },
    {
      key: 'classifications', label: 'Classifications', sortable: false, filterable: true,
      getValue: (a) => (a.classifications || []).join(' '),
      render: (a) => a.classifications?.length
        ? <div className={s.classChips}>{a.classifications.map((c) => <span key={c} className={s.classChip}>{c}</span>)}</div>
        : <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>—</Caption1>,
    },
    {
      key: 'sensitivity', label: 'Sensitivity', sortable: true, filterable: true,
      getValue: (a) => a.sensitivity || '',
      render: (a) => a.sensitivity
        ? <Badge appearance="filled" size="small" color={a.sensitivity === 'Highly Confidential' ? 'danger' : a.sensitivity === 'Confidential' ? 'warning' : 'subtle'}>{a.sensitivity}</Badge>
        : <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>—</Caption1>,
    },
    { key: 'sizeBytes', label: 'Size', sortable: true, filterable: false, width: 110, getValue: (a) => a.sizeBytes || 0, render: (a) => fmtBytes(a.sizeBytes) },
    { key: 'updatedAt', label: 'Updated', sortable: true, filterable: false, width: 130, getValue: (a) => a.updatedAt || '', render: (a) => a.updatedAt ? new Date(a.updatedAt).toLocaleDateString() : '—' },
    {
      key: 'open', label: '', sortable: false, filterable: false, width: 90,
      render: (a) => (
        <a href={`/items/${a.itemType}/${a.id}`} onClick={(e) => e.stopPropagation()}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
          Open <Open16Regular />
        </a>
      ),
    },
  ], [s.classChips, s.classChip]);

  return (
    <GovernanceShell sectionTitle="Data catalog">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Single inventory across every Lakehouse, Warehouse, Semantic Model, KQL DB, Mirrored DB, Data Product, and Vector Store in your tenant.
        {source && (
          <Badge appearance="outline" color={source === 'purview' ? 'brand' : 'informative'} size="small" style={{ marginLeft: 8 }}>
            source: {source}
          </Badge>
        )}
      </Body1>

      <div className={s.toolbar}>
        <Input
          contentBefore={<Search24Regular />}
          placeholder="Search assets, owners, classifications…"
          value={q}
          onChange={(_, d) => setQ(d.value)}
          style={{ flex: 1, maxWidth: 480 }}
        />
        <div className={s.spacer} />
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          {(assets || []).length} asset{(assets || []).length === 1 ? '' : 's'}
        </Caption1>
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
      </div>

      {typeChips.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          <span
            className={`${s.filterChip} ${!typeFilter ? s.filterChipActive : ''}`}
            onClick={() => setTypeFilter('')}
            role="button"
            tabIndex={0}
          >
            All ({(assets || []).length})
          </span>
          {typeChips.map((t) => (
            <span
              key={t}
              className={`${s.filterChip} ${typeFilter === t ? s.filterChipActive : ''}`}
              onClick={() => setTypeFilter(t === typeFilter ? '' : t)}
              role="button"
              tabIndex={0}
            >
              {typeLabel(t)} ({typeCounts.get(t) || 0})
            </span>
          ))}
        </div>
      )}

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load catalog</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {!error && (
        <LoomDataTable<Asset>
          columns={catalogColumns}
          rows={assets || []}
          getRowId={(a) => a.id}
          loading={loading}
          onRowClick={openAsset}
          empty={q || typeFilter
            ? 'No assets match the current filters.'
            : 'No data assets in your tenant yet. Create a lakehouse, warehouse, or semantic model and it will appear here.'}
        />
      )}

      <Drawer type="overlay" position="end" open={!!selected} onOpenChange={(_, d) => { if (!d.open) setSelected(null); }} className={s.drawer}>
        <DrawerHeader>
          <DrawerHeaderTitle action={<Button appearance="subtle" icon={<Dismiss24Regular />} onClick={() => setSelected(null)} aria-label="Close" />}>
            {selected?.displayName}
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          {selected && (
            <div className={s.drawerBody}>
              <div className={s.actionRow}>
                <Badge appearance="tint" color="brand">{typeLabel(selected.itemType)}</Badge>
                {selected.endorsement && (
                  <Badge appearance="filled" color={selected.endorsement === 'Certified' ? 'success' : 'brand'} icon={<ShieldCheckmark16Regular />}>
                    {selected.endorsement}
                  </Badge>
                )}
                {selected.sensitivity && (
                  <Badge appearance="filled" color={selected.sensitivity === 'Highly Confidential' ? 'danger' : selected.sensitivity === 'Confidential' ? 'warning' : 'subtle'}>
                    {selected.sensitivity}
                  </Badge>
                )}
              </div>

              {selected.description && <Body1 style={{ color: tokens.colorNeutralForeground2 }}>{selected.description}</Body1>}

              <div className={s.metaGrid}>
                <Caption1 className={s.metaLabel}>Workspace</Caption1><Caption1>{selected.workspaceName}</Caption1>
                <Caption1 className={s.metaLabel}>Owner</Caption1><Caption1>{selected.ownerUpn || selected.owner}</Caption1>
                <Caption1 className={s.metaLabel}>Classifications</Caption1>
                <div className={s.classChips}>
                  {selected.classifications?.length
                    ? selected.classifications.map((c) => <span key={c} className={s.classChip}>{c}</span>)
                    : <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>None</Caption1>}
                </div>
                <Caption1 className={s.metaLabel}>Rows</Caption1><Caption1>{selected.rowCount != null ? selected.rowCount.toLocaleString() : '—'}</Caption1>
                <Caption1 className={s.metaLabel}>Size</Caption1><Caption1>{fmtBytes(selected.sizeBytes)}</Caption1>
                <Caption1 className={s.metaLabel}>Updated</Caption1><Caption1>{selected.updatedAt ? new Date(selected.updatedAt).toLocaleString() : '—'}</Caption1>
              </div>

              <div className={s.actionRow}>
                <Button appearance="primary" icon={<Open20Regular />} onClick={() => router.push(`/items/${selected.itemType}/${selected.id}`)}>Open in editor</Button>
                <Button icon={<BranchFork16Regular />} onClick={() => router.push('/governance/lineage')}>View lineage</Button>
              </div>

              <Divider />

              <Title3 as="h3" style={{ fontSize: tokens.fontSizeBase400 }}><Key16Regular style={{ verticalAlign: 'middle', marginRight: 6 }} />Request access</Title3>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Records a request the owner reviews in the asset activity and grants in Governance → Policies.
              </Caption1>
              <Field label="Permission">
                <Dropdown value={reqPerm[0].toUpperCase() + reqPerm.slice(1)} selectedOptions={[reqPerm]}
                  onOptionSelect={(_, d) => setReqPerm((d.optionValue as typeof reqPerm) || 'read')}>
                  <Option value="read">Read</Option>
                  <Option value="write">Write</Option>
                  <Option value="admin">Admin</Option>
                </Dropdown>
              </Field>
              <Field label="Justification (optional)">
                <Textarea value={reqJustify} onChange={(_, d) => setReqJustify(d.value)} placeholder="Why you need access…" resize="vertical" />
              </Field>
              {reqResult && (
                <MessageBar intent={reqResult.ok ? 'success' : 'error'}>
                  <MessageBarBody>{reqResult.message}</MessageBarBody>
                </MessageBar>
              )}
              <div>
                <Button appearance="primary" icon={<Key16Regular />} disabled={reqBusy || (reqResult?.ok ?? false)} onClick={requestAccess}>
                  {reqBusy ? 'Requesting…' : 'Request access'}
                </Button>
              </div>
            </div>
          )}
        </DrawerBody>
      </Drawer>
    </GovernanceShell>
  );
}
