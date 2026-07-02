'use client';

/**
 * WhatIfParameterDialog — Azure-native parity with the Power BI / Fabric
 * "New parameter → Numeric range" (what-if) experience, rebuilt one-for-one in
 * the Loom Model view (`.claude/rules/ui-parity.md`).
 *
 * A what-if parameter in Power BI is three linked tabular objects:
 *   1. a single-column calculated table  = GENERATESERIES(min, max, increment)
 *   2. a value measure                   = SELECTEDVALUE('<name>'[<name>], default)
 *   3. a slicer bound to that column     = '<name>'[<name>]
 *
 * This surface GENERATES all three from a STRUCTURED 5-field form (name, data
 * type, min, max, increment, default) — there is NO hand-written DAX box, so
 * `loom_no_freeform_config` is honored (the generated DAX is shown read-only as
 * a preview, never edited). On confirm we POST `{ whatIfParameter: {...} }` to
 * the model BFF, which normalizes + persists it Azure-native onto
 * `item.state.model.whatIfParameters` (Cosmos — the SAME slot the DAX Copilot
 * and the `/query` DAX path already read), so the parameter immediately drives
 * real query results.
 *
 * NO-FABRIC-DEPENDENCY (`.claude/rules/no-fabric-dependency.md`): nothing here
 * requires a Power BI / Fabric / AAS workspace. The persistence target is the
 * owned Cosmos item; the GENERATESERIES table + SELECTEDVALUE measure are part
 * of the Loom-native tabular layer and are emitted into TMSL only when the model
 * is OPT-IN provisioned to a tabular engine. The full surface renders + saves
 * with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
 *
 * NO-VAPORWARE (`.claude/rules/no-vaporware.md`): every control is wired — the
 * primary button POSTs to a real route and the response (backend + steps) is
 * surfaced; failures render an honest error MessageBar; the parameter list is
 * seeded from the item's real persisted state, never a mock.
 *
 * web3-ui (`.claude/rules/web3-ui.md`): Fluent v9 + Loom tokens only (no raw
 * px/hex), dialog chrome matches the editor's sibling dialogs (delta-maintenance
 * / aggregation), EmptyState for the empty gallery, dark-legible throughout.
 */

import { useMemo, useState } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Caption1, Body1, Subtitle2, Field, Input, Dropdown, Option, SpinButton, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle, Badge, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Beaker24Regular, Beaker20Regular, Add20Regular, Code16Regular,
  Options24Regular, CheckmarkCircle16Filled,
} from '@fluentui/react-icons';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { EmptyState } from '@/lib/components/empty-state';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { clientFetch } from '@/lib/client-fetch';

// ── Contract shape (mirrors model-store.ts WhatIfParameter; the server assigns
//    id/createdAt/updatedAt via normalizeWhatIfParameter) ────────────────────

type WhatIfDataType = 'int64' | 'decimal' | 'double';

interface WhatIfParameter {
  id: string;
  name: string;
  min: number;
  max: number;
  increment: number;
  defaultValue: number;
  dataType?: WhatIfDataType;
  seriesExpression: string;
  valueMeasure: string;
  boundSlicerColumn: string;
  createdAt?: string;
  updatedAt?: string;
}

interface WhatIfParameterDialogProps {
  /** The owned model item — its `state.model.whatIfParameters` seeds the list. */
  item: WorkspaceItem;
  /** The semantic-model item id (route path segment). */
  id: string;
  /** Optional live Power BI/Fabric dataset id (opt-in path only; unused on the
   *  Azure-native default — kept for the shared ModelTabsExtra prop contract). */
  datasetId?: string;
  /** Called after a successful save so the parent can refresh its model view. */
  onSaved?: () => void;
}

const DATA_TYPE_OPTIONS: Array<{ value: WhatIfDataType; label: string; hint: string }> = [
  { value: 'int64', label: 'Whole number (int64)', hint: 'Integer steps — e.g. a discount % from 0 to 50 by 5.' },
  { value: 'decimal', label: 'Fixed decimal (decimal)', hint: 'Exact decimals — e.g. a price multiplier 0.50–2.00 by 0.05.' },
  { value: 'double', label: 'Decimal number (double)', hint: 'Floating point — widest range, approximate decimals.' },
];

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  header: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM, flexWrap: 'wrap',
  },
  headerText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  headerTitle: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  titleIcon: { color: tokens.colorBrandForeground1 },
  hint: { color: tokens.colorNeutralForeground3 },
  // Parameter card — elevated, hover-lift, matches the polished marketplace tiles.
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow4,
    transitionDuration: tokens.durationNormal,
    transitionProperty: 'box-shadow, transform',
    ':hover': { boxShadow: tokens.shadow16, transform: 'translateY(-2px)' },
  },
  cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalS },
  cardName: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  cardNameText: { fontWeight: tokens.fontWeightSemibold, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rangeRow: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  // Read-only generated-DAX preview block (the only "code" surface; never editable).
  preview: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  previewHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, color: tokens.colorNeutralForeground2 },
  code: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0,
  },
  codeLabel: { color: tokens.colorNeutralForeground3, fontWeight: tokens.fontWeightSemibold },
  dialogBody: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: '480px' },
  grid3: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: tokens.spacingHorizontalM,
  },
  steps: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, marginTop: tokens.spacingVerticalXS },
  stepLine: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, color: tokens.colorNeutralForeground2 },
});

