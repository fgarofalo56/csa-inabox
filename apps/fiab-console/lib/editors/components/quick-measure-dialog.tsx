'use client';

/**
 * QuickMeasureDialog — Azure-native parity with the Power BI / Fabric Model view
 * "New quick measure" experience, rebuilt one-for-one in the Loom Model view
 * (`.claude/rules/ui-parity.md`).
 *
 * In Power BI a "quick measure" is a TEMPLATE GALLERY: pick a template
 * (Year-to-date, Year-over-year %, Running total, Average per category,
 * % of total, Rank, Star rating…), fill a handful of structured field slots
 * (a base measure, a date column, a category column), and the tool GENERATES the
 * DAX — the user never writes DAX by hand. This surface rebuilds exactly that: a
 * card gallery of templates → only the chosen template's typed field pickers →
 * a read-only generated-DAX preview → save.
 *
 * The template registry + DAX generators live in the pure, credential-free
 * `lib/azure/quick-measure-templates.ts` (shared, unit-testable, no React / no
 * network). This component is only the Fluent v9 surface over it.
 *
 * loom_no_freeform_config (`.claude/rules/loom_no_freeform_config`): there is NO
 * hand-written DAX box anywhere. Every measure is produced by a template's
 * deterministic `generate()` from STRUCTURED pickers (Dropdowns over the model's
 * real measures/columns + a numeric star-ceiling SpinButton). The generated DAX
 * is shown read-only; only the measure NAME is editable.
 *
 * NO-FABRIC-DEPENDENCY (`.claude/rules/no-fabric-dependency.md`): nothing here
 * requires a Power BI / Fabric / AAS workspace. On confirm the generated measure
 * is POSTed to the semantic-model model BFF
 * (`/api/items/semantic-model/<id>/model?kind=measure`) — the tabular/DAX path,
 * which persists it Azure-native onto `item.state.model.measures` as a DAX
 * measure (storage kind `cosmos`, never a SQL TVF) — the SAME slot the DAX
 * Copilot (`dax-tools`) and the `/query` DAX path already read — so the quick
 * measure immediately drives real query results. The full surface renders and
 * saves with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
 *
 * NO-VAPORWARE (`.claude/rules/no-vaporware.md`): every control is wired. The
 * field pickers populate from the REAL loaded model schema passed via props (no
 * mock columns). The primary button POSTs to a real route and surfaces the
 * backend + steps it returns; a failure renders an honest error MessageBar (no
 * fake "Saved!"); the measure list is seeded from the model's real persisted
 * measures, never a placeholder array.
 *
 * web3-ui (`.claude/rules/web3-ui.md`): Fluent v9 + Loom tokens only (no raw
 * px/hex), the dialog chrome matches the sibling what-if / aggregation dialogs,
 * EmptyState for the empty gallery, elevated hover-lift cards, dark-legible.
 */

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Caption1, Body1, Subtitle2, Field, Input, Dropdown, Option, SpinButton, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle, Badge, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Sparkle24Regular, Sparkle20Regular, Add20Regular, Code16Regular,
  ArrowLeft20Regular, CheckmarkCircle16Filled,
  CalendarLtr24Regular, ArrowTrendingLines24Regular, DataArea24Regular,
  TextBulletListSquare24Regular, DataPie24Regular, NumberSymbol24Regular, Star24Regular,
} from '@fluentui/react-icons';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { EmptyState } from '@/lib/components/empty-state';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { clientFetch } from '@/lib/client-fetch';
import {
  quickMeasureTemplates, isQuickMeasureComplete,
  type QuickMeasureTemplate, type QuickMeasureField, type QuickMeasurePicks,
  type QuickMeasureFieldPick,
} from '@/lib/azure/quick-measure-templates';

// ── Permissive model-schema shapes (the canvas / model-route GET shapes) ──────
//
// Accepted loosely so any model-bearing editor (warehouse / synapse / databricks
// / semantic-model) can feed its already-loaded tables + measures straight in.

interface QmColumn { name: string; type?: string; dataType?: string; isPk?: boolean }
interface QmTable { name: string; schema?: string; columns?: QmColumn[] }
interface QmMeasure { name: string; expression?: string }

