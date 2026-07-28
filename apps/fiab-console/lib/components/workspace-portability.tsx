'use client';

/**
 * WorkspacePortabilitySection — EXP1: the workspace Settings → Portability
 * tab (export / import / clone), the UI entry for whole-workspace
 * metadata-plane portability.
 *
 *   - Export  → GET  /api/workspaces/[id]/export  (downloads `<name>.loomws`;
 *               the post-export receipt shows the manifest counts + the
 *               explicit secrets-excluded note)
 *   - Import  → POST /api/workspaces/[id]/import  (guided wizard: pick a
 *               `.loomws` file → review its manifest → choose the collision
 *               strategy, 'new-ids' default → import; NEVER freeform JSON)
 *   - Clone   → POST /api/workspaces/[id]/clone   (name dialog → one click →
 *               link to the new workspace)
 *
 * All three call the real BFF routes (Cosmos-backed — no-vaporware.md); the
 * routes are kill-switched by the `exp1-workspace-portability` runtime flag
 * and refuse with a message naming the flag, which this surface renders
 * verbatim. Fluent v9 + tokens only.
 */

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button, Subtitle2, Caption1, Text, Divider, Badge,
  MessageBar, MessageBarBody, Field, Input,
  RadioGroup, Radio, Spinner,
  Dialog, DialogTrigger, DialogSurface, DialogBody, DialogTitle,
  DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowDownload20Regular, ArrowUpload20Regular, Copy20Regular,
  DocumentArrowRight20Regular, ShieldCheckmark16Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import type { Workspace } from '@/lib/api/workspaces';

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2,
    boxShadow: tokens.shadow4,
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0, flexWrap: 'wrap' },
  hint: { color: tokens.colorNeutralForeground3 },
  row: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  counts: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  fileName: { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },
});

/** Light client-side shape of the export manifest (server is authoritative). */
interface BundleManifestView {
  itemCount: number;
  folderCount: number;
  roleCount: number;
  scrubbedPaths: string[];
  secretsNote: string;
}

interface ParsedBundle {
  fileName: string;
  raw: unknown;
  source?: { workspaceId?: string; name?: string };
  workspaceName: string;
  manifest: BundleManifestView | null;
}

interface ImportSummaryView {
  strategy: string;
  created: number;
  skipped: number;
  overwritten: number;
  foldersCreated: number;
  foldersReused: number;
  refsRemapped: number;
}

async function readError(r: Response, fallback: string): Promise<string> {
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  return j?.error || `${fallback} (HTTP ${r.status})`;
}

export function WorkspacePortabilitySection({ workspace }: { workspace: Workspace }) {
  const s = useStyles();
  return (
    <div className={s.section}>
      <MessageBar intent="info">
        <MessageBarBody>
          Portability bundles carry this workspace&apos;s items, content, folders, and non-secret
          config as a portable <code>.loomws</code> file. Secrets are never included — Key Vault
          references stay references, and per-estate Azure backend bindings are re-provisioned on
          the importing side.
        </MessageBarBody>
      </MessageBar>
      <ExportCard workspace={workspace} />
      <ImportCard workspace={workspace} />
      <CloneCard workspace={workspace} />
    </div>
  );
}

// ── Export ─────────────────────────────────────────────────────────────────

function ExportCard({ workspace }: { workspace: Workspace }) {
  const s = useStyles();
  const mut = useMutation({
    mutationFn: async (): Promise<BundleManifestView | null> => {
      const r = await clientFetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/export`);
      if (!r.ok) throw new Error(await readError(r, 'Export failed'));
      const text = await r.text();
      // Trigger the browser download of the exact server payload.
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${workspace.name || 'workspace'}.loomws`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      try {
        const parsed = JSON.parse(text) as { manifest?: BundleManifestView };
        return parsed.manifest ?? null;
      } catch {
        return null;
      }
    },
  });
  const manifest = mut.data;
  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <ArrowDownload20Regular />
        <Subtitle2>Export workspace</Subtitle2>
      </div>
      <Caption1 className={s.hint}>
        Download everything in “{workspace.name}” — items with their content, folder structure,
        non-secret settings, and an informational member list — as a single .loomws bundle you can
        import into another workspace or estate.
      </Caption1>
      {mut.error && (
        <MessageBar intent="error"><MessageBarBody>{(mut.error as Error).message}</MessageBarBody></MessageBar>
      )}
      {mut.isSuccess && manifest && (
        <MessageBar intent="success">
          <MessageBarBody>
            Exported {manifest.itemCount} item{manifest.itemCount === 1 ? '' : 's'},{' '}
            {manifest.folderCount} folder{manifest.folderCount === 1 ? '' : 's'}.{' '}
            <ShieldCheckmark16Regular aria-hidden />{' '}
            Secrets excluded ({manifest.scrubbedPaths?.length ?? 0} value
            {(manifest.scrubbedPaths?.length ?? 0) === 1 ? '' : 's'} scrubbed — listed in the
            bundle manifest).
          </MessageBarBody>
        </MessageBar>
      )}
      <div className={s.row}>
        <Button appearance="primary" icon={<ArrowDownload20Regular />}
          onClick={() => mut.mutate()} disabled={mut.isPending}>
          {mut.isPending ? 'Exporting…' : 'Export (.loomws)'}
        </Button>
        {mut.isPending && <Spinner size="tiny" />}
      </div>
    </div>
  );
}

