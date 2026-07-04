'use client';

import { clientFetch } from '@/lib/client-fetch';
import { useEffect, useMemo, useState } from 'react';
import { AdminShell } from '@/lib/components/admin-shell';
import {
  Body1, Caption1, Badge, Button, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync24Regular, Checkmark24Filled, ArrowDownload24Regular,
  ArrowUpload24Regular, Checkmark20Filled, ErrorCircle20Filled, Subtract20Regular,
} from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { useAdminTabStyles } from '@/lib/components/ui/admin-tab-styles';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

/**
 * Markdown styling atoms. Defined at module scope so the MarkdownNotes
 * component (and, via a passed className, the renderInline helper) can move
 * every static rule off inline styles and onto Fluent tokens — including
 * replacing the hardcoded rgba(127,127,127,0.15) code background with a
 * theme-aware neutral so release notes render correctly in dark mode.
 */
const useMdStyles = makeStyles({
  codeSpan: {
    fontFamily: 'Consolas, monospace',
    fontSize: '0.9em',
    backgroundColor: tokens.colorNeutralBackground3,
    padding: '1px 4px',
    borderRadius: tokens.borderRadiusSmall,
  },
  heading: { fontWeight: 600, marginBottom: tokens.spacingVerticalXS },
  list: {
    marginTop: tokens.spacingVerticalXS,
    marginBottom: tokens.spacingVerticalXS,
    paddingLeft: '20px',
  },
  item: { marginBottom: tokens.spacingVerticalXXS },
  pre: {
    fontFamily: 'Consolas, monospace',
    fontSize: tokens.fontSizeBase200,
    padding: tokens.spacingVerticalS,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    overflowX: 'auto',
    marginTop: tokens.spacingVerticalS,
    marginBottom: tokens.spacingVerticalS,
  },
  para: {
    marginTop: tokens.spacingVerticalS,
    marginBottom: tokens.spacingVerticalS,
    lineHeight: 1.5,
  },
});

/**
 * Lightweight markdown → JSX renderer. Covers the subset GitHub release
 * notes typically use: headings (#-####), bullets (-/*), code spans
 * (`x`), bold (**x**), italics (*x*), links ([t](u)), and paragraphs.
 * No external dep — pulling in react-markdown for ~5 markdown nodes per
 * release note would be overkill.
 */
