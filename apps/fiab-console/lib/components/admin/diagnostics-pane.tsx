'use client';

/**
 * DIAG1 — diagnostics / support-bundle pane (/admin/diagnostics).
 *
 * One-click incident triage export. Previews the assembled bundle
 * (version + ACA revision, gate summary, live probes, masked env posture, last
 * synthetic run, recent audit rows) and downloads it as a scrubbed JSON.
 *
 * REAL data only (no-vaporware.md): reads GET /api/admin/diagnostics/bundle
 * (inline preview) and GET …?download=1 (attachment). Env values are masked at
 * source and the whole bundle is secret-scrubbed server-side — nothing here can
 * leak a token or connection string.
 */

import { useCallback, useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  Badge, Body1, Body1Strong, Button, Caption1, Divider, MessageBar,
  MessageBarBody, MessageBarTitle, Spinner, Subtitle2, Table, TableBody,
  TableCell, TableHeader, TableHeaderCell, TableRow, Tooltip, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowDownload24Regular, ArrowSync24Regular, CheckmarkCircle24Filled,
  DocumentBriefcase24Regular, ErrorCircle24Filled, Open16Regular, ShieldCheckmark20Regular,
} from '@fluentui/react-icons';

interface GatePosture { id: string; status: string; missing: string[]; availability?: string }
interface ProbeResult { name: string; ok: boolean; ms: number; error?: string }
interface EnvVarPosture { key: string; present: boolean; value: string }
interface SyntheticRunLite { runId: string; ts: string; pass: number; fail: number; skip: number }
interface AuditRowLite { at: string; who: string; kind: string; target?: string }
interface SupportBundle {
  schema: string; generatedAt: string; generatedBy: string;
  version: { version: string; sha?: string; stamp?: string; revision?: string; app?: string; cloud?: string };
  gateSummary: { total: number; configured: number; blocked: number; cloudUnavailable: number };
  gates: GatePosture[]; env: EnvVarPosture[]; probes: ProbeResult[];
  lastSyntheticRun?: SyntheticRunLite; recentAudit: AuditRowLite[]; notes: string[];
}

const RUNBOOK_URL = 'https://github.com/fgarofalo56/csa-inabox/blob/main/docs/fiab/runbooks/support-bundle.md';

const useStyles = makeStyles({
  section: {
    padding: tokens.spacingVerticalXL, border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1,
    marginBottom: tokens.spacingVerticalXL, boxShadow: tokens.shadow4, minWidth: 0,
  },
  head: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalMNudge,
    marginBottom: tokens.spacingVerticalL, flexWrap: 'wrap', minWidth: 0,
  },
  statGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(200px, 100%), 1fr))',
    gap: tokens.spacingHorizontalL, marginBottom: tokens.spacingVerticalL,
  },
  stat: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
  },
  statValue: { fontSize: '22px', fontWeight: 700, lineHeight: 1.1, overflowWrap: 'anywhere' },
  badgeRow: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, minWidth: 0, alignItems: 'center' },
  scroll: { overflowX: 'auto', minWidth: 0 },
});

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  const styles = useStyles();
  return (
    <div className={styles.stat}>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{label}</Caption1>
      <span className={styles.statValue}>{value}</span>
      {hint && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{hint}</Caption1>}
    </div>
  );
}

