'use client';

/**
 * /governance/catalog — REAL data asset inventory. Backed by
 * /api/governance/catalog which serves the tenant's data items from the
 * `loom-governance-items` AI Search index (real facet counts + a
 * discoverability filter) when LOOM_AI_SEARCH_SERVICE is set, and falls back to
 * a Cosmos query otherwise.
 *
 * Domain scope comes from the live tenant domains (/api/admin/domains). Facet
 * chips/dropdowns (type, domain, endorsement, sensitivity) reflect real counts
 * returned by the backend. A Promoted/Certified item the caller cannot open
 * still appears (isDiscoverable) with a Request-Access CTA instead of "Open".
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Caption1, Body1, Input, Button, Title3,
  MessageBar, MessageBarBody, MessageBarTitle,
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Field, Dropdown, Option, Textarea, Divider,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Search24Regular, ArrowSync24Regular, Open16Regular, Dismiss24Regular,
  ShieldCheckmark16Regular, BranchFork16Regular, Key16Regular, Open20Regular,
  Eye16Regular, DatabaseSearch20Regular,
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
  domainId?: string | null;
  isDiscoverable?: boolean;
  /** False for a discoverable item in a workspace the caller cannot open. */
  canOpen?: boolean;
  updatedAt: string;
  rowCount?: number;
  sizeBytes?: number;
}

interface FacetBucket { value: string; count: number; }
interface Facets {
  itemType?: FacetBucket[];
  domainId?: FacetBucket[];
  endorsement?: FacetBucket[];
  sensitivity?: FacetBucket[];
  classifications?: FacetBucket[];
}
interface DomainOption { id: string; name: string; }

