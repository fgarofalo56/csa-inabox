'use client';

/**
 * AccessReviewsPanel (access-governance W4) — the access-review / recertification
 * admin surface. Three real, wired sections:
 *   • Campaigns list + builder wizard (AG-6): scope/reviewers/cadence pickers —
 *     no raw JSON. Snapshots in-scope ledger grants into review items on create.
 *   • Reviewer inbox (AG-7/AG-14): per-campaign items with bulk attest/revoke,
 *     attest/revoke-all-remaining, reviewer delegation, and close (auto-revokes
 *     undecided). Every revoke hits the real backend + ledger.
 *   • Lifecycle actions (AG-9/AG-14): run the review sweep, reconcile Entra
 *     group-targeted packages (honest gate when Graph group-sync is off), and
 *     leaver revoke-all for a principal.
 *
 * All real backends (POST /api/access-governance/reviews[/…], /group-sync,
 * /revoke-all). Fluent v9 + Loom tokens; badges wrap; clean first-open.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  makeStyles, tokens, Badge, Button, Input, Field, Dropdown, Option, Checkbox,
  Caption1, Subtitle2, Text, Spinner, Divider, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Card, CardHeader,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell, TableCellLayout,
} from '@fluentui/react-components';
import {
  ClipboardTaskListLtr24Regular, Add20Regular, ArrowSync20Regular, Timer20Regular,
  PeopleTeam20Regular, PersonDelete20Regular, CheckmarkCircle20Regular, DismissCircle20Regular,
  Person20Regular, Group20Regular, ShieldTask24Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { IdentityPicker } from '@/lib/components/ui/identity-picker';

interface Binding { type: 'user' | 'group'; id: string; name?: string }
interface ReviewItem {
  id: string; assignmentId?: string;
  principalId: string; principalUpn?: string; principalType: string;
  resourceType: string; resourceRef: string; resourceName?: string;
  role: string; source: string; decision: 'pending' | 'attest' | 'revoke';
  decidedBy?: string; decidedAt?: string;
}
interface Stats { total: number; attested: number; revoked: number; pending: number }
interface Review {
  id: string; name: string; description?: string;
  scope: { kind: string; ref?: string; resourceType?: string };
  reviewers: Binding[]; delegatedTo?: Binding[];
  cadenceDays?: number | null; dueAt?: string | null; autoRevokeOnExpiry: boolean;
  status: 'active' | 'completed' | 'closed'; items: ReviewItem[];
  createdBy?: string; createdAt: string; closedAt?: string;
  stats?: Stats;
}
interface Pkg { id: string; name: string }

const SCOPE_KINDS = [
  { key: 'all', label: 'All effective grants' },
  { key: 'package', label: 'One access package' },
  { key: 'resource', label: 'One resource' },
  { key: 'principal', label: 'One principal' },
  { key: 'group', label: 'One Entra group' },
];

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', minWidth: 0 },
  spacer: { flex: 1 },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  card: { minWidth: 0 },
  cardMeta: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  badges: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0, marginTop: tokens.spacingVerticalXS },
  wizard: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '360px' },
  chips: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 },
  scroll: { overflowX: 'auto', minWidth: 0 },
  cell: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  via: { color: tokens.colorNeutralForeground3 },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  lifecycle: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' },
});

function statusBadge(s: string) {
  const color = s === 'active' ? 'brand' : s === 'closed' ? 'subtle' : 'success';
  return <Badge appearance="tint" color={color as any} size="small">{s}</Badge>;
}
function decisionBadge(d: string) {
  const color = d === 'attest' ? 'success' : d === 'revoke' ? 'danger' : 'warning';
  const label = d === 'attest' ? 'attested' : d === 'revoke' ? 'revoked' : 'pending';
  return <Badge appearance="tint" color={color as any} size="small">{label}</Badge>;
}

export function AccessReviewsPanel() {
  const s = useStyles();
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [detail, setDetail] = useState<Review | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await clientFetch('/api/access-governance/reviews');
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); setReviews([]); return; }
      setReviews(j.reviews || []);
    } catch (e: any) { setErr(e?.message || String(e)); setReviews([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const runReviewSweep = useCallback(async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await clientFetch('/api/access-governance/reviews/sweep', { method: 'POST' });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || 'sweep failed'); return; }
      setNote(`Review sweep — ${j.closed ?? 0} campaign(s) closed, ${j.autoRevoked ?? 0} grant(s) auto-revoked.`);
      await load();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [load]);

  return (
    <div className={s.root}>
      <div className={s.header}>
        <Subtitle2>Recertification campaigns</Subtitle2>
        <div className={s.spacer} />
        <div className={s.actions}>
          <Tooltip content="Reload" relationship="label">
            <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={() => void load()} aria-label="Reload" />
          </Tooltip>
          <Button appearance="secondary" icon={<Timer20Regular />} disabled={busy} onClick={() => void runReviewSweep()}>Run review sweep</Button>
          <Button appearance="primary" icon={<Add20Regular />} onClick={() => setWizardOpen(true)}>New campaign</Button>
        </div>
      </div>

      {note && <MessageBar intent="success"><MessageBarBody>{note}</MessageBarBody></MessageBar>}
      {err && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Access reviews</MessageBarTitle>{err}</MessageBarBody></MessageBar>}

      {reviews === null && <Spinner size="tiny" label="Loading campaigns…" labelPosition="after" />}

      {reviews && reviews.length === 0 && !err && (
        <EmptyState
          icon={<ShieldTask24Regular />}
          title="No review campaigns yet"
          body="Create a recertification campaign to have reviewers attest or revoke access on a cadence. Undecided grants can be auto-revoked when the campaign closes."
          primaryAction={{ label: 'New campaign', onClick: () => setWizardOpen(true) }}
        />
      )}

      {reviews && reviews.length > 0 && (
        <TileGrid minTileWidth={300}>
          {reviews.map((r) => (
            <Card key={r.id} className={s.card} onClick={() => setDetail(r)} style={{ cursor: 'pointer' }}>
              <CardHeader
                header={<Text weight="semibold">{r.name}</Text>}
                description={<Caption1 className={s.via}>{SCOPE_KINDS.find((k) => k.key === r.scope.kind)?.label || r.scope.kind}{r.scope.ref ? ` · ${r.scope.ref}` : ''}</Caption1>}
              />
              <div className={s.cardMeta}>
                <Caption1 className={s.via}>{r.stats?.total ?? r.items.length} grant(s) · {r.stats?.pending ?? 0} pending</Caption1>
                <div className={s.badges}>
                  {statusBadge(r.status)}
                  {r.autoRevokeOnExpiry && <Badge appearance="tint" color="warning" size="small">auto-revoke</Badge>}
                  {r.dueAt && <Badge appearance="tint" color="informative" size="small">due {new Date(r.dueAt).toLocaleDateString()}</Badge>}
                  {typeof r.cadenceDays === 'number' && r.cadenceDays > 0 && <Badge appearance="tint" size="small">every {r.cadenceDays}d</Badge>}
                </div>
              </div>
            </Card>
          ))}
        </TileGrid>
      )}

      <Divider />
      <LifecycleActions onDone={(m) => { setNote(m); void load(); }} onError={setErr} />

      {wizardOpen && <CampaignWizard onClose={() => setWizardOpen(false)} onCreated={(m) => { setWizardOpen(false); setNote(m); void load(); }} />}
      {detail && <CampaignInbox review={detail} onClose={() => setDetail(null)} onChanged={() => { void load(); }} />}
    </div>
  );
}

/** AG-6 — the campaign builder wizard (pickers only, never raw JSON). */
function CampaignWizard({ onClose, onCreated }: { onClose: () => void; onCreated: (msg: string) => void }) {
  const s = useStyles();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scopeKind, setScopeKind] = useState('all');
  const [scopeRef, setScopeRef] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [reviewers, setReviewers] = useState<Binding[]>([]);
  const [cadenceDays, setCadenceDays] = useState<string>('0');
  const [dueInDays, setDueInDays] = useState<string>('14');
  const [autoRevoke, setAutoRevoke] = useState(false);
  const [packages, setPackages] = useState<Pkg[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try { const r = await clientFetch('/api/access-packages?scope=admin'); const j = await r.json(); if (j.ok) setPackages((j.packages || []).map((p: any) => ({ id: p.id, name: p.name }))); } catch { /* optional */ }
    })();
  }, []);

  const addReviewer = useCallback((hit: any) => {
    if (!hit?.id) return;
    setReviewers((prev) => prev.some((b) => b.id === hit.id) ? prev : [...prev, { type: hit.type === 'group' ? 'group' : 'user', id: hit.id, name: hit.displayName || hit.upn }]);
  }, []);

  const create = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const body: any = {
        name, description: description || undefined,
        scope: { kind: scopeKind, ...(scopeKind !== 'all' ? { ref: scopeRef } : {}), ...(scopeKind === 'resource' && resourceType ? { resourceType } : {}) },
        reviewers,
        cadenceDays: Number(cadenceDays) || null,
        dueInDays: Number(dueInDays) || undefined,
        autoRevokeOnExpiry: autoRevoke,
      };
      const r = await clientFetch('/api/access-governance/reviews', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      onCreated(`Created "${name}" — ${j.itemCount} grant(s) in scope to review.`);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [name, description, scopeKind, scopeRef, resourceType, reviewers, cadenceDays, dueInDays, autoRevoke, onCreated]);

  const needsRef = scopeKind !== 'all';
  const canCreate = name.trim().length > 0 && (!needsRef || scopeRef.trim().length > 0);

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>New review campaign</DialogTitle>
          <DialogContent>
            <div className={s.wizard}>
              <Field label="Campaign name" required>
                <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="Q3 access recertification" />
              </Field>
              <Field label="Description">
                <Input value={description} onChange={(_, d) => setDescription(d.value)} placeholder="Quarterly attestation of privileged access" />
              </Field>
              <Field label="What to review">
                <Dropdown value={SCOPE_KINDS.find((k) => k.key === scopeKind)?.label} selectedOptions={[scopeKind]} onOptionSelect={(_, d) => { setScopeKind(String(d.optionValue)); setScopeRef(''); }}>
                  {SCOPE_KINDS.map((k) => <Option key={k.key} value={k.key} text={k.label}>{k.label}</Option>)}
                </Dropdown>
              </Field>
              {scopeKind === 'package' && (
                <Field label="Access package">
                  <Dropdown placeholder="Pick a package" value={packages.find((p) => p.id === scopeRef)?.name} selectedOptions={[scopeRef]} onOptionSelect={(_, d) => setScopeRef(String(d.optionValue))}>
                    {packages.map((p) => <Option key={p.id} value={p.id} text={p.name}>{p.name}</Option>)}
                  </Dropdown>
                </Field>
              )}
              {scopeKind === 'resource' && (
                <>
                  <Field label="Resource reference" required>
                    <Input value={scopeRef} onChange={(_, d) => setScopeRef(d.value)} placeholder="workspace id / container / db / item id" />
                  </Field>
                  <Field label="Resource type (optional)">
                    <Input value={resourceType} onChange={(_, d) => setResourceType(d.value)} placeholder="workspace / adls-container / warehouse …" />
                  </Field>
                </>
              )}
              {(scopeKind === 'principal' || scopeKind === 'group') && (
                <Field label={scopeKind === 'group' ? 'Entra group' : 'Principal'} required hint="Search Entra, or paste the object id.">
                  <IdentityPicker kind={scopeKind === 'group' ? 'group' : 'user'} onSelect={(h) => setScopeRef(h?.id || '')} />
                  <Input value={scopeRef} onChange={(_, d) => setScopeRef(d.value)} placeholder="object id (oid)" />
                </Field>
              )}
              <Field label="Reviewers" hint="Named reviewers who may attest/revoke. Empty = admin-only.">
                <IdentityPicker kind="all" onSelect={addReviewer} />
                {reviewers.length > 0 && (
                  <div className={s.chips} style={{ marginTop: tokens.spacingVerticalXS }}>
                    {reviewers.map((b) => (
                      <Badge key={b.id} appearance="tint" color={b.type === 'group' ? 'informative' : 'brand'} size="small">
                        {b.name || b.id} <DismissCircle20Regular style={{ cursor: 'pointer', fontSize: '12px' }} onClick={() => setReviewers((p) => p.filter((x) => x.id !== b.id))} />
                      </Badge>
                    ))}
                  </div>
                )}
              </Field>
              <Field label="Deadline">
                <Dropdown value={`${dueInDays} days`} selectedOptions={[dueInDays]} onOptionSelect={(_, d) => setDueInDays(String(d.optionValue))}>
                  {['7', '14', '30', '60', '90'].map((n) => <Option key={n} value={n} text={`${n} days`}>{n} days</Option>)}
                </Dropdown>
              </Field>
              <Field label="Recurrence">
                <Dropdown value={Number(cadenceDays) > 0 ? `Every ${cadenceDays} days` : 'One-time'} selectedOptions={[cadenceDays]} onOptionSelect={(_, d) => setCadenceDays(String(d.optionValue))}>
                  <Option value="0" text="One-time">One-time</Option>
                  {['30', '60', '90', '180', '365'].map((n) => <Option key={n} value={n} text={`Every ${n} days`}>Every {n} days</Option>)}
                </Dropdown>
              </Field>
              <Checkbox checked={autoRevoke} onChange={(_, d) => setAutoRevoke(!!d.checked)} label="Auto-revoke undecided grants when the campaign closes at its deadline" />
              {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={!canCreate || busy} icon={busy ? <Spinner size="tiny" /> : <Add20Regular />} onClick={() => void create()}>Create campaign</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** AG-7/AG-14 — reviewer inbox with bulk attest/revoke + delegation + close. */
function CampaignInbox({ review, onClose, onChanged }: { review: Review; onClose: () => void; onChanged: () => void }) {
  const s = useStyles();
  const [items, setItems] = useState<ReviewItem[]>(review.items || []);
  const [status, setStatus] = useState(review.status);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [delegateOpen, setDelegateOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await clientFetch(`/api/access-governance/reviews/${encodeURIComponent(review.id)}`);
      const j = await r.json();
      if (j.ok) { setItems(j.review.items || []); setStatus(j.review.status); }
    } catch { /* keep */ }
  }, [review.id]);

  const decide = useCallback(async (decision: 'attest' | 'revoke', opts: { all?: boolean } = {}) => {
    const itemIds = opts.all ? undefined : [...sel];
    if (!opts.all && (!itemIds || itemIds.length === 0)) { setErr('Select at least one grant, or use an "all remaining" action.'); return; }
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await clientFetch(`/api/access-governance/reviews/${encodeURIComponent(review.id)}/decision`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(opts.all ? { decision, all: true } : { decision, itemIds }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setNote(`${decision === 'revoke' ? 'Revoked' : 'Attested'} ${j.decided} grant(s)${j.revoked != null ? ` (${j.revoked} backend revoke(s))` : ''}.`);
      setSel(new Set());
      await refresh(); onChanged();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [sel, review.id, refresh, onChanged]);

  const close = useCallback(async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await clientFetch(`/api/access-governance/reviews/${encodeURIComponent(review.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'close' }) });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setNote(`Campaign closed — ${j.autoRevoked ?? 0} undecided grant(s) auto-revoked.`);
      setStatus('closed'); await refresh(); onChanged();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [review.id, refresh, onChanged]);

  const delegate = useCallback(async (hit: any) => {
    if (!hit?.id) return;
    setBusy(true); setErr(null);
    try {
      const r = await clientFetch(`/api/access-governance/reviews/${encodeURIComponent(review.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delegate', delegatedTo: [{ type: hit.type === 'group' ? 'group' : 'user', id: hit.id, name: hit.displayName || hit.upn }] }) });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setNote('Delegated.'); setDelegateOpen(false); onChanged();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [review.id, onChanged]);

  const pending = useMemo(() => items.filter((i) => i.decision === 'pending').length, [items]);
  const allSelected = sel.size > 0 && sel.size === items.filter((i) => i.decision === 'pending').length;
  const toggleAll = () => {
    if (allSelected) setSel(new Set());
    else setSel(new Set(items.filter((i) => i.decision === 'pending').map((i) => i.id)));
  };
  const active = status === 'active';

  return (
    <>
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: '960px', width: '90vw' }}>
        <DialogBody>
          <DialogTitle>{review.name} {statusBadge(status)}</DialogTitle>
          <DialogContent>
            <div className={s.section}>
              <div className={s.actions}>
                <Button appearance="primary" size="small" icon={<CheckmarkCircle20Regular />} disabled={!active || busy || sel.size === 0} onClick={() => void decide('attest')}>Attest selected ({sel.size})</Button>
                <Button appearance="secondary" size="small" icon={<DismissCircle20Regular />} disabled={!active || busy || sel.size === 0} onClick={() => void decide('revoke')}>Revoke selected ({sel.size})</Button>
                <div className={s.spacer} />
                <Button appearance="subtle" size="small" disabled={!active || busy || pending === 0} onClick={() => void decide('attest', { all: true })}>Attest all remaining</Button>
                <Button appearance="subtle" size="small" disabled={!active || busy || pending === 0} onClick={() => void decide('revoke', { all: true })}>Revoke all remaining</Button>
                <Button appearance="subtle" size="small" icon={<PeopleTeam20Regular />} disabled={busy} onClick={() => setDelegateOpen(true)}>Delegate</Button>
                <Button appearance="subtle" size="small" icon={<Timer20Regular />} disabled={!active || busy} onClick={() => void close()}>Close campaign</Button>
              </div>

              {note && <MessageBar intent="success"><MessageBarBody>{note}</MessageBarBody></MessageBar>}
              {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}

              {items.length === 0 ? (
                <EmptyState icon={<ShieldTask24Regular />} title="No grants in scope" body="No active or eligible grants matched this campaign's scope when it was created." />
              ) : (
                <div className={s.scroll}>
                  <Table size="small" aria-label="Review items">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell><Checkbox checked={allSelected} onChange={toggleAll} disabled={!active} aria-label="Select all pending" /></TableHeaderCell>
                        <TableHeaderCell>Principal</TableHeaderCell>
                        <TableHeaderCell>Resource</TableHeaderCell>
                        <TableHeaderCell>Role</TableHeaderCell>
                        <TableHeaderCell>Decision</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map((it) => (
                        <TableRow key={it.id}>
                          <TableCell>
                            <Checkbox
                              checked={sel.has(it.id)}
                              disabled={!active || it.decision !== 'pending'}
                              onChange={() => setSel((prev) => { const n = new Set(prev); n.has(it.id) ? n.delete(it.id) : n.add(it.id); return n; })}
                              aria-label={`Select ${it.principalUpn || it.principalId}`}
                            />
                          </TableCell>
                          <TableCell>
                            <TableCellLayout media={it.principalType === 'Group' ? <Group20Regular /> : <Person20Regular />}>
                              <div className={s.cell}><span>{it.principalUpn || it.principalId}</span><Caption1 className={s.via}>{it.source}</Caption1></div>
                            </TableCellLayout>
                          </TableCell>
                          <TableCell><div className={s.cell}><span>{it.resourceName || it.resourceRef}</span><Caption1 className={s.via}>{it.resourceType}</Caption1></div></TableCell>
                          <TableCell>{it.role}</TableCell>
                          <TableCell><div className={s.badges}>{decisionBadge(it.decision)}{it.decidedBy && <Caption1 className={s.via}>{it.decidedBy}</Caption1>}</div></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>

      {delegateOpen && (
        <Dialog open onOpenChange={(_, d) => { if (!d.open) setDelegateOpen(false); }}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Delegate this review</DialogTitle>
              <DialogContent>
                <Field label="Delegate to" hint="The chosen reviewer(s) may act on this campaign in addition to the named reviewers.">
                  <IdentityPicker kind="all" onSelect={delegate} />
                </Field>
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setDelegateOpen(false)}>Close</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </>
  );
}

/** AG-9/AG-14 lifecycle actions: group-sync reconcile + leaver revoke-all. */
function LifecycleActions({ onDone, onError }: { onDone: (msg: string) => void; onError: (msg: string) => void }) {
  const s = useStyles();
  const [principal, setPrincipal] = useState('');
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState<{ remediation: string } | null>(null);

  const groupSync = useCallback(async () => {
    setBusy(true); setGate(null);
    try {
      const r = await clientFetch('/api/access-governance/group-sync', { method: 'POST' });
      const j = await r.json();
      if (j.gated) { setGate({ remediation: j.remediation }); return; }
      if (!j.ok) { onError(j.error || 'group-sync failed'); return; }
      onDone(`Group sync — ${j.granted ?? 0} granted, ${j.revoked ?? 0} revoked across ${j.groupTargetedPackages ?? 0} package(s).`);
    } catch (e: any) { onError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [onDone, onError]);

  const revokeAll = useCallback(async () => {
    if (!principal.trim()) return;
    setBusy(true);
    try {
      const r = await clientFetch('/api/access-governance/revoke-all', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ principalId: principal.trim() }) });
      const j = await r.json();
      if (!j.ok) { onError(j.error || 'revoke-all failed'); return; }
      onDone(`Leaver revoke-all — ${j.revoked ?? 0} of ${j.candidates ?? 0} grant(s) torn down for ${principal.trim()}.`);
      setPrincipal('');
    } catch (e: any) { onError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [principal, onDone, onError]);

  return (
    <div className={s.section}>
      <Subtitle2>Lifecycle</Subtitle2>
      {gate && (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Entra group sync is opt-in</MessageBarTitle>
            {gate.remediation} See the <a href="/admin/gates">gate registry</a> (graph-group-sync).
          </MessageBarBody>
        </MessageBar>
      )}
      <div className={s.lifecycle}>
        <Button appearance="secondary" icon={<PeopleTeam20Regular />} disabled={busy} onClick={() => void groupSync()}>Reconcile Entra group targets</Button>
        <Field label="Leaver revoke-all (principal object id)" style={{ minWidth: 320 }}>
          <Input value={principal} onChange={(_, d) => setPrincipal(d.value)} placeholder="8f2a…-oid"
            contentAfter={<Button appearance="transparent" size="small" icon={<PersonDelete20Regular />} disabled={busy || !principal.trim()} onClick={() => void revokeAll()} aria-label="Revoke all access for this principal" />} />
        </Field>
      </div>
      <Caption1 className={s.via}><ClipboardTaskListLtr24Regular style={{ fontSize: '14px', verticalAlign: 'middle' }} /> Revoke-all tears down every active/eligible grant for a departing principal through the real backend + entitlement ledger.</Caption1>
    </div>
  );
}
