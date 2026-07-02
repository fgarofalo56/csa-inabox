'use client';

/**
 * TriggerWizard — the Loom one-for-one of Azure Data Factory / Synapse Studio's
 * "Add trigger → New" dialog (ui-parity.md). Instead of a cron string or raw
 * JSON, it offers the SAME four guided trigger types the ADF portal does, each
 * with typed, structured controls (no freeform JSON — loom-no-freeform-config),
 * and emits the exact ADF trigger `properties` payload the
 * /api/items/data-pipeline/[id]/triggers route hands to the factory:
 *
 *   Schedule         — recurrence (minute/hour/day/week/month) + start/end + tz,
 *                      plus the advanced schedule (at-hours, at-minutes, weekly
 *                      day-picker, month-days, monthly occurrences)
 *   Tumbling window  — fixed windows + delay + concurrency + retry + self / other
 *                      tumbling-window-trigger DEPENDENCIES (offset + size)
 *   Storage events   — BlobCreated/Deleted on a storage account (picked via the
 *                      shared LinkedServicePicker → resolved account resource ID)
 *                      + blob path begins/ends-with filters (dynamic @{…})
 *   Custom events    — Event Grid topic scope + event types + subject begins/
 *                      ends-with filters (dynamic @{…})
 *
 * Plus two cross-cutting steps every trigger gets:
 *   • Trigger parameters — map each declared pipeline parameter to a TRIGGER
 *     OUTPUT (system variable, e.g. @triggerBody().fileName) OR a value source
 *     (direct literal / Key Vault / App Config). Trigger-output expressions are
 *     written verbatim into properties.pipelines[].parameters; value sources are
 *     resolved server-side at creation time by the BFF (trigger-param-resolver).
 *   • Activate on create — when on, the trigger is created Started and the
 *     wizard asks the caller (onActivate) to issue the real start.
 *
 * All trigger metadata (types, the per-type ConfigField settings, the system-
 * variable `outputs`, and pipeline-reference cardinality) is DATA-DRIVEN from
 * `lib/pipeline/trigger-catalog.ts` — the same `ConfigField` contract the
 * connector catalog uses, rendered by the same controls (with ExpressionField
 * for dynamic-capable fields), so this wizard stays 1:1 with the catalog.
 *
 * The created trigger + its parameter bindings + variables all round-trip as the
 * trigger JSON on the real ARM REST via adf-client (listTriggers / getTrigger /
 * upsertTrigger / startTrigger / stopTrigger) — no mocks (no-vaporware.md).
 *
 * Grounded in:
 *   learn.microsoft.com/azure/data-factory/concepts-pipeline-execution-triggers
 *   learn.microsoft.com/azure/data-factory/how-to-create-schedule-trigger
 *   learn.microsoft.com/azure/data-factory/how-to-create-tumbling-window-trigger
 *   learn.microsoft.com/azure/data-factory/tumbling-window-trigger-dependency
 *   learn.microsoft.com/azure/data-factory/how-to-create-event-trigger
 *   learn.microsoft.com/azure/data-factory/how-to-create-custom-event-trigger
 *   learn.microsoft.com/azure/data-factory/how-to-use-trigger-parameterization
 *   learn.microsoft.com/rest/api/datafactory/triggers/create-or-update
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Input, Field, Dropdown, Option, Switch, Text, Badge, Caption1,
  Subtitle2, Divider, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  CalendarClock20Regular, CalendarDataBar20Regular, CloudArrowUp20Regular,
  Flash20Regular, Clock20Regular, Branch20Regular, Link20Regular,
} from '@fluentui/react-icons';
import { ParamSourcePicker, EMPTY_BINDING, type ParamBinding } from './param-source-picker';
import { ExpressionField } from './expression-field';
import { LinkedServicePicker, type LinkedServiceEngine } from './linked-service-gallery';
import {
  TRIGGER_TYPES, triggerTypeByKey,
  type TriggerKind, type TriggerTypeDef, type ConfigField, type TriggerOutputVar,
} from '@/lib/pipeline/trigger-catalog';
import type { PipelineParameter } from './types';

// ---------------------------------------------------------------------------
// Per-type card glyphs (the catalog carries a best-effort `icon` string).
// ---------------------------------------------------------------------------

type Glyph = React.FC<{ className?: string }>;

const TYPE_GLYPH: Record<TriggerKind, Glyph> = {
  ScheduleTrigger: CalendarClock20Regular,
  TumblingWindowTrigger: CalendarDataBar20Regular,
  BlobEventsTrigger: CloudArrowUp20Regular,
  CustomEventsTrigger: Flash20Regular,
};

const useStyles = makeStyles({
  typeRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(0, 1fr))',
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalS,
  },
  typeCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalM, textAlign: 'left', alignItems: 'flex-start',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
    cursor: 'pointer', minWidth: 0, width: '100%',
    transitionProperty: 'box-shadow, border-color', transitionDuration: tokens.durationNormal,
    ':hover': { boxShadow: tokens.shadow16, border: `1px solid ${tokens.colorBrandStroke1}` },
  },
  typeCardActive: {
    border: `2px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorBrandBackground2,
    boxShadow: tokens.shadow8,
  },
  typeHead: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    color: tokens.colorBrandForeground1, minWidth: 0, width: '100%',
  },
  typeIcon: { fontSize: '20px', flexShrink: 0 },
  typeTitle: { fontWeight: tokens.fontWeightSemibold, minWidth: 0, overflowWrap: 'anywhere' },
  typeDesc: {
    color: tokens.colorNeutralForeground3, minWidth: 0, overflowWrap: 'anywhere',
    display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
  },
  grid2: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: tokens.spacingHorizontalM },
  fields: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    maxHeight: '56vh', overflowY: 'auto', paddingRight: tokens.spacingHorizontalXS, minWidth: 0,
  },
  section: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2, minWidth: 0,
  },
  sectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  sectionHint: { color: tokens.colorNeutralForeground3 },
  switchRow: { display: 'flex', gap: tokens.spacingHorizontalXL, flexWrap: 'wrap', alignItems: 'center' },
  paramRow: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalS, paddingInline: tokens.spacingHorizontalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1, minWidth: 0,
  },
  paramHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  errorText: { color: tokens.colorPaletteRedForeground1 },
});

// ---------------------------------------------------------------------------
// Per-parameter binding mode. A pipeline parameter on a trigger can be sourced
// from a TRIGGER OUTPUT system variable (an ADF @-expression written verbatim
// into properties.pipelines[].parameters) OR from a value source (direct /
// Key Vault / App Config, resolved server-side by the BFF). 'trigger' is the
// ADF-native default for event triggers (the file name / subject / window
// times the run needs); 'value' falls back to the existing ParamSourcePicker.
// ---------------------------------------------------------------------------

type ParamMode = 'trigger' | 'value';

interface ParamMapping {
  mode: ParamMode;
  /** Selected trigger-output id (when mode === 'trigger'). */
  outputId: string;
  /** The expression (editable — supports data.<keyName> tweaks etc.) for mode 'trigger'. */
  expression: string;
  /** Value-source binding (when mode === 'value'). */
  binding: ParamBinding;
}