function renderInline(line: string, key: number, codeClass: string): React.ReactNode {
  // [text](url)
  let parts: React.ReactNode[] = [line];
  parts = parts.flatMap((p, i) => {
    if (typeof p !== 'string') return [p];
    const out: React.ReactNode[] = [];
    let last = 0;
    const re = /\[([^\]]+)\]\(([^)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(p)) !== null) {
      if (m.index > last) out.push(p.slice(last, m.index));
      out.push(<a key={`l${key}-${i}-${m.index}`} href={m[2]} target="_blank" rel="noreferrer">{m[1]}</a>);
      last = m.index + m[0].length;
    }
    if (last < p.length) out.push(p.slice(last));
    return out;
  });
  // **bold**
  parts = parts.flatMap<React.ReactNode>((p, i) => {
    if (typeof p !== 'string') return [p];
    const segs = p.split(/(\*\*[^*]+\*\*)/g);
    return segs.map((seg, j) =>
      seg.startsWith('**') && seg.endsWith('**')
        ? <strong key={`b${key}-${i}-${j}`}>{seg.slice(2, -2)}</strong>
        : seg
    );
  });
  // `code`
  parts = parts.flatMap<React.ReactNode>((p, i) => {
    if (typeof p !== 'string') return [p];
    const segs = p.split(/(`[^`]+`)/g);
    return segs.map((seg, j) =>
      seg.startsWith('`') && seg.endsWith('`')
        ? <code key={`c${key}-${i}-${j}`} className={codeClass}>{seg.slice(1, -1)}</code>
        : seg
    );
  });
  return parts;
}

function MarkdownNotes({ text }: { text: string }) {
  const md = useMdStyles();
  const blocks = useMemo(() => {
    if (!text?.trim()) return [];
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    type Block =
      | { kind: 'h'; level: number; text: string }
      | { kind: 'ul'; items: string[] }
      | { kind: 'p'; text: string }
      | { kind: 'code'; text: string };
    const out: Block[] = [];
    let i = 0;
    while (i < lines.length) {
      const ln = lines[i];
      if (/^#{1,4}\s+/.test(ln)) {
        const m = ln.match(/^(#{1,4})\s+(.*)$/)!;
        out.push({ kind: 'h', level: m[1].length, text: m[2] });
        i++;
      } else if (ln.startsWith('```')) {
        const code: string[] = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('```')) { code.push(lines[i]); i++; }
        i++;
        out.push({ kind: 'code', text: code.join('\n') });
      } else if (/^[*-]\s+/.test(ln)) {
        const items: string[] = [];
        while (i < lines.length && /^[*-]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^[*-]\s+/, ''));
          i++;
        }
        out.push({ kind: 'ul', items });
      } else if (ln.trim() === '') {
        i++;
      } else {
        // Paragraph: collect until blank line / heading / bullet / code
        const para: string[] = [ln];
        i++;
        while (i < lines.length && lines[i].trim() && !/^#{1,4}\s+/.test(lines[i]) && !/^[*-]\s+/.test(lines[i]) && !lines[i].startsWith('```')) {
          para.push(lines[i]); i++;
        }
        out.push({ kind: 'p', text: para.join(' ') });
      }
    }
    return out;
  }, [text]);

  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === 'h') {
          const size = b.level === 1 ? 18 : b.level === 2 ? 16 : 14;
          // dynamic: heading size + top gap are computed from the markdown heading level / position
          return <div key={i} className={md.heading} style={{ fontSize: size, marginTop: i ? tokens.spacingVerticalS : 0 }}>{renderInline(b.text, i, md.codeSpan)}</div>;
        }
        if (b.kind === 'ul') {
          return (
            <ul key={i} className={md.list}>
              {b.items.map((it, j) => <li key={j} className={md.item}>{renderInline(it, j, md.codeSpan)}</li>)}
            </ul>
          );
        }
        if (b.kind === 'code') {
          return (
            <pre key={i} className={md.pre}>{b.text}</pre>
          );
        }
        return <p key={i} className={md.para}>{renderInline(b.text, i, md.codeSpan)}</p>;
      })}
    </>
  );
}

interface VersionInfo {
  current: string;
  build?: { sha?: string; stamp?: string };
  upstream: null | { tag: string; name: string; publishedAt: string; url: string; notes: string };
  recent: { tag: string; name: string; publishedAt: string; url: string; prerelease: boolean }[];
  hasUpdate: boolean;
  repo: string;
  error?: string;
}

interface RecentRelease { tag: string; name: string; publishedAt: string; url: string; prerelease: boolean }

interface AppApplyResult {
  app: string;
  fromImage: string;
  toImage: string;
  status: 'succeeded' | 'updating' | 'failed' | 'skipped';
  provisioningState?: string;
  error?: string;
}

interface PreflightGate {
  ok: false;
  reason: 'already-up-to-date' | 'no-upstream-release' | 'images-not-published' | 'arm-not-configured' | 'requires-infra-redeploy';
  message: string;
  missingImages?: { app: string; ref: string; exists: boolean; status: number }[];
  missingEnv?: string[];
  missingRequiredEnv?: { name: string; reason: string; remediation: string }[];
  infraTooOld?: { required: string; actual: string };
}

