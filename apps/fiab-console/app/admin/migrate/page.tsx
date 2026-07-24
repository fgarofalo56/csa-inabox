'use client';

/**
 * /admin/migrate — M1 estate assessment + inventory importer (the inbound-
 * migration ON-RAMP).
 *
 * Point Loom at a Snowflake / Databricks Unity Catalog / Microsoft Fabric /
 * Power BI estate, enumerate it, and render a MIGRATION-READINESS REPORT: KPI
 * tiles (total objects, 1:1, needs-review) + a per-object mapping table (source
 * kind → Loom item type, effort badge, reason). Real data via the audited BFF
 * (/api/migrate/assess → the loom-migrate reader → lib/migrate/assessment.ts);
 * every non-functional state is an HONEST gate (no fabricated counts) per
 * no-vaporware. A Fabric / Power BI estate is only ever a migration SOURCE —
 * Loom itself has no Fabric dependency.
 *
 * UX baseline: guided empty state (no red on first open), Fluent v9 + Loom
 * tokens only, TileGrid / EmptyState primitives, flexWrap badge rows.
 */
import { useState } from 'react';
import Link from 'next/link';
import { clientFetch } from '@/lib/client-fetch';
import { AdminShell } from '@/lib/components/admin-shell';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { EmptyState } from '@/lib/components/empty-state';
import { TranslatePanel } from './translate-panel';
import {
  makeStyles, tokens, Subtitle2, Caption1, Body1, Badge, Spinner, Dropdown, Option,
  Button, Input, Field, MessageBar, MessageBarBody, MessageBarTitle, Tooltip,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  TabList, Tab,
} from '@fluentui/react-components';
import {
  ArrowSwap24Regular, DatabaseArrowRight20Regular, Search20Regular, CheckmarkCircle20Regular,
  Warning20Regular,
} from '@fluentui/react-icons';
import {
  MIGRATION_SOURCE_LABELS, effortBadgeColor,
  type MigrationSourceType, type ReadinessReport, type AssessedObject,
} from '@/lib/migrate/assessment';

const SOURCE_TYPES: MigrationSourceType[] = ['snowflake', 'databricks-uc', 'fabric', 'powerbi'];

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  section: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4, minWidth: 0,
  },
  toolbar: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: tokens.spacingHorizontalM, flex: 1, minWidth: 0 },
  tile: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4, minWidth: 0,
  },
  tileValue: { fontSize: '28px', fontWeight: 700, lineHeight: 1.1, overflowWrap: 'anywhere' },
  tileLabel: { color: tokens.colorNeutralForeground2 },
  badgeRow: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0, alignItems: 'center' },
  scroll: { overflowX: 'auto', minWidth: 0 },
  reason: { color: tokens.colorNeutralForeground3, fontSize: '12px', maxWidth: '420px', overflowWrap: 'anywhere' },
  mono: { fontFamily: tokens.fontFamilyMonospace },
});

interface AssessState {
  loading: boolean;
  report?: ReadinessReport;
  /** Infra gate (LOOM_MIGRATE_URL unset). */
  infraGate?: { title: string; remediation: string; fixItHref: string };
  /** Connector gate (source connection prerequisite missing). */
  connectorGate?: { message: string; prerequisite: string[] };
  error?: string;
}

async function assess(sourceType: MigrationSourceType, connection: Record<string, string>) {
  const res = await clientFetch('/api/migrate/assess', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceType, connection }),
  }, 90_000);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

