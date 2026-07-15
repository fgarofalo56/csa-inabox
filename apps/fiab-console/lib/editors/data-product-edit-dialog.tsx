'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * DataProductEditDialog — the Loom one-for-one of Microsoft Purview's
 * "Edit data product" modal (Data Marketplace F4 + F7).
 *
 * Three steps that mirror the Create wizard — Basic / Business / Custom
 * attributes — where EACH step owns its own Save that fires a PATCH carrying
 * ONLY that step's fields (so editing Basic never re-sends Business fields).
 * The PATCH uses Cosmos optimistic concurrency: the dialog reads the doc's
 * `_etag` on open (from the GET response's ETag header) and passes it back as
 * `If-Match` on every save, refreshing it from each PATCH response. A stale
 * ETag (concurrent edit) yields HTTP 409, surfaced as an honest MessageBar.
 *
 * Parity details mirrored from the portal:
 *   - Basic: name, description, 12-value Type Select, 8-value Audience
 *     multi-select, owners, and the Endorsed checkbox (F7) with an inline
 *     Endorsed badge preview.
 *   - A debounced (500 ms), NON-BLOCKING duplicate-name warning banner — Save
 *     is never disabled by it, exactly like the portal.
 *   - Business: governance-domain Dropdown (real /api/admin/domains), use case.
 *   - Custom attributes: honest infra-gate until attribute-groups admin (T15)
 *     ships, per .claude/rules/no-vaporware.md.
 *
 * Backend: real Cosmos data-plane via /api/data-products/[id] (Azure-native
 * default — no Fabric/Purview dependency).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Input, Textarea, Field, Dropdown, Option, Select, Checkbox, Badge,
  Caption1, Body1Strong, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Edit20Regular, Save16Regular } from '@fluentui/react-icons';
import {
  DATA_PRODUCT_TYPES, DATA_PRODUCT_AUDIENCES, pickStepFields, type EditStep,
} from '@/lib/dataproducts/steps';
import type { DataProductDoc } from '@/lib/dataproducts/edit-model';
import { OwnerPeoplePicker, type OwnerRef } from '@/lib/dataproducts/owner-picker';
import { AttributeInput, type AttributeGroup, type AttributeValue } from '@/lib/dataproducts/attribute-input';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '540px' },
  steps: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', marginBottom: tokens.spacingVerticalXS },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap' },
  field: { flex: 1, minWidth: '200px' },
  attrGroup: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  endorseRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  hint: { color: tokens.colorNeutralForeground3, minWidth: 0 },
  // Long, dynamic strings (user-typed names, raw error text) must wrap rather
  // than force horizontal overflow inside the bounded dialog surface.
  wrap: { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },
  saveBar: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
    paddingTop: tokens.spacingVerticalS, borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
});

const STEP_ORDER: EditStep[] = ['basic', 'business', 'custom'];
const STEP_LABEL: Record<EditStep, string> = {
  basic: 'Basic', business: 'Business', custom: 'Custom attributes',
};

export interface DataProductEditDialogProps {
  /** The data-product id (also the Cosmos `dataproducts` doc id). */
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after any successful per-step save with the freshly-patched doc. */
  onSaved?: (updated: DataProductDoc) => void;
}

type SaveState = { kind: 'idle' | 'saving' | 'ok' | 'err' | 'conflict'; msg?: string };

