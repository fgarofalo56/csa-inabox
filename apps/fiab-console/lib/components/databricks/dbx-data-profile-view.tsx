'use client';

/**
 * DbxDataProfileView (R4-DBX-6) — the Databricks notebook "Data Profile" tab.
 *
 * Renders per-column summary statistics for a `display(df)` table result:
 * dtype, null count, and either numeric stats (min / max / mean / stddev) or
 * categorical stats (distinct count + top value). Computed by the shared,
 * unit-tested profiler (`buildDbxDataProfile` → `display-stats.buildLoomDisplay`)
 * from the rows already returned by the Command Execution API — no extra
 * backend call, real stats (no-vaporware.md).
 */

import { useMemo } from 'react';
import {
  makeStyles, tokens, Caption1,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Badge, MessageBar, MessageBarBody,
} from '@fluentui/react-components';
import { buildDbxDataProfile } from '@/lib/editors/databricks/dbx-data-profile';
import { isNumericDtype } from '@/lib/notebook/display-stats';

const useStyles = makeStyles({
  wrap: { overflowX: 'auto' },
  mono: { fontFamily: tokens.fontFamilyMonospace },
  meta: { marginBottom: tokens.spacingVerticalXS, color: tokens.colorNeutralForeground3 },
});

export interface DbxDataProfileViewProps {
  columns?: string[];
  rows?: unknown[][];
}

export function DbxDataProfileView({ columns, rows }: DbxDataProfileViewProps) {
  const s = useStyles();
  const payload = useMemo(() => buildDbxDataProfile(columns, rows), [columns, rows]);

  if (!payload) {
    return <MessageBar intent="info"><MessageBarBody>No tabular result to profile.</MessageBarBody></MessageBar>;
  }

  return (
    <div className={s.wrap}>
      <Caption1 className={s.meta}>
        Profiled {payload.sampleSize.toLocaleString()} row{payload.sampleSize === 1 ? '' : 's'} across {payload.columns.length} column{payload.columns.length === 1 ? '' : 's'}.
      </Caption1>
      <Table size="small" aria-label="Data profile">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Column</TableHeaderCell>
            <TableHeaderCell>Type</TableHeaderCell>
            <TableHeaderCell>Nulls</TableHeaderCell>
            <TableHeaderCell>Min</TableHeaderCell>
            <TableHeaderCell>Max</TableHeaderCell>
            <TableHeaderCell>Mean</TableHeaderCell>
            <TableHeaderCell>Std dev</TableHeaderCell>
            <TableHeaderCell>Distinct / top value</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {payload.columns.map((c) => {
            const numeric = isNumericDtype(c.dtype);
            const top = c.topValues && c.topValues[0];
            return (
              <TableRow key={c.name}>
                <TableCell className={s.mono}>{c.name}</TableCell>
                <TableCell><Badge appearance="outline" color={numeric ? 'brand' : 'informative'}>{c.dtype}</Badge></TableCell>
                <TableCell>{c.nullCount}</TableCell>
                <TableCell className={s.mono}>{numeric ? (c.min ?? '—') : '—'}</TableCell>
                <TableCell className={s.mono}>{numeric ? (c.max ?? '—') : '—'}</TableCell>
                <TableCell className={s.mono}>{numeric ? (c.mean ?? '—') : '—'}</TableCell>
                <TableCell className={s.mono}>{numeric ? (c.stddev ?? '—') : '—'}</TableCell>
                <TableCell>
                  {numeric
                    ? '—'
                    : top
                      ? <span className={s.mono}>{c.cardinality ?? '—'} distinct · “{top.value}” ×{top.count}</span>
                      : (c.cardinality != null ? `${c.cardinality} distinct` : '—')}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
