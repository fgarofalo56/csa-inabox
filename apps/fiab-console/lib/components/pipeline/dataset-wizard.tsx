'use client';

/**
 * DatasetWizard + DatasetPicker — the ADF / Synapse "New dataset" surface, themed
 * for Loom (Fluent UI v9 + Loom design tokens), one-for-one with the ADF/Synapse
 * Studio "New dataset" flow.
 *
 * A factory/workspace DATASET (Microsoft.DataFactory/factories/datasets, or the
 * Synapse dev-plane equivalent) is the named, reusable shape a Copy / Data Flow /
 * Lookup activity reads or writes. ADF Studio's "New dataset" wizard walks four
 * steps; this builds all four, structured from `connector-catalog.ts` — never a
 * freeform JSON textarea (per loom-no-freeform-config):
 *
 *   1. Pick a CONNECTOR (the same gallery the Get-data / linked-service surface
 *      uses — `CONNECTORS` from connector-catalog.ts, category list + searchable
 *      card grid).
 *   2. Pick or CREATE the LINKED SERVICE (the connection). `<LinkedServicePicker/>`
 *      lists the factory's existing linked services of the chosen connector type
 *      (real GET) and offers an inline "＋ New …" that renders the connector's
 *      structured `commonFields` + the selected auth option's `fields` and POSTs a
 *      real `linkedservices` upsert. Both create-new AND select-existing.
 *   3. Choose the DATASET TYPE (from the connector's `datasetTypes`) and fill its
 *      `locationFields` (container / folder / file, or schema / table) — structured
 *      inputs from the catalog.
 *   4. Optional SCHEMA import — add columns (name + ADF data type) structurally.
 *      Written to the dataset's `properties.schema[]`, which ADF persists. (The ADF
 *      management REST exposes no server-side schema-detect action — Studio's
 *      "Import schema" is a data-plane debug preview — so the honest parity
 *      affordance is a structured column editor, not a faked auto-detect.)
 *
 * Finish assembles the dataset `properties` and POSTs to the real BFF
 * (`/api/adf/datasets` or `/api/synapse/datasets`), which calls the real ARM /
 * Synapse-dev `upsertDataset`. No mocks (per no-vaporware.md).
 *
 * `<DatasetPicker/>` is the select-existing entry point: a labelled dropdown of
 * the factory's datasets (real GET) plus a "＋ New" button that opens this wizard
 * and selects the freshly-created dataset on success — both select-existing AND
 * create-new, as the operator requires.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Input, Field, Dropdown, Option, Switch, Badge, Spinner, Divider,
  Subtitle2, Body1, Caption1, Text, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Add16Regular, Dismiss16Regular, Delete16Regular,
  ArrowLeft20Regular, ArrowClockwise16Regular, Search20Regular,
  Database20Regular, DatabaseStack16Regular, PlugConnected20Regular,
  CheckmarkCircle16Filled, Table20Regular,
  Database24Regular, Storage24Regular, Folder24Regular,
  DatabaseLink24Regular, DataTrending24Regular, DataHistogram24Regular,
  Cloud24Regular, Globe24Regular, Apps24Regular, Document24Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import {
  CONNECTORS, connectorByType,
  type ConnectorDef, type ConnectorAuthOption, type ConfigField,
} from '@/lib/pipeline/connector-catalog';
import type { AdfDataset } from '@/lib/azure/adf-client';

// ---------------------------------------------------------------------------
// Provider plumbing — ADF (default) or Synapse share the same catalog + the
// same { name, properties } POST contract; only the route base differs.
// ---------------------------------------------------------------------------

export type DatasetProvider = 'adf' | 'synapse';

interface Routes { datasets: string; linkedServices: string }
function routesFor(provider: DatasetProvider): Routes {
  return provider === 'synapse'
    ? { datasets: '/api/synapse/datasets', linkedServices: '/api/synapse/linkedservices' }
    : { datasets: '/api/adf/datasets', linkedServices: '/api/adf/linked-services' };
}
function providerLabel(provider: DatasetProvider): string {
  return provider === 'synapse' ? 'Synapse workspace' : 'Data Factory';
}

const NAME_RE = /^[A-Za-z0-9_]{1,260}$/;

/** A linked service as returned by either BFF (ADF carries full props; Synapse
 *  returns {name,type}). We only need name + connector type here. */
interface LinkedServiceRow { name: string; type?: string }

/** ADF dataset `schema[]` column (name + ADF data type). */
interface SchemaColumn { name: string; type: string }

/** ADF logical column types offered in the optional schema editor. */
const SCHEMA_TYPES: { value: string; label: string }[] = [
  { value: 'String', label: 'String' },
  { value: 'Int32', label: 'Int32' },
  { value: 'Int64', label: 'Int64' },
  { value: 'Decimal', label: 'Decimal' },
  { value: 'Double', label: 'Double' },
  { value: 'Boolean', label: 'Boolean' },
  { value: 'DateTime', label: 'DateTime' },
  { value: 'Date', label: 'Date' },
  { value: 'Guid', label: 'GUID' },
  { value: 'Binary', label: 'Binary' },
];

