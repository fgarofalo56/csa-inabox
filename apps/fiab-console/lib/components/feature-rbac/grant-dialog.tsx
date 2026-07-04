'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * Grant dialog — pick an Entra principal (user or group via Graph
 * search) and a role; POSTs to /api/admin/permissions/grants.
 *
 * Real Graph search (no mock principal list). When Graph permissions
 * aren't granted, the dialog surfaces a MessageBar with the exact
 * remediation steps.
 */
import { useState, useCallback, useEffect } from 'react';
import {
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogContent, DialogActions, DialogBody,
  Button, Input, Field, Dropdown, Option,
  MessageBar, MessageBarBody, MessageBarTitle,
  Persona, Spinner, Tab, TabList, makeStyles, tokens,
} from '@fluentui/react-components';
import { Search16Regular } from '@fluentui/react-icons';

export type FeatureRole = 'Reader' | 'Contributor' | 'Admin';
export type PrincipalKind = 'user' | 'group';

interface PrincipalHit {
  id: string;
  type: PrincipalKind;
  displayName: string;
  upn?: string;
  mail?: string;
  description?: string;
}

const useStyles = makeStyles({
  results: { maxHeight: '240px', overflowY: 'auto', borderRadius: '4px', border: `1px solid ${tokens.colorNeutralStroke2}`, padding: '4px' },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', borderRadius: '4px', cursor: 'pointer', ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover } },
  rowSelected: { backgroundColor: tokens.colorBrandBackground2 },
});

export interface GrantDialogProps {
  open: boolean;
  capabilityId: string;
  capabilityName: string;
  onClose: () => void;
  onGranted: () => void;
}

export function GrantDialog({ open, capabilityId, capabilityName, onClose, onGranted }: GrantDialogProps) {
  const styles = useStyles();
  const [kind, setKind] = useState<PrincipalKind>('user');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<PrincipalHit[]>([]);
  const [selected, setSelected] = useState<PrincipalHit | null>(null);
  const [role, setRole] = useState<FeatureRole>('Reader');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; remediation?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // Debounced search
  useEffect(() => {
    if (!open || !q.trim()) { setHits([]); setError(null); return; }
    const handle = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await clientFetch(`/api/admin/permissions/principals?q=${encodeURIComponent(q)}&kind=${kind}`, { cache: 'no-store' });
        const json = await res.json();
        if (!res.ok) {
          setError({ message: json?.error || `Graph ${res.status}`, remediation: json?.remediation });
          setHits([]);
        } else {
          setHits(json.results || []);
        }
      } catch (e: any) {
        setError({ message: e?.message || String(e) });
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [q, kind, open]);

  const grant = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const res = await clientFetch('/api/admin/permissions/grants', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          capabilityId,
          principalId: selected.id,
          principalType: selected.type,
          principalDisplayName: selected.displayName,
          principalUpn: selected.upn,
          role,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError({ message: json?.error || `Grant ${res.status}` });
      } else {
        onGranted();
        onClose();
        setSelected(null);
        setQ('');
      }
    } catch (e: any) {
      setError({ message: e?.message || String(e) });
    } finally {
      setSaving(false);
    }
  }, [selected, role, capabilityId, onClose, onGranted]);

  return (
    <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open) onClose(); }} modalType="modal">
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Grant access — {capabilityName}</DialogTitle>
          <DialogContent>
            <TabList selectedValue={kind} onTabSelect={(_e, d) => setKind(d.value as PrincipalKind)}>
              <Tab value="user">User</Tab>
              <Tab value="group">Group</Tab>
            </TabList>
            <Field label="Search Entra" style={{ marginTop: tokens.spacingVerticalM }}>
              <Input
                value={q}
                onChange={(_e, d) => setQ(d.value)}
                placeholder={kind === 'user' ? 'Display name or UPN' : 'Group display name'}
                contentBefore={<Search16Regular />}
              />
            </Field>

            {error && (
              <MessageBar intent="warning" style={{ marginTop: tokens.spacingVerticalM }}>
                <MessageBarBody>
                  <MessageBarTitle>{error.message}</MessageBarTitle>
                  {error.remediation && <div style={{ marginTop: tokens.spacingVerticalXS }}>{error.remediation}</div>}
                </MessageBarBody>
              </MessageBar>
            )}

            <div className={styles.results} style={{ marginTop: tokens.spacingVerticalM }}>
              {loading && <Spinner size="tiny" label="Searching Entra…" />}
              {!loading && hits.length === 0 && q.trim() && !error && (
                <div style={{ padding: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>No matches.</div>
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
                  <Persona
                    name={h.displayName}
                    secondaryText={h.upn || h.mail || h.description || h.type}
                    presence={undefined as any}
                  />
                </div>
              ))}
            </div>

            <Field label="Role" style={{ marginTop: tokens.spacingVerticalL }}>
              <Dropdown value={role} selectedOptions={[role]} onOptionSelect={(_e, d) => setRole((d.optionValue || 'Reader') as FeatureRole)}>
                <Option value="Reader">Reader — can view</Option>
                <Option value="Contributor">Contributor — can view and edit</Option>
                <Option value="Admin">Admin — can view, edit, and grant access</Option>
              </Dropdown>
            </Field>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            </DialogTrigger>
            <Button appearance="primary" onClick={grant} disabled={!selected || saving}>
              {saving ? 'Granting…' : 'Grant'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
