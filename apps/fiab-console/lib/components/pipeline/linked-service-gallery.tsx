'use client';

/**
 * LinkedServiceGallery — the ADF / Synapse Studio "New linked service"
 * experience, themed for Loom (Fluent UI v9 + Loom design tokens).
 *
 * Parity with the Manage hub → Linked services → "+ New" flow:
 *
 *   1. GALLERY — a searchable connector gallery grouped by category. Each tile
 *      shows an icon + name + description, sourced from `CONNECTORS` in
 *      `lib/pipeline/connector-catalog.ts` (authored by the connector-catalog
 *      sibling). A search box filters by name / description / type.
 *   2. CONFIG — on pick, the per-connector STRUCTURED form: name → auth
 *      selector → the auth option's fields + the connector's common fields,
 *      with conditional `showIf` and secret fields rendered as password inputs.
 *      NEVER a freeform JSON textarea (per loom-no-freeform-config).
 *   3. COMMIT — "Test connection" (a real validate round-trip via the BFF, when
 *      supported) then "Create", which assembles `{ name, properties: { type,
 *      typeProperties } }` and POSTs it to the real linked-service BFF route,
 *      which calls the real ARM / Synapse dev-plane upsert (no mocks, per
 *      no-vaporware.md).
 *
 * Two entry points are exported:
 *   • <LinkedServiceGallery onSelected={(name) => …} />  — the full gallery +
 *     config wizard, plus a "Select existing" tab that lists the real linked
 *     services already on the factory / workspace.
 *   • <LinkedServicePicker value selectedName onSelected /> — a compact
 *     select-existing Dropdown with a "＋ New" affordance that opens the gallery
 *     in a dialog. Use it inside dataset / Copy-activity "Linked service"
 *     pickers.
 *
 * `engine` selects the backend: 'adf' → /api/adf/linked-services (Azure Data
 * Factory), 'synapse' → /api/synapse/linkedservices (Synapse workspace). Both
 * share the same `{ name, properties }` contract and the same `{ ok,
 * linkedServices }` GET shape.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Tooltip, Badge, Spinner, Caption1, Subtitle2, Text,
  Field, Input, Textarea, Switch, SpinButton, Dropdown, Option, SearchBox,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  TabList, Tab,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Add24Regular, ChevronLeft20Regular, ArrowClockwise20Regular,
  Dismiss24Regular, PlugConnected20Regular, CheckmarkCircle20Filled,
  Storage24Regular, Folder24Regular, Database24Regular, Cloud24Regular,
  Globe24Regular, Apps24Regular, Document24Regular, DataTrending24Regular,
  WeatherSnowflake24Regular, DataUsage24Regular, DocumentTable24Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import {
  CONNECTORS, connectorByType,
  type ConnectorDef, type ConnectorAuthOption, type ConfigField,
} from '@/lib/pipeline/connector-catalog';

// ---------------------------------------------------------------------------
// Engine → BFF route bindings.
// ---------------------------------------------------------------------------

export type LinkedServiceEngine = 'adf' | 'synapse';

function routeBase(engine: LinkedServiceEngine): string {
  return engine === 'synapse' ? '/api/synapse/linkedservices' : '/api/adf/linked-services';
}
function testRoute(engine: LinkedServiceEngine): string {
  return `${routeBase(engine)}/test`;
}

// ---------------------------------------------------------------------------
// Icon resolution. The catalog carries a best-effort `icon` string; map it to a
// real 24px glyph, falling back to a per-category default so a missing/unknown
// icon string still renders something on-brand (degrade gracefully).
// ---------------------------------------------------------------------------

type Glyph = React.FC<{ className?: string }>;

const ICON_BY_NAME: Record<string, Glyph> = {
  CloudDatabase: Storage24Regular,
  CloudDatabaseRegular: Storage24Regular,
  StorageRegular: Storage24Regular,
  FolderRegular: Folder24Regular,
  DatabaseRegular: Database24Regular,
  DatabaseLightningRegular: Database24Regular,
  DataWarehouseRegular: DataUsage24Regular,
  DataTrendingRegular: DataTrending24Regular,
  SnowflakeRegular: WeatherSnowflake24Regular,
  CloudRegular: Cloud24Regular,
  GlobeRegular: Globe24Regular,
  AppsRegular: Apps24Regular,
  DocumentRegular: Document24Regular,
};

const ICON_BY_CATEGORY: Record<ConnectorDef['category'], Glyph> = {
  azure: Cloud24Regular,
  database: Database24Regular,
  file: Folder24Regular,
  nosql: DataUsage24Regular,
  'generic-protocol': Globe24Regular,
  'services-and-apps': Apps24Regular,
};

function connectorGlyph(c: ConnectorDef): Glyph {
  if (c.icon && ICON_BY_NAME[c.icon]) return ICON_BY_NAME[c.icon];
  return ICON_BY_CATEGORY[c.category] ?? DocumentTable24Regular;
}

// ---------------------------------------------------------------------------
// Category presentation order + labels (matches the ADF "All / Azure / Database
// / File / NoSQL / Generic protocol / Services & apps" gallery groupings).
// ---------------------------------------------------------------------------

const CATEGORY_ORDER: ConnectorDef['category'][] = [
  'azure', 'database', 'file', 'nosql', 'generic-protocol', 'services-and-apps',
];
const CATEGORY_LABEL: Record<ConnectorDef['category'], string> = {
  azure: 'Azure',
  database: 'Database',
  file: 'File',
  nosql: 'NoSQL',
  'generic-protocol': 'Generic protocol',
  'services-and-apps': 'Services & apps',
};

const NAME_RE = /^[A-Za-z0-9_]{1,260}$/;

// ---------------------------------------------------------------------------

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  headRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  headTitle: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  headActions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexShrink: 0 },
  search: { width: '100%', maxWidth: '420px' },

  // gallery
  categoryBlock: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  categoryHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  countBadge: { marginInlineStart: tokens.spacingHorizontalXS },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    gap: tokens.spacingHorizontalM,
    minWidth: 0,
  },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM, textAlign: 'left', alignItems: 'flex-start',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
    cursor: 'pointer', height: '100%', minWidth: 0, width: '100%',
    transitionProperty: 'box-shadow, border-color, transform', transitionDuration: tokens.durationNormal,
    ':hover': { boxShadow: tokens.shadow16, border: `1px solid ${tokens.colorBrandStroke1}` },
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorBrandForeground1, minWidth: 0, width: '100%' },
  cardName: { minWidth: 0, overflowWrap: 'anywhere' },
  cardDesc: {
    color: tokens.colorNeutralForeground3, minWidth: 0, overflowWrap: 'anywhere',
    display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
  },
  cardIcon: { fontSize: '24px', flexShrink: 0 },
  emptyResults: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalXXL, textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    border: `1px dashed ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2,
  },

  // config form
  configHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0, maxWidth: '560px' },
  formActions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  fieldGroupLabel: { color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalXS },
  okBar: { color: tokens.colorPaletteGreenForeground1, display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },

  // existing list
  existingList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  existingRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalS, paddingInline: tokens.spacingHorizontalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1, minWidth: 0,
  },
  existingRowSel: { border: `1px solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2 },
  existingName: { display: 'flex', flexDirection: 'column', minWidth: 0 },

  // picker
  pickerRow: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalS, minWidth: 0, flexWrap: 'wrap' },
  pickerGrow: { flex: 1, minWidth: '220px' },
});

// ===========================================================================
// A single structured control rendered from a catalog ConfigField. Renders the
// right Fluent control per field.kind — NEVER a freeform JSON textarea.
// `secret` text becomes a password input. `multiline` becomes a Textarea.
// ===========================================================================

type FieldValue = string | number | boolean;

function CatalogFieldControl({
  field, value, error, onChange,
}: {
  field: ConfigField;
  value: FieldValue | undefined;
  error?: string;
  onChange: (v: FieldValue) => void;
}) {
  const hint = field.hint
    + (field.supportsDynamic ? (field.hint ? ' ' : '') + 'Supports @{…} dynamic content.' : '');

  if (field.kind === 'boolean') {
    return (
      <Field label={field.label} hint={field.hint} validationMessage={error}>
        <Switch checked={value === true} onChange={(_, d) => onChange(d.checked)} />
      </Field>
    );
  }
  if (field.kind === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    return (
      <Field label={field.label} hint={hint || undefined} required={field.required} validationMessage={error}>
        <SpinButton
          value={Number.isFinite(n) ? n : 0}
          placeholder={field.placeholder}
          onChange={(_, d) => {
            const next = d.value ?? (d.displayValue !== undefined ? Number(d.displayValue) : undefined);
            if (next !== undefined && next !== null && Number.isFinite(Number(next))) onChange(Number(next));
          }}
        />
      </Field>
    );
  }
  if (field.kind === 'select') {
    const opts = field.options || [];
    const cur = value === undefined || value === null ? '' : String(value);
    const curLabel = opts.find((o) => o.value === cur)?.label || cur;
    return (
      <Field label={field.label} hint={hint || undefined} required={field.required} validationMessage={error}>
        <Dropdown
          placeholder="Select…"
          value={curLabel}
          selectedOptions={cur ? [cur] : []}
          onOptionSelect={(_, d) => { if (d.optionValue !== undefined) onChange(d.optionValue); }}>
          {opts.map((o) => <Option key={o.value} value={o.value} text={o.label}>{o.label}</Option>)}
        </Dropdown>
      </Field>
    );
  }
  if (field.kind === 'multiline') {
    return (
      <Field label={field.label} hint={hint || undefined} required={field.required} validationMessage={error}>
        <Textarea
          value={value === undefined || value === null ? '' : String(value)}
          placeholder={field.placeholder}
          textarea={{ style: { fontFamily: field.secret ? tokens.fontFamilyMonospace : undefined } }}
          rows={4}
          onChange={(_, d) => onChange(d.value)}
        />
      </Field>
    );
  }
  // text / password
  return (
    <Field label={field.label} hint={hint || undefined} required={field.required} validationMessage={error}>
      <Input
        type={field.secret ? 'password' : 'text'}
        value={value === undefined || value === null ? '' : String(value)}
        placeholder={field.placeholder}
        onChange={(_, d) => onChange(d.value)}
      />
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Field helpers — visibility (showIf) + validation + payload assembly.
// ---------------------------------------------------------------------------

/** Fields that are actually shown for the chosen connector + auth option. */
function visibleFields(def: ConnectorDef, auth: ConnectorAuthOption | undefined, values: Record<string, FieldValue>): ConfigField[] {
  const all = [...(def.commonFields || []), ...((auth?.fields) || [])];
  return all.filter((f) => {
    if (!f.showIf) return true;
    const cur = values[f.showIf.key];
    return cur !== undefined && String(cur) === f.showIf.equals;
  });
}

