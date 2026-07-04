'use client';

/**
 * OneLake catalog — Govern tab.
 *
 * The governance surface of the OneLake catalog (the Fabric "Govern" pivot,
 * https://learn.microsoft.com/fabric/governance/onelake-catalog-govern),
 * themed Fluent v9 + Loom tokens. It answers "how well-governed is the data in
 * this tenant?" entirely from Azure-native backends:
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │ [honest Purview gate — warning when LOOM_PURVIEW_ACCOUNT unset] │
 *   ├──────────────┬──────────────┬──────────────────────────────────┤
 *   │ % Labeled    │ % Endorsed   │ % With owner   (score cards)      │
 *   ├──────────────┴──────────────┴──────────────────────────────────┤
 *   │ Label-coverage donut (labeled vs unlabeled)                     │
 *   ├──────────────────────────────────────────────────────────────────┤
 *   │ Classification table  (classification | items | Purview scans)   │
 *   ├──────────────────────────────────────────────────────────────────┤
 *   │ Items needing attention  (deep-linked to /items/{type}/{id})     │
 *   ├──────────────────────────────────────────────────────────────────┤
 *   │ F20 doc panel — one physical Delta read by many engines          │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * REAL data: GET /api/onelake/governance aggregates Cosmos item metadata +
 * (optional) Purview classic Data Map classifications. No mock arrays.
 *
 * Honest gate: when Purview is unset/unreachable the score cards, donut,
 * Cosmos classification counts and attention list still render in full — a
 * MessageBar names LOOM_PURVIEW_ACCOUNT for the scan-based overlay.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Spinner,
  Badge,
  Button,
  Text,
  Title3,
  Caption1,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  Open16Regular,
  Database20Regular,
  Person20Regular,
  ShieldCheckmark20Regular,
  Tag20Regular,
} from '@fluentui/react-icons';

import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { itemVisual } from '@/lib/components/ui/item-type-visual';

interface ClassificationRow {
  classification: string;
  count: number;
  purviewAssets?: number;
}

interface AttentionItem {
  id: string;
  itemType: string;
  displayName: string;
  workspaceId: string;
  workspaceName: string;
  issues: string[];
  href: string;
}

interface PurviewGateHint {
  missingEnvVar: string;
  bicepModule: string;
  bicepStatus?: string;
  followUp?: string;
}

interface GovernanceData {
  ok: boolean;
  purviewConfigured: boolean;
  purviewAccount: string | null;
  purviewAssetCount: number | null;
  totalItems: number;
  labeled: number;
  endorsed: number;
  owned: number;
  labeledPct: number;
  endorsedPct: number;
  ownedPct: number;
  attentionCount: number;
  classificationTable: ClassificationRow[];
  attention: AttentionItem[];
  purviewGate?: PurviewGateHint;
  error?: string;
}

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXL,
  },

  // ── score cards row ──
  cards: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow2,
    padding: tokens.spacingVerticalL,
  },
  cardHead: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground2,
  },
  cardIcon: {
    width: '32px',
    height: '32px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
  },
  cardValue: {
    fontSize: '34px',
    lineHeight: '38px',
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
    color: tokens.colorNeutralForeground1,
  },
  cardSub: { color: tokens.colorNeutralForeground3 },
  bar: {
    position: 'relative',
    height: '8px',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralBackground4,
    overflow: 'hidden',
  },
  barFill: {
    position: 'absolute',
    insetBlockStart: 0,
    insetInlineStart: 0,
    height: '100%',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorBrandBackground,
  },

  // ── donut block ──
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow2,
    padding: tokens.spacingVerticalL,
  },
  donutRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXL,
    flexWrap: 'wrap',
  },
  legend: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  legendRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  legendDot: {
    width: '12px',
    height: '12px',
    borderRadius: tokens.borderRadiusSmall,
    flexShrink: 0,
  },

  // ── attention list ──
  attentionRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  attentionIcon: {
    width: '32px',
    height: '32px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  attentionMain: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1 },
  attentionName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: tokens.fontWeightSemibold },
  attentionIssues: { display: 'inline-flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },

  emptyBox: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalXXL,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground2,
    textAlign: 'center',
  },

  // ── F20 doc panel ──
  docPanel: {
    display: 'flex',
    gap: tokens.spacingHorizontalM,
    alignItems: 'flex-start',
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorBrandStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    padding: tokens.spacingVerticalL,
  },
  docIcon: { flexShrink: 0, marginTop: '2px' },

  sectionTitle: { margin: 0 },
});

// ── label-coverage donut (pure SVG; no chart lib in repo) ──────────────────
function LabelDonut({ labeled, total }: { labeled: number; total: number }) {
  const r = 46;
  const circ = 2 * Math.PI * r;
  const pct = total ? labeled / total : 0;
  const dash = pct * circ;
  return (
    <svg
      width="120"
      height="120"
      viewBox="0 0 120 120"
      role="img"
      aria-label={`${Math.round(pct * 100)} percent of catalog items labeled`}
    >
      <circle cx="60" cy="60" r={r} fill="none" strokeWidth="14" stroke={tokens.colorNeutralBackground4} />
      <circle
        cx="60"
        cy="60"
        r={r}
        fill="none"
        strokeWidth="14"
        stroke={tokens.colorBrandBackground}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${circ - dash}`}
        strokeDashoffset={circ / 4}
        transform="rotate(-90 60 60)"
      />
      <text x="60" y="58" textAnchor="middle" fontSize="22" fontWeight="600" fill={tokens.colorNeutralForeground1}>
        {Math.round(pct * 100)}%
      </text>
      <text x="60" y="78" textAnchor="middle" fontSize="11" fill={tokens.colorNeutralForeground3}>
        labeled
      </text>
    </svg>
  );
}

// ── score card ──
function ScoreCard({
  icon,
  label,
  pct,
  numerator,
  total,
}: {
  icon: React.ReactNode;
  label: string;
  pct: number;
  numerator: number;
  total: number;
}) {
  const styles = useStyles();
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardIcon} aria-hidden>
          {icon}
        </span>
        <Text weight="semibold">{label}</Text>
      </div>
      <div className={styles.cardValue}>{pct}%</div>
      <div className={styles.bar} role="presentation">
        <div className={styles.barFill} style={{ width: `${pct}%` }} />
      </div>
      <Caption1 className={styles.cardSub}>
        {numerator} of {total} catalog item{total === 1 ? '' : 's'}
      </Caption1>
    </div>
  );
}

export function GovernView() {
  const styles = useStyles();
  const router = useRouter();
  const [data, setData] = useState<GovernanceData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/onelake/governance')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: GovernanceData) => {
        if (cancelled) return;
        if (d.ok) setData(d);
        else setError(d.error || 'Failed to load governance metrics');
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message ?? 'Failed to load governance metrics');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>
          <MessageBarTitle>Could not load governance metrics</MessageBarTitle>
          {error}
        </MessageBarBody>
      </MessageBar>
    );
  }
  if (data === null) return <Spinner label="Computing governance score…" />;

  const purviewOn = data.purviewConfigured && data.purviewAssetCount !== null;

  const classColumns: LoomColumn<ClassificationRow>[] = [
    {
      key: 'classification',
      label: 'Classification',
      width: 320,
      render: (r) => (
        <Badge appearance="tint" color="informative">
          {r.classification}
        </Badge>
      ),
    },
    {
      key: 'count',
      label: 'Labeled items',
      width: 140,
      getValue: (r) => r.count,
      render: (r) => <Text>{r.count}</Text>,
    },
    {
      key: 'purviewAssets',
      label: 'Purview scan hits',
      width: 160,
      getValue: (r) => r.purviewAssets ?? -1,
      render: (r) =>
        r.purviewAssets === undefined ? (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>—</Caption1>
        ) : (
          <Text>{r.purviewAssets}</Text>
        ),
    },
  ];

  return (
    <div className={styles.root}>
      {/* Honest Purview gate (Cosmos metrics still render above/below) */}
      {data.purviewGate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>
              Purview scan-based classifications need <code>{data.purviewGate.missingEnvVar}</code>
            </MessageBarTitle>
            Governance score and the labeled-item classification counts below are computed from
            Azure-native catalog metadata — no Microsoft Purview, Fabric or Power BI required. To
            overlay Purview scan-based classification counts, set{' '}
            <code>{data.purviewGate.missingEnvVar}</code> and deploy{' '}
            <code>{data.purviewGate.bicepModule}</code>
            {data.purviewGate.followUp ? `. ${data.purviewGate.followUp}` : '.'}
          </MessageBarBody>
        </MessageBar>
      )}

      {data.totalItems === 0 && (
        <div className={styles.emptyBox}>
          <Text weight="semibold">No catalog items to govern yet.</Text>
          <Caption1>
            Create a lakehouse, warehouse, database, mirrored or KQL store from any workspace, then
            its governance posture appears here.
          </Caption1>
        </div>
      )}

      {/* Score cards */}
      <div className={styles.cards}>
        <ScoreCard
          icon={<Tag20Regular />}
          label="Labeled"
          pct={data.labeledPct}
          numerator={data.labeled}
          total={data.totalItems}
        />
        <ScoreCard
          icon={<ShieldCheckmark20Regular />}
          label="Endorsed"
          pct={data.endorsedPct}
          numerator={data.endorsed}
          total={data.totalItems}
        />
        <ScoreCard
          icon={<Person20Regular />}
          label="With owner"
          pct={data.ownedPct}
          numerator={data.owned}
          total={data.totalItems}
        />
      </div>

      {/* Label-coverage donut */}
      <div className={styles.panel}>
        <Title3 className={styles.sectionTitle}>Label coverage</Title3>
        <div className={styles.donutRow}>
          <LabelDonut labeled={data.labeled} total={data.totalItems} />
          <div className={styles.legend}>
            <div className={styles.legendRow}>
              <span className={styles.legendDot} style={{ backgroundColor: tokens.colorBrandBackground }} aria-hidden />
              <Text>
                Labeled — <strong>{data.labeled}</strong>
              </Text>
            </div>
            <div className={styles.legendRow}>
              <span className={styles.legendDot} style={{ backgroundColor: tokens.colorNeutralBackground4 }} aria-hidden />
              <Text>
                Unlabeled — <strong>{Math.max(0, data.totalItems - data.labeled)}</strong>
              </Text>
            </div>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              Sensitivity labels set in the item editor or Governance.
              {purviewOn
                ? ` Purview scanned ${data.purviewAssetCount} data asset${data.purviewAssetCount === 1 ? '' : 's'} in account ${data.purviewAccount}.`
                : ''}
            </Caption1>
          </div>
        </div>
      </div>

      {/* Classification table */}
      <div className={styles.panel}>
        <Title3 className={styles.sectionTitle}>Classifications</Title3>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Item counts per classification from Azure-native catalog metadata
          {purviewOn ? ', overlaid with Microsoft Purview scan-based asset hits.' : '.'}
        </Caption1>
        <LoomDataTable
          columns={classColumns}
          rows={data.classificationTable}
          getRowId={(r) => r.classification}
          ariaLabel="Classification coverage"
          empty="No classifications applied to catalog items yet."
        />
      </div>

      {/* Items needing attention */}
      <div className={styles.panel}>
        <Title3 className={styles.sectionTitle}>
          Items needing attention{data.attentionCount ? ` · ${data.attentionCount}` : ''}
        </Title3>
        {data.attention.length === 0 ? (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            Every catalog item has a label, owner, endorsement and at least one classification. Nice.
          </Caption1>
        ) : (
          <div role="list">
            {data.attention.map((a) => {
              const v = itemVisual(a.itemType);
              const Icon = v.icon;
              return (
                <div key={a.id} className={styles.attentionRow} role="listitem">
                  <span
                    className={styles.attentionIcon}
                    style={{ backgroundColor: `${v.color}1f`, color: v.color }}
                    aria-hidden
                  >
                    <Icon style={{ width: 18, height: 18, color: v.color }} />
                  </span>
                  <span className={styles.attentionMain}>
                    <Text className={styles.attentionName} title={a.displayName}>
                      {a.displayName}
                    </Text>
                    <span className={styles.attentionIssues}>
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{a.workspaceName}</Caption1>
                      {a.issues.map((iss) => (
                        <Badge key={iss} appearance="outline" color="warning" size="small">
                          {iss}
                        </Badge>
                      ))}
                    </span>
                  </span>
                  <Button
                    icon={<Open16Regular />}
                    size="small"
                    appearance="primary"
                    onClick={() => router.push(a.href)}
                  >
                    Open
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* F20 doc panel — one physical Delta, many engines */}
      <section className={styles.docPanel} aria-label="Delta multi-engine note">
        <Database20Regular className={styles.docIcon} style={{ color: tokens.colorBrandForeground1 }} />
        <div>
          <Text weight="semibold" block>
            One physical Delta table — many engines
          </Text>
          <Caption1 block style={{ marginTop: tokens.spacingVerticalXS }}>
            Every lakehouse table in this catalog is a Delta Lake table stored once in OneLake (ADLS
            Gen2). The same physical Parquet + <code>_delta_log</code> files are simultaneously
            readable by Azure Synapse Analytics SQL (external tables / OPENROWSET), Apache Spark
            (Synapse Spark or Databricks), and Azure Data Explorer (ADX external delta table). No
            Power BI or Microsoft Fabric capacity is required to query the underlying data — any
            engine with Delta Lake support and ADLS connectivity reads it directly.
          </Caption1>
        </div>
      </section>
    </div>
  );
}

export default GovernView;
