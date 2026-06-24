'use client';

/**
 * DataFlowPicker — reusable select-existing picker that binds a published
 * MAPPING DATA FLOW to a pipeline's ExecuteDataFlow activity
 * (`typeProperties.dataflow.referenceName`). It is the data-flow analogue of
 * the dataset-wizard's self-fetching DatasetPicker: it owns its own real fetch
 * (`GET /api/adf/dataflows` or `/api/synapse/dataflows`) so a caller can drop a
 * single <DataFlowPicker/> wherever a `DataFlowReference` is needed.
 *
 * No mocks: the list is the live factory's mapping data flows. When the
 * factory/workspace isn't configured the route returns a 503 `not_configured`
 * gate, which we surface as an honest Fluent warning MessageBar while keeping
 * the (disabled) dropdown visible so the surface never goes blank.
 *
 * Ref: https://learn.microsoft.com/azure/data-factory/control-flow-execute-data-flow-activity
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Field, Dropdown, Option, Caption1, Badge, Button, Spinner, Tooltip,
  MessageBar, MessageBarBody, makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowClockwise16Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';

/** ADF (default Data Factory) vs Synapse workspace dev plane. */
export type DataFlowProvider = 'adf' | 'synapse';

const useStyles = makeStyles({
  row: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'flex-end' },
  grow: { flex: 1, minWidth: 0 },
  meta: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center', marginTop: tokens.spacingVerticalXXS, flexWrap: 'wrap' },
});

interface DataFlowLite { name: string; type?: string; }

function dataflowsRoute(provider: DataFlowProvider): string {
  return provider === 'synapse' ? '/api/synapse/dataflows' : '/api/adf/dataflows';
}

export interface DataFlowPickerProps {
  label: string;
  /** Currently-bound data flow name ('' when none). */
  value: string;
  onChange: (dataFlowName: string, dataFlow?: DataFlowLite) => void;
  provider?: DataFlowProvider;
  required?: boolean;
  hint?: string;
}

export function DataFlowPicker({
  label, value, onChange, provider = 'adf', required, hint,
}: DataFlowPickerProps) {
  const s = useStyles();
  const route = dataflowsRoute(provider);
  const [dataflows, setDataflows] = useState<DataFlowLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [gateError, setGateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setGateError(null);
    try {
      const r = await clientFetch(route, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 && j?.code === 'not_configured') {
        setGateError(String(j.error || 'Not configured.'));
        return;
      }
      if (!r.ok || !j?.ok) { setGateError(String(j?.error || `HTTP ${r.status}`)); return; }
      const list: DataFlowLite[] = Array.isArray(j.dataflows)
        ? j.dataflows.map((d: any) => ({
            name: d.name,
            type: d.type ?? d.properties?.type,
          }))
        : [];
      // Only mapping data flows are valid targets for ExecuteDataFlow — filter
      // out WranglingDataFlow (Power Query) and Flowlets, which run via their
      // own activity types.
      setDataflows(list.filter((d) => !d.type || d.type === 'MappingDataFlow'));
    } catch (e: any) {
      setGateError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [route]);

  useEffect(() => { load(); }, [load]);

  const selected = dataflows.find((d) => d.name === value);
  const hasData = dataflows.length > 0;

  return (
    <Field label={label} required={required} hint={hint}>
      {gateError && (
        <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalXS }}>
          <MessageBarBody>{gateError}</MessageBarBody>
        </MessageBar>
      )}
      <div className={s.row}>
        <div className={s.grow}>
          <Dropdown
            aria-label={label}
            placeholder={loading ? 'Loading data flows…' : hasData ? 'Select a mapping data flow' : 'No mapping data flows'}
            value={value || ''}
            selectedOptions={value ? [value] : []}
            disabled={!!gateError || loading || !hasData}
            onOptionSelect={(_, d) => {
              const name = d.optionValue || '';
              onChange(name, dataflows.find((x) => x.name === name));
            }}
          >
            <Option value="" text="(none)">(none)</Option>
            {dataflows.map((d) => (
              <Option key={d.name} value={d.name} text={d.name}>{d.name}</Option>
            ))}
          </Dropdown>
        </div>
        <Tooltip content="Refresh data flows" relationship="label">
          <Button
            appearance="subtle"
            aria-label="Refresh data flows"
            icon={loading ? <Spinner size="tiny" /> : <ArrowClockwise16Regular />}
            disabled={!!gateError || loading}
            onClick={load}
          />
        </Tooltip>
      </div>
      {selected && (
        <div className={s.meta}>
          <Badge appearance="tint" color="brand" size="small">{selected.type || 'MappingDataFlow'}</Badge>
        </div>
      )}
      {!hasData && !gateError && !loading && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalXXS }}>
          No mapping data flows found — create one from the <strong>Mapping data flow</strong> item type.
        </Caption1>
      )}
    </Field>
  );
}

export default DataFlowPicker;