interface QuickMeasureDialogProps {
  /** The owned model item — drives the POST route + seeds the measure list. */
  item: WorkspaceItem;
  /** The model item id (route path segment). */
  id: string;
  /** Optional live Power BI/Fabric dataset id — kept for the shared
   *  ModelTabsExtra prop contract; unused on the Azure-native default path. */
  datasetId?: string;
  /** Real loaded model tables (the column pickers populate from these). */
  tables?: QmTable[];
  /** Real persisted model measures (the base-measure picker + context list). */
  measures?: QmMeasure[];
  /** Called after a successful save so the parent can refresh its model view. */
  onSaved?: () => void;
}

// ── Template-icon mapping (the registry stores a Fluent icon NAME string) ─────

const TEMPLATE_ICONS: Record<string, ReactNode> = {
  CalendarLtr: <CalendarLtr24Regular />,
  ArrowTrendingLines: <ArrowTrendingLines24Regular />,
  DataArea: <DataArea24Regular />,
  TextBulletListSquare: <TextBulletListSquare24Regular />,
  DataPie: <DataPie24Regular />,
  NumberSymbol: <NumberSymbol24Regular />,
  Star: <Star24Regular />,
};
function iconFor(name?: string): ReactNode {
  return (name && TEMPLATE_ICONS[name]) || <Sparkle24Regular />;
}

// ── Schema → picker options ───────────────────────────────────────────────────

interface PickOption { value: string; label: string; pick: QuickMeasureFieldPick; isDate?: boolean }

function colType(c: QmColumn): string {
  return String(c.type ?? c.dataType ?? '').toLowerCase();
}
function isDateType(t: string): boolean {
  return /date|time/.test(t);
}

/** Seed the model-measure list off the persisted item state (back-compat). */
function seedMeasures(item: WorkspaceItem, fromProps: QmMeasure[]): QmMeasure[] {
  if (fromProps.length) return fromProps;
  const model = (item.state as Record<string, unknown> | undefined)?.model as { measures?: unknown } | undefined;
  const raw = model?.measures;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is QmMeasure => !!m && typeof (m as QmMeasure).name === 'string')
    .map((m) => ({ name: m.name, expression: (m as QmMeasure).expression }));
}

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

  // Saved-measure card — elevated, hover-lift, matches the marketplace tiles.
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

  // Template gallery card — clickable, button-like, accent on hover.
  template: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, alignItems: 'flex-start',
    padding: tokens.spacingVerticalL,
    textAlign: 'left',
    cursor: 'pointer',
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow4,
    color: tokens.colorNeutralForeground1,
    transitionDuration: tokens.durationNormal,
    transitionProperty: 'box-shadow, transform, border-color',
    ':hover': {
      boxShadow: tokens.shadow16, transform: 'translateY(-2px)',
      borderColor: tokens.colorBrandStroke1,
    },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: tokens.spacingHorizontalXXS },
  },
  templateIcon: {
    color: tokens.colorBrandForeground1,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground2,
  },
  templateTitle: { fontWeight: tokens.fontWeightSemibold },
  templateCaption: { color: tokens.colorNeutralForeground3 },

  // Read-only generated-DAX preview block (the only "code" surface).
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
  emptyPreview: { color: tokens.colorNeutralForeground3, fontStyle: 'italic' },

  dialogBody: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: '560px', maxWidth: '720px' },
  steps: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, marginTop: tokens.spacingVerticalXS },
  stepLine: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, color: tokens.colorNeutralForeground2 },
});

type DialogStep = 'gallery' | 'configure';

