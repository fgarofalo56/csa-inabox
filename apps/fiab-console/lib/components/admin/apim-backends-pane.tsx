'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  tokens, Spinner, MessageBar, MessageBarBody, Button,
  Caption1, Tooltip, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent,
  DialogActions, Field, Input, Dropdown, Option, Textarea,
} from '@fluentui/react-components';
import { Delete24Regular, Edit24Regular } from '@fluentui/react-icons';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { ApimBackendSummary } from '@/lib/azure/apim-client';
import { apimFetchJson } from './apim-pane-fetch';

interface BackendForm {
  name: string;
  url: string;
  protocol: 'http' | 'soap';
  title: string;
  description: string;
}

const EMPTY_FORM: BackendForm = { name: '', url: '', protocol: 'http', title: '', description: '' };

export function ApimBackendsPane() {
  const [backends, setBackends] = useState<ApimBackendSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  // Create/edit dialog state. `editing` holds the original backend when editing
  // (its name is immutable — APIM keys the entity by name), or null for create.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ApimBackendSummary | null>(null);
  const [form, setForm] = useState<BackendForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  // Delete confirmation state.
  const [deleting, setDeleting] = useState<ApimBackendSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    apimFetchJson('/api/apim/backends')
      .then((d) => {
        if (d.ok && Array.isArray(d.backends)) {
          setBackends(d.backends as ApimBackendSummary[]);
        } else {
          setError((d.error as string) || 'Failed to load backends');
        }
        setLoading(false);
      })
      .catch((e) => { setError(e instanceof Error ? e.message : String(e)); setLoading(false); });
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const openCreate = useCallback(() => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogError(null);
    setDialogOpen(true);
  }, []);

  const openEdit = useCallback((b: ApimBackendSummary) => {
    setEditing(b);
    setForm({
      name: b.name,
      url: b.url || '',
      protocol: b.protocol === 'soap' ? 'soap' : 'http',
      title: b.title || '',
      description: b.description || '',
    });
    setDialogError(null);
    setDialogOpen(true);
  }, []);

  async function handleSave() {
    if (!form.url.trim()) { setDialogError('Runtime URL is required.'); return; }
    setSaving(true);
    setDialogError(null);
    try {
      // POST upserts by name (edit reuses the existing name; create derives one
      // from name or URL server-side). The route does a real ARM PUT /backends.
      const d = await apimFetchJson('/api/apim/backends', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: editing ? editing.name : (form.name.trim() || undefined),
          url: form.url.trim(),
          protocol: form.protocol,
          title: form.title.trim() || undefined,
          description: form.description.trim() || undefined,
        }),
      });
      if (d.ok) {
        setDialogOpen(false);
        reload();
      } else {
        setDialogError((d.error as string) || 'Save failed.');
      }
    } catch (e) {
      setDialogError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      const d = await apimFetchJson(`/api/apim/backends?id=${encodeURIComponent(deleting.name)}`, {
        method: 'DELETE',
      });
      if (d.ok) {
        setDeleting(null);
        reload();
      } else {
        setError((d.error as string) || 'Delete failed.');
        setDeleting(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDeleting(null);
    } finally {
      setDeleteBusy(false);
    }
  }

  const visibleBackends = useMemo(() => {
    if (!q.trim()) return backends;
    const f = q.toLowerCase();
    return backends.filter((b) =>
      b.title?.toLowerCase().includes(f) || b.url.toLowerCase().includes(f) || b.name.toLowerCase().includes(f)
    );
  }, [backends, q]);

  const columns: LoomColumn<ApimBackendSummary>[] = useMemo(() => [
    {
      key: 'title',
      label: 'Backend',
      width: 200,
      render: (b) => (
        <div>
          <strong>{b.title || b.name}</strong>
          {b.description && <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS }}>{b.description}</Caption1>}
        </div>
      ),
    },
    {
      key: 'url',
      label: 'URL',
      width: 300,
      render: (b) => (
        <Caption1 style={{ wordBreak: 'break-all', maxWidth: '300px' }}>
          {b.url}
        </Caption1>
      ),
    },
    {
      key: 'protocol',
      label: 'Protocol',
      width: 100,
      render: (b) => <Caption1>{b.protocol || 'http'}</Caption1>,
    },
    {
      key: 'actions',
      label: 'Actions',
      width: 100,
      sortable: false,
      render: (b) => (
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
          <Tooltip content="Edit backend" relationship="label">
            <Button size="small" icon={<Edit24Regular />} aria-label={`Edit backend ${b.title || b.name}`} onClick={() => openEdit(b)} />
          </Tooltip>
          <Tooltip content="Delete backend" relationship="label">
            <Button size="small" icon={<Delete24Regular />} aria-label={`Delete backend ${b.title || b.name}`} onClick={() => setDeleting(b)} />
          </Tooltip>
        </div>
      ),
    },
  ], [openEdit]);

  if (loading) return <Section><Spinner label="Loading backends..." /></Section>;
  if (error) {
    return (
      <Section>
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      </Section>
    );
  }

  return (
    <Section
      title="Backends"
      actions={<Button appearance="primary" onClick={openCreate}>Create backend</Button>}
    >
      <Toolbar
        search={q}
        onSearch={setQ}
        searchPlaceholder="Filter by name, URL..."
      />
      <LoomDataTable
        columns={columns}
        rows={visibleBackends}
        getRowId={(b) => b.id}
        empty="No backends defined."
        ariaLabel="APIM backends"
      />

      {/* Create / edit backend dialog — real ARM PUT /backends via the BFF. */}
      <Dialog open={dialogOpen} onOpenChange={(_, d) => setDialogOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{editing ? `Edit backend "${editing.title || editing.name}"` : 'Create backend'}</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                {dialogError && (
                  <MessageBar intent="error"><MessageBarBody>{dialogError}</MessageBarBody></MessageBar>
                )}
                <Field label="Name" hint={editing ? 'Backend identifier (immutable).' : 'Optional — derived from URL when blank.'}>
                  <Input
                    value={form.name}
                    disabled={!!editing}
                    placeholder="my-backend"
                    onChange={(_, d) => setForm((f) => ({ ...f, name: d.value }))}
                  />
                </Field>
                <Field label="Runtime URL" required>
                  <Input
                    value={form.url}
                    placeholder="https://contoso-functions.azurewebsites.net/api"
                    onChange={(_, d) => setForm((f) => ({ ...f, url: d.value }))}
                  />
                </Field>
                <Field label="Protocol">
                  <Dropdown
                    value={form.protocol}
                    selectedOptions={[form.protocol]}
                    onOptionSelect={(_, d) => setForm((f) => ({ ...f, protocol: (d.optionValue as 'http' | 'soap') || 'http' }))}
                  >
                    <Option value="http">HTTP(S) / REST</Option>
                    <Option value="soap">SOAP</Option>
                  </Dropdown>
                </Field>
                <Field label="Title" hint="Friendly display name shown in the backends list.">
                  <Input
                    value={form.title}
                    placeholder="Contoso Functions"
                    onChange={(_, d) => setForm((f) => ({ ...f, title: d.value }))}
                  />
                </Field>
                <Field label="Description">
                  <Textarea
                    value={form.description}
                    rows={2}
                    onChange={(_, d) => setForm((f) => ({ ...f, description: d.value }))}
                  />
                </Field>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
              <Button appearance="primary" onClick={handleSave} disabled={saving || !form.url.trim()}>
                {saving ? 'Saving...' : editing ? 'Save changes' : 'Create'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Delete confirmation. */}
      <Dialog open={!!deleting} onOpenChange={(_, d) => { if (!d.open) setDeleting(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete backend</DialogTitle>
            <DialogContent>
              Delete backend <strong>{deleting?.title || deleting?.name}</strong>? Policies that reference this
              backend (set-backend-service) will fail until updated. This cannot be undone.
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDeleting(null)} disabled={deleteBusy}>Cancel</Button>
              <Button appearance="primary" onClick={handleDelete} disabled={deleteBusy}>
                {deleteBusy ? 'Deleting...' : 'Delete'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </Section>
  );
}
