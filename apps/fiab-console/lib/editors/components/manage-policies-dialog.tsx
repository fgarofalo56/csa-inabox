'use client';

/**
 * Manage Policies dialog (F8) — data-product access-policy editor.
 *
 * One-for-one with Microsoft Purview's data-product "Manage access" surface:
 *   • Permitted use — allowed-purposes list + inline add-purpose form.
 *   • Approval requirements — manager-approval toggle, privacy-review toggle,
 *     access-request approvers (Entra user/group search), access provider.
 *   • Multi-tier sequence preview (manager → privacy → approver → provider).
 *
 * Real backend: GET/PUT /api/data-products/{id}/access-policy (Cosmos), and
 * /api/data-products/{id}/principal-search (live Microsoft Graph — approvers
 * resolve to real Entra principals with their UPN shown; no free-text entry).
 *
 * Published guard: Purview only allows managing access policies on an
 * UNPUBLISHED product. When `isPublished` is true every control is disabled
 * and a MessageBar explains that the product must be unpublished first; the
 * PUT route also returns HTTP 409 as a server-side backstop.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Input, Field, Switch, Persona, Spinner, Tab, TabList, Badge, Divider,
  MessageBar, MessageBarBody, MessageBarTitle, Caption1, Body1, Subtitle2,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Search16Regular, Add16Regular, Delete16Regular, Dismiss16Regular, ChevronRight16Regular,
} from '@fluentui/react-icons';
import {
  type DataProductAccessPolicy, type PolicyPrincipal,
  defaultAccessPolicy, normalizeAccessPolicy, policyTiers, DEFAULT_PURPOSES,
} from '@/lib/types/access-policy';

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: '10px' },
  results: { maxHeight: '180px', overflowY: 'auto', borderRadius: '4px', border: `1px solid ${tokens.colorNeutralStroke2}`, padding: '4px' },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', borderRadius: '4px', cursor: 'pointer', ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover } },
  chips: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' },
  chip: { display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 8px', borderRadius: '4px', backgroundColor: tokens.colorNeutralBackground3, fontSize: '12px' },
  chipBtn: { cursor: 'pointer', display: 'inline-flex', alignItems: 'center', color: tokens.colorNeutralForeground3, ':hover': { color: tokens.colorNeutralForeground1 } },
  purposeForm: { display: 'grid', gridTemplateColumns: '1fr 2fr auto', gap: '8px', alignItems: 'flex-end' },
  tierRow: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px', padding: '8px', borderRadius: '6px', backgroundColor: tokens.colorNeutralBackground2 },
});

// ---------------------------------------------------------------------------
// Inline Entra principal picker (real Graph search, owner-scoped endpoint).
// ---------------------------------------------------------------------------
function PrincipalPicker({
  productId, disabled, multi, selected, onAdd, onRemove, label,
}: {
  productId: string;
  disabled: boolean;
  multi: boolean;
  selected: PolicyPrincipal[];
  onAdd: (p: PolicyPrincipal) => void;
  onRemove: (id: string) => void;
  label: string;
}) {
  const styles = useStyles();
  const [kind, setKind] = useState<'user' | 'group'>('user');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<PolicyPrincipal[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<{ message: string; remediation?: string } | null>(null);

  useEffect(() => {
    if (disabled || !q.trim()) { setHits([]); setErr(null); return; }
    const handle = setTimeout(async () => {
      setLoading(true); setErr(null);
      try {
        const res = await fetch(
          `/api/data-products/${encodeURIComponent(productId)}/principal-search?q=${encodeURIComponent(q)}&kind=${kind}`,
          { cache: 'no-store' },
        );
        const json = await res.json();
        if (!res.ok || !json.ok) {
          setErr({ message: json?.error || `Graph ${res.status}`, remediation: json?.remediation });
          setHits([]);
        } else {
          setHits((json.results || []).map((r: any): PolicyPrincipal => ({
            id: r.id,
            upn: r.upn || r.mail || r.displayName,
            displayName: r.displayName,
            type: r.type === 'group' ? 'Group' : 'User',
          })));
        }
      } catch (e: any) {
        setErr({ message: e?.message || String(e) });
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [q, kind, productId, disabled]);

  const add = (p: PolicyPrincipal) => {
    if (!multi) onAdd(p);
    else if (!selected.some((s) => s.id === p.id)) onAdd(p);
    setQ('');
    setHits([]);
  };

  return (
    <Field label={label}>
      <TabList selectedValue={kind} onTabSelect={(_e, d) => setKind(d.value as 'user' | 'group')} size="small">
        <Tab value="user" disabled={disabled}>User</Tab>
        <Tab value="group" disabled={disabled}>Group</Tab>
      </TabList>
      <Input
        value={q}
        disabled={disabled}
        onChange={(_e, d) => setQ(d.value)}
        placeholder={kind === 'user' ? 'Search by display name or UPN' : 'Search by group name'}
        contentBefore={<Search16Regular />}
        style={{ marginTop: 8 }}
      />
      {err && (
        <MessageBar intent="warning" style={{ marginTop: 8 }}>
          <MessageBarBody>
            <MessageBarTitle>{err.message}</MessageBarTitle>
            {err.remediation && <div style={{ marginTop: 4 }}>{err.remediation}</div>}
          </MessageBarBody>
        </MessageBar>
      )}
      {q.trim() && !err && (
        <div className={styles.results} style={{ marginTop: 8 }}>
          {loading && <Spinner size="tiny" label="Searching Entra…" />}
          {!loading && hits.length === 0 && <div style={{ padding: 8, color: tokens.colorNeutralForeground3 }}>No matches.</div>}
          {hits.map((h) => (
            <div
              key={h.id}
              className={styles.row}
              role="button"
              tabIndex={0}
              onClick={() => add(h)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') add(h); }}
            >
              <Persona name={h.displayName} secondaryText={h.upn} presence={undefined as any} />
              <Add16Regular />
            </div>
          ))}
        </div>
      )}
      {selected.length > 0 && (
        <div className={styles.chips}>
          {selected.map((p) => (
            <span key={p.id} className={styles.chip}>
              <Badge appearance="tint" color={p.type === 'Group' ? 'informative' : 'brand'} size="small">{p.type}</Badge>
              {p.upn}
              {!disabled && (
                <span
                  className={styles.chipBtn}
                  role="button"
                  tabIndex={0}
                  aria-label={`Remove ${p.upn}`}
                  onClick={() => onRemove(p.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onRemove(p.id); }}
                >
                  <Dismiss16Regular />
                </span>
              )}
            </span>
          ))}
        </div>
      )}
    </Field>
  );
}

export interface ManagePoliciesDialogProps {
  open: boolean;
  productId: string;
  isPublished: boolean;
  onClose: () => void;
  onSaved: (policy: DataProductAccessPolicy) => void;
}

export function ManagePoliciesDialog({ open, productId, isPublished, onClose, onSaved }: ManagePoliciesDialogProps) {
  const styles = useStyles();
  const [policy, setPolicy] = useState<DataProductAccessPolicy>(defaultAccessPolicy());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pName, setPName] = useState('');
  const [pDesc, setPDesc] = useState('');

  // Load the persisted policy whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setErr(null);
    (async () => {
      try {
        const r = await fetch(`/api/data-products/${encodeURIComponent(productId)}/access-policy`, { cache: 'no-store' });
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok || !j.ok) {
          setErr(j?.error || `HTTP ${r.status}`);
          setPolicy(defaultAccessPolicy());
        } else {
          const loaded = normalizeAccessPolicy(j.policy);
          // Seed Purview's default purposes on first open (none persisted yet).
          if (loaded.allowedPurposes.length === 0) loaded.allowedPurposes = [...DEFAULT_PURPOSES];
          setPolicy(loaded);
        }
      } catch (e: any) {
        if (!cancelled) { setErr(e?.message || String(e)); setPolicy(defaultAccessPolicy()); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, productId]);

  const addPurpose = () => {
    const name = pName.trim();
    if (!name) return;
    setPolicy((prev) => ({
      ...prev,
      allowedPurposes: prev.allowedPurposes.some((p) => p.name.toLowerCase() === name.toLowerCase())
        ? prev.allowedPurposes
        : [...prev.allowedPurposes, { name, description: pDesc.trim() }],
    }));
    setPName(''); setPDesc('');
  };
  const removePurpose = (name: string) =>
    setPolicy((prev) => ({ ...prev, allowedPurposes: prev.allowedPurposes.filter((p) => p.name !== name) }));

  const save = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/data-products/${encodeURIComponent(productId)}/access-policy`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(policy),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setErr(j?.code === 'published_locked'
          ? 'This product is Published — unpublish it before editing access policies.'
          : (j?.error || `HTTP ${r.status}`));
        return;
      }
      onSaved(normalizeAccessPolicy(j.policy));
      onClose();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [policy, productId, onSaved, onClose]);

  const tiers = policyTiers(policy);

  return (
    <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open) onClose(); }} modalType="modal">
      <DialogSurface style={{ maxWidth: 720 }}>
        <DialogBody>
          <DialogTitle>Manage policies</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {isPublished && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Product is Published</MessageBarTitle>
                    Editing access policies requires unpublishing the data product first. Unpublish from the APIM
                    surface, then reopen this dialog to make changes.
                  </MessageBarBody>
                </MessageBar>
              )}

              {loading ? (
                <Spinner label="Loading access policy…" />
              ) : (
                <>
                  {err && (
                    <MessageBar intent="error">
                      <MessageBarBody>{err}</MessageBarBody>
                    </MessageBar>
                  )}

                  {/* ---- Permitted use ---- */}
                  <div className={styles.section}>
                    <Subtitle2>Permitted use</Subtitle2>
                    <Body1>Consumers must select one of these purposes when requesting access.</Body1>
                    <Table size="small" aria-label="Allowed purposes">
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>Purpose</TableHeaderCell>
                          <TableHeaderCell>Description</TableHeaderCell>
                          <TableHeaderCell style={{ width: 48 }} />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {policy.allowedPurposes.length === 0 && (
                          <TableRow><TableCell>No purposes defined.</TableCell><TableCell /><TableCell /></TableRow>
                        )}
                        {policy.allowedPurposes.map((p) => (
                          <TableRow key={p.name}>
                            <TableCell><strong>{p.name}</strong></TableCell>
                            <TableCell>{p.description || <Caption1>—</Caption1>}</TableCell>
                            <TableCell>
                              <Button
                                appearance="subtle"
                                size="small"
                                icon={<Delete16Regular />}
                                aria-label={`Remove ${p.name}`}
                                disabled={isPublished}
                                onClick={() => removePurpose(p.name)}
                              />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    <div className={styles.purposeForm}>
                      <Field label="Add purpose">
                        <Input value={pName} disabled={isPublished} onChange={(_e, d) => setPName(d.value)} placeholder="e.g. Fraud detection" />
                      </Field>
                      <Field label="Description">
                        <Input value={pDesc} disabled={isPublished} onChange={(_e, d) => setPDesc(d.value)} placeholder="How this data may be used" />
                      </Field>
                      <Button appearance="secondary" icon={<Add16Regular />} disabled={isPublished || !pName.trim()} onClick={addPurpose}>
                        Add
                      </Button>
                    </div>
                  </div>

                  <Divider />

                  {/* ---- Approval requirements ---- */}
                  <div className={styles.section}>
                    <Subtitle2>Approval requirements</Subtitle2>
                    <Switch
                      label="Require manager approval"
                      checked={policy.requireManagerApproval}
                      disabled={isPublished}
                      onChange={(_e, d) => setPolicy((prev) => ({ ...prev, requireManagerApproval: d.checked }))}
                    />
                    <Switch
                      label="Require privacy and compliance review"
                      checked={policy.requirePrivacyReview}
                      disabled={isPublished}
                      onChange={(_e, d) => setPolicy((prev) => ({ ...prev, requirePrivacyReview: d.checked }))}
                    />
                    <PrincipalPicker
                      productId={productId}
                      disabled={isPublished}
                      multi
                      label="Access request approvers"
                      selected={policy.approvers}
                      onAdd={(p) => setPolicy((prev) => ({ ...prev, approvers: [...prev.approvers, p] }))}
                      onRemove={(idToRemove) => setPolicy((prev) => ({ ...prev, approvers: prev.approvers.filter((a) => a.id !== idToRemove) }))}
                    />
                    <PrincipalPicker
                      productId={productId}
                      disabled={isPublished}
                      multi={false}
                      label="Access provider (provisions the grant on approval)"
                      selected={policy.accessProvider ? [policy.accessProvider] : []}
                      onAdd={(p) => setPolicy((prev) => ({ ...prev, accessProvider: p }))}
                      onRemove={() => setPolicy((prev) => ({ ...prev, accessProvider: null }))}
                    />
                  </div>

                  <Divider />

                  {/* ---- Tier sequence preview ---- */}
                  <div className={styles.section}>
                    <Subtitle2>Approval sequence</Subtitle2>
                    {tiers.length === 0 ? (
                      <Caption1>No approval tiers configured — access requests will be auto-approved.</Caption1>
                    ) : (
                      <div className={styles.tierRow}>
                        {tiers.map((t, i) => (
                          <span key={t.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <Badge appearance="filled" color="brand">
                              {t.label}{t.detail ? `: ${t.detail}` : ''}
                            </Badge>
                            {i < tiers.length - 1 && <ChevronRight16Regular />}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" onClick={save} disabled={isPublished || busy || loading}>
              {busy ? 'Saving…' : 'Save policy'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
