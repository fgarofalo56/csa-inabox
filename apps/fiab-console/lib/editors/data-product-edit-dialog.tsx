'use client';

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

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 540 },
  steps: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 },
  row: { display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' },
  field: { flex: 1, minWidth: 200 },
  endorseRow: { display: 'flex', gap: 10, alignItems: 'center' },
  hint: { color: tokens.colorNeutralForeground3 },
  saveBar: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
    paddingTop: 6, borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
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
  const [owners, setOwners] = useState('');
  const [endorsed, setEndorsed] = useState(false);
  const [governanceDomainId, setGovernanceDomainId] = useState('');
  const [useCase, setUseCase] = useState('');
  const [customAttributes, setCustomAttributes] = useState<Record<string, string | number | boolean | null>>({});

  // Non-blocking duplicate-name warning (debounced).
  const [dupName, setDupName] = useState<string | null>(null);
  const dupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Governance-domain picker source.
  const [domains, setDomains] = useState<Array<{ id: string; name: string }>>([]);

  const [save, setSave] = useState<SaveState>({ kind: 'idle' });

  // ---- load on open --------------------------------------------------------
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setLoadErr(null); setSave({ kind: 'idle' }); setStep('basic'); setDupName(null);
    (async () => {
      try {
        const r = await fetch(`/api/data-products/${encodeURIComponent(id)}`);
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
        setOwners((d.owners || []).join(', '));
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
        const r = await fetch('/api/admin/domains');
        const j = await r.json();
        if (!cancelled && j?.ok) setDomains((j.domains || []).map((d: any) => ({ id: d.id, name: d.name })));
      } catch { /* picker is best-effort; the field still accepts the current value */ }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // ---- debounced, non-blocking duplicate-name check ------------------------
  const onNameChange = useCallback((value: string) => {
    setName(value);
    if (dupTimer.current) clearTimeout(dupTimer.current);
    const trimmed = value.trim();
    if (!trimmed) { setDupName(null); return; }
    dupTimer.current = setTimeout(async () => {
      try {
        const r = await fetch(
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
      owners: owners.split(',').map((o) => o.trim()).filter(Boolean),
      endorsed,
      governanceDomainId: governanceDomainId || undefined,
      useCase,
      customAttributes,
    };
    const patchBody = pickStepFields(which, fullState);
    try {
      const r = await fetch(`/api/data-products/${encodeURIComponent(id)}`, {
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
  const customKeys = Object.keys(customAttributes);

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: 720 }}>
        <DialogBody>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
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
                  <MessageBarBody><MessageBarTitle>Cannot load</MessageBarTitle>{loadErr}</MessageBarBody>
                </MessageBar>
              )}

              {!loading && !loadErr && (
                <>
                  {/* ---------------- BASIC (F7 lives here) ---------------- */}
                  {step === 'basic' && (
                    <>
                      <Field label="Name" required className={s.field}>
                        <Input value={name} onChange={(_, d) => onNameChange(d.value)} placeholder="Customer 360" />
                      </Field>
                      {dupName && (
                        <MessageBar intent="warning">
                          <MessageBarBody>
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
                      <Field label="Owners (comma-separated emails)">
                        <Input value={owners} onChange={(_, d) => setOwners(d.value)} placeholder="owner@contoso.com, lead@contoso.com" />
                      </Field>
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

                  {/* ---------------- CUSTOM ATTRIBUTES (honest gate) ---------------- */}
                  {step === 'custom' && (
                    customKeys.length === 0 ? (
                      <MessageBar intent="info">
                        <MessageBarBody>
                          <MessageBarTitle>No custom attribute groups defined</MessageBarTitle>
                          No attribute groups are configured for this governance domain yet. Define
                          required/optional attributes in <strong>Admin › Attribute Groups</strong>; they then
                          appear here as a typed form. (Attribute-group admin is tracked as Data Marketplace T15.)
                        </MessageBarBody>
                      </MessageBar>
                    ) : (
                      <>
                        <Body1Strong>Custom attributes</Body1Strong>
                        {customKeys.map((k) => (
                          <Field key={k} label={k} className={s.field}>
                            <Input
                              value={String(customAttributes[k] ?? '')}
                              onChange={(_, d) => setCustomAttributes((prev) => ({ ...prev, [k]: d.value }))}
                            />
                          </Field>
                        ))}
                      </>
                    )
                  )}

                  {/* ---------------- per-step Save bar ---------------- */}
                  <div className={s.saveBar}>
                    <Caption1 className={s.hint}>
                      Saving the <strong>{STEP_LABEL[step]}</strong> step PATCHes only its fields
                      ({(step === 'custom' && customKeys.length === 0) ? 'no editable fields' : 'leaving the other steps untouched'}).
                    </Caption1>
                    <Button
                      appearance="primary"
                      icon={<Save16Regular />}
                      onClick={() => saveStep(step)}
                      disabled={save.kind === 'saving' || (step === 'custom' && customKeys.length === 0)}
                    >
                      {save.kind === 'saving' ? 'Saving…' : `Save ${STEP_LABEL[step]}`}
                    </Button>
                  </div>

                  {save.kind === 'ok' && (
                    <MessageBar intent="success"><MessageBarBody>{save.msg}</MessageBarBody></MessageBar>
                  )}
                  {save.kind === 'err' && (
                    <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{save.msg}</MessageBarBody></MessageBar>
                  )}
                  {save.kind === 'conflict' && (
                    <MessageBar intent="warning">
                      <MessageBarBody>
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
              disabled={stepIndex >= STEP_ORDER.length - 1}
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
