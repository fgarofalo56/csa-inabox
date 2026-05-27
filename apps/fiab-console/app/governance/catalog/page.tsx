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
  Spinner, Badge, Caption1, Body1, Input, Button, Subtitle2,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Search24Regular, ArrowSync24Regular, Open16Regular } from '@fluentui/react-icons';
import { GovernanceShell } from '@/lib/components/governance-shell';

interface Asset {
  id: string;
  displayName: string;
  itemType: string;
  workspaceId: string;
  workspaceName: string;
  owner: string;
  classifications: string[];
  sensitivity: string | null;
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
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState('');

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

      {loading && !error && <Spinner label="Loading catalog…" />}

      {!loading && !error && (assets?.length ?? 0) === 0 && (
        <div style={{ padding: 32, color: tokens.colorNeutralForeground3, fontSize: 13, textAlign: 'center' }}>
          {q || typeFilter
            ? <>No assets match the current filters.</>
            : <>No data assets in your tenant yet. Create a lakehouse, warehouse, or semantic model and it will appear here.</>}
        </div>
      )}

      {!loading && !error && (assets?.length ?? 0) > 0 && (
        <div className={s.tableWrap}>
          <Table aria-label="Data catalog">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Workspace</TableHeaderCell>
                <TableHeaderCell>Owner</TableHeaderCell>
                <TableHeaderCell>Classifications</TableHeaderCell>
                <TableHeaderCell>Sensitivity</TableHeaderCell>
                <TableHeaderCell>Size</TableHeaderCell>
                <TableHeaderCell>Updated</TableHeaderCell>
                <TableHeaderCell></TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(assets || []).map((a) => (
                <TableRow key={a.id}>
                  <TableCell><strong>{a.displayName}</strong></TableCell>
                  <TableCell>{typeLabel(a.itemType)}</TableCell>
                  <TableCell>{a.workspaceName}</TableCell>
                  <TableCell>{a.owner}</TableCell>
                  <TableCell>
                    {a.classifications?.length ? (
                      <div className={s.classChips}>
                        {a.classifications.map((c) => <span key={c} className={s.classChip}>{c}</span>)}
                      </div>
                    ) : <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>—</Caption1>}
                  </TableCell>
                  <TableCell>
                    {a.sensitivity ? (
                      <Badge appearance="filled" color={a.sensitivity === 'Highly Confidential' ? 'danger' : a.sensitivity === 'Confidential' ? 'warning' : 'subtle'} size="small">
                        {a.sensitivity}
                      </Badge>
                    ) : <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>—</Caption1>}
                  </TableCell>
                  <TableCell>{fmtBytes(a.sizeBytes)}</TableCell>
                  <TableCell>{a.updatedAt ? new Date(a.updatedAt).toLocaleDateString() : '—'}</TableCell>
                  <TableCell>
                    <a
                      href={`/items/${a.itemType}/${a.id}`}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}
                    >
                      Open <Open16Regular />
                    </a>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </GovernanceShell>
  );
}