export default function MigratePage() {
  const styles = useStyles();
  const [tab, setTab] = useState<'assess' | 'translate'>('assess');
  const [sourceType, setSourceType] = useState<MigrationSourceType>('snowflake');
  const [host, setHost] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [catalog, setCatalog] = useState('');
  const [token, setToken] = useState('');
  const [state, setState] = useState<AssessState>({ loading: false });

  async function runAssess() {
    setState({ loading: true });
    try {
      const connection: Record<string, string> = {};
      if (host.trim()) connection.host = host.trim();
      if (workspaceId.trim()) connection.workspaceId = workspaceId.trim();
      if (catalog.trim()) connection.catalog = catalog.trim();
      if (token.trim()) connection.token = token.trim();
      const { status, json } = await assess(sourceType, connection);

      if (status === 503 && json?.gate) {
        setState({ loading: false, infraGate: { title: json.gate.title, remediation: json.gate.remediation, fixItHref: json.gate.fixItHref } });
        return;
      }
      if (json?.ok === false && json?.gated && json?.gate) {
        setState({ loading: false, connectorGate: { message: json.gate.remediation || json.gate.message, prerequisite: json.gate.missing || json.gate.prerequisite || [] } });
        return;
      }
      if (json?.report) {
        setState({ loading: false, report: json.report as ReadinessReport });
        return;
      }
      setState({ loading: false, error: json?.error || `Assessment failed (${status}).` });
    } catch (e) {
      setState({ loading: false, error: (e as Error)?.message || 'Assessment failed.' });
    }
  }

  const showHost = sourceType === 'snowflake' || sourceType === 'databricks-uc';
  const showWorkspace = sourceType === 'fabric' || sourceType === 'powerbi';
  const showCatalog = sourceType === 'databricks-uc' || sourceType === 'snowflake';

  return (
    <AdminShell
      sectionTitle="Migrate"
      learn={{
        title: 'Estate assessment',
        content:
          'Point Loom at a Snowflake, Databricks Unity Catalog, Microsoft Fabric, or Power BI estate and get a migration-readiness report — every schema, table, model, notebook, and report mapped to a Loom item type with a 1:1 / needs-review effort flag. A Fabric or Power BI estate is only ever a migration SOURCE; Loom itself needs no Fabric.',
      }}
    >
      <div className={styles.root}>
        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'assess' | 'translate')}>
          <Tab value="assess">Assess</Tab>
          <Tab value="translate">Translate</Tab>
        </TabList>

        {tab === 'translate' ? <TranslatePanel /> : (
        <>
        {/* Source connection picker */}
        <div className={styles.section}>
          <div className={styles.badgeRow}>
            <ArrowSwap24Regular />
            <Subtitle2>Connect a source estate</Subtitle2>
          </div>
          <div className={styles.toolbar}>
            <Field label="Source type" style={{ minWidth: '220px' }}>
              <Dropdown
                value={MIGRATION_SOURCE_LABELS[sourceType]}
                selectedOptions={[sourceType]}
                aria-label="Source type"
                onOptionSelect={(_, d) => setSourceType((d.optionValue as MigrationSourceType) || 'snowflake')}
              >
                {SOURCE_TYPES.map((s) => <Option key={s} value={s}>{MIGRATION_SOURCE_LABELS[s]}</Option>)}
              </Dropdown>
            </Field>
            <div className={styles.formGrid}>
              {showHost && (
                <Field label={sourceType === 'snowflake' ? 'Account URL' : 'Workspace URL'}>
                  <Input value={host} onChange={(_, d) => setHost(d.value)}
                    placeholder={sourceType === 'snowflake' ? 'https://<account>.snowflakecomputing.com' : 'https://adb-<id>.azuredatabricks.net'} />
                </Field>
              )}
              {showWorkspace && (
                <Field label="Workspace / group id">
                  <Input value={workspaceId} onChange={(_, d) => setWorkspaceId(d.value)} placeholder="00000000-0000-0000-0000-000000000000" />
                </Field>
              )}
              {showCatalog && (
                <Field label={sourceType === 'snowflake' ? 'Database' : 'Catalog'}>
                  <Input value={catalog} onChange={(_, d) => setCatalog(d.value)} placeholder={sourceType === 'snowflake' ? 'ANALYTICS_DB' : 'main'} />
                </Field>
              )}
              <Field label="Access token / PAT (Key Vault ref)" hint="Stored + resolved server-side; never rendered back.">
                <Input type="password" value={token} onChange={(_, d) => setToken(d.value)} placeholder="@Microsoft.KeyVault(SecretUri=…) or a PAT" />
              </Field>
            </div>
            <Button appearance="primary" icon={<Search20Regular />} onClick={runAssess} disabled={state.loading}>
              {state.loading ? <Spinner size="tiny" /> : 'Assess'}
            </Button>
          </div>
          <Caption1 className={styles.tileLabel}>
            The reader runs in-boundary. A source whose connection isn&apos;t provided yet is honestly gated — you&apos;ll see exactly what to supply, never a fabricated count.
          </Caption1>
        </div>

        {/* Result */}
        {state.infraGate && (
          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>Estate reader not configured</MessageBarTitle>
              {state.infraGate.remediation}{' '}
              <Link href={state.infraGate.fixItHref}>Fix it in the gate registry →</Link>
            </MessageBarBody>
          </MessageBar>
        )}
        {state.connectorGate && (
          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>Source connection required</MessageBarTitle>
              {state.connectorGate.message}
              {state.connectorGate.prerequisite.length > 0 && (
                <> Provide: <span className={styles.mono}>{state.connectorGate.prerequisite.join(', ')}</span>.</>
              )}
            </MessageBarBody>
          </MessageBar>
        )}
        {state.error && (
          <MessageBar intent="error" layout="multiline">
            <MessageBarBody><MessageBarTitle>Assessment failed</MessageBarTitle>{state.error}</MessageBarBody>
          </MessageBar>
        )}

        {state.loading && <Spinner label="Enumerating the source estate…" />}

        {state.report && <ReportView report={state.report} />}

        {/* Guided empty first-open state — no red, no error banner. */}
        {!state.loading && !state.report && !state.infraGate && !state.connectorGate && !state.error && (
          <EmptyState
            icon={<DatabaseArrowRight20Regular />}
            title="Assess a source estate to begin"
            body="Pick a source type above, provide its connection, and select Assess. Loom enumerates the estate and produces a migration-readiness report — every object mapped to a Loom item type with a 1:1 / needs-review effort flag."
          />
        )}
        </>
        )}
      </div>
    </AdminShell>
  );
}