const useStyles = makeStyles({
  intro: { color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalL },
  hero: {
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    background: 'linear-gradient(135deg, rgba(125,108,255,0.10), rgba(216,159,61,0.10))',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXL, flexWrap: 'wrap',
  },
  vBadge: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase500, fontWeight: 600,
    overflowWrap: 'anywhere',
  },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalL, flexWrap: 'wrap' },
  notes: {
    padding: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    fontSize: tokens.fontSizeBase300, maxHeight: '360px', overflowY: 'auto',
  },
  flow: {
    marginTop: tokens.spacingVerticalL, padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2, borderRadius: tokens.borderRadiusMedium,
    fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3, lineHeight: 1.5,
  },
  heroCol: { flex: 1, minWidth: '160px' },
  badgeWrap: { marginTop: tokens.spacingVerticalS },
  buildLine: { marginTop: tokens.spacingVerticalXXS, color: tokens.colorNeutralForeground3, fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase100 },
  applyList: { marginTop: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  applyRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  applyName: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase300, minWidth: '180px', overflowWrap: 'anywhere' },
  applyImage: { flex: 1, minWidth: 0, fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3, overflowWrap: 'anywhere' },
  ok: { color: tokens.colorPaletteGreenForeground1 },
  fail: { flex: 1, minWidth: 0, color: tokens.colorPaletteRedForeground1, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  dim: { flex: 1, minWidth: 0, color: tokens.colorNeutralForeground3, overflowWrap: 'anywhere' },
  dialogList: { margin: `${tokens.spacingVerticalS} 0 0`, paddingLeft: '18px', fontSize: tokens.fontSizeBase300, overflowWrap: 'anywhere' },
  codeWrap: { overflowWrap: 'anywhere', wordBreak: 'break-word' },
});

