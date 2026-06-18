'use client';

/**
 * DomainSettingsPane — the domain "Domain settings" side pane, one-for-one with
 * Fabric's 6-tab settings pane (General / Image / Admins / Contributors /
 * Default domain / Delegated). Opens as a Fluent Drawer from a row click on the
 * Domains list. Every tab's Apply button writes through PATCH /api/admin/domains
 * (real Cosmos write) — no static content, no dead controls.
 *
 * Source UI: Fabric admin portal -> Domains -> Domain settings side pane
 *   https://learn.microsoft.com/fabric/governance/domains#configure-domain-settings
 *
 * Subdomains (parentId set) get General settings only — matching Fabric, where
 * "Subdomains currently have general settings only."
 *
 * Backends per tab:
 *   General / Image / Admins / Contributors / Default domain -> PATCH Cosmos
 *   Delegated > default label -> GET /api/admin/security/mip/labels (Graph) or
 *                                 /api/admin/sensitivity-labels (Loom-native),
 *                                 persisted via PATCH delegatedSettings.
 *   Delegated > certification -> PATCH delegatedSettings.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  TabList, Tab, Button, Input, Textarea, Dropdown, Option, Checkbox,
  Spinner, Caption1, Body1, Subtitle2, Badge,
  TagGroup, Tag, Field,
  Accordion, AccordionItem, AccordionHeader, AccordionPanel,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Dismiss24Regular, Checkmark16Regular } from '@fluentui/react-icons';
import { DomainImageGallery } from '@/lib/components/domain-image-gallery';
import { DomainImageChip } from '@/lib/components/domain-image-presets';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import { AZURE_PUBLIC_REGIONS, AZURE_USGOV_REGIONS, type AzureRegion } from '@/lib/azure/azure-regions';

/** Capacity F-SKU set — kept in sync with domain-registry.VALID_CAPACITY_SKUS (server). */
const CAPACITY_SKUS = ['F2', 'F4', 'F8', 'F32', 'F64', 'F128', 'F512'] as const;
const DOMAIN_STATUS_COLOR: Record<string, 'brand' | 'success' | 'warning' | 'danger' | 'subtle'> = {
  registered: 'subtle', attaching: 'warning', active: 'success', detached: 'subtle', error: 'danger',
};

export interface DomainContributors {
  scope: 'AllTenant' | 'AdminsOnly' | 'SpecificUsersAndGroups';
  users?: string[];
}
export interface DomainDelegatedSettings {
  defaultSensitivityLabelId?: string;
  defaultSensitivityLabelName?: string;
  defaultSensitivityLabelSource?: 'mip' | 'loom';
  certificationEnabled?: boolean;
  certificationUrl?: string;
  certifiers?: string[];
}
export interface DomainRecord {
  id: string;
  name: string;
  description?: string;
  color?: string;
  /** Fluent icon name (lib/domains/domain-icons) — domain glyph. */
  icon?: string;
  /** Theme color (hex) paired with `icon`. */
  themeColor?: string;
  owners?: string[];
  admins?: string[];
  contributors?: DomainContributors;
  defaultDomainUsers?: string[];
  delegatedSettings?: DomainDelegatedSettings;
  imageKey?: string;
  parentId?: string;
  workspaceCount?: number;
  // DLZ binding / tenant topology (t158).
  subscriptionIds?: string[];
  dlzRg?: string;
  location?: string;
  capacitySku?: string;
  adminGroupId?: string;
  memberGroupId?: string;
  costCenter?: string;
  chargebackTag?: string;
  status?: 'registered' | 'attaching' | 'active' | 'detached' | 'error';
}