const EMPTY_MAPPING: ParamMapping = {
  mode: 'value', outputId: '', expression: '', binding: EMPTY_BINDING,
};

// ===========================================================================

export interface TriggerWizardProps {
  open: boolean;
  onClose: () => void;
  /**
   * Receives (name, properties, paramBindings) — the ADF trigger payload plus
   * the per-parameter VALUE bindings (direct / Key Vault / App Config). The
   * caller POSTs these; the BFF route resolves KV/App Config server-side and
   * merges the resolved literals into the trigger's pipeline `parameters`.
   * Trigger-output expression mappings are written directly into
   * `properties.pipelines[].parameters` / `properties.pipeline.parameters` so
   * they round-trip verbatim on the upsert.
   */
  onCreate: (
    name: string,
    properties: Record<string, unknown>,
    paramBindings: Record<string, ParamBinding>,
  ) => Promise<void>;
  /**
   * Optional — when supplied AND "Activate on create" is checked, the wizard
   * calls this after a successful create to issue the real start (PUT
   * action=start). When omitted, the activate toggle is hidden (the trigger is
   * created stopped and started from the trigger list).
   */
  onActivate?: (name: string) => Promise<void>;
  /** Declared parameters of the bound pipeline — rendered as a value source per param. */
  pipelineParams?: PipelineParameter[];
  /** Backend the storage-event picker lists linked services from. Defaults 'adf'. */
  engine?: LinkedServiceEngine;
  /** LOOM_PARAM_KEYVAULT configured (surfaced for the honest gate hint). */
  kvAvailable?: boolean;
  /** LOOM_PARAM_APPCONFIG configured (surfaced for the honest gate hint). */
  appConfigAvailable?: boolean;
  busy?: boolean;
  error?: string | null;
}

