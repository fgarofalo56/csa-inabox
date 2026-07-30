'use client';

/**
 * LU-5 — Loom Unity GOVERNANCE pane (/catalog/unity → Governance).
 *
 * The tags / governed tags / certification / custom-attributes surface for a
 * Unity Catalog securable, on BOTH backends. Everything here is real:
 *   read/write  → /api/catalog/unity/governance      (Cosmos overlay, keyed on `uc:<fqn>`)
 *   vocabulary  → /api/catalog/unity/governed-tags   (tenant governed-tag list)
 *   Purview     → the same POST with syncPurview:true (classic Atlas v2 Data Map)
 * and the securable picker walks the SAME catalogs/schemas/tables routes the
 * Explore pane uses, so it works against the OSS Unity Catalog server in Azure
 * Government with no Databricks SQL warehouse (no-fabric-dependency).
 *
 * A governed tag renders as a VALUE DROPDOWN (its controlled vocabulary), never
 * a free text box (loom_no_freeform_config); the BFF re-validates, so a crafted
 * request cannot bypass the vocabulary either.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import { Section } from '@/lib/components/ui/section';
import { EmptyState } from '@/lib/components/empty-state';
import { HonestGate } from '@/lib/components/shared/honest-gate';
import {
  Badge, Body1, Button, Caption1, Checkbox, Dropdown, Field, Input, MessageBar,
  MessageBarBody, MessageBarTitle, Option, Spinner, Subtitle2, Textarea,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add24Regular, ArrowSync24Regular, Dismiss16Regular, ShieldCheckmark24Regular,
  Tag16Regular,
} from '@fluentui/react-icons';
import type { AttributeDef, AttributeGroup } from '@/lib/types/attribute-groups';
import type {
  EndorsementRung, UcGovernanceOverlay, UcGovernedTagDef,
} from '@/lib/governance/uc-overlay/model';

const RUNGS: { value: EndorsementRung; label: string; hint: string }[] = [
  { value: 'none', label: 'Not endorsed', hint: 'No endorsement signal at the point of discovery.' },
  { value: 'promoted', label: 'Promoted', hint: 'A lightweight "this is ready to share" signal from the owner.' },
  { value: 'certified', label: 'Certified', hint: 'Authoritative — the certifier identity is recorded on the securable.' },
];

/**
 * True when a failed sync is an INFRA gate (Purview not deployed / not wired)
 * rather than an ordinary "nothing to do here" outcome.
 *
 * G2 requires an infra gate to render through the shared {@link HonestGate} —
 * registry-driven, with an inline **Fix it** wizard that writes
 * `LOOM_PURVIEW_ACCOUNT` through the same env-apply path as /admin/env-config.
 * The other reasons the sync can return (no Atlas entity registered yet, a
 * column overlay, nothing to sync) are NOT configuration problems and carry
 * their own next step, so they stay an informational MessageBar.
 */
function isPurviewInfraGate(reason?: string): boolean {
  return !!reason && reason.includes('LOOM_PURVIEW_ACCOUNT');
}

const useStyles = makeStyles({
  pickerRow: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: tokens.spacingHorizontalM, alignItems: 'end', marginBottom: tokens.spacingVerticalM,
  },
  chips: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  chip: {
    display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS,
    paddingTop: tokens.spacingVerticalXXS, paddingBottom: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalXS, paddingRight: tokens.spacingHorizontalXS,
    borderRadius: tokens.borderRadiusMedium, minWidth: 0, maxWidth: '100%',
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  chipGoverned: {
    backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground2,
    border: `1px solid ${tokens.colorBrandStroke2}`,
  },
  chipText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  addRow: {
    display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) auto',
    gap: tokens.spacingHorizontalM, alignItems: 'end', marginTop: tokens.spacingVerticalS,
  },
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'end', flexWrap: 'wrap' },
  muted: { color: tokens.colorNeutralForeground3 },
  attrGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
    gap: tokens.spacingHorizontalM, marginTop: tokens.spacingVerticalS,
  },
  sectionGap: { marginTop: tokens.spacingVerticalL },
});

interface GovernancePayload {
  ok: boolean;
  overlay: UcGovernanceOverlay;
  columnOverlays: UcGovernanceOverlay[];
  vocabulary: UcGovernedTagDef[];
  attributeGroups: AttributeGroup[];
  error?: string;
}

