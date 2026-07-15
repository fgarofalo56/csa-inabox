'use client';

/**
 * DP-3 — the guided 7-step data-product creation wizard.
 *
 * Replaces the bare /new form with the shape every best-in-class platform
 * converged on (Purview create-manage, Databricks Marketplace guided listing):
 *
 *   1. Basics          — name, description, type, audience, owners
 *   2. Business context — governance domain, use case, endorsement, custom attrs
 *   3. Template         — CURATED_TEMPLATES gallery + live "what you get" preview,
 *                         or start blank
 *   4. Sources & ports  — attach data assets + declare input/output ports
 *   5. Contract & SLOs  — the typed DataContractDesigner
 *   6. Access policy     — self-serve vs governed/request + a default policy, or skip
 *   7. Review & preview  — the real consumer projection + a Publish checklist
 *
 * Progressive disclosure per the default-ON posture: a DRAFT record is created
 * immediately after step 1 (canonical lifecycleState:'draft' via DP-1), every
 * later step is Skippable-with-defaults and PATCHes as you go, and only the
 * mandatory Purview subset (an asset + an access policy + a domain) gates
 * Publish — surfaced as an HONEST checklist, never a silent allow
 * (no-vaporware.md). Azure-native: real Cosmos + Graph + existing typed
 * designers, no Fabric/Power BI dependency (no-fabric-dependency.md).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { shorthands,
  Badge, Body1Strong, Button, Caption1, Checkbox, Divider, Dropdown, Field, Input, Option,
  Spinner, Subtitle2, Text, Textarea,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowLeft20Regular, ArrowRight20Regular, CheckmarkCircle20Filled, DismissCircle20Filled,
  Save20Regular, Rocket20Regular, Add20Regular, Dismiss16Regular, Board20Regular,
} from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { DataContractDesigner } from '@/lib/editors/components/data-contract-designer';
import { AddDataAssetsPanel } from '@/lib/editors/components/add-data-assets-panel';
import { EMPTY_CONTRACT, contractStats, type DataContract } from '@/lib/dataproducts/contract';
import { OwnerPeoplePicker, type OwnerRef } from '@/lib/dataproducts/owner-picker';
import { AttributeInput, type AttributeGroup } from '@/lib/dataproducts/attribute-input';
import { CURATED_TEMPLATES, type DataProductTemplate } from '@/lib/catalog/data-product-templates';
import { DEFAULT_PURPOSES } from '@/lib/types/access-policy';
import {
  DATA_PRODUCT_TYPES, DATA_PRODUCT_AUDIENCES, DATA_PRODUCT_DESCRIPTION_MAX,
} from '@/lib/catalog/data-product-enums';

const FORM_MAX = '820px';
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
  footer: { display: 'flex', gap: tokens.spacingHorizontalS, justifyContent: 'space-between', marginTop: tokens.spacingVerticalM, maxWidth: FORM_MAX, flexWrap: 'wrap' },
  footRight: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  attrGroup: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingHorizontalM, borderRadius: tokens.borderRadiusLarge, border: `1px solid ${tokens.colorNeutralStroke2}` },
  tGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: tokens.spacingHorizontalM },
  tCard: {
    padding: tokens.spacingHorizontalM, borderRadius: tokens.borderRadiusLarge, cursor: 'pointer',
    border: `1px solid ${tokens.colorNeutralStroke2}`, boxShadow: tokens.shadow4, minWidth: 0,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    ':hover': { boxShadow: tokens.shadow16, ...shorthands.borderColor(tokens.colorBrandStroke1) },
  },
  tCardSel: { ...shorthands.borderColor(tokens.colorBrandStroke1), backgroundColor: tokens.colorBrandBackground2 },
  preview: { padding: tokens.spacingHorizontalM, borderRadius: tokens.borderRadiusLarge, border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  portRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' },
  checkRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  pass: { color: tokens.colorPaletteGreenForeground1, flexShrink: 0 },
  fail: { color: tokens.colorPaletteRedForeground1, flexShrink: 0 },
});

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7;
const STEP_LABELS: Record<Step, string> = {
  1: 'Basics', 2: 'Business context', 3: 'Template', 4: 'Sources & ports',
  5: 'Contract & SLOs', 6: 'Access policy', 7: 'Review & publish',
};
const PORT_DIRECTIONS = ['output', 'input', 'management'] as const;
interface Port { name: string; direction: (typeof PORT_DIRECTIONS)[number] }
interface DomainOption { id: string; name: string; description?: string }
interface WorkspaceLite { id: string; name: string }

export function DataProductCreateWizard() {
  const s = useStyles();
  const router = useRouter();

  const [step, setStep] = useState<Step>(1);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // Step 1 — Basics
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState('');
  const [audience, setAudience] = useState<string[]>([]);
  const [owners, setOwners] = useState<OwnerRef[]>([]);

  // Step 2 — Business context
  const [governanceDomainId, setGovernanceDomainId] = useState('');
  const [useCase, setUseCase] = useState('');
  const [endorsed, setEndorsed] = useState(false);
  const [customAttributes, setCustomAttributes] = useState<Record<string, string | string[] | boolean>>({});

  // Step 3 — Template
  const [templateSlug, setTemplateSlug] = useState<string | null>(null);

  // Step 4 — Sources & ports
  const [ports, setPorts] = useState<Port[]>([]);
  const [assetCount, setAssetCount] = useState(0);
  const [assetsOpen, setAssetsOpen] = useState(false);

  // Step 5 — Contract
  const [contract, setContract] = useState<DataContract>(EMPTY_CONTRACT);

  // Step 6 — Access
  const [accessModel, setAccessModel] = useState<'governed' | 'self-serve' | 'request'>('governed');
  const [policyConfigured, setPolicyConfigured] = useState(false);

  // Step 7 — Review
  const [reviewProduct, setReviewProduct] = useState<any>(null);
  const [publishBlockers, setPublishBlockers] = useState<string[] | null>(null);
  const [published, setPublished] = useState(false);

  // Workspace + domains + attribute groups
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [wsLoaded, setWsLoaded] = useState(false);
  const [domains, setDomains] = useState<DomainOption[]>([]);
  const [domainSource, setDomainSource] = useState<'purview-uc' | 'cosmos' | ''>('');
  const [domainHint, setDomainHint] = useState<string | undefined>();
  const [domainsLoading, setDomainsLoading] = useState(true);
  const [groups, setGroups] = useState<AttributeGroup[]>([]);
  const [groupsNote, setGroupsNote] = useState<string | undefined>();

  // ── Load workspaces + domains on mount ───────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/loom/workspaces');
        const j = await r.json();
        const ws: WorkspaceLite[] = j.ok ? (j.workspaces || []) : [];
        setWorkspaces(ws);
        if (ws.length) setWorkspaceId(ws[0].id);
      } catch { /* surfaced at draft-create */ }
      finally { setWsLoaded(true); }
    })();
    (async () => {
      setDomainsLoading(true);
      try {
        const r = await fetch('/api/governance-domains');
        const j = await r.json();
        if (j.ok) { setDomains(j.domains || []); setDomainSource(j.source || ''); setDomainHint(j.purviewHint); }
        else setDomainHint(j.error || 'Failed to load governance domains.');
      } catch (e: any) { setDomainHint(e?.message || String(e)); }
      finally { setDomainsLoading(false); }
    })();
  }, []);

  // ── Attribute groups per domain ──────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const url = governanceDomainId ? `/api/attribute-groups?domainId=${encodeURIComponent(governanceDomainId)}` : '/api/attribute-groups';
        const r = await fetch(url);
        const j = await r.json();
        if (j.ok) { setGroups(j.groups || []); setGroupsNote(j.note); }
        else { setGroups([]); setGroupsNote(j.error); }
      } catch (e: any) { setGroups([]); setGroupsNote(e?.message || String(e)); }
    })();
  }, [governanceDomainId]);

  const overLimit = description.length > DATA_PRODUCT_DESCRIPTION_MAX;
  const page1Valid = !!displayName.trim() && !!type && !overLimit && owners.length > 0;
  const selectedTemplate: DataProductTemplate | undefined = useMemo(
    () => CURATED_TEMPLATES.find((t) => t.slug === templateSlug), [templateSlug]);

  const setAttr = useCallback((id: string, value: string | string[] | boolean) => {
    setCustomAttributes((cur) => ({ ...cur, [id]: value }));
  }, []);

  // ── PATCH helper ─────────────────────────────────────────────────────────
  const patchDraft = useCallback(async (fields: Record<string, unknown>): Promise<boolean> => {
    if (!draftId) return false;
    const r = await fetch(`/api/data-products/${encodeURIComponent(draftId)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) { setError(j.error || `Save failed (HTTP ${r.status}).`); return false; }
    return true;
  }, [draftId]);

  // ── Draft-on-step-1: create the DRAFT the moment Basics is complete ───────
  const ensureDraft = useCallback(async (): Promise<string | null> => {
    if (draftId) return draftId;
    const selectedDomain = domains.find((d) => d.id === governanceDomainId);
    const r = await fetch('/api/data-products', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: workspaceId || undefined,
        displayName: displayName.trim(), description, type, audience,
        governanceDomainId: governanceDomainId || undefined,
        governanceDomainName: selectedDomain?.name,
        useCase, endorsed, owners, customAttributes,
      }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) { setError(j.error || `Draft create failed (HTTP ${r.status}).`); return null; }
    const newId = j.id || j.item?.id;
    setDraftId(newId);
    return newId;
  }, [draftId, domains, governanceDomainId, workspaceId, displayName, description, type, audience, useCase, endorsed, owners, customAttributes]);

  // ── Advance: persist THIS step's fields, then go to `next` ────────────────
  const advance = useCallback(async (next: Step, fields?: Record<string, unknown>) => {
    setBusy(true); setError(undefined);
    try {
      let id = draftId;
      if (!id) { id = await ensureDraft(); if (!id) return; }
      // Only PATCH when there is at least one field to persist (an empty body
      // would 400 'no_fields'); a bare Skip just advances.
      const hasFields = fields && Object.keys(fields).some((k) => fields[k] !== undefined);
      if (hasFields) { const ok = await patchDraft(fields!); if (!ok) return; }
      setStep(next);
    } finally { setBusy(false); }
  }, [draftId, ensureDraft, patchDraft]);

  // Step 1 → 2 also CREATES the draft (draft-on-step-1).
  const advanceFromBasics = useCallback(async () => {
    setBusy(true); setError(undefined);
    try { const id = await ensureDraft(); if (id) setStep(2); }
    finally { setBusy(false); }
  }, [ensureDraft]);

  const saveExit = useCallback(async () => {
    setBusy(true);
    try {
      const id = draftId || await ensureDraft();
      if (id) router.push(`/data-products/${encodeURIComponent(id)}`);
    } finally { setBusy(false); }
  }, [draftId, ensureDraft, router]);

  // ── Access step — configure a default access policy (real PUT) ────────────
  const configurePolicy = useCallback(async () => {
    if (!draftId) return;
    setBusy(true); setError(undefined);
    try {
      const r = await fetch(`/api/data-products/${encodeURIComponent(draftId)}/access-policy`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allowedPurposes: DEFAULT_PURPOSES, requireManagerApproval: accessModel === 'request', approvers: [] }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) { setError(j.error || `Policy save failed (HTTP ${r.status}).`); return; }
      setPolicyConfigured(true);
    } finally { setBusy(false); }
  }, [draftId, accessModel]);

  // ── Review — load the consumer projection ────────────────────────────────
  const loadReview = useCallback(async () => {
    if (!draftId) return;
    try {
      const r = await fetch(`/api/data-products/${encodeURIComponent(draftId)}`);
      const j = await r.json();
      if (j.ok) { setReviewProduct(j.product); setAssetCount((j.product?.dataAssets?.length) ?? assetCount); }
    } catch { /* preview is best-effort; the checklist still renders */ }
  }, [draftId, assetCount]);

  const publish = useCallback(async () => {
    if (!draftId) return;
    setBusy(true); setError(undefined); setPublishBlockers(null);
    try {
      const r = await fetch(`/api/data-products/${encodeURIComponent(draftId)}/status`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'PUBLISHED' }),
      });
      const j = await r.json();
      if (r.status === 422 && j.preconditionFailed) { setPublishBlockers([j.preconditionFailed.message]); return; }
      if (!r.ok || !j.ok) { setError(j.error || `Publish failed (HTTP ${r.status}).`); return; }
      setPublished(true);
      router.push(`/data-products/${encodeURIComponent(draftId)}`);
    } finally { setBusy(false); }
  }, [draftId, router]);

  // Publish checklist (mirrors the status-route preconditions honestly).
  const checklist = useMemo(() => ([
    { label: 'At least one data asset attached', ok: assetCount > 0 },
    { label: 'Access policy configured (or self-serve)', ok: policyConfigured || accessModel === 'self-serve' },
    { label: 'Governance domain set', ok: !!governanceDomainId },
  ]), [assetCount, policyConfigured, accessModel, governanceDomainId]);

  const stepChip = (n: Step) => {
    const done = step > n;
    return (
      <div
        className={`${s.stepChip} ${step === n ? s.stepActive : ''} ${done ? s.stepDone : ''}`}
        onClick={() => { if (n <= step || (n > 1 && draftId)) { if (n === 7) void loadReview(); setStep(n); } }}
        role="button" tabIndex={0}
      >
        <span className={`${s.stepNum} ${step === n ? s.stepNumActive : ''}`}>
          {done ? <CheckmarkCircle20Filled /> : n}
        </span>
        <Text weight={step === n ? 'semibold' : 'regular'}>{STEP_LABELS[n]}</Text>
      </div>
    );
  };

  return (
    <PageShell
      title="New data product"
      subtitle="Guided creation — a governed, contract-bound product consumers can discover and subscribe to"
      breadcrumbs={[{ label: 'Home', href: '/' }, { label: 'Data products', href: '/data-products' }, { label: 'New' }]}
      actions={<Badge appearance="outline">{draftId ? 'Draft saved' : 'Draft'}</Badge>}
    >
      <div className={s.steps}>
        {([1, 2, 3, 4, 5, 6, 7] as Step[]).map((n, i) => (
          <span key={n} style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
            {stepChip(n)}{i < 6 && <ArrowRight20Regular />}
          </span>
        ))}
      </div>
      <Divider />

      {/* ── STEP 1 — BASICS ─────────────────────────────────────────────── */}
      {step === 1 && (
        <div className={s.page} style={{ marginTop: tokens.spacingVerticalL }}>
          <Field label="Name" required hint="A unique, business-friendly name for the data product.">
            <Input value={displayName} onChange={(_, d) => setDisplayName(d.value)} placeholder="e.g. Superstore Sales" />
          </Field>
          <Field
            label="Description" required
            validationState={overLimit ? 'error' : undefined}
            validationMessage={overLimit ? `Description exceeds the ${DATA_PRODUCT_DESCRIPTION_MAX.toLocaleString()}-character limit.` : undefined}
            hint="A business narrative: when, what, why, and how this data came into existence."
          >
            <Textarea value={description} onChange={(_, d) => setDescription(d.value)} resize="vertical" style={{ minHeight: '120px' }} />
          </Field>
          <Caption1 className={s.counter} style={{ color: overLimit ? tokens.colorPaletteRedForeground1 : tokens.colorNeutralForeground3 }}>
            {description.length.toLocaleString()} / {DATA_PRODUCT_DESCRIPTION_MAX.toLocaleString()}
          </Caption1>
          <Field label="Type" required hint="Helps consumers find the right kind of data product.">
            <Dropdown placeholder="Select a type" selectedOptions={type ? [type] : []}
              value={DATA_PRODUCT_TYPES.find((t) => t.value === type)?.label || ''}
              onOptionSelect={(_, d) => setType(d.optionValue || '')}>
              {DATA_PRODUCT_TYPES.map((t) => (<Option key={t.value} value={t.value}>{t.label}</Option>))}
            </Dropdown>
          </Field>
          <Field label="Audience" hint="Who this data product is intended for (optional, multi-select).">
            <Dropdown multiselect placeholder="Select audiences" selectedOptions={audience}
              value={audience.map((v) => DATA_PRODUCT_AUDIENCES.find((a) => a.value === v)?.label || v).join(', ')}
              onOptionSelect={(_, d) => setAudience(d.selectedOptions)}>
              {DATA_PRODUCT_AUDIENCES.map((a) => (<Option key={a.value} value={a.value}>{a.label}</Option>))}
            </Dropdown>
          </Field>
          <OwnerPeoplePicker owners={owners} onChange={setOwners} required hint="Search your directory (Microsoft Graph) and add at least one owner." />
          {workspaces.length > 1 && (
            <Field label="Loom workspace" hint="Where this draft data product is stored in Loom.">
              <Dropdown selectedOptions={workspaceId ? [workspaceId] : []}
                value={workspaces.find((w) => w.id === workspaceId)?.name || ''}
                onOptionSelect={(_, d) => setWorkspaceId(d.optionValue || '')}>
                {workspaces.map((w) => (<Option key={w.id} value={w.id}>{w.name}</Option>))}
              </Dropdown>
            </Field>
          )}
          {wsLoaded && workspaces.length === 0 && (
            <MessageBar intent="warning"><MessageBarBody>
              <MessageBarTitle>No Loom workspace yet</MessageBarTitle>
              A data product is stored inside a Loom workspace. Create a workspace first, then return here.
            </MessageBarBody></MessageBar>
          )}
        </div>
      )}

      {/* ── STEP 2 — BUSINESS CONTEXT ───────────────────────────────────── */}
      {step === 2 && (
        <div className={s.page} style={{ marginTop: tokens.spacingVerticalL }}>
          <Field label="Governance domain" hint="The business boundary that owns this data product.">
            {domainsLoading ? <Spinner size="tiny" label="Loading domains…" /> : (
              <Dropdown placeholder={domains.length ? 'Select a governance domain' : 'No domains available'}
                disabled={domains.length === 0} selectedOptions={governanceDomainId ? [governanceDomainId] : []}
                value={domains.find((d) => d.id === governanceDomainId)?.name || ''}
                onOptionSelect={(_, d) => setGovernanceDomainId(d.optionValue || '')}>
                {domains.map((d) => (<Option key={d.id} value={d.id} text={d.name}>{d.name}</Option>))}
              </Dropdown>
            )}
          </Field>
          {domainSource === 'purview-uc' && (
            <MessageBar intent="success"><MessageBarBody>Domains loaded live from Microsoft Purview Unified Catalog — selecting one registers the data product in Purview.</MessageBarBody></MessageBar>
          )}
          {domainSource === 'cosmos' && domainHint && (<MessageBar intent="info"><MessageBarBody>{domainHint}</MessageBarBody></MessageBar>)}
          <Field label="Use case" hint="What the data is used for today and how a user can apply it to their scenario.">
            <Textarea value={useCase} onChange={(_, d) => setUseCase(d.value)} resize="vertical" style={{ minHeight: '96px' }} />
          </Field>
          <Checkbox checked={endorsed} onChange={(_, d) => setEndorsed(!!d.checked)}
            label="Mark as Endorsed — a signal of confidence that this data product meets quality and governance standards." />
          {groups.length > 0 && groups.map((g) => (
            <div key={g.id} className={s.attrGroup}>
              <Subtitle2>{g.name}</Subtitle2>
              {g.description && <Caption1>{g.description}</Caption1>}
              {g.attributes.map((a) => (<AttributeInput key={a.id} attr={a} value={customAttributes[a.id]} onChange={(v) => setAttr(a.id, v)} />))}
            </div>
          ))}
          {groups.length === 0 && groupsNote && (<Caption1>{groupsNote}</Caption1>)}
        </div>
      )}

      {/* ── STEP 3 — TEMPLATE ───────────────────────────────────────────── */}
      {step === 3 && (
        <div className={s.page} style={{ marginTop: tokens.spacingVerticalL }}>
          <Body1Strong>Start from a template, or build blank</Body1Strong>
          <Caption1>A template pre-fills the sources, contract, and next-steps for a common pattern. You can change anything afterward.</Caption1>
          <div className={s.tGrid}>
            <div className={`${s.tCard} ${templateSlug === null ? s.tCardSel : ''}`} role="button" tabIndex={0} onClick={() => setTemplateSlug(null)}>
              <Board20Regular />
              <Text weight="semibold">Start blank</Text>
              <Caption1>Define everything yourself from the following steps.</Caption1>
            </div>
            {CURATED_TEMPLATES.map((t) => (
              <div key={t.slug} className={`${s.tCard} ${templateSlug === t.slug ? s.tCardSel : ''}`} role="button" tabIndex={0} onClick={() => setTemplateSlug(t.slug)}>
                <Badge appearance="tint" color="brand">{t.category}</Badge>
                <Text weight="semibold">{t.displayName}</Text>
                <Caption1>{t.description}</Caption1>
              </div>
            ))}
          </div>
          {selectedTemplate && (
            <div className={s.preview}>
              <Body1Strong>What you get: {selectedTemplate.displayName}</Body1Strong>
              <Caption1>{selectedTemplate.instructions}</Caption1>
              <Text weight="semibold">Components</Text>
              {selectedTemplate.components.map((c) => (<Caption1 key={c.slug}>• {c.label} — {c.description}</Caption1>))}
              <Caption1>Est. cost ~${selectedTemplate.estimatedMonthlyCostUsd}/mo. Next steps: {selectedTemplate.nextSteps.join(' → ')}</Caption1>
            </div>
          )}
        </div>
      )}

      {/* ── STEP 4 — SOURCES & PORTS ────────────────────────────────────── */}
      {step === 4 && (
        <div className={s.page} style={{ marginTop: tokens.spacingVerticalL }}>
          <Body1Strong>Data assets</Body1Strong>
          <Caption1>Attach the governed assets this product exposes. At least one is required to publish.</Caption1>
          <div className={s.checkRow}>
            <Badge appearance="tint" color={assetCount > 0 ? 'success' : 'informative'}>{assetCount} attached</Badge>
            <Button icon={<Add20Regular />} onClick={() => setAssetsOpen(true)} disabled={!draftId}>Attach data assets</Button>
          </div>
          <Divider />
          <Body1Strong>Ports</Body1Strong>
          <Caption1>Declare the input/output ports this product publishes (each output port is contract-bound).</Caption1>
          {ports.map((p, i) => (
            <div key={i} className={s.portRow}>
              <Field label="Port name" style={{ flex: 1, minWidth: '180px' }}>
                <Input value={p.name} onChange={(_, d) => setPorts((cur) => cur.map((x, xi) => xi === i ? { ...x, name: d.value } : x))} placeholder="e.g. curated-sales" />
              </Field>
              <Field label="Direction">
                <Dropdown selectedOptions={[p.direction]} value={p.direction}
                  onOptionSelect={(_, d) => setPorts((cur) => cur.map((x, xi) => xi === i ? { ...x, direction: (d.optionValue as Port['direction']) || 'output' } : x))}>
                  {PORT_DIRECTIONS.map((dir) => (<Option key={dir} value={dir}>{dir}</Option>))}
                </Dropdown>
              </Field>
              <Button icon={<Dismiss16Regular />} appearance="subtle" aria-label="Remove port" onClick={() => setPorts((cur) => cur.filter((_, xi) => xi !== i))} />
            </div>
          ))}
          <Button icon={<Add20Regular />} appearance="secondary" onClick={() => setPorts((cur) => [...cur, { name: '', direction: 'output' }])}>Add port</Button>
          {draftId && (
            <AddDataAssetsPanel
              productId={draftId} open={assetsOpen} onClose={() => setAssetsOpen(false)}
              existingGuids={new Set()} onAdded={(next) => setAssetCount(next.length)}
            />
          )}
        </div>
      )}

      {/* ── STEP 5 — CONTRACT & SLOs ────────────────────────────────────── */}
      {step === 5 && (
        <div style={{ marginTop: tokens.spacingVerticalL, minWidth: 0 }}>
          <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalM }}>
            <MessageBarBody>
              <MessageBarTitle>Data contract (optional)</MessageBarTitle>
              Define the schema, service-level objectives, and data-quality expectations this product commits to. Skip to add it later on the Contract tab.
            </MessageBarBody>
          </MessageBar>
          <DataContractDesigner value={contract} onChange={setContract} />
        </div>
      )}

      {/* ── STEP 6 — ACCESS POLICY ──────────────────────────────────────── */}
      {step === 6 && (
        <div className={s.page} style={{ marginTop: tokens.spacingVerticalL }}>
          <Field label="Access model" hint="How consumers get access to this product.">
            <Dropdown selectedOptions={[accessModel]} value={accessModel}
              onOptionSelect={(_, d) => setAccessModel((d.optionValue as typeof accessModel) || 'governed')}>
              <Option value="governed" text="Governed — approval required">Governed — approval required (tiered access request)</Option>
              <Option value="request" text="Request — manager approval">Request — manager approval required</Option>
              <Option value="self-serve" text="Self-serve — open">Self-serve — any signed-in consumer, no approval</Option>
            </Dropdown>
          </Field>
          {accessModel !== 'self-serve' ? (
            <>
              <Caption1>Configure a default access policy (allowed purposes + approval). You can refine it later on the Access policies tab.</Caption1>
              <div className={s.checkRow}>
                <Badge appearance="tint" color={policyConfigured ? 'success' : 'informative'}>{policyConfigured ? 'Policy configured' : 'No policy yet'}</Badge>
                <Button onClick={configurePolicy} disabled={!draftId || busy}>Configure default policy</Button>
              </div>
            </>
          ) : (
            <MessageBar intent="info"><MessageBarBody>Self-serve products need no access policy — any signed-in consumer can subscribe.</MessageBarBody></MessageBar>
          )}
        </div>
      )}

      {/* ── STEP 7 — REVIEW & PUBLISH ───────────────────────────────────── */}
      {step === 7 && (
        <div className={s.page} style={{ marginTop: tokens.spacingVerticalL }}>
          <Body1Strong>Consumer preview</Body1Strong>
          <div className={s.preview}>
            <Subtitle2>{reviewProduct?.name || displayName || 'Untitled data product'}</Subtitle2>
            <Caption1>{reviewProduct?.description || description || 'No description.'}</Caption1>
            <Caption1>Type: {reviewProduct?.type || type || '—'} · Owners: {(reviewProduct?.owners || owners).map((o: any) => o.displayName || o.upn).join(', ') || '—'}</Caption1>
            <Caption1>Domain: {domains.find((d) => d.id === governanceDomainId)?.name || '—'} · Access: {accessModel}</Caption1>
          </div>
          <Body1Strong>Ready to publish?</Body1Strong>
          {checklist.map((c) => (
            <div key={c.label} className={s.checkRow}>
              {c.ok ? <CheckmarkCircle20Filled className={s.pass} /> : <DismissCircle20Filled className={s.fail} />}
              <Caption1>{c.label}</Caption1>
            </div>
          ))}
          {publishBlockers && (
            <MessageBar intent="warning"><MessageBarBody>
              <MessageBarTitle>Publish blocked</MessageBarTitle>{publishBlockers.join(' ')}
            </MessageBarBody></MessageBar>
          )}
          {published && (<MessageBar intent="success"><MessageBarBody>Published — the product is now discoverable in the marketplace.</MessageBarBody></MessageBar>)}
        </div>
      )}

      {error && (
        <MessageBar intent="error" style={{ maxWidth: FORM_MAX, marginTop: tokens.spacingVerticalM }}>
          <MessageBarBody><MessageBarTitle>Something went wrong</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}

      {/* ── FOOTER NAV ──────────────────────────────────────────────────── */}
      <div className={s.footer}>
        <Button icon={<ArrowLeft20Regular />} disabled={step === 1 || busy} onClick={() => setStep((step - 1) as Step)}>Back</Button>
        <div className={s.footRight}>
          {draftId && step > 1 && (<Button icon={<Save20Regular />} disabled={busy} onClick={saveExit}>Save &amp; exit</Button>)}
          {step > 2 && step < 7 && (
            <Button appearance="secondary" disabled={busy} onClick={() => advance((step + 1) as Step)}>Skip</Button>
          )}
          {step === 1 && (
            <Button appearance="primary" icon={<ArrowRight20Regular />} iconPosition="after" disabled={!page1Valid || busy || (wsLoaded && workspaces.length === 0)} onClick={advanceFromBasics}>
              {busy ? 'Saving draft…' : 'Next'}
            </Button>
          )}
          {step === 2 && (
            <Button appearance="primary" icon={<ArrowRight20Regular />} iconPosition="after" disabled={busy}
              onClick={() => advance(3, { governanceDomainId: governanceDomainId || undefined, useCase, endorsed, customAttributes })}>Next</Button>
          )}
          {step === 3 && (
            <Button appearance="primary" icon={<ArrowRight20Regular />} iconPosition="after" disabled={busy}
              onClick={() => advance(4, { templateSlug })}>Next</Button>
          )}
          {step === 4 && (
            <Button appearance="primary" icon={<ArrowRight20Regular />} iconPosition="after" disabled={busy}
              onClick={() => advance(5, { ports: ports.filter((p) => p.name.trim()) })}>Next</Button>
          )}
          {step === 5 && (
            <Button appearance="primary" icon={<ArrowRight20Regular />} iconPosition="after" disabled={busy}
              onClick={() => advance(6, contractStats(contract).defined ? { contract } : {})}>Next</Button>
          )}
          {step === 6 && (
            <Button appearance="primary" icon={<ArrowRight20Regular />} iconPosition="after" disabled={busy}
              onClick={async () => { const ok = await patchDraft({ accessModel }); if (ok) { await loadReview(); setStep(7); } }}>Review</Button>
          )}
          {step === 7 && (
            <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <Rocket20Regular />} disabled={busy || !draftId} onClick={publish}>
              {busy ? 'Publishing…' : 'Publish'}
            </Button>
          )}
        </div>
      </div>
    </PageShell>
  );
}
