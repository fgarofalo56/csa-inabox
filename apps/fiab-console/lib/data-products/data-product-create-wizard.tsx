'use client';

/**
 * Data Product Creation Wizard (single) — Microsoft Purview Unified Catalog
 * "New data product" parity (F1) with the F18 governance-domain picker.
 *
 * Three pages, one-for-one with the real portal wizard
 * (https://learn.microsoft.com/purview/unified-catalog-data-products-create-manage):
 *
 *   1. Basic details   — Name, Description (10,000-char counter + hard block),
 *                        Type (14-value CatalogModelDataProductTypeEnum),
 *                        Audience (8-value AudienceEnum, multi-select),
 *                        Owners (search-as-you-type via real Microsoft Graph).
 *   2. Business details — Governance domain (live from /api/governance-domains:
 *                        Purview UC when configured, else Loom-local Cosmos),
 *                        Use case, Mark as Endorsed.
 *   3. Custom attributes — dynamic form rendered from the tenant's attribute-group
 *                        schema (/api/attribute-groups), honoring required fields.
 *
 * Create POSTs to /api/data-products (real Cosmos draft + best-effort Purview
 * registration) and navigates to /data-products/<id>. No mocks, no dead
 * controls — every field maps to a real backend value (no-vaporware.md). Works
 * with LOOM_DEFAULT_FABRIC_WORKSPACE UNSET and Purview unconfigured
 * (no-fabric-dependency.md): the draft still lands in Loom.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge, Body1, Button, Caption1, Checkbox, Divider, Dropdown, Field, Input, Option,
  Persona, Spinner, Subtitle2, Text, Textarea,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowLeft20Regular, ArrowRight20Regular, CheckmarkCircle20Filled, Dismiss16Regular,
  PersonAdd20Regular, Save20Regular,
} from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import {
  DATA_PRODUCT_TYPES, DATA_PRODUCT_AUDIENCES, DATA_PRODUCT_DESCRIPTION_MAX,
} from '@/lib/catalog/data-product-enums';

const useStyles = makeStyles({
  steps: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 },
  stepChip: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 16,
    border: `1px solid ${tokens.colorNeutralStroke2}`, cursor: 'pointer',
  },
  stepActive: { background: tokens.colorBrandBackground2, borderColor: tokens.colorBrandStroke1 },
  stepDone: { borderColor: tokens.colorPaletteGreenBorder2 },
  stepNum: {
    width: 22, height: 22, borderRadius: '50%', display: 'inline-flex', alignItems: 'center',
    justifyContent: 'center', fontSize: 12, fontWeight: 600,
    background: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
  },
  stepNumActive: { background: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand },
  page: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760 },
  counter: { alignSelf: 'flex-end' },
  ownerRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    padding: '6px 8px', borderRadius: 6, border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  ownerResults: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, maxHeight: 220, overflow: 'auto',
  },
  ownerResult: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    padding: '6px 10px', cursor: 'pointer',
    ':hover': { background: tokens.colorNeutralBackground1Hover },
  },
  chips: { display: 'flex', flexDirection: 'column', gap: 6 },
  footer: { display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 12, maxWidth: 760 },
  attrGroup: { display: 'flex', flexDirection: 'column', gap: 12, padding: 12, borderRadius: 8, border: `1px solid ${tokens.colorNeutralStroke2}` },
});

type Step = 1 | 2 | 3;

interface Owner { id: string; upn: string; displayName: string }
interface DomainOption { id: string; name: string; description?: string }
interface PrincipalResult { id: string; upn?: string; displayName?: string; mail?: string }

type AttributeFieldType =
  | 'Text' | 'Single choice' | 'Multiple choice' | 'Date' | 'Boolean' | 'Integer' | 'Double' | 'Rich text';
interface AttributeDef { id: string; name: string; description?: string; fieldType: AttributeFieldType; required?: boolean; choices?: string[] }
interface AttributeGroup { id: string; name: string; description?: string; attributes: AttributeDef[] }
interface WorkspaceLite { id: string; name: string }

export function DataProductCreateWizard() {
  const s = useStyles();
  const router = useRouter();

  const [step, setStep] = useState<Step>(1);

  // Page 1 — Basic
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState('');
  const [audience, setAudience] = useState<string[]>([]);
  const [owners, setOwners] = useState<Owner[]>([]);

  // Page 2 — Business
  const [governanceDomainId, setGovernanceDomainId] = useState('');
  const [useCase, setUseCase] = useState('');
  const [endorsed, setEndorsed] = useState(false);

  // Page 3 — Custom attributes
  const [customAttributes, setCustomAttributes] = useState<Record<string, string | string[] | boolean>>({});

  // Workspace (Loom storage partition for the draft).
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [wsLoaded, setWsLoaded] = useState(false);

  // Domains
  const [domains, setDomains] = useState<DomainOption[]>([]);
  const [domainSource, setDomainSource] = useState<'purview-uc' | 'cosmos' | ''>('');
  const [domainHint, setDomainHint] = useState<string | undefined>();
  const [domainsLoading, setDomainsLoading] = useState(true);

  // Attribute groups
  const [groups, setGroups] = useState<AttributeGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsNote, setGroupsNote] = useState<string | undefined>();

  // Owner search
  const [ownerQuery, setOwnerQuery] = useState('');
  const [ownerResults, setOwnerResults] = useState<PrincipalResult[]>([]);
  const [ownerSearching, setOwnerSearching] = useState(false);
  const [ownerError, setOwnerError] = useState<string | undefined>();
  const ownerDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>();

  // ── Load workspaces + domains on mount ───────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/loom/workspaces');
        const j = await r.json();
        const ws: WorkspaceLite[] = j.ok ? (j.workspaces || []) : [];
        setWorkspaces(ws);
        if (ws.length) setWorkspaceId(ws[0].id);
      } catch { /* surfaced at submit */ }
      finally { setWsLoaded(true); }
    })();
    (async () => {
      setDomainsLoading(true);
      try {
        const r = await fetch('/api/governance-domains');
        const j = await r.json();
        if (j.ok) {
          setDomains(j.domains || []);
          setDomainSource(j.source || '');
          setDomainHint(j.purviewHint);
        } else {
          setDomainHint(j.error || 'Failed to load governance domains.');
        }
      } catch (e: any) {
        setDomainHint(e?.message || String(e));
      } finally { setDomainsLoading(false); }
    })();
  }, []);

  // ── Load attribute groups whenever the domain changes ────────────────────
  useEffect(() => {
    (async () => {
      setGroupsLoading(true);
      setGroupsNote(undefined);
      try {
        const url = governanceDomainId
          ? `/api/attribute-groups?domainId=${encodeURIComponent(governanceDomainId)}`
          : '/api/attribute-groups';
        const r = await fetch(url);
        const j = await r.json();
        if (j.ok) { setGroups(j.groups || []); setGroupsNote(j.note); }
        else { setGroups([]); setGroupsNote(j.error); }
      } catch (e: any) {
        setGroups([]); setGroupsNote(e?.message || String(e));
      } finally { setGroupsLoading(false); }
    })();
  }, [governanceDomainId]);

  // ── Owner search (debounced, real Microsoft Graph) ───────────────────────
  const runOwnerSearch = useCallback((q: string) => {
    setOwnerQuery(q);
    if (ownerDebounce.current) clearTimeout(ownerDebounce.current);
    if (!q.trim()) { setOwnerResults([]); setOwnerError(undefined); return; }
    ownerDebounce.current = setTimeout(async () => {
      setOwnerSearching(true); setOwnerError(undefined);
      try {
        const r = await fetch(`/api/admin/permissions/principals?kind=user&q=${encodeURIComponent(q.trim())}`);
        const j = await r.json();
        if (j.ok) setOwnerResults(j.results || []);
        else { setOwnerResults([]); setOwnerError(j.remediation || j.error || `Search failed (HTTP ${r.status}).`); }
      } catch (e: any) {
        setOwnerResults([]); setOwnerError(e?.message || String(e));
      } finally { setOwnerSearching(false); }
    }, 300);
  }, []);

  const addOwner = useCallback((p: PrincipalResult) => {
    setOwners((cur) => cur.some((o) => o.id === p.id) ? cur : [...cur, { id: p.id, upn: p.upn || p.mail || '', displayName: p.displayName || p.upn || p.id }]);
    setOwnerQuery(''); setOwnerResults([]);
  }, []);
  const removeOwner = useCallback((id: string) => setOwners((cur) => cur.filter((o) => o.id !== id)), []);

  const overLimit = description.length > DATA_PRODUCT_DESCRIPTION_MAX;
  const page1Valid = !!displayName.trim() && !!type && !overLimit && owners.length > 0;

  // Required custom attributes must be filled before Create.
  const missingRequired = useMemo(() => {
    const missing: string[] = [];
    for (const g of groups) {
      for (const a of g.attributes) {
        if (!a.required) continue;
        const v = customAttributes[a.id];
        const empty = v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
        if (empty) missing.push(a.name);
      }
    }
    return missing;
  }, [groups, customAttributes]);

  const setAttr = useCallback((id: string, value: string | string[] | boolean) => {
    setCustomAttributes((cur) => ({ ...cur, [id]: value }));
  }, []);

  const submit = useCallback(async () => {
    setSubmitting(true); setSubmitError(undefined);
    try {
      const selectedDomain = domains.find((d) => d.id === governanceDomainId);
      const r = await fetch('/api/data-products', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: workspaceId || undefined,
          displayName: displayName.trim(),
          description,
          type,
          audience,
          governanceDomainId: governanceDomainId || undefined,
          governanceDomainName: selectedDomain?.name,
          useCase,
          endorsed,
          owners,
          customAttributes,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) { setSubmitError(j.error || `Create failed (HTTP ${r.status}).`); return; }
      router.push(`/data-products/${encodeURIComponent(j.id || j.item?.id)}`);
    } catch (e: any) {
      setSubmitError(e?.message || String(e));
    } finally { setSubmitting(false); }
  }, [workspaceId, displayName, description, type, audience, governanceDomainId, domains, useCase, endorsed, owners, customAttributes, router]);

  const stepChip = (n: Step, label: string) => {
    const done = step > n;
    return (
      <div
        className={`${s.stepChip} ${step === n ? s.stepActive : ''} ${done ? s.stepDone : ''}`}
        onClick={() => { if (n < step || (n === 2 && page1Valid) || n === 1) setStep(n); }}
        role="button"
        tabIndex={0}
      >
        <span className={`${s.stepNum} ${step === n ? s.stepNumActive : ''}`}>
          {done ? <CheckmarkCircle20Filled /> : n}
        </span>
        <Text weight={step === n ? 'semibold' : 'regular'}>{label}</Text>
      </div>
    );
  };

  return (
    <PageShell
      title="New data product"
      subtitle="Create a governed data product — Microsoft Purview Unified Catalog parity"
      breadcrumbs={[{ label: 'Home', href: '/' }, { label: 'Data products', href: '/data-products' }, { label: 'New' }]}
      actions={<Badge appearance="outline">Draft</Badge>}
    >
      <div className={s.steps}>
        {stepChip(1, 'Basic details')}
        <ArrowRight20Regular />
        {stepChip(2, 'Business details')}
        <ArrowRight20Regular />
        {stepChip(3, 'Custom attributes')}
      </div>
      <Divider />

      {/* ── PAGE 1 — BASIC ──────────────────────────────────────────────── */}
      {step === 1 && (
        <div className={s.page} style={{ marginTop: 16 }}>
          <Field label="Name" required hint="A unique, business-friendly name for the data product.">
            <Input value={displayName} onChange={(_, d) => setDisplayName(d.value)} placeholder="e.g. Superstore Sales" />
          </Field>

          <Field
            label="Description"
            required
            validationState={overLimit ? 'error' : undefined}
            validationMessage={overLimit ? `Description exceeds the ${DATA_PRODUCT_DESCRIPTION_MAX.toLocaleString()}-character limit.` : undefined}
            hint="A business narrative: when, what, why, and how this data came into existence."
          >
            <Textarea
              value={description}
              onChange={(_, d) => setDescription(d.value)}
              resize="vertical"
              style={{ minHeight: 120 }}
            />
          </Field>
          <Caption1 className={s.counter} style={{ color: overLimit ? tokens.colorPaletteRedForeground1 : tokens.colorNeutralForeground3 }}>
            {description.length.toLocaleString()} / {DATA_PRODUCT_DESCRIPTION_MAX.toLocaleString()}
          </Caption1>

          <Field label="Type" required hint="Helps consumers find the right kind of data product.">
            <Dropdown
              placeholder="Select a type"
              selectedOptions={type ? [type] : []}
              value={DATA_PRODUCT_TYPES.find((t) => t.value === type)?.label || ''}
              onOptionSelect={(_, d) => setType(d.optionValue || '')}
            >
              {DATA_PRODUCT_TYPES.map((t) => (
                <Option key={t.value} value={t.value}>{t.label}</Option>
              ))}
            </Dropdown>
          </Field>

          <Field label="Audience" hint="Who this data product is intended for (optional, multi-select).">
            <Dropdown
              multiselect
              placeholder="Select audiences"
              selectedOptions={audience}
              value={audience.map((v) => DATA_PRODUCT_AUDIENCES.find((a) => a.value === v)?.label || v).join(', ')}
              onOptionSelect={(_, d) => setAudience(d.selectedOptions)}
            >
              {DATA_PRODUCT_AUDIENCES.map((a) => (
                <Option key={a.value} value={a.value}>{a.label}</Option>
              ))}
            </Dropdown>
          </Field>

          <Field label="Owners" required hint="Search your directory (Microsoft Graph) and add at least one owner.">
            <Input
              value={ownerQuery}
              onChange={(_, d) => runOwnerSearch(d.value)}
              placeholder="Search by name or UPN…"
              contentBefore={<PersonAdd20Regular />}
              contentAfter={ownerSearching ? <Spinner size="tiny" /> : undefined}
            />
          </Field>
          {ownerError && (
            <MessageBar intent="warning">
              <MessageBarBody><MessageBarTitle>Directory search unavailable</MessageBarTitle>{ownerError}</MessageBarBody>
            </MessageBar>
          )}
          {ownerResults.length > 0 && (
            <div className={s.ownerResults}>
              {ownerResults.map((p) => (
                <div key={p.id} className={s.ownerResult} onClick={() => addOwner(p)} role="button" tabIndex={0}>
                  <Persona name={p.displayName || p.upn || p.id} secondaryText={p.upn || p.mail} avatar={{ color: 'colorful' }} />
                  <Button size="small" appearance="subtle" icon={<PersonAdd20Regular />} aria-label={`Add ${p.displayName}`}>Add</Button>
                </div>
              ))}
            </div>
          )}
          {owners.length > 0 && (
            <div className={s.chips}>
              {owners.map((o) => (
                <div key={o.id} className={s.ownerRow}>
                  <Persona name={o.displayName} secondaryText={o.upn} avatar={{ color: 'colorful' }} />
                  <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${o.displayName}`} onClick={() => removeOwner(o.id)} />
                </div>
              ))}
            </div>
          )}

          {workspaces.length > 1 && (
            <Field label="Loom workspace" hint="Where this draft data product is stored in Loom.">
              <Dropdown
                selectedOptions={workspaceId ? [workspaceId] : []}
                value={workspaces.find((w) => w.id === workspaceId)?.name || ''}
                onOptionSelect={(_, d) => setWorkspaceId(d.optionValue || '')}
              >
                {workspaces.map((w) => (<Option key={w.id} value={w.id}>{w.name}</Option>))}
              </Dropdown>
            </Field>
          )}
          {wsLoaded && workspaces.length === 0 && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>No Loom workspace yet</MessageBarTitle>
                A data product is stored inside a Loom workspace. Create a workspace first, then return here.
              </MessageBarBody>
            </MessageBar>
          )}
        </div>
      )}

      {/* ── PAGE 2 — BUSINESS ───────────────────────────────────────────── */}
      {step === 2 && (
        <div className={s.page} style={{ marginTop: 16 }}>
          <Field label="Governance domain" hint="The business boundary that owns this data product.">
            {domainsLoading ? (
              <Spinner size="tiny" label="Loading domains…" />
            ) : (
              <Dropdown
                placeholder={domains.length ? 'Select a governance domain' : 'No domains available'}
                disabled={domains.length === 0}
                selectedOptions={governanceDomainId ? [governanceDomainId] : []}
                value={domains.find((d) => d.id === governanceDomainId)?.name || ''}
                onOptionSelect={(_, d) => setGovernanceDomainId(d.optionValue || '')}
              >
                {domains.map((d) => (<Option key={d.id} value={d.id} text={d.name}>{d.name}</Option>))}
              </Dropdown>
            )}
          </Field>
          {domainSource === 'purview-uc' && (
            <MessageBar intent="success">
              <MessageBarBody>Domains loaded live from Microsoft Purview Unified Catalog — selecting one registers the data product in Purview.</MessageBarBody>
            </MessageBar>
          )}
          {domainSource === 'cosmos' && domainHint && (
            <MessageBar intent="info"><MessageBarBody>{domainHint}</MessageBarBody></MessageBar>
          )}

          <Field label="Use case" hint="What the data is used for today and how a user can apply it to their scenario.">
            <Textarea value={useCase} onChange={(_, d) => setUseCase(d.value)} resize="vertical" style={{ minHeight: 120 }} />
          </Field>

          <Checkbox
            checked={endorsed}
            onChange={(_, d) => setEndorsed(!!d.checked)}
            label="Mark as Endorsed — a signal of confidence that this data product meets quality and governance standards."
          />
        </div>
      )}

      {/* ── PAGE 3 — CUSTOM ATTRIBUTES ──────────────────────────────────── */}
      {step === 3 && (
        <div className={s.page} style={{ marginTop: 16 }}>
          {groupsLoading && <Spinner size="tiny" label="Loading custom attributes…" />}
          {!groupsLoading && groups.length === 0 && (
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>No custom attributes for this domain</MessageBarTitle>
                {groupsNote || 'No custom attribute groups are defined. Select Create to finish. An admin can define attribute groups via POST /api/attribute-groups (Catalog management → Custom metadata in Purview).'}
              </MessageBarBody>
            </MessageBar>
          )}
          {!groupsLoading && groups.map((g) => (
            <div key={g.id} className={s.attrGroup}>
              <Subtitle2>{g.name}</Subtitle2>
              {g.description && <Caption1>{g.description}</Caption1>}
              {g.attributes.map((a) => (
                <AttributeInput key={a.id} attr={a} value={customAttributes[a.id]} onChange={(v) => setAttr(a.id, v)} />
              ))}
            </div>
          ))}
          {missingRequired.length > 0 && (
            <MessageBar intent="warning">
              <MessageBarBody>Required attributes need a value: {missingRequired.join(', ')}.</MessageBarBody>
            </MessageBar>
          )}
        </div>
      )}

      {submitError && (
        <MessageBar intent="error" style={{ maxWidth: 760, marginTop: 12 }}>
          <MessageBarBody><MessageBarTitle>Create failed</MessageBarTitle>{submitError}</MessageBarBody>
        </MessageBar>
      )}

      {/* ── FOOTER NAV ──────────────────────────────────────────────────── */}
      <div className={s.footer}>
        <Button icon={<ArrowLeft20Regular />} disabled={step === 1 || submitting} onClick={() => setStep((step - 1) as Step)}>
          Back
        </Button>
        {step < 3 ? (
          <Button
            appearance="primary"
            icon={<ArrowRight20Regular />}
            iconPosition="after"
            disabled={(step === 1 && !page1Valid)}
            onClick={() => setStep((step + 1) as Step)}
          >
            Next
          </Button>
        ) : (
          <Button
            appearance="primary"
            icon={submitting ? <Spinner size="tiny" /> : <Save20Regular />}
            disabled={submitting || !page1Valid || missingRequired.length > 0 || (wsLoaded && workspaces.length === 0)}
            onClick={submit}
          >
            {submitting ? 'Creating…' : 'Create'}
          </Button>
        )}
      </div>
    </PageShell>
  );
}

/** Render a single custom attribute by its Purview field type. */
function AttributeInput({ attr, value, onChange }: {
  attr: AttributeDef;
  value: string | string[] | boolean | undefined;
  onChange: (v: string | string[] | boolean) => void;
}) {
  const common = { label: attr.name, required: attr.required, hint: attr.description } as const;
  switch (attr.fieldType) {
    case 'Boolean':
      return (
        <Field {...common}>
          <Checkbox checked={value === true} onChange={(_, d) => onChange(!!d.checked)} label="Yes" />
        </Field>
      );
    case 'Date':
      return (
        <Field {...common}>
          <Input type="date" value={typeof value === 'string' ? value : ''} onChange={(_, d) => onChange(d.value)} />
        </Field>
      );
    case 'Integer':
    case 'Double':
      return (
        <Field {...common}>
          <Input type="number" value={typeof value === 'string' ? value : ''} onChange={(_, d) => onChange(d.value)} />
        </Field>
      );
    case 'Rich text':
      return (
        <Field {...common}>
          <Textarea value={typeof value === 'string' ? value : ''} onChange={(_, d) => onChange(d.value)} resize="vertical" />
        </Field>
      );
    case 'Single choice':
      return (
        <Field {...common}>
          <Dropdown
            placeholder="Select a value"
            selectedOptions={typeof value === 'string' && value ? [value] : []}
            value={typeof value === 'string' ? value : ''}
            onOptionSelect={(_, d) => onChange(d.optionValue || '')}
          >
            {(attr.choices || []).map((c) => (<Option key={c} value={c}>{c}</Option>))}
          </Dropdown>
        </Field>
      );
    case 'Multiple choice':
      return (
        <Field {...common}>
          <Dropdown
            multiselect
            placeholder="Select values"
            selectedOptions={Array.isArray(value) ? value : []}
            value={Array.isArray(value) ? value.join(', ') : ''}
            onOptionSelect={(_, d) => onChange(d.selectedOptions)}
          >
            {(attr.choices || []).map((c) => (<Option key={c} value={c}>{c}</Option>))}
          </Dropdown>
        </Field>
      );
    case 'Text':
    default:
      return (
        <Field {...common}>
          <Input value={typeof value === 'string' ? value : ''} onChange={(_, d) => onChange(d.value)} />
        </Field>
      );
  }
}
