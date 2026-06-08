'use client';

/**
 * Share-item dialog (F6) — Fabric-style "Grant people access" flow.
 *
 * Two steps, mirroring Fabric's Share dialog:
 *   1. Pick an Entra principal (real Graph search via
 *      /api/admin/permissions/principals) + choose permission types. The
 *      permission set offered is tailored to the item type (Read always
 *      implied; ReadData / ReadAll / Execute / Build shown only where they apply).
 *      DLP-restricted items disable Edit + Reshare with an inline MessageBar.
 *   2. Review the selected principal + permissions, then Grant — POSTs to
 *      /api/items/{type}/{id}/permissions, which writes the Cosmos row and
 *      mirrors ADLS POSIX ACL + ARM Storage RBAC (Azure-native default).
 *
 * No mock principals: when Graph permissions aren't granted the search box
 * surfaces the exact remediation. Per no-vaporware.md.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogContent, DialogActions, DialogBody, DialogTrigger,
  Button, Input, Field, Checkbox, Badge,
  MessageBar, MessageBarBody, MessageBarTitle,
  Persona, Spinner, Tab, TabList, Divider, Caption1,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Search16Regular, ShieldKeyholeRegular } from '@fluentui/react-icons';

export type PrincipalKind = 'user' | 'group';

export type ItemPermissionType =
  | 'Read' | 'Edit' | 'Reshare' | 'ReadData' | 'ReadAllSQL' | 'ReadAllSpark'
  | 'SubscribeOneLakeEvents' | 'Execute' | 'Build';

interface PrincipalHit {
  id: string;
  type: PrincipalKind;
  displayName: string;
  upn?: string;
  mail?: string;
  description?: string;
}

interface PermissionOption {
  type: ItemPermissionType;
  label: string;
  hint: string;
  /** Always-on (Read) — checkbox is checked + disabled. */
  locked?: boolean;
  /** Disabled by an active DLP restriction (Edit / Reshare). */
  dlpBlocked?: boolean;
}

/** Item-type families that expose data-plane (SQL/Spark/OneLake) permissions. */
const DATA_ITEM_TYPES = new Set([
  'lakehouse', 'warehouse', 'mirrored-database', 'kql-database', 'eventhouse',
  'synapse-dedicated-sql-pool', 'synapse-serverless-sql-pool',
]);
/** Item-type families whose primary action is "run" (Execute). */
const EXECUTE_ITEM_TYPES = new Set([
  'notebook', 'spark-job-definition', 'environment', 'data-pipeline',
  'adf-pipeline', 'synapse-pipeline', 'copy-job', 'dataflow', 'dbt-job',
  'databricks-notebook', 'databricks-job', 'stream-analytics-job',
]);
/** Item-type families that expose "Build" (semantic models). */
const BUILD_ITEM_TYPES = new Set(['semantic-model']);

/** Resolve the permission options offered for an item type (Fabric parity). */
function permissionOptionsFor(itemType: string, dlpRestricted: boolean): PermissionOption[] {
  const opts: PermissionOption[] = [
    { type: 'Read', label: 'Read', hint: 'View the item and its metadata. Always granted.', locked: true },
    { type: 'Edit', label: 'Edit', hint: 'Modify the item definition.', dlpBlocked: dlpRestricted },
    { type: 'Reshare', label: 'Reshare', hint: 'Share the item with others.', dlpBlocked: dlpRestricted },
  ];
  if (DATA_ITEM_TYPES.has(itemType)) {
    opts.push(
      { type: 'ReadData', label: 'Read data (SQL)', hint: 'Query the item via the SQL analytics endpoint (TDS).' },
      { type: 'ReadAllSQL', label: 'ReadAll — SQL', hint: 'Read all data via the SQL analytics endpoint.' },
      { type: 'ReadAllSpark', label: 'ReadAll — Spark', hint: 'Read all data via Apache Spark / OneLake APIs.' },
      { type: 'SubscribeOneLakeEvents', label: 'Subscribe to OneLake events', hint: 'Receive OneLake change events for the item.' },
    );
  }
  if (EXECUTE_ITEM_TYPES.has(itemType)) {
    opts.push({ type: 'Execute', label: 'Execute', hint: 'Run / trigger the item.' });
  }
  if (BUILD_ITEM_TYPES.has(itemType)) {
    opts.push({ type: 'Build', label: 'Build', hint: 'Build reports on top of the semantic model.' });
  }
  return opts;
}

