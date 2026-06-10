'use client';

/**
 * WarehouseAccelerationPanel — the warehouse "Query acceleration" settings tab.
 *
 * Fabric's Warehouse "Performance / Settings" surface exposes query-acceleration
 * knobs (result-set caching, automatic in-memory/disk caching). This panel is
 * the Loom-native parity of that surface over the Azure-native DEFAULT backend
 * (the Synapse Dedicated SQL pool) — no Fabric / Power BI dependency, works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset (no-fabric-dependency.md).
 *
 * The single live control is the **Result-set caching** Switch. It is a REAL
 * backend control (no-vaporware.md):
 *   • current state is read from sys.databases.is_result_set_caching_on via the
 *     wired /api/items/warehouse/[id]/query route (real DMV round-trip), and
 *   • toggling runs `ALTER DATABASE [<db>] SET RESULT_SET_CACHING ON|OFF;`
 *     against the live dedicated pool through that same route.
 *
 * HONEST GATE (the GPU question): a SQL warehouse — whether the Synapse
 * Dedicated SQL pool default or an opt-in Fabric Warehouse backend — has **no
 * GPU acceleration**. GPU/vectorized execution is not a relational-warehouse
 * capability on either backend. The MessageBar states this plainly and points
 * to the result-set-caching toggle (Synapse default) and the automatic
 * in-memory/disk caching of the opt-in Fabric backend as the real acceleration
 * paths, so the toggle is never a dead control dressed up as "GPU on/off".
 */

import { useCallback, useEffect, useState } from 'react';
import {
  MessageBar, MessageBarBody, MessageBarTitle,
  Switch, Spinner, Badge, Button, Caption1, Body1, Link,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Flash20Regular, ArrowSync20Regular } from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';

const useStyles = makeStyles({
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  controlBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  hint: {
    color: tokens.colorNeutralForeground3,
    maxWidth: '720px',
  },
});

interface QueryResp {
  ok: boolean;
  columns?: string[];
  rows?: unknown[][];
  error?: string;
  state?: string;
  warehouse?: string;
}

