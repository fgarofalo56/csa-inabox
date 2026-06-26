'use client';

/**
 * CatalogItemActions — per-hit actions for a Loom (OneLake-source) catalog
 * record, rendered inside the CatalogDetailTile metadata dialog (alongside
 * "Close" / "Open in catalog").
 *
 * Two Azure-native, no-Fabric actions (per .claude/rules):
 *
 *   1) "Open in workspace"  (#2 deep-link)
 *      A plain link to the real item editor `/items/<type>/<id>`. For a Loom
 *      search hit this equals `detail_path`; we route to the editor (NOT
 *      `/catalog/onelake/<id>`, which 401s on getFabricItem with no Fabric
 *      tenant). Shown for every onelake hit.
 *
 *   2) "Build report in Loom"  (#1 build-report)
 *      Shown only for data-source item types whose data actually lives on a
 *      Synapse SQL endpoint the route can query today: lakehouse (serverless),
 *      warehouse (dedicated pool), and semantic-model (bind direct). Opens a
 *      Fluent dialog and POSTs the PROVEN, Azure-native
 *      `POST /api/thread/build-loom-report` edge,
 *      which mints a Loom-native semantic-model over Synapse (when needed),
 *      creates a `report` bound to it, records the Weave edge, and returns
 *      `{ ok, link:'/items/report/<id>' }`. No `api.powerbi.com` /
 *      `api.fabric.microsoft.com` is ever touched. On success we navigate to the
 *      pre-bound designer; on an honest gate (503 `{ gate }` — e.g.
 *      LOOM_SYNAPSE_* unset) we surface a Fluent MessageBar and do NOT navigate.
 *
 * Source-mode inputs (loom-no-freeform-config compliant — pickers + one
 * guarded SELECT escape hatch the route validates server-side):
 *   • semantic-model → no input; binds straight to the model. One click.
 *   • warehouse      → a real table <Dropdown> populated from
 *                      GET /api/thread/warehouse-tables (Synapse dedicated pool);
 *                      value = catalog-verified `objectId|schema|name`.
 *   • lakehouse      → a single multiline "SELECT …" field, validated by the
 *                      route's read-only sql-guard and run over Synapse serverless.
 *
 * NOT offered: kql-database and sql-database. build-loom-report's sqlKindFor()
 * only knows lakehouse (serverless) and warehouse (dedicated) and defaults every
 * other fromType to the Synapse DEDICATED pool — which holds neither a
 * kql-database's ADX/Kusto data nor a sql-database's Azure SQL data. Offering
 * "Build report" for those would silently run the SELECT against an unrelated
 * backend. They are withheld until build-loom-report grows a real ADX/Kusto and
 * Azure SQL report-source executor (tracked as task #33).
 *
 * Web-3.0: Fluent v9 + Loom tokens only, an itemVisual-colored build icon, clear
 * labels, designed busy/gate/error states — matches the detail-tile styling.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Field,
  Input,
  Textarea,
  Dropdown,
  Option,
  Spinner,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  Open16Regular,
  ChartMultipleRegular,
} from '@fluentui/react-icons';
import { itemVisual } from '@/lib/components/ui/item-type-visual';

/** The minimal catalog-hit shape these actions need (mirrors FederatedHit). */
export interface CatalogActionHit {
  source: 'purview' | 'unity-catalog' | 'onelake';
  id: string;
  display_name: string;
  /** Raw Loom item-type slug (e.g. lakehouse / warehouse / semantic-model). */
  type: string;
  /** Present on Loom hits (search adds `workspace_id`); not required to act. */
  workspace_id?: string;
  detail_path: string;
}

/**
 * Item types that can source a Loom report (drives the "Build report" action).
 *
 * Limited to the item types whose data build-loom-report can actually query
 * today: lakehouse (Synapse serverless), warehouse (Synapse dedicated pool),
 * and semantic-model (direct bind). kql-database (ADX/Kusto) and sql-database
 * (Azure SQL) are intentionally excluded — the route would default them to the
 * dedicated pool, which does not hold their data. Re-add when build-loom-report
 * has real ADX/Kusto + Azure SQL executors (task #33).
 */
const DATA_SOURCE_TYPES = new Set([
  'lakehouse',
  'warehouse',
  'semantic-model',
]);

/** Types whose report source is a single guarded SELECT (vs. a table picker). */
const QUERY_TYPES = new Set(['lakehouse']);

