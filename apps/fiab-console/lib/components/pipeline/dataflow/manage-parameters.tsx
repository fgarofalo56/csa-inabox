'use client';

/**
 * ManageParameters — Power Query "Manage parameters" parity for BOTH the
 * Dataflow Gen2 PowerQueryHost and the report Transform host (Wave 4).
 *
 * Power Query parameters are `shared` query declarations whose body is a typed
 * literal carrying a `meta [IsParameterQuery=true, …]` record:
 *
 *   shared #"Start Date" = #date(2024, 1, 1)
 *       meta [IsParameterQuery=true, Type="Date", IsParameterQueryRequired=true];
 *   shared Region = "East"
 *       meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true,
 *             List={"East", "West", "North", "South"}];
 *
 * This surface is the structured editor for those declarations — a master/detail
 * dialog (left rail = the parameter list + "New", right = the typed detail form)
 * exactly like the real PQ "Manage Parameters" dialog. The user NEVER types M or
 * SQL (no-freeform-config): every field is a typed control and the M is GENERATED
 * here and persisted through `m-script.setQueryBody`, identical to how the ribbon
 * buttons append applied steps. The M stays the single source of truth the host's
 * `onChange` carries to Save (Cosmos) and Run (ADF WranglingDataFlow / report
 * /refresh) — no Fabric, no Power BI (no-fabric-dependency).
 *
 * Pure exports (`parseParameters` / `buildParameterBody` / `upsertParameter` /
 * `deleteParameter` / `parameterRef`) let the step dialogs and the host list and
 * REFERENCE the parameters (e.g. inserting `#"Start Date"` into a filter step) —
 * shared, additive, no regression to the existing host mount.
 *
 * Fluent v9 + Loom design tokens + the canvas-node-kit `transform` accent, so it
 * reads as the SAME product as the PowerQueryHost it opens from (web3-ui).
 */

import { useCallback, useMemo, useState } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Input, Dropdown, Option, Switch, Field, Textarea, Badge, Tooltip,
  Caption1, Body1Strong, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Add16Regular, Delete16Regular, BracesVariable20Regular,
} from '@fluentui/react-icons';
import {
  parseSharedQueries, setQueryBody, quoteStepName, splitTopLevel,
} from './m-script';
import { CATEGORY_ACCENT, accentTint, accentGradient } from '@/lib/components/canvas/canvas-node-kit';

// Power Query parameters live in the transform category of the canvas kit — reuse
// the SAME violet accent the PowerQueryHost frame + transform nodes use.
const PARAM_ACCENT = CATEGORY_ACCENT.transform;

// ════════════════════════════════════════════════════════════════════════════
// Public model
// ════════════════════════════════════════════════════════════════════════════

/** The Power Query parameter value kinds the structured editor exposes. */
export type ParameterType = 'text' | 'number' | 'date' | 'boolean' | 'list';

export interface QueryParameter {
  /** Parameter (shared query) name — may contain spaces (`Start Date`). */
  name: string;
  /** Value kind; drives the typed literal + the `Type="…"` meta. */
  type: ParameterType;
  /**
   * Current value in FRIENDLY string form (what the detail form shows/edits):
   *   text → the raw text; number → e.g. `5`; date → `YYYY-MM-DD`;
   *   boolean → `true`/`false`; list → one value per line.
   * Converted to/from the M typed literal by the pure helpers below.
   */
  currentValue: string;
  /**
   * Optional suggested/allowed values for a SCALAR parameter (PQ "Suggested
   * values = List of values"), friendly strings. Emitted as `List={…}` meta and
   * surfaced as a Dropdown when referenced. Not used for `list`-typed params
   * (their value IS the list).
   */
  allowedValues?: string[];
  /** PQ "Required" — emits `IsParameterQueryRequired=true|false`. */
  required: boolean;
}

/** ParameterType → the Power Query `Type="…"` meta token. */
const M_TYPE: Record<ParameterType, string> = {
  text: 'Text', number: 'Number', date: 'Date', boolean: 'Logical', list: 'List',
};

const TYPE_OPTIONS: Array<{ value: ParameterType; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Decimal number' },
  { value: 'date', label: 'Date' },
  { value: 'boolean', label: 'True/False' },
  { value: 'list', label: 'List' },
];

