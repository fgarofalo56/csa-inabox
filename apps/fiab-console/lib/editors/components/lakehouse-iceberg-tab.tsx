'use client';

/**
 * LakehouseIcebergTab — "Expose as Iceberg" (OneLake Iceberg V2 interop).
 *
 * Parity with Fabric OneLake's Delta↔Iceberg metadata virtualization
 * (https://learn.microsoft.com/fabric/onelake/onelake-iceberg-tables). The
 * Azure-native default backs this with Delta UniForm (Iceberg V2 metadata
 * written alongside the Delta log on the SAME ADLS Gen2 files), enabled per
 * Delta table via a real ALTER TABLE … SET TBLPROPERTIES on a Databricks SQL
 * Warehouse. Iceberg readers (Snowflake, Trino, Spark, Athena) then read the
 * Delta tables directly — no copy, no real Fabric / OneLake dependency.
 *
 * Surface (one-for-one with the Fabric capability):
 *   - master "Expose this lakehouse as Iceberg" Switch (the toggle the task asks for)
 *   - per-Delta-table Checkbox list (which tables to virtualize)
 *   - the ADLS Gen2 path (https + abfss) of the lakehouse Tables/ root
 *   - the Iceberg REST Catalog URL (Databricks Unity Catalog endpoint) +
 *     copy-able external-volume snippet for Snowflake
 *   - per-table conversion status (has metadata/*.metadata.json been produced?)
 *   - honest infra-gate MessageBars naming the exact env var when Databricks /
 *     storage isn't configured. The toggle + selection still persist.
 *
 * Every control calls the real BFF (/api/lakehouse/iceberg + /api/lakehouse/tables).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Badge, Body1, Button, Caption1, Spinner, Subtitle2, Switch, Checkbox, Field, Link,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, Save20Regular, Copy20Regular, CheckmarkCircle20Filled,
  Clock20Regular, Layer20Regular, Open20Regular, ArrowSortUp16Regular, ArrowSortDown16Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: 14, padding: 4, minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 8, padding: 14,
    display: 'flex', flexDirection: 'column', gap: 10, backgroundColor: tokens.colorNeutralBackground1,
  },
  pathRow: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  mono: {
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 12,
    backgroundColor: tokens.colorNeutralBackground3, padding: '4px 8px', borderRadius: 4,
    overflow: 'auto', maxWidth: '100%', whiteSpace: 'nowrap',
  },
  pickList: {
    maxHeight: 220, overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 6, padding: 8, display: 'flex', flexDirection: 'column', gap: 4,
  },
  pickRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    padding: '2px 4px', borderRadius: 4,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  spacer: { flex: 1 },
  redText: { color: tokens.colorPaletteRedForeground1 },
  snippet: { whiteSpace: 'pre', flex: 1, margin: 0 },
  snippetRow: { display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' },
  sortHeader: {
    cursor: 'pointer', userSelect: 'none', display: 'inline-flex', alignItems: 'center', gap: 4,
  },
  hint: { display: 'flex', alignItems: 'center', gap: 6, color: tokens.colorNeutralForeground3 },
});

type SortDir = 'asc' | 'desc';

interface IcebergStatus {
  ok: boolean;
  container: string;
  enabled: boolean;
  tables: string[];
  tableStatus?: { table: string; converted: boolean; latestMetadata?: string }[];
  adlsTablesRoot?: string;
  adlsAbfssRoot?: string;
  account?: string;
  catalogUrl?: string;
  icebergVersion?: string;
  databricksConfigured?: boolean;
  storageGate?: string;
  updatedAt?: string;
  updatedBy?: string;
  error?: string;
}

interface SaveResult {
  ok: boolean;
  enabled?: boolean;
  appliedCount?: number;
  results?: { table: string; applied: boolean; sql?: string; error?: string }[];
  gate?: string;
  catalogUrl?: string;
  adlsAbfssRoot?: string;
  error?: string;
}

/** A Delta table discovered under the container's Tables/ folder. */
interface ScannedTable { name: string; container?: string }

async function jsonOrThrow<T>(r: Response): Promise<T> {
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = (await r.text()).slice(0, 200);
    throw new Error(`HTTP ${r.status}: ${text}`);
  }
  return (await r.json()) as T;
}