const useStyles = makeStyles({
  toolbar: {
    display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12,
    paddingBottom: 12, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    flexWrap: 'wrap',
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
  const [domainFilter, setDomainFilter] = useState<string>('');
  const [endorsementFilter, setEndorsementFilter] = useState<string>('');
  const [sensitivityFilter, setSensitivityFilter] = useState<string>('');
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [facets, setFacets] = useState<Facets>({});
  const [domains, setDomains] = useState<DomainOption[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const [reindexBusy, setReindexBusy] = useState(false);
  const [reindexMsg, setReindexMsg] = useState<{ ok: boolean; text: string } | null>(null);
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
      const r = await clientFetch('/api/catalog/request-access', {
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

  // Live tenant domains for the domain scope selector (Cosmos-backed).
  useEffect(() => {
    clientFetch('/api/admin/domains')
      .then((r) => r.json())
      .then((j) => { if (j?.ok) setDomains((j.domains || []).map((d: any) => ({ id: d.id, name: d.name }))); })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (typeFilter) params.set('type', typeFilter);
      if (domainFilter) params.set('domain', domainFilter);
      if (endorsementFilter) params.set('endorsement', endorsementFilter);
      if (sensitivityFilter) params.set('sensitivity', sensitivityFilter);
      const r = await clientFetch(`/api/governance/catalog?${params.toString()}`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setAssets(j.assets || []);
      setFacets(j.facets || {});
      setTotal(typeof j.total === 'number' ? j.total : (j.assets || []).length);
      setSource(j.source || 'cosmos');
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setLoading(false); }
  }, [q, typeFilter, domainFilter, endorsementFilter, sensitivityFilter]);

  useEffect(() => { load(); }, [load]);

  const reindex = useCallback(async () => {
    setReindexBusy(true); setReindexMsg(null);
    try {
      const r = await clientFetch('/api/admin/governance-catalog/reindex', { method: 'POST' });
      const j = await r.json();
      if (j.ok) {
        setReindexMsg({ ok: true, text: `Indexed ${j.indexed} asset${j.indexed === 1 ? '' : 's'}${j.indexCreated ? ' (index created)' : ''}.` });
        await load();
      } else {
        setReindexMsg({ ok: false, text: j.hint || j.error || `HTTP ${r.status}` });
      }
    } catch (e: any) {
      setReindexMsg({ ok: false, text: e?.message || String(e) });
    } finally { setReindexBusy(false); }
  }, [load]);

  // Facet-driven counts (real, returned by the backend).
  const typeCounts = useMemo(() => {
    const out = new Map<string, number>();
    for (const f of (facets.itemType || [])) out.set(f.value, f.count);
    return out;
  }, [facets.itemType]);

  const domainCounts = useMemo(() => {
    const out = new Map<string, number>();
    for (const f of (facets.domainId || [])) out.set(f.value, f.count);
    return out;
  }, [facets.domainId]);

  const typeChips = useMemo(() => {
    const seen = Array.from(typeCounts.keys());
    return [...TYPE_ORDER.filter((t) => seen.includes(t)), ...seen.filter((t) => !TYPE_ORDER.includes(t))];
  }, [typeCounts]);

  const endorsementOptions = useMemo(() => (facets.endorsement || []).map((f) => f.value), [facets.endorsement]);
  const sensitivityOptions = useMemo(() => (facets.sensitivity || []).map((f) => f.value), [facets.sensitivity]);

  const domainName = useMemo(() => {
    if (!domainFilter) return 'All domains';
    return domains.find((d) => d.id === domainFilter)?.name || domainFilter;
  }, [domainFilter, domains]);

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
          {a.isDiscoverable && a.canOpen === false && (
            <Badge appearance="outline" color="informative" size="small" icon={<Eye16Regular />}>
              Discoverable
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
      key: 'open', label: '', sortable: false, filterable: false, width: 130,
      render: (a) => a.canOpen === false
        ? (
          <Button size="small" appearance="subtle" icon={<Key16Regular />}
            onClick={(e) => { e.stopPropagation(); openAsset(a); }}>
            Request access
          </Button>
        )
        : (
          <a href={`/items/${a.itemType}/${a.id}`} onClick={(e) => e.stopPropagation()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
            Open <Open16Regular />
          </a>
        ),
    },
  ], [s.classChips, s.classChip, openAsset]);

  return (
    <GovernanceShell sectionTitle="Data catalog">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Single inventory across every Lakehouse, Warehouse, Semantic Model, KQL DB, Mirrored DB, Data Product, and Vector Store in your tenant.
        {source && (
          <Badge appearance="outline" color={source === 'aisearch' ? 'brand' : 'informative'} size="small" style={{ marginLeft: 8 }}>
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
          style={{ flex: 1, minWidth: 240, maxWidth: 420 }}
        />
        <Field style={{ minWidth: 170 }}>
          <Dropdown
            aria-label="Domain scope"
            value={domainName}
            selectedOptions={[domainFilter]}
            onOptionSelect={(_, d) => setDomainFilter(d.optionValue || '')}
          >
            <Option value="">All domains</Option>
            {domains.map((dm) => (
              <Option key={dm.id} value={dm.id} text={dm.name}>
                {dm.name}{domainCounts.has(dm.id) ? ` (${domainCounts.get(dm.id)})` : ''}
              </Option>
            ))}
          </Dropdown>
        </Field>
        {endorsementOptions.length > 0 && (
          <Dropdown
            aria-label="Endorsement"
            style={{ minWidth: 150 }}
            value={endorsementFilter || 'Any endorsement'}
            selectedOptions={[endorsementFilter]}
            onOptionSelect={(_, d) => setEndorsementFilter(d.optionValue || '')}
          >
            <Option value="">Any endorsement</Option>
            {endorsementOptions.map((v) => <Option key={v} value={v}>{v}</Option>)}
          </Dropdown>
        )}
        {sensitivityOptions.length > 0 && (
          <Dropdown
            aria-label="Sensitivity"
            style={{ minWidth: 150 }}
            value={sensitivityFilter || 'Any sensitivity'}
            selectedOptions={[sensitivityFilter]}
            onOptionSelect={(_, d) => setSensitivityFilter(d.optionValue || '')}
          >
            <Option value="">Any sensitivity</Option>
            {sensitivityOptions.map((v) => <Option key={v} value={v}>{v}</Option>)}
          </Dropdown>
        )}
        <div className={s.spacer} />
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          {total} asset{total === 1 ? '' : 's'}
        </Caption1>
        <Button appearance="subtle" icon={<DatabaseSearch20Regular />} onClick={reindex} disabled={reindexBusy}
          title="Rebuild the AI Search catalog index from Cosmos">
          {reindexBusy ? 'Rebuilding…' : 'Rebuild index'}
        </Button>
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
      </div>

      {reindexMsg && (
        <MessageBar intent={reindexMsg.ok ? 'success' : 'warning'} style={{ marginBottom: 12 }}>
          <MessageBarBody>{reindexMsg.text}</MessageBarBody>
        </MessageBar>
      )}

      {typeChips.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          <span
            className={`${s.filterChip} ${!typeFilter ? s.filterChipActive : ''}`}
            onClick={() => setTypeFilter('')}
            role="button"
            tabIndex={0}
          >
            All ({total})
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
          empty={q || typeFilter || domainFilter || endorsementFilter || sensitivityFilter
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
                {selected.isDiscoverable && selected.canOpen === false && (
                  <Badge appearance="outline" color="informative" icon={<Eye16Regular />}>Discoverable</Badge>
                )}
              </div>

              {selected.canOpen === false && (
                <MessageBar intent="info">
                  <MessageBarBody>
                    <MessageBarTitle>Discoverable asset</MessageBarTitle>
                    This {typeLabel(selected.itemType)} is published to the catalog but lives in a workspace you don&apos;t have access to.
                    Request access below — the owner grants it in Governance → Policies.
                  </MessageBarBody>
                </MessageBar>
              )}

              {selected.description && <Body1 style={{ color: tokens.colorNeutralForeground2 }}>{selected.description}</Body1>}

              <div className={s.metaGrid}>
                <Caption1 className={s.metaLabel}>Workspace</Caption1><Caption1>{selected.workspaceName}</Caption1>
                <Caption1 className={s.metaLabel}>Owner</Caption1><Caption1>{selected.ownerUpn || selected.owner}</Caption1>
                <Caption1 className={s.metaLabel}>Domain</Caption1>
                <Caption1>{selected.domainId ? (domains.find((d) => d.id === selected.domainId)?.name || selected.domainId) : '—'}</Caption1>
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

              {selected.canOpen !== false && (
                <div className={s.actionRow}>
                  {selected.itemType === 'data-product' && (
                    <Button appearance="primary" icon={<Open20Regular />} onClick={() => router.push(`/data-products/${selected.id}`)}>Open data product</Button>
                  )}
                  <Button appearance={selected.itemType === 'data-product' ? 'secondary' : 'primary'} icon={<Open20Regular />} onClick={() => router.push(`/items/${selected.itemType}/${selected.id}`)}>Open in editor</Button>
                  <Button icon={<BranchFork16Regular />} onClick={() => router.push(`/governance/lineage?focusId=${encodeURIComponent(selected.id)}`)}>View lineage</Button>
                </div>
              )}

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
