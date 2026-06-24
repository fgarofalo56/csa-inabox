'use client';

/**
 * IntegrationRuntimeManager — the pipeline editor's "Integration runtimes"
 * surface (Azure Data Factory / Synapse Manage-hub parity, themed for Loom).
 *
 * Lists the integration runtimes on the pipeline's backing Data Factory with
 * live status, and drives a "New integration runtime" flow:
 *   1. Pick a type (Azure / Self-Hosted / Azure-SSIS) from the catalog.
 *   2. Fill the STRUCTURED config form the catalog defines for that type
 *      (dropdowns / numbers / toggles — never freeform JSON, per
 *      loom-no-freeform-config).
 *   3. Create via the BFF, which calls adf-client.upsertIntegrationRuntime
 *      (real ARM PUT — no mocks, per no-vaporware).
 *
 * Also supports SELECTING an existing IR (onSelect) so a caller (e.g. an
 * activity's "Run on" picker) can both create-new AND select-existing.
 *
 * Self-Hosted IRs surface their install (auth) keys on demand, and Self-Hosted
 * / Azure-SSIS IRs can be started / stopped / deleted. Every call goes to
 * `/api/items/data-pipeline/[id]/integration-runtimes` (real ARM via adf-client).
 *
 * Fluent UI v9 + Loom design tokens only — no hard-coded px / hex.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Tooltip, Badge, Spinner, Caption1, Subtitle2, Body1, Text,
  Field, Input, Dropdown, Option, Switch, SpinButton,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Link, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowClockwise20Regular, Play20Regular, Stop20Regular,
  Delete20Regular, Key20Regular, Copy20Regular, Open16Regular, ChevronLeft20Regular,
  Cloud24Regular, ServerLink24Regular, Server24Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import {
  irTypesForEngine, integrationRuntimeType,
  defaultFormValues, fieldVisible, validateForm, integrationRuntimeSpecFromForm,
  type ConfigField, type IrTypeId, type IntegrationRuntimeType, type PipelineEngine,
} from '@/lib/pipeline/integration-runtime-catalog';

// ---------------------------------------------------------------------------

interface IrRow { name: string; type?: string; description?: string; state?: string }

const TYPE_ICON: Record<IrTypeId, React.FC> = {
  'azure': Cloud24Regular,
  'self-hosted': ServerLink24Regular,
  'azure-ssis': Server24Regular,
};

const NAME_RE = /^[A-Za-z0-9_]{1,260}$/;

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  headRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  headActions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexShrink: 0 },
  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalXXL, textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    border: `1px dashed ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  rowName: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  rowActions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  desc: { color: tokens.colorNeutralForeground3, overflowWrap: 'anywhere' },
  // type-picker cards
  typeGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: tokens.spacingHorizontalM, minWidth: 0 },
  typeCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM, textAlign: 'left', alignItems: 'flex-start',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
    cursor: 'pointer', height: '100%',
    transitionProperty: 'box-shadow, border-color', transitionDuration: tokens.durationNormal,
    ':hover': { boxShadow: tokens.shadow16, border: `1px solid ${tokens.colorBrandStroke1}` },
  },
  typeCardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorBrandForeground1 },
  typeCardSummary: { color: tokens.colorNeutralForeground3 },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '440px' },
  formHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  keyBox: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3, fontFamily: tokens.fontFamilyMonospace,
    overflowWrap: 'anywhere', wordBreak: 'break-all',
  },
});

function stateBadge(state?: string): { color: 'success' | 'warning' | 'danger' | 'informative'; label: string } {
  const s = (state || '').toLowerCase();
  if (s === 'started' || s === 'online') return { color: 'success', label: state || 'Online' };
  if (s === 'starting' || s === 'initial') return { color: 'informative', label: state || 'Starting' };
  if (s === 'stopping' || s === 'stopped' || s === 'limited') return { color: 'warning', label: state || 'Stopped' };
  if (s === 'needregistration') return { color: 'warning', label: 'Needs registration' };
  if (s === 'offline' || s === 'accessdenied') return { color: 'danger', label: state || 'Offline' };
  return { color: 'informative', label: state || 'Unknown' };
}

/** A Self-Hosted / Azure-SSIS (Managed-but-named-SSIS) IR can be started/stopped. */
function isLifecycleManaged(row: IrRow): boolean {
  // The built-in AutoResolveIntegrationRuntime can't be started/stopped/deleted.
  if (row.name === 'AutoResolveIntegrationRuntime') return false;
  return row.type === 'SelfHosted' || row.type === 'Managed';
}