export function TriggerWizard({
  open, onClose, onCreate, onActivate, pipelineParams,
  engine = 'adf', kvAvailable = true, appConfigAvailable = true, busy, error,
}: TriggerWizardProps) {
  const styles = useStyles();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<TriggerKind>('ScheduleTrigger');
  const def = useMemo<TriggerTypeDef>(
    () => triggerTypeByKey(kind) ?? TRIGGER_TYPES[0],
    [kind],
  );

  // Structured per-type setting values keyed by the catalog ConfigField.key.
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  // The storage linked service the operator picked (for display / convenience);
  // the authoritative `scope` is the resolved resource id in settings.scope.
  const [storageLinkedService, setStorageLinkedService] = useState<string>('');

  // Per-parameter mapping (paramName -> ParamMapping). Reset on open.
  const [mappings, setMappings] = useState<Record<string, ParamMapping>>({});

  // Activate-on-create.
  const [activate, setActivate] = useState(false);

  // Reset all transient state whenever the dialog re-opens.
  useEffect(() => {
    if (!open) return;
    setName('');
    setKind('ScheduleTrigger');
    setSettings(defaultSettingsFor(TRIGGER_TYPES[0]));
    setStorageLinkedService('');
    setMappings({});
    setActivate(false);
  }, [open]);

  // When the type changes, seed that type's default settings (keep nothing
  // cross-type — each type's typeProperties are disjoint).
  const pickKind = (next: TriggerKind) => {
    setKind(next);
    const d = triggerTypeByKey(next);
    if (d) setSettings(defaultSettingsFor(d));
    setStorageLinkedService('');
  };

  const setSetting = (key: string, value: unknown) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  const mappingFor = (p: string): ParamMapping => mappings[p] ?? EMPTY_MAPPING;
  const setMappingFor = (p: string, patch: Partial<ParamMapping>) =>
    setMappings((prev) => ({ ...prev, [p]: { ...mappingFor(p), ...patch } }));

  // The fields actually shown for this type, honoring ConfigField.showIf
  // (e.g. weekly day-picker only for frequency Week, dependency offset only for
  // a self-dependency, etc.).
  const shownFields = useMemo<ConfigField[]>(
    () => def.settings.filter((f) => fieldVisible(f, settings)),
    [def, settings],
  );

  // -------------------------------------------------------------------------
  // Assemble the ADF trigger `properties` payload from the structured state.
  // -------------------------------------------------------------------------

  const properties = useMemo<Record<string, unknown>>(
    () => buildTriggerProperties(def, settings, mappings, activate),
    [def, settings, mappings, activate],
  );

  // The VALUE bindings handed to onCreate (only the 'value'-mode params); the
  // 'trigger'-mode params are already baked into properties.pipelines[].
  const valueBindings = useMemo<Record<string, ParamBinding>>(() => {
    const out: Record<string, ParamBinding> = {};
    for (const [pName, m] of Object.entries(mappings)) {
      if (m.mode === 'value') out[pName] = m.binding;
    }
    return out;
  }, [mappings]);

  // -------------------------------------------------------------------------
  // Validation — name + per-type required fields.
  // -------------------------------------------------------------------------

  const validation = useMemo(() => validateTrigger(def, name, settings), [def, name, settings]);
  const valid = validation.ok;

  const paramNames = (pipelineParams || []).map((p) => p.name);

  const submit = async () => {
    if (!valid) return;
    await onCreate(name.trim(), properties, valueBindings);
    // Activate-on-create: ask the caller to start the trigger right after the
    // create succeeds. The caller controls busy/error; if the create failed it
    // surfaces via `error` and we never get a clean unmount, so the start only
    // fires on a successful create flow (the dialog stays open on error).
    if (activate && onActivate) {
      try { await onActivate(name.trim()); } catch { /* surfaced by caller toast */ }
    }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: 720 }}>
        <DialogBody>
          <DialogTitle>New trigger</DialogTitle>
          <DialogContent>
            <div className={styles.fields}>
              {/* -------- Name -------- */}
              <Field
                label="Name"
                required
                validationState={name && !validation.fields.name ? undefined : (name ? 'error' : undefined)}
                validationMessage={name && validation.fields.name ? validation.fields.name : undefined}
              >
                <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="daily-load" />
              </Field>

              {/* -------- Type picker (data-driven from the catalog) -------- */}
              <Field label="Type">
                <div className={styles.typeRow}>
                  {TRIGGER_TYPES.map((t) => {
                    const Icon = TYPE_GLYPH[t.type];
                    const active = kind === t.type;
                    return (
                      <button
                        key={t.type}
                        type="button"
                        className={`${styles.typeCard} ${active ? styles.typeCardActive : ''}`}
                        onClick={() => pickKind(t.type)}
                        aria-pressed={active}
                        aria-label={`${t.displayName} trigger`}
                      >
                        <span className={styles.typeHead}>
                          <Icon className={styles.typeIcon} />
                          <Text className={styles.typeTitle}>{t.displayName}</Text>
                        </span>
                        <Caption1 className={styles.typeDesc}>{t.description}</Caption1>
                      </button>
                    );
                  })}
                </div>
              </Field>

              {/* -------- Type-specific config form -------- */}
              <div className={styles.section}>
                <div className={styles.sectionHead}>
                  <Clock20Regular />
                  <Subtitle2>{configHeading(kind)}</Subtitle2>
                </div>

                {/* Storage-event trigger: linked-service convenience picker that
                    resolves a storage account, written into the `scope` field. */}
                {kind === 'BlobEventsTrigger' && (
                  <>
                    <LinkedServicePicker
                      engine={engine}
                      label="Storage linked service (optional helper)"
                      value={storageLinkedService}
                      onSelected={setStorageLinkedService}
                    />
                    <Caption1 className={styles.sectionHint}>
                      Pick the Azure Storage (ADLS Gen2 / Blob) connection to identify
                      the account, then paste its ARM resource ID below — Data Factory
                      registers the Event Grid subscription on that account&apos;s scope.
                    </Caption1>
                  </>
                )}

                {/* Two-up the date-ish + interval fields when this type is a
                    recurrence (schedule / tumbling); event types render single-col. */}
                <TypeFields
                  def={def}
                  fields={shownFields}
                  values={settings}
                  errors={validation.fields}
                  onChange={setSetting}
                  paramNames={paramNames}
                  grid2={styles.grid2}
                />

                {(def.supportsBackfill || def.supportsRetry || def.supportsConcurrency) && (
                  <Caption1 className={styles.sectionHint}>
                    <Branch20Regular style={{ verticalAlign: 'middle' }} />{' '}
                    Tumbling-window triggers run contiguous, stateful windows — set the
                    series start in the past to backfill, and use a dependency to gate
                    a window on a prior window of this or another trigger.
                  </Caption1>
                )}
              </div>

              {/* -------- Trigger parameters (output → pipeline-param mapping) -------- */}
              {pipelineParams && pipelineParams.length > 0 && (
                <div className={styles.section}>
                  <div className={styles.sectionHead}>
                    <Link20Regular />
                    <Subtitle2>Trigger parameters</Subtitle2>
                    <Badge appearance="tint" color="informative">Passed each run</Badge>
                  </div>
                  <Caption1 className={styles.sectionHint}>
                    Supply each declared pipeline parameter every time the trigger
                    fires — from a TRIGGER OUTPUT (system variable such as the file
                    name or window start time) or a value source (a literal, a Key
                    Vault secret, or an App Configuration key). Trigger-output
                    expressions are written into the trigger&apos;s pipeline
                    reference; value sources are resolved when the trigger is created.
                  </Caption1>

                  {pipelineParams.map((p) => {
                    const m = mappingFor(p.name);
                    return (
                      <div key={p.name} className={styles.paramRow}>
                        <div className={styles.paramHead}>
                          <Text weight="semibold"><code>{p.name}</code></Text>
                          <Badge appearance="outline" color="subtle">{p.type}</Badge>
                        </div>

                        <Field label="Source">
                          <Dropdown
                            value={m.mode === 'trigger' ? 'Trigger output' : 'Value source'}
                            selectedOptions={[m.mode]}
                            onOptionSelect={(_, d) => {
                              if (d.optionValue) setMappingFor(p.name, { mode: d.optionValue as ParamMode });
                            }}
                          >
                            <Option value="trigger" text="Trigger output">Trigger output (system variable)</Option>
                            <Option value="value" text="Value source">Value source (direct / Key Vault / App Config)</Option>
                          </Dropdown>
                        </Field>

                        {m.mode === 'trigger' ? (
                          <TriggerOutputMapper
                            outputs={def.outputs}
                            mapping={m}
                            paramNames={paramNames}
                            onChange={(patch) => setMappingFor(p.name, patch)}
                          />
                        ) : (
                          <ParamSourcePicker
                            binding={m.binding}
                            onChange={(next) => setMappingFor(p.name, { binding: next })}
                            paramType={p.type}
                            kvAvailable={kvAvailable}
                            appConfigAvailable={appConfigAvailable}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* -------- Activate on create + start/stop -------- */}
              <Divider />
              {onActivate ? (
                <div className={styles.switchRow}>
                  <Switch
                    label="Activate on create (start the trigger immediately)"
                    checked={activate}
                    onChange={(_, d) => setActivate(d.checked)}
                  />
                  <Tooltip
                    content="When off, the trigger is created in a Stopped state — start it from the trigger list below."
                    relationship="description"
                  >
                    <Badge appearance="tint" color={activate ? 'success' : 'subtle'}>
                      {activate ? 'Will start' : 'Created stopped'}
                    </Badge>
                  </Tooltip>
                </div>
              ) : (
                <Text size={200} className={styles.sectionHint}>
                  <Badge appearance="tint" color="informative">Created stopped</Badge>{' '}
                  The trigger is created in a stopped state — start it from the trigger list.
                </Text>
              )}

              {error && <Text size={200} className={styles.errorText}>{error}</Text>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button appearance="primary" disabled={!valid || busy} onClick={submit}>
              {busy ? 'Creating…' : (activate && onActivate ? 'Create & start' : 'Create trigger')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ===========================================================================
// Type-specific field renderer — drives one control per catalog ConfigField,
// upgrading select-of-known-domains to richer controls (weekday multiselect,
// switch for boolean) and dynamic-capable text to the shared ExpressionField.
// ===========================================================================

const WEEK_DAY_OPTIONS = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
];

function TypeFields({
  def, fields, values, errors, onChange, paramNames, grid2,
}: {
  def: TriggerTypeDef;
  fields: ConfigField[];
  values: Record<string, unknown>;
  errors: Record<string, string | undefined>;
  onChange: (key: string, value: unknown) => void;
  paramNames: string[];
  grid2: string;
}) {
  // Pair adjacent "small" fields (number / short text) into two-up rows the way
  // the ADF recurrence panel does (interval next to recurrence, start next to
  // end, retry count next to interval). We pair by a curated key-adjacency list
  // per type; everything else renders full width.
  const pairs = PAIR_KEYS[def.type] || [];

  const rendered = new Set<string>();
  const out: React.ReactNode[] = [];

  for (const f of fields) {
    if (rendered.has(f.key)) continue;
    const pair = pairs.find((p) => p[0] === f.key || p[1] === f.key);
    const partnerKey = pair ? (pair[0] === f.key ? pair[1] : pair[0]) : undefined;
    const partner = partnerKey ? fields.find((x) => x.key === partnerKey) : undefined;

    if (partner) {
      rendered.add(f.key); rendered.add(partner.key);
      out.push(
        <div key={`${f.key}|${partner.key}`} className={grid2}>
          <TriggerFieldControl field={f} value={values[f.key]} error={errors[f.key]} onChange={(v) => onChange(f.key, v)} paramNames={paramNames} />
          <TriggerFieldControl field={partner} value={values[partner.key]} error={errors[partner.key]} onChange={(v) => onChange(partner.key, v)} paramNames={paramNames} />
        </div>,
      );
    } else {
      rendered.add(f.key);
      out.push(
        <TriggerFieldControl key={f.key} field={f} value={values[f.key]} error={errors[f.key]} onChange={(v) => onChange(f.key, v)} paramNames={paramNames} />,
      );
    }
  }
  return <>{out}</>;
}

/** Adjacent-key pairs to render two-up per trigger type. */
const PAIR_KEYS: Partial<Record<TriggerKind, [string, string][]>> = {
  ScheduleTrigger: [
    ['frequency', 'interval'],
    ['startTime', 'endTime'],
    ['scheduleHours', 'scheduleMinutes'],
  ],
  TumblingWindowTrigger: [
    ['frequency', 'interval'],
    ['startTime', 'endTime'],
    ['delay', 'maxConcurrency'],
    ['retryCount', 'retryIntervalInSeconds'],
  ],
  BlobEventsTrigger: [
    ['blobPathBeginsWith', 'blobPathEndsWith'],
    ['eventBlobCreated', 'eventBlobDeleted'],
  ],
  CustomEventsTrigger: [
    ['subjectBeginsWith', 'subjectEndsWith'],
  ],
};

function TriggerFieldControl({
  field, value, error, onChange, paramNames,
}: {
  field: ConfigField;
  value: unknown;
  error?: string;
  onChange: (v: unknown) => void;
  paramNames: string[];
}) {
  // Weekly day-picker — a multiselect dropdown over the seven days. Stored as a
  // comma-separated string in settings (assembled into schedule.weekDays at
  // build time) so it round-trips through the same comma parsing as the portal.
  if (field.key === 'scheduleWeekDays') {
    const selected = splitList(typeof value === 'string' ? value : '');
    return (
      <Field label={field.label} hint={field.hint} required={field.required} validationMessage={error}>
        <Dropdown
          multiselect
          placeholder="Select weekdays"
          value={selected.join(', ')}
          selectedOptions={selected}
          onOptionSelect={(_, d) => onChange(d.selectedOptions.join(', '))}
        >
          {WEEK_DAY_OPTIONS.map((w) => <Option key={w} value={w}>{w}</Option>)}
        </Dropdown>
      </Field>
    );
  }

  if (field.kind === 'boolean') {
    return (
      <Field label="" hint={field.hint} validationMessage={error}>
        <Switch
          label={field.label}
          checked={value === true}
          onChange={(_, d) => onChange(d.checked)}
        />
      </Field>
    );
  }

  if (field.kind === 'select') {
    const opts = field.options || [];
    const cur = value === undefined || value === null ? '' : String(value);
    const curLabel = opts.find((o) => o.value === cur)?.label || cur;
    return (
      <Field label={field.label} hint={field.hint} required={field.required} validationMessage={error}>
        <Dropdown
          placeholder="Select…"
          value={curLabel}
          selectedOptions={cur ? [cur] : []}
          onOptionSelect={(_, d) => { if (d.optionValue !== undefined) onChange(d.optionValue); }}
        >
          {opts.map((o) => <Option key={o.value} value={o.value} text={o.label}>{o.label}</Option>)}
        </Dropdown>
      </Field>
    );
  }

  if (field.kind === 'number') {
    return (
      <Field label={field.label} hint={field.hint} required={field.required} validationMessage={error}>
        <Input
          type="number"
          value={value === undefined || value === null ? '' : String(value)}
          placeholder={field.placeholder}
          onChange={(_, d) => onChange(d.value)}
        />
      </Field>
    );
  }

  // Dynamic-capable text (path / subject filters) → the shared ExpressionField so
  // a filter parameterised by an @{…} expression gets the "Add dynamic content"
  // affordance; the @-string round-trips verbatim onto typeProperties.
  if (field.supportsDynamic && field.kind === 'text') {
    return (
      <ExpressionField
        label={field.label}
        hint={field.hint}
        required={field.required}
        placeholder={field.placeholder}
        supportsDynamic
        availableParams={paramNames}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(next) => onChange(next)}
      />
    );
  }

  // multiline / text / password
  return (
    <Field label={field.label} hint={field.hint} required={field.required} validationMessage={error}>
      <Input
        type={field.secret ? 'password' : 'text'}
        value={value === undefined || value === null ? '' : String(value)}
        placeholder={field.placeholder}
        onChange={(_, d) => onChange(d.value)}
      />
    </Field>
  );
}

// ===========================================================================
// Trigger-output → pipeline-param mapper. Pick a system variable; for the
// custom-event free-form `data.<keyName>` output the expression stays editable
// so the operator targets a specific data field. Other params/variables are not
// offered here (a trigger run has no pipeline context yet) — the ExpressionField
// is shown read-as-typed but lets the operator hand-edit the @-expression.
// ===========================================================================

function TriggerOutputMapper({
  outputs, mapping, paramNames, onChange,
}: {
  outputs: TriggerOutputVar[];
  mapping: ParamMapping;
  paramNames: string[];
  onChange: (patch: Partial<ParamMapping>) => void;
}) {
  const selected = outputs.find((o) => o.id === mapping.outputId);
  return (
    <>
      <Field label="Trigger output" hint={selected?.description}>
        <Dropdown
          placeholder="Select a trigger output…"
          value={selected?.label || ''}
          selectedOptions={mapping.outputId ? [mapping.outputId] : []}
          onOptionSelect={(_, d) => {
            const o = outputs.find((x) => x.id === d.optionValue);
            if (o) onChange({ outputId: o.id, expression: o.expression });
          }}
        >
          {outputs.map((o) => (
            <Option key={o.id} value={o.id} text={o.label}>{o.label} · {o.expression}</Option>
          ))}
        </Dropdown>
      </Field>
      {mapping.outputId && (
        <ExpressionField
          label="Expression"
          hint="The ADF expression passed to the pipeline parameter. Edit the data.<keyName> suffix for custom-event payload fields."
          supportsDynamic
          availableParams={paramNames}
          value={mapping.expression || selected?.expression || ''}
          onChange={(next) => onChange({ expression: next })}
        />
      )}
    </>
  );
}

// ===========================================================================
// Pure helpers — defaults, visibility, validation, and the ARM properties build.
// All exported for unit testing the wire format.
// ===========================================================================

/** A type's default setting values (sensible ADF defaults, capitalised enums). */
export function defaultSettingsFor(def: TriggerTypeDef): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  for (const f of def.settings) {
    if (f.kind === 'boolean') base[f.key] = false;
  }
  if (def.type === 'ScheduleTrigger' || def.type === 'TumblingWindowTrigger') {
    base.frequency = def.type === 'TumblingWindowTrigger' ? 'Hour' : 'Day';
    base.interval = '1';
    base.startTime = isoUtcNow();
    if (def.type === 'ScheduleTrigger') base.timeZone = 'UTC';
    if (def.type === 'TumblingWindowTrigger') {
      base.maxConcurrency = '1';
      base.retryCount = '0';
      base.retryIntervalInSeconds = '30';
      base.dependencyKind = 'none';
    }
  }
  if (def.type === 'BlobEventsTrigger') {
    base.eventBlobCreated = true;
    base.eventBlobDeleted = false;
    base.ignoreEmptyBlobs = true;
  }
  return base;
}

/** Whether a ConfigField is visible given the current values (showIf). */
export function fieldVisible(f: ConfigField, values: Record<string, unknown>): boolean {
  if (!f.showIf) return true;
  const cur = values[f.showIf.key];
  return cur !== undefined && String(cur) === f.showIf.equals;
}

function splitList(s: string): string[] {
  return (s || '').split(',').map((x) => x.trim()).filter(Boolean);
}
function numList(s: string): number[] {
  return splitList(s).map(Number).filter((n) => Number.isFinite(n));
}
function asNum(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

/** Validate the name + per-type required fields. */
export function validateTrigger(
  def: TriggerTypeDef,
  name: string,
  values: Record<string, unknown>,
): { ok: boolean; fields: Record<string, string | undefined> } {
  const fields: Record<string, string | undefined> = {};
  const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,259}$/;
  if (!name.trim()) fields.name = 'Name is required.';
  else if (!NAME_RE.test(name.trim())) fields.name = 'Letters, digits, spaces, underscore, and hyphen only (start alphanumeric).';

  for (const f of def.settings) {
    if (!f.required) continue;
    if (!fieldVisible(f, values)) continue;
    const v = values[f.key];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      fields[f.key] = `${f.label} is required.`;
    }
  }
  // Storage-event trigger must select at least one event.
  if (def.type === 'BlobEventsTrigger' && values.eventBlobCreated !== true && values.eventBlobDeleted !== true) {
    fields.eventBlobCreated = 'Select at least one event (created / deleted).';
  }
  return { ok: Object.keys(fields).length === 0, fields };
}

/**
 * Assemble the full ADF trigger `properties` object from the wizard state.
 * `properties.type`, `runtimeState`, the type-specific `typeProperties`, and —
 * when a trigger-output mapping exists — the `pipelines[].parameters` /
 * `pipeline.parameters` (with the @-expression literal). Value-source params are
 * NOT written here; the BFF resolves and merges them.
 */
export function buildTriggerProperties(
  def: TriggerTypeDef,
  values: Record<string, unknown>,
  mappings: Record<string, ParamMapping>,
  activate: boolean,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: def.type,
    runtimeState: activate ? 'Started' : 'Stopped',
  };

  if (def.type === 'ScheduleTrigger') {
    const schedule: Record<string, unknown> = {};
    const hours = numList(str(values.scheduleHours));
    const minutes = numList(str(values.scheduleMinutes));
    const weekDays = splitList(str(values.scheduleWeekDays));
    const monthDays = numList(str(values.scheduleMonthDays));
    const occurrences = parseMonthlyOccurrences(str(values.scheduleMonthlyOccurrences));
    if (hours.length) schedule.hours = hours;
    if (minutes.length) schedule.minutes = minutes;
    if (weekDays.length) schedule.weekDays = weekDays;
    if (monthDays.length) schedule.monthDays = monthDays;
    if (occurrences.length) schedule.monthlyOccurrences = occurrences;
    base.typeProperties = {
      recurrence: {
        frequency: str(values.frequency) || 'Day',
        interval: asNum(values.interval, 1),
        startTime: str(values.startTime) || isoUtcNow(),
        timeZone: str(values.timeZone) || 'UTC',
        ...(str(values.endTime) ? { endTime: str(values.endTime) } : {}),
        ...(Object.keys(schedule).length ? { schedule } : {}),
      },
    };
  } else if (def.type === 'TumblingWindowTrigger') {
    const tp: Record<string, unknown> = {
      frequency: str(values.frequency) || 'Hour',
      interval: asNum(values.interval, 1),
      startTime: str(values.startTime) || isoUtcNow(),
      maxConcurrency: asNum(values.maxConcurrency, 1),
      ...(str(values.endTime) ? { endTime: str(values.endTime) } : {}),
      ...(str(values.delay) ? { delay: str(values.delay) } : {}),
      retryPolicy: {
        count: asNum(values.retryCount, 0),
        intervalInSeconds: asNum(values.retryIntervalInSeconds, 30),
      },
    };
    const dep = buildDependsOn(values);
    if (dep) tp.dependsOn = dep;
    base.typeProperties = tp;
  } else if (def.type === 'BlobEventsTrigger') {
    const events: string[] = [];
    if (values.eventBlobCreated === true) events.push('Microsoft.Storage.BlobCreated');
    if (values.eventBlobDeleted === true) events.push('Microsoft.Storage.BlobDeleted');
    base.typeProperties = {
      ...(str(values.blobPathBeginsWith) ? { blobPathBeginsWith: str(values.blobPathBeginsWith) } : {}),
      ...(str(values.blobPathEndsWith) ? { blobPathEndsWith: str(values.blobPathEndsWith) } : {}),
      ignoreEmptyBlobs: values.ignoreEmptyBlobs !== false,
      scope: str(values.scope),
      events,
    };
  } else {
    // CustomEventsTrigger
    base.typeProperties = {
      scope: str(values.scope),
      events: splitList(str(values.events)),
      ...(str(values.subjectBeginsWith) ? { subjectBeginsWith: str(values.subjectBeginsWith) } : {}),
      ...(str(values.subjectEndsWith) ? { subjectEndsWith: str(values.subjectEndsWith) } : {}),
    };
  }

  // Trigger-output parameter mappings → pipeline reference parameters. Only the
  // 'trigger'-mode params are written here as @-expression literals. The BFF
  // injects the actual pipelineReference.referenceName (this pipeline) and
  // merges resolved value-source params on top, so we emit a parameters-only
  // reference scaffold the route fills in.
  const triggerParams: Record<string, unknown> = {};
  for (const [pName, m] of Object.entries(mappings)) {
    if (m.mode === 'trigger') {
      const expr = (m.expression || '').trim();
      if (expr) triggerParams[pName] = expr;
    }
  }
  if (Object.keys(triggerParams).length) {
    if (def.pipelineReference === 'single') {
      base.pipeline = { parameters: triggerParams };
    } else {
      base.pipelines = [{ parameters: triggerParams }];
    }
  }

  return base;
}

/**
 * Build the tumbling-window `dependsOn[]` DependencyReference array from the
 * dependency settings. Returns undefined when no dependency is configured.
 *   - self    → SelfDependencyTumblingWindowTriggerReference { type, offset, size? }
 *   - trigger → TumblingWindowTriggerDependencyReference
 *               { type, referenceTrigger:{ referenceName, type }, offset?, size? }
 */
export function buildDependsOn(values: Record<string, unknown>): unknown[] | undefined {
  const kind = str(values.dependencyKind);
  if (kind === 'self') {
    const offset = str(values.dependencyOffset);
    return [{
      type: 'SelfDependencyTumblingWindowTriggerReference',
      ...(offset ? { offset } : {}),
      ...(str(values.dependencySize) ? { size: str(values.dependencySize) } : {}),
    }];
  }
  if (kind === 'trigger') {
    const refName = str(values.dependencyTrigger);
    if (!refName) return undefined;
    return [{
      type: 'TumblingWindowTriggerDependencyReference',
      referenceTrigger: { referenceName: refName, type: 'TriggerReference' },
      ...(str(values.dependencyOffsetTrigger) ? { offset: str(values.dependencyOffsetTrigger) } : {}),
      ...(str(values.dependencySizeTrigger) ? { size: str(values.dependencySizeTrigger) } : {}),
    }];
  }
  return undefined;
}

/**
 * Parse a comma-separated "day:occurrence" list (e.g. "friday:1, friday:-1")
 * into the ARM `monthlyOccurrences` array
 * [{ day:'Friday', occurrence:1 }, …]. Day is title-cased; bad pairs are skipped.
 */
export function parseMonthlyOccurrences(s: string): { day: string; occurrence: number }[] {
  const out: { day: string; occurrence: number }[] = [];
  for (const part of splitList(s)) {
    const [d, o] = part.split(':').map((x) => x.trim());
    if (!d || o === undefined) continue;
    const occ = Number(o);
    if (!Number.isFinite(occ)) continue;
    out.push({ day: d.charAt(0).toUpperCase() + d.slice(1).toLowerCase(), occurrence: occ });
  }
  return out;
}

function configHeading(kind: TriggerKind): string {
  switch (kind) {
    case 'ScheduleTrigger': return 'Recurrence';
    case 'TumblingWindowTrigger': return 'Window & dependencies';
    case 'BlobEventsTrigger': return 'Storage event source';
    case 'CustomEventsTrigger': return 'Event Grid source';
    default: return 'Configuration';
  }
}

/** Now as an ISO-8601 UTC string `yyyy-MM-ddTHH:mm:ssZ` (ADF startTime format). */
function isoUtcNow(): string {
  const d = new Date();
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