interface Props {
  domain: DomainRecord | null;
  /** True if the signed-in caller is a tenant/Fabric admin (vs domain admin). */
  isTenantAdmin: boolean;
  onClose: () => void;
  /** Called with the updated domain after any successful Apply. */
  onSaved: (updated: DomainRecord) => void;
}

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, paddingTop: tokens.spacingVerticalM },
  tabPanel: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, paddingTop: tokens.spacingVerticalM },
  applyRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', marginTop: tokens.spacingVerticalS },
  note: { color: tokens.colorNeutralForeground3, fontSize: '12px', lineHeight: 1.5 },
  tagAdd: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end' },
  previewRow: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center' },
  scrollResults: {
    maxHeight: '180px', overflowY: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium, marginTop: tokens.spacingVerticalXS,
  },
  resultRow: {
    display: 'flex', flexDirection: 'column', gap: '2px', width: '100%', textAlign: 'left',
    padding: '6px 8px', border: 'none', background: 'none', cursor: 'pointer',
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  invTable: { display: 'flex', flexDirection: 'column', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, overflow: 'hidden' },
  invHead: {
    display: 'grid', gridTemplateColumns: '1.4fr 1.6fr 1.2fr 0.8fr', gap: tokens.spacingHorizontalS,
    padding: '6px 8px', fontWeight: tokens.fontWeightSemibold, backgroundColor: tokens.colorNeutralBackground2,
    fontSize: tokens.fontSizeBase200,
  },
  invRow: {
    display: 'grid', gridTemplateColumns: '1.4fr 1.6fr 1.2fr 0.8fr', gap: tokens.spacingHorizontalS,
    padding: '6px 8px', borderTop: `1px solid ${tokens.colorNeutralStroke3}`, fontSize: tokens.fontSizeBase200,
    alignItems: 'center', wordBreak: 'break-word',
  },
  // Shared layout primitives (tokenized; replaces residual inline styles).
  flexGrow: { flex: 1 },
  tagWrap: { flexWrap: 'wrap' },
  tagWrapSpaced: { flexWrap: 'wrap', marginBottom: tokens.spacingVerticalS },
  tagSpaced: { marginBottom: tokens.spacingVerticalXS },
  sectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  sectionHeadSpaced: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalM },
  labelSwatch: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  swatch: { width: '12px', height: '12px', borderRadius: tokens.borderRadiusSmall, display: 'inline-block' },
});

type TabKey = 'general' | 'image' | 'admins' | 'contributors' | 'default-domain' | 'delegated' | 'topology';

export function DomainSettingsPane({ domain, isTenantAdmin, onClose, onSaved }: Props) {
  const styles = useStyles();
  const [tab, setTab] = useState<TabKey>('general');
  const isSubdomain = !!domain?.parentId;

  // Reset to General whenever a new domain is opened.
  useEffect(() => { setTab('general'); }, [domain?.id]);

  if (!domain) return null;

  const title = isSubdomain ? `Subdomain settings — ${domain.name}` : `Domain settings — ${domain.name}`;

  return (
    <Drawer open onOpenChange={(_, d) => { if (!d.open) onClose(); }} position="end" size="medium">
      <DrawerHeader>
        <DrawerHeaderTitle
          action={<Button appearance="subtle" icon={<Dismiss24Regular />} onClick={onClose} aria-label="Close" />}
        >
          {title}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <div className={styles.body}>
          <TabList selectedValue={tab} onTabSelect={(_e, d) => setTab(d.value as TabKey)} size="small">
            <Tab value="general">General</Tab>
            {!isSubdomain && <Tab value="image">Image</Tab>}
            {!isSubdomain && <Tab value="admins">Admins</Tab>}
            {!isSubdomain && <Tab value="contributors">Contributors</Tab>}
            {!isSubdomain && <Tab value="default-domain">Default domain</Tab>}
            {!isSubdomain && <Tab value="delegated">Delegated</Tab>}
            {!isSubdomain && <Tab value="topology">Landing zone</Tab>}
          </TabList>

          {tab === 'general' && <GeneralTab domain={domain} isTenantAdmin={isTenantAdmin} onSaved={onSaved} />}
          {tab === 'image' && !isSubdomain && <ImageTab domain={domain} onSaved={onSaved} />}
          {tab === 'admins' && !isSubdomain && <AdminsTab domain={domain} isTenantAdmin={isTenantAdmin} onSaved={onSaved} />}
          {tab === 'contributors' && !isSubdomain && <ContributorsTab domain={domain} onSaved={onSaved} />}
          {tab === 'default-domain' && !isSubdomain && <DefaultDomainTab domain={domain} onSaved={onSaved} />}
          {tab === 'delegated' && !isSubdomain && <DelegatedTab domain={domain} onSaved={onSaved} />}
          {tab === 'topology' && !isSubdomain && <TopologyTab domain={domain} isTenantAdmin={isTenantAdmin} onSaved={onSaved} />}
        </div>
      </DrawerBody>
    </Drawer>
  );
}

// ============================================================
// Shared helpers
// ============================================================