// ===========================================================================

export interface IntegrationRuntimeManagerProps {
  /** The data-pipeline item id (route param). */
  itemId: string;
  /** The workspace (Cosmos partition key) the item lives in. */
  workspaceId: string;
  /** Pipeline engine — scopes the offered IR types (Synapse excludes Azure-SSIS). */
  engine?: PipelineEngine;
  /**
   * When provided, each IR row gets a "Select" affordance and clicking it calls
   * this with the IR name — letting a parent both create-new AND select-existing.
   */
  onSelect?: (irName: string) => void;
  /** The currently-selected IR name (highlighted when onSelect is set). */
  selectedName?: string;
}

type WizardStage = 'list' | 'pick-type' | 'config';

export function IntegrationRuntimeManager({
  itemId, workspaceId, engine = 'adf', onSelect, selectedName,
}: IntegrationRuntimeManagerProps) {
  const s = useStyles();
  const base = `/api/items/data-pipeline/${encodeURIComponent(itemId)}/integration-runtimes?workspaceId=${encodeURIComponent(workspaceId)}`;

  const [rows, setRows] = useState<IrRow[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [gate, setGate] = useState<{ missing: string } | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);

  // wizard
  const [stage, setStage] = useState<WizardStage>('list');
  const [pickedType, setPickedType] = useState<IrTypeId | null>(null);
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // auth-keys dialog
  const [keysFor, setKeysFor] = useState<string | null>(null);
  const [keys, setKeys] = useState<{ authKey1?: string; authKey2?: string } | null>(null);
  const [keysErr, setKeysErr] = useState<string | null>(null);
  const [keysBusy, setKeysBusy] = useState(false);

  const availableTypes = useMemo(() => irTypesForEngine(engine), [engine]);

  const load = useCallback(async () => {
    setLoadErr(null); setGate(null);
    try {
      const r = await clientFetch(base);
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 && j?.missing) { setGate({ missing: j.missing }); setRows([]); return; }
      if (!r.ok || !j?.ok) { setLoadErr(j?.error || `HTTP ${r.status}`); setRows([]); return; }
      setRows(Array.isArray(j.runtimes) ? j.runtimes : []);
    } catch (e: any) { setLoadErr(e?.message || String(e)); setRows([]); }
  }, [base]);

  useEffect(() => { void load(); }, [load]);

  // ----- wizard helpers -----

  const startWizard = useCallback(() => {
    setStage('pick-type'); setPickedType(null); setName('');
    setValues({}); setFormErrors({}); setSubmitErr(null);
  }, []);

  const choseType = useCallback((id: IrTypeId) => {
    setPickedType(id);
    setValues(defaultFormValues(id));
    setFormErrors({});
    setSubmitErr(null);
    setStage('config');
  }, []);

  const setField = useCallback((key: string, v: string | number | boolean) => {
    setValues((prev) => ({ ...prev, [key]: v }));
    setFormErrors((prev) => { const n = { ...prev }; delete n[key]; return n; });
  }, []);

  const cancelWizard = useCallback(() => {
    setStage('list'); setPickedType(null); setName(''); setValues({});
    setFormErrors({}); setSubmitErr(null);
  }, []);

  const submit = useCallback(async () => {
    if (!pickedType) return;
    setSubmitErr(null);
    const nm = name.trim();
    if (!NAME_RE.test(nm)) { setSubmitErr('Name must be 1-260 chars: letters, digits, and underscore only.'); return; }
    const errs = validateForm(pickedType, values);
    if (Object.keys(errs).length) { setFormErrors(errs); return; }
    setSubmitting(true);
    try {
      const spec = integrationRuntimeSpecFromForm(pickedType, nm, values);
      const r = await clientFetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: nm, properties: spec.properties }),
      }, 30000);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) { setSubmitErr(j?.error || `HTTP ${r.status}`); return; }
      cancelWizard();
      await load();
      onSelect?.(nm);
    } catch (e: any) { setSubmitErr(e?.message || String(e)); }
    finally { setSubmitting(false); }
  }, [pickedType, name, values, base, cancelWizard, load, onSelect]);

  // ----- lifecycle -----

  const lifecycle = useCallback(async (irName: string, action: 'start' | 'stop' | 'delete') => {
    setBusyName(irName);
    try {
      const r = action === 'delete'
        ? await clientFetch(`${base}&name=${encodeURIComponent(irName)}`, { method: 'DELETE' }, 30000)
        : await clientFetch(base, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: irName, action }),
          }, 30000);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) { setLoadErr(j?.error || `HTTP ${r.status}`); return; }
      await load();
    } catch (e: any) { setLoadErr(e?.message || String(e)); }
    finally { setBusyName(null); }
  }, [base, load]);

  const showKeys = useCallback(async (irName: string) => {
    setKeysFor(irName); setKeys(null); setKeysErr(null); setKeysBusy(true);
    try {
      const r = await clientFetch(base, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: irName, action: 'authKeys' }),
      }, 30000);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) { setKeysErr(j?.error || `HTTP ${r.status}`); return; }
      setKeys(j.authKeys || {});
    } catch (e: any) { setKeysErr(e?.message || String(e)); }
    finally { setKeysBusy(false); }
  }, [base]);

  // ----- render: config form stage (full-surface) -----

  if (stage === 'config' && pickedType) {
    const def = integrationRuntimeType(pickedType)!;
    const TypeIcon = TYPE_ICON[pickedType];
    return (
      <div className={s.root}>
        <div className={s.headRow}>
          <div className={s.formHead}>
            <Button appearance="subtle" icon={<ChevronLeft20Regular />} onClick={() => setStage('pick-type')}>Back</Button>
            <TypeIcon />
            <Subtitle2>New {def.title} integration runtime</Subtitle2>
          </div>
        </div>
        <Caption1>{def.description}</Caption1>
        <div className={s.form}>
          <Field label="Name" required validationMessage={!name || NAME_RE.test(name.trim()) ? undefined : 'Letters, digits, and underscore only.'}>
            <Input value={name} placeholder="e.g. onprem_sql_gateway" onChange={(_, d) => setName(d.value)} />
          </Field>
          {def.fields.map((f) => fieldVisible(f, values) ? (
            <CatalogFieldControl key={f.key} field={f} value={values[f.key]} error={formErrors[f.key]} onChange={(v) => setField(f.key, v)} />
          ) : null)}
          {submitErr && <MessageBar intent="error"><MessageBarBody>{submitErr}</MessageBarBody></MessageBar>}
          <div className={s.headActions}>
            <Button appearance="primary" icon={<Add20Regular />} disabled={submitting || !name.trim()} onClick={submit}>
              {submitting ? 'Creating…' : 'Create'}
            </Button>
            <Button appearance="secondary" disabled={submitting} onClick={cancelWizard}>Cancel</Button>
            <Link href={def.learnMoreUrl} target="_blank" rel="noreferrer">
              Learn more <Open16Regular style={{ verticalAlign: 'middle' }} />
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // ----- render: type-picker stage -----

  if (stage === 'pick-type') {
    return (
      <div className={s.root}>
        <div className={s.headRow}>
          <Subtitle2>Choose an integration runtime type</Subtitle2>
          <Button appearance="subtle" icon={<ChevronLeft20Regular />} onClick={cancelWizard}>Back to list</Button>
        </div>
        <div className={s.typeGrid}>
          {availableTypes.map((t: IntegrationRuntimeType) => {
            const TypeIcon = TYPE_ICON[t.id];
            return (
              <button key={t.id} type="button" className={s.typeCard} onClick={() => choseType(t.id)}>
                <span className={s.typeCardHead}><TypeIcon /><Subtitle2>{t.title}</Subtitle2></span>
                <Caption1 className={s.typeCardSummary}>{t.summary}</Caption1>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // ----- render: list stage -----

  return (
    <div className={s.root}>
      <div className={s.headRow}>
        <Subtitle2>Integration runtimes</Subtitle2>
        <div className={s.headActions}>
          <Tooltip content="Refresh" relationship="label">
            <Button appearance="subtle" icon={<ArrowClockwise20Regular />} onClick={() => { setRows(null); void load(); }} aria-label="Refresh" />
          </Tooltip>
          <Button appearance="primary" icon={<Add20Regular />} onClick={startWizard} disabled={!!gate}>
            New integration runtime
          </Button>
        </div>
      </div>

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Data Factory not configured</MessageBarTitle>
            Set the <code>{gate.missing}</code> environment variable on the Console so it can reach the backing Azure Data Factory. Until then, integration runtimes can&apos;t be listed or created.
          </MessageBarBody>
        </MessageBar>
      )}

      {loadErr && !gate && (
        <MessageBar intent="error"><MessageBarBody>{loadErr}</MessageBarBody></MessageBar>
      )}

      {rows === null && !gate && (
        <div className={s.empty}><Spinner size="tiny" label="Loading integration runtimes…" /></div>
      )}

      {rows !== null && rows.length === 0 && !gate && (
        <div className={s.empty}>
          <Cloud24Regular />
          <Subtitle2>No integration runtimes yet</Subtitle2>
          <Caption1>The factory uses the built-in auto-resolve Azure runtime by default. Create one to pin a region, reach private data with a self-hosted gateway, or run SSIS packages.</Caption1>
          <Button appearance="primary" icon={<Add20Regular />} onClick={startWizard}>New integration runtime</Button>
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <Table aria-label="Integration runtimes" size="medium">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const badge = stateBadge(row.state);
              const lifecycleable = isLifecycleManaged(row);
              const isSelfHosted = row.type === 'SelfHosted';
              const selected = selectedName && row.name === selectedName;
              const rowBusy = busyName === row.name;
              return (
                <TableRow key={row.name} appearance={selected ? 'brand' : undefined}>
                  <TableCell>
                    <div className={s.rowName}>
                      <Text weight="semibold">{row.name}</Text>
                    </div>
                    {row.description && <Caption1 className={s.desc}>{row.description}</Caption1>}
                  </TableCell>
                  <TableCell>{row.type || '—'}</TableCell>
                  <TableCell><Badge appearance="tint" color={badge.color}>{badge.label}</Badge></TableCell>
                  <TableCell>
                    <div className={s.rowActions}>
                      {onSelect && (
                        <Button size="small" appearance={selected ? 'primary' : 'secondary'} onClick={() => onSelect(row.name)}>
                          {selected ? 'Selected' : 'Select'}
                        </Button>
                      )}
                      {isSelfHosted && (
                        <Tooltip content="Show install (auth) keys" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Key20Regular />} onClick={() => showKeys(row.name)} aria-label="Show auth keys" />
                        </Tooltip>
                      )}
                      {lifecycleable && (
                        <>
                          <Tooltip content="Start" relationship="label">
                            <Button size="small" appearance="subtle" icon={rowBusy ? <Spinner size="tiny" /> : <Play20Regular />} disabled={rowBusy} onClick={() => lifecycle(row.name, 'start')} aria-label="Start" />
                          </Tooltip>
                          <Tooltip content="Stop" relationship="label">
                            <Button size="small" appearance="subtle" icon={<Stop20Regular />} disabled={rowBusy} onClick={() => lifecycle(row.name, 'stop')} aria-label="Stop" />
                          </Tooltip>
                          <Tooltip content="Delete (must be stopped)" relationship="label">
                            <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={rowBusy} onClick={() => lifecycle(row.name, 'delete')} aria-label="Delete" />
                          </Tooltip>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {/* Auth-keys dialog (Self-Hosted install keys) */}
      <Dialog open={!!keysFor} onOpenChange={(_, d) => { if (!d.open) { setKeysFor(null); setKeys(null); setKeysErr(null); } }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle><span className={s.formHead}><Key20Regular /> Install keys — {keysFor}</span></DialogTitle>
            <DialogContent>
              <div className={s.form} style={{ minWidth: 0 }}>
                <Body1>Install the Microsoft Integration Runtime on each gateway machine, then register the node with one of these keys.</Body1>
                {keysBusy && <Spinner size="tiny" label="Fetching keys…" />}
                {keysErr && <MessageBar intent="error"><MessageBarBody>{keysErr}</MessageBarBody></MessageBar>}
                {keys && (['authKey1', 'authKey2'] as const).map((k) => {
                  const val = keys[k];
                  if (!val) return null;
                  return (
                    <Field key={k} label={k === 'authKey1' ? 'Primary key' : 'Secondary key'}>
                      <div className={s.keyBox}>
                        <Caption1 style={{ flex: 1, minWidth: 0 }}>{val}</Caption1>
                        <Tooltip content="Copy" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Copy20Regular />} aria-label="Copy key"
                            onClick={() => { void navigator.clipboard?.writeText(val); }} />
                        </Tooltip>
                      </div>
                    </Field>
                  );
                })}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => { setKeysFor(null); setKeys(null); setKeysErr(null); }}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A single structured control rendered from a catalog ConfigField. Renders the
// right Fluent control per field.type — NEVER a freeform JSON textarea.
// ---------------------------------------------------------------------------

function CatalogFieldControl({
  field, value, error, onChange,
}: {
  field: ConfigField;
  value: string | number | boolean | undefined;
  error?: string;
  onChange: (v: string | number | boolean) => void;
}) {
  if (field.type === 'boolean') {
    return (
      <Field label={field.label} hint={field.help} validationMessage={error}>
        <Switch checked={value === true} onChange={(_, d) => onChange(d.checked)} />
      </Field>
    );
  }
  if (field.type === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    return (
      <Field label={field.label} hint={field.help} required={field.required} validationMessage={error}>
        <SpinButton
          value={Number.isFinite(n) ? n : (typeof field.default === 'number' ? field.default : 0)}
          min={field.min} max={field.max}
          onChange={(_, d) => {
            const next = d.value ?? (d.displayValue !== undefined ? Number(d.displayValue) : undefined);
            if (next !== undefined && next !== null && Number.isFinite(Number(next))) onChange(Number(next));
          }}
        />
      </Field>
    );
  }
  if (field.type === 'select') {
    const opts = field.options || [];
    const cur = value === undefined || value === null ? '' : String(value);
    const curLabel = opts.find((o) => o.value === cur)?.label || cur;
    return (
      <Field label={field.label} hint={field.help} required={field.required} validationMessage={error}>
        <Dropdown value={curLabel} selectedOptions={[cur]} onOptionSelect={(_, d) => { if (d.optionValue !== undefined) onChange(d.optionValue); }}>
          {opts.map((o) => <Option key={o.value} value={o.value} text={o.label}>{o.label}</Option>)}
        </Dropdown>
      </Field>
    );
  }
  // text
  return (
    <Field label={field.label} hint={field.help} required={field.required} validationMessage={error}>
      <Input value={value === undefined || value === null ? '' : String(value)} placeholder={field.placeholder} onChange={(_, d) => onChange(d.value)} />
    </Field>
  );
}

export default IntegrationRuntimeManager;