async function runSql(id: string, sql: string): Promise<QueryResp> {
  const r = await fetch(`/api/items/warehouse/${encodeURIComponent(id)}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  return (await r.json()) as QueryResp;
}

export function WarehouseAccelerationPanel({ id, ready }: { id: string; ready: boolean }) {
  const s = useStyles();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [dbName, setDbName] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ready || !id || id === 'new') return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      // Real DMV — current database-level result-set-caching state.
      const j = await runSql(
        id,
        'SELECT DB_NAME() AS db, CAST(is_result_set_caching_on AS int) AS rsc '
          + 'FROM sys.databases WHERE database_id = DB_ID();',
      );
      if (!j.ok) {
        setError(j.error || 'Could not read acceleration state.');
        setEnabled(null);
        return;
      }
      const row = j.rows?.[0] ?? [];
      const cols = j.columns ?? [];
      const dbIdx = cols.indexOf('db');
      const rscIdx = cols.indexOf('rsc');
      setDbName(dbIdx >= 0 ? String(row[dbIdx] ?? j.warehouse ?? '') : (j.warehouse ?? ''));
      setEnabled(rscIdx >= 0 ? Number(row[rscIdx]) === 1 : false);
    } catch (e: any) {
      setError(e?.message || String(e));
      setEnabled(null);
    } finally {
      setLoading(false);
    }
  }, [id, ready]);

  useEffect(() => { void load(); }, [load]);

  const toggle = useCallback(
    async (next: boolean) => {
      if (!dbName) { setError('Database name unknown — refresh first.'); return; }
      setSaving(true);
      setError(null);
      setNotice(null);
      try {
        // Real backend mutation — ALTER DATABASE on the live dedicated pool.
        const db = dbName.replace(/]/g, ']]');
        const j = await runSql(id, `ALTER DATABASE [${db}] SET RESULT_SET_CACHING ${next ? 'ON' : 'OFF'};`);
        if (!j.ok) {
          setError(j.error || 'Could not change result-set caching.');
          return;
        }
        setEnabled(next);
        setNotice(
          next
            ? 'Result-set caching is ON. Repeated identical queries return from the cached result set, skip concurrency slots, and run dramatically faster.'
            : 'Result-set caching is OFF. Turn it back on for repetitive read workloads; keep it off for large (>1 GB) result sets to avoid control-node throttling.',
        );
      } catch (e: any) {
        setError(e?.message || String(e));
      } finally {
        setSaving(false);
      }
    },
    [id, dbName],
  );

  return (
    <div style={{ padding: tokens.spacingVerticalM }}>
      {/*
        HONEST GATE — the GPU question. A relational SQL warehouse (Synapse
        Dedicated SQL pool default, or the opt-in Fabric Warehouse backend) has
        no GPU acceleration. State that plainly and point to the real
        acceleration paths instead of shipping a dead "GPU" switch.
      */}
      <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalL }}>
        <MessageBarBody>
          <MessageBarTitle>About GPU-accelerated querying</MessageBarTitle>
          The Azure-native default backend for this warehouse is the{' '}
          <strong>Synapse Dedicated SQL pool</strong>, which does <strong>not</strong> offer
          GPU acceleration — GPU/vectorized execution is not a relational-warehouse
          capability. The pool accelerates queries through <strong>result-set caching</strong>{' '}
          (toggle below) and automatic statistics. The opt-in{' '}
          <strong>Fabric Warehouse backend</strong>{' '}
          (<code>LOOM_WAREHOUSE_BACKEND=fabric</code> + a bound workspace) adds automatic,
          transparent in-memory/SSD columnar caching, but it too has no GPU knob. For
          GPU-accelerated analytics, use a Spark / Databricks GPU pool or Azure Data
          Explorer instead. {' '}
          <Link href="https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/performance-tuning-result-set-caching" target="_blank">
            Result-set caching docs
          </Link>
        </MessageBarBody>
      </MessageBar>

      <Section
        title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Flash20Regular /> Query acceleration</span>}
        actions={
          <Button
            appearance="subtle"
            icon={<ArrowSync20Regular />}
            onClick={() => void load()}
            disabled={!ready || loading || saving}
          >
            Refresh
          </Button>
        }
      >
        {!ready && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Warehouse compute is offline</MessageBarTitle>
              Resume the backing Synapse Dedicated SQL pool to read or change acceleration
              settings. The result-set-caching state lives on the live database.
            </MessageBarBody>
          </MessageBar>
        )}

        {ready && (
          <div className={s.controlBlock}>
            <div className={s.row}>
              {loading ? (
                <Spinner size="tiny" labelPosition="after" label="Reading acceleration state…" />
              ) : (
                <Switch
                  checked={enabled === true}
                  disabled={saving || enabled === null}
                  onChange={(_, d) => void toggle(d.checked)}
                  label={
                    saving
                      ? 'Applying…'
                      : `Result-set caching (database-level query acceleration)${enabled == null ? '' : enabled ? ' — ON' : ' — OFF'}`
                  }
                />
              )}
              {dbName && <Badge appearance="outline">{dbName}</Badge>}
              {enabled === true && <Badge appearance="filled" color="success">Accelerated</Badge>}
            </div>
            <Caption1 className={s.hint}>
              When ON, the dedicated pool caches each query's result set in the user database
              (up to 1 TB, evicted after 48 h idle or on data change) and serves repeated
              identical queries directly from cache — bypassing concurrency slots. This runs a
              real <code>ALTER DATABASE … SET RESULT_SET_CACHING</code> against the live pool.
            </Caption1>
          </div>
        )}

        {error && (
          <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}>
            <MessageBarBody><MessageBarTitle>Acceleration change failed</MessageBarTitle>{error}</MessageBarBody>
          </MessageBar>
        )}
        {notice && !error && (
          <MessageBar intent="success" style={{ marginTop: tokens.spacingVerticalM }}>
            <MessageBarBody><Body1>{notice}</Body1></MessageBarBody>
          </MessageBar>
        )}
      </Section>
    </div>
  );
}

export default WarehouseAccelerationPanel;
