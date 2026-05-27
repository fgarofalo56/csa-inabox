'use client';

import { useEffect, useMemo, useState } from 'react';
import { AdminShell } from '@/lib/components/admin-shell';
import {
  Body1, Caption1, Subtitle2, Badge, Button, Title3,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, Checkmark24Filled, ArrowDownload24Regular } from '@fluentui/react-icons';

/**
 * Lightweight markdown → JSX renderer. Covers the subset GitHub release
 * notes typically use: headings (#-####), bullets (-/*), code spans
 * (`x`), bold (**x**), italics (*x*), links ([t](u)), and paragraphs.
 * No external dep — pulling in react-markdown for ~5 markdown nodes per
 * release note would be overkill.
 */
function renderInline(line: string, key: number): React.ReactNode {
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
  parts = parts.flatMap((p, i) => {
    if (typeof p !== 'string') return [p];
    const segs = p.split(/(\*\*[^*]+\*\*)/g);
    return segs.map((seg, j) =>
      seg.startsWith('**') && seg.endsWith('**')
        ? <strong key={`b${key}-${i}-${j}`}>{seg.slice(2, -2)}</strong>
        : seg
    );
  });
  // `code`
  parts = parts.flatMap((p, i) => {
    if (typeof p !== 'string') return [p];
    const segs = p.split(/(`[^`]+`)/g);
    return segs.map((seg, j) =>
      seg.startsWith('`') && seg.endsWith('`')
        ? <code key={`c${key}-${i}-${j}`} style={{ fontFamily: 'Consolas, monospace', fontSize: '0.9em', background: 'rgba(127,127,127,0.15)', padding: '1px 4px', borderRadius: 3 }}>{seg.slice(1, -1)}</code>
        : seg
    );
  });
  return parts;
}

function MarkdownNotes({ text }: { text: string }) {
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
          return <div key={i} style={{ fontSize: size, fontWeight: 600, marginTop: i ? 12 : 0, marginBottom: 6 }}>{renderInline(b.text, i)}</div>;
        }
        if (b.kind === 'ul') {
          return (
            <ul key={i} style={{ marginTop: 4, marginBottom: 4, paddingLeft: 20 }}>
              {b.items.map((it, j) => <li key={j} style={{ marginBottom: 2 }}>{renderInline(it, j)}</li>)}
            </ul>
          );
        }
        if (b.kind === 'code') {
          return (
            <pre key={i} style={{
              fontFamily: 'Consolas, monospace', fontSize: 12, padding: 8,
              backgroundColor: 'rgba(127,127,127,0.15)', borderRadius: 4,
              overflow: 'auto', margin: '8px 0',
            }}>{b.text}</pre>
          );
        }
        return <p key={i} style={{ margin: '6px 0', lineHeight: 1.5 }}>{renderInline(b.text, i)}</p>;
      })}
    </>
  );
}

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
    fontSize: 13, maxHeight: 360, overflowY: 'auto',
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
              <div className={s.notes}>
                {info.upstream.notes
                  ? <MarkdownNotes text={info.upstream.notes} />
                  : '(no release notes)'}
              </div>
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