export default function UpdatesPage() {
  const s = useStyles();
  const a = useAdminTabStyles();
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  // In-product update apply state.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResults, setApplyResults] = useState<AppApplyResult[] | null>(null);
  const [applyGate, setApplyGate] = useState<PreflightGate | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyDone, setApplyDone] = useState<{ ok: boolean; tag: string } | null>(null);

  async function load() {
    setLoading(true);
    try { setInfo(await clientFetch('/api/version').then((r) => r.json())); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  async function runUpdate() {
    if (!info?.upstream) return;
    setConfirmOpen(false);
    setApplying(true);
    setApplyResults(null);
    setApplyGate(null);
    setApplyError(null);
    setApplyDone(null);
    try {
      const res = await clientFetch('/api/admin/updates/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmTag: info.upstream.tag }),
      }, 180_000); // rolling ~8 apps via ARM PATCH sequentially can exceed the 6s default
      const j = await res.json().catch(() => ({}));
      if (j?.results) {
        setApplyResults(j.results as AppApplyResult[]);
        setApplyDone({ ok: !!j.ok, tag: j?.target?.tag_name ?? info.upstream.tag });
      } else if (j?.preflight && j.preflight.ok === false) {
        setApplyGate(j.preflight as PreflightGate);
      } else {
        setApplyError(j?.error || `Update failed (HTTP ${res.status}).`);
      }
    } catch (e) {
      setApplyError((e as Error).message);
    } finally {
      setApplying(false);
    }
  }

  const recentColumns: LoomColumn<RecentRelease>[] = [
    {
      key: 'tag', label: 'Version', width: 180,
      render: (r) => (
        <span>
          <strong>{r.tag}</strong>
          {r.prerelease && <Badge appearance="outline" color="warning" size="small" className={a.badgeGap}>pre-release</Badge>}
        </span>
      ),
    },
    { key: 'name', label: 'Name', width: 280, render: (r) => <Caption1>{r.name}</Caption1> },
    {
      key: 'publishedAt', label: 'Published', width: 160,
      getValue: (r) => new Date(r.publishedAt).getTime(),
      render: (r) => <Caption1>{new Date(r.publishedAt).toLocaleDateString()}</Caption1>,
    },
    {
      key: 'view', label: '', width: 90, sortable: false, filterable: false,
      render: (r) => (
        <Button appearance="subtle" size="small" as="a" href={r.url} target="_blank" rel="noreferrer"
          onClick={(e) => e.stopPropagation()}>
          View
        </Button>
      ),
    },
  ];

  return (
    <AdminShell sectionTitle="Updates & version sync">
      <Body1 className={s.intro}>
        Loom is open source and continuously updated. This page shows your running build,
        the latest version published upstream, and any release notes between them. When an
        update is available you can apply it in place — Loom rolls your Container Apps to the
        new release&apos;s public images directly, with no repo clone or CI run required.
      </Body1>
      {loading ? (
        <Section><Spinner size="small" label="Checking for updates…" labelPosition="after" /></Section>
      ) : info ? (
        <>
          <Section title="Version status">
            <div className={s.hero}>
              <div className={s.heroCol}>
                <Caption1>Currently running</Caption1>
                <div className={s.badgeWrap}><span className={s.vBadge}>{info.current}</span></div>
                {info.build?.sha && (
                  <div className={s.buildLine}>build {info.build.sha.slice(0, 12)}</div>
                )}
              </div>
              <div className={s.heroCol}>
                <Caption1>Latest upstream ({info.repo})</Caption1>
                <div className={s.badgeWrap}>
                  {info.upstream
                    ? <span className={s.vBadge}>{info.upstream.tag}</span>
                    : <Caption1>(unable to reach GitHub: {info.error ?? 'unknown'})</Caption1>}
                </div>
              </div>
              <div>
                {info.hasUpdate
                  ? <Badge appearance="filled" color="brand">Update available</Badge>
                  : <Badge appearance="filled" color="success"><Checkmark24Filled /> Up to date</Badge>}
              </div>
            </div>

            <div className={s.actions}>
              <Button appearance="secondary" icon={<ArrowSync24Regular />} onClick={load} disabled={applying}>Re-check</Button>
              {info.upstream && info.hasUpdate && (
                <>
                  <Dialog open={confirmOpen} onOpenChange={(_, d) => setConfirmOpen(d.open)}>
                    <DialogTrigger disableButtonEnhancement>
                      <Button appearance="primary" icon={<ArrowUpload24Regular />} disabled={applying}
                        onClick={() => setConfirmOpen(true)}>
                        {applying ? `Updating to ${info.upstream.tag}…` : `Update to ${info.upstream.tag}`}
                      </Button>
                    </DialogTrigger>
                    <DialogSurface>
                      <DialogBody>
                        <DialogTitle>Update Loom to {info.upstream.tag}?</DialogTitle>
                        <DialogContent>
                          This rolls your Loom Container Apps to the public <code>{info.upstream.tag}</code> release
                          images and briefly restarts them. The console itself is rolled last, so you may see a short
                          reconnect at the end. No data is deleted; only the application images change.
                          <ul className={s.dialogList}>
                            <li>Each app is updated one at a time, with live status below.</li>
                            <li>If the public images for this release are not yet published, the update will refuse with a clear message rather than break anything.</li>
                          </ul>
                        </DialogContent>
                        <DialogActions>
                          <DialogTrigger disableButtonEnhancement>
                            <Button appearance="secondary">Cancel</Button>
                          </DialogTrigger>
                          <Button appearance="primary" icon={<ArrowUpload24Regular />} onClick={() => void runUpdate()}>
                            Update now
                          </Button>
                        </DialogActions>
                      </DialogBody>
                    </DialogSurface>
                  </Dialog>
                  <Button appearance="secondary" icon={<ArrowDownload24Regular />}
                    as="a" href={info.upstream.url} target="_blank" rel="noreferrer">
                    View release notes
                  </Button>
                </>
              )}
            </div>

            {applying && (
              <MessageBar intent="info" className={a.messageBar}>
                <MessageBarBody>
                  <Spinner size="tiny" /> Rolling Loom apps to {info.upstream?.tag}. This may take a minute — apps are updated one at a time.
                </MessageBarBody>
              </MessageBar>
            )}

            {applyError && (
              <MessageBar intent="error" className={a.messageBar}>
                <MessageBarBody><MessageBarTitle>Update failed</MessageBarTitle>{applyError}</MessageBarBody>
              </MessageBar>
            )}

            {applyGate && (
              <MessageBar intent="warning" className={a.messageBar}>
                <MessageBarBody>
                  <MessageBarTitle>
                    {applyGate.reason === 'requires-infra-redeploy'
                      ? 'Infrastructure re-deploy required first'
                      : 'Update not available yet'}
                  </MessageBarTitle>
                  {applyGate.message}
                  {applyGate.missingImages && applyGate.missingImages.length > 0 && (
                    <ul className={s.dialogList}>
                      {applyGate.missingImages.map((m) => (
                        <li key={m.app}><code className={s.codeWrap}>{m.ref}</code> (HTTP {m.status})</li>
                      ))}
                    </ul>
                  )}
                  {applyGate.missingEnv && applyGate.missingEnv.length > 0 && (
                    <div>Set: <code className={s.codeWrap}>{applyGate.missingEnv.join(', ')}</code></div>
                  )}
                  {applyGate.missingRequiredEnv && applyGate.missingRequiredEnv.length > 0 && (
                    <ul className={s.dialogList}>
                      {applyGate.missingRequiredEnv.map((e) => (
                        <li key={e.name}>
                          <code className={s.codeWrap}>{e.name}</code> — {e.reason}{' '}
                          <em>{e.remediation}</em>
                        </li>
                      ))}
                    </ul>
                  )}
                  {applyGate.infraTooOld && (
                    <div>
                      Running infra version <code className={s.codeWrap}>{applyGate.infraTooOld.actual}</code>;
                      this release needs <code className={s.codeWrap}>{applyGate.infraTooOld.required}</code>.
                      Re-deploy <code className={s.codeWrap}>platform/fiab/bicep</code> first.
                    </div>
                  )}
                </MessageBarBody>
              </MessageBar>
            )}

            {applyResults && (
              <>
                {applyDone && (
                  <MessageBar intent={applyDone.ok ? 'success' : 'warning'} className={a.messageBar}>
                    <MessageBarBody>
                      <MessageBarTitle>
                        {applyDone.ok
                          ? `Update to ${applyDone.tag} applied`
                          : `Update to ${applyDone.tag} completed with issues`}
                      </MessageBarTitle>
                      {applyDone.ok
                        ? 'Apps are rolling to new revisions. Re-check in a minute to confirm the running version.'
                        : 'Some apps did not update — see per-app status below. The update did not fake success.'}
                    </MessageBarBody>
                  </MessageBar>
                )}
                <div className={s.applyList}>
                  {applyResults.map((r) => {
                    const icon =
                      r.status === 'failed' ? <ErrorCircle20Filled className={s.fail} />
                      : r.status === 'skipped' ? <Subtract20Regular className={s.dim} />
                      : <Checkmark20Filled className={s.ok} />;
                    return (
                      <div key={r.app} className={s.applyRow}>
                        {icon}
                        <span className={s.applyName}>{r.app}</span>
                        {r.status === 'failed' ? (
                          <span className={s.fail}>{r.error}</span>
                        ) : r.status === 'skipped' ? (
                          <span className={s.dim}>not deployed on this boundary — skipped</span>
                        ) : (
                          <span className={s.applyImage}>
                            → {r.toImage.split('/').pop()} ({r.provisioningState || r.status})
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </Section>

          {info.upstream && (
            <Section title={`Release notes — ${info.upstream.tag}`}>
              <Caption1>Published {new Date(info.upstream.publishedAt).toLocaleString()}</Caption1>
              <div className={s.notes}>
                {info.upstream.notes
                  ? <MarkdownNotes text={info.upstream.notes} />
                  : '(no release notes)'}
              </div>
            </Section>
          )}

          <Section title="Recent releases">
            <LoomDataTable
              columns={recentColumns}
              rows={info.recent}
              getRowId={(r) => r.tag}
              empty="No recent releases found upstream."
              ariaLabel="Recent releases"
            />
          </Section>

          <Section title="How updates flow">
            <div className={s.flow}>
              <b>How updates flow:</b> when you submit a bug report or feature request via the
              in-app Feedback widget, it&apos;s sanitized client-side AND server-side, then forwarded
              to the upstream <code>{info.repo}</code> issue tracker. The maintainers triage,
              ship a release, and this page shows it. Your tenant ID is hashed before it leaves
              the deployment — no PII, no workspace IDs, no data values are ever forwarded.
            </div>
          </Section>
        </>
      ) : (
        <Section title="Version status">
          <MessageBar intent="error" className={a.messageBar}>
            <MessageBarBody>
              <MessageBarTitle>Could not check for updates</MessageBarTitle>
              The version service did not return a response. Confirm the console can reach
              GitHub, then re-check.
            </MessageBarBody>
          </MessageBar>
          <Button appearance="secondary" icon={<ArrowSync24Regular />} onClick={load}>Re-check</Button>
        </Section>
      )}
    </AdminShell>
  );
}