// ── DAX generators (pure, deterministic — the no-freeform-config core) ───────

/** Format a number for DAX: integers for int64, trimmed decimals otherwise. */
function fmtNum(n: number, dataType: WhatIfDataType): string {
  if (!Number.isFinite(n)) return '0';
  if (dataType === 'int64') return String(Math.trunc(n));
  // Keep author-entered precision but drop a trailing ".0" noise.
  return String(n);
}

function buildSeriesExpression(min: number, max: number, increment: number, dataType: WhatIfDataType): string {
  return `GENERATESERIES(${fmtNum(min, dataType)}, ${fmtNum(max, dataType)}, ${fmtNum(increment, dataType)})`;
}

function buildValueMeasure(name: string, defaultValue: number, dataType: WhatIfDataType): string {
  return `SELECTEDVALUE('${name}'[${name}], ${fmtNum(defaultValue, dataType)})`;
}

function buildBoundSlicerColumn(name: string): string {
  return `'${name}'[${name}]`;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_ ]{0,99}$/;

/** Reuse the editor's existing what-if parameters off the persisted item state. */
function seedParameters(item: WorkspaceItem): WhatIfParameter[] {
  const model = (item.state as Record<string, unknown> | undefined)?.model as
    | { whatIfParameters?: unknown }
    | undefined;
  const raw = model?.whatIfParameters;
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is WhatIfParameter => !!p && typeof (p as WhatIfParameter).name === 'string');
}

