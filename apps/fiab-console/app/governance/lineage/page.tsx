'use client';

import { GovernanceShell } from '@/lib/components/governance-shell';
import {
  Body1, Caption1, Subtitle2, Badge,
  makeStyles, tokens,
} from '@fluentui/react-components';

/**
 * Lineage page — column-level lineage graph rendered with SVG (no
 * extra dep). Mirrors Purview's lineage view: upstream sources → ETL
 * → downstream consumers, with column highlighting.
 */

interface Node { id: string; label: string; type: string; x: number; y: number; }
interface Edge { from: string; to: string; cols?: string; }

const NODES: Node[] = [
  { id: 'sql',  label: 'prod-sales (Azure SQL)',        type: 'Source',    x: 30,  y: 60  },
  { id: 'sap',  label: 'sap_orders_extract',            type: 'Source',    x: 30,  y: 220 },
  { id: 'cdc',  label: 'orders-cdc (Eventstream)',      type: 'Stream',    x: 280, y: 60  },
  { id: 'mirror', label: 'orders-mirror (Mirrored DB)', type: 'Mirror',    x: 280, y: 220 },
  { id: 'bronze', label: 'bronze.orders (Lakehouse)',   type: 'Lakehouse', x: 530, y: 140 },
  { id: 'silver', label: 'silver.orders_clean',         type: 'Lakehouse', x: 780, y: 140 },
  { id: 'fact',   label: 'fact_sales (Warehouse)',      type: 'Warehouse', x: 1030, y: 80  },
  { id: 'sm',     label: 'CustomerSemantic',            type: 'Semantic',  x: 1030, y: 220 },
  { id: 'rpt',    label: 'Sales Exec Report',           type: 'Report',    x: 1280, y: 140 },
];
const EDGES: Edge[] = [
  { from: 'sql',  to: 'cdc',    cols: '12 cols' },
  { from: 'sap',  to: 'mirror', cols: '34 cols' },
  { from: 'cdc',  to: 'bronze', cols: 'orders, amount, ts' },
  { from: 'mirror', to: 'bronze', cols: '34 cols' },
  { from: 'bronze', to: 'silver', cols: '+ dedup, +clean' },
  { from: 'silver', to: 'fact',  cols: '6 cols' },
  { from: 'silver', to: 'sm',    cols: 'measures: TotalRevenue' },
  { from: 'fact',   to: 'rpt',   cols: 'TotalRevenue' },
  { from: 'sm',     to: 'rpt',   cols: 'live connection' },
];

const TYPE_COLOR: Record<string, string> = {
  Source: '#1f6feb', Stream: '#0050b3', Mirror: '#117865', Lakehouse: '#3d2e80',
  Warehouse: '#b91c4b', Semantic: '#7d6cff', Report: '#d89f3d',
};

const useStyles = makeStyles({
  legend: { display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' },
  legChip: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 },
  swatch: { width: 12, height: 12, borderRadius: 3 },
  canvas: {
    width: '100%', overflowX: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 8, backgroundColor: tokens.colorNeutralBackground1,
    backgroundImage: `radial-gradient(${tokens.colorNeutralStroke3} 1px, transparent 1px)`,
    backgroundSize: '20px 20px',
  },
  meta: { marginTop: 16, padding: 12, backgroundColor: tokens.colorNeutralBackground2, borderRadius: 6 },
});

export default function LineagePage() {
  const s = useStyles();
  return (
    <GovernanceShell sectionTitle="Column-level lineage" sectionBadge="Purview-backed">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Lineage is harvested from Loom-native runs (pipelines, dataflows, notebooks, mirrored DBs) and from Purview scans against on-prem and third-party sources. Click a node to drill into its column-level lineage.
      </Body1>
      <div className={s.legend}>
        {Object.entries(TYPE_COLOR).map(([t, c]) => (
          <span key={t} className={s.legChip}><span className={s.swatch} style={{ background: c }} />{t}</span>
        ))}
      </div>
      <div className={s.canvas}>
        <svg viewBox="0 0 1500 320" width="1500" height="320" role="img" aria-label="Lineage graph">
          {EDGES.map((e, i) => {
            const a = NODES.find((n) => n.id === e.from)!;
            const b = NODES.find((n) => n.id === e.to)!;
            return (
              <g key={i}>
                <line x1={a.x + 200} y1={a.y + 30} x2={b.x} y2={b.y + 30}
                  stroke="#7d6cff" strokeWidth="2" opacity="0.65" markerEnd="url(#arrow)" />
                {e.cols && (
                  <text x={(a.x + 200 + b.x) / 2} y={(a.y + b.y) / 2 + 22}
                    fontSize="10" fill="#4b5563" textAnchor="middle">{e.cols}</text>
                )}
              </g>
            );
          })}
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="#7d6cff" />
            </marker>
          </defs>
          {NODES.map((n) => (
            <g key={n.id} transform={`translate(${n.x},${n.y})`}>
              <rect width="200" height="60" rx="8" fill="#fff" stroke={TYPE_COLOR[n.type]} strokeWidth="2" />
              <rect width="6" height="60" rx="2" fill={TYPE_COLOR[n.type]} />
              <text x="16" y="22" fontSize="11" fill="#525252" textTransform="uppercase" fontWeight="600">{n.type}</text>
              <text x="16" y="42" fontSize="13" fontWeight="600" fill="#1a1a1a">{n.label}</text>
            </g>
          ))}
        </svg>
      </div>
      <div className={s.meta}>
        <Subtitle2>fact_sales — selected</Subtitle2>
        <Body1 style={{ marginTop: 4 }}>9 lineage edges · 6 upstream sources · 1 downstream report · last harvested 5 min ago by orchestrator <code>loom-purview-scanner</code>.</Body1>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <Badge appearance="outline">12 columns</Badge>
          <Badge appearance="outline">3 PII columns</Badge>
          <Badge appearance="outline" color="success">Certified</Badge>
        </div>
      </div>
    </GovernanceShell>
  );
}
