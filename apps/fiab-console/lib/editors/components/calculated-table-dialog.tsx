'use client';

/**
 * CalculatedTableDialog — Azure-native parity with the Power BI / Fabric Model
 * view "New table" (calculated table) experience, rebuilt one-for-one in the
 * Loom Model view (`.claude/rules/ui-parity.md`).
 *
 * A calculated table in Power BI / Fabric is a model table whose rows come from
 * a table-valued EXPRESSION (DAX) rather than a loaded source — e.g. a date
 * dimension `CALENDAR(...)`, a deduped `SUMMARIZECOLUMNS(...)`, a `UNION(...)` of
 * two facts. Loom additionally allows the expression to be a read-only `SELECT`
 * (SQL) so the same surface serves the warehouse / Synapse / Databricks engines.
 *
 * loom_no_freeform_config (`.claude/rules/loom_no_freeform_config`): the
 * expression box here is the ONE sanctioned free-form surface — the explicit
 * 1:1 ADF/Synapse-style expression exception (the same exception that covers the
 * per-role RLS DAX filter and the measure DAX). Everything else on this surface
 * is structured: a validated identifier name and a two-option language toggle.
 * The expression is guarded client-side (mirroring `validateRlsDax`: no
 * semicolons / statement-shaping for DAX; a read-only single-statement SELECT
 * for SQL) before it is ever sent — the server re-validates and is the source of
 * truth.
 *
 * NO-FABRIC-DEPENDENCY (`.claude/rules/no-fabric-dependency.md`): nothing here
 * requires a Power BI / Fabric / AAS workspace. On confirm the table is POSTed to
 * the model BFF (`/api/items/semantic-model/<id>/model`), which persists it
 * Azure-native onto `item.state.model.calculatedTables` (Cosmos — the SAME slot
 * the DAX Copilot and the `/query` DAX path read) and emits it in TMSL only when
 * the model is OPT-IN provisioned to a tabular engine. The full surface renders
 * and saves with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
 *
 * NO-VAPORWARE (`.claude/rules/no-vaporware.md`): every control is wired — the
 * primary button POSTs to a real route and surfaces the backend + steps it
 * returns; a failure renders an honest error MessageBar (no fake "Saved!"); the
 * table list is seeded from the item's real persisted state, never a mock.
 *
 * web3-ui (`.claude/rules/web3-ui.md`): Fluent v9 + Loom tokens only (no raw
 * px/hex), the dialog chrome matches the sibling what-if / quick-measure dialogs,
 * EmptyState for the empty gallery, elevated hover-lift cards, dark-legible.
 */

import { useMemo, useState } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Caption1, Body1, Subtitle2, Field, Input, Textarea, RadioGroup, Radio, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle, Badge, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Table24Regular, Table20Regular, Add20Regular, Code16Regular,
  Link16Regular, CheckmarkCircle16Filled,
} from '@fluentui/react-icons';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { EmptyState } from '@/lib/components/empty-state';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { clientFetch } from '@/lib/client-fetch';

// ── Contract shape (mirrors model-store.ts CalculatedTable; the server assigns
//    id/createdAt/updatedAt via normalizeCalculatedTable) ─────────────────────

type CalcTableLanguage = 'dax' | 'sql';

interface CalculatedTable {
  id: string;
  name: string;
  expression: string;
  language: CalcTableLanguage;
  createdAt?: string;
  updatedAt?: string;
}

// Loose model-table shape (the canvas / model-route GET shape) — accepted only
// to show the operator which tables the new calculated table will sit beside.
interface CtModelTable { name: string; schema?: string }

interface CalculatedTableDialogProps {
  /** The owned model item — its `state.model.calculatedTables` seeds the list. */
  item: WorkspaceItem;
  /** The semantic-model item id (route path segment). */
  id: string;
  /** Optional live Power BI/Fabric dataset id (opt-in path only; unused on the
   *  Azure-native default — kept for the shared ModelTabsExtra prop contract). */
  datasetId?: string;
  /** Real loaded model tables — shown as context so the operator knows the new
   *  table joins an existing model (relationships / measures can reference it). */
  tables?: CtModelTable[];
  /** Called after a successful save so the parent can refresh its model view. */
  onSaved?: () => void;
}

