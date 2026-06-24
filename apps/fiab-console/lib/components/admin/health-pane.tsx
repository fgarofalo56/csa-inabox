'use client';

/**
 * Loom Health — self-audit / self-review pane.
 *
 * Runs GET /api/admin/self-audit (a real review of the running console:
 * identity, data plane, the Azure services each workload needs, permissions,
 * security posture) and renders a scored, grouped report. For issues the
 * console identity can safely fix at runtime, a "Heal" action (admin-approved,
 * via POST /api/admin/self-audit) applies the fix; deploy-time issues (env vars
 * / RBAC grants) show the exact remediation to apply + redeploy.
 *
 * Everything here reflects the live engine — no mock checks (no-vaporware.md).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Spinner, MessageBar, MessageBarBody, MessageBarTitle, Button, Badge,
  Subtitle2, Body1, Body1Strong, Caption1, Divider, tokens,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogActions, DialogContent,
} from '@fluentui/react-components';
import {
  CheckmarkCircle24Filled, Warning24Filled, ErrorCircle24Filled,
  ArrowSync24Regular, Wrench24Regular, ShieldCheckmark24Regular,
} from '@fluentui/react-icons';

type AuditStatus = 'pass' | 'warn' | 'fail';
type AuditSeverity = 'critical' | 'recommended' | 'optional';
type AuditCategory = 'identity' | 'data-plane' | 'azure-services' | 'permissions' | 'security' | 'enrichment' | 'builders' | 'catalog-governance' | 'ai-copilot';
interface CheckResult {
  id: string; category: AuditCategory; title: string; severity: AuditSeverity; status: AuditStatus;
  detail: string; remediation?: string; fixId?: string; redeploy?: boolean; docs?: string;
  portalSteps?: string[]; fixScript?: string;
}
interface AuditReport {
  generatedAt: string; score: number;
  summary: { pass: number; warn: number; fail: number; total: number; fixable: number };
  results: CheckResult[];
}

const CATEGORY_LABEL: Record<AuditCategory, string> = {
  'identity': 'Identity & session',
  'data-plane': 'Data plane (Loom store)',
  'azure-services': 'Azure services',
  'permissions': 'Permissions',
  'security': 'Security posture',
  'enrichment': 'Enrichment',
  'builders': 'Builders',
  'catalog-governance': 'Catalog & governance backends',
  'ai-copilot': 'AI & Copilot',
};
const CATEGORY_ORDER: AuditCategory[] = ['identity', 'data-plane', 'permissions', 'azure-services', 'catalog-governance', 'ai-copilot', 'builders', 'security', 'enrichment'];

const card: React.CSSProperties = {
  padding: tokens.spacingVerticalXL, border: `1px solid ${tokens.colorNeutralStroke2}`,
  borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1,
  marginBottom: tokens.spacingVerticalXL, boxShadow: tokens.shadow4,
};
const head: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 };

function StatusIcon({ s }: { s: AuditStatus }) {
  if (s === 'pass') return <CheckmarkCircle24Filled style={{ color: tokens.colorPaletteGreenForeground1 }} />;
  if (s === 'warn') return <Warning24Filled style={{ color: tokens.colorPaletteYellowForeground1 }} />;
  return <ErrorCircle24Filled style={{ color: tokens.colorPaletteRedForeground1 }} />;
}

function scoreColor(score: number): string {
  if (score >= 90) return tokens.colorPaletteGreenForeground1;
  if (score >= 70) return tokens.colorPaletteYellowForeground1;
  return tokens.colorPaletteRedForeground1;
}

export function HealthPane() {
  const [report, setReport] = useState<AuditReport | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [healing, setHealing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'one' | 'all'; fixId?: string } | null>(null);
  const [healMsg, setHealMsg] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [openFix, setOpenFix] = useState<Record<string, boolean>>({});

  const copyScript = useCallback((id: string, text: string) => {
    try { void navigator.clipboard?.writeText(text); } catch { /* clipboard blocked */ }
    setCopiedId(id);
    setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 2000);
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/admin/self-audit', { cache: 'no-store' });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'audit failed'); return; }
      setReport(j.report); setIsAdmin(!!j.isAdmin);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const heal = useCallback(async (fixId: string, dryRun = false) => {
    setHealing(fixId); setHealMsg(null);
    try {
      const r = await fetch('/api/admin/self-audit', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fixId, dryRun }),
      });
      const j = await r.json();
      setHealMsg(j.detail || (j.ok ? (dryRun ? 'Dry-run complete.' : 'Fix applied.') : 'Fix failed.'));
      // A dry-run changes nothing, so don't re-run the audit (which clears the message).
      if (!dryRun) await load();
    } catch (e: any) { setHealMsg(e?.message || String(e)); }
    finally { setHealing(null); }
  }, [load]);

  const healAll = useCallback(async () => {
    const fixables = (report?.results || []).filter((r) => r.fixId).map((r) => r.fixId!) as string[];
    for (const f of fixables) await heal(f);
  }, [report, heal]);

  // Dry-run the canonical runtime-safe fix so the healer is demonstrable even
  // when fixable=0 (nothing currently broken). Read-only — applies no change.
  const dryRunDemo = useCallback(() => heal('ensure-cosmos', true), [heal]);

  if (loading && !report) {
    return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner label="Running self-audit…" /></div>;
  }
  if (error) {
    return (
      <MessageBar intent="error">
        <MessageBarBody><MessageBarTitle>Audit failed</MessageBarTitle> {error}</MessageBarBody>
      </MessageBar>
    );
  }
  if (!report) return null;

  const fixableCount = report.summary.fixable;
  const grouped = CATEGORY_ORDER
    .map((cat) => ({ cat, items: report.results.filter((r) => r.category === cat) }))
    .filter((g) => g.items.length > 0);

  return (
    <div>
      {/* Scorecard */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 120 }}>
            <div style={{ fontSize: 48, fontWeight: 700, lineHeight: 1, color: scoreColor(report.score) }}>{report.score}</div>
            <Caption1>Health score</Caption1>
          </div>
          <Divider vertical style={{ height: 64 }} />
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', flex: 1 }}>
            <Badge appearance="filled" color="success" size="large">{report.summary.pass} passing</Badge>
            <Badge appearance="filled" color="warning" size="large">{report.summary.warn} warnings</Badge>
            <Badge appearance="filled" color="danger" size="large">{report.summary.fail} failing</Badge>
            <Badge appearance="outline" size="large">{report.summary.total} checks</Badge>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button icon={<ArrowSync24Regular />} appearance="outline" onClick={load} disabled={loading}>Re-run</Button>
            <Button
              icon={<Wrench24Regular />} appearance="outline"
              onClick={dryRunDemo} disabled={healing !== null}
              title="Preview what the runtime-safe healer would do — no change is applied"
            >
              {healing ? 'Dry-running…' : 'Dry-run healer'}
            </Button>
            {isAdmin && fixableCount > 0 && (
              <Button icon={<Wrench24Regular />} appearance="primary" onClick={() => setConfirm({ kind: 'all' })}>
                Heal {fixableCount} auto-fixable
              </Button>
            )}
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <Caption1>Last run {new Date(report.generatedAt).toLocaleString()} · agent-loom can run this and apply the same fixes conversationally from Copilot.</Caption1>
        </div>
      </div>

      {healMsg && (
        <MessageBar intent="info" style={{ marginBottom: 16 }}>
          <MessageBarBody><MessageBarTitle>Healer</MessageBarTitle> {healMsg}</MessageBarBody>
        </MessageBar>
      )}
      {!isAdmin && (
        <MessageBar intent="warning" style={{ marginBottom: 16 }}>
          <MessageBarBody>
            <MessageBarTitle>Read-only</MessageBarTitle>
            You can view the audit, but only a tenant admin can run the healer. Set LOOM_TENANT_ADMIN_OID / LOOM_TENANT_ADMIN_GROUP_ID to your principal.
          </MessageBarBody>
        </MessageBar>
      )}

      {grouped.map(({ cat, items }) => (
        <div key={cat} style={card}>
          <div style={head}>
            <ShieldCheckmark24Regular style={{ color: tokens.colorBrandForeground1 }} />
            <Subtitle2>{CATEGORY_LABEL[cat]}</Subtitle2>
            <Badge appearance="tint" size="small">{items.length}</Badge>
          </div>
          {items.map((r, i) => (
            <div key={r.id}>
              {i > 0 && <Divider style={{ margin: '12px 0' }} />}
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <div style={{ marginTop: 2 }}><StatusIcon s={r.status} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Body1Strong>{r.title}</Body1Strong>
                    <Badge appearance="outline" size="small"
                      color={r.severity === 'critical' ? 'danger' : r.severity === 'recommended' ? 'warning' : 'informative'}>
                      {r.severity}
                    </Badge>
                    {r.fixId && <Badge appearance="tint" size="small" color="brand">auto-fixable</Badge>}
                    {r.redeploy && r.status !== 'pass' && <Badge appearance="tint" size="small">needs redeploy / grant</Badge>}
                  </div>
                  <Body1 style={{ display: 'block', marginTop: 2, color: tokens.colorNeutralForeground2, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{r.detail}</Body1>
                  {r.status !== 'pass' && r.remediation && (
                    <div style={{ marginTop: 8, padding: 10, borderRadius: 6, background: tokens.colorNeutralBackground3, border: `1px solid ${tokens.colorNeutralStroke2}` }}>
                      <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>Remediation</Caption1>
                      <Body1 style={{ display: 'block', marginTop: 2, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{r.remediation}</Body1>
                      {r.docs && (
                        <a href={r.docs} target={r.docs.startsWith('http') ? '_blank' : undefined} rel="noreferrer"
                          style={{ color: tokens.colorBrandForeground1, fontSize: 12 }}>Open reference →</a>
                      )}
                    </div>
                  )}
                  {r.status !== 'pass' && (r.portalSteps?.length || r.fixScript) && (
                    <div style={{ marginTop: 8 }}>
                      <Button size="small" appearance="subtle"
                        onClick={() => setOpenFix((o) => ({ ...o, [r.id]: !o[r.id] }))}>
                        {openFix[r.id] ? '▾ Hide fix instructions' : '▸ How to fix (portal + PowerShell)'}
                      </Button>
                      {openFix[r.id] && (
                        <div style={{ marginTop: 8, padding: 12, borderRadius: 6, border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground2 }}>
                          {r.portalSteps?.length ? (
                            <>
                              <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>Fix via the Azure portal</Caption1>
                              <ol style={{ margin: '6px 0 12px', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
                                {r.portalSteps.map((step, si) => (
                                  <li key={si}><Body1>{step}</Body1></li>
                                ))}
                              </ol>
                            </>
                          ) : null}
                          {r.fixScript ? (
                            <>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>Fix via PowerShell (Az CLI — copy &amp; run)</Caption1>
                                <Button size="small" appearance="outline"
                                  onClick={() => copyScript(r.id, r.fixScript!)}>
                                  {copiedId === r.id ? 'Copied ✓' : 'Copy script'}
                                </Button>
                              </div>
                              <pre style={{ marginTop: 6, padding: 10, borderRadius: 6, background: tokens.colorNeutralBackground4, color: tokens.colorNeutralForeground1, overflow: 'auto', maxWidth: '100%', maxHeight: 320, fontSize: 12, fontFamily: 'Consolas, "Cascadia Code", monospace', whiteSpace: 'pre', lineHeight: 1.5 }}>
                                {r.fixScript}
                              </pre>
                              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                                Run in Azure Cloud Shell (PowerShell) or local pwsh with the Az CLI signed in to this tenant. Replace any &lt;…&gt; placeholders with your values.
                              </Caption1>
                            </>
                          ) : null}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {r.status !== 'pass' && r.fixId && (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Button size="small" appearance="outline" icon={<Wrench24Regular />}
                      disabled={healing === r.fixId}
                      title="Preview this fix — no change is applied"
                      onClick={() => heal(r.fixId!, true)}>
                      {healing === r.fixId ? 'Dry-running…' : 'Dry-run'}
                    </Button>
                    {isAdmin && (
                      <Button size="small" appearance="primary" icon={<Wrench24Regular />}
                        disabled={healing === r.fixId}
                        onClick={() => setConfirm({ kind: 'one', fixId: r.fixId })}>
                        {healing === r.fixId ? 'Healing…' : 'Heal'}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}

      {/* Admin-approval confirm dialog */}
      <Dialog open={!!confirm} onOpenChange={(_, d) => { if (!d.open) setConfirm(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Approve healer action</DialogTitle>
            <DialogContent>
              {confirm?.kind === 'all'
                ? `agent-loom will apply ${fixableCount} runtime-safe fix(es) to this deployment (e.g. ensure Cosmos containers). Deploy-time items (env vars / RBAC grants) are NOT auto-applied — their exact remediation is shown for you to apply + redeploy.`
                : 'agent-loom will apply this runtime-safe fix to the live deployment using the Console managed identity. Proceed?'}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button appearance="primary" icon={<Wrench24Regular />}
                onClick={() => { const c = confirm; setConfirm(null); if (c?.kind === 'all') healAll(); else if (c?.fixId) heal(c.fixId); }}>
                Approve &amp; heal
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
