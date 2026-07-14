'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * AttachServiceWizard — attach an EXISTING brownfield Azure service to a Loom
 * landing zone (§2.2). Four steps in one flowing dialog:
 *
 *   1. Discover — GET /api/landing-zones/discover (Azure Resource Graph, the
 *      caller's RBAC + ABAC across every subscription) → candidates grouped by
 *      subscription, decorated with the item-type-visual icons the rest of Loom
 *      uses, filterable by kind + free text.
 *   2. Pick — multi-select checkboxes (never a free-text resource id —
 *      loom_no_freeform_config).
 *   3. Validate — POST …/attach/preflight → real reachability / network-posture /
 *      RBAC verdict per pick, each an honest badge + MessageBar (no-vaporware.md).
 *   4. Register — POST …/attach → writes the registry docs, returns a receipt
 *      (what registered, what still needs a manual grant / PE path).
 *
 * Fluent v9 + Loom tokens; no raw px, no JSON textarea.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Input, Dropdown, Option, Badge, Spinner, Caption1, Body1, Checkbox, Divider,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, CheckmarkCircle20Filled, ArrowSync16Regular, Search20Regular,
  PlugConnected24Regular, ShieldCheckmark20Regular, Warning20Regular,
} from '@fluentui/react-icons';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import {
  ATTACHED_KIND_DEFS, getKindDef, kindLabel, type AttachedServiceKind,
} from '@/lib/azure/attached-service-kinds';
import type { AttachedServiceCandidate } from '@/lib/azure/attached-discovery';
import { CreateLandingZoneStep } from '@/lib/components/landing-zones/create-landing-zone-step';

/** Client-safe base64url encode of a `${sub}/${rg}` landing-zone id for the path. */
function encodeLzIdForPath(id: string): string {
  if (!id.includes('/')) return id; // 'hub' etc. — readable
  const b64 = btoa(unescape(encodeURIComponent(id)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '640px', maxWidth: '820px' },
  meta: { color: tokens.colorNeutralForeground3 },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  search: { flex: 1, minWidth: '220px' },
  statusRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, maxHeight: '44vh', overflowY: 'auto', paddingRight: tokens.spacingHorizontalXS },
  group: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  subHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, marginBottom: tokens.spacingVerticalXXS },
  row: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalS, paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  rowIcon: { flexShrink: 0, display: 'inline-flex', fontSize: '20px' },
  rowText: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  rowName: { fontWeight: tokens.fontWeightSemibold, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  rowSub: { color: tokens.colorNeutralForeground3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  verdictBadges: { display: 'flex', gap: tokens.spacingHorizontalXS, flexShrink: 0, flexWrap: 'wrap' },
  empty: { color: tokens.colorNeutralForeground3, padding: tokens.spacingVerticalM, textAlign: 'center' },
  footerNote: { color: tokens.colorNeutralForeground3 },
});

interface DiscoverResponse {
  ok: boolean;
  candidates?: AttachedServiceCandidate[];
  via?: 'user' | 'uami';
  code?: string;
  error?: string;
}

interface PreflightVerdict {
  armResourceId: string;
  kind: AttachedServiceKind;
  reachability: 'reachable' | 'private-endpoint-needed' | 'blocked' | 'unknown';
  networkPosture: 'public' | 'private-endpoint' | 'service-endpoint' | 'unknown';
  rbacState: 'granted' | 'pending' | 'manual-gate';
  rbacRoleName: string;
  ok: boolean;
  remediation: string | null;
}

interface AttachReceipt {
  ok: boolean;
  registered?: Array<{ id: string; displayName: string; kind: string }>;
  manualActions?: Array<{ armResourceId: string; action: string }>;
  errors?: Array<{ armResourceId: string; error: string }>;
  receipt?: { attached: number; failed: number; note: string };
}

function shortSub(sub: string): string {
  return sub && sub.length > 14 ? `${sub.slice(0, 8)}…${sub.slice(-4)}` : sub || 'unknown';
}

