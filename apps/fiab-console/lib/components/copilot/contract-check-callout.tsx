'use client';

/**
 * ContractCheckCallout — B-N14c: the shared surface for a data-contract verdict
 * on a copilot PROPOSAL.
 *
 * Rendered next to any suggestion (a generated pipeline spec, a Power Query
 * step, a generated T-SQL statement) BEFORE the user applies it, so a contract
 * breach is visible at the decision point instead of at run time in the Bronze
 * dead-letter tree. One component, used by every proposing surface — the same
 * verdict shape the Answer Receipt renders.
 *
 * States, all designed (never a bare div):
 *   blocked  → error MessageBar; the surface disables Apply.
 *   errors   → warning MessageBar (warn-quarantine would land + quarantine).
 *   warnings → informational MessageBar (classified columns, deprecated contract).
 *   clean    → success MessageBar naming the contracts it conforms to.
 *   skipped  → subtle informational note with the honest reason.
 *   ungoverned only → nothing is rendered (no contract governs this proposal).
 *
 * Fluent v9 + Loom tokens only (web3-ui.md): no raw px, no hex. The violation
 * list wraps (`flexWrap` + `minWidth:0`) so badges can never overlap.
 */

import { useId, useState } from 'react';
import {
  Badge, Button, Caption1, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ChevronDown12Regular, ChevronRight12Regular } from '@fluentui/react-icons';

/** The verdict shape (structurally the `ContractCheck` the guard returns). */
export interface ContractCheckView {
  ok: boolean;
  blocked: boolean;
  kind: string;
  contractsChecked: Array<{ id: string; name: string; version?: string; status?: string; mode?: string }>;
  ungovernedDatasets?: string[];
  violations: Array<{
    contractName?: string;
    dataset: string;
    column?: string;
    rule: string;
    severity: 'error' | 'warning' | 'info';
    detail: string;
  }>;
  note: string;
  skipped?: string;
  skipReason?: string;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  chips: {
    display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS,
    alignItems: 'center', minWidth: 0,
  },
  toggle: { alignSelf: 'flex-start' },
  list: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    margin: 0, paddingLeft: tokens.spacingHorizontalL, minWidth: 0,
  },
  row: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    overflowWrap: 'anywhere',
    minWidth: 0,
  },
  target: { fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1 },
});

const SEVERITY_COLOR: Record<string, 'danger' | 'warning' | 'informative'> = {
  error: 'danger',
  warning: 'warning',
  info: 'informative',
};

export interface ContractCheckCalloutProps {
  check: ContractCheckView | null | undefined;
  /** Render the skipped state too (default true — honesty over tidiness). */
  showSkipped?: boolean;
}

export function ContractCheckCallout({ check, showSkipped = true }: ContractCheckCalloutProps) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const listId = useId();

  if (!check) return null;

  if (check.skipped) {
    if (!showSkipped) return null;
    return (
      <MessageBar intent="info" layout="multiline">
        <MessageBarBody>
          <MessageBarTitle>Data contracts not checked</MessageBarTitle>
          {check.skipReason || check.note}
        </MessageBarBody>
      </MessageBar>
    );
  }

  // No contract governs anything this proposal touches — say nothing.
  if (!check.contractsChecked.length) return null;

  const errors = check.violations.filter((v) => v.severity === 'error');
  const warnings = check.violations.filter((v) => v.severity === 'warning');
  const infos = check.violations.filter((v) => v.severity === 'info');
  const intent = check.blocked ? 'error' : errors.length ? 'warning' : warnings.length ? 'warning' : 'success';
  const title = check.blocked
    ? 'Data contract violation — do not apply as-is'
    : errors.length
      ? 'Data contract violation'
      : warnings.length
        ? 'Data contract warnings'
        : 'Conforms to the governing data contracts';

  const detailed = [...errors, ...warnings, ...infos];

  return (
    <div className={s.root}>
      <MessageBar intent={intent} layout="multiline">
        <MessageBarBody>
          <MessageBarTitle>{title}</MessageBarTitle>
          {check.note}
          <div className={s.chips} style={{ marginTop: tokens.spacingVerticalXS }}>
            {check.contractsChecked.map((c) => (
              <Badge key={c.id} appearance="tint" color="informative" title={`Enforcement: ${c.mode || 'warn-quarantine'}`}>
                {c.name}
                {c.version ? ` v${c.version}` : ''}
              </Badge>
            ))}
            {errors.length > 0 && <Badge appearance="tint" color="danger">{errors.length} error{errors.length === 1 ? '' : 's'}</Badge>}
            {warnings.length > 0 && <Badge appearance="tint" color="warning">{warnings.length} warning{warnings.length === 1 ? '' : 's'}</Badge>}
          </div>
        </MessageBarBody>
      </MessageBar>

      {detailed.length > 0 && (
        <>
          <Button
            className={s.toggle}
            size="small"
            appearance="subtle"
            icon={open ? <ChevronDown12Regular /> : <ChevronRight12Regular />}
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Hide' : 'Show'} {detailed.length} contract finding{detailed.length === 1 ? '' : 's'}
          </Button>
          {open && (
            <ul id={listId} className={s.list} aria-label="Data-contract findings">
              {detailed.map((v, i) => (
                <li key={`${v.dataset}-${v.column || ''}-${v.rule}-${i}`} className={s.row}>
                  <Badge appearance="tint" color={SEVERITY_COLOR[v.severity] || 'informative'} size="small">
                    {v.severity}
                  </Badge>{' '}
                  <span className={s.target}>
                    {v.dataset}
                    {v.column ? `.${v.column}` : ''}
                  </span>{' '}
                  — {v.detail}
                  {v.contractName ? <Caption1> ({v.contractName})</Caption1> : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
