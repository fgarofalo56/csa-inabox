'use client';

/**
 * Governance → Data contracts (N6).
 *
 * THE registry of ODCS v3.1 data contracts, what each one is bound to at
 * ingestion, and whether the data flowing through those bindings actually
 * conforms. This is Pillar-2's trust boundary made visible: the 2026 lesson is
 * that winners ENFORCE contracts rather than document them, so this page is
 * organised around enforcement, not paperwork.
 *
 *   • KPI row      — contracts, how many are actually enforcing, how many are
 *                    bound to a real ingestion path, rows evaluated vs rejected.
 *   • Registry     — a sortable/filterable LoomDataTable: contract, ODCS
 *                    version + status, enforcement mode (default
 *                    `warn-quarantine`; `hard-reject` is a visible opt-in),
 *                    bindings, pass-rate bar, last decision.
 *   • Empty state  — the guided launcher (create a contract / learn ODCS),
 *                    never a bare div and never fabricated rows.
 *
 * Every number comes from /api/governance/data-contracts, which reads the real
 * `loom-data-contracts` Cosmos container — no mock arrays (no-vaporware).
 * Azure-native, no Microsoft Fabric / Power BI. Web-3.0: Fluent v9 + Loom
 * tokens only, TileGrid/Section/LoomDataTable/GuidedEmptyState primitives, and
 * every badge row wraps (`flexWrap` + `minWidth: 0`) so nothing overlaps.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge, Button, Caption1, Spinner, Text, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, DocumentCheckmark24Regular, ShieldCheckmark20Regular,
  Open16Regular, Warning20Regular,
} from '@fluentui/react-icons';
import { GovernanceShell } from '@/lib/components/governance-shell';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { GuidedEmptyState } from '@/lib/components/shared/guided-empty-state';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { clientFetch } from '@/lib/client-fetch';

interface BindingRow {
  id: string; kind: string; targetItemId: string; targetItemName: string | null;
  dataset: string; enabled: boolean;
}
interface TrendRow {
  runs: number; clean: number; quarantined: number; rejected: number;
  rowsEvaluated: number; rowsRejected: number; passRate: number | null;
}
interface LastRun {
  at: string; source: string; dataset: string; decision: string;
  evaluated: number; rejected: number; deadLetterPath: string | null;
}
interface ContractRow {
  itemId: string; displayName: string; odcsId: string; apiVersion: string | null;
  version: string | null; status: string; objectName: string | null; properties: number;
  slaCount: number; enforcementEnabled: boolean; enforcementMode: string;
  bindings: BindingRow[]; trend: TrendRow; lastRun: LastRun | null; updatedAt: string;
}
interface Summary {
  total: number; active: number; enforcing: number; hardReject: number;
  bound: number; unbound: number; rowsEvaluated: number; rowsRejected: number;
  quarantinedRuns: number; rejectedRuns: number;
}

const useStyles = makeStyles({
  intro: {
    display: 'block',
    color: tokens.colorNeutralForeground3,
    marginBottom: tokens.spacingVerticalL,
    maxWidth: '820px',
  },
  kpi: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    minWidth: 0,
  },
  kpiValue: { fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold, lineHeight: tokens.lineHeightHero700 },
  kpiLabel: { color: tokens.colorNeutralForeground3 },
  badgeRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
    alignItems: 'center',
  },
  cell: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
  bar: {
    flex: 1,
    minWidth: '48px',
    maxWidth: '120px',
    height: tokens.spacingVerticalSNudge,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusCircular,
    overflow: 'hidden',
  },
  barFill: { height: '100%', display: 'block' },
  passCell: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
});

const DECISION_LABEL: Record<string, string> = {
  landed: 'All rows landed',
  'landed-with-quarantine': 'Quarantined',
  'rejected-batch': 'Batch rejected',
};

function StatusBadge({ status }: { status: string }) {
  const color = status === 'active' ? 'success' : status === 'deprecated' || status === 'retired' ? 'warning' : 'informative';
  return <Badge appearance="tint" color={color}>{status}</Badge>;
}

export default function DataContractsPage() {
  const s = useStyles();
  const router = useRouter();
  const [rows, setRows] = useState<ContractRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [defaultMode, setDefaultMode] = useState('warn-quarantine');
  const [disabled, setDisabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await clientFetch('/api/governance/data-contracts');
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Could not load the data-contract registry.');
      setDisabled(!!j.disabled);
      setRows(Array.isArray(j.contracts) ? j.contracts : []);
      setSummary(j.summary || null);
      if (j.defaultMode) setDefaultMode(String(j.defaultMode));
    } catch (e) {
      setError((e as Error)?.message || 'Could not load the data-contract registry.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = search.trim()
    ? rows.filter((r) => `${r.displayName} ${r.odcsId} ${r.objectName || ''}`.toLowerCase().includes(search.trim().toLowerCase()))
    : rows;

  const columns: LoomColumn<ContractRow>[] = [
    {
      key: 'displayName',
      label: 'Contract',
      width: 240,
      render: (r) => (
        <div className={s.cell}>
          <Text weight="semibold">{r.displayName}</Text>
          <br />
          <Caption1>{r.objectName ? `${r.objectName} · ${r.properties} column${r.properties === 1 ? '' : 's'}` : 'No schema object yet'}</Caption1>
        </div>
      ),
      getValue: (r) => r.displayName,
    },
    {
      key: 'version',
      label: 'ODCS',
      width: 150,
      render: (r) => (
        <div className={s.badgeRow}>
          <Badge appearance="outline">{r.apiVersion || 'v3.1.0'}</Badge>
          <Badge appearance="tint" color="brand">v{r.version || '1.0.0'}</Badge>
          <StatusBadge status={r.status} />
        </div>
      ),
      getValue: (r) => `${r.status} ${r.version || ''}`,
    },
    {
      key: 'enforcementMode',
      label: 'Enforcement',
      width: 180,
      filterType: 'select',
      render: (r) => (
        <div className={s.badgeRow}>
          {r.enforcementEnabled ? (
            <Badge appearance="tint" color={r.enforcementMode === 'hard-reject' ? 'danger' : 'success'}>
              {r.enforcementMode}
            </Badge>
          ) : (
            <Badge appearance="tint" color="subtle">off</Badge>
          )}
          {r.enforcementMode === defaultMode && r.enforcementEnabled && <Caption1>default</Caption1>}
        </div>
      ),
      getValue: (r) => (r.enforcementEnabled ? r.enforcementMode : 'off'),
    },
    {
      key: 'bindings',
      label: 'Bound to',
      width: 220,
      render: (r) => (
        r.bindings.length ? (
          <div className={s.badgeRow}>
            {r.bindings.slice(0, 3).map((b) => (
              <Tooltip key={b.id} content={`${b.kind} · ${b.targetItemName || b.targetItemId} · ${b.dataset}`} relationship="label">
                <Badge appearance="outline" color={b.enabled ? 'informative' : 'subtle'}>{b.kind}: {b.dataset}</Badge>
              </Tooltip>
            ))}
            {r.bindings.length > 3 && <Caption1>+{r.bindings.length - 3} more</Caption1>}
          </div>
        ) : (
          <Badge appearance="tint" color="warning">not bound — nothing is enforced yet</Badge>
        )
      ),
      getValue: (r) => r.bindings.map((b) => b.kind).join(' ') || 'unbound',
    },
    {
      key: 'passRate',
      label: 'Pass rate',
      width: 170,
      render: (r) => {
        const pct = r.trend.passRate == null ? null : Math.round(r.trend.passRate * 1000) / 10;
        if (pct == null) return <Caption1>No runs yet</Caption1>;
        const color = pct >= 99 ? tokens.colorPaletteGreenForeground1 : pct >= 90 ? tokens.colorPaletteYellowForeground1 : tokens.colorPaletteRedForeground1;
        return (
          <div className={s.passCell}>
            <span className={s.bar}>
              <span className={s.barFill} style={{ width: `${pct}%`, backgroundColor: color }} />
            </span>
            <Caption1>{pct}% · {r.trend.rowsRejected} rejected</Caption1>
          </div>
        );
      },
      getValue: (r) => (r.trend.passRate == null ? -1 : r.trend.passRate),
    },
    {
      key: 'lastRun',
      label: 'Last decision',
      width: 200,
      render: (r) => (
        r.lastRun ? (
          <div className={s.cell}>
            <Badge
              appearance="tint"
              color={r.lastRun.decision === 'landed' ? 'success' : r.lastRun.decision === 'rejected-batch' ? 'danger' : 'warning'}
            >
              {DECISION_LABEL[r.lastRun.decision] || r.lastRun.decision}
            </Badge>
            <br />
            <Caption1>{r.lastRun.source} · {r.lastRun.dataset} · {new Date(r.lastRun.at).toLocaleString()}</Caption1>
          </div>
        ) : <Caption1>Never enforced</Caption1>
      ),
      getValue: (r) => r.lastRun?.at || '',
    },
  ];

  return (
    <GovernanceShell
      sectionTitle="Data contracts"
      sectionBadge="ODCS 3.1"
      explainer="Open Data Contract Standard v3.1 contracts, the ingestion paths they govern, and whether the data flowing through actually conforms."
    >
      <TeachingBanner
        surfaceKey="governance-data-contracts"
        icon={ShieldCheckmark20Regular}
        title="Contracts that enforce, not contracts that document"
        message={`Every contract here is stored as ODCS 3.1 JSON and applied at ingestion. The default posture is ${defaultMode}: a violating row is quarantined to the Bronze _rejected dead-letter path and an alert fires, while the rest of the batch still lands — a new contract can never silently drop a production load. Switch a proven contract to hard-reject when you want the whole batch blocked.`}
        learnMoreHref="https://bitol-io.github.io/open-data-contract-standard/latest/"
      />

      <Text className={s.intro}>
        Author a contract on any <strong>data contract</strong> item (schema derived from the bound table,
        quality and SLA rules from typed pickers), register it as ODCS 3.1, then bind it to a mirrored database,
        a pipeline sink, or an eventstream. Loom enforces it on every batch.
      </Text>

      {disabled && (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Registry turned off</MessageBarTitle>
            The <code>n6-data-contracts</code> runtime flag is off, so this registry is hidden. Enforcement itself is
            unaffected — bound contracts keep quarantining violations. Re-enable it in Admin → Runtime flags.
          </MessageBarBody>
        </MessageBar>
      )}

      {error && (
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Could not load the registry</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {summary && summary.total > 0 && (
        <Section title="Enforcement posture">
          <TileGrid>
            <div className={s.kpi}>
              <span className={s.kpiValue}>{summary.total}</span>
              <Caption1 className={s.kpiLabel}>Registered contracts</Caption1>
            </div>
            <div className={s.kpi}>
              <span className={s.kpiValue}>{summary.enforcing}</span>
              <Caption1 className={s.kpiLabel}>Enforcing ({summary.hardReject} hard-reject)</Caption1>
            </div>
            <div className={s.kpi}>
              <span className={s.kpiValue}>{summary.bound}</span>
              <Caption1 className={s.kpiLabel}>Bound to an ingestion path ({summary.unbound} unbound)</Caption1>
            </div>
            <div className={s.kpi}>
              <span className={s.kpiValue}>{summary.rowsRejected}</span>
              <Caption1 className={s.kpiLabel}>Rows quarantined of {summary.rowsEvaluated} evaluated</Caption1>
            </div>
          </TileGrid>
        </Section>
      )}

      <Section
        title="Registry"
        actions={
          <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={() => void load()} disabled={loading}>
            Refresh
          </Button>
        }
      >
        <Toolbar
          search={search}
          onSearch={setSearch}
          searchPlaceholder="Search contracts…"
          actions={
            <Button appearance="primary" icon={<Add20Regular />} onClick={() => router.push('/items/data-contract/new')}>
              New data contract
            </Button>
          }
        />
        {loading ? (
          <Spinner label="Loading data contracts…" />
        ) : filtered.length === 0 ? (
          <GuidedEmptyState
            title={rows.length === 0 ? 'No data contracts registered yet' : 'No contracts match that search'}
            intro={
              rows.length === 0
                ? 'A data contract is the enforceable agreement between a producer and its consumers: the schema, the quality rules, and the SLAs. Register one as ODCS 3.1 and Loom applies it at ingestion.'
                : 'Clear the search to see every registered contract.'
            }
            heroIcon={DocumentCheckmark24Regular}
            paths={[
              {
                key: 'create',
                title: 'Create a data contract',
                body: 'Derive the schema from a bound table, add quality and SLA rules from typed pickers, then register it as ODCS 3.1.',
                icon: Add20Regular,
                onClick: () => router.push('/items/data-contract/new'),
              },
              {
                key: 'bind',
                title: 'Bind an ingestion path',
                body: 'Point a contract at a mirrored database, a pipeline sink, or an eventstream — that is the moment it starts enforcing.',
                icon: ShieldCheckmark20Regular,
                onClick: () => router.push('/browse?type=mirrored-database'),
              },
              {
                key: 'quality',
                title: 'Review data quality',
                body: 'Rules, runs, and monitors across Kusto, Databricks, and Synapse — the observational half of the same story.',
                icon: Warning20Regular,
                onClick: () => router.push('/governance/data-quality'),
              },
            ]}
            learnMoreHref="https://bitol-io.github.io/open-data-contract-standard/latest/"
            learnMoreLabel="Open Data Contract Standard"
          />
        ) : (
          <LoomDataTable
            columns={columns}
            rows={filtered}
            getRowId={(r) => r.itemId}
            ariaLabel="Registered data contracts"
            onRowClick={(r) => router.push(`/items/data-contract/${encodeURIComponent(r.itemId)}`)}
            rowActions={(r) => [
              {
                key: 'open',
                label: 'Open contract',
                icon: <Open16Regular />,
                onClick: () => router.push(`/items/data-contract/${encodeURIComponent(r.itemId)}`),
              },
            ]}
          />
        )}
      </Section>
    </GovernanceShell>
  );
}