function reachabilityBadge(v: PreflightVerdict['reachability']) {
  switch (v) {
    case 'reachable':
      return <Badge appearance="tint" color="success" size="small" icon={<CheckmarkCircle20Filled />}>Reachable</Badge>;
    case 'private-endpoint-needed':
      return <Badge appearance="tint" color="warning" size="small" icon={<Warning20Regular />}>PE needed</Badge>;
    case 'blocked':
      return <Badge appearance="tint" color="danger" size="small">Blocked</Badge>;
    default:
      return <Badge appearance="tint" color="informative" size="small">Unknown</Badge>;
  }
}

export function AttachServiceWizard({
  open, onClose, landingZoneId, landingZoneLabel, onAttached,
}: {
  open: boolean;
  onClose: () => void;
  /**
   * `${sub}/${rg}` of a DLZ, a logical LZ slug, or 'hub' for admin-plane
   * services. When OMITTED, the wizard opens on a step-0 landing-zone SELECTOR
   * (pick hub / a DLZ / a logical LZ, or create a new logical LZ) before the
   * discover→multi-select→attach flow — this is the top-level "Attach existing
   * services" entry point that isn't scoped to a specific DLZ drawer.
   */
  landingZoneId?: string;
  landingZoneLabel?: string;
  onAttached?: () => void;
}) {
  const s = useStyles();
  const [candidates, setCandidates] = useState<AttachedServiceCandidate[]>([]);
  const [via, setVia] = useState<'user' | 'uami' | null>(null);
  const [loading, setLoading] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [verdicts, setVerdicts] = useState<Record<string, PreflightVerdict>>({});
  const [validating, setValidating] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [receipt, setReceipt] = useState<AttachReceipt | null>(null);

  // ── Step-0 landing-zone selector (only when no fixed landingZoneId prop) ──────
  // The wizard can be opened un-scoped (top-level "Attach existing services"); the
  // operator then picks the target LZ — hub, any discovered DLZ, any logical LZ —
  // or creates a new logical LZ inline, all before discovery runs.
  const [pickedLzId, setPickedLzId] = useState('');
  const [pickedLzLabel, setPickedLzLabel] = useState('');
  const [creatingNew, setCreatingNew] = useState(false);
  const [lzOptions, setLzOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [lzLoading, setLzLoading] = useState(false);

  // The LZ the attach flow operates on: the fixed prop, else the step-0 pick.
  const activeLzId = landingZoneId ?? (pickedLzId || '');
  const activeLzLabel = landingZoneLabel ?? (pickedLzLabel || '');
  // When un-scoped and no LZ chosen yet, we're on the selector step (not discovery).
  const onSelectorStep = !landingZoneId && !activeLzId;

  const encodedLz = useMemo(() => encodeLzIdForPath(activeLzId || 'hub'), [activeLzId]);

  // Load the LZ choices (hub + DLZs + logical LZs) for the step-0 dropdown.
  const loadLzOptions = useCallback(async () => {
    setLzLoading(true);
    try {
      const res = await clientFetch('/api/setup/landing-zones');
      const j = await res.json().catch(() => ({}));
      const opts: Array<{ id: string; label: string }> = [{ id: 'hub', label: 'Hub (admin plane)' }];
      if (res.ok && j.ok && Array.isArray(j.landingZones)) {
        for (const z of j.landingZones) {
          opts.push({
            id: z.id,
            label: `${z.domainName || z.id}${z.logical ? ' (logical)' : ''}${z.region ? ` · ${z.region}` : ''}`,
          });
        }
      }
      setLzOptions(opts);
    } catch {
      setLzOptions([{ id: 'hub', label: 'Hub (admin plane)' }]);
    } finally {
      setLzLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setGate(null); setError(null); setVerdicts({}); setReceipt(null);
    try {
      const res = await clientFetch('/api/landing-zones/discover');
      const j: DiscoverResponse = await res.json();
      if (j.ok && Array.isArray(j.candidates)) {
        setCandidates(j.candidates);
        setVia(j.via ?? null);
      } else if (j.code === 'no_access') {
        setCandidates([]);
        setGate(j.error || 'No access to Azure resources.');
      } else {
        setCandidates([]);
        setError(j.error || `Request failed (HTTP ${res.status}).`);
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set()); setVerdicts({}); setReceipt(null);
    if (landingZoneId) {
      // Fixed-scope open (from a DLZ drawer / hub card) — go straight to discovery.
      void load();
    } else {
      // Un-scoped open — reset the step-0 selector and load the LZ choices.
      setPickedLzId(''); setPickedLzLabel(''); setCreatingNew(false);
      void loadLzOptions();
    }
  }, [open, landingZoneId, load, loadLzOptions]);

  // Once an un-scoped wizard has a chosen LZ (picked or freshly created), run
  // discovery against it.
  useEffect(() => {
    if (open && !landingZoneId && activeLzId && !creatingNew) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, landingZoneId, activeLzId, creatingNew]);

  const kindsPresent = useMemo(() => {
    const set = new Set(candidates.map((c) => c.kind));
    return ATTACHED_KIND_DEFS.filter((d) => set.has(d.kind)).map((d) => d.kind);
  }, [candidates]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return candidates.filter((c) => {
      if (kindFilter !== 'all' && c.kind !== kindFilter) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        (c.resourceGroup || '').toLowerCase().includes(q) ||
        (c.subscriptionName || '').toLowerCase().includes(q)
      );
    });
  }, [candidates, search, kindFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, { label: string; items: AttachedServiceCandidate[] }>();
    for (const c of filtered) {
      const key = c.subscriptionId || 'unknown';
      if (!map.has(key)) map.set(key, { label: c.subscriptionName || shortSub(key), items: [] });
      map.get(key)!.items.push(c);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[1].label.localeCompare(b[1].label))
      .map(([sub, v]) => ({ sub, ...v }));
  }, [filtered]);

  const toggle = (armId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(armId)) next.delete(armId); else next.add(armId);
      return next;
    });
    setReceipt(null);
  };

  const selectedCandidates = useMemo(
    () => candidates.filter((c) => selected.has(c.armResourceId)),
    [candidates, selected],
  );

  const runPreflight = useCallback(async () => {
    if (selectedCandidates.length === 0) return;
    setValidating(true); setError(null); setReceipt(null);
    try {
      const res = await clientFetch(`/api/landing-zones/${encodedLz}/attach/preflight`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ services: selectedCandidates.map((c) => ({ armResourceId: c.armResourceId, kind: c.kind })) }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) { setError(j?.error || `HTTP ${res.status}`); return; }
      const map: Record<string, PreflightVerdict> = {};
      for (const r of (j.results as PreflightVerdict[]) || []) map[r.armResourceId] = r;
      setVerdicts(map);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setValidating(false);
    }
  }, [encodedLz, selectedCandidates]);

  const runAttach = useCallback(async () => {
    if (selectedCandidates.length === 0) return;
    setAttaching(true); setError(null);
    try {
      const res = await clientFetch(`/api/landing-zones/${encodedLz}/attach`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          services: selectedCandidates.map((c) => ({ armResourceId: c.armResourceId, kind: c.kind, displayName: c.name })),
        }),
      });
      const j: AttachReceipt = await res.json();
      setReceipt(j);
      if (j.receipt && j.receipt.attached > 0) onAttached?.();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setAttaching(false);
    }
  }, [encodedLz, selectedCandidates, onAttached]);

  const hasVerdicts = Object.keys(verdicts).length > 0;

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            <span className={s.statusRow}>
              <PlugConnected24Regular /> Attach existing service{onSelectorStep ? 's' : ''}
              {activeLzLabel && !onSelectorStep && <Badge appearance="outline" size="small">{activeLzLabel}</Badge>}
            </span>
          </DialogTitle>
          <DialogContent>
            {/* ── Step 0: landing-zone selector (un-scoped open only) ─────────── */}
            {onSelectorStep && !creatingNew && (
              <div className={s.body}>
                <Body1 className={s.meta}>
                  Choose the landing zone to attach existing Azure services to — the hub, any Data
                  Landing Zone, or a lightweight logical landing zone — or create a new logical
                  landing zone to group them under.
                </Body1>
                <Dropdown
                  placeholder={lzLoading ? 'Loading landing zones…' : 'Select a landing zone'}
                  disabled={lzLoading}
                  onOptionSelect={(_, d) => {
                    const id = d.optionValue || '';
                    if (id === '__new__') { setCreatingNew(true); return; }
                    setPickedLzId(id);
                    setPickedLzLabel(lzOptions.find((o) => o.id === id)?.label || id);
                  }}
                >
                  {lzOptions.map((o) => (
                    <Option key={o.id} value={o.id} text={o.label}>{o.label}</Option>
                  ))}
                  <Option value="__new__" text="＋ New landing zone">＋ New landing zone</Option>
                </Dropdown>
                {lzLoading && <Spinner size="tiny" label="Loading landing zones…" />}
              </div>
            )}

            {/* ── Step 0b: create a new logical landing zone inline ───────────── */}
            {onSelectorStep && creatingNew && (
              <CreateLandingZoneStep
                onBack={() => setCreatingNew(false)}
                onCreated={(id, name) => {
                  setCreatingNew(false);
                  setPickedLzId(id);
                  setPickedLzLabel(name);
                }}
              />
            )}

            {/* ── Discover → multi-select → validate → register ──────────────── */}
            {!onSelectorStep && (
            <div className={s.body}>
              <Body1 className={s.meta}>
                Bind an existing Azure service you already own to this landing zone so it becomes part
                of Loom. We discover the resources your Azure role assignments can reach (RBAC + ABAC)
                across every subscription — pick one or more, validate, and attach. Attaching never
                creates or deletes your Azure resource; Loom only borrows it.
              </Body1>

              <div className={s.toolbar}>
                <Input
                  className={s.search}
                  value={search}
                  placeholder="Search by name, resource group, subscription…"
                  contentBefore={<Search20Regular />}
                  onChange={(_, d) => setSearch(d.value)}
                />
                <Dropdown
                  value={kindFilter === 'all' ? 'All kinds' : kindLabel(kindFilter)}
                  selectedOptions={[kindFilter]}
                  onOptionSelect={(_, d) => setKindFilter(d.optionValue || 'all')}
                >
                  <Option value="all">All kinds</Option>
                  {kindsPresent.map((k) => (
                    <Option key={k} value={k}>{kindLabel(k)}</Option>
                  ))}
                </Dropdown>
                <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} disabled={loading} onClick={load} aria-label="Refresh discovery" />
              </div>

              <div className={s.statusRow}>
                {loading && <Spinner size="tiny" label="Discovering attachable Azure resources…" />}
                {!loading && via && (
                  <Badge appearance="tint" color={via === 'user' ? 'brand' : 'informative'} size="small"
                    title={via === 'user' ? 'Resolved with your Azure RBAC + ABAC' : 'Resolved with the Loom managed identity'}>
                    {via === 'user' ? 'your RBAC' : 'managed identity'}
                  </Badge>
                )}
                {!loading && !gate && !error && (
                  <Caption1 className={s.meta}>
                    {filtered.length} of {candidates.length} resource{candidates.length === 1 ? '' : 's'} · {selected.size} selected
                  </Caption1>
                )}
              </div>

              {gate && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>No Azure resources visible</MessageBarTitle>
                    {gate}
                  </MessageBarBody>
                </MessageBar>
              )}
              {error && (
                <MessageBar intent="error">
                  <MessageBarBody>
                    <MessageBarTitle>Could not discover / attach</MessageBarTitle>
                    {error}
                  </MessageBarBody>
                </MessageBar>
              )}

              {!loading && !gate && (
                <div className={s.list}>
                  {filtered.length === 0 && !error && <div className={s.empty}>No matching resources.</div>}
                  {grouped.map((g) => (
                    <div key={g.sub} className={s.group}>
                      <div className={s.subHeader}>
                        <Badge appearance="outline" size="small" color="informative">Subscription</Badge>
                        <Caption1 className={s.meta} title={g.sub}>{g.label}</Caption1>
                      </div>
                      <Divider />
                      {g.items.map((c) => {
                        const def = getKindDef(c.kind);
                        const visual = itemVisual(def?.tileSlug || c.kind);
                        const Icon = visual.icon;
                        const checked = selected.has(c.armResourceId);
                        const v = verdicts[c.armResourceId];
                        return (
                          <div key={c.armResourceId} className={s.row}>
                            <Checkbox checked={checked} onChange={() => toggle(c.armResourceId)} aria-label={`Select ${c.name}`} />
                            <span className={s.rowIcon} style={{ color: visual.color }}><Icon /></span>
                            <span className={s.rowText}>
                              <span className={s.rowName} title={c.name}>{c.name}</span>
                              <Caption1 className={s.rowSub} title={`${kindLabel(c.kind)} · ${c.resourceGroup} · ${c.location || ''}`}>
                                {kindLabel(c.kind)}{c.resourceGroup ? ` · ${c.resourceGroup}` : ''}{c.location ? ` · ${c.location}` : ''}
                              </Caption1>
                            </span>
                            <span className={s.verdictBadges}>
                              {v && reachabilityBadge(v.reachability)}
                              {v && v.networkPosture === 'private-endpoint' && (
                                <Badge appearance="outline" size="small" color="warning">private-endpoint</Badge>
                              )}
                              {v && <Badge appearance="outline" size="small" color="informative" title={`Needs role: ${v.rbacRoleName}`}>RBAC: {v.rbacState}</Badge>}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}

              {/* Validate-step gate summary */}
              {hasVerdicts && !receipt && (
                <MessageBar intent={Object.values(verdicts).every((v) => v.ok) ? 'success' : 'warning'}>
                  <MessageBarBody>
                    <MessageBarTitle>Preflight complete</MessageBarTitle>
                    {Object.values(verdicts).every((v) => v.ok)
                      ? 'All selected resources are reachable. They still need their navigator RBAC granted after attach (each resource shows the role it needs).'
                      : 'Some selected resources are private-endpoint-locked or unreachable. You can still attach them — Loom records the exact remediation — but their data plane will honest-gate until the network / RBAC action is taken.'}
                  </MessageBarBody>
                </MessageBar>
              )}

              {/* Register-step receipt */}
              {receipt && (
                <MessageBar intent={receipt.receipt && receipt.receipt.failed === 0 ? 'success' : 'warning'}>
                  <MessageBarBody>
                    <MessageBarTitle>
                      {receipt.receipt?.attached ?? 0} attached{receipt.receipt?.failed ? `, ${receipt.receipt.failed} failed` : ''}
                    </MessageBarTitle>
                    {receipt.receipt?.note}
                    {!!receipt.manualActions?.length && (
                      <ul style={{ margin: `${tokens.spacingVerticalS} 0 0`, paddingLeft: tokens.spacingHorizontalL }}>
                        {receipt.manualActions.slice(0, 6).map((m, i) => (
                          <li key={i}><Caption1>{m.action}</Caption1></li>
                        ))}
                      </ul>
                    )}
                    {!!receipt.errors?.length && (
                      <div style={{ marginTop: tokens.spacingVerticalS }}>
                        {receipt.errors.map((e, i) => <Caption1 key={i} block>{e.armResourceId}: {e.error}</Caption1>)}
                      </div>
                    )}
                  </MessageBarBody>
                </MessageBar>
              )}
            </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>{receipt ? 'Done' : 'Cancel'}</Button>
            {/* Un-scoped wizard: let the operator switch the target LZ back at the selector. */}
            {!landingZoneId && activeLzId && !onSelectorStep && !receipt && (
              <Button
                appearance="subtle"
                onClick={() => { setPickedLzId(''); setPickedLzLabel(''); setCreatingNew(false); setCandidates([]); setSelected(new Set()); setVerdicts({}); void loadLzOptions(); }}
              >
                Change landing zone
              </Button>
            )}
            {!onSelectorStep && !receipt && (
              <Button
                appearance="outline"
                icon={validating ? <Spinner size="tiny" /> : <ShieldCheckmark20Regular />}
                disabled={selected.size === 0 || validating}
                onClick={runPreflight}
              >
                {validating ? 'Validating…' : `Validate ${selected.size || ''}`}
              </Button>
            )}
            {!onSelectorStep && !receipt && (
              <Button
                appearance="primary"
                icon={attaching ? <Spinner size="tiny" /> : <Add20Regular />}
                disabled={selected.size === 0 || attaching}
                onClick={runAttach}
              >
                {attaching ? 'Attaching…' : `Attach ${selected.size || ''}`}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default AttachServiceWizard;
