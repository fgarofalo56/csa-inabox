'use client';

/**
 * WorkspaceCreateWizard — the multi-step "New workspace" create experience,
 * one-for-one with the Fabric "Create a workspace" pane (Basics → Contacts →
 * License mode → Capacity → Advanced/OneLake), with the Loom Fluent v9 theme.
 *
 * Source UI (Fabric): Workspaces → New workspace → Name/description, Contact
 * list, Advanced (License mode, Default storage format, Capacity/Domain).
 *   https://learn.microsoft.com/fabric/fundamentals/create-workspaces
 *
 * Real backend (no-vaporware): POST /api/admin/workspaces persists a Cosmos
 * workspace doc, best-effort binds a real Fabric/Power BI capacity, registers
 * the domain in Purview, and optionally provisions a dedicated Azure resource
 * group. The Azure-native default needs NO Fabric workspace
 * (no-fabric-dependency.md) — capacity is strictly optional, gated honestly
 * when the Fabric capacity API isn't authorized.
 *
 * Every config control is a dropdown / option-card / picker — no raw JSON
 * (loom_no_freeform_config). The only free-text fields are the workspace name,
 * description, and the backing-RG name suffix (a resource name, not a config key).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent,
  Title3, Subtitle2, Body1, Body1Strong, Caption1,
  Button, Input, Textarea, Dropdown, Option, Field, Checkbox, Badge,
  Spinner, Divider, Tag, TagGroup, mergeClasses,
  MessageBar, MessageBarBody, MessageBarTitle, Listbox,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Dismiss24Regular, ArrowLeft20Regular, ArrowRight20Regular,
  Checkmark16Filled, Search16Regular, Add16Regular,
  Building24Regular, Branch24Regular,
} from '@fluentui/react-icons';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import type { Workspace, WorkspaceLicenseMode } from '@/lib/types/workspace';

interface FabricCapacityOpt { id: string; displayName: string; sku: string; region?: string; state?: string; }
interface DomainOpt { id: string; name: string; }
interface StorageOpt { id: string; name: string; isHns: boolean; sku?: string; resourceGroup?: string; location?: string; }
interface PrincipalOpt { id: string; displayName: string; upn?: string; mail?: string; }

type StepKey = 'basics' | 'contacts' | 'license' | 'capacity' | 'advanced';

const STEPS: { key: StepKey; label: string; hint: string }[] = [
  { key: 'basics', label: 'Name & description', hint: 'What is this workspace' },
  { key: 'contacts', label: 'Contact list', hint: 'Workspace contacts' },
  { key: 'license', label: 'License mode', hint: 'How it is licensed' },
  { key: 'capacity', label: 'Capacity', hint: 'Optional compute binding' },
  { key: 'advanced', label: 'Advanced', hint: 'Domain, storage, RG' },
];

interface LicenseOption {
  value: WorkspaceLicenseMode; title: string; desc: string; govHidden?: boolean; needsCapacity?: boolean;
}
const LICENSE_OPTIONS: LicenseOption[] = [
  { value: 'Org', title: 'Organizational (Azure-native)', desc: 'Default — backed by Azure-native compute you already pay for. No Power BI / Fabric license required.' },
  { value: 'Pro', title: 'Power BI Pro', desc: 'User-based Power BI Pro licensing for report consumers.' },
  { value: 'PremiumPerUser', title: 'Premium Per User (PPU)', desc: 'Per-user premium features without a dedicated capacity.' },
  { value: 'Premium', title: 'Premium / Fabric capacity', desc: 'Dedicated Fabric / Power BI Premium capacity (select one in the next step).', needsCapacity: true },
  { value: 'Embedded', title: 'Power BI Embedded', desc: 'Azure Power BI Embedded (A-SKU) for app-embedded analytics.' },
  { value: 'Trial', title: 'Fabric Trial', desc: 'Fabric trial capacity (F64-equivalent, 60 days). Commercial only.', govHidden: true },
];

const useStyles = makeStyles({
  surface: { maxWidth: '920px', width: '92vw' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalM },
  grid: { display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', gap: tokens.spacingHorizontalXL, alignItems: 'start', marginTop: tokens.spacingVerticalM },
  rail: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  railItem: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium, border: '1px solid transparent',
    background: 'none', textAlign: 'left', width: '100%', cursor: 'default',
  },
  railItemClickable: { cursor: 'pointer', ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover } },
  railItemActive: { backgroundColor: tokens.colorNeutralBackground1, border: `1px solid ${tokens.colorNeutralStroke1}`, boxShadow: tokens.shadow2 },
  railBullet: {
    flexShrink: 0, width: '24px', height: '24px', borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold,
    border: `1px solid ${tokens.colorNeutralStroke2}`, color: tokens.colorNeutralForeground3,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  railBulletActive: { backgroundColor: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand, border: `1px solid ${tokens.colorBrandBackground}` },
  railBulletDone: { backgroundColor: tokens.colorPaletteGreenBackground3, color: tokens.colorNeutralForegroundOnBrand, border: `1px solid ${tokens.colorPaletteGreenBackground3}` },
  railText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  railLabel: { fontWeight: tokens.fontWeightSemibold },
  railHint: { color: tokens.colorNeutralForeground3 },
  panel: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  stepHeader: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  fields: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, maxWidth: '560px' },
  fieldsWide: { maxWidth: '620px' },
  tagWrap: { flexWrap: 'wrap' },
  flexGrow: { flex: 1 },
  optionStack: { display: 'flex', flexDirection: 'column' },
  optionCard: {
    display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'pointer', textAlign: 'left', width: '100%',
    ':hover': { border: `1px solid ${tokens.colorNeutralStroke1}`, boxShadow: tokens.shadow4 },
  },
  optionCardSelected: { border: `1px solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2, boxShadow: tokens.shadow4 },
  optionBody: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  optionTitleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  pickerRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end' },
  resultBox: { maxHeight: '180px', overflowY: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  reviewGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: tokens.spacingHorizontalL, rowGap: tokens.spacingVerticalM },
  reviewCell: { display: 'flex', flexDirection: 'column', gap: '2px' },
  footer: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalM },
  footerRight: { display: 'flex', gap: tokens.spacingHorizontalS, marginLeft: 'auto' },
});

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (ws: Workspace) => void;
  /** When true, POST to /api/admin/workspaces (admin plane). */
  isAdmin?: boolean;
}

