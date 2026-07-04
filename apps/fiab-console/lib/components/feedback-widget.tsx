'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * FeedbackWidget — dialog opened by the topbar 'Send feedback' icon
 * AND the 'Send feedback' button pinned at the bottom of the left
 * nav. Two tabs (Bug / Feature). Privacy block visible in-dialog.
 * No floating button (it overlapped the brand and content).
 */

import { useEffect, useState } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Textarea, Input, Tab, TabList, Caption1, Body1, Badge,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Bug24Regular, Lightbulb24Regular } from '@fluentui/react-icons';
import { redact, scrubEnv } from '@/lib/feedback/redaction';

/**
 * Capture the current route as a client-only string post-mount. Avoids the
 * SSR vs CSR hydration mismatch the old `typeof window` ternary produced
 * when the Dialog was ever pre-rendered.
 */
function useClientRoute(): string {
  const [route, setRoute] = useState('—');
  useEffect(() => {
    try { setRoute(new URL(window.location.href).pathname); } catch { /* keep — */ }
  }, []);
  return route;
}

const LOOM_VERSION = process.env.NEXT_PUBLIC_LOOM_VERSION || 'dev';
const EVT_OPEN = 'csaloom:open-feedback';

export function openFeedback() {
  window.dispatchEvent(new Event(EVT_OPEN));
}

const useStyles = makeStyles({
  surface: { maxWidth: '560px', width: '95vw' },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalMNudge, marginTop: tokens.spacingVerticalS },
  privacy: {
    padding: tokens.spacingHorizontalMNudge, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2,
    fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  ok: { padding: tokens.spacingHorizontalM, borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorPaletteGreenBackground2, color: tokens.colorPaletteGreenForeground1 },
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
  const route = useClientRoute();

  useEffect(() => {
    const o = () => { reset(); setOpen(true); };
    window.addEventListener(EVT_OPEN, o);
    return () => window.removeEventListener(EVT_OPEN, o);
  }, []);

  async function send() {
    setSubmitting(true);
    const env = scrubEnv({
      url: typeof window !== 'undefined' ? window.location.href : undefined,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      loomVersion: LOOM_VERSION,
    });
    try {
      const r = await clientFetch('/api/feedback', {
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
                    <Body1 style={{ marginTop: tokens.spacingVerticalSNudge }}>
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
                      Route: <code>{route}</code>
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
  );
}