const useStyles = makeStyles({
  results: { maxHeight: '220px', overflowY: 'auto', borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`, padding: '4px' },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', borderRadius: tokens.borderRadiusMedium, cursor: 'pointer', ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover } },
  rowSelected: { backgroundColor: tokens.colorBrandBackground2 },
  permGrid: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: tokens.spacingVerticalM },
  permRow: { display: 'flex', flexDirection: 'column', gap: '0px' },
  reviewPerms: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: tokens.spacingVerticalS },
});

export interface ShareItemDialogProps {
  open: boolean;
  itemId: string;
  itemType: string;
  dlpRestricted?: boolean;
  dlpPolicyName?: string;
  hasStoragePath?: boolean;
  onClose: () => void;
  onGranted: () => void;
}

export function ShareItemDialog({
  open, itemId, itemType, dlpRestricted = false, dlpPolicyName, hasStoragePath,
  onClose, onGranted,
}: ShareItemDialogProps) {
  const styles = useStyles();
  const [step, setStep] = useState<1 | 2>(1);
  const [kind, setKind] = useState<PrincipalKind>('user');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<PrincipalHit[]>([]);
  const [selected, setSelected] = useState<PrincipalHit | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; remediation?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const options = useMemo(() => permissionOptionsFor(itemType, dlpRestricted), [itemType, dlpRestricted]);
  const [checked, setChecked] = useState<Set<ItemPermissionType>>(new Set(['Read']));

  // Reset on (re)open.
  useEffect(() => {
    if (open) {
      setStep(1); setSelected(null); setQ(''); setHits([]); setError(null);
      setChecked(new Set(['Read']));
    }
  }, [open]);

  // Debounced Entra search.
  useEffect(() => {
    if (!open || !q.trim()) { setHits([]); setError(null); return; }
    const h = setTimeout(async () => {
      setLoading(true); setError(null);
      try {
        const res = await fetch(`/api/admin/permissions/principals?q=${encodeURIComponent(q)}&kind=${kind}`, { cache: 'no-store' });
        const json = await res.json();
        if (!res.ok) { setError({ message: json?.error || `Graph ${res.status}`, remediation: json?.remediation }); setHits([]); }
        else setHits(json.results || []);
      } catch (e: any) {
        setError({ message: e?.message || String(e) });
      } finally { setLoading(false); }
    }, 300);
    return () => clearTimeout(h);
  }, [q, kind, open]);

  const toggle = useCallback((t: ItemPermissionType) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      next.add('Read'); // Read always implied.
      return next;
    });
  }, []);

  const grant = useCallback(async () => {
    if (!selected) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch(`/api/items/${itemType}/${itemId}/permissions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          principalId: selected.id,
          principalType: selected.type,
          principalDisplayName: selected.displayName,
          principalUpn: selected.upn,
          permissionTypes: Array.from(checked),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError({ message: json?.message || json?.error || `Grant ${res.status}` });
      } else {
        onGranted();
        onClose();
      }
    } catch (e: any) {
      setError({ message: e?.message || String(e) });
    } finally { setSaving(false); }
  }, [selected, checked, itemType, itemId, onGranted, onClose]);

  return (
    <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open) onClose(); }} modalType="modal">
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Grant people access</DialogTitle>
          <DialogContent>
            {dlpRestricted && (
              <MessageBar intent="warning" icon={<ShieldKeyholeRegular />}>
                <MessageBarBody>
                  <MessageBarTitle>DLP restriction active</MessageBarTitle>
                  Sharing is restricted by Data Loss Prevention policy
                  {dlpPolicyName ? ` "${dlpPolicyName}"` : ''}. Edit and Reshare are disabled for this item.
                </MessageBarBody>
              </MessageBar>
            )}

            {step === 1 && (
              <>
                <TabList selectedValue={kind} onTabSelect={(_e, d) => setKind(d.value as PrincipalKind)} style={{ marginTop: 8 }}>
                  <Tab value="user">User</Tab>
                  <Tab value="group">Group</Tab>
                </TabList>
                <Field label="Search Entra" style={{ marginTop: 12 }}>
                  <Input
                    value={q}
                    onChange={(_e, d) => setQ(d.value)}
                    placeholder={kind === 'user' ? 'Display name or UPN' : 'Group display name'}
                    contentBefore={<Search16Regular />}
                  />
                </Field>

                {error && (
                  <MessageBar intent="warning" style={{ marginTop: 12 }}>
                    <MessageBarBody>
                      <MessageBarTitle>{error.message}</MessageBarTitle>
                      {error.remediation && <div style={{ marginTop: 4 }}>{error.remediation}</div>}
                    </MessageBarBody>
                  </MessageBar>
                )}

                <div className={styles.results} style={{ marginTop: 12 }}>
                  {loading && <Spinner size="tiny" label="Searching Entra…" />}
                  {!loading && hits.length === 0 && q.trim() && !error && (
                    <div style={{ padding: 8, color: tokens.colorNeutralForeground3 }}>No matches.</div>
                  )}
                  {hits.map((h) => (
                    <div
                      key={h.id}
                      className={`${styles.row} ${selected?.id === h.id ? styles.rowSelected : ''}`}
                      onClick={() => setSelected(h)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelected(h); }}
                    >
                      <Persona name={h.displayName} secondaryText={h.upn || h.mail || h.description || h.type} />
                    </div>
                  ))}
                </div>

                <Divider style={{ marginTop: 16, marginBottom: 8 }} />
                <Caption1>Permissions</Caption1>
                <div className={styles.permGrid}>
                  {options.map((o) => (
                    <div key={o.type} className={styles.permRow}>
                      <Checkbox
                        label={o.label}
                        checked={o.locked ? true : checked.has(o.type)}
                        disabled={o.locked || o.dlpBlocked}
                        onChange={() => toggle(o.type)}
                      />
                      <Caption1 style={{ marginLeft: 28, color: tokens.colorNeutralForeground3 }}>
                        {o.dlpBlocked ? `${o.hint} (disabled by DLP)` : o.hint}
                      </Caption1>
                    </div>
                  ))}
                </div>
                {hasStoragePath === false && (
                  <MessageBar intent="info" style={{ marginTop: 12 }}>
                    <MessageBarBody>
                      This item has no resolved ADLS storage path, so data-plane permissions are
                      recorded in Loom but not mirrored to a POSIX ACL. Read/Edit on the item still apply.
                    </MessageBarBody>
                  </MessageBar>
                )}
              </>
            )}

            {step === 2 && selected && (
              <>
                <Field label="Recipient" style={{ marginTop: 8 }}>
                  <Persona name={selected.displayName} secondaryText={selected.upn || selected.mail || selected.type} />
                </Field>
                <Caption1 style={{ marginTop: 12, display: 'block' }}>Permissions to grant</Caption1>
                <div className={styles.reviewPerms}>
                  {Array.from(checked).map((t) => (
                    <Badge key={t} appearance="tint" color="brand">{t}</Badge>
                  ))}
                </div>
                {error && (
                  <MessageBar intent="error" style={{ marginTop: 12 }}>
                    <MessageBarBody>
                      <MessageBarTitle>Grant failed</MessageBarTitle>
                      {error.message}
                    </MessageBarBody>
                  </MessageBar>
                )}
                <Caption1 style={{ marginTop: 12, display: 'block', color: tokens.colorNeutralForeground3 }}>
                  Granting Read mirrors a POSIX ACL entry + Storage Blob Data Reader on the item&apos;s
                  data. Revoking takes effect on the recipient&apos;s next sign-in / token refresh.
                </Caption1>
              </>
            )}
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            </DialogTrigger>
            {step === 1 ? (
              <Button appearance="primary" disabled={!selected} onClick={() => setStep(2)}>Next</Button>
            ) : (
              <>
                <Button appearance="secondary" onClick={() => setStep(1)}>Back</Button>
                <Button appearance="primary" disabled={saving} onClick={grant}>
                  {saving ? 'Granting…' : 'Grant'}
                </Button>
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default ShareItemDialog;