// ── Import wizard ──────────────────────────────────────────────────────────

function ImportCard({ workspace }: { workspace: Workspace }) {
  const s = useStyles();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [parsed, setParsed] = useState<ParsedBundle | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<'new-ids' | 'skip-existing' | 'overwrite'>('new-ids');

  const mut = useMutation({
    mutationFn: async (): Promise<ImportSummaryView> => {
      const r = await clientFetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bundle: parsed?.raw, strategy }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; summary?: ImportSummaryView };
      if (!r.ok || !j.ok || !j.summary) throw new Error(j?.error || `Import failed (HTTP ${r.status})`);
      return j.summary;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['items', workspace.id] });
      void qc.invalidateQueries({ queryKey: ['folders', workspace.id] });
      void qc.invalidateQueries({ queryKey: ['workspace', workspace.id] });
    },
  });

  const onFile = async (file: File | undefined) => {
    setParseError(null);
    setParsed(null);
    mut.reset();
    if (!file) return;
    try {
      const text = await file.text();
      const raw = JSON.parse(text) as Record<string, unknown>;
      if (raw?.loomws !== 1) {
        setParseError('Not a .loomws workspace bundle (expected { loomws: 1, … }). App bundles (.loomapp) are imported from the app catalog instead.');
        return;
      }
      const wsBlock = (raw.workspace ?? {}) as { name?: string };
      const manifest = (raw.manifest ?? null) as BundleManifestView | null;
      setParsed({
        fileName: file.name,
        raw,
        source: raw.source as ParsedBundle['source'],
        workspaceName: wsBlock.name || file.name,
        manifest,
      });
    } catch {
      setParseError('That file is not valid JSON — pick a .loomws bundle exported from a workspace.');
    }
  };

  const reset = () => {
    setParsed(null);
    setParseError(null);
    setStrategy('new-ids');
    mut.reset();
    if (fileRef.current) fileRef.current.value = '';
  };

  const summary = mut.data;
  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <ArrowUpload20Regular />
        <Subtitle2>Import a bundle</Subtitle2>
      </div>
      <Caption1 className={s.hint}>
        Bring a .loomws bundle&apos;s items and folders into this workspace. You choose how name
        collisions are handled before anything is written.
      </Caption1>
      <div className={s.row}>
        <Dialog open={open} onOpenChange={(_, d) => { setOpen(d.open); if (!d.open) reset(); }}>
          <DialogTrigger disableButtonEnhancement>
            <Button icon={<ArrowUpload20Regular />}>Import into this workspace…</Button>
          </DialogTrigger>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Import a .loomws bundle</DialogTitle>
              <DialogContent>
                <div className={s.section}>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".loomws,application/json,.json"
                    style={{ display: 'none' }}
                    onChange={(e) => void onFile(e.target.files?.[0])}
                  />
                  <div className={s.row}>
                    <Button icon={<DocumentArrowRight20Regular />} onClick={() => fileRef.current?.click()}>
                      {parsed ? 'Choose a different file…' : 'Choose a .loomws file…'}
                    </Button>
                    {parsed && <Text className={s.fileName}>{parsed.fileName}</Text>}
                  </div>
                  {parseError && (
                    <MessageBar intent="error"><MessageBarBody>{parseError}</MessageBarBody></MessageBar>
                  )}
                  {parsed && (
                    <>
                      <Divider />
                      <Subtitle2>“{parsed.workspaceName}”</Subtitle2>
                      <div className={s.counts}>
                        <Badge appearance="tint">{parsed.manifest?.itemCount ?? '?'} items</Badge>
                        <Badge appearance="tint">{parsed.manifest?.folderCount ?? '?'} folders</Badge>
                        {parsed.source?.name && <Badge appearance="outline">from {parsed.source.name}</Badge>}
                      </div>
                      <MessageBar intent="info">
                        <MessageBarBody>
                          <ShieldCheckmark16Regular aria-hidden /> This bundle format never carries
                          secret values{parsed.manifest ? ` (${parsed.manifest.scrubbedPaths?.length ?? 0} excluded at export — see its manifest)` : ''}.
                          Imported items re-provision their Azure backends on first use; the
                          bundle&apos;s member list is informational and is not applied.
                        </MessageBarBody>
                      </MessageBar>
                      <Field label="If an item with the same type and name already exists here">
                        <RadioGroup value={strategy} onChange={(_, d) => setStrategy(d.value as typeof strategy)}>
                          <Radio value="new-ids" label="Create everything as new items (default — nothing here is touched)" />
                          <Radio value="skip-existing" label="Skip it — keep the existing item, import only what's new" />
                          <Radio value="overwrite" label="Overwrite it — replace the existing item's content with the bundle's" />
                        </RadioGroup>
                      </Field>
                    </>
                  )}
                  {mut.error && (
                    <MessageBar intent="error"><MessageBarBody>{(mut.error as Error).message}</MessageBarBody></MessageBar>
                  )}
                  {summary && (
                    <MessageBar intent="success">
                      <MessageBarBody>
                        Imported: {summary.created} created, {summary.skipped} skipped,{' '}
                        {summary.overwritten} overwritten · {summary.foldersCreated} folder
                        {summary.foldersCreated === 1 ? '' : 's'} created
                        {summary.foldersReused ? `, ${summary.foldersReused} reused` : ''}
                        {summary.refsRemapped ? ` · ${summary.refsRemapped} cross-references relinked` : ''}.
                      </MessageBarBody>
                    </MessageBar>
                  )}
                </div>
              </DialogContent>
              <DialogActions>
                <DialogTrigger disableButtonEnhancement>
                  <Button appearance="secondary">{summary ? 'Close' : 'Cancel'}</Button>
                </DialogTrigger>
                {!summary && (
                  <Button appearance="primary" icon={<ArrowUpload20Regular />}
                    disabled={!parsed || mut.isPending}
                    onClick={() => mut.mutate()}>
                    {mut.isPending ? 'Importing…' : 'Import'}
                  </Button>
                )}
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </div>
    </div>
  );
}

