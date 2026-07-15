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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { shorthands,
  Badge, Button, Caption1, Checkbox, Divider, Dropdown, Field, Input, Option,
  Spinner, Subtitle2, Text, Textarea,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowLeft20Regular, ArrowRight20Regular, CheckmarkCircle20Filled, Save20Regular,
} from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { DataContractDesigner } from '@/lib/editors/components/data-contract-designer';
import { EMPTY_CONTRACT, contractStats, type DataContract } from '@/lib/dataproducts/contract';
import { OwnerPeoplePicker, type OwnerRef } from '@/lib/dataproducts/owner-picker';
import { AttributeInput, type AttributeGroup } from '@/lib/dataproducts/attribute-input';
import {
  DATA_PRODUCT_TYPES, DATA_PRODUCT_AUDIENCES, DATA_PRODUCT_DESCRIPTION_MAX,
} from '@/lib/catalog/data-product-enums';

// NOTE: every length value MUST carry a unit or come from a token. Griffel
// silently DROPS unitless numeric values (e.g. `gap: 16`, `maxWidth: 760`,
// `width: 22`) in this project's setup — which previously made the form sprawl
// full-width, collapsed the step-number circles, and removed chip gaps. Use
// Loom spacing/radius tokens (web3-ui rule) and explicit px strings for
// structural sizes.
const FORM_MAX = '760px';
const useStyles = makeStyles({
  steps: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap', marginBottom: tokens.spacingVerticalXS },
  stepChip: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge,
    padding: `${tokens.spacingVerticalSNudge} ${tokens.spacingHorizontalM}`, borderRadius: tokens.borderRadiusCircular,
    border: `1px solid ${tokens.colorNeutralStroke2}`, cursor: 'pointer',
  },
  stepActive: { backgroundColor: tokens.colorBrandBackground2, ...shorthands.borderColor(tokens.colorBrandStroke1) },
  stepDone: { ...shorthands.borderColor(tokens.colorPaletteGreenBorder2) },
  stepNum: {
    width: '22px', height: '22px', borderRadius: '50%', display: 'inline-flex', alignItems: 'center',
    justifyContent: 'center', fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold, flexShrink: 0,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
  },
  stepNumActive: { backgroundColor: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand },
  page: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, maxWidth: FORM_MAX },
  counter: { alignSelf: 'flex-end' },
  footer: { display: 'flex', gap: tokens.spacingHorizontalS, justifyContent: 'space-between', marginTop: tokens.spacingVerticalM, maxWidth: FORM_MAX },
  attrGroup: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingHorizontalM, borderRadius: tokens.borderRadiusLarge, border: `1px solid ${tokens.colorNeutralStroke2}` },
});

type Step = 1 | 2 | 3 | 4;

interface DomainOption { id: string; name: string; description?: string }
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
  const [owners, setOwners] = useState<OwnerRef[]>([]);

  // Page 2 — Business
  const [governanceDomainId, setGovernanceDomainId] = useState('');
  const [useCase, setUseCase] = useState('');
  const [endorsed, setEndorsed] = useState(false);

  // Page 3 — Custom attributes
  const [customAttributes, setCustomAttributes] = useState<Record<string, string | string[] | boolean>>({});

  // Page 4 — Data contract (optional): schema + SLOs + quality expectations.
  const [contract, setContract] = useState<DataContract>(EMPTY_CONTRACT);

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
          ...(contractStats(contract).defined ? { contract } : {}),
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) { setSubmitError(j.error || `Create failed (HTTP ${r.status}).`); return; }
      router.push(`/data-products/${encodeURIComponent(j.id || j.item?.id)}`);
    } catch (e: any) {
      setSubmitError(e?.message || String(e));
    } finally { setSubmitting(false); }
  }, [workspaceId, displayName, description, type, audience, governanceDomainId, domains, useCase, endorsed, owners, customAttributes, contract, router]);

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
        <ArrowRight20Regular />
        {stepChip(4, 'Data contract')}
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

          <OwnerPeoplePicker
            owners={owners}
            onChange={setOwners}
            required
            hint="Search your directory (Microsoft Graph) and add at least one owner."
          />

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

      {/* ── PAGE 4 — DATA CONTRACT (optional) ────────────────────────────── */}
      {step === 4 && (
        <div style={{ marginTop: 16, minWidth: 0 }}>
          <MessageBar intent="info" style={{ marginBottom: 12 }}>
            <MessageBarBody>
              <MessageBarTitle>Data contract (optional)</MessageBarTitle>
              Define the schema, service-level objectives, and data-quality expectations this product
              commits to. You can skip this and add it later in the studio&apos;s Contract tab.
            </MessageBarBody>
          </MessageBar>
          <DataContractDesigner value={contract} onChange={setContract} />
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
        {step < 4 ? (
          <Button
            appearance="primary"
            icon={<ArrowRight20Regular />}
            iconPosition="after"
            disabled={(step === 1 && !page1Valid) || (step === 3 && missingRequired.length > 0)}
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
