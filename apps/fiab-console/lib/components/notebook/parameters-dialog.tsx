'use client';

/**
 * ParametersDialog — "Run with parameters" for the Loom notebook (R4-NB-2 /
 * Fabric notebook F5). Papermill semantics: the notebook's single
 * `parameters`-tagged cell declares `name = value` defaults; this dialog reads
 * those declarations, lets the user override each value, and returns the
 * overrides. The editor then injects an override cell immediately AFTER the
 * parameters cell and runs — exactly how papermill parameterizes a notebook.
 *
 * Grounded in the papermill parameters contract used by Fabric / Azure ML
 * scheduled runs: https://papermill.readthedocs.io/en/latest/usage-parameterize.html
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Input, Field, Text, Badge, MessageBar, MessageBarBody,
  makeStyles, tokens,
} from '@fluentui/react-components';

export interface ParameterDecl {
  name: string;
  /** Raw right-hand side as written in the parameters cell (e.g. `10`, `"prod"`). */
  defaultValue: string;
}

const useStyles = makeStyles({
  fields: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  note: { color: tokens.colorNeutralForeground3 },
});

/**
 * Parse `name = value` assignments from a parameters-cell source. Skips blank
 * lines, comments, and non-assignment statements. Keeps the raw RHS verbatim so
 * a Python literal (number / string / list) round-trips unchanged.
 */
export function parseParameterCell(source: string): ParameterDecl[] {
  const decls: ParameterDecl[] = [];
  for (const rawLine of (source || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // name = value  (a single leading identifier, no augmented/compound assign)
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*(.+?)\s*(#.*)?$/.exec(line);
    if (!m) continue;
    const name = m[1];
    if (['if', 'for', 'while', 'return', 'import', 'from'].includes(name)) continue;
    decls.push({ name, defaultValue: m[2] });
  }
  return decls;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Source of the parameters-tagged cell (empty when none is tagged). */
  parameterSource: string;
  /** Called with the override map (name → raw literal) when the user runs. */
  onRun: (overrides: Record<string, string>) => void;
  busy?: boolean;
}

export function ParametersDialog({ open, onClose, parameterSource, onRun, busy }: Props) {
  const s = useStyles();
  const decls = useMemo(() => parseParameterCell(parameterSource), [parameterSource]);
  const [values, setValues] = useState<Record<string, string>>({});

  // Seed the fields with the declared defaults each time the dialog opens.
  useEffect(() => {
    if (open) {
      const seed: Record<string, string> = {};
      for (const d of decls) seed[d.name] = d.defaultValue;
      setValues(seed);
    }
  }, [open, decls]);

  const submit = () => {
    // Only send values that DIFFER from the declared default (papermill injects
    // just the overrides — unchanged params keep their in-cell default).
    const overrides: Record<string, string> = {};
    for (const d of decls) {
      const v = values[d.name];
      if (v !== undefined && v !== d.defaultValue) overrides[d.name] = v;
    }
    onRun(overrides);
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: 520 }}>
        <DialogBody>
          <DialogTitle>Run with parameters</DialogTitle>
          <DialogContent>
            {decls.length === 0 ? (
              <MessageBar intent="info">
                <MessageBarBody>
                  No parameters found. Tag a code cell as the <b>parameters</b> cell (cell
                  menu → &ldquo;Mark as parameters cell&rdquo;) and declare defaults as{' '}
                  <code>name = value</code> lines. Those become the overridable inputs here.
                </MessageBarBody>
              </MessageBar>
            ) : (
              <div className={s.fields}>
                <Text size={200} className={s.note}>
                  <Badge appearance="tint" color="brand">papermill</Badge>{' '}
                  Overrides are injected as a cell right after the parameters cell, then the
                  notebook runs. Values are raw Python literals (quote strings).
                </Text>
                {decls.map((d) => (
                  <Field key={d.name} label={d.name} hint={`default: ${d.defaultValue}`}>
                    <Input
                      value={values[d.name] ?? ''}
                      onChange={(_, data) => setValues((p) => ({ ...p, [d.name]: data.value }))}
                    />
                  </Field>
                ))}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button appearance="primary" disabled={busy || decls.length === 0} onClick={submit}>
              {busy ? 'Running…' : 'Run'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