export function DiagnosticsPane() {
  const styles = useStyles();
  const [bundle, setBundle] = useState<SupportBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await clientFetch('/api/admin/diagnostics/bundle', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) { setError(j?.error || `bundle failed (${r.status})`); return; }
      setBundle(j.bundle as SupportBundle);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const download = useCallback(async () => {
    setDownloading(true); setError(null);
    try {
      const r = await clientFetch('/api/admin/diagnostics/bundle?download=1', { cache: 'no-store' });
      if (!r.ok) { setError(`download failed (${r.status})`); return; }
      const blob = await r.blob();
      const cd = r.headers.get('content-disposition') || '';
      const name = /filename="([^"]+)"/.exec(cd)?.[1] || `loom-support-bundle-${Date.now()}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      a.remove(); URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setDownloading(false);
    }
  }, []);

  return (
    <section className={styles.section} aria-label="Diagnostics support bundle">
      <div className={styles.head}>
        <DocumentBriefcase24Regular style={{ color: tokens.colorBrandForeground1 }} />
        <Subtitle2>Support bundle</Subtitle2>
        <Caption1 style={{ color: tokens.colorNeutralForeground3, minWidth: 0 }}>
          One-click incident triage export: version + ACA revision, gate-registry state, masked env posture,
          live probes, the last synthetic run, and recent audit rows — secret-scrubbed, safe to attach to a ticket.
        </Caption1>
        <span style={{ flex: 1 }} />
        <Button appearance="subtle" icon={<Open16Regular />} as="a" href={RUNBOOK_URL} target="_blank" rel="noreferrer">
          Runbook
        </Button>
        <Button appearance="secondary" icon={loading ? <Spinner size="tiny" /> : <ArrowSync24Regular />}
          onClick={load} disabled={loading}>
          Refresh
        </Button>
        <Button appearance="primary" icon={downloading ? <Spinner size="tiny" /> : <ArrowDownload24Regular />}
          onClick={download} disabled={downloading || !bundle}>
          Export support bundle
        </Button>
      </div>

      <MessageBar intent="success" layout="multiline" style={{ marginBottom: tokens.spacingVerticalL }}>
        <MessageBarBody>
          <MessageBarTitle>
            <ShieldCheckmark20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS }} />
            Secret-safe
          </MessageBarTitle>
          Env values are masked at source (secrets → <code>***</code>) and the whole bundle is run through a
          secret scrubber server-side. No Key Vault values, tokens, or connection strings are included.
        </MessageBarBody>
      </MessageBar>

      {error && (
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Could not load the bundle</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {loading && !bundle && !error && <Spinner label="Assembling support bundle…" />}

      {bundle && (
        <>
          <div className={styles.statGrid}>
            <Stat label="Version" value={bundle.version.version}
              hint={bundle.version.sha ? `sha ${bundle.version.sha.slice(0, 12)}` : undefined} />
            <Stat label="ACA revision" value={bundle.version.revision || '—'} hint={bundle.version.cloud} />
            <Stat
              label="Gates"
              value={`${bundle.gateSummary.configured}/${bundle.gateSummary.total}`}
              hint={`${bundle.gateSummary.blocked} blocked · ${bundle.gateSummary.cloudUnavailable} cloud-unavailable`}
            />
            <Stat label="Env posture" value={`${bundle.env.filter((e) => e.present).length}/${bundle.env.length}`} hint="present / referenced (masked)" />
            <Stat
              label="Last synthetic run"
              value={bundle.lastSyntheticRun ? `${bundle.lastSyntheticRun.pass}✓ ${bundle.lastSyntheticRun.fail}✗` : '—'}
              hint={bundle.lastSyntheticRun?.ts ? new Date(bundle.lastSyntheticRun.ts).toLocaleString() : 'no run in bundle'}
            />
            <Stat label="Audit rows" value={bundle.recentAudit.length} hint="most recent, scrubbed" />
          </div>

          <Body1Strong>Live probes</Body1Strong>
          <div className={styles.badgeRow} style={{ margin: `${tokens.spacingVerticalXS} 0 ${tokens.spacingVerticalL}` }}>
            {bundle.probes.map((p) => (
              <Tooltip key={p.name} relationship="description" content={p.error || `${p.ms} ms`}>
                <Badge appearance="tint" color={p.ok ? 'success' : 'danger'}
                  icon={p.ok ? <CheckmarkCircle24Filled /> : <ErrorCircle24Filled />}>
                  {p.name} · {p.ms}ms
                </Badge>
              </Tooltip>
            ))}
          </div>

          {bundle.notes.length > 0 && (
            <MessageBar intent="info" layout="multiline" style={{ marginBottom: tokens.spacingVerticalL }}>
              <MessageBarBody>
                <MessageBarTitle>Bundle notes</MessageBarTitle>
                <ul style={{ margin: 0, paddingLeft: tokens.spacingHorizontalXL }}>
                  {bundle.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </MessageBarBody>
            </MessageBar>
          )}

          <Divider style={{ marginBottom: tokens.spacingVerticalM }} />
          <Body1Strong>Recent audit rows</Body1Strong>
          {bundle.recentAudit.length === 0 ? (
            <Body1 style={{ display: 'block', color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalXS }}>
              No recent audit rows in this deployment (or the Cosmos audit container is empty).
            </Body1>
          ) : (
            <div className={styles.scroll}>
              <Table size="small" aria-label="Recent audit rows" style={{ marginTop: tokens.spacingVerticalS }}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>When</TableHeaderCell>
                    <TableHeaderCell>Who</TableHeaderCell>
                    <TableHeaderCell>Action</TableHeaderCell>
                    <TableHeaderCell>Target</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bundle.recentAudit.slice(0, 10).map((r, i) => (
                    <TableRow key={i}>
                      <TableCell>{r.at ? new Date(r.at).toLocaleString() : '—'}</TableCell>
                      <TableCell>{r.who || '—'}</TableCell>
                      <TableCell>{r.kind || '—'}</TableCell>
                      <TableCell>{r.target || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <Divider style={{ margin: `${tokens.spacingVerticalL} 0 ${tokens.spacingVerticalS}` }} />
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            Generated {new Date(bundle.generatedAt).toLocaleString()} by {bundle.generatedBy} · schema {bundle.schema} ·
            the exported JSON includes the FULL gate + env posture; this preview shows the summary.
          </Caption1>
        </>
      )}
    </section>
  );
}