function validate(def: ConnectorDef, auth: ConnectorAuthOption | undefined, values: Record<string, FieldValue>): Record<string, string> {
  const errs: Record<string, string> = {};
  for (const f of visibleFields(def, auth, values)) {
    if (!f.required) continue;
    const v = values[f.key];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      errs[f.key] = `${f.label} is required.`;
    }
  }
  return errs;
}

/** Build the linked-service `properties` object from the form values. */
function buildProperties(
  def: ConnectorDef,
  auth: ConnectorAuthOption | undefined,
  values: Record<string, FieldValue>,
  description: string,
): { type: string; description?: string; typeProperties: Record<string, unknown> } {
  const typeProperties: Record<string, unknown> = {};
  for (const f of visibleFields(def, auth, values)) {
    const v = values[f.key];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) continue;
    // Secret fields go to the ARM secureString shape so the credential is never
    // round-tripped as plaintext in the saved resource.
    typeProperties[f.key] = f.secret
      ? { type: 'SecureString', value: String(v) }
      : v;
  }
  return {
    type: def.type,
    ...(description.trim() ? { description: description.trim() } : {}),
    typeProperties,
  };
}

// ===========================================================================
// Existing linked-service row shape (from the GET { ok, linkedServices }).
// ===========================================================================

interface ExistingLs { name: string; type?: string }