interface TableOption {
  value: string;
  label: string;
}

interface BuildResult {
  ok: boolean;
  error?: string;
  /** Honest infra-gate payload (e.g. `{ missing: 'LOOM_SYNAPSE_WORKSPACE' }`). */
  gate?: { missing?: string } | null;
}

const useStyles = makeStyles({
  row: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  hint: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
  query: {
    fontFamily: tokens.fontFamilyMonospace,
  },
  loadingRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground3,
  },
  gatePre: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    marginTop: tokens.spacingVerticalXS,
    marginBottom: 0,
    whiteSpace: 'pre-wrap',
  },
});

/**
 * Per-Loom-hit actions. Renders nothing for non-Loom (purview / unity-catalog)
 * hits — those keep their existing "Open in catalog" → detail_path button.
 */
export function CatalogItemActions({ hit }: { hit: CatalogActionHit }) {
  const s = useStyles();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [reportName, setReportName] = useState(`${hit.display_name} report`);
  const [table, setTable] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BuildResult | null>(null);

  // warehouse table picker (real Synapse-dedicated dropdown)
  const [tableOptions, setTableOptions] = useState<TableOption[]>([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [tablesGate, setTablesGate] = useState<{ missing?: string } | null>(null);

  const isQueryType = QUERY_TYPES.has(hit.type);
  const isWarehouse = hit.type === 'warehouse';
  const isModel = hit.type === 'semantic-model';
  const canBuild = DATA_SOURCE_TYPES.has(hit.type);

  // Load the warehouse table list when the dialog opens for a warehouse hit.
  useEffect(() => {
    if (!open || !isWarehouse) return;
    let cancelled = false;
    setTablesLoading(true);
    setTablesError(null);
    setTablesGate(null);
    fetch(`/api/thread/warehouse-tables?fromType=warehouse&fromId=${encodeURIComponent(hit.id)}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.ok) {
          setTableOptions(Array.isArray(j.options) ? j.options : []);
        } else {
          setTablesError(j?.error || 'Could not list warehouse tables.');
          setTablesGate(j?.gate ?? null);
        }
      })
      .catch((e) => {
        if (!cancelled) setTablesError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setTablesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, isWarehouse, hit.id]);

  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (next) {
      // Reset transient state each time the dialog opens.
      setResult(null);
      setReportName(`${hit.display_name} report`);
      setTable('');
      setQuery('');
    }
  }, [hit.display_name]);

  const canSubmit =
    !!reportName.trim() &&
    (isModel || (isWarehouse ? !!table : isQueryType ? !!query.trim() : false));

  const buildReport = useCallback(async () => {
    if (!reportName.trim()) {
      setResult({ ok: false, error: 'Report name is required.' });
      return;
    }
    if (isWarehouse && !table) {
      setResult({ ok: false, error: 'Pick a table to build the report from.' });
      return;
    }
    if (isQueryType && !query.trim()) {
      setResult({ ok: false, error: 'Enter a SELECT query for the report source.' });
      return;
    }

    setBusy(true);
    setResult(null);
    try {
      const values: Record<string, unknown> = { reportName: reportName.trim() };
      if (isModel) {
        values.sourceMode = 'model';
      } else if (isWarehouse) {
        values.sourceMode = 'table';
        values.table = table;
      } else {
        // lakehouse: a guarded SELECT run over the Synapse SERVERLESS endpoint.
        // build-loom-report resolves the serverless target from fromType==='lakehouse'
        // directly; `attachedSource` is only honored for fromType==='notebook', so we
        // do NOT send it here (it would be dead/misleading for a lakehouse source).
        values.sourceMode = 'query';
        values.query = query.trim();
      }

      const r = await fetch('/api/thread/build-loom-report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          from: { id: hit.id, type: hit.type, name: hit.display_name },
          values,
        }),
      });
      const j = await r.json();
      if (j?.ok && j.link) {
        // Pre-bound report — navigate to the real designer (real rows on a visual).
        router.push(j.link);
        return;
      }
      setResult({
        ok: false,
        error: j?.error || 'Could not build the report.',
        gate: j?.gate ?? null,
      });
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [reportName, isWarehouse, isQueryType, isModel, table, query, hit.id, hit.type, hit.display_name, router]);

  // Only Loom (onelake-source) items get these Azure-native actions.
  if (hit.source !== 'onelake') return null;

  const buildVisual = itemVisual('report');

  return (
    <div className={s.row}>
      {/* #2 — Open the real editor for this item (no Fabric catalog 401). */}
      <Button
        appearance="secondary"
        as="a"
        href={`/items/${hit.type}/${hit.id}`}
        icon={<Open16Regular />}
        data-testid="catalog-open-in-workspace"
      >
        Open in workspace
      </Button>

      {/* #1 — Build a pre-bound Loom report (Azure-native, no Power BI/Fabric). */}
      {canBuild && (
        <Button
          appearance="primary"
          icon={<ChartMultipleRegular style={{ color: buildVisual.color }} />}
          onClick={() => onOpenChange(true)}
          data-testid="catalog-build-report"
        >
          Build report in Loom
        </Button>
      )}

      <Dialog open={open} onOpenChange={(_e, d) => onOpenChange(d.open)}>
        <DialogSurface style={{ maxWidth: 560 }}>
          <DialogBody>
            <DialogTitle>Build a report on “{hit.display_name}”</DialogTitle>
            <DialogContent>
              <div className={s.body}>
                <Text className={s.hint}>
                  {isModel
                    ? 'Creates a Loom report bound directly to this semantic model. It opens in the designer pre-wired to real data.'
                    : isWarehouse
                      ? 'Pick a table. Loom mints an Azure-native semantic model over the Synapse dedicated pool and opens a report bound to it.'
                      : 'Enter a read-only SELECT. Loom runs it over the lakehouse (Synapse serverless), introspects the real result schema, mints a semantic model, and opens a pre-bound report.'}
                </Text>

                <Field label="Report name" required>
                  <Input
                    value={reportName}
                    onChange={(_, d) => setReportName(d.value)}
                    placeholder={`${hit.display_name} report`}
                    data-testid="build-report-name"
                  />
                </Field>

                {isWarehouse && (
                  <Field label="Table" required>
                    {tablesLoading ? (
                      <span className={s.loadingRow}>
                        <Spinner size="tiny" /> Loading warehouse tables…
                      </span>
                    ) : tablesError ? (
                      <MessageBar intent={tablesGate ? 'warning' : 'error'}>
                        <MessageBarBody>
                          <MessageBarTitle>
                            {tablesGate ? 'Warehouse not configured' : 'Could not list tables'}
                          </MessageBarTitle>
                          <Text>{tablesError}</Text>
                          {tablesGate?.missing && (
                            <pre className={s.gatePre}>Set: {tablesGate.missing}</pre>
                          )}
                        </MessageBarBody>
                      </MessageBar>
                    ) : (
                      <Dropdown
                        placeholder="Select a table"
                        value={tableOptions.find((o) => o.value === table)?.label ?? ''}
                        selectedOptions={table ? [table] : []}
                        onOptionSelect={(_, d) => setTable(d.optionValue ?? '')}
                        data-testid="build-report-table"
                      >
                        {tableOptions.map((o) => (
                          <Option key={o.value} value={o.value} text={o.label}>
                            {o.label}
                          </Option>
                        ))}
                      </Dropdown>
                    )}
                  </Field>
                )}

                {isQueryType && (
                  <Field
                    label="SQL query (SELECT …)"
                    required
                    hint="Read-only SELECT — validated server-side by the Loom sql-guard."
                  >
                    <Textarea
                      className={s.query}
                      value={query}
                      onChange={(_, d) => setQuery(d.value)}
                      placeholder="SELECT * FROM dbo.my_table"
                      rows={4}
                      data-testid="build-report-query"
                    />
                  </Field>
                )}

                {result && !result.ok && (
                  <MessageBar intent={result.gate ? 'warning' : 'error'}>
                    <MessageBarBody>
                      <MessageBarTitle>
                        {result.gate ? 'Configuration needed' : 'Could not build the report'}
                      </MessageBarTitle>
                      <Text>{result.error}</Text>
                      {result.gate?.missing && (
                        <pre className={s.gatePre}>Set: {result.gate.missing}</pre>
                      )}
                    </MessageBarBody>
                  </MessageBar>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                onClick={buildReport}
                disabled={busy || !canSubmit}
                icon={busy ? <Spinner size="tiny" /> : undefined}
                data-testid="build-report-submit"
              >
                {busy ? 'Building…' : 'Create & open'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
