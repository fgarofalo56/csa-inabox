'use client';

/**
 * QueryParamsBar — parity with the Databricks SQL editor / Synapse parameter
 * widgets. Auto-detects `{{name}}` tokens in the SQL the user is editing and
 * renders one input widget per distinct parameter. The values flow back to the
 * editor's `run()` callback, which transmits them to the backend OUT OF BAND
 * (Databricks `parameters[]` array / mssql `req.input()`), never spliced into
 * the SQL string — the canonical SQL-injection-safe parameterization.
 *
 * Detection token: `{{name}}` (double-brace), which the editor rewrites to the
 * engine-native marker just before execution:
 *   - Databricks  → `:name`  (named parameter marker, Statement Execution API)
 *   - Synapse TDS → `@name`  (sp_executesql / req.input bind variable)
 *
 * Both rewrites substitute only the fixed placeholder TOKEN (`:name` / `@name`),
 * NOT the user-supplied value, so there is no string concatenation of values.
 */

import { useMemo, useState, useEffect, useCallback } from 'react';
import {
  Field, Input, Caption1, Dropdown, Option, Badge, Tooltip, Button,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Info16Regular } from '@fluentui/react-icons';
import {
  extractParams, QUERY_PARAM_TYPES,
  type QueryParam, type QueryParamType,
} from './query-params-utils';

// Re-export the pure helpers/types so existing importers of './query-params'
// keep working unchanged. The substitution helpers and detection regex live in
// query-params-utils.ts (Fluent-free) so they can be unit-tested on node.
export {
  extractParams, substituteDbx, substituteSynapse, QUERY_PARAM_TYPES,
} from './query-params-utils';
export type { QueryParam, QueryParamType } from './query-params-utils';

const useStyles = makeStyles({
  wrap: {
    display: 'flex',
    gap: tokens.spacingVerticalS,
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, alignSelf: 'center' },
  field: { minWidth: '140px' },
  typePicker: { minWidth: '110px' },
});

interface Props {
  /** Current SQL text — params are re-derived whenever this changes. */
  sql: string;
  /** Called with the full ordered param list whenever names or values change. */
  onChange: (params: QueryParam[]) => void;
  /** Optional: hide the per-param type picker (Synapse binds NVARCHAR always). */
  showTypePicker?: boolean;
}

/**
 * Renders a parameter widget bar above the SQL editor. Returns null (renders
 * nothing) when the SQL contains no `{{name}}` tokens, so editors with no
 * parameters are unaffected.
 */
export function QueryParamsBar({ sql, onChange, showTypePicker = true }: Props) {
  const s = useStyles();
  const names = useMemo(() => extractParams(sql), [sql]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [types, setTypes] = useState<Record<string, QueryParamType>>({});

  // Stable callback so the propagate effect doesn't re-fire on every render.
  const propagate = useCallback(
    (vals: Record<string, string>, tys: Record<string, QueryParamType>) => {
      onChange(
        names.map((n) => ({ name: n, value: vals[n] ?? '', type: tys[n] ?? 'STRING' })),
      );
    },
    [names, onChange],
  );

  // Propagate whenever the parameter set or any value/type changes.
  useEffect(() => {
    propagate(values, types);
  }, [propagate, values, types]);

  if (names.length === 0) return null;

  return (
    <div className={s.wrap} role="group" aria-label="Query parameters">
      <div className={s.head}>
        <Badge appearance="tint" color="brand">Parameters</Badge>
        <Tooltip
          content="Values are bound as typed parameters (Databricks :name / Synapse @name) — never concatenated into SQL, so they are injection-safe."
          relationship="label"
        >
          <Button appearance="transparent" size="small" icon={<Info16Regular />} aria-label="About parameters" />
        </Tooltip>
      </div>
      {names.map((n) => (
        <div key={n} style={{ display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'flex-end' }}>
          <Field label={n} className={s.field}>
            <Input
              size="small"
              value={values[n] ?? ''}
              placeholder={`value for ${n}`}
              aria-label={`Parameter ${n}`}
              onChange={(_, d) => setValues((prev) => ({ ...prev, [n]: d.value }))}
            />
          </Field>
          {showTypePicker && (
            <Field label="Type" className={s.typePicker}>
              <Dropdown
                size="small"
                value={types[n] ?? 'STRING'}
                selectedOptions={[types[n] ?? 'STRING']}
                aria-label={`Type for ${n}`}
                onOptionSelect={(_, d) =>
                  setTypes((prev) => ({ ...prev, [n]: (d.optionValue as QueryParamType) || 'STRING' }))
                }
              >
                {QUERY_PARAM_TYPES.map((t) => (
                  <Option key={t} value={t}>{t}</Option>
                ))}
              </Dropdown>
            </Field>
          )}
        </div>
      ))}
      <Caption1 style={{ color: tokens.colorNeutralForeground3, alignSelf: 'center' }}>
        {names.length} parameter{names.length === 1 ? '' : 's'} · use <code>{'{{name}}'}</code> in SQL
      </Caption1>
    </div>
  );
}