export function WhatIfParameterDialog({ item, id, datasetId, onSaved }: WhatIfParameterDialogProps) {
  const s = useStyles();
  const [params, setParams] = useState<WhatIfParameter[]>(() => seedParameters(item));
  const [open, setOpen] = useState(false);

  // Form state (structured — no free-form DAX).
  const [name, setName] = useState('');
  const [dataType, setDataType] = useState<WhatIfDataType>('int64');
  const [min, setMin] = useState(0);
  const [max, setMax] = useState(10);
  const [increment, setIncrement] = useState(1);
  const [defaultValue, setDefaultValue] = useState(0);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [backend, setBackend] = useState<string | null>(null);

  const step = dataType === 'int64' ? 1 : 0.05;

  const trimmedName = name.trim();
  const nameTaken = params.some((p) => p.name.toLowerCase() === trimmedName.toLowerCase());

  // Validation — drives both the inline field messages and the disabled state.
  const nameError =
    !trimmedName ? 'A parameter name is required.'
    : !NAME_RE.test(trimmedName) ? 'Start with a letter or underscore; letters, digits, spaces and underscores only.'
    : nameTaken ? 'A what-if parameter with this name already exists.'
    : undefined;
  const rangeError =
    !(min < max) ? 'Minimum must be less than maximum.'
    : !(increment > 0) ? 'Increment must be greater than zero.'
    : (increment > max - min) ? 'Increment cannot exceed the min→max span.'
    : undefined;
  const defaultError =
    !(defaultValue >= min && defaultValue <= max) ? `Default must be between ${min} and ${max}.` : undefined;

  const valid = !nameError && !rangeError && !defaultError;

  // Live generated DAX preview (read-only) — recomputed as the form changes.
  const preview = useMemo(() => {
    const n = trimmedName || '<name>';
    return {
      seriesExpression: buildSeriesExpression(min, max, increment, dataType),
      valueMeasure: buildValueMeasure(n, defaultValue, dataType),
      boundSlicerColumn: buildBoundSlicerColumn(n),
    };
  }, [trimmedName, min, max, increment, defaultValue, dataType]);

  function resetForm() {
    setName(''); setDataType('int64'); setMin(0); setMax(10); setIncrement(1); setDefaultValue(0);
    setError(null); setSteps([]); setBackend(null);
  }

  function openDialog() {
    resetForm();
    setOpen(true);
  }

  async function save() {
    if (!valid) return;
    setBusy(true);
    setError(null);
    setSteps([]);
    setBackend(null);

    const payload: Omit<WhatIfParameter, 'id' | 'createdAt' | 'updatedAt'> = {
      name: trimmedName,
      min, max, increment, defaultValue, dataType,
      seriesExpression: buildSeriesExpression(min, max, increment, dataType),
      valueMeasure: buildValueMeasure(trimmedName, defaultValue, dataType),
      boundSlicerColumn: buildBoundSlicerColumn(trimmedName),
    };

    try {
      const res = await clientFetch(
        `/api/items/semantic-model/${encodeURIComponent(id)}/model`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ whatIfParameter: payload }),
        },
      );
      let j: {
        ok?: boolean;
        whatIfParameter?: WhatIfParameter;
        whatIfParameters?: WhatIfParameter[];
        backend?: string;
        steps?: string[];
        error?: string;
      };
      try { j = await res.json(); }
      catch { j = { ok: false, error: `Unexpected non-JSON response (HTTP ${res.status})` }; }

      if (!res.ok || j.ok === false) {
        setError(j.error || `Save failed (HTTP ${res.status}).`);
        if (Array.isArray(j.steps)) setSteps(j.steps);
        return;
      }

      // Prefer the server-normalized object/list; fall back to the optimistic
      // payload so the card still appears with the generated DAX.
      const saved: WhatIfParameter = j.whatIfParameter ?? {
        ...payload,
        id: `whatif-${Date.now()}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const nextList = Array.isArray(j.whatIfParameters)
        ? j.whatIfParameters
        : [...params.filter((p) => p.name.toLowerCase() !== saved.name.toLowerCase()), saved];

      setParams(nextList);
      setBackend(j.backend ?? null);
      setSteps(Array.isArray(j.steps) ? j.steps : []);
      onSaved?.();
      setOpen(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={s.section} data-dataset-id={datasetId || undefined}>
      <div className={s.header}>
        <div className={s.headerText}>
          <div className={s.headerTitle}>
            <Beaker24Regular className={s.titleIcon} />
            <Subtitle2>What-if parameters</Subtitle2>
          </div>
          <Caption1 className={s.hint}>
            Generate a numeric-range parameter — a GENERATESERIES table, a SELECTEDVALUE measure, and a bound
            slicer column — that lets report consumers model scenarios. Saved Azure-native to this model; no Power
            BI or Fabric workspace required.
          </Caption1>
        </div>
        {params.length > 0 && (
          <Button appearance="primary" icon={<Add20Regular />} onClick={openDialog}>
            New parameter
          </Button>
        )}
      </div>

      {params.length === 0 ? (
        <EmptyState
          icon={<Beaker20Regular />}
          title="No what-if parameters yet"
          body="Add a numeric-range parameter so report users can drive measures with a slicer — discount rates, price multipliers, growth assumptions, and more. Loom generates the DAX for you; there is nothing to hand-write."
          primaryAction={{ label: 'Create what-if parameter', onClick: openDialog }}
        />
      ) : (
        <TileGrid minTileWidth={320}>
          {params.map((p) => (
            <div key={p.id || p.name} className={s.card}>
              <div className={s.cardHead}>
                <div className={s.cardName}>
                  <Options24Regular className={s.titleIcon} />
                  <Tooltip content={p.name} relationship="label">
                    <Body1 className={s.cardNameText}>{p.name}</Body1>
                  </Tooltip>
                </div>
                <Badge appearance="outline" color="brand">{p.dataType ?? 'int64'}</Badge>
              </div>
              <div className={s.rangeRow}>
                <Badge appearance="tint" color="informative">min {p.min}</Badge>
                <Badge appearance="tint" color="informative">max {p.max}</Badge>
                <Badge appearance="tint" color="informative">step {p.increment}</Badge>
                <Badge appearance="tint" color="brand">default {p.defaultValue}</Badge>
              </div>
              <div className={s.preview}>
                <div className={s.previewHeader}>
                  <Code16Regular />
                  <Caption1>Generated DAX</Caption1>
                </div>
                <pre className={s.code}><span className={s.codeLabel}>Table  </span>{p.seriesExpression}</pre>
                <pre className={s.code}><span className={s.codeLabel}>Measure</span> {p.valueMeasure}</pre>
                <pre className={s.code}><span className={s.codeLabel}>Slicer </span>{p.boundSlicerColumn}</pre>
              </div>
            </div>
          ))}
        </TileGrid>
      )}

      <Dialog open={open} onOpenChange={(_, d) => { if (!busy) setOpen(d.open); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>
              <span className={s.headerTitle}>
                <Beaker24Regular className={s.titleIcon} />
                New what-if parameter
              </span>
            </DialogTitle>
            <DialogContent>
              <div className={s.dialogBody}>
                <Caption1 className={s.hint}>
                  Define the numeric range below. Loom generates the GENERATESERIES table, the SELECTEDVALUE
                  measure, and the slicer binding — shown read-only in the preview. No DAX to write by hand.
                </Caption1>

                <Field
                  label="Parameter name"
                  required
                  validationState={name && nameError ? 'error' : 'none'}
                  validationMessage={name ? nameError : undefined}
                  hint="Becomes the calculated table, the value measure, and the slicer column name."
                >
                  <Input
                    value={name}
                    placeholder="e.g. Discount %"
                    onChange={(_, d) => setName(d.value)}
                  />
                </Field>

                <Field label="Data type" hint={DATA_TYPE_OPTIONS.find((o) => o.value === dataType)?.hint}>
                  <Dropdown
                    value={DATA_TYPE_OPTIONS.find((o) => o.value === dataType)?.label}
                    selectedOptions={[dataType]}
                    onOptionSelect={(_, d) => setDataType((d.optionValue as WhatIfDataType) || 'int64')}
                  >
                    {DATA_TYPE_OPTIONS.map((o) => (
                      <Option key={o.value} value={o.value} text={o.label}>{o.label}</Option>
                    ))}
                  </Dropdown>
                </Field>

                <Field
                  label="Range"
                  required
                  validationState={rangeError ? 'error' : 'none'}
                  validationMessage={rangeError}
                >
                  <div className={s.grid3}>
                    <Field label="Minimum">
                      <SpinButton
                        value={min}
                        step={step}
                        onChange={(_, d) => setMin(Number(d.value ?? d.displayValue) || 0)}
                      />
                    </Field>
                    <Field label="Maximum">
                      <SpinButton
                        value={max}
                        step={step}
                        onChange={(_, d) => setMax(Number(d.value ?? d.displayValue) || 0)}
                      />
                    </Field>
                    <Field label="Increment">
                      <SpinButton
                        value={increment}
                        min={0}
                        step={step}
                        onChange={(_, d) => setIncrement(Number(d.value ?? d.displayValue) || 0)}
                      />
                    </Field>
                  </div>
                </Field>

                <Field
                  label="Default value"
                  required
                  validationState={defaultError ? 'error' : 'none'}
                  validationMessage={defaultError}
                  hint="The value the measure returns when nothing is selected on the slicer."
                >
                  <SpinButton
                    value={defaultValue}
                    min={min}
                    max={max}
                    step={step}
                    onChange={(_, d) => setDefaultValue(Number(d.value ?? d.displayValue) || 0)}
                  />
                </Field>

                <div className={s.preview}>
                  <div className={s.previewHeader}>
                    <Code16Regular />
                    <Caption1>Will generate (read-only)</Caption1>
                  </div>
                  <pre className={s.code}><span className={s.codeLabel}>Table  </span>{preview.seriesExpression}</pre>
                  <pre className={s.code}><span className={s.codeLabel}>Measure</span> {preview.valueMeasure}</pre>
                  <pre className={s.code}><span className={s.codeLabel}>Slicer </span>{preview.boundSlicerColumn}</pre>
                </div>

                {error && (
                  <MessageBar intent="error">
                    <MessageBarBody>
                      <MessageBarTitle>Couldn’t save the parameter</MessageBarTitle>
                      {error}
                      {steps.length > 0 && (
                        <div className={s.steps}>
                          {steps.map((line, i) => (
                            <Caption1 key={i} className={s.stepLine}>{line}</Caption1>
                          ))}
                        </div>
                      )}
                    </MessageBarBody>
                  </MessageBar>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
              <Button
                appearance="primary"
                icon={busy ? <Spinner size="tiny" /> : <Beaker20Regular />}
                onClick={save}
                disabled={!valid || busy}
              >
                {busy ? 'Saving…' : 'Create parameter'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {backend && steps.length > 0 && (
        <MessageBar intent="success">
          <MessageBarBody>
            <MessageBarTitle>
              <CheckmarkCircle16Filled style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS }} />
              Parameter saved ({backend})
            </MessageBarTitle>
            <div className={s.steps}>
              {steps.map((line, i) => (
                <Caption1 key={i} className={s.stepLine}>{line}</Caption1>
              ))}
            </div>
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}

export default WhatIfParameterDialog;
