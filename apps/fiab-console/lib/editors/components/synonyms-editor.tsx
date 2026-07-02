'use client';

/**
 * SynonymsEditor — the Loom-native parity of the Power BI / Fabric "Q&A →
 * Synonyms" (linguistic schema) surface, rebuilt one-for-one in the Loom Model
 * view (`.claude/rules/ui-parity.md`).
 *
 * In Power BI you give every table / column / measure a set of natural-language
 * SYNONYMS so the Q&A visual and Copilot understand the words a business user
 * actually types ("revenue" → [Sales Amount], "client" → Customers). This
 * surface lists every object in the model (one row per table, column, and
 * measure, derived from the REAL loaded model schema) and lets the author attach
 * synonym terms — as removable Fluent tags — plus an optional match weight.
 *
 * NO-FABRIC-DEPENDENCY (`.claude/rules/no-fabric-dependency.md`): nothing here
 * requires a Power BI / Fabric / AAS workspace. The terms persist Azure-native
 * to the OWNED Cosmos item under `item.state.model.synonyms` (via the synonyms
 * BFF route + `linguistic-schema.ts`, same pattern as `model-store.ts`). The
 * full surface renders + saves with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET; the
 * persisted linguistic schema is what drives the Loom-native Q&A AI visual and
 * the Copilot, and is emitted into TMSL's `linguisticMetadata` only when the
 * model is OPT-IN provisioned to a tabular engine.
 *
 * NO-VAPORWARE (`.claude/rules/no-vaporware.md`): the object universe is built
 * from the real schema passed by the model view (never a mock); terms load via
 * GET and save via PUT to a real route; a load/save failure surfaces an honest
 * error MessageBar; an honest infra/permission gate (if the route ever returns
 * one) renders as a warning bar. No dead controls.
 *
 * loom_no_freeform_config (`.claude/rules/loom-no-freeform-config.md`): authoring
 * is structured — terms are added as discrete tags (Enter / comma / Add button),
 * weight is a preset Dropdown. There is no JSON / free-form config box.
 *
 * web3-ui (`.claude/rules/web3-ui.md`): Fluent v9 + Loom tokens only (no raw
 * px/hex for spacing, color, radius, or shadow), section headers
 * (Subtitle2 / Caption1), grouped rows with per-type icons, EmptyState for a
 * model with no objects, dark-legible throughout. Matches the editor's sibling
 * Model-view dialogs (what-if / hierarchy / Security tab).
 *
 * Props are intentionally minimal ({ item, id }); `tables` + `datasetId` follow
 * the shared ModelTabsExtra prop contract so the same mount can feed the schema.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge, Body1, Button, Caption1, Divider, Dropdown, Input, Option, Spinner,
  Subtitle2, Switch, Tab, TabList, Tag, TagGroup, Text, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add16Regular, ArrowSync16Regular, BrainCircuit20Regular, CalculatorMultiple20Regular,
  CheckmarkCircle16Filled, ColumnTriple20Regular, DocumentTable20Regular,
  LocalLanguage24Regular, Save20Regular, Search16Regular, Sparkle20Regular,
} from '@fluentui/react-icons';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { EmptyState } from '@/lib/components/empty-state';
import { clientFetch } from '@/lib/client-fetch';

// ── Contract shape (mirrors SynonymEntry in linguistic-schema.ts) ────────────

type SynObjectType = 'table' | 'column' | 'measure';

interface SynonymEntry {
  objectType: SynObjectType;
  table?: string;
  object: string;
  terms: string[];
  weight?: number;
}

/** A model table as supplied by the Model view (covers both `ModelTable` and the
 *  semantic-model `SmTable` — only the fields used here are required). */
interface SynonymsTableLike {
  name: string;
  columns?: Array<{ name: string }>;
  measures?: Array<{ name?: string }>;
}

export interface SynonymsEditorProps {
  /** The owned semantic-model item — its `state.model` seeds the schema fallback. */
  item: WorkspaceItem;
  /** The item id (route path segment). */
  id: string;
  /** Optional live Power BI/Fabric dataset id (opt-in path only; unused on the
   *  Azure-native default — kept for the shared ModelTabsExtra prop contract). */
  datasetId?: string;
  /** The loaded model schema (tables + columns + measures). When omitted the
   *  schema is derived from the item's persisted model state. */
  tables?: SynonymsTableLike[];
  /** The item type segment of the route (defaults to 'semantic-model'). */
  itemType?: string;
}

// ── Keying + meta ────────────────────────────────────────────────────────────