export function QuickMeasureDialog({ item, id, datasetId, tables = [], measures = [], onSaved }: QuickMeasureDialogProps) {
  const s = useStyles();

  // Model-measure list (existing + locally-created this session, dedup by name).
  const [created, setCreated] = useState<QmMeasure[]>([]);
  const seeded = useMemo(() => seedMeasures(item, measures), [item, measures]);
  const allMeasures = useMemo(() => {
    const byName = new Map<string, QmMeasure>();
    for (const m of seeded) byName.set(m.name, m);
    for (const m of created) byName.set(m.name, m);
    return [...byName.values()];
  }, [seeded, created]);

  // Picker pools built from the REAL loaded schema.
  const measureOptions = useMemo<PickOption[]>(
    () => allMeasures.map((m) => ({ value: `m::${m.name}`, label: m.name, pick: { measure: m.name } })),
    [allMeasures],
  );
  const columnOptions = useMemo<PickOption[]>(() => {
    const out: PickOption[] = [];
    for (const t of tables) {
      for (const c of t.columns ?? []) {
        out.push({
          value: `c::${t.name}::${c.name}`,
          label: `${t.name} · ${c.name}`,
          pick: { table: t.name, column: c.name },
          isDate: isDateType(colType(c)),
        });
      }
    }
    return out;
  }, [tables]);
  const dateColumnOptions = useMemo<PickOption[]>(
    () => [...columnOptions].sort((a, b) => Number(!!b.isDate) - Number(!!a.isDate)),
    [columnOptions],
  );

  // Flat value→option index (values are globally unique) for pick resolution.
  const optionByValue = useMemo(() => {
    const m = new Map<string, PickOption>();
    for (const o of measureOptions) m.set(o.value, o);
    for (const o of columnOptions) m.set(o.value, o);
    return m;
  }, [measureOptions, columnOptions]);

  function poolForField(field: QuickMeasureField): PickOption[] {
    if (field.kind === 'measure') return measureOptions;
    if (field.kind === 'dateColumn') return dateColumnOptions;
    return columnOptions; // 'column' | 'category'
  }

  // Dialog + step state.
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<DialogStep>('gallery');
  const [tpl, setTpl] = useState<QuickMeasureTemplate | null>(null);

  // Per-field selected option value (UI), + scalar options + name override.
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [maxRating, setMaxRating] = useState(5);
  const [nameOverride, setNameOverride] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [backend, setBackend] = useState<string | null>(null);

  // Resolve the registry's `picks` shape from the selected option values.
  const picks: QuickMeasurePicks = useMemo(() => {
    const out: QuickMeasurePicks = {};
    if (tpl) for (const f of tpl.fields) out[f.key] = optionByValue.get(selected[f.key] || '')?.pick;
    return out;
  }, [tpl, selected, optionByValue]);

  const complete = !!tpl && isQuickMeasureComplete(tpl, picks);
  const usesRating = tpl?.key === 'starRating';

  // Generate only when complete (the registry's generate() throws on partial).
  const generated = useMemo(() => {
    if (!tpl || !complete) return null;
    try { return tpl.generate(picks, usesRating ? { maxRating } : undefined); }
    catch { return null; }
  }, [tpl, complete, picks, usesRating, maxRating]);

  const effectiveName = nameOverride ?? generated?.name ?? '';
  // DAX measure names may contain spaces; only brackets are disallowed.
  const nameValid = effectiveName.trim().length > 0 && !/[[\]]/.test(effectiveName);

  // Which picker pools the chosen template needs, and whether they're empty —
  // drives an honest "load schema / create a base measure first" gate.
  const needsMeasure = !!tpl && tpl.fields.some((f) => f.kind === 'measure');
  const needsColumn = !!tpl && tpl.fields.some((f) => f.kind !== 'measure');
  const blocked: string | null =
    needsMeasure && measureOptions.length === 0
      ? 'This model has no measures yet. Create a base measure first — quick measures build on an existing measure.'
      : needsColumn && columnOptions.length === 0
        ? "This model's tables aren't loaded yet. Load the model schema so the column pickers can populate."
        : null;

  const canSave = complete && nameValid && !blocked && !busy;

  function reset() {
    setSelected({}); setMaxRating(5); setNameOverride(null); setError(null);
  }
  function openGallery() {
    reset(); setSteps([]); setBackend(null); setTpl(null); setStep('gallery'); setOpen(true);
  }
  function chooseTemplate(t: QuickMeasureTemplate) {
    reset(); setTpl(t); setStep('configure');
  }

  async function save() {
    if (!tpl || !generated || !canSave) return;
    setBusy(true); setError(null); setSteps([]); setBackend(null);

    const name = effectiveName.trim();
    // A quick measure is TABULAR DAX (TOTALYTD / RANKX / SAMEPERIODLASTYEAR …),
    // never T-SQL, so it persists on the tabular/DAX path: the semantic-model
    // model route stores it Azure-native onto `state.model.measures` as a DAX
    // measure — the SAME slot dax-tools + the `/query` DAX path read. We do NOT
    // route by `item.itemType`: a warehouse / Synapse / Databricks model route
    // would wrap the expression in `CREATE FUNCTION … RETURNS TABLE AS RETURN
    // (<DAX>)` and run it as invalid T-SQL. This matches the sibling Wave-3
    // dialogs (what-if / calculated-table), which also POST to this route.
    const url = `/api/items/semantic-model/${encodeURIComponent(id)}/model?kind=measure`;
    // Derive a table context from any column pick (measure refs are global).
    const table = tpl.fields.map((f) => picks[f.key]?.table).find(Boolean);
    const measure = {
      name,
      expression: generated.expression,
      // 'cosmos' is the storage MeasureKind for a DAX/tabular measure kept in
      // Cosmos (no SQL schema, never materialized as a TVF). model-store accepts
      // only {tvf,scalar,cosmos}; the previous 'dax' tag was not a MeasureKind
      // and silently coerced to the route default ('tvf' on the SQL engines).
      kind: 'cosmos' as const,
      table,
      description: `${tpl.title} (quick measure)`,
    };

    try {
      const res = await clientFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ measure }),
      });
      let j: {
        ok?: boolean;
        measure?: QmMeasure;
        measures?: QmMeasure[];
        model?: { measures?: QmMeasure[] };
        backend?: string;
        steps?: string[];
        persisted?: boolean;
        notice?: string;
        error?: string;
        message?: string;
      };
      try { j = await res.json(); }
      catch { j = { ok: false, error: `Unexpected non-JSON response (HTTP ${res.status})` }; }

      if (!res.ok || j.ok === false) {
        setError(j.error || j.message || `Save failed (HTTP ${res.status}).`);
        if (Array.isArray(j.steps)) setSteps(j.steps);
        return;
      }

      // Honest no-vaporware gate: the route answers ok:true but persisted:false
      // when no Loom-owned model item resolves for this id (a live-only dataset).
      // Surface the notice instead of a fake "Saved!" — nothing was stored.
      if (j.persisted === false) {
        setError(j.notice || 'The measure was not saved to this model.');
        if (Array.isArray(j.steps)) setSteps(j.steps);
        return;
      }

      const saved: QmMeasure = j.measure ?? { name, expression: generated.expression };
      setCreated((prev) => [...prev.filter((m) => m.name !== saved.name), saved]);
      setBackend(j.backend ?? 'loom-native');
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
            <Sparkle24Regular className={s.titleIcon} />
            <Subtitle2>Quick measures</Subtitle2>
          </div>
          <Caption1 className={s.hint}>
            Generate a measure from a template — year-to-date, year-over-year, running total, rank, star rating and
            more. Pick a few fields and Loom writes the DAX for you. Saved Azure-native to this model and immediately
            usable in queries; no Power BI or Fabric workspace required.
          </Caption1>
        </div>
        {allMeasures.length > 0 && (
          <Button appearance="primary" icon={<Add20Regular />} onClick={openGallery}>
            New quick measure
          </Button>
        )}
      </div>

      {allMeasures.length === 0 ? (
        <EmptyState
          icon={<Sparkle20Regular />}
          title="No measures yet"
          body="Create a measure from a quick-measure template — choose a calculation, pick the fields, and Loom generates the DAX. There is nothing to hand-write, and the measure drives real query results the moment it is saved."
          primaryAction={{ label: 'New quick measure', onClick: openGallery }}
        />
      ) : (
        <TileGrid minTileWidth={300}>
          {allMeasures.map((m) => (
            <div key={m.name} className={s.card}>
              <div className={s.cardHead}>
                <div className={s.cardName}>
                  <Sparkle20Regular className={s.titleIcon} />
                  <Tooltip content={m.name} relationship="label">
                    <Body1 className={s.cardNameText}>{m.name}</Body1>
                  </Tooltip>
                </div>
                {created.some((c) => c.name === m.name) && (
                  <Badge appearance="tint" color="success">new</Badge>
                )}
              </div>
              {m.expression && (
                <div className={s.preview}>
                  <div className={s.previewHeader}>
                    <Code16Regular />
                    <Caption1>DAX</Caption1>
                  </div>
                  <pre className={s.code}>{m.expression}</pre>
                </div>
              )}
            </div>
          ))}
        </TileGrid>
      )}

      <Dialog open={open} onOpenChange={(_, d) => { if (!busy) setOpen(d.open); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>
              <span className={s.headerTitle}>
                {step === 'configure' && (
                  <Button
                    appearance="subtle" size="small" icon={<ArrowLeft20Regular />}
                    aria-label="Back to templates"
                    onClick={() => { setStep('gallery'); setTpl(null); }}
                  />
                )}
                <Sparkle24Regular className={s.titleIcon} />
                {step === 'gallery' ? 'New quick measure' : tpl?.title}
              </span>
            </DialogTitle>
            <DialogContent>
              <div className={s.dialogBody}>
                {step === 'gallery' ? (
                  <>
                    <Caption1 className={s.hint}>
                      Choose a calculation. You will pick its fields next — Loom generates the DAX, so there is nothing
                      to write by hand.
                    </Caption1>
                    <TileGrid minTileWidth={240}>
                      {quickMeasureTemplates.map((t) => (
                        <div
                          key={t.key}
                          role="button"
                          tabIndex={0}
                          className={s.template}
                          onClick={() => chooseTemplate(t)}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseTemplate(t); } }}
                        >
                          <span className={s.templateIcon}>{iconFor(t.icon)}</span>
                          <Body1 className={s.templateTitle}>{t.title}</Body1>
                          <Caption1 className={s.templateCaption}>{t.caption}</Caption1>
                        </div>
                      ))}
                    </TileGrid>
                  </>
                ) : tpl && (
                  <>
                    <Caption1 className={s.hint}>{tpl.caption}</Caption1>

                    {blocked && (
                      <MessageBar intent="warning">
                        <MessageBarBody>
                          <MessageBarTitle>Can&apos;t build this measure yet</MessageBarTitle>
                          {blocked}
                        </MessageBarBody>
                      </MessageBar>
                    )}

                    {tpl.fields.map((f) => {
                      const pool = poolForField(f);
                      const sel = selected[f.key] || '';
                      return (
                        <Field key={f.key} label={f.label} required hint={f.hint}>
                          <Dropdown
                            placeholder={pool.length ? `Select a ${f.label.toLowerCase()}` : 'No matching fields in this model'}
                            disabled={pool.length === 0}
                            value={pool.find((o) => o.value === sel)?.label ?? ''}
                            selectedOptions={sel ? [sel] : []}
                            onOptionSelect={(_, d) => {
                              setSelected((prev) => ({ ...prev, [f.key]: d.optionValue || '' }));
                              setNameOverride(null);
                            }}
                          >
                            {pool.map((o) => (
                              <Option key={o.value} value={o.value} text={o.label}>{o.label}</Option>
                            ))}
                          </Dropdown>
                        </Field>
                      );
                    })}

                    {usesRating && (
                      <Field label="Maximum rating" hint="The top of the scale the value maps onto (number of stars).">
                        <SpinButton
                          value={maxRating}
                          min={1}
                          onChange={(_, d) => { setMaxRating(Math.max(1, Number(d.value ?? d.displayValue) || 5)); setNameOverride(null); }}
                        />
                      </Field>
                    )}

                    <Field
                      label="Measure name"
                      required
                      validationState={effectiveName && !nameValid ? 'error' : 'none'}
                      validationMessage={effectiveName && !nameValid ? 'A name is required and cannot contain [ or ].' : undefined}
                      hint="Defaults from the template — edit if you like."
                    >
                      <Input value={effectiveName} placeholder="Pick the fields to generate a name" onChange={(_, d) => setNameOverride(d.value)} />
                    </Field>

                    <div className={s.preview}>
                      <div className={s.previewHeader}>
                        <Code16Regular />
                        <Caption1>Generated DAX (read-only)</Caption1>
                      </div>
                      {generated
                        ? <pre className={s.code}>{generated.expression}</pre>
                        : <Caption1 className={s.emptyPreview}>Pick the fields above to preview the generated DAX.</Caption1>}
                    </div>

                    {error && (
                      <MessageBar intent="error">
                        <MessageBarBody>
                          <MessageBarTitle>Couldn&apos;t save the measure</MessageBarTitle>
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
                  </>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
              {step === 'configure' && (
                <Button
                  appearance="primary"
                  icon={busy ? <Spinner size="tiny" /> : <Sparkle20Regular />}
                  onClick={save}
                  disabled={!canSave}
                >
                  {busy ? 'Saving…' : 'Create measure'}
                </Button>
              )}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {backend && (
        <MessageBar intent="success">
          <MessageBarBody>
            <MessageBarTitle>
              <CheckmarkCircle16Filled style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS }} />
              Measure saved ({backend})
            </MessageBarTitle>
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
  );
}

export default QuickMeasureDialog;