function existingType(ls: ExistingLs): string | undefined {
  // ADF returns { name, properties: { type } }; Synapse returns { name, type }.
  return ls.type || (ls as any)?.properties?.type;
}

// ===========================================================================
// Config form (full-surface) — used by both the gallery and the picker dialog.
// ===========================================================================

function ConnectorConfigForm({
  engine, def, onBack, onCreated,
}: {
  engine: LinkedServiceEngine;
  def: ConnectorDef;
  onBack: () => void;
  onCreated: (name: string) => void;
}) {
  const s = useStyles();
  const Glyph = connectorGlyph(def);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [authIdx, setAuthIdx] = useState(0);
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<'ok' | null>(null);
  const [testErr, setTestErr] = useState<string | null>(null);

  const auth = def.authOptions[authIdx];
  const shown = useMemo(() => visibleFields(def, auth, values), [def, auth, values]);
  const commonShown = shown.filter((f) => (def.commonFields || []).includes(f));
  const authShown = shown.filter((f) => !(def.commonFields || []).includes(f));

  const setField = useCallback((key: string, v: FieldValue) => {
    setValues((prev) => ({ ...prev, [key]: v }));
    setErrors((prev) => { const n = { ...prev }; delete n[key]; return n; });
    setTested(null); setTestErr(null);
  }, []);

  const chooseAuth = useCallback((idx: number) => {
    setAuthIdx(idx); setErrors({}); setTested(null); setTestErr(null);
  }, []);

  const test = useCallback(async () => {
    setTestErr(null); setSubmitErr(null);
    const errs = validate(def, auth, values);
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setTesting(true); setTested(null);
    try {
      const properties = buildProperties(def, auth, values, description);
      const r = await clientFetch(testRoute(engine), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ properties }),
      }, 30000);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) { setTestErr(j?.error || `HTTP ${r.status}`); return; }
      setTested('ok');
    } catch (e: any) { setTestErr(e?.message || String(e)); }
    finally { setTesting(false); }
  }, [engine, def, auth, values, description]);

  const create = useCallback(async () => {
    setSubmitErr(null);
    const nm = name.trim();
    if (!NAME_RE.test(nm)) { setSubmitErr('Name must be 1-260 chars: letters, digits, and underscore only.'); return; }
    const errs = validate(def, auth, values);
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setSubmitting(true);
    try {
      const properties = buildProperties(def, auth, values, description);
      const r = await clientFetch(routeBase(engine), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: nm, properties }),
      }, 30000);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) { setSubmitErr(j?.error || `HTTP ${r.status}`); return; }
      onCreated(nm);
    } catch (e: any) { setSubmitErr(e?.message || String(e)); }
    finally { setSubmitting(false); }
  }, [engine, def, auth, values, name, description, onCreated]);

  return (
    <div className={s.root}>
      <div className={s.headRow}>
        <div className={s.configHead}>
          <Button appearance="subtle" icon={<ChevronLeft20Regular />} onClick={onBack}>Back</Button>
          <Glyph className={s.cardIcon} />
          <Subtitle2>New {def.name} linked service</Subtitle2>
        </div>
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{def.description}</Caption1>

      <div className={s.form}>
        <Field
          label="Name"
          required
          validationMessage={!name || NAME_RE.test(name.trim()) ? undefined : 'Letters, digits, and underscore only.'}>
          <Input value={name} placeholder={`e.g. ${def.type}_conn`} onChange={(_, d) => { setName(d.value); setSubmitErr(null); }} />
        </Field>

        <Field label="Description">
          <Input value={description} placeholder="Optional" onChange={(_, d) => setDescription(d.value)} />
        </Field>

        {/* Common (endpoint / db) fields */}
        {commonShown.map((f) => (
          <CatalogFieldControl key={f.key} field={f} value={values[f.key]} error={errors[f.key]} onChange={(v) => setField(f.key, v)} />
        ))}

        {/* Auth selector + the chosen auth's fields */}
        {def.authOptions.length > 0 && (
          <>
            <Caption1 className={s.fieldGroupLabel}>Authentication</Caption1>
            <Field label="Authentication method" required>
              <Dropdown
                value={auth?.label || ''}
                selectedOptions={[String(authIdx)]}
                onOptionSelect={(_, d) => { if (d.optionValue !== undefined) chooseAuth(Number(d.optionValue)); }}>
                {def.authOptions.map((a, i) => (
                  <Option key={i} value={String(i)} text={a.label}>{a.label}</Option>
                ))}
              </Dropdown>
            </Field>
            {authShown.map((f) => (
              <CatalogFieldControl key={f.key} field={f} value={values[f.key]} error={errors[f.key]} onChange={(v) => setField(f.key, v)} />
            ))}
          </>
        )}

        {testErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Test failed</MessageBarTitle>{testErr}</MessageBarBody></MessageBar>}
        {tested === 'ok' && !testErr && (
          <div className={s.okBar}><CheckmarkCircle20Filled /><Caption1>Connection validated against the {engine === 'synapse' ? 'Synapse workspace' : 'Data Factory'}.</Caption1></div>
        )}
        {submitErr && <MessageBar intent="error"><MessageBarBody>{submitErr}</MessageBarBody></MessageBar>}

        <div className={s.formActions}>
          <Button appearance="primary" icon={<PlugConnected20Regular />} disabled={submitting || !name.trim()} onClick={create}>
            {submitting ? 'Creating…' : 'Create'}
          </Button>
          <Button appearance="secondary" icon={testing ? <Spinner size="tiny" /> : <ArrowClockwise20Regular />} disabled={testing || submitting} onClick={test}>
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
          <Button appearance="subtle" disabled={submitting} onClick={onBack}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// The connector gallery (browse + search + pick).
// ===========================================================================

function ConnectorGalleryGrid({ onPick }: { onPick: (def: ConnectorDef) => void }) {
  const s = useStyles();
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return CONNECTORS;
    return CONNECTORS.filter((c) =>
      c.name.toLowerCase().includes(needle)
      || c.type.toLowerCase().includes(needle)
      || (c.description || '').toLowerCase().includes(needle));
  }, [q]);

  const byCategory = useMemo(() => {
    const map = new Map<ConnectorDef['category'], ConnectorDef[]>();
    for (const c of filtered) {
      const list = map.get(c.category) || [];
      list.push(c);
      map.set(c.category, list);
    }
    return map;
  }, [filtered]);

  return (
    <div className={s.root}>
      <SearchBox
        className={s.search}
        placeholder="Search connectors (name, type, description)…"
        value={q}
        onChange={(_, d) => setQ(d.value)}
        aria-label="Search connectors"
      />

      {filtered.length === 0 ? (
        <div className={s.emptyResults}>
          <Globe24Regular />
          <Subtitle2>No connectors match &ldquo;{q}&rdquo;</Subtitle2>
          <Caption1>Try a different term — e.g. &ldquo;sql&rdquo;, &ldquo;blob&rdquo;, &ldquo;rest&rdquo;, or a connector type.</Caption1>
        </div>
      ) : (
        CATEGORY_ORDER.filter((cat) => byCategory.has(cat)).map((cat) => {
          const list = byCategory.get(cat) || [];
          return (
            <div key={cat} className={s.categoryBlock}>
              <div className={s.categoryHead}>
                <Subtitle2>{CATEGORY_LABEL[cat]}</Subtitle2>
                <Badge className={s.countBadge} appearance="tint" color="informative">{list.length}</Badge>
              </div>
              <div className={s.grid}>
                {list.map((c) => {
                  const Glyph = connectorGlyph(c);
                  return (
                    <button key={c.type} type="button" className={s.card} onClick={() => onPick(c)} aria-label={`New ${c.name} linked service`}>
                      <span className={s.cardHead}>
                        <Glyph className={s.cardIcon} />
                        <Text weight="semibold" className={s.cardName}>{c.name}</Text>
                      </span>
                      <Caption1 className={s.cardDesc}>{c.description}</Caption1>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// ===========================================================================
// Select-existing list (real linked services already on the factory/workspace).
// ===========================================================================

function ExistingLinkedServices({
  engine, selectedName, onSelected,
}: {
  engine: LinkedServiceEngine;
  selectedName?: string;
  onSelected: (name: string) => void;
}) {
  const s = useStyles();
  const [rows, setRows] = useState<ExistingLs[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gate, setGate] = useState<{ missing: string } | null>(null);

  const load = useCallback(async () => {
    setErr(null); setGate(null);
    try {
      const r = await clientFetch(routeBase(engine));
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 && j?.missing) { setGate({ missing: j.missing }); setRows([]); return; }
      if (!r.ok || !j?.ok) { setErr(j?.error || `HTTP ${r.status}`); setRows([]); return; }
      setRows(Array.isArray(j.linkedServices) ? j.linkedServices : []);
    } catch (e: any) { setErr(e?.message || String(e)); setRows([]); }
  }, [engine]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className={s.root}>
      <div className={s.headRow}>
        <Subtitle2>Existing linked services</Subtitle2>
        <Tooltip content="Refresh" relationship="label">
          <Button appearance="subtle" icon={<ArrowClockwise20Regular />} onClick={() => { setRows(null); void load(); }} aria-label="Refresh" />
        </Tooltip>
      </div>

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>{engine === 'synapse' ? 'Synapse workspace' : 'Data Factory'} not configured</MessageBarTitle>
            Set the <code>{gate.missing}</code> environment variable on the Console so it can reach the backing
            {engine === 'synapse' ? ' Synapse workspace' : ' Azure Data Factory'}. Until then, linked services can&apos;t be listed.
          </MessageBarBody>
        </MessageBar>
      )}
      {err && !gate && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
      {rows === null && !gate && <Spinner size="tiny" label="Loading linked services…" />}

      {rows !== null && rows.length === 0 && !gate && !err && (
        <div className={s.emptyResults}>
          <PlugConnected20Regular />
          <Subtitle2>No linked services yet</Subtitle2>
          <Caption1>Create one from the gallery to connect a data store.</Caption1>
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <div className={s.existingList}>
          {rows.map((ls) => {
            const t = existingType(ls);
            const def = t ? connectorByType(t) : undefined;
            const Glyph = def ? connectorGlyph(def) : DocumentTable24Regular;
            const sel = selectedName === ls.name;
            return (
              <div key={ls.name} className={`${s.existingRow}${sel ? ` ${s.existingRowSel}` : ''}`}>
                <div className={s.configHead}>
                  <Glyph className={s.cardIcon} />
                  <div className={s.existingName}>
                    <Text weight="semibold">{ls.name}</Text>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{def?.name || t || 'Linked service'}</Caption1>
                  </div>
                </div>
                <Button size="small" appearance={sel ? 'primary' : 'secondary'} onClick={() => onSelected(ls.name)}>
                  {sel ? 'Selected' : 'Select'}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// <LinkedServiceGallery /> — gallery + config wizard + select-existing tab.
// ===========================================================================

export interface LinkedServiceGalleryProps {
  /** Backend: 'adf' (default) → Azure Data Factory; 'synapse' → Synapse workspace. */
  engine?: LinkedServiceEngine;
  /** Fires with the linked-service name on a successful create OR an existing pick. */
  onSelected?: (name: string) => void;
  /** Hide the "Select existing" tab (e.g. when the caller only wants create-new). */
  hideExisting?: boolean;
  /** The currently-selected linked-service name (highlighted in the existing list). */
  selectedName?: string;
}

export function LinkedServiceGallery({
  engine = 'adf', onSelected, hideExisting, selectedName,
}: LinkedServiceGalleryProps) {
  const s = useStyles();
  const [tab, setTab] = useState<'new' | 'existing'>('new');
  const [picked, setPicked] = useState<ConnectorDef | null>(null);

  const handleCreated = useCallback((nm: string) => {
    setPicked(null);
    onSelected?.(nm);
  }, [onSelected]);

  if (picked) {
    return (
      <ConnectorConfigForm
        engine={engine}
        def={picked}
        onBack={() => setPicked(null)}
        onCreated={handleCreated}
      />
    );
  }

  return (
    <div className={s.root}>
      {!hideExisting && (
        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'new' | 'existing')}>
          <Tab value="new" icon={<Add20Regular />}>New</Tab>
          <Tab value="existing" icon={<PlugConnected20Regular />}>Select existing</Tab>
        </TabList>
      )}

      {tab === 'new' || hideExisting ? (
        <ConnectorGalleryGrid onPick={setPicked} />
      ) : (
        <ExistingLinkedServices
          engine={engine}
          selectedName={selectedName}
          onSelected={(nm) => onSelected?.(nm)}
        />
      )}
    </div>
  );
}

// ===========================================================================
// <LinkedServicePicker /> — compact select-existing dropdown + "＋ New" dialog.
// Use inside dataset / Copy-activity "Linked service" fields.
// ===========================================================================

export interface LinkedServicePickerProps {
  engine?: LinkedServiceEngine;
  /** The currently-selected linked-service name. */
  value?: string;
  /** Fires with the chosen linked-service name (existing pick or freshly created). */
  onSelected: (name: string) => void;
  label?: string;
  required?: boolean;
  disabled?: boolean;
}

export function LinkedServicePicker({
  engine = 'adf', value, onSelected, label = 'Linked service', required, disabled,
}: LinkedServicePickerProps) {
  const s = useStyles();
  const [rows, setRows] = useState<ExistingLs[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gate, setGate] = useState<{ missing: string } | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);

  const load = useCallback(async () => {
    setErr(null); setGate(null);
    try {
      const r = await clientFetch(routeBase(engine));
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 && j?.missing) { setGate({ missing: j.missing }); setRows([]); return; }
      if (!r.ok || !j?.ok) { setErr(j?.error || `HTTP ${r.status}`); setRows([]); return; }
      setRows(Array.isArray(j.linkedServices) ? j.linkedServices : []);
    } catch (e: any) { setErr(e?.message || String(e)); setRows([]); }
  }, [engine]);

  useEffect(() => { void load(); }, [load]);

  const onGalleryCreated = useCallback((nm: string) => {
    setGalleryOpen(false);
    void load();
    onSelected(nm);
  }, [load, onSelected]);

  const selectedRow = (rows || []).find((r) => r.name === value);

  return (
    <>
      <div className={s.pickerRow}>
        <Field label={label} required={required} className={s.pickerGrow}
          validationMessage={err && !gate ? err : undefined}
          validationState={err && !gate ? 'error' : undefined}>
          <Dropdown
            disabled={disabled || !!gate}
            placeholder={
              gate ? 'Backend not configured'
                : rows === null ? 'Loading…'
                : 'Select a linked service'
            }
            value={selectedRow?.name || value || ''}
            selectedOptions={value ? [value] : []}
            onOptionSelect={(_, d) => { if (d.optionValue) onSelected(d.optionValue); }}>
            {(rows || []).map((ls) => {
              const t = existingType(ls);
              const def = t ? connectorByType(t) : undefined;
              return (
                <Option key={ls.name} value={ls.name} text={ls.name}>
                  {ls.name}{def ? ` · ${def.name}` : t ? ` · ${t}` : ''}
                </Option>
              );
            })}
          </Dropdown>
        </Field>
        <Button appearance="secondary" icon={<Add20Regular />} disabled={disabled} onClick={() => setGalleryOpen(true)}>
          New
        </Button>
      </div>

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>{engine === 'synapse' ? 'Synapse workspace' : 'Data Factory'} not configured</MessageBarTitle>
            Set <code>{gate.missing}</code> on the Console to list and create linked services.
          </MessageBarBody>
        </MessageBar>
      )}

      <Dialog open={galleryOpen} onOpenChange={(_, d) => { if (!d.open) setGalleryOpen(false); }}>
        <DialogSurface style={{ maxWidth: '920px' }}>
          <DialogBody>
            <DialogTitle
              action={<Button appearance="subtle" icon={<Dismiss24Regular />} aria-label="Close" onClick={() => setGalleryOpen(false)} />}>
              <span className={s.configHead}><Add24Regular /> New linked service</span>
            </DialogTitle>
            <DialogContent>
              <LinkedServiceGallery engine={engine} hideExisting onSelected={onGalleryCreated} />
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setGalleryOpen(false)}>Cancel</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

export default LinkedServiceGallery;
