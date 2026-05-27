'use client';

import { useEffect, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Subtitle2, Button,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, Open16Regular } from '@fluentui/react-icons';
import { GovernanceShell } from '@/lib/components/governance-shell';

interface Distribution { label: string; count: number; }
interface LabeledItem { id: string; displayName: string; itemType: string; workspaceName?: string; label: string; }
interface Resp {
  total: number; labeled: number; unlabeled: number;
  distribution: Distribution[]; items: LabeledItem[]; source: string;
}

const useStyles = makeStyles({
  statsRow: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: 12, marginBottom: 20,
  },
  statCard: {
    padding: 16, borderRadius: 8,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  statVal: { fontSize: 28, fontWeight: 600, color: tokens.colorBrandForeground1 },
  statLabel: { fontSize: 12, color: tokens.colorNeutralForeground3 },
  empty: { padding: 32, color: tokens.colorNeutralForeground3, fontSize: 13, textAlign: 'center' },
});

function labelColor(l: string): 'subtle' | 'informative' | 'warning' | 'danger' | 'severe' {
  if (l === 'Highly Confidential' || l === 'Restricted') return 'danger';
  if (l === 'Confidential') return 'warning';
  if (l === 'Internal') return 'informative';
  return 'subtle';
}

export default function SensitivityPage() {
  const s = useStyles();
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/governance/sensitivity');
      const j = await r.json();
      if (!j.ok) { setError(j.error); return; }
      setData(j);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  return (
    <GovernanceShell sectionTitle="Sensitivity labels">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Distribution of Microsoft Purview Information Protection labels across your tenant's data assets,
        derived live from each item's <code>state.sensitivityLabel</code> field.
      </Body1>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load sensitivity</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {loading && !error && <Spinner label="Aggregating labels…" />}

      {data && (
        <>
          <div className={s.statsRow}>
            <div className={s.statCard}>
              <div className={s.statVal}>{data.total}</div>
              <div className={s.statLabel}>total items</div>
            </div>
            <div className={s.statCard}>
              <div className={s.statVal}>{data.labeled}</div>
              <div className={s.statLabel}>labeled ({data.total ? Math.round(100 * data.labeled / data.total) : 0}%)</div>
            </div>
            <div className={s.statCard}>
              <div className={s.statVal}>{data.unlabeled}</div>
              <div className={s.statLabel}>unlabeled</div>
            </div>
          </div>

          <Subtitle2 style={{ display: 'block', marginBottom: 8 }}>Label distribution</Subtitle2>
          <Table size="small" aria-label="Label distribution" style={{ marginBottom: 20 }}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Label</TableHeaderCell>
                <TableHeaderCell>Items</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.distribution.map((d) => (
                <TableRow key={d.label}>
                  <TableCell>
                    <Badge appearance="filled" color={labelColor(d.label)} size="small">{d.label}</Badge>
                  </TableCell>
                  <TableCell><strong>{d.count}</strong></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <Subtitle2 style={{ display: 'block', marginBottom: 8 }}>Labeled items ({data.items.length})</Subtitle2>
          {data.items.length === 0 ? (
            <div className={s.empty}>No items have a sensitivity label yet.</div>
          ) : (
            <Table aria-label="Labeled items">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Item</TableHeaderCell>
                  <TableHeaderCell>Type</TableHeaderCell>
                  <TableHeaderCell>Workspace</TableHeaderCell>
                  <TableHeaderCell>Label</TableHeaderCell>
                  <TableHeaderCell></TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((it) => (
                  <TableRow key={it.id}>
                    <TableCell><strong>{it.displayName}</strong></TableCell>
                    <TableCell>{it.itemType}</TableCell>
                    <TableCell>{it.workspaceName || '—'}</TableCell>
                    <TableCell>
                      <Badge appearance="filled" color={labelColor(it.label)} size="small">{it.label}</Badge>
                    </TableCell>
                    <TableCell>
                      <a href={`/items/${it.itemType}/${it.id}`}
                         style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                        Open <Open16Regular />
                      </a>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </GovernanceShell>
  );
}