// ── Clone ──────────────────────────────────────────────────────────────────

function CloneCard({ workspace }: { workspace: Workspace }) {
  const s = useStyles();
  const qc = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(`${workspace.name} (clone)`);

  const mut = useMutation({
    mutationFn: async (): Promise<{ id: string; name: string }> => {
      const r = await clientFetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/clone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; workspace?: { id: string; name: string } };
      if (!r.ok || !j.ok || !j.workspace) throw new Error(j?.error || `Clone failed (HTTP ${r.status})`);
      return j.workspace;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workspaces'] });
    },
  });

  const clone = mut.data;
  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <Copy20Regular />
        <Subtitle2>Clone workspace</Subtitle2>
      </div>
      <Caption1 className={s.hint}>
        Create a new workspace you own with a copy of every item and folder in “{workspace.name}”.
        Clones get fresh ids and re-provision their own Azure backends — nothing is shared with the
        original. Access is not copied; you share the clone deliberately.
      </Caption1>
      <div className={s.row}>
        <Dialog open={open} onOpenChange={(_, d) => { setOpen(d.open); if (!d.open) { mut.reset(); setName(`${workspace.name} (clone)`); } }}>
          <DialogTrigger disableButtonEnhancement>
            <Button icon={<Copy20Regular />}>Clone…</Button>
          </DialogTrigger>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Clone “{workspace.name}”</DialogTitle>
              <DialogContent>
                <div className={s.section}>
                  <Field label="New workspace name" required>
                    <Input value={name} onChange={(_, d) => setName(d.value)} />
                  </Field>
                  {mut.error && (
                    <MessageBar intent="error"><MessageBarBody>{(mut.error as Error).message}</MessageBarBody></MessageBar>
                  )}
                  {clone && (
                    <MessageBar intent="success">
                      <MessageBarBody>Cloned to “{clone.name}”.</MessageBarBody>
                    </MessageBar>
                  )}
                </div>
              </DialogContent>
              <DialogActions>
                <DialogTrigger disableButtonEnhancement>
                  <Button appearance="secondary">{clone ? 'Close' : 'Cancel'}</Button>
                </DialogTrigger>
                {clone ? (
                  <Button appearance="primary" onClick={() => { setOpen(false); router.push(`/workspaces/${clone.id}`); }}>
                    Open the clone
                  </Button>
                ) : (
                  <Button appearance="primary" icon={<Copy20Regular />}
                    disabled={!name.trim() || mut.isPending}
                    onClick={() => mut.mutate()}>
                    {mut.isPending ? 'Cloning…' : 'Clone'}
                  </Button>
                )}
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </div>
    </div>
  );
}