export function DataProductEditDialog({ id, open, onOpenChange, onSaved }: DataProductEditDialogProps) {
  const s = useStyles();
  const [step, setStep] = useState<EditStep>('basic');

  // Loaded doc + the live ETag that each PATCH refreshes.
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [etag, setEtag] = useState('');

  // Editable form state (mirrors DataProductDoc's editable fields).
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState('');
  const [audience, setAudience] = useState<string[]>([]);
  const [owners, setOwners] = useState<OwnerRef[]>([]);
  const [endorsed, setEndorsed] = useState(false);
  const [governanceDomainId, setGovernanceDomainId] = useState('');
  const [useCase, setUseCase] = useState('');
  const [customAttributes, setCustomAttributes] = useState<Record<string, AttributeValue | number | null>>({});

  // Non-blocking duplicate-name warning (debounced).
  const [dupName, setDupName] = useState<string | null>(null);
  const dupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Governance-domain picker source.
  const [domains, setDomains] = useState<Array<{ id: string; name: string }>>([]);

  // DP-17 — typed custom-attribute schema (same source as the create wizard's
  // step 3), so the Custom step renders the control matching each fieldType.
  const [attrGroups, setAttrGroups] = useState<AttributeGroup[]>([]);
  const [attrGroupsNote, setAttrGroupsNote] = useState<string | undefined>();

  const [save, setSave] = useState<SaveState>({ kind: 'idle' });

  // ---- load on open --------------------------------------------------------
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setLoadErr(null); setSave({ kind: 'idle' }); setStep('basic'); setDupName(null);
    (async () => {
      try {
        const r = await clientFetch(`/api/data-products/${encodeURIComponent(id)}`);
        const j = await r.json();
        if (cancelled) return;
        if (!j.ok) {
          setLoadErr(r.status === 404
            ? `No marketplace data product exists for id '${id}'. Create one from the Data Marketplace before editing.`
            : (j.error || `HTTP ${r.status}`));
          return;
        }
        const d: DataProductDoc = j.doc;
        setName(d.name || '');
        setDescription(d.description || '');
        setType(d.type || '');
        setAudience(Array.isArray(d.audience) ? d.audience : []);
        // DP-17: bind the rich owner records the people-picker expects (a legacy
        // record may still surface a plain email string).
        setOwners((d.owners || []).map((o) =>
          typeof o === 'string'
            ? { id: o, upn: o, displayName: o }
            : { id: o.id || o.upn || o.displayName || '', upn: o.upn || '', displayName: o.displayName || o.upn || o.id || '' },
        ).filter((o) => o.id));
        setEndorsed(!!d.endorsed);
        setGovernanceDomainId(d.governanceDomainId || '');
        setUseCase(d.useCase || '');
        setCustomAttributes(d.customAttributes || {});
        // ETag header is authoritative; fall back to the body's _etag.
        setEtag(r.headers.get('etag') || d._etag || '');
      } catch (e: any) {
        if (!cancelled) setLoadErr(e?.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, id]);

  // ---- governance-domain picker -------------------------------------------
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await clientFetch('/api/admin/domains');
        const j = await r.json();
        if (!cancelled && j?.ok) setDomains((j.domains || []).map((d: any) => ({ id: d.id, name: d.name })));
      } catch { /* picker is best-effort; the field still accepts the current value */ }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // ---- typed custom-attribute schema (DP-17) -------------------------------
  // Load the attribute-group schema for the product's governance domain (the
  // same /api/attribute-groups source the create wizard uses) so the Custom
  // step renders Dropdown/DatePicker/Switch/number controls per fieldType.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const url = governanceDomainId
          ? `/api/attribute-groups?domainId=${encodeURIComponent(governanceDomainId)}`
          : '/api/attribute-groups';
        const r = await clientFetch(url);
        const j = await r.json();
        if (cancelled) return;
        if (j?.ok) { setAttrGroups(j.groups || []); setAttrGroupsNote(j.note); }
        else { setAttrGroups([]); setAttrGroupsNote(j?.error); }
      } catch (e: any) {
        if (!cancelled) { setAttrGroups([]); setAttrGroupsNote(e?.message || String(e)); }
      }
    })();
    return () => { cancelled = true; };
  }, [open, governanceDomainId]);

  // ---- debounced, non-blocking duplicate-name check ------------------------
  const onNameChange = useCallback((value: string) => {
    setName(value);
    if (dupTimer.current) clearTimeout(dupTimer.current);
    const trimmed = value.trim();
    if (!trimmed) { setDupName(null); return; }
    dupTimer.current = setTimeout(async () => {
      try {
        const r = await clientFetch(
          `/api/data-products?name=${encodeURIComponent(trimmed)}&excludeId=${encodeURIComponent(id)}`,
        );
        const j = await r.json();
        setDupName(j?.ok && j.duplicate ? trimmed : null);
      } catch { setDupName(null); }
    }, 500);
  }, [id]);

  useEffect(() => () => { if (dupTimer.current) clearTimeout(dupTimer.current); }, []);

  // ---- per-step Save (PATCH only this step's fields) -----------------------
  const saveStep = useCallback(async (which: EditStep) => {
    setSave({ kind: 'saving' });
    // Build the PATCH body from ONLY this step's fields (steps.ts contract).
    const fullState: Partial<DataProductDoc> = {
      name: name.trim(),
      description,
      type: type || undefined,
      audience,
      // DP-17: send the rich `{id,upn,displayName}` records the people-picker
      // resolved — no comma-parsing of a free-text string.
      owners,
      endorsed,
      governanceDomainId: governanceDomainId || undefined,
      useCase,
      customAttributes,
    };
    const patchBody = pickStepFields(which, fullState);
    try {
      const r = await clientFetch(`/api/data-products/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': etag },
        body: JSON.stringify(patchBody),
      });
      const j = await r.json();
      if (r.status === 409) {
        setSave({ kind: 'conflict', msg: j.error || 'document changed elsewhere' });
        return;
      }
      if (!j.ok) { setSave({ kind: 'err', msg: j.error || `HTTP ${r.status}` }); return; }
      setEtag(r.headers.get('etag') || j.doc?._etag || etag);
      setSave({ kind: 'ok', msg: `Saved ${STEP_LABEL[which]} (${(j.patched || []).join(', ')})` });
      if (onSaved && j.doc) onSaved(j.doc as DataProductDoc);
    } catch (e: any) {
      setSave({ kind: 'err', msg: e?.message || String(e) });
    }
  }, [name, description, type, audience, owners, endorsed, governanceDomainId, useCase, customAttributes, etag, id, onSaved]);

  const stepIndex = STEP_ORDER.indexOf(step);
  // DP-17 — the typed attribute schema for the domain, plus any legacy
  // customAttributes keys the schema doesn't cover (rendered as text so no
  // stored value is lost).
  const allAttrDefs = attrGroups.flatMap((g) => g.attributes);
  const coveredKeys = new Set(allAttrDefs.flatMap((a) => [a.id, a.name]));
  const orphanKeys = Object.keys(customAttributes).filter((k) => !coveredKeys.has(k));
  const hasAnyCustom = allAttrDefs.length > 0 || orphanKeys.length > 0;
  // Per-step validation (§7.5): Basic requires a name — can't save or advance
  // past an invalid step. Business/Custom have no required fields.
  const basicInvalid = !name.trim();
  const customEmpty = step === 'custom' && !hasAnyCustom;
  const saveDisabled = save.kind === 'saving' || customEmpty || (step === 'basic' && basicInvalid);
  const setAttr = (key: string, v: AttributeValue) => setCustomAttributes((prev) => ({ ...prev, [key]: v }));

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: 720 }}>
        <DialogBody>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
              <Edit20Regular />
              Edit data product
              {endorsed && <Badge appearance="tint" color="brand" size="small">Endorsed</Badge>}
            </span>
          </DialogTitle>
          <DialogContent>
            <div className={s.body}>
              <div className={s.steps}>
                {STEP_ORDER.map((st, i) => (
                  <Badge
                    key={st}
                    appearance={st === step ? 'filled' : 'outline'}
                    color={st === step ? 'brand' : 'informative'}
                    size="medium"
                    style={{ cursor: 'pointer' }}
                    onClick={() => setStep(st)}
                  >
                    {i + 1}. {STEP_LABEL[st]}
                  </Badge>
                ))}
              </div>

              {loading && <Spinner size="tiny" label="Loading data product…" />}
              {loadErr && (
                <MessageBar intent="error">
                  <MessageBarBody className={s.wrap}><MessageBarTitle>Cannot load</MessageBarTitle>{loadErr}</MessageBarBody>
                </MessageBar>
              )}

              {!loading && !loadErr && (
                <>
                  {/* ---------------- BASIC (F7 lives here) ---------------- */}
                  {step === 'basic' && (
                    <>
                      <Field
                        label="Name"
                        required
                        className={s.field}
                        validationState={basicInvalid ? 'error' : 'none'}
                        validationMessage={basicInvalid ? 'A name is required to save this step.' : undefined}
                      >
                        <Input value={name} onChange={(_, d) => onNameChange(d.value)} placeholder="Customer 360" />
                      </Field>
                      {dupName && (
                        <MessageBar intent="warning">
                          <MessageBarBody className={s.wrap}>
                            A data product named <strong>{dupName}</strong> already exists. Saving is still
                            allowed — names are not required to be unique.
                          </MessageBarBody>
                        </MessageBar>
                      )}
                      <Field label="Description">
                        <Textarea
                          value={description}
                          onChange={(_, d) => setDescription(d.value)}
                          rows={3}
                          maxLength={10000}
                          placeholder="What this data product provides and who it serves."
                        />
                      </Field>
                      <div className={s.row}>
                        <Field label="Type" className={s.field}>
                          <Select value={type} onChange={(_, d) => setType(d.value)}>
                            <option value="">(none)</option>
                            {DATA_PRODUCT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                          </Select>
                        </Field>
                        <Field label="Audience" className={s.field}>
                          <Dropdown
                            multiselect
                            placeholder="Select audiences"
                            selectedOptions={audience}
                            value={audience.join(', ')}
                            onOptionSelect={(_, d) => setAudience(d.selectedOptions)}
                          >
                            {DATA_PRODUCT_AUDIENCES.map((a) => <Option key={a} value={a} text={a}>{a}</Option>)}
                          </Dropdown>
                        </Field>
                      </div>
                      <OwnerPeoplePicker
                        owners={owners}
                        onChange={setOwners}
                        hint="Search your directory (Microsoft Graph) and add owners."
                      />
                      <div className={s.endorseRow}>
                        <Checkbox
                          checked={endorsed}
                          onChange={(_, d) => setEndorsed(d.checked === true)}
                          label="Endorsed — mark this data product as endorsed by the governance team."
                        />
                        {endorsed && <Badge appearance="tint" color="brand" size="small">Endorsed</Badge>}
                      </div>
                    </>
                  )}

                  {/* ---------------- BUSINESS ---------------- */}
                  {step === 'business' && (
                    <>
                      <Field label="Governance domain" className={s.field}>
                        <Dropdown
                          placeholder={domains.length ? 'Select a governance domain' : 'No domains defined — Admin › Domains'}
                          value={domains.find((d) => d.id === governanceDomainId)?.name || governanceDomainId}
                          selectedOptions={governanceDomainId ? [governanceDomainId] : []}
                          onOptionSelect={(_, d) => setGovernanceDomainId(d.optionValue || '')}
                        >
                          {domains.map((d) => <Option key={d.id} value={d.id} text={d.name}>{d.name}</Option>)}
                        </Dropdown>
                      </Field>
                      <Field label="Use case">
                        <Textarea
                          value={useCase}
                          onChange={(_, d) => setUseCase(d.value)}
                          rows={4}
                          placeholder="How consumers are expected to use this data product."
                        />
                      </Field>
                    </>
                  )}

                  {/* ---------------- CUSTOM ATTRIBUTES (typed, DP-17) ---------------- */}
                  {step === 'custom' && (
                    !hasAnyCustom ? (
                      <MessageBar intent="info">
                        <MessageBarBody>
                          <MessageBarTitle>No custom attribute groups defined</MessageBarTitle>
                          {attrGroupsNote || (
                            <>No attribute groups are configured for this governance domain yet. Define
                            required/optional attributes in <strong>Admin › Attribute Groups</strong>; they then
                            appear here as a typed form (Dropdown, date, switch, number) per field type.</>
                          )}
                        </MessageBarBody>
                      </MessageBar>
                    ) : (
                      <>
                        <Body1Strong>Custom attributes</Body1Strong>
                        {attrGroups.map((g) => (
                          <div key={g.id} className={s.attrGroup}>
                            <Caption1>{g.name}</Caption1>
                            {g.attributes.map((a) => {
                              const raw = customAttributes[a.id] ?? customAttributes[a.name];
                              const value: AttributeValue | undefined =
                                raw === null ? undefined : (raw as AttributeValue | undefined);
                              return (
                                <AttributeInput key={a.id} attr={a} value={value} onChange={(v) => setAttr(a.id, v)} />
                              );
                            })}
                          </div>
                        ))}
                        {/* Legacy values not covered by the current schema — kept editable so
                            saving never drops a stored attribute. */}
                        {orphanKeys.map((k) => (
                          <AttributeInput
                            key={k}
                            attr={{ id: k, name: k, fieldType: 'Text' }}
                            value={(customAttributes[k] === null ? undefined : customAttributes[k]) as AttributeValue | undefined}
                            onChange={(v) => setAttr(k, v)}
                          />
                        ))}
                      </>
                    )
                  )}

                  {/* ---------------- per-step Save bar ---------------- */}
                  <div className={s.saveBar}>
                    <Caption1 className={s.hint}>
                      Saving the <strong>{STEP_LABEL[step]}</strong> step PATCHes only its fields
                      ({(step === 'custom' && !hasAnyCustom) ? 'no editable fields' : 'leaving the other steps untouched'}).
                    </Caption1>
                    <Button
                      appearance="primary"
                      icon={<Save16Regular />}
                      onClick={() => saveStep(step)}
                      disabled={saveDisabled}
                    >
                      {save.kind === 'saving' ? 'Saving…' : `Save ${STEP_LABEL[step]}`}
                    </Button>
                  </div>

                  {save.kind === 'ok' && (
                    <MessageBar intent="success"><MessageBarBody className={s.wrap}>{save.msg}</MessageBarBody></MessageBar>
                  )}
                  {save.kind === 'err' && (
                    <MessageBar intent="error"><MessageBarBody className={s.wrap}><MessageBarTitle>Save failed</MessageBarTitle>{save.msg}</MessageBarBody></MessageBar>
                  )}
                  {save.kind === 'conflict' && (
                    <MessageBar intent="warning">
                      <MessageBarBody className={s.wrap}>
                        <MessageBarTitle>Document changed elsewhere</MessageBarTitle>
                        {save.msg} — close this dialog and re-open it to reload the latest version before editing again.
                      </MessageBarBody>
                    </MessageBar>
                  )}
                </>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
            <Button
              appearance="secondary"
              disabled={stepIndex <= 0}
              onClick={() => setStep(STEP_ORDER[Math.max(0, stepIndex - 1)])}
            >
              Back
            </Button>
            <Button
              appearance="secondary"
              disabled={stepIndex >= STEP_ORDER.length - 1 || (step === 'basic' && basicInvalid)}
              onClick={() => setStep(STEP_ORDER[Math.min(STEP_ORDER.length - 1, stepIndex + 1)])}
            >
              Next
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default DataProductEditDialog;