// ---------------------------------------------------------------------------
// Connector icon resolution — map the catalog's best-effort `icon` string (and
// its category) to a real `@fluentui/react-icons` glyph. Falls back per-category
// so every connector shows something on-brand (no broken/empty chip).
// ---------------------------------------------------------------------------

type IconCmp = React.FC<{ className?: string; style?: React.CSSProperties }>;
const ICON_BY_NAME: Record<string, IconCmp> = {
  CloudDatabase: Database24Regular,
  StorageRegular: Storage24Regular,
  FolderRegular: Folder24Regular,
  DatabaseRegular: Database24Regular,
  DataWarehouseRegular: DataHistogram24Regular,
  DataTrendingRegular: DataTrending24Regular,
  DatabaseLightningRegular: DatabaseLink24Regular,
  SnowflakeRegular: DataTrending24Regular,
  CloudRegular: Cloud24Regular,
  GlobeRegular: Globe24Regular,
  AppsRegular: Apps24Regular,
  DocumentRegular: Document24Regular,
};
const ICON_BY_CATEGORY: Record<ConnectorDef['category'], IconCmp> = {
  azure: Database24Regular,
  database: Database24Regular,
  file: Folder24Regular,
  nosql: DatabaseLink24Regular,
  'generic-protocol': Globe24Regular,
  'services-and-apps': Apps24Regular,
};
function connectorIcon(c: ConnectorDef): IconCmp {
  return (c.icon && ICON_BY_NAME[c.icon]) || ICON_BY_CATEGORY[c.category] || Database24Regular;
}

const CATEGORY_LABEL: Record<ConnectorDef['category'], string> = {
  azure: 'Azure',
  database: 'Database',
  file: 'File',
  nosql: 'NoSQL',
  'generic-protocol': 'Protocol',
  'services-and-apps': 'Services & apps',
};
const CATEGORY_ORDER: ConnectorDef['category'][] = [
  'azure', 'database', 'file', 'nosql', 'generic-protocol', 'services-and-apps',
];

// ---------------------------------------------------------------------------

const useStyles = makeStyles({
  surface: { maxWidth: '920px', width: '92vw' },
  // Step indicator
  steps: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    marginBottom: tokens.spacingVerticalM, flexWrap: 'wrap',
  },
  stepPill: {
    display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium, color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold,
  },
  stepActive: { backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1 },
  stepDone: { color: tokens.colorPaletteGreenForeground1 },
  stepSep: { color: tokens.colorNeutralForeground4 },
  // Connector gallery
  gallery: { display: 'grid', gridTemplateColumns: '180px minmax(0, 1fr)', gap: tokens.spacingHorizontalL, minHeight: '420px' },
  catList: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    borderRight: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    paddingRight: tokens.spacingHorizontalS,
  },
  catItem: {
    textAlign: 'left', padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium, background: 'transparent', border: 'none',
    cursor: 'pointer', color: tokens.colorNeutralForeground1, fontSize: tokens.fontSizeBase300,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
    ':focus-visible': { outline: `${tokens.strokeWidthThick} solid ${tokens.colorStrokeFocus2}`, outlineOffset: tokens.strokeWidthThin },
  },
  catItemActive: { backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1, fontWeight: tokens.fontWeightSemibold },
  rightCol: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: tokens.spacingHorizontalS, alignContent: 'start', overflowY: 'auto',
    paddingRight: tokens.spacingHorizontalXS, minWidth: 0,
  },
  card: {
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalM,
    cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    backgroundColor: tokens.colorNeutralBackground1, textAlign: 'left',
    boxShadow: tokens.shadow4, transitionDuration: tokens.durationNormal, transitionProperty: 'box-shadow, border-color',
    ':hover': { borderColor: tokens.colorBrandStroke1, boxShadow: tokens.shadow16 },
    ':focus-visible': { outline: `${tokens.strokeWidthThick} solid ${tokens.colorStrokeFocus2}`, outlineOffset: tokens.strokeWidthThin },
  },
  cardSelected: { borderColor: tokens.colorBrandStroke1, boxShadow: tokens.shadow8 },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  chip: {
    flexShrink: 0, width: '36px', height: '36px',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1,
  },
  cardName: { fontWeight: tokens.fontWeightSemibold, lineHeight: tokens.lineHeightBase300, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
  cardDesc: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2, lineHeight: tokens.lineHeightBase200 },
  cardTags: { display: 'flex', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalXS, flexWrap: 'wrap' },
  emptyGrid: {
    gridColumn: '1 / -1', padding: tokens.spacingVerticalXXL,
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalS,
    textAlign: 'center', color: tokens.colorNeutralForeground3,
  },
  // Form steps
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  formHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, minWidth: 0 },
  sectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalXS },
  sectionIcon: { color: tokens.colorBrandForeground1, flexShrink: 0 },
  sectionTitle: { fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1 },
  twoCol: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacingHorizontalS },
  createPanel: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke2}`,
    borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  createHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, fontWeight: tokens.fontWeightSemibold },
  createActions: { display: 'flex', gap: tokens.spacingHorizontalS, justifyContent: 'flex-end' },
  lsRow: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalS },
  lsGrow: { flex: 1, minWidth: 0 },
  schemaRow: { display: 'grid', gridTemplateColumns: '1fr 160px auto', gap: tokens.spacingHorizontalS, alignItems: 'flex-end' },
  schemaEmpty: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium,
    border: `${tokens.strokeWidthThin} dashed ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2, color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  // DatasetPicker
  pickerRow: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalS },
  pickerGrow: { flex: 1, minWidth: 0 },
  pickerMeta: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center', marginTop: tokens.spacingVerticalXXS, flexWrap: 'wrap' },
});

