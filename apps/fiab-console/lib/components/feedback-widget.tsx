'use client';

/**
 * FeedbackWidget — floating "Send feedback" button bottom-right.
 * Opens a Dialog with two tabs: Bug / Feature. Captures the current
 * URL, browser UA, and Loom version, scrubs everything client-side,
 * POSTs to /api/feedback. Shows the resulting upstream issue link
 * when configured.
 */

import { useState } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Textarea, Input, Tab, TabList, Caption1, Body1, Badge,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Bug24Regular, Lightbulb24Regular, ChatHelp24Regular } from '@fluentui/react-icons';
import { redact, scrubEnv } from '@/lib/feedback/redaction';

const LOOM_VERSION = process.env.NEXT_PUBLIC_LOOM_VERSION || 'dev';

const useStyles = makeStyles({
  toggle: {
    position: 'fixed', right: 16, bottom: 16,
    zIndex: 900,
    borderRadius: 999,
    paddingLeft: 16, paddingRight: 16,
    boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
  },
  surface: { maxWidth: 560, width: '95vw' },
  form: { display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 },
  privacy: {
    padding: 10, borderRadius: 6,
    backgroundColor: tokens.colorNeutralBackground2,
    fontSize: 12, color: tokens.colorNeutralForeground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  ok: { padding: 12, borderRadius: 6, backgroundColor: tokens.colorPaletteGreenBackground2, color: tokens.colorPaletteGreenForeground1 },
});

interface Result { status: string; issueNumber?: number; issueUrl?: string; forwarded?: boolean }

export function FeedbackWidget() {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'bug' | 'feature'>('bug');
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function send() {
    setSubmitting(true);
    const env = scrubEnv({
      url: typeof window !== 'undefined' ? window.location.href : undefined,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      loomVersion: LOOM_VERSION,
    });
    try {
      const r = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: tab,
          title: redact(title),
          description: redact(desc),
          ...env,
        }),
      });
      const j = (await r.json()) as Result;
      setResult(j);
    } catch {
      setResult({ status: 'error' });
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setTitle(''); setDesc(''); setResult(null); setSubmitting(false);
  }

  return (
    <>
      <Button
        className={s.toggle}
        appearance="primary"
        icon={<ChatHelp24Regular />}
        onClick={() => { reset(); setOpen(true); }}
        aria-label="Send feedback"
      >
        Feedback
      </Button>
      <Dialog open={open} onOpenChange={(_, d) => { setOpen(d.open); if (!d.open) reset(); }}>
        <DialogSurface className={s.surface}>
          <DialogBody>
            <DialogTitle>Send feedback</DialogTitle>
            <DialogContent>
              {result ? (
                <div className={s.ok}>
                  <Body1>
                    {result.forwarded
                      ? `Thanks — forwarded to the CSA Loom maintainers as issue #${result.issueNumber}.`
                      : 'Thanks — your feedback was captured locally. The maintainer will pull it on the next sync.'}
                  </Body1>
                  {result.issueUrl && (
                    <Body1 style={{ marginTop: 6 }}>
                      <a href={result.issueUrl} target="_blank" rel="noreferrer">View on GitHub →</a>
                    </Body1>
                  )}
                </div>
              ) : (
                <>
                  <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'bug' | 'feature')}>
                    <Tab value="bug" icon={<Bug24Regular />}>File a bug</Tab>
                    <Tab value="feature" icon={<Lightbulb24Regular />}>Request a feature</Tab>
                  </TabList>
                  <div className={s.form}>
                    <Caption1>{tab === 'bug' ? 'What broke?' : 'What would make Loom better?'}</Caption1>
                    <Input value={title} onChange={(_, d) => setTitle(d.value)}
                      placeholder={tab === 'bug' ? 'e.g. Notebook editor crashes when running an empty cell' : 'e.g. Add export-to-CSV on the OneLake catalog'} />
                    <Caption1>Details</Caption1>
                    <Textarea rows={6} value={desc} onChange={(_, d) => setDesc(d.value)}
                      placeholder="Steps to reproduce, screenshots, expected vs actual behavior… (no PII please)" />
                    <div className={s.privacy}>
                      <b>Privacy:</b> Loom strips user names, emails, workspace and item IDs, hostnames,
                      IPs, and any sensitive-looking strings from your report before sending.
                      Only the route you&apos;re on, your browser family, and the redacted text are forwarded
                      to the CSA Loom maintainers. Your tenant ID is hashed (irreversible) for de-duplication.
                    </div>
                    <Caption1>
                      Route: <code>{typeof window !== 'undefined' ? new URL(window.location.href).pathname : '—'}</code>
                      {'  ·  '}
                      Loom version: <Badge appearance="outline">{LOOM_VERSION}</Badge>
                    </Caption1>
                  </div>
                </>
              )}
            </DialogContent>
            <DialogActions>
              {result ? (
                <Button appearance="primary" onClick={() => { reset(); setOpen(false); }}>Close</Button>
              ) : (
                <>
                  <Button appearance="secondary" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button appearance="primary" onClick={send} disabled={submitting || !title.trim()}>
                    {submitting ? 'Sending…' : tab === 'bug' ? 'File bug' : 'Request feature'}
                  </Button>
                </>
              )}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