export function LakehouseIcebergTab({ container }: { container: string }) {
  const s = useStyles();

  // Current Iceberg status (toggle, selected tables, ADLS path, catalog URL).
  const statusQ = useQuery<IcebergStatus>({
    queryKey: ['lakehouse', 'iceberg', container],
    queryFn: () =>
      fetch(`/api/lakehouse/iceberg?container=${encodeURIComponent(container)}`).then(jsonOrThrow<IcebergStatus>),
    enabled: !!container,
  });

  // Delta tables available in this container (for the selection list).
  const tablesQ = useQuery<{ ok: boolean; tables: ScannedTable[]; gate?: string }>({
    queryKey: ['lakehouse', 'iceberg-tables', container],
    queryFn: () =>
      fetch(`/api/lakehouse/tables?containers=${encodeURIComponent(container)}`).then(
        jsonOrThrow<{ ok: boolean; tables: ScannedTable[]; gate?: string }>,
      ),
    enabled: !!container,
  });

  const [enabled, setEnabled] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveResult | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [sortCol, setSortCol] = useState<'table' | 'converted'>('table');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // Hydrate local form state from the server status once it loads.
  useEffect(() => {
    if (statusQ.data?.ok) {
      setEnabled(!!statusQ.data.enabled);
      setSelected(new Set(statusQ.data.tables || []));
    }
  }, [statusQ.data]);

  const toggleTable = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const copy = useCallback((label: string, text: string) => {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(label);
        setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500);
      },
      () => {},
    );
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSaveResult(null);
    try {
      const r = await fetch('/api/lakehouse/iceberg', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ container, enabled, tables: Array.from(selected) }),
      });
      const data = await jsonOrThrow<SaveResult>(r);
      if (!data.ok) {
        setSaveError(data.error || 'Save failed');
      } else {
        setSaveResult(data);
        statusQ.refetch();
      }
    } catch (e: any) {
      setSaveError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [container, enabled, selected, statusQ]);

  const onSort = useCallback((col: 'table' | 'converted') => {
    setSortCol((prevCol) => {
      if (prevCol === col) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prevCol;
      }
      setSortDir('asc');
      return col;
    });
  }, []);

  const st = statusQ.data;
  const tables = tablesQ.data?.tables || [];
  const tablesGate = tablesQ.data?.gate;
  const convertedMap = new Map((st?.tableStatus || []).map((t) => [t.table, t]));

  const sortedStatus = useMemo(() => {
    const rows = [...(st?.tableStatus || [])];
    const dir = sortDir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      if (sortCol === 'converted') {
        const av = a.converted ? 1 : 0;
        const bv = b.converted ? 1 : 0;
        if (av !== bv) return (av - bv) * dir;
      }
      return a.table.localeCompare(b.table) * dir;
    });
    return rows;
  }, [st?.tableStatus, sortCol, sortDir]);

  const snowflakeSnippet =
    st?.adlsTablesRoot
      ? `-- Snowflake: read the virtualized Iceberg table from this lakehouse\nCREATE OR REPLACE EXTERNAL VOLUME loom_iceberg_exvol\n  STORAGE_LOCATIONS = (\n    ( NAME = 'loom_iceberg_exvol'\n      STORAGE_PROVIDER = 'AZURE'\n      STORAGE_BASE_URL = '${st.adlsTablesRoot.replace(/^https:\/\//i, 'azure://')}/'\n      AZURE_TENANT_ID = '<your-tenant-id>' ) )\n  ALLOW_WRITES = false;`
      : '';

  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        <Layer20Regular />
        <Subtitle2>Expose as Iceberg</Subtitle2>
        <Badge appearance="tint" color="brand">Iceberg {st?.icebergVersion?.toUpperCase() || 'V2'}</Badge>
        <Badge appearance="outline" color="informative">Preview</Badge>
        <div className={s.spacer} />
        <Tooltip content="Re-scan Delta tables and refresh conversion status" relationship="label">
          <Button
            icon={<ArrowSync20Regular />}
            appearance="subtle"
            disabled={statusQ.isFetching || tablesQ.isFetching}
            onClick={() => { statusQ.refetch(); tablesQ.refetch(); }}
          >
            {statusQ.isFetching || tablesQ.isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        </Tooltip>
      </div>

      <Body1>
        Make this lakehouse&apos;s Delta tables readable by Apache Iceberg clients (Snowflake,
        Trino, Spark, Athena). Loom enables{' '}
        <Link href="https://learn.microsoft.com/azure/databricks/delta/uniform" target="_blank">
          Delta UniForm
        </Link>{' '}
        so Iceberg V2 metadata is written alongside the Delta log on the same ADLS Gen2 files — no
        copy, no real Fabric / OneLake dependency. This is the Azure-native parity for{' '}
        <Link href="https://learn.microsoft.com/fabric/onelake/onelake-iceberg-tables" target="_blank">
          Fabric OneLake&apos;s Delta↔Iceberg virtualization
        </Link>.
      </Body1>

      {statusQ.isLoading && <Spinner label="Loading Iceberg status…" />}
      {statusQ.error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load Iceberg status</MessageBarTitle>
            {String((statusQ.error as any)?.message || statusQ.error)}
          </MessageBarBody>
        </MessageBar>
      )}

      {st?.storageGate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Lakehouse storage not configured</MessageBarTitle>
            {st.storageGate}
          </MessageBarBody>
        </MessageBar>
      )}

      {st && !st.databricksConfigured && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Databricks SQL Warehouse not configured</MessageBarTitle>
            Enabling Iceberg runs a real{' '}
            <code>ALTER TABLE … SET TBLPROPERTIES (delta.universalFormat.enabledFormats=&apos;iceberg&apos;)</code>{' '}
            via a Databricks SQL Warehouse. Set <code>LOOM_DATABRICKS_HOSTNAME</code> (and optionally{' '}
            <code>LOOM_DATABRICKS_SQL_WAREHOUSE_ID</code>) in the admin-plane env vars to enable
            conversion. Your selection still saves and applies on the next save once it&apos;s configured.
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Master toggle + save */}
      {st && (
        <div className={s.card}>
          <Switch
            checked={enabled}
            onChange={(_, d) => setEnabled(!!d.checked)}
            label={enabled ? 'Iceberg exposure enabled' : 'Expose this lakehouse as Iceberg'}
          />
          <Caption1>
            When enabled, the selected Delta tables emit Iceberg V2 metadata so Iceberg readers can
            query them in place.
          </Caption1>
          <div className={s.toolbar}>
            <Button
              appearance="primary"
              icon={<Save20Regular />}
              disabled={saving || (enabled && selected.size === 0)}
              onClick={save}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
            {st.updatedAt && (
              <Caption1>
                Last saved {new Date(st.updatedAt).toLocaleString()}
                {st.updatedBy ? ` by ${st.updatedBy}` : ''}
              </Caption1>
            )}
          </div>
          {enabled && selected.size === 0 && (
            <Caption1 className={s.redText}>
              Select at least one Delta table to expose.
            </Caption1>
          )}
        </div>
      )}

      {saveError && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Save failed</MessageBarTitle>
            {saveError}
          </MessageBarBody>
        </MessageBar>
      )}

      {saveResult && (
        <MessageBar intent={saveResult.gate ? 'warning' : 'success'}>
          <MessageBarBody>
            <MessageBarTitle>
              {saveResult.gate
                ? 'Saved — conversion pending infra'
                : `Saved — ${saveResult.appliedCount || 0} table(s) converted`}
            </MessageBarTitle>
            {saveResult.gate ||
              'Delta UniForm enabled. Iceberg metadata is generated on the next write to each table.'}
            {(saveResult.results || [])
              .filter((r) => r.error)
              .map((r) => (
                <div key={r.table}>
                  <code>{r.table}</code>: {r.error}
                </div>
              ))}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Delta table selection */}
      {st && (
        <div className={s.card}>
          <Field label="Delta tables to expose as Iceberg">
            {tablesQ.isLoading && <Spinner size="tiny" label="Scanning Delta tables…" />}
            {tablesGate && (
              <MessageBar intent="warning">
                <MessageBarBody>{tablesGate}</MessageBarBody>
              </MessageBar>
            )}
            {!tablesQ.isLoading && tables.length === 0 && !tablesGate && (
              <Caption1>No Delta tables found under {container}/Tables/ yet.</Caption1>
            )}
            {tables.length > 0 && (
              <div className={s.pickList}>
                {tables.map((t) => {
                  const conv = convertedMap.get(t.name);
                  return (
                    <div key={t.name} className={s.pickRow}>
                      <Checkbox
                        checked={selected.has(t.name)}
                        onChange={() => toggleTable(t.name)}
                        label={t.name}
                      />
                      {conv?.converted ? (
                        <Badge appearance="tint" color="success" icon={<CheckmarkCircle20Filled />}>
                          Iceberg metadata present
                        </Badge>
                      ) : selected.has(t.name) && st.enabled ? (
                        <Badge appearance="tint" color="warning" icon={<Clock20Regular />}>
                          Pending first write
                        </Badge>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </Field>
        </div>
      )}

      {/* ADLS path + catalog URL */}
      {st?.adlsTablesRoot && (
        <div className={s.card}>
          <Subtitle2>Iceberg endpoints</Subtitle2>
          <Field label="ADLS Gen2 path (Tables root)">
            <div className={s.pathRow}>
              <span className={s.mono}>{st.adlsTablesRoot}</span>
              <Button
                size="small"
                appearance="subtle"
                icon={<Copy20Regular />}
                onClick={() => copy('https', st.adlsTablesRoot!)}
              >
                {copied === 'https' ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </Field>
          {st.adlsAbfssRoot && (
            <Field label="abfss path">
              <div className={s.pathRow}>
                <span className={s.mono}>{st.adlsAbfssRoot}</span>
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<Copy20Regular />}
                  onClick={() => copy('abfss', st.adlsAbfssRoot!)}
                >
                  {copied === 'abfss' ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </Field>
          )}
          {st.catalogUrl ? (
            <Field label="Iceberg REST Catalog URL (Unity Catalog)">
              <div className={s.pathRow}>
                <span className={s.mono}>{st.catalogUrl}</span>
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<Copy20Regular />}
                  onClick={() => copy('catalog', st.catalogUrl!)}
                >
                  {copied === 'catalog' ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </Field>
          ) : (
            <Caption1>
              No Iceberg REST Catalog endpoint (Databricks Unity Catalog) is configured — Iceberg
              readers can still point directly at each table&apos;s{' '}
              <code>metadata/*.metadata.json</code> on the ADLS path above.
            </Caption1>
          )}
          {snowflakeSnippet && (
            <Field label="Snowflake external volume (read virtualized Iceberg)">
              <div className={s.snippetRow}>
                <pre className={`${s.mono} ${s.snippet}`}>{snowflakeSnippet}</pre>
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<Copy20Regular />}
                  onClick={() => copy('snowflake', snowflakeSnippet)}
                >
                  {copied === 'snowflake' ? 'Copied' : 'Copy snippet'}
                </Button>
              </div>
            </Field>
          )}
        </div>
      )}

      {/* Per-table conversion status table */}
      {st && (st.tableStatus?.length || 0) > 0 && (
        <div className={s.card}>
          <Subtitle2>Conversion status</Subtitle2>
          <Table size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell
                  className={s.sortHeader}
                  tabIndex={0}
                  aria-sort={sortCol === 'table' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  onClick={() => onSort('table')}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort('table'); } }}
                >
                  Table
                  {sortCol === 'table' && (sortDir === 'asc' ? <ArrowSortUp16Regular /> : <ArrowSortDown16Regular />)}
                </TableHeaderCell>
                <TableHeaderCell
                  className={s.sortHeader}
                  tabIndex={0}
                  aria-sort={sortCol === 'converted' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  onClick={() => onSort('converted')}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort('converted'); } }}
                >
                  Iceberg metadata
                  {sortCol === 'converted' && (sortDir === 'asc' ? <ArrowSortUp16Regular /> : <ArrowSortDown16Regular />)}
                </TableHeaderCell>
                <TableHeaderCell>Latest metadata file</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedStatus.map((t) => (
                <TableRow key={t.table}>
                  <TableCell>{t.table}</TableCell>
                  <TableCell>
                    {t.converted ? (
                      <Badge appearance="tint" color="success" icon={<CheckmarkCircle20Filled />}>
                        Present
                      </Badge>
                    ) : (
                      <Badge appearance="tint" color="warning" icon={<Clock20Regular />}>
                        Not yet
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {t.latestMetadata ? (
                      <span className={s.mono}>{t.latestMetadata}</span>
                    ) : (
                      <Caption1>—</Caption1>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Caption1 className={s.hint}>
            <Open20Regular /> Iceberg metadata is written on the next commit to each table after
            UniForm is enabled. Run an INSERT/MERGE/OPTIMIZE to trigger the first conversion.
          </Caption1>
        </div>
      )}
    </div>
  );
}
