'use client';

/**
 * RequestAccessButton — the sign-in-boundary "Request access" affordance.
 *
 * Shown wherever a person hits the front door without access (the SignInRequired
 * message bar, the app-shell top bar next to "Sign in"). Opens a Fluent Dialog
 * where they enter their Microsoft identity (name, work email, organization,
 * reason) and, optionally, their Entra object/tenant ids. Submitting POSTs to the
 * UNAUTHENTICATED /api/access-requests/public endpoint (plain fetch — this surface
 * is pre-auth, so no session/credentials handling) and shows a success MessageBar.
 * Routed to the tenant admin's onboarding queue at /admin/access-requests.
 *
 * Web3.0 / Loom design tokens throughout — no raw px, no ad-hoc colors.
 */
import { useState, useCallback } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  DialogTrigger, Button, Field, Input, Textarea, Accordion, AccordionItem,
  AccordionHeader, AccordionPanel, MessageBar, MessageBarBody, MessageBarTitle,
  Spinner, Caption1, Subtitle2, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  PersonAddRegular, SendRegular, CheckmarkCircleFilled,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  surface: { maxWidth: '540px' },
  field: { marginBottom: tokens.spacingVerticalM },
  intro: { color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalL, display: 'block' },
  titleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  titleIcon: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '36px', height: '36px', flexShrink: 0,
    borderRadius: tokens.borderRadiusLarge,
    backgroundImage: `linear-gradient(135deg, ${tokens.colorBrandBackground2}, ${tokens.colorBrandBackground})`,
    color: tokens.colorNeutralForegroundOnBrand, fontSize: '20px', boxShadow: tokens.shadow4,
  },
  titleText: { display: 'flex', flexDirection: 'column', minWidth: 0, gap: tokens.spacingVerticalXXS },
  titleSub: { color: tokens.colorNeutralForeground3 },
  advanced: { marginTop: tokens.spacingVerticalS, marginBottom: tokens.spacingVerticalM },
  // Off-screen honeypot — a real user never sees or fills it; bots do.
  honeypot: {
    position: 'absolute', left: '-9999px', width: '1px', height: '1px',
    overflow: 'hidden', opacity: 0,
  },
  reasonHint: { color: tokens.colorNeutralForeground3, display: 'block', marginTop: tokens.spacingVerticalXXS },
});

const REASON_MAX = 500;

interface Props {
  /** Button appearance — 'primary' on the shell top bar, 'secondary' inline. */
  appearance?: 'primary' | 'secondary' | 'outline' | 'subtle' | 'transparent';
  size?: 'small' | 'medium' | 'large';
}

