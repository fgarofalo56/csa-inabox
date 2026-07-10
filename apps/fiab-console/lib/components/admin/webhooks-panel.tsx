'use client';

/**
 * /admin/webhooks — outbound webhook / event-subscription registry UI
 * (BR-WEBHOOK). Wired to the REAL routes under /api/admin/webhooks/*:
 *   - list / create        → GET|POST /api/admin/webhooks
 *   - detail + history      → GET       /api/admin/webhooks/[id]
 *   - edit / enable / delete→ PATCH|DELETE /api/admin/webhooks/[id]
 *   - test fire (real POST) → POST      /api/admin/webhooks/[id]/test
 *
 * Registration is a guided wizard (Fluent v9 + Loom tokens): name, https URL,
 * optional signing secret (auto-generated when blank), and an event-type
 * multi-select rendered as grouped checkboxes (loom_no_freeform_config — never
 * a JSON/textarea field). Per-hook delivery history + a test-fire button give a
 * live receipt. No mocks — every action calls the backend (no-vaporware.md).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  makeStyles, tokens, Button, Input, Field, Checkbox, Switch,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Badge, Spinner, Skeleton, SkeletonItem, MessageBar, MessageBarBody, MessageBarTitle, Text, Caption1,
  Accordion, AccordionItem, AccordionHeader, AccordionPanel,
} from '@fluentui/react-components';
import {
  Add24Regular, Delete24Regular, Send24Regular, Edit24Regular, History24Regular,
  Flow24Regular, ShieldKeyhole24Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { LOOM_EVENT_GROUPS, type LoomEventType } from '@/lib/events/event-types';
import { GuidedEmptyState } from '@/lib/components/shared/guided-empty-state';
import { LOOM_ACCENT } from '@/lib/components/shared/accent-tokens';

interface HookView {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  secretSet: boolean;
  createdAt: string;
  stats?: { delivered: number; failed: number; lastAttemptAt?: string; lastStatus?: number };
}
interface Delivery {
  id: string;
  eventType: string;
  outcome: 'delivered' | 'failed';
  status: number;
  attempts: number;
  transport: 'direct' | 'eventgrid';
  responseSnippet?: string;
  at: string;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  eventGroups: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  eventGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: tokens.spacingVerticalXS, columnGap: tokens.spacingHorizontalL,
  },
  groupLabel: { fontWeight: tokens.fontWeightSemibold, marginBottom: tokens.spacingVerticalXS },
  urlCell: { maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowActions: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  wizardFields: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '520px', maxWidth: '640px' },
  delivRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
  skeletonList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, paddingTop: tokens.spacingVerticalS },
  skeletonRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalL },
});

const ALL_EVENT_TYPES: LoomEventType[] = LOOM_EVENT_GROUPS.flatMap((g) => g.events.map((e) => e.type));

export function WebhooksPanel() {
  const styles = useStyles();
  const [hooks, setHooks] = useState<HookView[]>([]);
  const [eventGrid, setEventGrid] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Wizard state
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [wName, setWName] = useState('');
  const [wUrl, setWUrl] = useState('');
  const [wSecret, setWSecret] = useState('');
  const [wEvents, setWEvents] = useState<Set<string>>(new Set());
  const [wEnabled, setWEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [wizardError, setWizardError] = useState<string | null>(null);

  // Delivery history
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await clientFetch('/api/admin/webhooks');
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setHooks(json.hooks || []);
      setEventGrid(!!json.eventGrid);
    } catch (e: any) {
      setError(e?.message || 'Failed to load webhooks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openCreate = () => {
    setEditingId(null);
    setWName(''); setWUrl(''); setWSecret(''); setWEvents(new Set()); setWEnabled(true);
    setWizardError(null); setWizardOpen(true);
  };
  const openEdit = (h: HookView) => {
    setEditingId(h.id);
    setWName(h.name); setWUrl(h.url); setWSecret('');
    setWEvents(new Set(h.events.includes('*') ? ALL_EVENT_TYPES : h.events));
    setWEnabled(h.enabled); setWizardError(null); setWizardOpen(true);
  };

  const toggleEvent = (t: string) => {
    setWEvents((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  };
  const allSelected = wEvents.size === ALL_EVENT_TYPES.length;
  const toggleAll = () => setWEvents(allSelected ? new Set() : new Set(ALL_EVENT_TYPES));

  const submitWizard = async () => {
    setSaving(true);
    setWizardError(null);
    try {
      const events = allSelected ? ['*'] : [...wEvents];
      const payload: Record<string, unknown> = { name: wName, url: wUrl, events, enabled: wEnabled };
      if (wSecret.trim()) payload.secret = wSecret.trim();
      const res = editingId
        ? await clientFetch(`/api/admin/webhooks/${editingId}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
          })
        : await clientFetch('/api/admin/webhooks', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
          });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setWizardOpen(false);
      setNotice(editingId ? 'Webhook updated.' : 'Webhook registered.');
      await load();
    } catch (e: any) {
      setWizardError(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (h: HookView) => {
    try {
      const res = await clientFetch(`/api/admin/webhooks/${h.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !h.enabled }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await load();
    } catch (e: any) {
      setError(e?.message || 'Toggle failed');
    }
  };

  const removeHook = async (h: HookView) => {
    if (!confirm(`Delete webhook "${h.name}"? Its delivery history is also removed.`)) return;
    try {
      const res = await clientFetch(`/api/admin/webhooks/${h.id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setNotice('Webhook deleted.');
      await load();
    } catch (e: any) {
      setError(e?.message || 'Delete failed');
    }
  };

  const testFire = async (h: HookView) => {
    setNotice(null); setError(null);
    try {
      const res = await clientFetch(`/api/admin/webhooks/${h.id}/test`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      const d = json.delivery;
      setNotice(
        `Test event ${d.outcome === 'delivered' ? 'delivered' : 'failed'} — HTTP ${d.status} ` +
        `via ${d.transport} after ${d.attempts} attempt(s).`,
      );
      if (historyFor === h.id) await openHistory(h.id);
      await load();
    } catch (e: any) {
      setError(e?.message || 'Test fire failed');
    }
  };

  const openHistory = async (id: string) => {
    setHistoryFor(id); setHistoryLoading(true); setDeliveries([]);
    try {
      const res = await clientFetch(`/api/admin/webhooks/${id}`);
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setDeliveries(json.deliveries || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load history');
    } finally {
      setHistoryLoading(false);
    }
  };

  return (
    <div className={styles.root}>
      {error && (
        <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
      )}
      {notice && (
        <MessageBar intent="success"><MessageBarBody>{notice}</MessageBarBody></MessageBar>
      )}
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Delivery transport</MessageBarTitle>
          {eventGrid
            ? 'Events fan out through your Azure Event Grid custom topic (LOOM_EVENTGRID_TOPIC_ENDPOINT is set).'
            : 'Events are delivered by direct HTTPS POST with an HMAC-SHA256 signature (X-Loom-Signature) — the zero-infra default. To route through Azure Event Grid instead, set LOOM_EVENTGRID_TOPIC_ENDPOINT + LOOM_EVENTGRID_TOPIC_KEY (see platform/fiab/bicep/modules/admin-plane/event-grid-webhooks.bicep).'}
        </MessageBarBody>
      </MessageBar>

      <div className={styles.toolbar}>
        <Text weight="semibold">Registered endpoints ({hooks.length})</Text>
        <div className={styles.spacer} />
        <Button appearance="primary" icon={<Add24Regular />} onClick={openCreate}>Register webhook</Button>
      </div>

      {loading ? (
        <div className={styles.skeletonList} aria-label="Loading webhooks">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className={styles.skeletonRow}>
              <Skeleton aria-label="" style={{ flex: 1 }}><SkeletonItem shape="rectangle" style={{ height: '18px' }} /></Skeleton>
              <Skeleton aria-label="" style={{ width: '140px' }}><SkeletonItem shape="rectangle" style={{ height: '18px' }} /></Skeleton>
              <Skeleton aria-label="" style={{ width: '90px' }}><SkeletonItem shape="rectangle" style={{ height: '18px' }} /></Skeleton>
            </div>
          ))}
        </div>
      ) : hooks.length === 0 ? (
        <GuidedEmptyState
          title="No webhooks registered yet"
          intro="Register an outbound endpoint to receive Loom events — item lifecycle, workspace changes, pipeline-run outcomes, marketplace subscribe / SLA-breach, and admin-plane mutations."
          heroIcon={Flow24Regular}
          ariaLabel="No webhooks registered"
          columns={2}
          paths={[
            {
              key: 'register',
              title: 'Register a webhook',
              body: 'Name it, point it at an HTTPS URL, and pick the event types to receive — no JSON, just grouped checkboxes.',
              icon: Add24Regular,
              accent: LOOM_ACCENT.blue,
              onClick: openCreate,
            },
            {
              key: 'signing',
              title: 'Verify signatures',
              body: 'Each delivery is signed with HMAC-SHA256 (X-Loom-Signature). Learn how to validate it on your receiver.',
              icon: ShieldKeyhole24Regular,
              accent: LOOM_ACCENT.teal,
              href: 'https://learn.microsoft.com/azure/event-grid/receive-events',
            },
          ]}
        />
      ) : (
        <Table aria-label="Registered webhooks" size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Endpoint</TableHeaderCell>
              <TableHeaderCell>Events</TableHeaderCell>
              <TableHeaderCell>Delivered / Failed</TableHeaderCell>
              <TableHeaderCell>Enabled</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {hooks.map((h) => (
              <TableRow key={h.id}>
                <TableCell>{h.name}</TableCell>
                <TableCell><span className={styles.urlCell} title={h.url}>{h.url}</span></TableCell>
                <TableCell>
                  <Badge appearance="tint" color="informative">
                    {h.events.includes('*') ? 'all events' : `${h.events.length} type(s)`}
                  </Badge>
                </TableCell>
                <TableCell>
                  {h.stats ? `${h.stats.delivered} / ${h.stats.failed}` : '0 / 0'}
                </TableCell>
                <TableCell>
                  <Switch checked={h.enabled} onChange={() => toggleEnabled(h)} aria-label={`Enable ${h.name}`} />
                </TableCell>
                <TableCell>
                  <div className={styles.rowActions}>
                    <Button size="small" icon={<Send24Regular />} onClick={() => testFire(h)}>Test</Button>
                    <Button size="small" icon={<History24Regular />} onClick={() => openHistory(h.id)}>History</Button>
                    <Button size="small" icon={<Edit24Regular />} onClick={() => openEdit(h)}>Edit</Button>
                    <Button size="small" icon={<Delete24Regular />} onClick={() => removeHook(h)}>Delete</Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {historyFor && (
        <Accordion collapsible defaultOpenItems={['h']}>
          <AccordionItem value="h">
            <AccordionHeader>Delivery history — last {deliveries.length} attempts</AccordionHeader>
            <AccordionPanel>
              {historyLoading ? (
                <Spinner size="tiny" label="Loading…" />
              ) : deliveries.length === 0 ? (
                <Caption1>No deliveries logged yet. Use “Test” to fire a signed event.</Caption1>
              ) : (
                <div className={styles.eventGroups}>
                  {deliveries.map((d) => (
                    <div key={d.id} className={styles.delivRow}>
                      <Badge appearance="filled" color={d.outcome === 'delivered' ? 'success' : 'danger'}>
                        {d.outcome}
                      </Badge>
                      <span className={styles.mono}>{d.eventType}</span>
                      <Caption1>HTTP {d.status} · {d.attempts} attempt(s) · {d.transport}</Caption1>
                      <Caption1>{new Date(d.at).toLocaleString()}</Caption1>
                      {d.responseSnippet && <Caption1 className={styles.mono}>{d.responseSnippet}</Caption1>}
                    </div>
                  ))}
                </div>
              )}
            </AccordionPanel>
          </AccordionItem>
        </Accordion>
      )}

      <Dialog open={wizardOpen} onOpenChange={(_, d) => setWizardOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{editingId ? 'Edit webhook' : 'Register webhook'}</DialogTitle>
            <DialogContent>
              <div className={styles.wizardFields}>
                {wizardError && (
                  <MessageBar intent="error"><MessageBarBody>{wizardError}</MessageBarBody></MessageBar>
                )}
                <Field label="Name" required>
                  <Input value={wName} onChange={(_, d) => setWName(d.value)} placeholder="e.g. Ops PagerDuty bridge" />
                </Field>
                <Field label="Endpoint URL (https)" required hint="Must be https. Loopback / link-local / IMDS hosts are rejected.">
                  <Input value={wUrl} onChange={(_, d) => setWUrl(d.value)} placeholder="https://example.com/hooks/loom" />
                </Field>
                <Field
                  label="Signing secret (HMAC-SHA256)"
                  hint={editingId
                    ? 'Leave blank to keep the current secret. Deliveries are signed with X-Loom-Signature.'
                    : 'Leave blank to auto-generate a strong secret. Deliveries are signed with X-Loom-Signature.'}
                >
                  <Input value={wSecret} onChange={(_, d) => setWSecret(d.value)} type="password" placeholder={editingId ? '•••••••• (unchanged)' : 'auto-generated when blank'} />
                </Field>
                <Field label="Event types" required hint="The endpoint receives only the checked events.">
                  <div className={styles.eventGroups}>
                    <Checkbox label="All events" checked={allSelected} onChange={toggleAll} />
                    {LOOM_EVENT_GROUPS.map((g) => (
                      <div key={g.group}>
                        <div className={styles.groupLabel}>{g.group}</div>
                        <div className={styles.eventGrid}>
                          {g.events.map((e) => (
                            <Checkbox
                              key={e.type}
                              label={e.label}
                              checked={wEvents.has(e.type)}
                              onChange={() => toggleEvent(e.type)}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </Field>
                <Switch label="Enabled" checked={wEnabled} onChange={(_, d) => setWEnabled(d.checked)} />
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setWizardOpen(false)} disabled={saving}>Cancel</Button>
              <Button appearance="primary" onClick={submitWizard} disabled={saving}>
                {saving ? <Spinner size="tiny" /> : editingId ? 'Save changes' : 'Register'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