interface PurviewResult {
  synced: boolean; reason?: string; guid?: string;
  classifications: string[]; businessMetadataKeys: string[];
}

/** The CUSTOM (ungoverned) key sentinel in the tag-key dropdown. */
const CUSTOM_KEY = '__custom__';

/**
 * Tenant governed-tag vocabulary editor. POST is tenant-admin-only; a
 * non-admin's 403 is surfaced verbatim instead of hiding the surface, so it is
 * obvious WHO can change the vocabulary (no-vaporware honest state).
 */
function VocabularyEditor({ vocabulary, onSaved }: {
  vocabulary: UcGovernedTagDef[]; onSaved: () => void;
}) {
  const s = useStyles();
  const [key, setKey] = useState('');
  const [values, setValues] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async (next: UcGovernedTagDef[]) => {
    setBusy(true); setErr(null);
    try {
      const r = await clientFetch('/api/catalog/unity/governed-tags', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tags: next }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setKey(''); setValues('');
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const parsedValues = values.split(',').map((v) => v.trim()).filter(Boolean);

  return (
    <div className={s.stack}>
      {vocabulary.length === 0 ? (
        <Caption1 className={s.muted}>
          No governed tags yet. A governed tag pins a key to a controlled set of values — an
          assignment outside that set is rejected by the API, not just by this form.
        </Caption1>
      ) : (
        <div className={s.chips}>
          {vocabulary.map((d) => (
            <span key={d.key} className={`${s.chip} ${s.chipGoverned}`}>
              <Tag16Regular />
              <Caption1 className={s.chipText}>{d.key}: {d.allowedValues.join(' | ')}</Caption1>
              <Button
                size="small" appearance="transparent" icon={<Dismiss16Regular />} disabled={busy}
                aria-label={`Delete governed tag ${d.key}`}
                onClick={() => void save(vocabulary.filter((x) => x.key !== d.key))}
              />
            </span>
          ))}
        </div>
      )}
      <div className={s.addRow}>
        <Field label="Governed tag key">
          <Input value={key} onChange={(_, d) => setKey(d.value)} placeholder="data-sensitivity" />
        </Field>
        <Field label="Allowed values" hint="Comma-separated. Only these values can be assigned.">
          <Input value={values} onChange={(_, d) => setValues(d.value)} placeholder="public, internal, restricted" />
        </Field>
        <Button
          appearance="primary" icon={<Add24Regular />}
          disabled={busy || !key.trim() || parsedValues.length === 0}
          onClick={() => void save([
            ...vocabulary.filter((x) => x.key.toLowerCase() !== key.trim().toLowerCase()),
            { key: key.trim(), allowedValues: parsedValues },
          ])}
        >
          Add governed tag
        </Button>
      </div>
      {err && (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Vocabulary not saved</MessageBarTitle>
            {err}
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}

function TagChips({ overlay, onRemove, busy }: {
  overlay: UcGovernanceOverlay | null; onRemove: (key: string) => void; busy: boolean;
}) {
  const s = useStyles();
  const tags = overlay?.tags || [];
  if (!tags.length) {
    return (
      <EmptyState
        icon={<Tag16Regular />}
        title="No tags on this securable yet"
        body="Add a governed tag (its value comes from the tenant vocabulary) or a free-form key=value below. Tags apply on BOTH Unity Catalog backends and are the input LU-6 compiles into access policy."
      />
    );
  }
  return (
    <div className={s.chips}>
      {tags.map((t) => (
        <span key={t.key} className={t.governed ? `${s.chip} ${s.chipGoverned}` : s.chip}>
          <Tag16Regular />
          <Caption1 className={s.chipText}>{t.key}{t.value ? `=${t.value}` : ''}</Caption1>
          {t.governed && <Badge appearance="tint" color="brand" size="extra-small">governed</Badge>}
          <Button
            size="small" appearance="transparent" icon={<Dismiss16Regular />}
            aria-label={`Remove tag ${t.key}`} disabled={busy} onClick={() => onRemove(t.key)}
          />
        </span>
      ))}
    </div>
  );
}

/** One attribute-group field, rendered by its Purview-vocabulary fieldType. */
function AttributeField({ def, value, onChange, disabled }: {
  def: AttributeDef;
  value: unknown;
  onChange: (v: string | number | boolean | string[] | null) => void;
  disabled: boolean;
}) {
  const label = def.required ? `${def.name} *` : def.name;
  switch (def.fieldType) {
    case 'Boolean':
      return (
        <Checkbox
          label={label} disabled={disabled} checked={value === true}
          onChange={(_, d) => onChange(d.checked === true)}
        />
      );
    case 'Single choice':
      return (
        <Field label={label} hint={def.description}>
          <Dropdown
            disabled={disabled} placeholder="Select"
            value={typeof value === 'string' ? value : ''}
            selectedOptions={typeof value === 'string' && value ? [value] : []}
            onOptionSelect={(_, d) => onChange(d.optionValue ?? null)}
          >
            {(def.choices || []).map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
          </Dropdown>
        </Field>
      );
    case 'Multiple choice':
      return (
        <Field label={label} hint={def.description}>
          <Dropdown
            multiselect disabled={disabled} placeholder="Select"
            value={Array.isArray(value) ? (value as string[]).join(', ') : ''}
            selectedOptions={Array.isArray(value) ? (value as string[]) : []}
            onOptionSelect={(_, d) => onChange(d.selectedOptions)}
          >
            {(def.choices || []).map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
          </Dropdown>
        </Field>
      );
    case 'Rich text':
      return (
        <Field label={label} hint={def.description}>
          <Textarea
            disabled={disabled} value={typeof value === 'string' ? value : ''}
            onChange={(_, d) => onChange(d.value)} aria-label={def.name}
          />
        </Field>
      );
    case 'Integer':
    case 'Double':
      return (
        <Field label={label} hint={def.description}>
          <Input
            type="number" disabled={disabled}
            value={value === undefined || value === null ? '' : String(value)}
            onChange={(_, d) => onChange(d.value === '' ? null : Number(d.value))}
          />
        </Field>
      );
    case 'Date':
      return (
        <Field label={label} hint={def.description}>
          <Input
            type="date" disabled={disabled}
            value={typeof value === 'string' ? value : ''}
            onChange={(_, d) => onChange(d.value || null)}
          />
        </Field>
      );
    default:
      return (
        <Field label={label} hint={def.description}>
          <Input
            disabled={disabled} value={typeof value === 'string' ? value : ''}
            onChange={(_, d) => onChange(d.value)}
          />
        </Field>
      );
  }
}

export function UcGovernancePane({ oss }: { oss: boolean }) {
  const s = useStyles();

  // Securable picker (same routes as the Explore pane).
  const [catalogs, setCatalogs] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [catalog, setCatalog] = useState('');
  const [schema, setSchema] = useState('');
  const [table, setTable] = useState('');
  const [pickerError, setPickerError] = useState<string | null>(null);

  const [payload, setPayload] = useState<GovernancePayload | null>(null);
  const [vocabulary, setVocabulary] = useState<UcGovernedTagDef[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [purview, setPurview] = useState<PurviewResult | null>(null);

  // Tag composer.
  const [tagKey, setTagKey] = useState('');
  const [customKey, setCustomKey] = useState('');
  const [tagValue, setTagValue] = useState('');
  // Certification composer.
  const [note, setNote] = useState('');
  // Attribute draft (id → value), seeded from the loaded overlay.
  const [attrDraft, setAttrDraft] = useState<Record<string, unknown>>({});

  const fullName = useMemo(
    () => [catalog, schema, table].filter(Boolean).join('.'),
    [catalog, schema, table],
  );
  const securableType = table ? 'table' : schema ? 'schema' : 'catalog';

  const loadJson = useCallback(async (url: string): Promise<any | null> => {
    const r = await clientFetch(url);
    const j = await r.json();
    if (!j.ok) { setPickerError(j.error || `HTTP ${r.status}`); return null; }
    setPickerError(null);
    return j;
  }, []);

  useEffect(() => {
    void (async () => {
      const j = await loadJson('/api/databricks/unity-catalog/catalogs');
      setCatalogs((j?.catalogs || []).map((c: { name: string }) => c.name).filter(Boolean));
    })();
  }, [loadJson]);

  const reloadVocabulary = useCallback(async () => {
    try {
      const r = await clientFetch('/api/catalog/unity/governed-tags');
      const j = await r.json();
      if (j.ok) setVocabulary(j.tags || []);
    } catch { /* the pane still works with an empty vocabulary (free tags only) */ }
  }, []);

  useEffect(() => { void reloadVocabulary(); }, [reloadVocabulary]);

  useEffect(() => {
    setSchema(''); setTable(''); setSchemas([]); setTables([]);
    if (!catalog) return;
    void (async () => {
      const j = await loadJson(`/api/databricks/unity-catalog/schemas?catalog=${encodeURIComponent(catalog)}`);
      setSchemas((j?.schemas || []).map((x: { name: string }) => x.name).filter(Boolean));
    })();
  }, [catalog, loadJson]);

  useEffect(() => {
    setTable(''); setTables([]);
    if (!catalog || !schema) return;
    void (async () => {
      const j = await loadJson(
        `/api/databricks/unity-catalog/tables?catalog=${encodeURIComponent(catalog)}&schema=${encodeURIComponent(schema)}`,
      );
      setTables((j?.tables || []).map((x: { name: string }) => x.name).filter(Boolean));
    })();
  }, [catalog, schema, loadJson]);

  const reload = useCallback(async () => {
    if (!fullName) { setPayload(null); return; }
    setLoading(true); setError(null);
    try {
      const r = await clientFetch(
        `/api/catalog/unity/governance?fullName=${encodeURIComponent(fullName)}&securableType=${securableType}`,
      );
      const j = (await r.json()) as GovernancePayload;
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); setPayload(null); return; }
      setPayload(j);
      setAttrDraft({ ...(j.overlay?.attributes || {}) });
      setNote(j.overlay?.certification?.note || '');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [fullName, securableType]);

  useEffect(() => { void reload(); }, [reload]);

  const mutate = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    if (!fullName) return false;
    setBusy(true); setError(null);
    try {
      const r = await clientFetch('/api/catalog/unity/governance', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fullName, securableType, ...body }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return false; }
      if (j.purview) setPurview(j.purview as PurviewResult);
      await reload();
      return true;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, [fullName, securableType, reload]);

  const governedDef = useMemo(
    () => vocabulary.find((d) => d.key.toLowerCase() === tagKey.toLowerCase()),
    [vocabulary, tagKey],
  );
  const effectiveKey = tagKey === CUSTOM_KEY ? customKey.trim() : tagKey;
  const canAddTag = !!effectiveKey && (!governedDef || !!tagValue);

  const addTag = async () => {
    if (!canAddTag) return;
    const ok = await mutate({ setTags: [{ key: effectiveKey, value: tagValue }] });
    if (ok) { setTagKey(''); setCustomKey(''); setTagValue(''); }
  };

  const attributeGroups = payload?.attributeGroups || [];
  const dirtyAttributes = useMemo(() => {
    const saved = payload?.overlay?.attributes || {};
    const out: Record<string, unknown> = {};
    const ids = new Set([...Object.keys(saved), ...Object.keys(attrDraft)]);
    for (const id of ids) {
      const a = attrDraft[id];
      const b = (saved as Record<string, unknown>)[id];
      if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) out[id] = a ?? null;
    }
    return out;
  }, [payload, attrDraft]);

  const rung = payload?.overlay?.certification?.rung || 'none';

  return (
    <>
      <Section title="Securable">
        <Body1 className={s.muted}>
          Governance facts are stored by Loom against the securable identity{' '}
          <code>uc:&lt;catalog.schema.table&gt;</code> — the same identity the lineage graph and the
          Purview join use — so they apply on {oss ? 'the OSS Unity Catalog server' : 'Databricks Unity Catalog'} and
          survive a metastore migration.
        </Body1>
        <div className={s.pickerRow}>
          <Field label="Catalog">
            <Dropdown
              placeholder="Pick a catalog" value={catalog} selectedOptions={catalog ? [catalog] : []}
              onOptionSelect={(_, d) => setCatalog(d.optionValue || '')}
            >
              {catalogs.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Schema">
            <Dropdown
              placeholder="(catalog-level)" disabled={!catalog} value={schema}
              selectedOptions={schema ? [schema] : []}
              onOptionSelect={(_, d) => setSchema(d.optionValue || '')}
            >
              {schemas.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Table">
            <Dropdown
              placeholder="(schema-level)" disabled={!schema} value={table}
              selectedOptions={table ? [table] : []}
              onOptionSelect={(_, d) => setTable(d.optionValue || '')}
            >
              {tables.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
            </Dropdown>
          </Field>
        </div>
        {pickerError && (
          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>Could not list the catalog</MessageBarTitle>
              {pickerError}
            </MessageBarBody>
          </MessageBar>
        )}
      </Section>

      <Section title="Governed tags (tenant vocabulary)" className={s.sectionGap}>
        <VocabularyEditor vocabulary={vocabulary} onSaved={() => { void reloadVocabulary(); void reload(); }} />
      </Section>

      {!fullName && (
        <EmptyState
          icon={<ShieldCheckmark24Regular />}
          title="Pick a securable to govern"
          body="Choose a catalog (and optionally a schema and table) above. Tags, governed tags, certification, and custom attributes all attach to whichever level you select."
          primaryAction={{ label: 'Browse the catalog', href: '/catalog' }}
          secondaryAction={{ label: 'Define custom attributes', href: '/admin/attribute-groups' }}
        />
      )}

      {fullName && (
        <>
          {loading && <Spinner size="tiny" label={`Reading governance for ${fullName}…`} labelPosition="after" />}
          {error && (
            <MessageBar intent="error" layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>Governance operation failed</MessageBarTitle>
                {error}
              </MessageBarBody>
            </MessageBar>
          )}

          <Section title={`Tags — ${fullName}`} className={s.sectionGap}>
            <div className={s.stack}>
              <TagChips overlay={payload?.overlay || null} onRemove={(key) => void mutate({ removeTagKeys: [key] })} busy={busy} />
              <div className={s.addRow}>
                <Field label="Tag key" hint={governedDef?.description || (vocabulary.length ? 'Governed keys enforce their allowed values.' : 'No governed tags defined yet — any key is free-form.')}>
                  <Dropdown
                    placeholder="Pick or add a key" value={tagKey === CUSTOM_KEY ? 'Custom key…' : tagKey}
                    selectedOptions={tagKey ? [tagKey] : []}
                    onOptionSelect={(_, d) => { setTagKey(d.optionValue || ''); setTagValue(''); }}
                  >
                    {vocabulary.map((d) => (
                      <Option key={d.key} value={d.key} text={d.key}>{d.key}</Option>
                    ))}
                    <Option key={CUSTOM_KEY} value={CUSTOM_KEY} text="Custom key…">Custom key…</Option>
                  </Dropdown>
                </Field>
                {tagKey === CUSTOM_KEY ? (
                  <Field label="Custom key">
                    <Input value={customKey} onChange={(_, d) => setCustomKey(d.value)} placeholder="cost-center" />
                  </Field>
                ) : governedDef ? (
                  <Field label="Value (governed)">
                    <Dropdown
                      placeholder="Pick an allowed value" value={tagValue}
                      selectedOptions={tagValue ? [tagValue] : []}
                      onOptionSelect={(_, d) => setTagValue(d.optionValue || '')}
                    >
                      {governedDef.allowedValues.map((v) => <Option key={v} value={v} text={v}>{v}</Option>)}
                    </Dropdown>
                  </Field>
                ) : (
                  <Field label="Value">
                    <Input value={tagValue} onChange={(_, d) => setTagValue(d.value)} placeholder="finance" />
                  </Field>
                )}
                <Button appearance="primary" icon={<Add24Regular />} disabled={busy || !canAddTag} onClick={() => void addTag()}>
                  Apply tag
                </Button>
              </div>
            </div>
          </Section>

          <Section title="Certification" className={s.sectionGap}>
            <div className={s.stack}>
              <Body1 className={s.muted}>
                The same endorsement ladder Loom uses for data products, so a certified table and a
                certified data product land in the same catalog facet.
              </Body1>
              <div className={s.row}>
                <Field label="Status" hint={RUNGS.find((r) => r.value === rung)?.hint}>
                  <Dropdown
                    value={RUNGS.find((r) => r.value === rung)?.label || 'Not endorsed'}
                    selectedOptions={[rung]}
                    disabled={busy}
                    onOptionSelect={(_, d) => void mutate({ certification: { rung: (d.optionValue || 'none') as EndorsementRung, note } })}
                  >
                    {RUNGS.map((r) => <Option key={r.value} value={r.value} text={r.label}>{r.label}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Note">
                  <Input value={note} onChange={(_, d) => setNote(d.value)} placeholder="Reviewed by the data office" />
                </Field>
                <Button
                  appearance="secondary" disabled={busy || !payload}
                  onClick={() => void mutate({ certification: { rung, note } })}
                >
                  Save note
                </Button>
              </div>
              {payload?.overlay?.certification?.by && (
                <Caption1 className={s.muted}>
                  {payload.overlay.certification.rung} by {payload.overlay.certification.by}
                  {payload.overlay.certification.at ? ` on ${new Date(payload.overlay.certification.at).toLocaleString()}` : ''}
                </Caption1>
              )}
            </div>
          </Section>

          <Section title="Custom attributes" className={s.sectionGap}>
            {attributeGroups.length === 0 ? (
              <EmptyState
                icon={<ShieldCheckmark24Regular />}
                title="No attribute groups defined for this tenant"
                body="Define them once under Admin → Catalog & domains → Custom attributes; the same schema then applies to data products and to catalog securables."
                primaryAction={{ label: 'Define custom attributes', href: '/admin/attribute-groups' }}
              />
            ) : (
              <div className={s.stack}>
                {attributeGroups.map((g) => (
                  <div key={g.id}>
                    <Subtitle2>{g.name}</Subtitle2>
                    <div className={s.attrGrid}>
                      {g.attributes.map((a) => (
                        <AttributeField
                          key={a.id} def={a} disabled={busy} value={attrDraft[a.id]}
                          onChange={(v) => setAttrDraft((prev) => ({ ...prev, [a.id]: v }))}
                        />
                      ))}
                    </div>
                  </div>
                ))}
                <div>
                  <Button
                    appearance="primary"
                    disabled={busy || Object.keys(dirtyAttributes).length === 0}
                    onClick={() => void mutate({ attributes: dirtyAttributes })}
                  >
                    Save attributes
                  </Button>
                </div>
              </div>
            )}
          </Section>

          <Section
            title="Microsoft Purview"
            className={s.sectionGap}
            actions={(
              <Button
                appearance="secondary" icon={<ArrowSync24Regular />} disabled={busy || !payload}
                onClick={() => void mutate({ syncPurview: true })}
              >
                Sync to Purview
              </Button>
            )}
          >
            <div className={s.stack}>
              <Body1 className={s.muted}>
                Governed tags are pushed as Atlas classifications and free tags + certification as
                <code> LoomCustomTags_&lt;tenant&gt;</code> business metadata on the registered Data Map
                entity — tenant-namespaced, because an Atlas typedef is account-global while a Loom
                tenant is not. The overlay itself never depends on Purview.
              </Body1>
              {payload?.overlay?.purview?.syncedAt && (
                <Caption1 className={s.muted}>
                  Last synced {new Date(payload.overlay.purview.syncedAt).toLocaleString()}
                  {payload.overlay.purview.guid ? ` · asset ${payload.overlay.purview.guid}` : ''}
                </Caption1>
              )}
              {/* G2 — an infra gate gets the SHARED HonestGate (inline "Fix it"
                  wizard, registry-driven), never a bespoke warning bar. Reasons
                  that are NOT infra gates (no Atlas entity yet, column overlay,
                  nothing to sync) stay an informational bar with their own
                  actionable next step. */}
              {purview && !purview.synced && isPurviewInfraGate(purview.reason) && (
                <HonestGate
                  gateId="purview"
                  surface="Unity governance → Purview sync"
                  missing={['LOOM_PURVIEW_ACCOUNT']}
                  detail={purview.reason}
                  onResolved={() => void reload()}
                />
              )}
              {purview && !purview.synced && !isPurviewInfraGate(purview.reason) && (
                <MessageBar intent="warning" layout="multiline">
                  <MessageBarBody>
                    <MessageBarTitle>Not synced</MessageBarTitle>
                    {purview.reason}
                  </MessageBarBody>
                </MessageBar>
              )}
              {purview?.synced && (
                <MessageBar intent="success" layout="multiline">
                  <MessageBarBody>
                    <MessageBarTitle>Synced to the Purview Data Map</MessageBarTitle>
                    {purview.classifications.length ? `Classifications: ${purview.classifications.join(', ')}. ` : ''}
                    {purview.businessMetadataKeys.length ? `Business metadata: ${purview.businessMetadataKeys.join(', ')}.` : ''}
                  </MessageBarBody>
                </MessageBar>
              )}
            </div>
          </Section>
        </>
      )}
    </>
  );
}