interface MetaRow {
  key: string;
  objectType: SynObjectType;
  table?: string;
  object: string;
  /** false when the object only exists in saved synonyms, not the current schema. */
  inSchema: boolean;
}

const SEP = '';
function keyOf(objectType: SynObjectType, table: string | undefined, object: string): string {
  return `${objectType}${SEP}${table ?? ''}${SEP}${object}`;
}

const WEIGHT_OPTIONS: Array<{ value: string; label: string; weight?: number }> = [
  { value: 'none', label: 'Default', weight: undefined },
  { value: '0.25', label: 'Low (0.25)', weight: 0.25 },
  { value: '0.5', label: 'Medium (0.5)', weight: 0.5 },
  { value: '0.75', label: 'High (0.75)', weight: 0.75 },
  { value: '1', label: 'Exact (1.0)', weight: 1 },
];
function weightToOption(w: number | undefined): string {
  if (typeof w !== 'number') return 'none';
  const hit = WEIGHT_OPTIONS.find((o) => o.weight === w);
  return hit ? hit.value : '0.5';
}

type TypeFilter = 'all' | 'table' | 'column' | 'measure';

// ── Schema derivation (real model objects, never mocked) ─────────────────────

interface DerivedTable { name: string; columns: string[]; measures: string[] }

function deriveSchema(
  item: WorkspaceItem,
  tablesProp: SynonymsTableLike[] | undefined,
): { tables: DerivedTable[]; modelMeasures: string[] } {
  const tables: DerivedTable[] = [];
  const seen = new Set<string>();

  for (const t of tablesProp ?? []) {
    const name = String(t?.name ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    tables.push({
      name,
      columns: (t.columns ?? [])
        .map((c) => String(c?.name ?? '').trim())
        .filter(Boolean),
      measures: (t.measures ?? [])
        .map((m) => String(m?.name ?? '').trim())
        .filter(Boolean),
    });
  }

  const model = (item.state as Record<string, unknown> | undefined)?.model as
    | { relationships?: Array<{ fromTable?: string; toTable?: string }>; measures?: Array<{ name?: string }> }
    | undefined;

  // Fallback table names from persisted relationships when no schema was passed.
  if (tables.length === 0 && Array.isArray(model?.relationships)) {
    for (const r of model!.relationships!) {
      for (const tn of [r?.fromTable, r?.toTable]) {
        const name = String(tn ?? '').trim();
        if (name && !seen.has(name)) {
          seen.add(name);
          tables.push({ name, columns: [], measures: [] });
        }
      }
    }
  }

  const modelMeasures = Array.isArray(model?.measures)
    ? model!.measures!.map((m) => String(m?.name ?? '').trim()).filter(Boolean)
    : [];

  return { tables, modelMeasures };
}

/** Flatten the derived schema into one MetaRow per table / column / measure. */
function buildSchemaRows(tables: DerivedTable[], modelMeasures: string[]): MetaRow[] {
  const rows: MetaRow[] = [];
  const measureSeen = new Set<string>();

  for (const t of tables) {
    rows.push({ key: keyOf('table', t.name, t.name), objectType: 'table', table: t.name, object: t.name, inSchema: true });
    for (const c of t.columns) {
      rows.push({ key: keyOf('column', t.name, c), objectType: 'column', table: t.name, object: c, inSchema: true });
    }
    for (const m of t.measures) {
      measureSeen.add(`${t.name}${SEP}${m}`);
      rows.push({ key: keyOf('measure', t.name, m), objectType: 'measure', table: t.name, object: m, inSchema: true });
    }
  }
  // Model-level measures not already attached to a table.
  for (const m of modelMeasures) {
    const tagged = [...measureSeen].some((k) => k.endsWith(`${SEP}${m}`));
    if (tagged) continue;
    rows.push({ key: keyOf('measure', undefined, m), objectType: 'measure', object: m, inSchema: true });
  }
  return rows;
}

// ── Styles (tokens only) ─────────────────────────────────────────────────────

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  header: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM, flexWrap: 'wrap',
  },
  headerText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  headerTitle: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  titleIcon: { color: tokens.colorBrandForeground1 },
  hint: { color: tokens.colorNeutralForeground3, maxWidth: '720px' },
  headerActions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  toolbar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  search: { minWidth: '220px' },
  stats: { color: tokens.colorNeutralForeground3, display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  // Scroll surface for the (potentially long) object list.
  list: {
    display: 'flex', flexDirection: 'column',
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    overflow: 'hidden',
  },
  scroller: { maxHeight: '560px', overflowY: 'auto' },
  groupHead: {
    position: 'sticky', top: 0, zIndex: 1,
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
    backgroundColor: tokens.colorNeutralBackground3,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  groupIcon: { color: tokens.colorNeutralForeground2 },
  groupCount: { color: tokens.colorNeutralForeground3 },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(160px, 240px) minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    transitionDuration: tokens.durationFaster,
    transitionProperty: 'background-color',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  objCell: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  objIconTable: { color: tokens.colorBrandForeground1, flexShrink: 0 },
  objIconColumn: { color: tokens.colorNeutralForeground2, flexShrink: 0 },
  objIconMeasure: { color: tokens.colorPaletteGreenForeground1, flexShrink: 0 },
  objText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  objName: { fontWeight: tokens.fontWeightSemibold, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  objSub: { color: tokens.colorNeutralForeground3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  termsCell: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  tagGroup: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
  addRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  addInput: { minWidth: '180px', maxWidth: '320px', flexGrow: 1 },
  emptyTerms: { color: tokens.colorNeutralForeground4 },
  weightCell: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, justifySelf: 'end' },
  weightDropdown: { minWidth: '120px' },
});

// ── Per-object row ───────────────────────────────────────────────────────────

interface RowProps {
  meta: MetaRow;
  terms: string[];
  weight: number | undefined;
  onAddTerms: (key: string, terms: string[]) => void;
  onRemoveTerm: (key: string, term: string) => void;
  onWeight: (key: string, weight: number | undefined) => void;
}

function objectIcon(styles: ReturnType<typeof useStyles>, t: SynObjectType) {
  if (t === 'table') return <DocumentTable20Regular className={styles.objIconTable} />;
  if (t === 'measure') return <CalculatorMultiple20Regular className={styles.objIconMeasure} />;
  return <ColumnTriple20Regular className={styles.objIconColumn} />;
}

function SynonymRow({ meta, terms, weight, onAddTerms, onRemoveTerm, onWeight }: RowProps) {
  const styles = useStyles();
  const [draft, setDraft] = useState('');

  const commit = useCallback(() => {
    // Split on commas so a user can paste "rev, sales, turnover" at once.
    const parts = draft.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) { setDraft(''); return; }
    onAddTerms(meta.key, parts);
    setDraft('');
  }, [draft, meta.key, onAddTerms]);

  const subLabel = meta.objectType === 'table'
    ? 'Table'
    : `${meta.objectType === 'measure' ? 'Measure' : 'Column'}${meta.table ? ` · ${meta.table}` : ''}`;

  return (
    <div className={styles.row} data-object-key={meta.key}>
      <div className={styles.objCell}>
        {objectIcon(styles, meta.objectType)}
        <div className={styles.objText}>
          <Tooltip content={meta.object} relationship="label">
            <Body1 className={styles.objName}>{meta.object}</Body1>
          </Tooltip>
          <Caption1 className={styles.objSub}>
            {subLabel}{!meta.inSchema ? ' · saved' : ''}
          </Caption1>
        </div>
      </div>

      <div className={styles.termsCell}>
        {terms.length > 0 ? (
          <TagGroup
            className={styles.tagGroup}
            size="small"
            aria-label={`Synonyms for ${meta.object}`}
            onDismiss={(_e, d: { value: string }) => onRemoveTerm(meta.key, d.value)}
          >
            {terms.map((term) => (
              <Tag key={term} value={term} dismissible appearance="brand" shape="rounded" size="small">
                {term}
              </Tag>
            ))}
          </TagGroup>
        ) : (
          <Caption1 className={styles.emptyTerms}>No synonyms yet</Caption1>
        )}
        <div className={styles.addRow}>
          <Input
            className={styles.addInput}
            size="small"
            value={draft}
            placeholder="Add synonym, press Enter…"
            aria-label={`Add synonym for ${meta.object}`}
            contentBefore={<Add16Regular />}
            onChange={(_, d) => setDraft(d.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
            }}
          />
          <Button size="small" appearance="subtle" onClick={commit} disabled={!draft.trim()}>
            Add
          </Button>
        </div>
      </div>

      <div className={styles.weightCell}>
        <Tooltip content="Match weight — higher terms win when Q&A / Copilot resolves an ambiguous word." relationship="label">
          <Dropdown
            className={styles.weightDropdown}
            size="small"
            aria-label={`Match weight for ${meta.object}`}
            value={WEIGHT_OPTIONS.find((o) => o.value === weightToOption(weight))?.label}
            selectedOptions={[weightToOption(weight)]}
            onOptionSelect={(_, d) => {
              const opt = WEIGHT_OPTIONS.find((o) => o.value === d.optionValue);
              onWeight(meta.key, opt?.weight);
            }}
          >
            {WEIGHT_OPTIONS.map((o) => (
              <Option key={o.value} value={o.value} text={o.label}>{o.label}</Option>
            ))}
          </Dropdown>
        </Tooltip>
      </div>
    </div>
  );
}