export function RequestAccessButton({ appearance = 'secondary', size = 'medium' }: Props) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [organization, setOrganization] = useState('');
  const [reason, setReason] = useState('');
  const [aadObjectId, setAadObjectId] = useState('');
  const [aadTenantId, setAadTenantId] = useState('');
  const [honeypot, setHoneypot] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const reset = useCallback(() => {
    setDisplayName(''); setEmail(''); setOrganization(''); setReason('');
    setAadObjectId(''); setAadTenantId(''); setHoneypot('');
    setBusy(false); setError(null); setDone(false);
  }, []);

  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (next) reset();
  }, [reset]);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // Plain fetch: this endpoint is deliberately unauthenticated (the caller
      // has no session yet), so no clientFetch session/refresh handling.
      const r = await fetch('/api/access-requests/public', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName, email, organization, reason,
          aadObjectId: aadObjectId || undefined,
          aadTenantId: aadTenantId || undefined,
          company_website: honeypot, // honeypot — server drops if populated
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 429) {
        setError('Too many requests. Please wait a little while and try again.');
        return;
      }
      if (!r.ok || j.ok === false) {
        setError(j.error || `Could not submit your request (HTTP ${r.status}).`);
        return;
      }
      setDone(true);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }, [displayName, email, organization, reason, aadObjectId, aadTenantId, honeypot]);

  const canSubmit = displayName.trim() && email.trim() && reason.trim() && !busy;

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogTrigger disableButtonEnhancement>
        <Button appearance={appearance} size={size} icon={<PersonAddRegular />}>
          Request access
        </Button>
      </DialogTrigger>
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>
            <div className={styles.titleRow}>
              <span className={styles.titleIcon} aria-hidden><PersonAddRegular /></span>
              <span className={styles.titleText}>
                <Subtitle2>Request access to CSA Loom</Subtitle2>
                <Caption1 className={styles.titleSub}>An administrator will review and set you up</Caption1>
              </span>
            </div>
          </DialogTitle>
          <DialogContent>
            {done ? (
              <MessageBar intent="success" layout="multiline">
                <MessageBarBody>
                  <MessageBarTitle>Request sent</MessageBarTitle>
                  Thanks — an administrator will review your request and set you up. You&apos;ll
                  be able to sign in once your access is granted. You can close this window.
                </MessageBarBody>
              </MessageBar>
            ) : (
              <>
                <Caption1 className={styles.intro}>
                  Tell us who you are and why you need access. We&apos;ll route your request to a
                  Loom administrator, who adds you to the tenant so you can sign in.
                </Caption1>

                {/* Honeypot: hidden from humans, catches bots. */}
                <div className={styles.honeypot} aria-hidden>
                  <label>
                    Company website
                    <input
                      type="text" tabIndex={-1} autoComplete="off"
                      value={honeypot} onChange={(e) => setHoneypot(e.target.value)}
                    />
                  </label>
                </div>

                <Field label="Your name" required className={styles.field}>
                  <Input
                    value={displayName} onChange={(_, d) => setDisplayName(d.value)}
                    placeholder="Ada Lovelace" maxLength={120} autoComplete="name"
                  />
                </Field>
                <Field label="Work email" required className={styles.field}>
                  <Input
                    type="email" value={email} onChange={(_, d) => setEmail(d.value)}
                    placeholder="ada@contoso.com" maxLength={200} autoComplete="email"
                  />
                </Field>
                <Field label="Organization" className={styles.field}>
                  <Input
                    value={organization} onChange={(_, d) => setOrganization(d.value)}
                    placeholder="Contoso Ltd." maxLength={160} autoComplete="organization"
                  />
                </Field>
                <Field label="Why do you need access?" required className={styles.field}>
                  <Textarea
                    rows={3} value={reason}
                    onChange={(_, d) => setReason(d.value.slice(0, REASON_MAX))}
                    placeholder="Briefly describe your role and what you'll do in Loom"
                    resize="vertical" maxLength={REASON_MAX}
                  />
                  <Caption1 className={styles.reasonHint}>{reason.length}/{REASON_MAX}</Caption1>
                </Field>

                <Accordion collapsible className={styles.advanced}>
                  <AccordionItem value="advanced">
                    <AccordionHeader>Microsoft Entra details (optional)</AccordionHeader>
                    <AccordionPanel>
                      <Field label="Entra object id" className={styles.field}>
                        <Input
                          value={aadObjectId} onChange={(_, d) => setAadObjectId(d.value)}
                          placeholder="00000000-0000-0000-0000-000000000000"
                        />
                      </Field>
                      <Field label="Entra tenant id" className={styles.field}>
                        <Input
                          value={aadTenantId} onChange={(_, d) => setAadTenantId(d.value)}
                          placeholder="00000000-0000-0000-0000-000000000000"
                        />
                      </Field>
                    </AccordionPanel>
                  </AccordionItem>
                </Accordion>

                {error && (
                  <MessageBar intent="error" layout="multiline">
                    <MessageBarBody>{error}</MessageBarBody>
                  </MessageBar>
                )}
              </>
            )}
          </DialogContent>
          <DialogActions>
            {done ? (
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="primary">Close</Button>
              </DialogTrigger>
            ) : (
              <>
                <Button
                  appearance="primary"
                  icon={busy ? <Spinner size="tiny" /> : <SendRegular />}
                  disabled={!canSubmit}
                  onClick={submit}
                >
                  {busy ? 'Sending…' : 'Send request'}
                </Button>
                <DialogTrigger disableButtonEnhancement>
                  <Button appearance="secondary">Cancel</Button>
                </DialogTrigger>
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
