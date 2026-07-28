'use client';

/**
 * DashboardParameterBar — the KQL dashboard's parameter/filter bar, extracted
 * from kql-dashboard-editor.tsx per the U8 decomposition convention (the
 * editor keeps the state; this is pure presentation + callbacks, so the
 * per-type rendering — free-text / fixed / multi / query / datasource /
 * duration — can be reasoned about and tested on its own).
 *
 * Parity: the Fabric Real-Time Dashboard filter bar
 * (https://learn.microsoft.com/fabric/real-time-intelligence/dashboard-parameters):
 * each dashboard parameter renders a typed control at the top of the canvas;
 * changing one re-runs the tiles whose KQL references it (cross-filter), and
 * a `duration` parameter drives the global `_startTime`/`_endTime` range so
 * it re-runs every tile. All execution is the REAL ADX path — the callbacks
 * land in the editor's runTile/runAll which POST /api/items/kql-dashboard/
 * [id]/run (kusto-client). Azure-native; no Fabric on the path.
 */

import { Button, Caption1, Input, Select, tokens } from '@fluentui/react-components';
import { Play20Regular } from '@fluentui/react-icons';

export type DashParamType = 'freetext' | 'fixed' | 'multi' | 'query' | 'datasource' | 'duration';
export type DashParamDataType = 'string' | 'long' | 'int' | 'real' | 'datetime' | 'bool';

export interface DashParam {
  variableName: string;
  label?: string;
  type: DashParamType;
  dataType?: DashParamDataType;
  values?: string[];
  query?: string;
  dataSourceId?: string;
  value?: string | string[];
}

export interface DashDataSource { id: string; name: string; database: string; clusterUri?: string; }

export type TimeRangeKey = 'last-15m' | 'last-1h' | 'last-4h' | 'last-24h' | 'last-7d' | 'last-30d' | 'all';
export const TIME_ORDER: TimeRangeKey[] = ['last-15m', 'last-1h', 'last-4h', 'last-24h', 'last-7d', 'last-30d', 'all'];

export function DashboardParameterBar({
  params, dataSources, timeRange, paramValueCache, running,
  onUpdateParam, onRunDependents, onRunAll, onLoadParamValues, onTimeRangeChange,
}: {
  params: DashParam[];
  dataSources: DashDataSource[];
  timeRange: TimeRangeKey;
  /** Query-based param dropdown values, keyed by variableName. */
  paramValueCache: Record<string, string[]>;
  running: boolean;
  onUpdateParam: (idx: number, patch: Partial<DashParam>) => void;
  /** Re-run only the tiles whose KQL references this variable. */
  onRunDependents: (variableName: string) => void;
  onRunAll: () => void;
  onLoadParamValues: (p: DashParam) => void;
  onTimeRangeChange: (key: TimeRangeKey) => void;
}) {
  if (params.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: tokens.spacingVerticalM, flexWrap: 'wrap', alignItems: 'flex-end', padding: `${tokens.spacingVerticalXS} 0` }}>
      {params.map((p, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 160 }}>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{p.label || p.variableName}</Caption1>
          {p.type === 'fixed' || p.type === 'datasource' ? (
            <Select value={(p.value as string) || ''}
              onChange={(_: unknown, d: any) => { onUpdateParam(i, { value: d.value }); setTimeout(() => onRunDependents(p.variableName), 0); }}>
              <option value="">(all)</option>
              {(p.type === 'datasource' ? dataSources.map((d) => d.name) : (p.values || [])).map((v) => <option key={v} value={v}>{v}</option>)}
            </Select>
          ) : p.type === 'query' ? (
            <Select value={(p.value as string) || ''}
              onFocus={() => { if (!paramValueCache[p.variableName]) onLoadParamValues(p); }}
              onChange={(_: unknown, d: any) => { onUpdateParam(i, { value: d.value }); setTimeout(() => onRunDependents(p.variableName), 0); }}>
              <option value="">(all)</option>
              {(paramValueCache[p.variableName] || []).map((v) => <option key={v} value={v}>{v}</option>)}
            </Select>
          ) : p.type === 'duration' ? (
            // Time-range picker — matches the Fabric "Duration" param type.
            // Changing it sets the global time range (which drives the
            // synthetic _startTime/_endTime tokens) and re-runs every tile.
            <Select value={(p.value as string) || timeRange}
              onChange={(_: unknown, d: any) => {
                onUpdateParam(i, { value: d.value });
                if (TIME_ORDER.includes(d.value as TimeRangeKey)) onTimeRangeChange(d.value as TimeRangeKey);
                setTimeout(() => onRunAll(), 0);
              }}>
              {TIME_ORDER.map((k) => <option key={k} value={k}>{k}</option>)}
            </Select>
          ) : p.type === 'multi' ? (
            p.values && p.values.length > 0 ? (
              // Fixed-value multi-select — native <select multiple> backed
              // by the param's allowed values list.
              <select
                multiple
                size={Math.min(p.values.length, 5)}
                value={Array.isArray(p.value) ? (p.value as string[]) : []}
                onChange={(e) => onUpdateParam(i, { value: Array.from(e.target.selectedOptions).map((o) => o.value) })}
                onBlur={() => onRunDependents(p.variableName)}
                aria-label={p.label || p.variableName}
                style={{ minWidth: 160, padding: tokens.spacingVerticalXS, border: `1px solid ${tokens.colorNeutralStroke1}`, borderRadius: tokens.borderRadiusMedium, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}>
                {p.values.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            ) : (
              <Input placeholder="comma,separated,values"
                value={Array.isArray(p.value) ? p.value.join(',') : ''}
                onChange={(_: unknown, d: any) => onUpdateParam(i, { value: d.value.split(',').map((x: string) => x.trim()).filter(Boolean) })}
                onBlur={() => onRunDependents(p.variableName)} />
            )
          ) : (
            <Input value={Array.isArray(p.value) ? '' : (p.value || '')}
              onChange={(_: unknown, d: any) => onUpdateParam(i, { value: d.value })}
              onBlur={() => onRunDependents(p.variableName)} />
          )}
        </div>
      ))}
      <Button size="small" appearance="primary" icon={<Play20Regular />} onClick={onRunAll} disabled={running}>Apply</Button>
    </div>
  );
}