async function patchDomain(id: string, patch: Record<string, unknown>): Promise<DomainRecord> {
  const r = await fetch(`/api/admin/domains?id=${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j.domain as DomainRecord;
}

function ApplyButton({ busy, error, onApply, disabled }: {
  busy: boolean; error: string | null; onApply: () => void; disabled?: boolean;
}) {
  const styles = useStyles();
  return (
    <>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      <div className={styles.applyRow}>
        <Button appearance="primary" onClick={onApply} disabled={busy || disabled}>
          {busy ? <Spinner size="tiny" /> : 'Apply'}
        </Button>
      </div>
    </>
  );
}

/** A TagGroup of UPNs/groups with an Input+Add affordance (Fabric people picker parity). */
function TagListEditor({ label, values, onChange, placeholder, disabled }: {
  label: string; values: string[]; onChange: (v: string[]) => void; placeholder?: string; disabled?: boolean;
}) {
  const styles = useStyles();
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (!values.includes(v)) onChange([...values, v]);
    setDraft('');
  };
  return (
    <Field label={label}>
      {values.length > 0 && (
        <TagGroup
          onDismiss={(_e, d) => onChange(values.filter((v) => v !== d.value))}
          className={styles.tagWrapSpaced}
          aria-label={label}
        >
          {values.map((v) => (
            <Tag key={v} value={v} dismissible dismissIcon={{ 'aria-label': `Remove ${v}` }}>{v}</Tag>
          ))}
        </TagGroup>
      )}
      <div className={styles.tagAdd}>
        <Input
          className={styles.flexGrow}
          value={draft}
          disabled={disabled}
          placeholder={placeholder || 'name@contoso.com or a group name'}
          onChange={(_e, d) => setDraft(d.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        />
        <Button onClick={add} disabled={disabled || !draft.trim()} icon={<Checkmark16Regular />}>Add</Button>
      </div>
    </Field>
  );
}

// ============================================================
// General
// ============================================================

function GeneralTab({ domain, isTenantAdmin, onSaved }: { domain: DomainRecord; isTenantAdmin: boolean; onSaved: (d: DomainRecord) => void }) {
  const styles = useStyles();
  const [name, setName] = useState(domain.name);
  const [description, setDescription] = useState(domain.description || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setName(domain.name); setDescription(domain.description || ''); }, [domain.id]);

  const apply = async () => {
    setBusy(true); setErr(null);
    try {
      // Domain admins can only change the description (Fabric rule) — so only
      // send `name` when the caller is a tenant admin.
      const patch: Record<string, unknown> = { description };
      if (isTenantAdmin) patch.name = name;
      onSaved(await patchDomain(domain.id, patch));
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className={styles.tabPanel}>
      <Field label="Name">
        <Input value={name} disabled={!isTenantAdmin} onChange={(_e, d) => setName(d.value)} />
      </Field>
      {!isTenantAdmin && (
        <Caption1 className={styles.note}>
          Domain admins can edit the description only. Renaming a domain requires a tenant admin.
        </Caption1>
      )}
      <Field label="Description">
        <Textarea value={description} resize="vertical" rows={4} onChange={(_e, d) => setDescription(d.value)} />
      </Field>
      <ApplyButton busy={busy} error={err} onApply={apply} disabled={isTenantAdmin && !name.trim()} />
    </div>
  );
}

// ============================================================
// Image
// ============================================================

function ImageTab({ domain, onSaved }: { domain: DomainRecord; onSaved: (d: DomainRecord) => void }) {
  const styles = useStyles();
  const [imageKey, setImageKey] = useState(domain.imageKey || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setImageKey(domain.imageKey || ''); }, [domain.id]);

  const apply = async () => {
    setBusy(true); setErr(null);
    try { onSaved(await patchDomain(domain.id, { imageKey })); }
    catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className={styles.tabPanel}>
      <Body1>Choose an image or color to represent this domain in the catalog domain selector.</Body1>
      <div className={styles.previewRow}>
        <DomainImageChip imageKey={imageKey} icon={domain.icon} themeColor={domain.themeColor} fallbackColor={domain.color} size={64} />
        <Caption1 className={styles.note}>Current selection preview</Caption1>
      </div>
      <DomainImageGallery value={imageKey} onChange={setImageKey} />
      <ApplyButton busy={busy} error={err} onApply={apply} />
    </div>
  );
}

// ============================================================
// Admins
// ============================================================

function AdminsTab({ domain, isTenantAdmin, onSaved }: { domain: DomainRecord; isTenantAdmin: boolean; onSaved: (d: DomainRecord) => void }) {
  const styles = useStyles();
  const [admins, setAdmins] = useState<string[]>(domain.admins || []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setAdmins(domain.admins || []); }, [domain.id]);

  const apply = async () => {
    setBusy(true); setErr(null);
    try { onSaved(await patchDomain(domain.id, { admins })); }
    catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className={styles.tabPanel}>
      <Body1>Specify who can change domain settings and add or remove workspaces.</Body1>
      {!isTenantAdmin && (
        <MessageBar intent="info">
          <MessageBarBody>
            Only a tenant (Fabric) admin can change the domain admin list. You can view it here.
          </MessageBarBody>
        </MessageBar>
      )}
      <TagListEditor label="Domain admins" values={admins} onChange={setAdmins} disabled={!isTenantAdmin} />
      <ApplyButton busy={busy} error={err} onApply={apply} disabled={!isTenantAdmin} />
    </div>
  );
}

// ============================================================
// Contributors
// ============================================================

const CONTRIB_SCOPES: { key: DomainContributors['scope']; label: string; desc: string }[] = [
  { key: 'AllTenant', label: 'Everyone in the organization (default)', desc: 'Any workspace admin can assign their workspaces to this domain.' },
  { key: 'AdminsOnly', label: 'Only tenant admins and domain admins', desc: 'Only tenant admins and this domain’s admins can assign workspaces.' },
  { key: 'SpecificUsersAndGroups', label: 'Specific users and groups', desc: 'Only the listed users/groups (and domain admins) can assign workspaces.' },
];

function ContributorsTab({ domain, onSaved }: { domain: DomainRecord; onSaved: (d: DomainRecord) => void }) {
  const styles = useStyles();
  const [scope, setScope] = useState<DomainContributors['scope']>(domain.contributors?.scope || 'AllTenant');
  const [users, setUsers] = useState<string[]>(domain.contributors?.users || []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setScope(domain.contributors?.scope || 'AllTenant');
    setUsers(domain.contributors?.users || []);
  }, [domain.id]);

  const apply = async () => {
    setBusy(true); setErr(null);
    try {
      onSaved(await patchDomain(domain.id, {
        contributors: { scope, users: scope === 'SpecificUsersAndGroups' ? users : undefined },
      }));
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const active = CONTRIB_SCOPES.find((s) => s.key === scope);

  return (
    <div className={styles.tabPanel}>
      <Body1>Specify who can assign workspaces to this domain.</Body1>
      <Field label="Who can assign workspaces">
        <Dropdown
          selectedOptions={[scope]}
          value={active?.label || ''}
          onOptionSelect={(_e, d) => setScope(d.optionValue as DomainContributors['scope'])}
        >
          {CONTRIB_SCOPES.map((s) => <Option key={s.key} value={s.key}>{s.label}</Option>)}
        </Dropdown>
      </Field>
      {active && <Caption1 className={styles.note}>{active.desc}</Caption1>}
      {scope === 'SpecificUsersAndGroups' && (
        <TagListEditor label="Allowed users and groups" values={users} onChange={setUsers} />
      )}
      <ApplyButton busy={busy} error={err} onApply={apply} />
    </div>
  );
}

// ============================================================
// Default domain
// ============================================================

function DefaultDomainTab({ domain, onSaved }: { domain: DomainRecord; onSaved: (d: DomainRecord) => void }) {
  const styles = useStyles();
  const [users, setUsers] = useState<string[]>(domain.defaultDomainUsers || []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setUsers(domain.defaultDomainUsers || []); }, [domain.id]);

  const apply = async () => {
    setBusy(true); setErr(null);
    try { onSaved(await patchDomain(domain.id, { defaultDomainUsers: users })); }
    catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className={styles.tabPanel}>
      <Body1>
        When you add people to the default domain list, unassigned workspaces they&apos;re admins of, and new
        workspaces they create, will automatically be assigned to this domain.
      </Body1>
      <Caption1 className={styles.note}>
        Specified users / group members generally automatically become domain contributors of workspaces
        assigned via this mechanism. Workspaces already assigned to another domain are preserved (not overridden).
      </Caption1>
      <TagListEditor label="Default-domain users and groups" values={users} onChange={setUsers} />
      <ApplyButton busy={busy} error={err} onApply={apply} />
    </div>
  );
}

// ============================================================
// Delegated settings
// ============================================================

interface LabelOption { id: string; name: string; color?: string; }

function DelegatedTab({ domain, onSaved }: { domain: DomainRecord; onSaved: (d: DomainRecord) => void }) {
  const styles = useStyles();
  const ds = domain.delegatedSettings || {};

  // Information-protection: default sensitivity label.
  const [labelId, setLabelId] = useState(ds.defaultSensitivityLabelId || '');
  const [labelSource, setLabelSource] = useState<'mip' | 'loom'>(ds.defaultSensitivityLabelSource || 'mip');
  const [mip, setMip] = useState<{ status: 'loading' | 'ok' | 'gated' | 'error'; labels: LabelOption[]; hint?: string }>({ status: 'loading', labels: [] });
  const [loomLabels, setLoomLabels] = useState<LabelOption[]>([]);
  const [ipBusy, setIpBusy] = useState(false);
  const [ipErr, setIpErr] = useState<string | null>(null);

  // Certification.
  const [override, setOverride] = useState<boolean>(ds.certificationEnabled !== undefined || !!ds.certificationUrl || !!(ds.certifiers && ds.certifiers.length));
  const [certEnabled, setCertEnabled] = useState<boolean>(!!ds.certificationEnabled);
  const [certUrl, setCertUrl] = useState(ds.certificationUrl || '');
  const [certifiers, setCertifiers] = useState<string[]>(ds.certifiers || []);
  const [certBusy, setCertBusy] = useState(false);
  const [certErr, setCertErr] = useState<string | null>(null);

  useEffect(() => {
    const d = domain.delegatedSettings || {};
    setLabelId(d.defaultSensitivityLabelId || '');
    setLabelSource(d.defaultSensitivityLabelSource || 'mip');
    setOverride(d.certificationEnabled !== undefined || !!d.certificationUrl || !!(d.certifiers && d.certifiers.length));
    setCertEnabled(!!d.certificationEnabled);
    setCertUrl(d.certificationUrl || '');
    setCertifiers(d.certifiers || []);
  }, [domain.id]);

  // Load MIP labels (and Loom-native labels as a fallback) on mount.
  const loadLabels = useCallback(() => {
    setMip({ status: 'loading', labels: [] });
    fetch('/api/admin/security/mip/labels')
      .then(async (r) => {
        const j = await r.json();
        if (r.ok && j.ok) {
          setMip({ status: 'ok', labels: (j.labels || []).map((l: any) => ({ id: l.id, name: l.name || l.displayName, color: l.color })) });
        } else if (r.status === 503) {
          setMip({ status: 'gated', labels: [], hint: j?.hint?.followUp || j?.error || 'Microsoft Information Protection is not configured.' });
        } else {
          setMip({ status: 'error', labels: [], hint: j?.error || `HTTP ${r.status}` });
        }
      })
      .catch((e) => setMip({ status: 'error', labels: [], hint: String(e) }));
    // Loom-native labels (always Cosmos-backed) — offered as a fallback source.
    fetch('/api/admin/sensitivity-labels')
      .then((r) => r.json())
      .then((j) => { if (j.ok) setLoomLabels((j.labels || []).map((l: any) => ({ id: l.id, name: l.name, color: l.color }))); })
      .catch(() => {});
  }, []);
  useEffect(() => { loadLabels(); }, [loadLabels]);

  const labelOptions = labelSource === 'mip' ? mip.labels : loomLabels;
  const selectedLabel = labelOptions.find((l) => l.id === labelId);

  const applyIp = async () => {
    setIpBusy(true); setIpErr(null);
    try {
      onSaved(await patchDomain(domain.id, {
        delegatedSettings: {
          defaultSensitivityLabelId: labelId || '',
          defaultSensitivityLabelName: selectedLabel?.name || '',
          defaultSensitivityLabelSource: labelSource,
        },
      }));
    } catch (e: any) { setIpErr(e?.message || String(e)); }
    finally { setIpBusy(false); }
  };

  const applyCert = async () => {
    setCertBusy(true); setCertErr(null);
    try {
      onSaved(await patchDomain(domain.id, {
        delegatedSettings: override
          ? { certificationEnabled: certEnabled, certificationUrl: certUrl, certifiers }
          : { certificationEnabled: false, certificationUrl: '', certifiers: [] },
      }));
    } catch (e: any) { setCertErr(e?.message || String(e)); }
    finally { setCertBusy(false); }
  };

  return (
    <div className={styles.tabPanel}>
      <Body1>Override tenant-level settings at the domain level.</Body1>
      <Accordion multiple collapsible defaultOpenItems={['ip']}>
        <AccordionItem value="ip">
          <AccordionHeader>Information protection</AccordionHeader>
          <AccordionPanel>
            <div className={styles.tabPanel}>
              <Subtitle2>Set a default label for this domain</Subtitle2>
              <Caption1 className={styles.note}>
                The label is applied by default to items in workspaces assigned to this domain (per the
                domain-level default label logic).
              </Caption1>

              {mip.status === 'loading' && <Spinner size="tiny" label="Loading sensitivity labels…" />}

              {mip.status === 'gated' && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Microsoft Information Protection not configured</MessageBarTitle>
                    {mip.hint} You can still set a Loom-native label below (not enforced at the M365 layer).
                  </MessageBarBody>
                </MessageBar>
              )}
              {mip.status === 'error' && (
                <MessageBar intent="error">
                  <MessageBarBody>
                    <MessageBarTitle>Couldn&apos;t load MIP labels</MessageBarTitle>
                    {mip.hint}
                  </MessageBarBody>
                </MessageBar>
              )}

              <Field label="Label source">
                <Dropdown
                  selectedOptions={[labelSource]}
                  value={labelSource === 'mip' ? 'Microsoft Purview (MIP)' : 'Loom-native labels'}
                  onOptionSelect={(_e, d) => { setLabelSource(d.optionValue as 'mip' | 'loom'); setLabelId(''); }}
                >
                  <Option value="mip" disabled={mip.status !== 'ok'}>{`Microsoft Purview (MIP)${mip.status !== 'ok' ? ' — not configured' : ''}`}</Option>
                  <Option value="loom">Loom-native labels</Option>
                </Dropdown>
              </Field>

              <Field label="Default sensitivity label">
                <Dropdown
                  placeholder={labelOptions.length ? 'Select a label' : 'No labels available'}
                  selectedOptions={labelId ? [labelId] : []}
                  value={selectedLabel?.name || ''}
                  onOptionSelect={(_e, d) => setLabelId(d.optionValue || '')}
                  disabled={labelOptions.length === 0}
                >
                  <Option value="">(None)</Option>
                  {labelOptions.map((l) => (
                    <Option key={l.id} value={l.id} text={l.name}>
                      <span className={styles.labelSwatch}>
                        {l.color && <span className={styles.swatch} style={{ backgroundColor: l.color }} />}
                        {l.name}
                      </span>
                    </Option>
                  ))}
                </Dropdown>
              </Field>
              {labelSource === 'loom' && (
                <Caption1 className={styles.note}>
                  Loom-native labels are stored in Loom and surfaced in governance views, but are not enforced
                  by Microsoft 365 / Purview. Configure MIP to enforce at the M365 layer.
                </Caption1>
              )}
              <ApplyButton busy={ipBusy} error={ipErr} onApply={applyIp} />
            </div>
          </AccordionPanel>
        </AccordionItem>

        <AccordionItem value="cert">
          <AccordionHeader>Certification</AccordionHeader>
          <AccordionPanel>
            <div className={styles.tabPanel}>
              <Caption1 className={styles.note}>
                Certification is a way for organizations to label items they consider quality items. Override
                the tenant-level certification settings for this domain below.
              </Caption1>
              <Checkbox
                checked={override}
                onChange={(_e, d) => setOverride(!!d.checked)}
                label="Override tenant admin selection"
              />
              {override && (
                <>
                  <Checkbox
                    checked={certEnabled}
                    onChange={(_e, d) => setCertEnabled(!!d.checked)}
                    label="Enable certification for this domain"
                  />
                  <Field label="Certification documentation URL">
                    <Input
                      value={certUrl}
                      placeholder="https://contoso.sharepoint.com/governance/certification"
                      onChange={(_e, d) => setCertUrl(d.value)}
                    />
                  </Field>
                  <TagListEditor label="Certifiers (domain experts)" values={certifiers} onChange={setCertifiers} />
                </>
              )}
              <ApplyButton busy={certBusy} error={certErr} onApply={applyCert} />
            </div>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>

      {ds.defaultSensitivityLabelName && (
        <Badge appearance="tint" color="brand">Default label: {ds.defaultSensitivityLabelName}</Badge>
      )}
    </div>
  );
}

// ============================================================
// Single Entra security-group picker (debounced Graph search)
// ============================================================

function GroupPicker({ label, value, onChange, disabled }: {
  label: string; value: string; onChange: (id: string) => void; disabled?: boolean;
}) {
  const styles = useStyles();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Array<{ id: string; displayName: string; mail?: string }>>([]);
  const [searching, setSearching] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [chosenName, setChosenName] = useState<string>('');

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults([]); setGate(null); return; }
    const t = setTimeout(async () => {
      setSearching(true); setGate(null);
      try {
        const r = await fetch(`/api/admin/permissions/principals?q=${encodeURIComponent(term)}&kind=group`);
        const j = await r.json();
        if (r.status === 503 || j?.ok === false) {
          setGate(j?.remediation || j?.error || 'Microsoft Graph group search is not configured.');
          setResults([]);
        } else {
          setResults((j.results || []).map((p: any) => ({ id: p.id, displayName: p.displayName, mail: p.mail })));
        }
      } catch (e: any) { setGate(e?.message || String(e)); }
      finally { setSearching(false); }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <Field label={label}>
      {value ? (
        <TagGroup onDismiss={() => { onChange(''); setChosenName(''); }} className={styles.tagSpaced} aria-label={label}>
          <Tag value={value} dismissible dismissIcon={{ 'aria-label': 'Remove group' }}>
            {chosenName || value}
          </Tag>
        </TagGroup>
      ) : (
        <Input
          value={q}
          disabled={disabled}
          placeholder="Search Entra security groups…"
          onChange={(_e, d) => setQ(d.value)}
        />
      )}
      {searching && <Spinner size="tiny" label="Searching Entra…" />}
      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>{gate}</MessageBarBody>
        </MessageBar>
      )}
      {!value && results.length > 0 && (
        <div className={styles.scrollResults}>
          {results.map((g) => (
            <button
              key={g.id}
              type="button"
              className={styles.resultRow}
              onClick={() => { onChange(g.id); setChosenName(g.displayName); setQ(''); setResults([]); }}
            >
              <span>{g.displayName}</span>
              {g.mail && <Caption1 className={styles.note}>{g.mail}</Caption1>}
            </button>
          ))}
        </div>
      )}
    </Field>
  );
}

// ============================================================
// Landing zone (DLZ binding) tab — t158 tenant topology
// ============================================================

interface InventoryResource {
  name: string; type: string; resourceGroup: string; location: string; subscriptionId: string;
}

function TopologyTab({ domain, isTenantAdmin, onSaved }: {
  domain: DomainRecord; isTenantAdmin: boolean; onSaved: (d: DomainRecord) => void;
}) {
  const styles = useStyles();
  const regions: AzureRegion[] = isGovCloud() ? AZURE_USGOV_REGIONS : AZURE_PUBLIC_REGIONS;

  const [location, setLocation] = useState(domain.location || '');
  const [capacitySku, setCapacitySku] = useState(domain.capacitySku || '');
  const [adminGroupId, setAdminGroupId] = useState(domain.adminGroupId || '');
  const [memberGroupId, setMemberGroupId] = useState(domain.memberGroupId || '');
  const [costCenter, setCostCenter] = useState(domain.costCenter || '');
  const [status, setStatus] = useState(domain.status || 'registered');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Inventory.
  const [inv, setInv] = useState<InventoryResource[] | null>(null);
  const [invLoading, setInvLoading] = useState(false);
  const [invGate, setInvGate] = useState<string | null>(null);
  const [invBound, setInvBound] = useState(true);

  useEffect(() => {
    setLocation(domain.location || ''); setCapacitySku(domain.capacitySku || '');
    setAdminGroupId(domain.adminGroupId || ''); setMemberGroupId(domain.memberGroupId || '');
    setCostCenter(domain.costCenter || ''); setStatus(domain.status || 'registered');
  }, [domain.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadInventory = useCallback(async () => {
    setInvLoading(true); setInvGate(null);
    try {
      const r = await fetch(`/api/admin/domains/${encodeURIComponent(domain.id)}/inventory`);
      const j = await r.json();
      if (!j.ok) { setInvGate(j.remediation || j.hint || j.error || `HTTP ${r.status}`); setInv([]); return; }
      setInvBound(j.bound !== false);
      setInv(j.resources || []);
      if (j.bound === false && j.hint) setInvGate(j.hint);
    } catch (e: any) { setInvGate(e?.message || String(e)); setInv([]); }
    finally { setInvLoading(false); }
  }, [domain.id]);

  useEffect(() => { loadInventory(); }, [loadInventory]);

  const apply = async () => {
    setBusy(true); setErr(null);
    try {
      onSaved(await patchDomain(domain.id, {
        location: location || null,
        capacitySku: capacitySku || null,
        adminGroupId: adminGroupId || null,
        memberGroupId: memberGroupId || null,
        costCenter: costCenter || null,
        status,
      }));
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const subs = domain.subscriptionIds || [];

  return (
    <div className={styles.tabPanel}>
      <div className={styles.sectionHead}>
        <Subtitle2>Data Landing Zone binding</Subtitle2>
        <Badge appearance="tint" color={DOMAIN_STATUS_COLOR[status] || 'subtle'}>{status}</Badge>
      </div>
      <Caption1 className={styles.note}>
        Binds this domain to its Data Landing Zone — the subscription(s), resource group, region, and capacity it
        was deployed at, plus the Entra groups that back its admin / member tiers and the chargeback cost center.
        dlz-attach fills these automatically; a tenant admin can also set them here.
      </Caption1>

      <Field label="Attached subscription(s)">
        {subs.length ? (
          <TagGroup aria-label="Attached subscriptions" className={styles.tagWrap}>
            {subs.map((sub) => <Tag key={sub} value={sub}>{sub}</Tag>)}
          </TagGroup>
        ) : (
          <Caption1 className={styles.note}>None attached. Use “Attach existing subscription” on the domain’s row.</Caption1>
        )}
      </Field>

      <Field label="Resource group">
        <Input value={domain.dlzRg || ''} disabled placeholder="Set by dlz-attach / attach flow" />
      </Field>

      <Field label="Region">
        <Dropdown
          disabled={!isTenantAdmin}
          value={location ? (regions.find((r) => r.name === location)?.display || location) : ''}
          selectedOptions={location ? [location] : []}
          onOptionSelect={(_e, d) => setLocation(d.optionValue || '')}
          placeholder="Select a region"
        >
          {regions.map((r) => <Option key={r.name} value={r.name} text={r.display}>{r.display} ({r.name})</Option>)}
        </Dropdown>
      </Field>

      <Field label="Capacity sizing">
        <Dropdown
          disabled={!isTenantAdmin}
          value={capacitySku}
          selectedOptions={capacitySku ? [capacitySku] : []}
          onOptionSelect={(_e, d) => setCapacitySku(d.optionValue || '')}
          placeholder="Select a capacity F-SKU"
        >
          {CAPACITY_SKUS.map((sku) => <Option key={sku} value={sku} text={sku}>{sku}</Option>)}
        </Dropdown>
      </Field>

      <GroupPicker label="Domain admins group (Entra)" value={adminGroupId} onChange={setAdminGroupId} disabled={!isTenantAdmin} />
      <GroupPicker label="Domain members group (Entra)" value={memberGroupId} onChange={setMemberGroupId} disabled={!isTenantAdmin} />

      <Field label="Chargeback cost center">
        <Input value={costCenter} disabled={!isTenantAdmin} placeholder="e.g. CC-1042" onChange={(_e, d) => setCostCenter(d.value)} />
      </Field>

      <Field label="Status">
        <Dropdown
          disabled={!isTenantAdmin}
          value={status}
          selectedOptions={[status]}
          onOptionSelect={(_e, d) => setStatus((d.optionValue as DomainRecord['status']) || 'registered')}
        >
          {(['registered', 'attaching', 'active', 'detached', 'error'] as const).map((st) =>
            <Option key={st} value={st} text={st}>{st}</Option>)}
        </Dropdown>
      </Field>

      {domain.chargebackTag && (
        <Caption1 className={styles.note}>Chargeback tag: <code>{domain.chargebackTag}</code></Caption1>
      )}

      {isTenantAdmin && <ApplyButton busy={busy} error={err} onApply={apply} />}
      {!isTenantAdmin && (
        <Caption1 className={styles.note}>Only a tenant admin can change the Data Landing Zone binding.</Caption1>
      )}

      {/* Resource inventory (ARG by tag) */}
      <div className={styles.sectionHeadSpaced}>
        <Subtitle2>Resource inventory</Subtitle2>
        <Button size="small" onClick={loadInventory} disabled={invLoading}>Refresh</Button>
      </div>
      {invLoading && <Spinner size="tiny" label="Querying Azure Resource Graph…" />}
      {invGate && (
        <MessageBar intent={invBound ? 'warning' : 'info'}>
          <MessageBarBody>{invGate}</MessageBarBody>
        </MessageBar>
      )}
      {inv && inv.length > 0 && (
        <div className={styles.invTable}>
          <div className={styles.invHead}>
            <span>Name</span><span>Type</span><span>Resource group</span><span>Location</span>
          </div>
          {inv.map((r) => (
            <div key={`${r.subscriptionId}/${r.resourceGroup}/${r.name}`} className={styles.invRow}>
              <span>{r.name}</span>
              <span><Caption1 className={styles.note}>{r.type}</Caption1></span>
              <span>{r.resourceGroup}</span>
              <span>{r.location}</span>
            </div>
          ))}
        </div>
      )}
      {inv && inv.length === 0 && !invGate && (
        <Caption1 className={styles.note}>No tagged resources found for this domain.</Caption1>
      )}
    </div>
  );
}

export default DomainSettingsPane;
