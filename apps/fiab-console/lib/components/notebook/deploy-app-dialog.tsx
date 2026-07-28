'use client';

/**
 * N19a — "Deploy as app" dialog for the Loom notebook.
 *
 * Publishes the open notebook as a runnable Loom app through the SHARED org-app
 * publish path (POST /api/items/notebook/[id]/deploy-app → a real `loom-app`
 * item + the same `stampPublish` versioning the loom-app editor uses). The
 * consumer opens /apps/view/<id> and runs the notebook there — no notebook
 * editor, no Fabric, no Power BI.
 *
 * Every control is wired to the real route; the dialog shows the live
 * deployment state (version, published-at, consumer URL) it reads back from the
 * server, never an optimistic guess.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Field, Input, Textarea, Caption1, Badge, Spinner, Link,
  MessageBar, MessageBarBody, MessageBarTitle,
  tokens,
} from '@fluentui/react-components';
import { RocketRegular, OpenRegular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';

export interface NotebookDeployment {
  appId: string;
  displayName: string;
  published: boolean;
  version: number;
  publishedAt: string | null;
  url: string;
  audiences: { name: string; principals: number }[];
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notebookId: string;
  notebookName: string;
  /** Status-line reporter so the deploy shows up in the editor's run message. */
  onStatus?: (msg: string) => void;
}

export function DeployAppDialog({ open, onOpenChange, notebookId, notebookName, onStatus }: Props) {
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [deployment, setDeployment] = useState<NotebookDeployment | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [principals, setPrincipals] = useState('');

  const load = useCallback(async () => {
    if (!notebookId) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await clientFetch(`/api/items/notebook/${encodeURIComponent(notebookId)}/deploy-app`);
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `load failed (${r.status})`); return; }
      setDeployment(j.deployment || null);
      setName(j.deployment?.displayName || `${notebookName} app`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [notebookId, notebookName]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  const submit = useCallback(async (unpublish: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await clientFetch(`/api/items/notebook/${encodeURIComponent(notebookId)}/deploy-app`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(unpublish ? { unpublish: true } : {
          displayName: name,
          description,
          principals: principals.split(/[,;\n]/).map((p) => p.trim()).filter(Boolean),
        }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `deploy failed (${r.status})`); return; }
      onStatus?.(unpublish
        ? 'App retracted — consumers can no longer open it.'
        : `Deployed as app v${j.version} — ${j.url}`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [notebookId, name, description, principals, onStatus, load]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
              <RocketRegular /> Deploy notebook as app
            </span>
          </DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Publishes this notebook as a Loom app so people who should run it — but not edit it — open a
                clean consumer page instead of the notebook editor. It uses the same org-app publish path,
                so the app appears in Apps alongside every other published app and versions the same way.
              </Caption1>

              {loading && <Spinner size="tiny" label="Loading deployment…" />}

              {err && (
                <MessageBar intent="error" layout="multiline">
                  <MessageBarBody><MessageBarTitle>Deploy failed</MessageBarTitle>{err}</MessageBarBody>
                </MessageBar>
              )}

              {deployment && (
                <MessageBar intent={deployment.published ? 'success' : 'info'} layout="multiline">
                  <MessageBarBody>
                    <MessageBarTitle>
                      {deployment.published ? 'Deployed' : 'Retracted'}
                    </MessageBarTitle>
                    <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', columnGap: tokens.spacingHorizontalXS, rowGap: tokens.spacingVerticalXXS, minWidth: 0 }}>
                      <Badge appearance="tint" size="small">v{deployment.version}</Badge>
                      {deployment.publishedAt && <Caption1>{new Date(deployment.publishedAt).toLocaleString()}</Caption1>}
                      <Link href={deployment.url} target="_blank" rel="noreferrer">
                        Open app <OpenRegular />
                      </Link>
                    </span>
                  </MessageBarBody>
                </MessageBar>
              )}

              <Field label="App name" hint="Shown to consumers in Apps.">
                <Input value={name} onChange={(_, d) => setName(d.value)} disabled={busy} />
              </Field>
              <Field label="Description" hint="What this app does — shown on the app landing page.">
                <Textarea value={description} onChange={(_, d) => setDescription(d.value)} rows={2} disabled={busy} />
              </Field>
              <Field
                label="Who can open it"
                hint="Emails, UPNs, object ids or group ids, comma-separated. Leave empty to give everyone with workspace access the app."
              >
                <Textarea value={principals} onChange={(_, d) => setPrincipals(d.value)} rows={2} disabled={busy} />
              </Field>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)} disabled={busy}>Close</Button>
            {deployment?.published && (
              <Button appearance="secondary" onClick={() => void submit(true)} disabled={busy}>Retract</Button>
            )}
            <Button appearance="primary" icon={<RocketRegular />} onClick={() => void submit(false)} disabled={busy || !name.trim()}>
              {busy ? 'Deploying…' : deployment ? 'Re-deploy' : 'Deploy'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