const LANGUAGE_OPTIONS: Array<{ value: CalcTableLanguage; label: string; hint: string; sample: string }> = [
  {
    value: 'dax',
    label: 'DAX table expression',
    hint: 'A DAX table-valued expression — the rows are computed by the tabular engine.',
    sample: 'CALENDAR(DATE(2020,1,1), DATE(2030,12,31))',
  },
  {
    value: 'sql',
    label: 'SQL SELECT query',
    hint: 'A read-only SELECT — the rows are materialized by the SQL/warehouse engine.',
    sample: 'SELECT DISTINCT Region FROM dbo.Sales',
  },
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

  // Calculated-table card — elevated, hover-lift, matches the marketplace tiles.
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

  // Read-only expression preview block (monospace).
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
  mono: { fontFamily: tokens.fontFamilyMonospace },

  dialogBody: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: '520px', maxWidth: '720px' },
  participate: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, color: tokens.colorNeutralForeground3 },
  steps: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, marginTop: tokens.spacingVerticalXS },
  stepLine: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, color: tokens.colorNeutralForeground2 },
});

// ── Validation (structured name + the sanctioned free-form expression guard) ──

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

// DAX query-shaping keywords that must NOT appear in a table EXPRESSION — these
// turn an expression into a query / definition (mirrors validateRlsDax).
const FORBIDDEN_DAX = /\b(EVALUATE|DEFINE|MEASURE\s|ORDER\s+BY)\b/i;
// SQL DDL/DML that must NOT appear in a read-only calculated-table SELECT.
const FORBIDDEN_SQL = /\b(DROP|DELETE|UPDATE|INSERT|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|MERGE|GRANT|REVOKE|INTO)\b/i;

function balancedParens(e: string): boolean {
  let depth = 0;
  for (const ch of e) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * Guard the free-form expression before it is sent. Mirrors the validateRlsDax
 * style for DAX (no semicolons / statement-shaping) and enforces a single
 * read-only SELECT for SQL. The server re-validates — this is the friendly
 * client pre-check, never the only gate.
 */
function guardExpression(raw: string, language: CalcTableLanguage): { ok: boolean; error?: string } {
  const e = (raw || '').trim();
  if (!e) return { ok: false, error: 'An expression is required.' };
  if (e.length > 8000) return { ok: false, error: 'Expression exceeds 8000 characters.' };

  if (language === 'dax') {
    if (e.includes(';')) return { ok: false, error: 'Semicolons are not allowed in a DAX table expression.' };
    if (FORBIDDEN_DAX.test(e)) {
      return {
        ok: false,
        error:
          'A calculated table must be a DAX table expression (e.g. CALENDAR(…), SUMMARIZECOLUMNS(…), ' +
          'UNION(…)), not a query. Remove EVALUATE / DEFINE / MEASURE / ORDER BY.',
      };
    }
    if (!balancedParens(e)) return { ok: false, error: 'Unbalanced parentheses.' };
    return { ok: true };
  }

  // SQL — a single read-only SELECT (a leading CTE is allowed).
  const noTrailingSemi = e.replace(/;\s*$/, '');
  if (noTrailingSemi.includes(';')) {
    return { ok: false, error: 'Only a single SELECT statement is allowed (remove the extra semicolons).' };
  }
  if (!/^\s*(SELECT|WITH)\b/i.test(noTrailingSemi)) {
    return { ok: false, error: 'A SQL calculated table must be a SELECT query (optionally a WITH … SELECT CTE).' };
  }
  if (FORBIDDEN_SQL.test(noTrailingSemi)) {
    return { ok: false, error: 'Only a read-only SELECT is allowed — no INSERT / UPDATE / DELETE / DDL / SELECT INTO.' };
  }
  if (!balancedParens(noTrailingSemi)) return { ok: false, error: 'Unbalanced parentheses.' };
  return { ok: true };
}

/** Seed the editor's existing calculated tables off the persisted item state. */
function seedTables(item: WorkspaceItem): CalculatedTable[] {
  const model = (item.state as Record<string, unknown> | undefined)?.model as
    | { calculatedTables?: unknown }
    | undefined;
  const raw = model?.calculatedTables;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is CalculatedTable => !!t && typeof (t as CalculatedTable).name === 'string')
    .map((t) => ({
      id: t.id || t.name,
      name: t.name,
      expression: String((t as CalculatedTable).expression || ''),
      language: (t as CalculatedTable).language === 'sql' ? 'sql' : 'dax',
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }));
}