// ---------------------------------------------------------------------------
// Structured field renderer (shared by the linked-service create panel and the
// dataset location step). Renders one ConfigField as the right Fluent control —
// NEVER a JSON textarea (per loom-no-freeform-config).
// ---------------------------------------------------------------------------

function isFieldVisible(f: ConfigField, values: Record<string, string>): boolean {
  if (!f.showIf) return true;
  return (values[f.showIf.key] || '') === f.showIf.equals;
}

function FieldControl({
  field, value, onChange,
}: { field: ConfigField; value: string; onChange: (v: string) => void }) {
  if (field.kind === 'boolean') {
    return (
      <Field hint={field.hint}>
        <Switch label={field.label} checked={value === 'true'} onChange={(_, d) => onChange(d.checked ? 'true' : '')} />
      </Field>
    );
  }
  if (field.kind === 'select') {
    const cur = value || '';
    const curLabel = field.options?.find((o) => o.value === cur)?.label || '';
    return (
      <Field label={field.label} required={field.required} hint={field.hint}>
        <Dropdown
          aria-label={field.label}
          placeholder={field.placeholder || 'Select…'}
          selectedOptions={cur ? [cur] : []}
          value={curLabel}
          onOptionSelect={(_, d) => onChange(d.optionValue || '')}
        >
          {(field.options || []).map((o) => <Option key={o.value} value={o.value}>{o.label}</Option>)}
        </Dropdown>
      </Field>
    );
  }
  const inputType = field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text';
  return (
    <Field
      label={field.label}
      required={field.required}
      hint={field.secret ? `${field.hint ? field.hint + ' ' : ''}Stored securely as a secureString — never kept in plaintext.` : field.hint}
    >
      {field.kind === 'multiline' ? (
        <textarea
          aria-label={field.label}
          value={value}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          style={{
            fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200,
            padding: tokens.spacingVerticalSNudge, borderRadius: tokens.borderRadiusMedium,
            border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1}`,
            background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1,
            resize: 'vertical', width: '100%', boxSizing: 'border-box',
          }}
        />
      ) : (
        <Input
          type={inputType}
          placeholder={field.placeholder}
          value={value}
          onChange={(_, d) => onChange(d.value)}
        />
      )}
    </Field>
  );
}

/** Render the ordered field list, honoring per-field `showIf` visibility. */
function FieldList({
  fields, values, setValue,
}: { fields: ConfigField[]; values: Record<string, string>; setValue: (k: string, v: string) => void }) {
  return (
    <>
      {fields.filter((f) => isFieldVisible(f, values)).map((f) => (
        <FieldControl key={f.key} field={f} value={values[f.key] || ''} onChange={(v) => setValue(f.key, v)} />
      ))}
    </>
  );
}

/** Build a linked-service `typeProperties` payload from the connector's common
 *  fields + the chosen auth option's fields. Secrets become ADF AzureKeyVault-less
 *  secureStrings; the BFF/ARM persists them. */
function buildLinkedServiceProperties(
  connector: ConnectorDef, auth: ConnectorAuthOption, values: Record<string, string>,
): Record<string, unknown> {
  const typeProperties: Record<string, unknown> = {};
  const emit = (f: ConfigField) => {
    if (!isFieldVisible(f, values)) return;
    const raw = (values[f.key] || '').trim();
    if (!raw) return;
    if (f.secret) {
      typeProperties[f.key] = { type: 'SecureString', value: raw };
    } else if (f.kind === 'number') {
      const n = Number(raw);
      typeProperties[f.key] = Number.isFinite(n) ? n : raw;
    } else if (f.kind === 'boolean') {
      typeProperties[f.key] = raw === 'true';
    } else {
      typeProperties[f.key] = raw;
    }
  };
  connector.commonFields.forEach(emit);
  auth.fields.forEach(emit);
  // The auth kind drives the connector's authenticationType discriminator where
  // the ADF schema uses one. We carry the catalog auth value so SQL-family /
  // storage connectors land on the right typeProperties.authenticationType.
  return typeProperties;
}

// ===========================================================================
// LinkedServicePicker — select-existing OR create-new (inline) for the chosen
// connector type. Exported so other surfaces (Copy, Data Flow) can reuse it.
// ===========================================================================

export interface LinkedServicePickerProps {
  provider?: DatasetProvider;
  /** The connector whose linked services we list / create. */
  connector: ConnectorDef;
  /** Currently-selected linked service name ('' when none). */
  value: string;
  onChange: (name: string) => void;
  /** Honest infra-gate text (names the missing env var). */
  gateError?: string | null;
}

export function LinkedServicePicker({
  provider = 'adf', connector, value, onChange, gateError,
}: LinkedServicePickerProps) {
  const styles = useStyles();
  const routes = routesFor(provider);
  const [all, setAll] = useState<LinkedServiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // Inline create state.
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [authIdx, setAuthIdx] = useState(0);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setLoadErr(null);
    try {
      const r = await clientFetch(routes.linkedServices, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 && j?.code === 'not_configured') { setLoadErr(String(j.error || 'Not configured.')); return; }
      if (!r.ok || !j?.ok) { setLoadErr(String(j?.error || `HTTP ${r.status}`)); return; }
      const list: LinkedServiceRow[] = Array.isArray(j.linkedServices)
        ? j.linkedServices.map((l: any) => ({ name: l.name, type: l.properties?.type ?? l.type }))
        : [];
      setAll(list);
    } catch (e: any) {
      setLoadErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [routes.linkedServices]);

  useEffect(() => { load(); }, [load]);

  // Linked services matching this connector's type are the valid bindings.
  const matching = useMemo(() => all.filter((l) => (l.type || '') === connector.type), [all, connector.type]);

  function openCreate() {
    setCreating(true);
    setNewName(`${connector.type}_ls`);
    setAuthIdx(0);
    setVals({});
    setCreateErr(null);
  }

  const auth = connector.authOptions[authIdx] || connector.authOptions[0];

  const createMissingRequired = useMemo(() => {
    if (!auth) return false;
    const all = [...connector.commonFields, ...auth.fields];
    return all.some((f) => f.required && isFieldVisible(f, vals) && !(vals[f.key] || '').trim());
  }, [connector, auth, vals]);

  async function submitCreate() {
    const name = newName.trim();
    if (!name) { setCreateErr('Name is required.'); return; }
    if (!NAME_RE.test(name)) { setCreateErr('Name must be 1–260 chars: letters, digits, underscore.'); return; }
    if (!auth) { setCreateErr('Pick an authentication method.'); return; }
    setBusy(true); setCreateErr(null);
    try {
      const properties = {
        type: connector.type,
        typeProperties: buildLinkedServiceProperties(connector, auth, vals),
      };
      const r = await clientFetch(routes.linkedServices, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, properties }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) { setCreateErr(String(j?.error || `HTTP ${r.status}`)); return; }
      const created = String(j?.linkedService?.name || name);
      await load();
      onChange(created);
      setCreating(false);
    } catch (e: any) {
      setCreateErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  const placeholder = gateError || loadErr ? 'Unavailable'
    : loading ? 'Loading connections…'
    : matching.length === 0 ? `No ${connector.name} connections — create one`
    : 'Select a connection…';

  return (
    <Field label="Linked service (connection)" required hint={`The ${connector.name} connection this dataset binds to.`}>
      {(gateError || loadErr) && (
        <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalXS }}>
          <MessageBarBody>{gateError || loadErr}</MessageBarBody>
        </MessageBar>
      )}
      <div className={styles.lsRow}>
        <div className={styles.lsGrow}>
          <Dropdown
            aria-label="Linked service"
            disabled={!!gateError || loading}
            placeholder={placeholder}
            selectedOptions={value ? [value] : []}
            value={value}
            onOptionSelect={(_, d) => onChange(d.optionValue || '')}
          >
            {matching.map((l) => (
              <Option key={l.name} value={l.name} text={l.name}>{l.name}</Option>
            ))}
          </Dropdown>
        </div>
        <Tooltip content="Refresh connections" relationship="label">
          <Button
            appearance="subtle"
            icon={loading ? <Spinner size="tiny" /> : <ArrowClockwise16Regular />}
            aria-label="Refresh connections"
            disabled={!!gateError || loading}
            onClick={load}
          />
        </Tooltip>
        <Button
          appearance="secondary"
          icon={<Add16Regular />}
          disabled={!!gateError}
          onClick={() => (creating ? setCreating(false) : openCreate())}
        >
          New
        </Button>
      </div>

      {creating && auth && (
        <div className={styles.createPanel}>
          <div className={styles.createHead}>
            <PlugConnected20Regular /> New {connector.name} connection
          </div>
          <Field label="Connection name" required>
            <Input value={newName} onChange={(_, d) => setNewName(d.value)} placeholder={`${connector.type}_ls`} />
          </Field>
          {connector.authOptions.length > 1 && (
            <Field label="Authentication" required>
              <Dropdown
                aria-label="Authentication"
                selectedOptions={[String(authIdx)]}
                value={auth.label}
                onOptionSelect={(_, d) => { setAuthIdx(Number(d.optionValue) || 0); setVals({}); }}
              >
                {connector.authOptions.map((a, i) => (
                  <Option key={`${a.auth}-${i}`} value={String(i)} text={a.label}>{a.label}</Option>
                ))}
              </Dropdown>
            </Field>
          )}
          <FieldList
            fields={connector.commonFields}
            values={vals}
            setValue={(k, v) => setVals((p) => ({ ...p, [k]: v }))}
          />
          {(connector.commonFields.length > 0 && auth.fields.length > 0) && <Divider />}
          <FieldList
            fields={auth.fields}
            values={vals}
            setValue={(k, v) => setVals((p) => ({ ...p, [k]: v }))}
          />
          {auth.fields.length === 0 && connector.commonFields.length === 0 && (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              This connection needs no extra settings.
            </Caption1>
          )}
          {createErr && <MessageBar intent="error"><MessageBarBody>{createErr}</MessageBarBody></MessageBar>}
          <div className={styles.createActions}>
            <Button appearance="subtle" icon={<Dismiss16Regular />} disabled={busy}
              onClick={() => { setCreating(false); setCreateErr(null); }}>Cancel</Button>
            <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <Add16Regular />}
              disabled={busy || !newName.trim() || createMissingRequired} onClick={submitCreate}>
              {busy ? 'Creating…' : 'Create connection'}
            </Button>
          </div>
        </div>
      )}
    </Field>
  );
}

// ===========================================================================
// DatasetWizard — the 4-step "New dataset" dialog.
// ===========================================================================

type Step = 'connector' | 'connection' | 'shape' | 'schema';
const STEP_ORDER: Step[] = ['connector', 'connection', 'shape', 'schema'];
const STEP_LABEL: Record<Step, string> = {
  connector: 'Connector', connection: 'Connection', shape: 'Dataset type', schema: 'Schema',
};

export interface DatasetWizardProps {
  open: boolean;
  onClose: () => void;
  provider?: DatasetProvider;
  /** Fires with the created dataset's name after a successful upsert. */
  onCreated?: (datasetName: string) => void;
}

export function DatasetWizard({ open, onClose, provider = 'adf', onCreated }: DatasetWizardProps) {
  const styles = useStyles();
  const routes = routesFor(provider);

  const [step, setStep] = useState<Step>('connector');
  // Step 1
  const [category, setCategory] = useState<ConnectorDef['category']>('azure');
  const [query, setQuery] = useState('');
  const [connector, setConnector] = useState<ConnectorDef | null>(null);
  // Step 2
  const [linkedService, setLinkedService] = useState('');
  const [lsGate, setLsGate] = useState<string | null>(null);
  // Step 3
  const [datasetTypeIdx, setDatasetTypeIdx] = useState(0);
  const [datasetName, setDatasetName] = useState('');
  const [locVals, setLocVals] = useState<Record<string, string>>({});
  // Step 4
  const [columns, setColumns] = useState<SchemaColumn[]>([]);
  // Submit
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The linked-services route is the same gate as datasets; probe it once so we
  // can show the honest infra-gate inside the connection step's picker.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      try {
        const r = await clientFetch(routes.linkedServices, { cache: 'no-store' });
        const j = await r.json().catch(() => ({}));
        if (!alive) return;
        if (r.status === 503 && j?.code === 'not_configured') setLsGate(String(j.error || 'Not configured.'));
        else setLsGate(null);
      } catch { /* leave gate null; the picker surfaces its own load error */ }
    })();
    return () => { alive = false; };
  }, [open, routes.linkedServices]);

  function reset() {
    setStep('connector'); setCategory('azure'); setQuery(''); setConnector(null);
    setLinkedService(''); setDatasetTypeIdx(0); setDatasetName(''); setLocVals({});
    setColumns([]); setBusy(false); setErr(null);
  }

  const connectors = useMemo(() => {
    const q = query.trim().toLowerCase();
    return CONNECTORS.filter((c) =>
      q ? (c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q) || c.type.toLowerCase().includes(q))
        : c.category === category);
  }, [category, query]);

  const datasetType = connector?.datasetTypes[datasetTypeIdx] || connector?.datasetTypes[0];

  function pickConnector(c: ConnectorDef) {
    setConnector(c);
    setLinkedService('');
    setDatasetTypeIdx(0);
    setDatasetName(`${c.datasetTypes[0]?.type || c.type}_ds`);
    setLocVals({});
    setColumns([]);
    setErr(null);
    setStep('connection');
  }

  const locMissingRequired = useMemo(() => {
    if (!datasetType) return false;
    return datasetType.locationFields.some((f) => f.required && isFieldVisible(f, locVals) && !(locVals[f.key] || '').trim());
  }, [datasetType, locVals]);

  const canFinish =
    !!connector && !!datasetType && !!linkedService &&
    !!datasetName.trim() && NAME_RE.test(datasetName.trim()) &&
    !locMissingRequired && !busy;

  async function finish() {
    if (!connector || !datasetType || !canFinish) return;
    setBusy(true); setErr(null);
    try {
      // Assemble the dataset typeProperties: file connectors carry a `location`
      // object (the catalog's location fields ARE the location members); table
      // connectors carry the table-shape fields directly on typeProperties.
      const fileLikeTypes = new Set(['DelimitedText', 'Parquet', 'Json', 'Binary', 'Avro', 'Orc', 'Xml']);
      const isFileLike = fileLikeTypes.has(datasetType.type);
      const typeProperties: Record<string, unknown> = {};
      const location: Record<string, unknown> = {};
      for (const f of datasetType.locationFields) {
        if (!isFieldVisible(f, locVals)) continue;
        const raw = (locVals[f.key] || '').trim();
        if (!raw) continue;
        const v = f.kind === 'number' ? (Number.isFinite(Number(raw)) ? Number(raw) : raw)
          : f.kind === 'boolean' ? raw === 'true' : raw;
        if (isFileLike) location[f.key] = v; else typeProperties[f.key] = v;
      }
      if (isFileLike && Object.keys(location).length) {
        // The ADF DatasetLocation `type` discriminator follows the connector's
        // store (the catalog already shapes which location members exist).
        location.type = locationTypeFor(connector.type);
        typeProperties.location = location;
      }

      const schema = columns
        .filter((c) => c.name.trim())
        .map((c) => ({ name: c.name.trim(), type: c.type }));

      const properties: AdfDataset['properties'] = {
        type: datasetType.type,
        linkedServiceName: { referenceName: linkedService, type: 'LinkedServiceReference' },
        ...(Object.keys(typeProperties).length ? { typeProperties } : {}),
        ...(schema.length ? { schema } : {}),
      };

      const name = datasetName.trim();
      const r = await clientFetch(routes.datasets, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, properties }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) { setErr(String(j?.error || `HTTP ${r.status}`)); return; }
      const created = String(j?.dataset?.name || name);
      onCreated?.(created);
      reset();
      onClose();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  const stepIdx = STEP_ORDER.indexOf(step);

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) { reset(); onClose(); } }}>
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
              <Database20Regular /> New dataset
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>({providerLabel(provider)})</Caption1>
            </span>
          </DialogTitle>
          <DialogContent>
            {/* Step indicator */}
            <div className={styles.steps} role="list" aria-label="Wizard steps">
              {STEP_ORDER.map((s, i) => (
                <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
                  <span
                    role="listitem"
                    className={`${styles.stepPill} ${s === step ? styles.stepActive : i < stepIdx ? styles.stepDone : ''}`}
                  >
                    {i < stepIdx ? <CheckmarkCircle16Filled /> : null}
                    {i + 1}. {STEP_LABEL[s]}
                  </span>
                  {i < STEP_ORDER.length - 1 && <span className={styles.stepSep}>›</span>}
                </span>
              ))}
            </div>

            {/* ---- Step 1: connector ---- */}
            {step === 'connector' && (
              <div className={styles.gallery}>
                <div className={styles.catList} role="tablist" aria-label="Connector category">
                  {CATEGORY_ORDER.map((c) => (
                    <button key={c} type="button" role="tab" aria-selected={category === c && !query}
                      className={`${styles.catItem} ${category === c && !query ? styles.catItemActive : ''}`}
                      onClick={() => { setCategory(c); setQuery(''); }}>
                      {CATEGORY_LABEL[c]}
                    </button>
                  ))}
                </div>
                <div className={styles.rightCol}>
                  <Input contentBefore={<Search20Regular />} placeholder="Search connectors"
                    value={query} onChange={(_, d) => setQuery(d.value)} />
                  <div className={styles.grid}>
                    {connectors.map((c) => {
                      const Icon = connectorIcon(c);
                      const selected = connector?.type === c.type;
                      return (
                        <button key={c.type} type="button"
                          className={`${styles.card} ${selected ? styles.cardSelected : ''}`}
                          onClick={() => pickConnector(c)} aria-label={`Choose ${c.name}`}>
                          <div className={styles.cardHead}>
                            <span className={styles.chip} aria-hidden><Icon style={{ width: 20, height: 20 }} /></span>
                            <Subtitle2 className={styles.cardName}>{c.name}</Subtitle2>
                          </div>
                          <Body1 className={styles.cardDesc}>{c.description}</Body1>
                          <div className={styles.cardTags}>
                            <Badge appearance="outline" size="small">{CATEGORY_LABEL[c.category]}</Badge>
                            {c.supportsSource && <Badge appearance="tint" color="brand" size="small">Source</Badge>}
                            {c.supportsSink && <Badge appearance="tint" color="success" size="small">Sink</Badge>}
                          </div>
                        </button>
                      );
                    })}
                    {connectors.length === 0 && (
                      <div className={styles.emptyGrid}>
                        <Search20Regular style={{ width: 32, height: 32, color: tokens.colorNeutralForeground4 }} aria-hidden />
                        <Body1>No connectors match &quot;{query}&quot;.</Body1>
                        <Button appearance="subtle" size="small" onClick={() => setQuery('')}>Clear search</Button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ---- Step 2: connection (linked service) ---- */}
            {step === 'connection' && connector && (
              <div className={styles.form}>
                <ConnectorHead connector={connector} />
                <LinkedServicePicker
                  provider={provider}
                  connector={connector}
                  value={linkedService}
                  onChange={setLinkedService}
                  gateError={lsGate}
                />
              </div>
            )}

            {/* ---- Step 3: dataset type + location ---- */}
            {step === 'shape' && connector && (
              <div className={styles.form}>
                <ConnectorHead connector={connector} />
                <Field label="Dataset name" required hint="Letters, digits, and underscore (1–260 chars).">
                  <Input value={datasetName} onChange={(_, d) => setDatasetName(d.value)} placeholder={`${datasetType?.type || connector.type}_ds`} />
                </Field>
                {connector.datasetTypes.length > 1 ? (
                  <Field label="Dataset type" required hint="The format / shape this connector exposes.">
                    <Dropdown
                      aria-label="Dataset type"
                      selectedOptions={[String(datasetTypeIdx)]}
                      value={datasetType?.name || ''}
                      onOptionSelect={(_, d) => { setDatasetTypeIdx(Number(d.optionValue) || 0); setLocVals({}); }}
                    >
                      {connector.datasetTypes.map((dt, i) => (
                        <Option key={dt.type} value={String(i)} text={dt.name}>{dt.name}</Option>
                      ))}
                    </Dropdown>
                  </Field>
                ) : (
                  <Field label="Dataset type">
                    <Body1>{datasetType?.name}</Body1>
                  </Field>
                )}
                <div className={styles.sectionHead}>
                  <Table20Regular className={styles.sectionIcon} />
                  <span className={styles.sectionTitle}>Location</span>
                </div>
                {datasetType && datasetType.locationFields.length > 0 ? (
                  <FieldList
                    fields={datasetType.locationFields}
                    values={locVals}
                    setValue={(k, v) => setLocVals((p) => ({ ...p, [k]: v }))}
                  />
                ) : (
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    This dataset type needs no extra location settings.
                  </Caption1>
                )}
              </div>
            )}

            {/* ---- Step 4: optional schema ---- */}
            {step === 'schema' && connector && (
              <div className={styles.form}>
                <ConnectorHead connector={connector} />
                <div className={styles.sectionHead}>
                  <DatabaseStack16Regular className={styles.sectionIcon} />
                  <span className={styles.sectionTitle}>Schema (optional)</span>
                </div>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  Define the dataset&apos;s columns to enable column mapping in Copy / Data Flow.
                  Leave empty to use schema drift / late-bound mapping.
                </Caption1>
                {columns.length === 0 ? (
                  <div className={styles.schemaEmpty}>
                    <DatabaseStack16Regular aria-hidden />
                    <span>No columns defined yet — the dataset will use schema drift.</span>
                  </div>
                ) : (
                  columns.map((col, i) => (
                    <div key={i} className={styles.schemaRow}>
                      <Field label={i === 0 ? 'Column name' : undefined}>
                        <Input value={col.name} placeholder="OrderId"
                          onChange={(_, d) => setColumns((cs) => cs.map((c, j) => j === i ? { ...c, name: d.value } : c))} />
                      </Field>
                      <Field label={i === 0 ? 'Type' : undefined}>
                        <Dropdown
                          aria-label="Column type"
                          selectedOptions={[col.type]}
                          value={SCHEMA_TYPES.find((t) => t.value === col.type)?.label || col.type}
                          onOptionSelect={(_, d) => setColumns((cs) => cs.map((c, j) => j === i ? { ...c, type: d.optionValue || 'String' } : c))}
                        >
                          {SCHEMA_TYPES.map((t) => <Option key={t.value} value={t.value}>{t.label}</Option>)}
                        </Dropdown>
                      </Field>
                      <Tooltip content="Remove column" relationship="label">
                        <Button appearance="subtle" icon={<Delete16Regular />} aria-label="Remove column"
                          onClick={() => setColumns((cs) => cs.filter((_, j) => j !== i))} />
                      </Tooltip>
                    </div>
                  ))
                )}
                <div>
                  <Button appearance="secondary" icon={<Add16Regular />}
                    onClick={() => setColumns((cs) => [...cs, { name: '', type: 'String' }])}>
                    Add column
                  </Button>
                </div>
              </div>
            )}

            {err && (
              <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}>
                <MessageBarBody>
                  <MessageBarTitle>Could not create dataset</MessageBarTitle>
                  {err}
                </MessageBarBody>
              </MessageBar>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => { reset(); onClose(); }}>Cancel</Button>
            {step !== 'connector' && (
              <Button appearance="subtle" icon={<ArrowLeft20Regular />}
                onClick={() => setStep(STEP_ORDER[Math.max(0, stepIdx - 1)])}>
                Back
              </Button>
            )}
            {step === 'connection' && (
              <Button appearance="primary" disabled={!linkedService} onClick={() => setStep('shape')}>Next</Button>
            )}
            {step === 'shape' && (
              <Button appearance="primary"
                disabled={!datasetName.trim() || !NAME_RE.test(datasetName.trim()) || locMissingRequired}
                onClick={() => setStep('schema')}>
                Next
              </Button>
            )}
            {step === 'schema' && (
              <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <Database20Regular />}
                disabled={!canFinish} onClick={finish}>
                {busy ? 'Creating…' : 'Create dataset'}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** Small connector summary header reused across the form steps. */
function ConnectorHead({ connector }: { connector: ConnectorDef }) {
  const styles = useStyles();
  const Icon = connectorIcon(connector);
  return (
    <div className={styles.formHead}>
      <span className={styles.chip} aria-hidden><Icon style={{ width: 20, height: 20 }} /></span>
      <div style={{ minWidth: 0 }}>
        <Text weight="semibold">{connector.name}</Text>
        <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground2 }}>{connector.description}</Caption1>
      </div>
    </div>
  );
}

/** ADF DatasetLocation `type` discriminator for a file-store connector. */
function locationTypeFor(connectorType: string): string {
  switch (connectorType) {
    case 'AzureBlobFS': return 'AzureBlobFSLocation';
    case 'AzureBlobStorage': return 'AzureBlobStorageLocation';
    case 'AzureFileStorage': return 'AzureFileStorageLocation';
    case 'AmazonS3': return 'AmazonS3Location';
    case 'FileServer': return 'FileServerLocation';
    case 'Ftp': return 'FtpServerLocation';
    case 'Sftp': return 'SftpLocation';
    case 'HttpServer': return 'HttpServerLocation';
    default: return 'AzureBlobFSLocation';
  }
}

// ===========================================================================
// DatasetPicker — select an existing dataset + "＋ New" to open the wizard.
// Both select-existing AND create-new, per the operator.
// ===========================================================================

export interface DatasetWizardPickerProps {
  label: string;
  /** Currently-bound dataset name ('' when none). */
  value: string;
  onChange: (datasetName: string, dataset?: { name: string; type?: string; linkedService?: string }) => void;
  provider?: DatasetProvider;
  required?: boolean;
  hint?: string;
}

/**
 * DatasetPicker — the standalone select-existing-or-create picker. It owns its
 * own dataset fetch (real GET) and its own DatasetWizard, so a caller can drop a
 * single <DatasetPicker/> anywhere a dataset reference is needed.
 *
 * NOTE: the existing `dataset-picker.tsx` exports a `<DatasetPicker/>` that takes
 * a pre-loaded `datasets` list (used inside the Copy tabs where the list is
 * already fetched once). This export is named `DatasetPicker` too but lives in a
 * different module; callers import whichever fits — pre-loaded list vs.
 * self-fetching + create-new. To avoid a name clash at a shared import site, this
 * one is also re-exported as `DatasetSelectOrCreate`.
 */
export function DatasetPicker({
  label, value, onChange, provider = 'adf', required, hint,
}: DatasetWizardPickerProps) {
  const styles = useStyles();
  const routes = routesFor(provider);
  const [datasets, setDatasets] = useState<{ name: string; type?: string; linkedService?: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [gateError, setGateError] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setGateError(null);
    try {
      const r = await clientFetch(routes.datasets, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 && j?.code === 'not_configured') { setGateError(String(j.error || 'Not configured.')); return; }
      if (!r.ok || !j?.ok) { setGateError(String(j?.error || `HTTP ${r.status}`)); return; }
      const list = Array.isArray(j.datasets)
        ? j.datasets.map((d: any) => ({
            name: d.name,
            type: d.properties?.type ?? d.type,
            linkedService: d.properties?.linkedServiceName?.referenceName,
          }))
        : [];
      setDatasets(list);
    } catch (e: any) {
      setGateError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [routes.datasets]);

  useEffect(() => { load(); }, [load]);

  const selected = datasets.find((d) => d.name === value);
  const hasData = datasets.length > 0;

  return (
    <Field label={label} required={required} hint={hint}>
      {gateError && (
        <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalXS }}>
          <MessageBarBody>{gateError}</MessageBarBody>
        </MessageBar>
      )}
      <div className={styles.pickerRow}>
        <div className={styles.pickerGrow}>
          <Dropdown
            aria-label={label}
            placeholder={loading ? 'Loading datasets…' : hasData ? 'Select a dataset' : 'No datasets — create one'}
            value={value || ''}
            selectedOptions={value ? [value] : []}
            disabled={!!gateError || loading}
            onOptionSelect={(_, d) => {
              const name = d.optionValue || '';
              onChange(name, datasets.find((x) => x.name === name));
            }}
          >
            <Option value="" text="(none)">(none)</Option>
            {datasets.map((d) => (
              <Option key={d.name} value={d.name} text={d.name}>{d.name}</Option>
            ))}
          </Dropdown>
        </div>
        <Tooltip content="Refresh datasets" relationship="label">
          <Button appearance="subtle" aria-label="Refresh datasets"
            icon={loading ? <Spinner size="tiny" /> : <ArrowClockwise16Regular />}
            disabled={!!gateError || loading} onClick={load} />
        </Tooltip>
        <Button appearance="secondary" icon={<Add20Regular />} disabled={!!gateError}
          onClick={() => setWizardOpen(true)}>
          New
        </Button>
      </div>
      {selected && (
        <div className={styles.pickerMeta}>
          {selected.type && <Badge appearance="tint" color="brand" size="small">{selected.type}</Badge>}
          {selected.linkedService && (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>→ {selected.linkedService}</Caption1>
          )}
        </div>
      )}

      <DatasetWizard
        open={wizardOpen}
        provider={provider}
        onClose={() => setWizardOpen(false)}
        onCreated={async (name) => {
          await load();
          onChange(name, { name });
        }}
      />
    </Field>
  );
}

/** Alias to disambiguate from the pre-loaded-list `DatasetPicker` in
 *  `dataset-picker.tsx` at any site that imports both. */
export { DatasetPicker as DatasetSelectOrCreate };

/** Re-export the connector type system for callers wiring the wizard. */
export { CONNECTORS, connectorByType };
export type { ConnectorDef };

/** Number of connectors the wizard's gallery exposes (for tests / parity docs). */
export const DATASET_WIZARD_CONNECTOR_COUNT = CONNECTORS.length;
