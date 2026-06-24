'use client';

import { clientFetch } from '@/lib/client-fetch';
import { useEffect, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Subtitle2, Button,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, Open16Regular } from '@fluentui/react-icons';
import { GovernanceShell } from '@/lib/components/governance-shell';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { Section, Toolbar } from '@/lib/components/ui/section';

interface Distribution { label: string; count: number; }
interface LabeledItem { id: string; displayName: string; itemType: string; workspaceName?: string; label: string; }
interface Resp {
  total: number; labeled: number; unlabeled: number;
  distribution: Distribution[]; items: LabeledItem[]; source: string;
}

const useStyles = makeStyles({
  statsRow: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(180px, 100%), 1fr))',
    gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalXL,
  },
  statCard: {
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
  },
  statVal: { fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold, color: tokens.colorBrandForeground1 },
  statLabel: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  empty: { padding: tokens.spacingVerticalXXL, color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, textAlign: 'center' },
  labelGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(200px, 100%), 1fr))', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalXL },
  labelCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalL, cursor: 'pointer',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderLeftWidth: '4px',
    borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2, textAlign: 'left', width: '100%',
    ':hover': { boxShadow: tokens.shadow8, backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  labelCardSel: { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '-1px' },
  labelCardTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  labelCount: { fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightBold, color: tokens.colorNeutralForeground1 },
  bar: { height: '6px', borderRadius: tokens.borderRadiusSmall, backgroundColor: tokens.colorNeutralBackground4, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: tokens.borderRadiusSmall },
});

function labelColor(l: string): 'subtle' | 'informative' | 'warning' | 'danger' | 'severe' {
  if (l === 'Highly Confidential' || l === 'Restricted') return 'danger';
  if (l === 'Confidential') return 'warning';
  if (l === 'Internal') return 'informative';
  return 'subtle';
}
function labelHex(l: string): string {
  if (l === 'Highly Confidential' || l === 'Restricted') return tokens.colorPaletteRedForeground1;
  if (l === 'Confidential') return tokens.colorPaletteDarkOrangeForeground1;
  if (l === 'Internal') return tokens.colorBrandForeground1;
  if (l === 'Public' || l === 'General') return tokens.colorPaletteGreenForeground1;
  return tokens.colorNeutralForeground3;
}

export default function SensitivityPage() {
  const s = useStyles();
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await clientFetch('/api/governance/sensitivity');
      const j = await r.json();
      if (!j.ok) { setError(j.error); return; }
      setData(j);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const itemColumns: LoomColumn<LabeledItem>[] = [
    { key: 'displayName', label: 'Item', sortable: true, filterable: true, getValue: (it) => it.displayName, render: (it) => <strong>{it.displayName}</strong> },
    { key: 'itemType', label: 'Type', sortable: true, filterable: true, getValue: (it) => it.itemType },
    { key: 'workspaceName', label: 'Workspace', sortable: true, filterable: true, getValue: (it) => it.workspaceName || '—', render: (it) => it.workspaceName || '—' },
    { key: 'label', label: 'Label', sortable: true, filterable: true, getValue: (it) => it.label, render: (it) => <Badge appearance="filled" color={labelColor(it.label)} size="small">{it.label}</Badge> },
    {
      key: 'open', label: '', sortable: false, filterable: false, width: 90,
      render: (it) => (
        <a href={`/items/${it.itemType}/${it.id}`} onClick={(e) => e.stopPropagation()}
           style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, fontSize: tokens.fontSizeBase200 }}>
          Open <Open16Regular />
        </a>
      ),
    },
  ];

  return (
    <GovernanceShell sectionTitle="Sensitivity labels">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalM }}>
        Distribution of Microsoft Purview Information Protection labels across your tenant's data assets,
        derived live from each item's <code>state.sensitivityLabel</code> field.
      </Body1>

      <Toolbar actions={<Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>} />

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

          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalS }}>
            <Subtitle2 style={{ display: 'block' }}>Label distribution</Subtitle2>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Click a label to filter the items below.</Caption1>
            <a href="https://purview.microsoft.com/informationprotection/labels" target="_blank" rel="noreferrer"
               style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, fontSize: tokens.fontSizeBase200 }}>
              Manage labels in Microsoft Purview <Open16Regular />
            </a>
          </div>
          <div className={s.labelGrid}>
            {data.distribution.map((d) => {
              const pct = data.labeled ? Math.round(100 * d.count / data.labeled) : 0;
              const sel = selectedLabel === d.label;
              return (
                <button key={d.label} type="button"
                  className={`${s.labelCard}${sel ? ` ${s.labelCardSel}` : ''}`}
                  style={{ borderLeftColor: labelHex(d.label) }}
                  onClick={() => setSelectedLabel(sel ? null : d.label)}>
                  <div className={s.labelCardTop}>
                    <Badge appearance="filled" color={labelColor(d.label)}>{d.label}</Badge>
                    <span className={s.labelCount}>{d.count}</span>
                  </div>
                  <div className={s.bar}><div className={s.barFill} style={{ width: `${pct}%`, backgroundColor: labelHex(d.label) }} /></div>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{pct}% of labeled items</Caption1>
                </button>
              );
            })}
          </div>

          <Subtitle2 style={{ display: 'block', marginBottom: tokens.spacingVerticalS }}>
            Labeled items ({(selectedLabel ? data.items.filter((i) => i.label === selectedLabel) : data.items).length})
            {selectedLabel && <Button size="small" appearance="subtle" onClick={() => setSelectedLabel(null)} style={{ marginLeft: tokens.spacingHorizontalS }}>Clear filter ({selectedLabel})</Button>}
          </Subtitle2>
          <LoomDataTable<LabeledItem>
            columns={itemColumns}
            rows={selectedLabel ? data.items.filter((i) => i.label === selectedLabel) : data.items}
            getRowId={(it) => it.id}
            empty="No items have a sensitivity label yet."
          />
        </>
      )}
    </GovernanceShell>
  );
}
