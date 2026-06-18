'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  makeStyles, tokens, Spinner, MessageBar, MessageBarBody, Button, Badge,
  Caption1, Tooltip, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent,
  DialogActions, Field, Input, Switch,
} from '@fluentui/react-components';
import { Delete24Regular, Edit24Regular } from '@fluentui/react-icons';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { ApimApiSummary } from '@/lib/azure/apim-client';
import { apimFetchJson } from './apim-pane-fetch';

const useStyles = makeStyles({
  protocolBadge: { marginRight: tokens.spacingHorizontalS },
});

const PROTOCOL_OPTIONS = ['https', 'http'] as const;

interface ApiForm {
  id: string;
  displayName: string;
  path: string;
  protocols: string[];
  serviceUrl: string;
  subscriptionRequired: boolean;
}

const EMPTY_FORM: ApiForm = {
  id: '',
  displayName: '',
  path: '',
  protocols: ['https'],
  serviceUrl: '',
  subscriptionRequired: true,
};

export function ApimApisPane() {
  const styles = useStyles();
  const [apis, setApis] = useState<ApimApiSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  // Create / edit dialog state. `editing` holds the original API when editing
  // (its name is immutable — APIM keys the entity by name), or null for create.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ApimApiSummary | null>(null);
  const [form, setForm] = useState<ApiForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  // Delete confirmation state.
  const [deleting, setDeleting] = useState<ApimApiSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    // apimFetchJson reads the body as text first and surfaces a non-JSON body
    // (HTML 404/500 page) or an honest 503 config-gate as a readable error
    // instead of crashing the pane with "Unexpected token '<'".
    apimFetchJson('/api/items/apim-api')
      .then((d) => {
        if (d.ok && Array.isArray(d.apis)) {
          setApis(d.apis as ApimApiSummary[]);
        } else {
          setError(d.error || 'Failed to load APIs');
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

  const openEdit = useCallback((a: ApimApiSummary) => {
    setEditing(a);
    setForm({
      id: a.name,
      displayName: a.displayName || '',
      path: a.path || '',
      protocols: a.protocols && a.protocols.length ? a.protocols : ['https'],
      serviceUrl: a.serviceUrl || '',
      subscriptionRequired: a.subscriptionRequired !== false,
    });
    setDialogError(null);
    setDialogOpen(true);
  }, []);

  async function handleSave() {
    if (!form.displayName.trim()) { setDialogError('Display name is required.'); return; }
    if (!form.path.trim()) { setDialogError('API URL suffix (path) is required.'); return; }
    setSaving(true);
    setDialogError(null);
    try {
      // POST upserts: create derives an id from displayName server-side; edit
      // reuses the existing name. The route does a real ARM PUT /apis.
      const d = await apimFetchJson('/api/items/apim-api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: editing ? editing.name : (form.id.trim() || undefined),
          displayName: form.displayName.trim(),
          path: form.path.trim(),
          protocols: form.protocols.length ? form.protocols : ['https'],
          serviceUrl: form.serviceUrl.trim() || undefined,
          subscriptionRequired: form.subscriptionRequired,
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
      const d = await apimFetchJson(`/api/items/apim-api/${encodeURIComponent(deleting.name)}`, {
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

  function toggleProtocol(p: string) {
    setForm((f) => {
      const has = f.protocols.includes(p);
      const next = has ? f.protocols.filter((x) => x !== p) : [...f.protocols, p];
      return { ...f, protocols: next.length ? next : [p] };
    });
  }

  const visibleApis = useMemo(() => {
    if (!q.trim()) return apis;
    const f = q.toLowerCase();
    return apis.filter((a) =>
      a.displayName.toLowerCase().includes(f) ||
      a.path.toLowerCase().includes(f) ||
      a.name.toLowerCase().includes(f)
    );
  }, [apis, q]);

  const columns: LoomColumn<ApimApiSummary>[] = useMemo(() => [
    {
      key: 'displayName',
      label: 'Name',
      width: 240,
      render: (a) => (
        <div>
          <strong>{a.displayName}</strong>
          <Caption1 style={{ display: 'block', marginTop: '4px', color: tokens.colorNeutralForeground3 }}>{a.path}</Caption1>
        </div>
      ),
    },
    {
      key: 'protocols',
      label: 'Protocols',
      width: 140,
      render: (a) => (
        <div>
          {(a.protocols || []).map((p) => (
            <Badge key={p} className={styles.protocolBadge} appearance="outline" size="small">
              {p.toUpperCase()}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      key: 'subscriptionRequired',
      label: 'Requires key',
      width: 120,
      render: (a) => (
        <Badge appearance="outline" color={a.subscriptionRequired ? 'success' : 'warning'}>
          {a.subscriptionRequired ? 'Yes' : 'No'}
        </Badge>
      ),
    },
    {
      key: 'actions',
      label: 'Actions',
      width: 120,
      sortable: false,
      render: (a) => (
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
          <Tooltip content="Edit API" relationship="label">
            <Button
              size="small"
              appearance="subtle"
              icon={<Edit24Regular />}
              aria-label={`Edit ${a.displayName}`}
              onClick={() => openEdit(a)}
            />
          </Tooltip>
          <Tooltip content="Delete API" relationship="label">
            <Button
              size="small"
              appearance="subtle"
              icon={<Delete24Regular />}
              aria-label={`Delete ${a.displayName}`}
              onClick={() => setDeleting(a)}
            />
          </Tooltip>
        </div>
      ),
    },
  ], [styles, openEdit]);

  if (loading) return <Section><Spinner label="Loading APIs..." /></Section>;

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
      title="APIs"
      actions={<Button appearance="primary" onClick={openCreate}>Create API</Button>}
    >
      <Toolbar
        search={q}
        onSearch={setQ}
        searchPlaceholder="Filter by name, path..."
      />
      <LoomDataTable
        columns={columns}
        rows={visibleApis}
        getRowId={(a) => a.id}
        empty="No APIs defined."
        ariaLabel="APIM APIs"
      />

      {/* Create / edit API dialog — real ARM PUT /apis via the BFF. */}
      <Dialog open={dialogOpen} onOpenChange={(_, d) => setDialogOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{editing ? `Edit API "${editing.displayName || editing.name}"` : 'Create API'}</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                {dialogError && (
                  <MessageBar intent="error"><MessageBarBody>{dialogError}</MessageBarBody></MessageBar>
                )}
                <Field label="Name" hint={editing ? 'API identifier (immutable).' : 'Optional — derived from display name when blank.'}>
                  <Input
                    value={editing ? editing.name : form.id}
                    disabled={!!editing}
                    placeholder="orders-api"
                    onChange={(_, d) => setForm((f) => ({ ...f, id: d.value }))}
                  />
                </Field>
                <Field label="Display name" required>
                  <Input
                    value={form.displayName}
                    placeholder="Orders API"
                    onChange={(_, d) => setForm((f) => ({ ...f, displayName: d.value }))}
                  />
                </Field>
                <Field label="API URL suffix" required hint="The path segment appended to the gateway base URL (e.g. orders).">
                  <Input
                    value={form.path}
                    placeholder="orders"
                    onChange={(_, d) => setForm((f) => ({ ...f, path: d.value }))}
                  />
                </Field>
                <Field label="Web service URL" hint="Backend the gateway forwards to. Optional for a façade-only API.">
                  <Input
                    value={form.serviceUrl}
                    placeholder="https://contoso-functions.azurewebsites.net/api"
                    onChange={(_, d) => setForm((f) => ({ ...f, serviceUrl: d.value }))}
                  />
                </Field>
                <Field label="Protocols">
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalM }}>
                    {PROTOCOL_OPTIONS.map((p) => (
                      <Switch
                        key={p}
                        label={p.toUpperCase()}
                        checked={form.protocols.includes(p)}
                        onChange={() => toggleProtocol(p)}
                      />
                    ))}
                  </div>
                </Field>
                <Field label="Subscription required" hint="Require a subscription key to call this API.">
                  <Switch
                    checked={form.subscriptionRequired}
                    onChange={(_, d) => setForm((f) => ({ ...f, subscriptionRequired: d.checked }))}
                  />
                </Field>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
              <Button appearance="primary" onClick={handleSave} disabled={saving || !form.displayName.trim() || !form.path.trim()}>
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
            <DialogTitle>Delete API</DialogTitle>
            <DialogContent>
              Delete API <strong>{deleting?.displayName || deleting?.name}</strong>? Consumers calling this
              API will receive 404s, and any products that include it will lose the API. This cannot be undone.
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
