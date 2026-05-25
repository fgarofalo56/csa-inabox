'use client';

import { useEffect, useState } from 'react';
import { AdminShell } from '@/lib/components/admin-shell';
import {
  Body1, Caption1, Subtitle2, Badge, Button, Title3,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, Checkmark24Filled, ArrowDownload24Regular } from '@fluentui/react-icons';

interface VersionInfo {
  current: string;
  upstream: null | { tag: string; name: string; publishedAt: string; url: string; notes: string };
  recent: { tag: string; name: string; publishedAt: string; url: string; prerelease: boolean }[];
  hasUpdate: boolean;
  repo: string;
  error?: string;
}

const useStyles = makeStyles({
  hero: {
    padding: 20, borderRadius: 8,
    background: 'linear-gradient(135deg, rgba(125,108,255,0.10), rgba(216,159,61,0.10))',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex', alignItems: 'center', gap: 20,
  },
  vBadge: {
    padding: '8px 16px', borderRadius: 8,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    fontFamily: 'Consolas, monospace', fontSize: 18, fontWeight: 600,
  },
  list: { marginTop: 16 },
  row: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 12px', borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  notes: {
    padding: 12, marginTop: 12, borderRadius: 6,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    whiteSpace: 'pre-wrap', fontSize: 13, maxHeight: 280, overflowY: 'auto',
  },
});

export default function UpdatesPage() {
  const s = useStyles();
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try { setInfo(await fetch('/api/version').then((r) => r.json())); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  return (
    <AdminShell sectionTitle="Updates & version sync">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 16 }}>
        Loom is open source and continuously updated. This page shows your running build,
        the latest version published upstream, and any release notes between them. Operators
        run the linked GitHub Actions deploy with the new tag to pull updates.
      </Body1>
      {loading ? (
        <Body1>Checking for updates…</Body1>
      ) : info ? (
        <>
          <div className={s.hero}>
            <div style={{ flex: 1 }}>
              <Caption1>Currently running</Caption1>
              <div style={{ marginTop: 6 }}><span className={s.vBadge}>{info.current}</span></div>
            </div>
            <div style={{ flex: 1 }}>
              <Caption1>Latest upstream ({info.repo})</Caption1>
              <div style={{ marginTop: 6 }}>
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

          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
            <Button appearance="secondary" icon={<ArrowSync24Regular />} onClick={load}>Re-check</Button>
            {info.upstream && info.hasUpdate && (
              <>
                <Button appearance="primary" icon={<ArrowDownload24Regular />}
                  as="a" href={info.upstream.url} target="_blank" rel="noreferrer">
                  View release {info.upstream.tag} on GitHub
                </Button>
                <Button appearance="secondary"
                  as="a" href={`https://github.com/${info.repo}/actions`} target="_blank" rel="noreferrer">
                  Open deploy workflow
                </Button>
              </>
            )}
          </div>

          {info.upstream && (
            <>
              <Title3 as="h3" style={{ marginTop: 24 }}>Release notes — {info.upstream.tag}</Title3>
              <Caption1>Published {new Date(info.upstream.publishedAt).toLocaleString()}</Caption1>
              <div className={s.notes}>{info.upstream.notes || '(no release notes)'}</div>
            </>
          )}

          <Title3 as="h3" style={{ marginTop: 24 }}>Recent releases</Title3>
          <div className={s.list}>
            {info.recent.map((r) => (
              <div key={r.tag} className={s.row}>
                <div>
                  <Subtitle2>{r.tag}</Subtitle2>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    {r.name} · {new Date(r.publishedAt).toLocaleDateString()}
                    {r.prerelease && <Badge appearance="outline" color="warning" style={{ marginLeft: 8 }}>pre-release</Badge>}
                  </Caption1>
                </div>
                <Button appearance="subtle" as="a" href={r.url} target="_blank" rel="noreferrer">View</Button>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 24, padding: 12, backgroundColor: tokens.colorNeutralBackground2, borderRadius: 6, fontSize: 12, color: tokens.colorNeutralForeground3 }}>
            <b>How updates flow:</b> when you submit a bug report or feature request via the
            in-app Feedback widget, it&apos;s sanitized client-side AND server-side, then forwarded
            to the upstream <code>{info.repo}</code> issue tracker. The maintainers triage,
            ship a release, and this page shows it. Your tenant ID is hashed before it leaves
            the deployment — no PII, no workspace IDs, no data values are ever forwarded.
          </div>
        </>
      ) : null}
    </AdminShell>
  );
}