function ReportView({ report }: { report: ReadinessReport }) {
  const styles = useStyles();
  const itemTypeEntries = Object.entries(report.byLoomItemType).sort((a, b) => b[1] - a[1]);

  return (
    <>
      <TileGrid minTileWidth={220}>
        <div className={styles.tile}>
          <Caption1 className={styles.tileLabel}>Objects enumerated</Caption1>
          <div className={styles.tileValue}>{report.totals.objects.toLocaleString()}</div>
          <Caption1 className={styles.tileLabel}>{report.sourceLabel || MIGRATION_SOURCE_LABELS[report.sourceType]}</Caption1>
        </div>
        <div className={styles.tile}>
          <Caption1 className={styles.tileLabel}>1:1 mappings</Caption1>
          <div className={styles.tileValue}>{report.totals.oneToOne.toLocaleString()}</div>
          <div className={styles.badgeRow}>
            <Badge appearance="tint" color="success" icon={<CheckmarkCircle20Regular />}>direct Loom item</Badge>
          </div>
        </div>
        <div className={styles.tile}>
          <Caption1 className={styles.tileLabel}>Needs review</Caption1>
          <div className={styles.tileValue}>{report.totals.needsReview.toLocaleString()}</div>
          <div className={styles.badgeRow}>
            <Badge appearance="tint" color="warning" icon={<Warning20Regular />}>manual step</Badge>
          </div>
        </div>
      </TileGrid>

      <div className={styles.section}>
        <div className={styles.badgeRow}>
          <Subtitle2>Loom item types</Subtitle2>
        </div>
        {itemTypeEntries.length ? (
          <div className={styles.badgeRow}>
            {itemTypeEntries.map(([k, n]) => (
              <Badge key={k} appearance="tint" color={k === 'needs-review' ? 'warning' : 'brand'}>{k}: {n}</Badge>
            ))}
          </div>
        ) : <Body1>No objects were enumerated.</Body1>}
      </div>

      <div className={styles.section}>
        <div className={styles.badgeRow}>
          <Subtitle2>Per-object mapping</Subtitle2>
        </div>
        <div className={styles.scroll}>
          <Table aria-label="Per-object migration mapping" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Source object</TableHeaderCell>
                <TableHeaderCell>Source kind</TableHeaderCell>
                <TableHeaderCell>Loom item type</TableHeaderCell>
                <TableHeaderCell>Effort</TableHeaderCell>
                <TableHeaderCell>Notes</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.objects.map((o: AssessedObject, i: number) => (
                <TableRow key={`${o.name}-${i}`}>
                  <TableCell>
                    <span className={styles.mono}>{[o.database, o.schema, o.name].filter(Boolean).join('.')}</span>
                  </TableCell>
                  <TableCell>{o.rawType || o.sourceKind}</TableCell>
                  <TableCell>
                    {o.loomItemType === 'needs-review'
                      ? <Badge appearance="tint" color="warning">needs-review</Badge>
                      : <Badge appearance="tint" color="brand">{o.loomItemType}</Badge>}
                  </TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={effortBadgeColor(o.effort)}>{o.effort}</Badge>
                  </TableCell>
                  <TableCell>
                    <Tooltip content={o.reason} relationship="description">
                      <span className={styles.reason}>{o.reason}</span>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </>
  );
}