export function WorkspaceCreateWizard({ open, onClose, onCreated, isAdmin }: Props) {
  const styles = useStyles();
  const gov = isGovCloud();

  const [step, setStep] = useState<StepKey>('basics');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [contacts, setContacts] = useState<string[]>([]);
  const [licenseMode, setLicenseMode] = useState<WorkspaceLicenseMode>('Org');
  const [capacity, setCapacity] = useState('');
  const [domain, setDomain] = useState('');
  const [storageAccountId, setStorageAccountId] = useState('');
  const [provisionBackingRg, setProvisionBackingRg] = useState(false);

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset all state whenever the wizard is (re)opened.
  useEffect(() => {
    if (open) {
      setStep('basics'); setName(''); setDescription(''); setContacts([]);
      setLicenseMode('Org'); setCapacity(''); setDomain(''); setStorageAccountId('');
      setProvisionBackingRg(false); setCreating(false); setError(null);
    }
  }, [open]);

  const stepIndex = STEPS.findIndex((s) => s.key === step);
  const licenseNeedsCapacity = LICENSE_OPTIONS.find((l) => l.value === licenseMode)?.needsCapacity === true;

  const isStepComplete = useCallback((k: StepKey): boolean => {
    switch (k) {
      case 'basics': return !!name.trim();
      case 'contacts': return true; // optional
      case 'license': return !!licenseMode;
      case 'capacity': return !licenseNeedsCapacity || !!capacity; // capacity required only for Premium-family
      case 'advanced': return !!domain; // a governance domain binding is REQUIRED (t158)
      default: return false;
    }
  }, [name, licenseMode, licenseNeedsCapacity, capacity, domain]);

  const canCreate = !!name.trim() && !!domain && (!licenseNeedsCapacity || !!capacity);

  const go = (k: StepKey) => setStep(k);
  const next = () => { const i = STEPS.findIndex((s) => s.key === step); if (i < STEPS.length - 1) setStep(STEPS[i + 1].key); };
  const back = () => { const i = STEPS.findIndex((s) => s.key === step); if (i > 0) setStep(STEPS[i - 1].key); };

  async function create() {
    setCreating(true); setError(null);
    try {
      const url = isAdmin ? '/api/admin/workspaces' : '/api/workspaces';
      const body = {
        name: name.trim(),
        description: description.trim() || undefined,
        contacts: contacts.length ? contacts : undefined,
        licenseMode,
        capacity: capacity || undefined,
        domain: domain || undefined,
        storageAccountId: storageAccountId || undefined,
        provisionBackingRg,
      };
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok || j?.ok === false) { setError(j?.error || `HTTP ${r.status}`); return; }
      // Admin route returns { ok, workspace }; user route returns the ws doc directly.
      const ws: Workspace = (j.workspace ?? j) as Workspace;
      onCreated(ws);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} modalType="modal" onOpenChange={(_e, d) => { if (!d.open) onClose(); }}>
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle action={<Button appearance="subtle" icon={<Dismiss24Regular />} aria-label="Close" onClick={onClose} />}>
            Create a workspace
          </DialogTitle>
          <DialogContent>
            <div className={styles.grid}>
              {/* Step rail */}
              <nav className={styles.rail} aria-label="Create workspace steps">
                {STEPS.map((s, i) => {
                  const done = isStepComplete(s.key) && i < stepIndex;
                  const active = s.key === step;
                  const reachable = i <= stepIndex || STEPS.slice(0, i).every((p) => isStepComplete(p.key));
                  return (
                    <button
                      key={s.key}
                      type="button"
                      className={mergeClasses(styles.railItem, reachable && styles.railItemClickable, active && styles.railItemActive)}
                      aria-current={active ? 'step' : undefined}
                      disabled={!reachable}
                      onClick={() => reachable && go(s.key)}
                    >
                      <span className={mergeClasses(styles.railBullet, active && styles.railBulletActive, done && styles.railBulletDone)} aria-hidden>
                        {done ? <Checkmark16Filled /> : i + 1}
                      </span>
                      <span className={styles.railText}>
                        <Caption1 className={styles.railLabel}>{s.label}</Caption1>
                        <Caption1 className={styles.railHint}>{s.hint}</Caption1>
                      </span>
                    </button>
                  );
                })}
              </nav>

              {/* Content panel */}
              <div className={styles.panel}>
                {error && (
                  <MessageBar intent="error">
                    <MessageBarBody><MessageBarTitle>Could not create workspace</MessageBarTitle>{error}</MessageBarBody>
                  </MessageBar>
                )}

                {step === 'basics' && (
                  <>
                    <div className={styles.stepHeader}>
                      <Subtitle2>Name &amp; description</Subtitle2>
                      <Body1>Give the workspace a clear name. The description helps collaborators understand its purpose.</Body1>
                    </div>
                    <div className={styles.fields}>
                      <Field label="Workspace name" required>
                        <Input value={name} onChange={(_e, d) => setName(d.value)} placeholder="e.g. Finance Analytics" />
                      </Field>
                      <Field label="Description">
                        <Textarea value={description} onChange={(_e, d) => setDescription(d.value)} rows={4} resize="vertical" placeholder="What this workspace is for…" />
                      </Field>
                    </div>
                  </>
                )}

                {step === 'contacts' && (
                  <ContactsStep contacts={contacts} onChange={setContacts} />
                )}

                {step === 'license' && (
                  <>
                    <div className={styles.stepHeader}>
                      <Subtitle2>License mode</Subtitle2>
                      <Body1>How is this workspace licensed? The Azure-native default needs no Power BI / Fabric license.</Body1>
                    </div>
                    <div className={mergeClasses(styles.fields, styles.fieldsWide)}>
                      {LICENSE_OPTIONS.filter((o) => !(o.govHidden && gov)).map((o) => {
                        const selected = licenseMode === o.value;
                        return (
                          <button
                            key={o.value} type="button" aria-pressed={selected}
                            className={mergeClasses(styles.optionCard, selected && styles.optionCardSelected)}
                            onClick={() => { setLicenseMode(o.value); if (!o.needsCapacity) { /* keep capacity, it stays optional */ } }}
                          >
                            <span className={styles.optionBody}>
                              <span className={styles.optionTitleRow}>
                                <Body1Strong>{o.title}</Body1Strong>
                                {o.value === 'Org' && <Badge appearance="tint" color="success" size="small">Default</Badge>}
                                {o.needsCapacity && <Badge appearance="tint" color="brand" size="small">Needs capacity</Badge>}
                              </span>
                              <Caption1 className={styles.railHint}>{o.desc}</Caption1>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}

                {step === 'capacity' && (
                  <CapacityStep
                    value={capacity}
                    onChange={setCapacity}
                    required={licenseNeedsCapacity}
                  />
                )}

                {step === 'advanced' && (
                  <>
                    <AdvancedStep
                      domain={domain} onDomain={setDomain}
                      storageAccountId={storageAccountId} onStorage={setStorageAccountId}
                      provisionBackingRg={provisionBackingRg} onProvisionBackingRg={setProvisionBackingRg}
                      name={name}
                    />
                    <Divider />
                    <div className={styles.stepHeader}>
                      <Subtitle2>Review</Subtitle2>
                    </div>
                    <div className={styles.reviewGrid}>
                      <ReviewCell label="Name" value={name || '—'} />
                      <ReviewCell label="License mode" value={LICENSE_OPTIONS.find((l) => l.value === licenseMode)?.title || licenseMode} />
                      <ReviewCell label="Contacts" value={contacts.length ? `${contacts.length} assigned` : 'Creator only'} />
                      <ReviewCell label="Capacity" value={capacity ? capacity.split('/').pop() || capacity : 'None (Azure-native)'} />
                      <ReviewCell label="Domain" value={domain || 'None'} />
                      <ReviewCell label="OneLake storage" value={storageAccountId ? (storageAccountId.split('/').pop() || 'Custom') : 'Deployment default'} />
                      <ReviewCell label="Backing resource group" value={provisionBackingRg ? 'Provision dedicated RG' : 'Shared'} />
                    </div>
                  </>
                )}

                {/* Footer */}
                <div className={styles.footer}>
                  <Button appearance="subtle" icon={<ArrowLeft20Regular />} onClick={step === 'basics' ? onClose : back}>
                    {step === 'basics' ? 'Cancel' : 'Back'}
                  </Button>
                  <div className={styles.footerRight}>
                    {step !== 'advanced' ? (
                      <Button
                        appearance="primary" icon={<ArrowRight20Regular />} iconPosition="after"
                        disabled={!isStepComplete(step)}
                        onClick={next}
                      >
                        Next
                      </Button>
                    ) : (
                      <Button appearance="primary" disabled={!canCreate || creating} onClick={create}>
                        {creating ? <Spinner size="tiny" /> : 'Create workspace'}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </DialogContent>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function ReviewCell({ label, value }: { label: string; value: string }) {
  const styles = useStyles();
  return (
    <div className={styles.reviewCell}>
      <Caption1 className={styles.railHint}>{label}</Caption1>
      <Body1Strong>{value}</Body1Strong>
    </div>
  );
}

// ============================================================
// Step: Contacts — Graph people picker → tag list
// ============================================================

function ContactsStep({ contacts, onChange }: { contacts: string[]; onChange: (v: string[]) => void }) {
  const styles = useStyles();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PrincipalOpt[]>([]);
  const [searching, setSearching] = useState(false);
  const [gate, setGate] = useState<string | null>(null);

  // Debounced Graph search.
  useEffect(() => {
    const term = q.trim();
    if (!term) { setResults([]); setGate(null); return; }
    const id = setTimeout(async () => {
      setSearching(true); setGate(null);
      try {
        const r = await fetch(`/api/admin/permissions/principals?q=${encodeURIComponent(term)}&kind=user`);
        const j = await r.json();
        if (r.status === 503 || j?.ok === false) {
          setGate(j?.remediation || j?.error || 'Microsoft Graph people search is not configured.');
          setResults([]);
        } else {
          setResults((j.results || []).map((p: any) => ({ id: p.id, displayName: p.displayName, upn: p.upn, mail: p.mail })));
        }
      } catch (e: any) {
        setGate(e?.message || String(e));
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(id);
  }, [q]);

  const add = (label: string) => {
    const v = label.trim();
    if (v && !contacts.includes(v)) onChange([...contacts, v]);
  };

  return (
    <>
      <div className={styles.stepHeader}>
        <Subtitle2>Contact list</Subtitle2>
        <Body1>Assign workspace contacts (admins / members beyond you). Search Entra users by name. This step is optional.</Body1>
      </div>
      <div className={styles.fields}>
        {contacts.length > 0 && (
          <Field label="Assigned contacts">
            <TagGroup onDismiss={(_e, d) => onChange(contacts.filter((c) => c !== d.value))} className={styles.tagWrap}>
              {contacts.map((c) => (
                <Tag key={c} value={c} dismissible dismissIcon={{ 'aria-label': `Remove ${c}` }}>{c}</Tag>
              ))}
            </TagGroup>
          </Field>
        )}
        <Field label="Search people">
          <div className={styles.pickerRow}>
            <Input className={styles.flexGrow} value={q} onChange={(_e, d) => setQ(d.value)} contentBefore={<Search16Regular />} placeholder="Start typing a name…" />
            {q.trim() && (
              <Button icon={<Add16Regular />} onClick={() => add(q)} title="Add the typed value as a contact">Add typed</Button>
            )}
          </div>
        </Field>
        {searching && <Spinner size="tiny" label="Searching Entra…" />}
        {gate && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>People search unavailable</MessageBarTitle>
              {gate} You can still type a UPN or group name and choose “Add typed”.
            </MessageBarBody>
          </MessageBar>
        )}
        {results.length > 0 && (
          <div className={styles.resultBox}>
            <Listbox>
              {results.map((p) => (
                <Option key={p.id} value={p.id} text={p.displayName} onClick={() => add(p.upn || p.mail || p.displayName)}>
                  <span className={styles.optionStack}>
                    <span>{p.displayName}</span>
                    {(p.upn || p.mail) && <Caption1 className={styles.railHint}>{p.upn || p.mail}</Caption1>}
                  </span>
                </Option>
              ))}
            </Listbox>
          </div>
        )}
      </div>
    </>
  );
}

// ============================================================
// Step: Capacity — real Fabric/Power BI capacities (gated)
// ============================================================

function CapacityStep({ value, onChange, required }: { value: string; onChange: (v: string) => void; required: boolean }) {
  const styles = useStyles();
  const [caps, setCaps] = useState<FabricCapacityOpt[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setGate(null);
      try {
        const r = await fetch('/api/admin/scaling/capacity');
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok || j?.ok === false) {
          setGate(j?.hint || j?.error || 'The Fabric capacity API is not available.');
          setCaps([]);
        } else {
          setCaps(j.capacities || []);
        }
      } catch (e: any) {
        if (!cancelled) { setGate(e?.message || String(e)); setCaps([]); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const selectedName = useMemo(() => caps?.find((c) => c.id === value)?.displayName, [caps, value]);

  return (
    <>
      <div className={styles.stepHeader}>
        <Subtitle2>Capacity</Subtitle2>
        <Body1>
          {required
            ? 'The selected license mode requires a dedicated Fabric / Power BI capacity.'
            : 'Optional. The Azure-native default needs no capacity — leave this blank and Loom binds one only if you later add a Power BI artifact.'}
        </Body1>
      </div>
      <div className={styles.fields}>
        {loading && <Spinner size="tiny" label="Listing capacities…" />}
        {!loading && gate && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Fabric capacity API not available</MessageBarTitle>
              {gate} Set LOOM_UAMI_CLIENT_ID and enable “Service principals can use Fabric APIs” in your Fabric tenant settings, or skip and assign capacity later.
            </MessageBarBody>
          </MessageBar>
        )}
        {!loading && caps && caps.length > 0 && (
          <Field label="Capacity" required={required}>
            <Dropdown
              placeholder="Select a capacity"
              value={selectedName || ''}
              selectedOptions={value ? [value] : []}
              onOptionSelect={(_e, d) => onChange(d.optionValue || '')}
            >
              <Option value="">None</Option>
              {caps.map((c) => (
                <Option key={c.id} value={c.id} text={c.displayName}>
                  {c.displayName} ({c.sku}){c.region ? ` — ${c.region}` : ''}{c.state ? ` · ${c.state}` : ''}
                </Option>
              ))}
            </Dropdown>
          </Field>
        )}
        {!loading && caps && caps.length === 0 && !gate && (
          <MessageBar intent="info">
            <MessageBarBody>No capacities are visible to the Console identity. The workspace will run on the Azure-native default.</MessageBarBody>
          </MessageBar>
        )}
      </div>
    </>
  );
}

// ============================================================
// Step: Advanced — domain, OneLake storage account, backing RG
// ============================================================

function AdvancedStep(props: {
  domain: string; onDomain: (v: string) => void;
  storageAccountId: string; onStorage: (v: string) => void;
  provisionBackingRg: boolean; onProvisionBackingRg: (v: boolean) => void;
  name: string;
}) {
  const styles = useStyles();
  const { domain, onDomain, storageAccountId, onStorage, provisionBackingRg, onProvisionBackingRg } = props;

  const [domains, setDomains] = useState<DomainOpt[] | null>(null);
  const [storage, setStorage] = useState<StorageOpt[] | null>(null);
  const [storageGate, setStorageGate] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/domains').then((r) => r.json())
      .then((j) => {
        const opts: DomainOpt[] = j?.ok ? (j.domains || []).map((d: any) => ({ id: d.id, name: d.name })) : [];
        setDomains(opts);
        // A domain binding is REQUIRED (t158). Preselect a sensible default so a
        // single-domain / legacy tenant isn't blocked: prefer the seeded
        // `default` domain, else the only domain when there's exactly one.
        if (!domain && opts.length) {
          const fallback = opts.find((d) => d.id === 'default') || (opts.length === 1 ? opts[0] : undefined);
          if (fallback) onDomain(fallback.id);
        }
      })
      .catch(() => setDomains([]));
    fetch('/api/storage/accounts').then((r) => r.json())
      .then((j) => {
        if (j?.ok && Array.isArray(j.accounts)) {
          setStorage(j.accounts.map((a: any) => ({ id: a.id, name: a.name, isHns: a.isHns, sku: a.sku, resourceGroup: a.resourceGroup, location: a.location })));
        } else { setStorage([]); setStorageGate(j?.hint || j?.error || 'Could not list storage accounts.'); }
      })
      .catch((e) => { setStorage([]); setStorageGate(String(e?.message || e)); });
  }, []);

  const domainName = useMemo(() => domains?.find((d) => d.id === domain)?.name, [domains, domain]);
  const storageName = useMemo(() => storage?.find((sx) => sx.id === storageAccountId)?.name, [storage, storageAccountId]);

  return (
    <>
      <div className={styles.stepHeader}>
        <Subtitle2>Advanced</Subtitle2>
        <Body1>Optionally place this workspace in a governance domain, bind a specific OneLake storage account, and provision a dedicated Azure resource group.</Body1>
      </div>
      <div className={styles.fields}>
        <Field label="Governance domain" required hint="Every workspace is bound to a governance domain — the unit Loom uses to organize the tenant's data estate and its Data Landing Zone.">
          <Dropdown
            placeholder={domains === null ? 'Loading…' : (domains.length ? 'Select a domain' : 'No domains defined')}
            disabled={domains === null}
            value={domainName || ''}
            selectedOptions={domain ? [domain] : []}
            onOptionSelect={(_e, d) => onDomain(d.optionValue || '')}
          >
            {(domains || []).map((d) => <Option key={d.id} value={d.id} text={d.name}>{d.name}</Option>)}
          </Dropdown>
        </Field>
        {domains !== null && domains.length === 0 && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>No governance domains exist yet</MessageBarTitle>
              Create one at Admin → Domains first. A workspace must belong to a domain.
            </MessageBarBody>
          </MessageBar>
        )}

        <Field label="OneLake storage account" hint="ADLS Gen2 account backing this workspace's OneLake files. Leave as default to use the deployment DLZ account.">
          {storageGate ? (
            <MessageBar intent="warning">
              <MessageBarBody>
                {storageGate} Grant the Console UAMI Reader on the subscription to list accounts; the deployment-default account is used otherwise.
              </MessageBarBody>
            </MessageBar>
          ) : (
            <Dropdown
              placeholder={storage === null ? 'Loading…' : 'Deployment default'}
              disabled={storage === null}
              value={storageName ? storageName : 'Deployment default'}
              selectedOptions={storageAccountId ? [storageAccountId] : ['']}
              onOptionSelect={(_e, d) => onStorage(d.optionValue || '')}
            >
              <Option value="">Deployment default</Option>
              {(storage || []).map((sx) => (
                <Option key={sx.id} value={sx.id} text={sx.name}>
                  {sx.name} ({sx.isHns ? 'ADLS Gen2' : 'Blob'}){sx.resourceGroup ? ` — ${sx.resourceGroup}` : ''}
                </Option>
              ))}
            </Dropdown>
          )}
        </Field>

        <Field>
          <Checkbox
            checked={provisionBackingRg}
            onChange={(_e, d) => onProvisionBackingRg(!!d.checked)}
            label="Provision a dedicated Azure resource group for this workspace"
          />
          <Caption1 className={styles.railHint}>
            Creates an Azure resource group via ARM (requires Contributor at subscription scope, already granted to the Console UAMI). The name is derived from the LOOM_WORKSPACE_RG_PREFIX prefix + the workspace id.
          </Caption1>
        </Field>
      </div>
    </>
  );
}

export default WorkspaceCreateWizard;
