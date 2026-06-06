'use client';

/**
 * DestinationPicker — the Dataflow Gen2 "Output destination" surface. Mirrors
 * Power Query Online's data-destination dialog: choose where the output query
 * writes. On the Azure-native backend this compiles into an ADF dataset wired
 * as the WranglingDataFlow sink (ADLS Gen2 Parquet/CSV or an Azure SQL table).
 *
 * Real backend: the Azure SQL linked-service list is fetched from
 * /api/adf/linked-services (honest infra-gate when ADF is unconfigured). No
 * fabricated options.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Subtitle2, Caption1, Field, Select, Input, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import type { DataflowSink } from './m-script';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, maxWidth: '560px' },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  grow: { flex: 1, minWidth: '200px' },
});

type DestKind = 'adls-parquet' | 'adls-csv' | 'azuresql';

function sinkToKind(sink: DataflowSink | null): DestKind {
  if (!sink) return 'adls-parquet';
  if (sink.type === 'azuresql') return 'azuresql';
  return sink.format === 'csv' ? 'adls-csv' : 'adls-parquet';
}

export interface DestinationPickerProps {
  sink: DataflowSink | null;
  queries: string[];
  onChange: (sink: DataflowSink) => void;
  readOnly?: boolean;
}

export function DestinationPicker({ sink, queries, onChange, readOnly = false }: DestinationPickerProps) {
  const s = useStyles();
  const kind = sinkToKind(sink);
  const [linkedServices, setLinkedServices] = useState<string[] | null>(null);
  const [lsError, setLsError] = useState<string | null>(null);

  useEffect(() => {
    if (kind !== 'azuresql' || linkedServices !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/adf/linked-services');
        const j = await r.json();
        if (cancelled) return;
        if (!j.ok) { setLsError(j.error || 'failed'); setLinkedServices([]); return; }
        const sqlOnly = (j.linkedServices || [])
          .filter((l: any) => /sql/i.test(l?.properties?.type || ''))
          .map((l: any) => l.name);
        setLinkedServices(sqlOnly);
      } catch (e: any) { if (!cancelled) { setLsError(e?.message || String(e)); setLinkedServices([]); } }
    })();
    return () => { cancelled = true; };
  }, [kind, linkedServices]);

  const patch = useCallback((p: Partial<DataflowSink>) => {
    const base: DataflowSink = sink || { type: 'adls', container: 'silver', format: 'parquet' };
    onChange({ ...base, ...p });
  }, [sink, onChange]);

  const setKind = useCallback((k: DestKind) => {
    if (k === 'azuresql') onChange({ type: 'azuresql', schema: sink?.schema || 'dbo', table: sink?.table || '', writeMode: sink?.writeMode || 'append', linkedService: sink?.linkedService, query: sink?.query });
    else onChange({ type: 'adls', container: sink?.container || 'silver', path: sink?.path, format: k === 'adls-csv' ? 'csv' : 'parquet', query: sink?.query });
  }, [sink, onChange]);

  return (
    <div className={s.root}>
      <Subtitle2>Output destination</Subtitle2>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        Where the selected output query writes when you Run. Compiled into an ADF
        WranglingDataFlow sink — no Fabric required.
      </Caption1>

      <div className={s.row}>
        <Field label="Destination" className={s.grow}>
          <Select value={kind} disabled={readOnly} onChange={(_, d) => setKind(d.value as DestKind)}>
            <option value="adls-parquet">ADLS Gen2 — Parquet</option>
            <option value="adls-csv">ADLS Gen2 — CSV</option>
            <option value="azuresql">Azure SQL Database — table</option>
          </Select>
        </Field>
        <Field label="Output query" className={s.grow}>
          <Select value={sink?.query || ''} disabled={readOnly || queries.length === 0} onChange={(_, d) => patch({ query: d.value || undefined })}>
            <option value="">{queries.length ? 'Last query (default)' : 'No queries'}</option>
            {queries.map((q) => <option key={q} value={q}>{q}</option>)}
          </Select>
        </Field>
      </div>

      {kind !== 'azuresql' ? (
        <div className={s.row}>
          <Field label="Container" className={s.grow}>
            <Select value={sink?.container || 'silver'} disabled={readOnly} onChange={(_, d) => patch({ container: d.value })}>
              <option value="bronze">bronze</option>
              <option value="silver">silver</option>
              <option value="gold">gold</option>
              <option value="landing">landing</option>
            </Select>
          </Field>
          <Field label="Folder path" className={s.grow} hint="e.g. dataflows/sales — leave blank for a default folder.">
            <Input value={sink?.path || ''} disabled={readOnly} placeholder="dataflows/<name>"
              onChange={(_, d) => patch({ path: d.value })} />
          </Field>
        </div>
      ) : (
        <>
          {lsError && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Azure SQL linked services unavailable</MessageBarTitle>
                {lsError} — create a SQL linked service in the Data Factory Manage hub, or use an ADLS destination.
              </MessageBarBody>
            </MessageBar>
          )}
          <div className={s.row}>
            <Field label="SQL linked service" className={s.grow}>
              <Select value={sink?.linkedService || ''} disabled={readOnly || !linkedServices?.length} onChange={(_, d) => patch({ linkedService: d.value || undefined })}>
                <option value="">{linkedServices === null ? 'Loading…' : (linkedServices.length ? 'Select…' : 'No SQL linked services')}</option>
                {(linkedServices || []).map((n) => <option key={n} value={n}>{n}</option>)}
              </Select>
            </Field>
            <Field label="Write mode" className={s.grow}>
              <Select value={sink?.writeMode || 'append'} disabled={readOnly} onChange={(_, d) => patch({ writeMode: d.value as 'append' | 'overwrite' })}>
                <option value="append">Append</option>
                <option value="overwrite">Overwrite</option>
              </Select>
            </Field>
          </div>
          <div className={s.row}>
            <Field label="Schema" className={s.grow}>
              <Input value={sink?.schema || 'dbo'} disabled={readOnly} onChange={(_, d) => patch({ schema: d.value })} />
            </Field>
            <Field label="Table" className={s.grow}>
              <Input value={sink?.table || ''} disabled={readOnly} placeholder="MyTable" onChange={(_, d) => patch({ table: d.value })} />
            </Field>
          </div>
        </>
      )}
    </div>
  );
}