export function CalculatedTableDialog({ item, id, datasetId, tables = [], onSaved }: CalculatedTableDialogProps) {
  const s = useStyles();
  const [calcTables, setCalcTables] = useState<CalculatedTable[]>(() => seedTables(item));
  const [open, setOpen] = useState(false);

  // Form state (structured name + language toggle + the sanctioned free-form expr).
  const [name, setName] = useState('');
  const [language, setLanguage] = useState<CalcTableLanguage>('dax');
  const [expression, setExpression] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [backend, setBackend] = useState<string | null>(null);

  const trimmedName = name.trim();
  const nameTaken = calcTables.some((t) => t.name.toLowerCase() === trimmedName.toLowerCase());

  const nameError =
    !trimmedName ? 'A table name is required.'
    : !NAME_RE.test(trimmedName) ? 'Start with a letter or underscore; letters, digits and underscores only.'
    : nameTaken ? 'A calculated table with this name already exists.'
    : undefined;

  const exprGuard = useMemo(() => guardExpression(expression, language), [expression, language]);
  const exprError = expression.trim() ? (exprGuard.ok ? undefined : exprGuard.error) : undefined;

  const valid = !nameError && exprGuard.ok;
  const activeLang = LANGUAGE_OPTIONS.find((o) => o.value === language)!;
  const otherTableNames = tables.map((t) => t.name).filter(Boolean);

  function resetForm() {
    setName(''); setLanguage('dax'); setExpression('');
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

    const payload = { name: trimmedName, expression: expression.trim(), language };

    try {
      const res = await clientFetch(
        `/api/items/semantic-model/${encodeURIComponent(id)}/model`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ calculatedTable: payload }),
        },
      );
      let j: {
        ok?: boolean;
        calculatedTable?: CalculatedTable;
        calculatedTables?: CalculatedTable[];
        backend?: string;
        steps?: string[];
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

      // Prefer the server-normalized object/list; fall back to the optimistic
      // payload so the card still appears with its expression.
      const saved: CalculatedTable = j.calculatedTable ?? {
        ...payload,
        id: `calctable-${Date.now()}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const nextList = Array.isArray(j.calculatedTables)
        ? j.calculatedTables
        : [...calcTables.filter((t) => t.name.toLowerCase() !== saved.name.toLowerCase()), saved];

      setCalcTables(nextList);
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
            <Table24Regular className={s.titleIcon} />
            <Subtitle2>Calculated tables</Subtitle2>
          </div>
          <Caption1 className={s.hint}>
            Add a table whose rows come from an expression — a date dimension, a deduped lookup, a UNION of two
            facts. The new table joins the model: relationships and measures can reference its columns just like a
            loaded table. Saved Azure-native to this model; no Power BI or Fabric workspace required.
          </Caption1>
        </div>
        {calcTables.length > 0 && (
          <Button appearance="primary" icon={<Add20Regular />} onClick={openDialog}>
            New table
          </Button>
        )}
      </div>

      {calcTables.length === 0 ? (
        <EmptyState
          icon={<Table20Regular />}
          title="No calculated tables yet"
          body="Create a table from a DAX table expression or a read-only SQL SELECT — a date dimension, a parameter table, a deduped lookup, or a combined fact. The table participates in the model: relationships and measures can reference it the moment it is saved."
          primaryAction={{ label: 'Create calculated table', onClick: openDialog }}
        />
      ) : (
        <TileGrid minTileWidth={320}>
          {calcTables.map((t) => (
            <div key={t.id || t.name} className={s.card}>
              <div className={s.cardHead}>
                <div className={s.cardName}>
                  <Table20Regular className={s.titleIcon} />
                  <Tooltip content={t.name} relationship="label">
                    <Body1 className={s.cardNameText}>{t.name}</Body1>
                  </Tooltip>
                </div>
                <Badge appearance="outline" color="brand">{t.language === 'sql' ? 'SQL' : 'DAX'}</Badge>
              </div>
              <div className={s.preview}>
                <div className={s.previewHeader}>
                  <Code16Regular />
                  <Caption1>{t.language === 'sql' ? 'SELECT' : 'Table expression'}</Caption1>
                </div>
                <pre className={s.code}>{t.expression}</pre>
              </div>
              <Caption1 className={s.participate}>
                <Link16Regular />
                Participates in the model — relationships &amp; measures can reference its columns.
              </Caption1>
            </div>
          ))}
        </TileGrid>
      )}

      <Dialog open={open} onOpenChange={(_, d) => { if (!busy) setOpen(d.open); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>
              <span className={s.headerTitle}>
                <Table24Regular className={s.titleIcon} />
                New calculated table
              </span>
            </DialogTitle>
            <DialogContent>
              <div className={s.dialogBody}>
                <Caption1 className={s.hint}>
                  Name the table, choose the expression language, and author the table-valued expression. This is the
                  one sanctioned free-form surface — the same 1:1 expression exception as a measure. The expression is
                  validated below before it is saved.
                </Caption1>

                <Field
                  label="Table name"
                  required
                  validationState={name && nameError ? 'error' : 'none'}
                  validationMessage={name ? nameError : undefined}
                  hint="Becomes the table name in the model. A valid identifier — letters, digits, underscores."
                >
                  <Input
                    value={name}
                    placeholder="e.g. DimDate"
                    onChange={(_, d) => setName(d.value)}
                  />
                </Field>

                <Field label="Expression language" hint={activeLang.hint}>
                  <RadioGroup
                    layout="horizontal"
                    value={language}
                    onChange={(_, d) => { setLanguage(d.value as CalcTableLanguage); setError(null); }}
                  >
                    {LANGUAGE_OPTIONS.map((o) => (
                      <Radio key={o.value} value={o.value} label={o.label} />
                    ))}
                  </RadioGroup>
                </Field>

                <Field
                  label={language === 'sql' ? 'SELECT query' : 'DAX table expression'}
                  required
                  validationState={exprError ? 'error' : 'none'}
                  validationMessage={exprError}
                  hint={`Example: ${activeLang.sample}`}
                >
                  <Textarea
                    value={expression}
                    placeholder={activeLang.sample}
                    onChange={(_, d) => setExpression(d.value)}
                    textarea={{ className: s.mono }}
                    resize="vertical"
                    rows={6}
                  />
                </Field>

                <MessageBar intent="info">
                  <MessageBarBody>
                    <Link16Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS }} />
                    This table participates in the model — once saved, its columns can be used in relationships and
                    referenced by measures, exactly like a loaded table.
                    {otherTableNames.length > 0 && (
                      <> It will join {otherTableNames.length} existing table{otherTableNames.length === 1 ? '' : 's'} in this model.</>
                    )}
                  </MessageBarBody>
                </MessageBar>

                {error && (
                  <MessageBar intent="error">
                    <MessageBarBody>
                      <MessageBarTitle>Couldn&apos;t save the table</MessageBarTitle>
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
                icon={busy ? <Spinner size="tiny" /> : <Table20Regular />}
                onClick={save}
                disabled={!valid || busy}
              >
                {busy ? 'Saving…' : 'Create table'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {backend && (
        <MessageBar intent="success">
          <MessageBarBody>
            <MessageBarTitle>
              <CheckmarkCircle16Filled style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS }} />
              Calculated table saved ({backend})
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

export default CalculatedTableDialog;