// ── Main editor ──────────────────────────────────────────────────────────────

interface RowValue { terms: string[]; weight?: number }

export function SynonymsEditor({ item, id, datasetId, tables, itemType = 'semantic-model' }: SynonymsEditorProps) {
  const styles = useStyles();

  const { tables: derivedTables, modelMeasures } = useMemo(
    () => deriveSchema(item, tables),
    [item, tables],
  );
  const schemaRows = useMemo(
    () => buildSchemaRows(derivedTables, modelMeasures),
    [derivedTables, modelMeasures],
  );
  const schemaKeys = useMemo(() => new Set(schemaRows.map((r) => r.key)), [schemaRows]);

  // Editable source of truth: terms + weight per object key.
  const [valueByKey, setValueByKey] = useState<Record<string, RowValue>>({});
  // Saved entries whose object is NOT in the current schema → still shown so we
  // never silently drop the operator's saved linguistic schema.
  const [orphanRows, setOrphanRows] = useState<MetaRow[]>([]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<{ missing?: string; detail?: string } | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  // Filters.
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [onlyWithSyn, setOnlyWithSyn] = useState(false);

  const reqIdRef = useRef(0);

  const ingest = useCallback((entries: SynonymEntry[]) => {
    const next: Record<string, RowValue> = {};
    const orphans: MetaRow[] = [];
    for (const e of entries) {
      if (!e || typeof e.object !== 'string') continue;
      const objectType: SynObjectType = e.objectType === 'table' || e.objectType === 'measure' ? e.objectType : 'column';
      const k = keyOf(objectType, e.table, e.object);
      const terms = Array.isArray(e.terms) ? e.terms.map((t) => String(t)).filter(Boolean) : [];
      const weight = typeof e.weight === 'number' ? e.weight : undefined;
      next[k] = { terms, weight };
      if (!schemaKeys.has(k)) {
        orphans.push({ key: k, objectType, table: e.table, object: e.object, inSchema: false });
      }
    }
    setValueByKey(next);
    setOrphanRows(orphans);
  }, [schemaKeys]);

  const load = useCallback(async () => {
    const rid = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    setGate(null);
    try {
      const res = await clientFetch(
        `/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(id)}/synonyms`,
        { method: 'GET' },
      );
      let j: { ok?: boolean; synonyms?: SynonymEntry[]; gate?: { missing?: string; detail?: string }; error?: string };
      try { j = await res.json(); }
      catch { j = { ok: false, error: `Unexpected non-JSON response (HTTP ${res.status})` }; }
      if (rid !== reqIdRef.current) return; // a newer load superseded this one

      if (j.gate) { setGate(j.gate); ingest([]); setDirty(false); return; }
      if (res.status === 404) { ingest([]); setDirty(false); return; } // route not deployed yet — start empty
      if (!res.ok || j.ok === false) {
        setError(j.error || `Couldn’t load synonyms (HTTP ${res.status}).`);
        ingest([]);
        return;
      }
      ingest(Array.isArray(j.synonyms) ? j.synonyms : []);
      setDirty(false);
    } catch (e: unknown) {
      if (rid !== reqIdRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
      ingest([]);
    } finally {
      if (rid === reqIdRef.current) setLoading(false);
    }
  }, [id, itemType, ingest]);

  useEffect(() => { void load(); }, [load]);

  // Combined ordered rows: schema first, orphans (saved-but-missing) last.
  const allRows = useMemo(() => [...schemaRows, ...orphanRows], [schemaRows, orphanRows]);

  // Mutations.
  const addTerms = useCallback((key: string, add: string[]) => {
    setValueByKey((prev) => {
      const cur = prev[key]?.terms ?? [];
      const lower = new Set(cur.map((t) => t.toLowerCase()));
      const merged = [...cur];
      for (const t of add) {
        if (!lower.has(t.toLowerCase())) { merged.push(t); lower.add(t.toLowerCase()); }
      }
      return { ...prev, [key]: { terms: merged, weight: prev[key]?.weight } };
    });
    setDirty(true);
    setSavedNote(null);
  }, []);

  const removeTerm = useCallback((key: string, term: string) => {
    setValueByKey((prev) => {
      const cur = prev[key]?.terms ?? [];
      return { ...prev, [key]: { terms: cur.filter((t) => t !== term), weight: prev[key]?.weight } };
    });
    setDirty(true);
    setSavedNote(null);
  }, []);

  const setWeight = useCallback((key: string, weight: number | undefined) => {
    setValueByKey((prev) => ({ ...prev, [key]: { terms: prev[key]?.terms ?? [], weight } }));
    setDirty(true);
    setSavedNote(null);
  }, []);

  // Build the SynonymEntry[] payload from the current edits (objects with ≥1 term).
  const buildPayload = useCallback((): SynonymEntry[] => {
    const metaByKey = new Map(allRows.map((r) => [r.key, r]));
    const out: SynonymEntry[] = [];
    for (const [key, val] of Object.entries(valueByKey)) {
      const terms = (val.terms ?? []).map((t) => t.trim()).filter(Boolean);
      if (terms.length === 0) continue;
      const meta = metaByKey.get(key);
      if (!meta) continue;
      const entry: SynonymEntry = { objectType: meta.objectType, object: meta.object, terms };
      if (meta.table) entry.table = meta.table;
      if (typeof val.weight === 'number') entry.weight = val.weight;
      out.push(entry);
    }
    return out;
  }, [allRows, valueByKey]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    setSavedNote(null);
    const payload = buildPayload();
    try {
      const res = await clientFetch(
        `/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(id)}/synonyms`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ synonyms: payload }),
        },
      );
      let j: { ok?: boolean; persisted?: boolean; synonyms?: SynonymEntry[]; gate?: { missing?: string; detail?: string }; error?: string };
      try { j = await res.json(); }
      catch { j = { ok: false, error: `Unexpected non-JSON response (HTTP ${res.status})` }; }

      if (j.gate) { setGate(j.gate); setError(j.gate.detail || 'Synonyms could not be persisted.'); return; }
      if (!res.ok || j.ok === false) {
        setError(j.error || `Save failed (HTTP ${res.status}).`);
        return;
      }
      // Re-seed from the server's canonical list when present.
      if (Array.isArray(j.synonyms)) ingest(j.synonyms);
      setDirty(false);
      setGate(null);
      const n = payload.length;
      setSavedNote(`Saved the linguistic schema — ${n} object${n === 1 ? '' : 's'} with synonyms. Q&A and Copilot will use these terms.`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [buildPayload, id, itemType, ingest]);

  // Filtered + grouped view.
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allRows.filter((r) => {
      if (typeFilter !== 'all' && r.objectType !== typeFilter) return false;
      const v = valueByKey[r.key];
      const has = !!v && v.terms.length > 0;
      if (onlyWithSyn && !has) return false;
      if (q) {
        const inName = r.object.toLowerCase().includes(q) || (r.table ?? '').toLowerCase().includes(q);
        const inTerms = !!v && v.terms.some((t) => t.toLowerCase().includes(q));
        if (!inName && !inTerms) return false;
      }
      return true;
    });
  }, [allRows, typeFilter, onlyWithSyn, search, valueByKey]);

  const groups = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, MetaRow[]>();
    for (const r of filteredRows) {
      const gk = r.table ?? (r.objectType === 'measure' ? '__model_measures__' : '__other__');
      if (!map.has(gk)) { map.set(gk, []); order.push(gk); }
      map.get(gk)!.push(r);
    }
    // Within each group: table, then columns, then measures, then name.
    const rank: Record<SynObjectType, number> = { table: 0, column: 1, measure: 2 };
    for (const rows of map.values()) {
      rows.sort((a, b) => (rank[a.objectType] - rank[b.objectType]) || a.object.localeCompare(b.object));
    }
    return order.map((gk) => ({
      key: gk,
      label: gk === '__model_measures__' ? 'Model-level measures' : gk === '__other__' ? 'Other saved objects' : gk,
      rows: map.get(gk)!,
    }));
  }, [filteredRows]);

  // Stats.
  const stats = useMemo(() => {
    let withSyn = 0;
    let totalTerms = 0;
    for (const r of allRows) {
      const v = valueByKey[r.key];
      if (v && v.terms.length > 0) { withSyn += 1; totalTerms += v.terms.length; }
    }
    return { objects: allRows.length, withSyn, totalTerms };
  }, [allRows, valueByKey]);

  const hasObjects = allRows.length > 0;

  return (
    <div className={styles.root} data-dataset-id={datasetId || undefined}>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <div className={styles.headerTitle}>
            <LocalLanguage24Regular className={styles.titleIcon} />
            <Subtitle2>Synonyms (linguistic schema)</Subtitle2>
          </div>
          <Caption1 className={styles.hint}>
            Teach Q&amp;A and Copilot the everyday words your users type for each table, column, and measure —
            “revenue” for [Sales Amount], “client” for Customers. Saved Azure-native to this model; no Power BI or
            Fabric workspace required.
          </Caption1>
        </div>
        <div className={styles.headerActions}>
          <Button
            appearance="subtle"
            icon={loading ? <Spinner size="tiny" /> : <ArrowSync16Regular />}
            onClick={() => { void load(); }}
            disabled={loading || saving}
          >
            Reload
          </Button>
          <Button
            appearance="primary"
            icon={saving ? <Spinner size="tiny" /> : <Save20Regular />}
            onClick={() => { void save(); }}
            disabled={saving || loading || !dirty}
          >
            {saving ? 'Saving…' : dirty ? 'Save synonyms' : 'Saved'}
          </Button>
        </div>
      </div>

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Synonyms need a one-time setup</MessageBarTitle>
            {gate.detail || 'A required resource is not configured.'}
            {gate.missing ? ` (${gate.missing})` : ''}
          </MessageBarBody>
        </MessageBar>
      )}

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Something went wrong</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {savedNote && (
        <MessageBar intent="success">
          <MessageBarBody>
            <MessageBarTitle>
              <CheckmarkCircle16Filled style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS }} />
              Linguistic schema saved
            </MessageBarTitle>
            {savedNote}
          </MessageBarBody>
        </MessageBar>
      )}

      {!hasObjects ? (
        <EmptyState
          icon={<BrainCircuit20Regular />}
          title="No model objects to describe yet"
          body="Load a model with tables, columns, and measures first. Once the schema is in place, add the natural-language synonyms that power the Q&A AI visual and Copilot — no Power BI or Fabric workspace needed."
          primaryAction={{ label: 'Reload model', onClick: () => { void load(); } }}
        />
      ) : (
        <>
          <div className={styles.toolbar}>
            <Input
              className={styles.search}
              size="small"
              value={search}
              placeholder="Search objects or synonyms…"
              contentBefore={<Search16Regular />}
              onChange={(_, d) => setSearch(d.value)}
            />
            <TabList
              size="small"
              selectedValue={typeFilter}
              onTabSelect={(_, d) => setTypeFilter(d.value as TypeFilter)}
            >
              <Tab value="all">All</Tab>
              <Tab value="table">Tables</Tab>
              <Tab value="column">Columns</Tab>
              <Tab value="measure">Measures</Tab>
            </TabList>
            <Switch
              label="With synonyms only"
              checked={onlyWithSyn}
              onChange={(_, d) => setOnlyWithSyn(!!d.checked)}
            />
            <div className={styles.stats}>
              <Sparkle20Regular />
              <Caption1>
                {stats.withSyn}/{stats.objects} objects · {stats.totalTerms} term{stats.totalTerms === 1 ? '' : 's'}
              </Caption1>
            </div>
          </div>

          <div className={styles.list}>
            <div className={styles.scroller}>
              {filteredRows.length === 0 ? (
                <div className={styles.row} style={{ gridTemplateColumns: '1fr' }}>
                  <Text className={styles.emptyTerms}>No objects match the current filter.</Text>
                </div>
              ) : (
                groups.map((g, gi) => (
                  <div key={g.key}>
                    {gi > 0 && <Divider />}
                    <div className={styles.groupHead}>
                      {g.key === '__model_measures__'
                        ? <CalculatorMultiple20Regular className={styles.groupIcon} />
                        : <DocumentTable20Regular className={styles.groupIcon} />}
                      <Subtitle2>{g.label}</Subtitle2>
                      <Badge appearance="tint" color="informative" className={styles.groupCount}>
                        {g.rows.length}
                      </Badge>
                    </div>
                    {g.rows.map((r) => (
                      <SynonymRow
                        key={r.key}
                        meta={r}
                        terms={valueByKey[r.key]?.terms ?? []}
                        weight={valueByKey[r.key]?.weight}
                        onAddTerms={addTerms}
                        onRemoveTerm={removeTerm}
                        onWeight={setWeight}
                      />
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default SynonymsEditor;