/** Human label for a ParameterType (badges / dropdown value). */
export function parameterTypeLabel(t: ParameterType): string {
  return TYPE_OPTIONS.find((o) => o.value === t)?.label ?? t;
}

// ════════════════════════════════════════════════════════════════════════════
// Pure M ↔ model helpers  (server/host/step-dialogs can import these)
// ════════════════════════════════════════════════════════════════════════════

/** Build an M text literal `"…"` (doubling embedded quotes). */
function mTextLit(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

/** Parse an M string literal token `"…"` → its unescaped value, or null. */
function parseMString(tok: string): string | null {
  const m = tok.trim().match(/^"((?:[^"]|"")*)"$/);
  return m ? m[1].replace(/""/g, '"') : null;
}

/** Build an `#date(y, m, d)` literal from a `YYYY-MM-DD` string, or null. */
function mDateLit(v: string): string | null {
  const m = v.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const mo = Number(m[2]);
  const da = Number(m[3]);
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  return `#date(${Number(m[1])}, ${mo}, ${da})`;
}

/** Parse an `#date(y, m, d)` literal → `YYYY-MM-DD`, or null. */
function parseMDate(tok: string): string | null {
  const m = tok.trim().match(/^#date\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (!m) return null;
  const pad = (n: string) => n.padStart(2, '0');
  return `${m[1].padStart(4, '0')}-${pad(m[2])}-${pad(m[3])}`;
}

/** Build a scalar M literal for a non-list type, or null when the value is invalid. */
function scalarLit(value: string, type: Exclude<ParameterType, 'list'>): string | null {
  const v = value.trim();
  switch (type) {
    case 'text': return mTextLit(value);
    case 'number': return /^-?\d+(\.\d+)?$/.test(v) ? v : null;
    case 'date': return mDateLit(v);
    case 'boolean': return /^(true|false)$/i.test(v) ? v.toLowerCase() : null;
    default: return null;
  }
}

/** Infer an M literal for one free element of a `list`-typed parameter. */
function inferElementLit(value: string): string {
  const v = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  if (/^(true|false)$/i.test(v)) return v.toLowerCase();
  const d = mDateLit(v);
  if (d) return d;
  return mTextLit(value);
}

/** Friendly string for one M element token (the inverse of inferElementLit). */
function elementToFriendly(tok: string): string {
  const s = parseMString(tok);
  if (s != null) return s;
  const d = parseMDate(tok);
  if (d != null) return d;
  return tok.trim();
}

/** Split a comma/newline-separated friendly value list into trimmed non-empty items. */
function splitValues(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parse an M list literal `{a, b, c}` → raw element tokens, or null. */
function parseListLiteral(tok: string): string[] | null {
  const t = tok.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  const inner = t.slice(1, -1).trim();
  if (inner === '') return [];
  return splitTopLevel(inner, ',').map((x) => x.trim());
}

/**
 * Split a parameter declaration body into its typed literal and the inner text
 * of its `meta [ … ]` record (string/bracket-aware so `#date(…)` and nested
 * lists are respected). `metaInner` is '' when there is no meta record.
 */
function splitMeta(body: string): { literal: string; metaInner: string } {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inStr) {
      if (ch === '"') { if (body[i + 1] === '"') { i += 1; continue; } inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '(' || ch === '{' || ch === '[') { depth += 1; continue; }
    if (ch === ')' || ch === '}' || ch === ']') { depth -= 1; continue; }
    if (
      depth === 0 && body.substr(i, 4).toLowerCase() === 'meta'
      && (i === 0 || /\s/.test(body[i - 1]))
      && /[\s[]/.test(body[i + 4] ?? '')
    ) {
      const literal = body.slice(0, i).trim();
      const open = body.indexOf('[', i + 4);
      if (open < 0) return { literal, metaInner: '' };
      // Capture the balanced [...] record.
      let d2 = 0;
      let inS2 = false;
      for (let j = open; j < body.length; j += 1) {
        const c = body[j];
        if (inS2) { if (c === '"') { if (body[j + 1] === '"') { j += 1; continue; } inS2 = false; } continue; }
        if (c === '"') { inS2 = true; continue; }
        if (c === '[') d2 += 1;
        else if (c === ']') { d2 -= 1; if (d2 === 0) return { literal, metaInner: body.slice(open + 1, j) }; }
      }
      return { literal, metaInner: body.slice(open + 1) };
    }
  }
  return { literal: body.trim(), metaInner: '' };
}

/** Parse a `meta` record's inner text `k1=v1, k2=v2` → a key→value map. */
function parseMetaRecord(inner: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!inner.trim()) return out;
  for (const field of splitTopLevel(inner, ',')) {
    const eq = field.indexOf('=');
    if (eq < 0) continue;
    out[field.slice(0, eq).trim()] = field.slice(eq + 1).trim();
  }
  return out;
}

/** Resolve a ParameterType from the `Type="…"` meta, falling back to the literal. */
function resolveType(metaType: string | undefined, literal: string): ParameterType {
  const t = metaType ? parseMString(metaType) : null;
  switch (t) {
    case 'Text': return 'text';
    case 'Number': case 'Decimal': case 'Int64': return 'number';
    case 'Date': case 'DateTime': case 'DateTimeZone': return 'date';
    case 'Logical': return 'boolean';
    case 'List': return 'list';
    default: break;
  }
  const lit = literal.trim();
  if (lit.startsWith('{')) return 'list';
  if (lit.startsWith('"')) return 'text';
  if (/^#date/i.test(lit)) return 'date';
  if (/^(true|false)$/i.test(lit)) return 'boolean';
  if (/^-?\d+(\.\d+)?$/.test(lit)) return 'number';
  return 'text';
}

/** Convert an M typed literal back to the form's friendly string. */
function literalToFriendly(literal: string, type: ParameterType): string {
  const lit = literal.trim();
  switch (type) {
    case 'text': return parseMString(lit) ?? lit.replace(/^"|"$/g, '');
    case 'date': return parseMDate(lit) ?? lit;
    case 'boolean': return /^true$/i.test(lit) ? 'true' : 'false';
    case 'number': return lit;
    case 'list': {
      const items = parseListLiteral(lit);
      return items ? items.map(elementToFriendly).join('\n') : lit;
    }
    default: return lit;
  }
}

/**
 * Build the persisted M body (`<typed literal> meta [IsParameterQuery=true, …]`)
 * for a parameter. The body is what `setQueryBody` writes after `shared <name> =`.
 * Only ever called for a VALID parameter (the editor gates Apply on validity), so
 * invalid scalars fall back to a safe empty literal rather than throwing.
 */
export function buildParameterBody(p: QueryParameter): string {
  let literal: string;
  if (p.type === 'list') {
    literal = `{${splitValues(p.currentValue).map(inferElementLit).join(', ')}}`;
  } else if (p.type === 'boolean') {
    // A boolean always has a value; an untouched/empty field means `false`.
    literal = /^true$/i.test(p.currentValue.trim()) ? 'true' : 'false';
  } else {
    literal = scalarLit(p.currentValue, p.type) ?? (p.type === 'number' ? '0' : '""');
  }
  const meta = [
    'IsParameterQuery=true',
    `Type="${M_TYPE[p.type]}"`,
    `IsParameterQueryRequired=${p.required ? 'true' : 'false'}`,
  ];
  if (p.type !== 'list' && p.allowedValues && p.allowedValues.length > 0) {
    const list = p.allowedValues
      .map((v) => scalarLit(v, p.type as Exclude<ParameterType, 'list'>) ?? mTextLit(v))
      .join(', ');
    meta.push(`List={${list}}`);
  }
  return `${literal} meta [${meta.join(', ')}]`;
}

/**
 * Parse every Power Query parameter declared in `mScript`. A declaration is a
 * parameter iff its body carries `IsParameterQuery=true`. Pure + dependency-free
 * so the host, the step dialogs, and the server can all reference parameters.
 */
export function parseParameters(mScript: string): QueryParameter[] {
  const out: QueryParameter[] = [];
  for (const { name, body } of parseSharedQueries(mScript)) {
    if (!/IsParameterQuery\s*=\s*true/i.test(body)) continue;
    const { literal, metaInner } = splitMeta(body);
    const meta = parseMetaRecord(metaInner);
    const type = resolveType(meta.Type, literal);
    const allowed = meta.List ? parseListLiteral(meta.List)?.map(elementToFriendly) : undefined;
    out.push({
      name,
      type,
      currentValue: literalToFriendly(literal, type),
      allowedValues: allowed && allowed.length ? allowed : undefined,
      required: /^true$/i.test((meta.IsParameterQueryRequired ?? 'false').trim()),
    });
  }
  return out;
}

/**
 * A valid Power Query identifier (no quoting needed). Parameter names are held to
 * this because the SHARED infrastructure both hosts rely on — `m-script`'s
 * `parseSharedQueries` (name = `[^\s=]*`) and the PowerQueryHost's section rebuild
 * on query delete — cannot round-trip a quoted `#"…"` name with spaces. Holding to
 * an identifier keeps every declaration parseable and prevents silent M corruption
 * (no-vaporware: the parameter must actually survive a host edit). The validator
 * surfaces this as an honest message rather than emitting a name that breaks.
 */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Write one parameter declaration through `m-script.setQueryBody` — the exact
 * emit path the ribbon uses for query bodies. Names are validated to plain
 * identifiers upstream, so setQueryBody both finds an existing decl and appends a
 * new one without any quoting ambiguity.
 */
function setParamDecl(mScript: string, name: string, body: string): string {
  return setQueryBody(mScript, name, body);
}

/** Remove a parameter (or any query) declaration from `mScript`. Pure. */
export function deleteParameter(mScript: string, name: string): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `\\n?[^\\S\\n]*shared\\s+#?"?${esc}"?\\s*=\\s*[\\s\\S]*?;(?=\\s*(?:shared\\b|section\\b|$))`,
  );
  return mScript.replace(re, '\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Upsert a parameter into `mScript` (rename-aware). When `originalName` differs
 * from `p.name`, the old declaration is removed first so the rename is clean.
 */
export function upsertParameter(mScript: string, p: QueryParameter, originalName?: string): string {
  let next = mScript;
  if (originalName && originalName !== p.name) next = deleteParameter(next, originalName);
  return setParamDecl(next, p.name, buildParameterBody(p));
}

/** The M token used to REFERENCE this parameter inside a step expression. */
export function parameterRef(name: string): string {
  return quoteStepName(name);
}

// ════════════════════════════════════════════════════════════════════════════
// Editor (master/detail dialog) — reused by the dataflow + report hosts
// ════════════════════════════════════════════════════════════════════════════

interface DraftParam extends QueryParameter {
  /** Stable local id for list keys (names can change while editing). */
  id: string;
  /** The name this draft was loaded under, '' for a freshly added one. */
  originalName: string;
}

let DRAFT_SEQ = 0;
function newDraft(p: QueryParameter, originalName: string): DraftParam {
  DRAFT_SEQ += 1;
  return { ...p, id: `p${DRAFT_SEQ}`, originalName };
}

/** Validation message for a draft, or null when it is valid. */
function validateDraft(d: DraftParam, all: DraftParam[]): string | null {
  const name = d.name.trim();
  if (!name) return 'Name is required.';
  if (!IDENTIFIER_RE.test(name)) {
    return 'Name must use letters, digits, and underscores (no spaces) and start with a letter or underscore.';
  }
  if (all.some((o) => o.id !== d.id && o.name.trim().toLowerCase() === name.toLowerCase())) {
    return `Another parameter is already named "${name}".`;
  }
  if (d.type === 'list') {
    if (splitValues(d.currentValue).length === 0) return 'Add at least one list value.';
    return null;
  }
  // A boolean is always valid (an empty field means `false`).
  if (d.type === 'boolean') return null;
  if (d.required && d.currentValue.trim() === '') return 'A required parameter needs a current value.';
  if (d.currentValue.trim() !== '' && scalarLit(d.currentValue, d.type) == null) {
    return d.type === 'date'
      ? 'Enter the date as YYYY-MM-DD.'
      : d.type === 'number'
        ? 'Enter a valid number.'
        : 'Enter true or false.';
  }
  return null;
}

const useStyles = makeStyles({
  surface: { maxWidth: '880px', width: '880px' },
  titleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  titleIcon: {
    flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '32px', height: '32px', borderRadius: tokens.borderRadiusMedium,
    background: accentGradient(PARAM_ACCENT), color: PARAM_ACCENT,
    border: `1px solid ${accentTint(PARAM_ACCENT, 24)}`,
  },
  body: {
    display: 'flex', gap: tokens.spacingHorizontalM,
    minHeight: '360px', maxHeight: '60vh',
  },
  rail: {
    width: '256px', flexShrink: 0, display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalXS, overflow: 'auto',
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingRight: tokens.spacingHorizontalS,
  },
  railHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  listItem: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalS, paddingRight: tokens.spacingHorizontalXS,
    borderRadius: tokens.borderRadiusMedium, cursor: 'pointer',
    transitionProperty: 'background-color', transitionDuration: tokens.durationFaster,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  listItemActive: {
    backgroundColor: accentTint(PARAM_ACCENT, 12),
    boxShadow: `inset 3px 0 0 0 ${PARAM_ACCENT}`,
  },
  listText: {
    flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px',
  },
  listName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  detail: {
    flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalM, overflow: 'auto',
    paddingRight: tokens.spacingHorizontalXS,
  },
  detailRow: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  grow: { flex: 1, minWidth: '200px' },
  invalidDot: { color: tokens.colorPaletteRedForeground1 },
  empty: {
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: tokens.colorNeutralForeground3, textAlign: 'center',
    paddingLeft: tokens.spacingHorizontalXL, paddingRight: tokens.spacingHorizontalXL,
  },
});

export interface ManageParametersDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Open-state change (Cancel / dismiss / after Apply). */
  onOpenChange: (open: boolean) => void;
  /** Current Power Query M (single source of truth). */
  mScript: string;
  /** Emit the next M when the user applies parameter changes. */
  onChange: (nextM: string) => void;
  /** Read-only host (view the parameters, no edits). */
  readOnly?: boolean;
}

/**
 * The Power Query "Manage parameters" dialog. Opens from either host (a ribbon /
 * View button wires `open`); parses the M into a working draft on open, lets the
 * user add / edit / delete typed parameters, and on Apply reconciles the draft
 * back into the M (delete removed, upsert the rest) and calls `onChange`.
 */
export function ManageParametersDialog({
  open, onOpenChange, mScript, onChange, readOnly = false,
}: ManageParametersDialogProps) {
  const s = useStyles();

  // The parameters as they exist in the M when the dialog opened (for reconcile).
  const original = useMemo(() => (open ? parseParameters(mScript) : []), [open, mScript]);
  const [drafts, setDrafts] = useState<DraftParam[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [touched, setTouched] = useState(false);

  // (Re)seed the working draft each time the dialog transitions to open.
  const [seededFor, setSeededFor] = useState<boolean>(false);
  if (open && !seededFor) {
    const seeded = original.map((p) => newDraft(p, p.name));
    setDrafts(seeded);
    setActiveId(seeded[0]?.id ?? '');
    setTouched(false);
    setSeededFor(true);
  } else if (!open && seededFor) {
    setSeededFor(false);
  }

  const active = drafts.find((d) => d.id === activeId) ?? null;

  const patchActive = useCallback((patch: Partial<QueryParameter>) => {
    if (readOnly) return;
    setTouched(true);
    setDrafts((prev) => prev.map((d) => (d.id === activeId ? { ...d, ...patch } : d)));
  }, [activeId, readOnly]);

  const addParameter = useCallback(() => {
    if (readOnly) return;
    const existing = new Set(drafts.map((d) => d.name));
    let n = drafts.length + 1;
    let name = `Parameter${n}`;
    while (existing.has(name)) { n += 1; name = `Parameter${n}`; }
    const d = newDraft({ name, type: 'text', currentValue: '', required: true }, '');
    setDrafts((prev) => [...prev, d]);
    setActiveId(d.id);
    setTouched(true);
  }, [drafts, readOnly]);

  const deleteDraft = useCallback((id: string) => {
    if (readOnly) return;
    setDrafts((prev) => {
      const next = prev.filter((d) => d.id !== id);
      if (id === activeId) setActiveId(next[0]?.id ?? '');
      return next;
    });
    setTouched(true);
  }, [activeId, readOnly]);

  // First validation error across the whole draft (gates Apply).
  const firstError = useMemo(() => {
    for (const d of drafts) {
      const e = validateDraft(d, drafts);
      if (e) return { id: d.id, name: d.name, error: e };
    }
    return null;
  }, [drafts]);

  const apply = useCallback(() => {
    if (readOnly || firstError) return;
    let next = mScript;
    // 1) Delete originals no draft still points at.
    const keptOriginals = new Set(drafts.map((d) => d.originalName).filter((x) => x));
    for (const o of original) if (!keptOriginals.has(o.name)) next = deleteParameter(next, o.name);
    // 2) Upsert each draft (rename-aware via originalName).
    for (const d of drafts) {
      const param: QueryParameter = {
        name: d.name.trim(), type: d.type, currentValue: d.currentValue,
        allowedValues: d.allowedValues, required: d.required,
      };
      next = upsertParameter(next, param, d.originalName || undefined);
    }
    onChange(next);
    onOpenChange(false);
  }, [readOnly, firstError, drafts, original, mScript, onChange, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle>
            <span className={s.titleRow}>
              <span className={s.titleIcon} aria-hidden="true"><BracesVariable20Regular /></span>
              Manage parameters
            </span>
          </DialogTitle>
          <DialogContent>
            {readOnly && (
              <MessageBar intent="info">
                <MessageBarBody>This dataflow is read-only — parameters are shown but cannot be edited.</MessageBarBody>
              </MessageBar>
            )}
            <div className={s.body}>
              {/* Master rail — the parameter list + New */}
              <div className={s.rail} role="navigation" aria-label="Parameters">
                <div className={s.railHeader}>
                  <Body1Strong>Parameters</Body1Strong>
                  <Tooltip content="New parameter" relationship="label">
                    <Button
                      size="small" appearance="subtle" icon={<Add16Regular />}
                      onClick={addParameter} disabled={readOnly} aria-label="New parameter"
                    />
                  </Tooltip>
                </div>
                {drafts.length === 0 && (
                  <Caption1>No parameters yet. Choose <strong>New parameter</strong> to add one.</Caption1>
                )}
                {drafts.map((d) => {
                  const invalid = validateDraft(d, drafts) != null;
                  return (
                    <div
                      key={d.id}
                      className={mergeClasses(s.listItem, d.id === activeId && s.listItemActive)}
                      onClick={() => setActiveId(d.id)}
                      role="button" tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter') setActiveId(d.id); }}
                    >
                      <span className={s.listText}>
                        <span className={s.listName}>
                          {d.name.trim() || <em>(unnamed)</em>}
                          {invalid && <span className={s.invalidDot} aria-label="Invalid"> ●</span>}
                        </span>
                        <Badge appearance="tint" color="brand" size="small">
                          {parameterTypeLabel(d.type)}
                        </Badge>
                      </span>
                      {!readOnly && (
                        <Tooltip content="Delete parameter" relationship="label">
                          <Button
                            size="small" appearance="subtle" icon={<Delete16Regular />}
                            onClick={(e) => { e.stopPropagation(); deleteDraft(d.id); }}
                            aria-label={`Delete ${d.name}`}
                          />
                        </Tooltip>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Detail — typed editor for the selected parameter */}
              {active ? (
                <ParameterDetail
                  className={s.detail} rowClass={s.detailRow} growClass={s.grow}
                  draft={active} readOnly={readOnly}
                  error={validateDraft(active, drafts)}
                  onPatch={patchActive}
                />
              ) : (
                <div className={s.empty}>
                  <Caption1>Select a parameter on the left to edit it, or add a new one.</Caption1>
                </div>
              )}
            </div>

            {firstError && touched && (
              <MessageBar intent="error">
                <MessageBarBody>
                  <MessageBarTitle>Fix “{firstError.name.trim() || 'parameter'}”</MessageBarTitle>
                  {firstError.error}
                </MessageBarBody>
              </MessageBar>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>
              {readOnly ? 'Close' : 'Cancel'}
            </Button>
            {!readOnly && (
              <Button appearance="primary" onClick={apply} disabled={!!firstError}>
                Apply
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

interface ParameterDetailProps {
  className: string;
  rowClass: string;
  growClass: string;
  draft: DraftParam;
  readOnly: boolean;
  error: string | null;
  onPatch: (patch: Partial<QueryParameter>) => void;
}

/** The typed detail form for one parameter (right pane of the dialog). */
function ParameterDetail({ className, rowClass, growClass, draft, readOnly, error, onPatch }: ParameterDetailProps) {
  // Per-field validation messages, derived from the single draft error so the
  // message lands under the control that caused it.
  const valueError = error && /value|number|date|true|list/i.test(error) ? error : undefined;
  const nameError = error && /name/i.test(error) ? error : undefined;

  return (
    <div className={className}>
      <div className={rowClass}>
        <Field
          className={growClass} label="Name" required
          validationState={nameError ? 'error' : 'none'}
          validationMessage={nameError}
          hint="Letters, digits, and underscores; no spaces. Reference it in steps by this name."
        >
          <Input
            value={draft.name} disabled={readOnly}
            onChange={(_, d) => onPatch({ name: d.value })}
          />
        </Field>
        <Field className={growClass} label="Type">
          <Dropdown
            value={parameterTypeLabel(draft.type)}
            selectedOptions={[draft.type]}
            disabled={readOnly}
            onOptionSelect={(_, d) => onPatch({ type: (d.optionValue as ParameterType) ?? 'text' })}
          >
            {TYPE_OPTIONS.map((o) => <Option key={o.value} value={o.value}>{o.label}</Option>)}
          </Dropdown>
        </Field>
      </div>

      <Field label="Required" hint="A required parameter must always carry a value.">
        <Switch
          checked={draft.required} disabled={readOnly}
          onChange={(_, d) => onPatch({ required: d.checked })}
          label={draft.required ? 'Required' : 'Optional'}
        />
      </Field>

      {draft.type === 'list' ? (
        <Field
          label="List values" required
          validationState={valueError ? 'error' : 'none'}
          validationMessage={valueError}
          hint="One value per line. Numbers and true/false are detected automatically; everything else is text."
        >
          <Textarea
            value={draft.currentValue} disabled={readOnly} resize="vertical"
            onChange={(_, d) => onPatch({ currentValue: d.value })}
            placeholder={'East\nWest\nNorth'}
          />
        </Field>
      ) : draft.type === 'boolean' ? (
        <Field label="Current value">
          <Switch
            checked={/^true$/i.test(draft.currentValue.trim())} disabled={readOnly}
            onChange={(_, d) => onPatch({ currentValue: d.checked ? 'true' : 'false' })}
            label={/^true$/i.test(draft.currentValue.trim()) ? 'true' : 'false'}
          />
        </Field>
      ) : draft.allowedValues && draft.allowedValues.length > 0 ? (
        <Field
          label="Current value"
          validationState={valueError ? 'error' : 'none'}
          validationMessage={valueError}
          hint="Constrained to the suggested values below."
        >
          <Dropdown
            value={draft.currentValue}
            selectedOptions={draft.currentValue ? [draft.currentValue] : []}
            disabled={readOnly}
            onOptionSelect={(_, d) => onPatch({ currentValue: d.optionValue ?? '' })}
          >
            {draft.allowedValues.map((v) => <Option key={v} value={v}>{v}</Option>)}
          </Dropdown>
        </Field>
      ) : (
        <Field
          label="Current value"
          validationState={valueError ? 'error' : 'none'}
          validationMessage={valueError}
          hint={draft.type === 'date' ? 'Format: YYYY-MM-DD' : draft.type === 'number' ? 'A numeric value' : undefined}
        >
          <Input
            value={draft.currentValue} disabled={readOnly}
            type={draft.type === 'number' ? 'number' : 'text'}
            placeholder={draft.type === 'date' ? '2024-01-01' : undefined}
            onChange={(_, d) => onPatch({ currentValue: d.value })}
          />
        </Field>
      )}

      {draft.type !== 'list' && draft.type !== 'boolean' && (
        <Field
          label="Suggested values (optional)"
          hint="One value per line. When set, the current value is picked from this list."
        >
          <Textarea
            value={(draft.allowedValues ?? []).join('\n')} disabled={readOnly} resize="vertical"
            onChange={(_, d) => onPatch({ allowedValues: splitValues(d.value) })}
            placeholder={'East\nWest'}
          />
        </Field>
      )}
    </div>
  );
}
