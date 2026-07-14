'use client';

/**
 * CTS-08 — Copilot memory brain admin panel (Admin → Copilot → Long-term memory).
 *
 * Tenant-admin surface to browse every memory scope (per-user / per-workspace),
 * search within a scope, delete a single memory, bulk-purge a scope, and inspect
 * the CTS-12 write-audit trail. Fluent v9 + Loom tokens, EmptyState primitive, no
 * raw px. Real backend: /api/admin/copilot/memory{,/[id],/audit} (tenant-admin
 * gated). Honest gate: a 403 shows the exact admin bootstrap remediation.
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import {
  Body1, Caption1, Subtitle2, Badge, Button, Input, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, DialogTrigger,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  BrainCircuit20Regular, Delete16Regular, Search20Regular,
  ShieldTask16Regular, Person16Regular, People16Regular, ArrowLeft16Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';

interface ScopeSummary { scopeKey: string; scope: 'user' | 'workspace'; count: number }
interface MemoryRow {
  id: string; scopeKey: string; scope: string; content: string; category: string;
  confidence: number; tags: string[]; source: string; createdAt: string; recallCount?: number;
}
interface AuditRow {
  id: string; outcome: 'stored' | 'rejected'; reason?: string; detail?: string;
  flags: string[]; redacted: boolean; category?: string; source?: string; at: string;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  intro: { color: tokens.colorNeutralForeground2, lineHeight: 1.55 },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  headIcon: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '32px', height: '32px', flexShrink: 0, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1,
  },
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  scopeCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4, cursor: 'pointer',
    transitionProperty: 'box-shadow', transitionDuration: tokens.durationNormal,
    ':hover': { boxShadow: tokens.shadow16 },
  },
  scopeHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  scopeKey: { fontWeight: tokens.fontWeightSemibold, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  muted: { color: tokens.colorNeutralForeground3 },
  content: { maxWidth: '520px', whiteSpace: 'normal', wordBreak: 'break-word' },
  tableWrap: { overflowX: 'auto' },
});

export function CopilotMemoryPanel() {
  const styles = useStyles();
  const [scopes, setScopes] = useState<ScopeSummary[] | null>(null);
  const [selected, setSelected] = useState<ScopeSummary | null>(null);
  const [memories, setMemories] = useState<MemoryRow[] | null>(null);
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  const [view, setView] = useState<'memories' | 'audit'>('memories');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);

  const loadScopes = useCallback(() => {
    setLoading(true); setError(null);
    clientFetch('/api/admin/copilot/memory', { cache: 'no-store' })
      .then(async (r) => {
        if (r.status === 401 || r.status === 403) {
          const j = await r.json().catch(() => ({}));
          setGate(j?.remediation || 'Long-term memory administration is a tenant-admin surface. Set LOOM_TENANT_ADMIN_OID or join LOOM_TENANT_ADMIN_GROUP_ID.');
          return null;
        }
        return r.json();
      })
      .then((j: any) => {
        if (!j) return;
        if (j.ok) setScopes(j.scopes || []);
        else setError(j.error || 'Failed to load memory scopes');
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadScopes(); }, [loadScopes]);

  const openScope = useCallback((scope: ScopeSummary, query = '') => {
    setSelected(scope); setView('memories'); setMemories(null); setError(null);
    const url = `/api/admin/copilot/memory?scopeKey=${encodeURIComponent(scope.scopeKey)}${query ? `&q=${encodeURIComponent(query)}` : ''}`;
    clientFetch(url, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: any) => { if (j.ok) setMemories(j.memories || []); else setError(j.error || 'Failed to load memories'); })
      .catch((e) => setError(String(e)));
  }, []);

  const openAudit = useCallback((scope: ScopeSummary) => {
    setView('audit'); setAudit(null); setError(null);
    clientFetch(`/api/admin/copilot/memory/audit?scopeKey=${encodeURIComponent(scope.scopeKey)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: any) => { if (j.ok) setAudit(j.audit || []); else setError(j.error || 'Failed to load audit'); })
      .catch((e) => setError(String(e)));
  }, []);

  const deleteOne = useCallback((scope: ScopeSummary, id: string) => {
    setBusy(true);
    clientFetch(`/api/admin/copilot/memory/${encodeURIComponent(id)}?scopeKey=${encodeURIComponent(scope.scopeKey)}`, { method: 'DELETE' })
      .then((r) => r.json())
      .then((j: any) => { if (j.ok) { setMemories((cur) => (cur || []).filter((m) => m.id !== id)); } else setError(j.error || 'Delete failed'); })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  }, []);

  const purge = useCallback((scope: ScopeSummary) => {
    setBusy(true);
    clientFetch('/api/admin/copilot/memory', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'purge', scopeKey: scope.scopeKey }),
    })
      .then((r) => r.json())
      .then((j: any) => { if (j.ok) { setSelected(null); setMemories(null); loadScopes(); } else setError(j.error || 'Purge failed'); })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  }, [loadScopes]);

  if (loading) return <Spinner label="Loading memory scopes…" />;
  if (gate) return (
    <MessageBar intent="warning">
      <MessageBarBody><MessageBarTitle>Tenant-admin access required</MessageBarTitle>{gate}</MessageBarBody>
    </MessageBar>
  );

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <span className={styles.headIcon} aria-hidden><BrainCircuit20Regular /></span>
        <Subtitle2>Long-term memory</Subtitle2>
      </div>
      <Body1 className={styles.intro}>
        Durable facts and preferences the Copilot has learned across sessions, scoped to each user
        (private) or workspace (shared). Every write is injection-scanned, secret-redacted, and audited
        (CTS-12). Browse a scope to view, search, delete, or purge its memories, or inspect the write-audit
        trail. Recall is Azure-native — Cosmos + Azure AI Search vectors, no Fabric dependency.
      </Body1>

      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}

      {!selected && (
        (scopes && scopes.length > 0) ? (
          <div className={styles.grid}>
            {scopes.map((s) => (
              <div key={s.scopeKey} className={styles.scopeCard} role="button" tabIndex={0}
                   onClick={() => openScope(s)} onKeyDown={(e) => { if (e.key === 'Enter') openScope(s); }}>
                <div className={styles.scopeHead}>
                  {s.scope === 'workspace' ? <People16Regular /> : <Person16Regular />}
                  <span className={styles.scopeKey} title={s.scopeKey}>{s.scopeKey}</span>
                </div>
                <div className={styles.scopeHead}>
                  <Badge appearance="tint" color={s.scope === 'workspace' ? 'informative' : 'brand'}>{s.scope}</Badge>
                  <Caption1 className={styles.muted}>{s.count} {s.count === 1 ? 'memory' : 'memories'}</Caption1>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<BrainCircuit20Regular />}
            title="No memories yet"
            body="The Copilot has not captured any durable memories. As users chat and use Dump to Memory, scoped memories appear here for review."
          />
        )
      )}

      {selected && (
        <>
          <div className={styles.toolbar}>
            <Button icon={<ArrowLeft16Regular />} appearance="subtle" onClick={() => { setSelected(null); setMemories(null); setAudit(null); }}>
              All scopes
            </Button>
            <Badge appearance="tint" color={selected.scope === 'workspace' ? 'informative' : 'brand'}>{selected.scopeKey}</Badge>
            <div className={styles.spacer} />
            <Button appearance={view === 'memories' ? 'primary' : 'secondary'} onClick={() => openScope(selected, q)}>Memories</Button>
            <Button appearance={view === 'audit' ? 'primary' : 'secondary'} icon={<ShieldTask16Regular />} onClick={() => openAudit(selected)}>Write audit</Button>
            <Dialog>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="outline" icon={<Delete16Regular />} disabled={busy}>Purge scope</Button>
              </DialogTrigger>
              <DialogSurface>
                <DialogBody>
                  <DialogTitle>Purge all memories in this scope?</DialogTitle>
                  <DialogContent>
                    This permanently deletes every memory in <strong>{selected.scopeKey}</strong> from Cosmos and
                    the vector mirror. This cannot be undone.
                  </DialogContent>
                  <DialogActions>
                    <DialogTrigger disableButtonEnhancement><Button appearance="secondary">Cancel</Button></DialogTrigger>
                    <DialogTrigger disableButtonEnhancement>
                      <Button appearance="primary" onClick={() => purge(selected)}>Purge</Button>
                    </DialogTrigger>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>
          </div>

          {view === 'memories' && (
            <>
              <div className={styles.toolbar}>
                <Input contentBefore={<Search20Regular />} placeholder="Search within scope…" value={q}
                       onChange={(_, d) => setQ(d.value)}
                       onKeyDown={(e) => { if (e.key === 'Enter') openScope(selected, q); }} />
                <Button icon={<Search20Regular />} onClick={() => openScope(selected, q)}>Search</Button>
              </div>
              {!memories ? <Spinner label="Loading memories…" /> : memories.length === 0 ? (
                <EmptyState icon={<BrainCircuit20Regular />} title="No memories in this scope"
                            body="Nothing matches. Clear the search or pick another scope." />
              ) : (
                <div className={styles.tableWrap}>
                  <Table aria-label="Memories">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>Memory</TableHeaderCell>
                        <TableHeaderCell>Category</TableHeaderCell>
                        <TableHeaderCell>Conf.</TableHeaderCell>
                        <TableHeaderCell>Source</TableHeaderCell>
                        <TableHeaderCell>Recalls</TableHeaderCell>
                        <TableHeaderCell>Created</TableHeaderCell>
                        <TableHeaderCell aria-label="Actions" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {memories.map((m) => (
                        <TableRow key={m.id}>
                          <TableCell className={styles.content}>{m.content}</TableCell>
                          <TableCell><Badge appearance="outline">{m.category}</Badge></TableCell>
                          <TableCell>{(m.confidence ?? 0).toFixed(2)}</TableCell>
                          <TableCell><Caption1 className={styles.muted}>{m.source}</Caption1></TableCell>
                          <TableCell>{m.recallCount ?? 0}</TableCell>
                          <TableCell><Caption1 className={styles.muted}>{new Date(m.createdAt).toLocaleDateString()}</Caption1></TableCell>
                          <TableCell>
                            <Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy}
                                    aria-label="Delete memory" onClick={() => deleteOne(selected, m.id)} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}

          {view === 'audit' && (
            !audit ? <Spinner label="Loading write audit…" /> : audit.length === 0 ? (
              <EmptyState icon={<ShieldTask16Regular />} title="No write-audit records"
                          body="No memory writes have been screened in this scope yet." />
            ) : (
              <div className={styles.tableWrap}>
                <Table aria-label="Write audit">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Outcome</TableHeaderCell>
                      <TableHeaderCell>Reason</TableHeaderCell>
                      <TableHeaderCell>Flags</TableHeaderCell>
                      <TableHeaderCell>Category</TableHeaderCell>
                      <TableHeaderCell>When</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {audit.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell>
                          <Badge appearance="tint" color={a.outcome === 'stored' ? 'success' : 'danger'}>{a.outcome}</Badge>
                        </TableCell>
                        <TableCell><Caption1>{a.reason || (a.redacted ? 'secret redacted' : '—')}</Caption1></TableCell>
                        <TableCell><Caption1 className={styles.muted}>{(a.flags || []).join(', ') || '—'}</Caption1></TableCell>
                        <TableCell><Caption1 className={styles.muted}>{a.category || '—'}</Caption1></TableCell>
                        <TableCell><Caption1 className={styles.muted}>{new Date(a.at).toLocaleString()}</Caption1></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}
