'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  tokens, Spinner, MessageBar, MessageBarBody, Button, Badge,
  Caption1, Tooltip, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent,
  DialogActions, Field, Input, Dropdown, Option, Textarea, Switch,
} from '@fluentui/react-components';
import { Delete24Regular, Edit24Regular } from '@fluentui/react-icons';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { ApimProductSummary } from '@/lib/azure/apim-client';
import { apimFetchJson } from './apim-pane-fetch';

interface ProductForm {
  id: string;
  displayName: string;
  description: string;
  state: 'published' | 'notPublished';
  subscriptionRequired: boolean;
  approvalRequired: boolean;
}

const EMPTY_FORM: ProductForm = {
  id: '',
  displayName: '',
  description: '',
  state: 'published',
  subscriptionRequired: true,
  approvalRequired: false,
};

export function ApimProductsPane() {
  const [products, setProducts] = useState<ApimProductSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  // Create / edit dialog state. `editing` holds the original product when
  // editing (name immutable), or null for create.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ApimProductSummary | null>(null);
  const [form, setForm] = useState<ProductForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  // Delete confirmation state.
  const [deleting, setDeleting] = useState<ApimProductSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    // apimFetchJson surfaces a non-JSON body / honest 503 gate as a readable
    // error instead of crashing the pane with "Unexpected token '<'".
    apimFetchJson('/api/items/apim-product')
      .then((d) => {
        if (d.ok && Array.isArray(d.products)) {
          setProducts(d.products as ApimProductSummary[]);
        } else {
          setError(d.error || 'Failed to load products');
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

  const openEdit = useCallback((p: ApimProductSummary) => {
    setEditing(p);
    setForm({
      id: p.name,
      displayName: p.displayName || '',
      description: p.description || '',
      state: p.state === 'notPublished' ? 'notPublished' : 'published',
      subscriptionRequired: p.subscriptionRequired !== false,
      approvalRequired: !!p.approvalRequired,
    });
    setDialogError(null);
    setDialogOpen(true);
  }, []);

  async function handleSave() {
    if (!form.displayName.trim()) { setDialogError('Display name is required.'); return; }
    setSaving(true);
    setDialogError(null);
    try {
      // POST upserts: create derives an id from displayName server-side; edit
      // reuses the existing name. The route does a real ARM PUT /products.
      const d = await apimFetchJson('/api/items/apim-product', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: editing ? editing.name : (form.id.trim() || undefined),
          displayName: form.displayName.trim(),
          description: form.description.trim() || undefined,
          state: form.state,
          subscriptionRequired: form.subscriptionRequired,
          approvalRequired: form.approvalRequired,
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
      const d = await apimFetchJson(`/api/items/apim-product/${encodeURIComponent(deleting.name)}`, {
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

  const visibleProducts = useMemo(() => {
    if (!q.trim()) return products;
    const f = q.toLowerCase();
    return products.filter((p) =>
      p.displayName.toLowerCase().includes(f) ||
      (p.description || '').toLowerCase().includes(f)
    );
  }, [products, q]);

  const columns: LoomColumn<ApimProductSummary>[] = useMemo(() => [
    {
      key: 'displayName',
      label: 'Product',
      width: 240,
      render: (p) => (
        <div>
          <strong>{p.displayName}</strong>
          {p.description && <Caption1 style={{ display: 'block', marginTop: '4px', color: tokens.colorNeutralForeground3 }}>{p.description}</Caption1>}
        </div>
      ),
    },
    {
      key: 'state',
      label: 'State',
      width: 120,
      render: (p) => (
        <Badge appearance="outline" color={p.state === 'published' ? 'success' : 'warning'}>
          {p.state}
        </Badge>
      ),
    },
    {
      key: 'subscriptionRequired',
      label: 'Subscription',
      width: 120,
      render: (p) => (
        <Badge appearance="outline" color={p.subscriptionRequired ? 'success' : 'subtle'}>
          {p.subscriptionRequired ? 'Required' : 'Optional'}
        </Badge>
      ),
    },
    {
      key: 'approvalRequired',
      label: 'Approval',
      width: 120,
      render: (p) => (
        <Badge appearance="outline" color={p.approvalRequired ? 'warning' : 'success'}>
          {p.approvalRequired ? 'Manual' : 'Auto'}
        </Badge>
      ),
    },
    {
      key: 'actions',
      label: 'Actions',
      width: 120,
      sortable: false,
      render: (p) => (
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
          <Tooltip content="Edit product" relationship="label">
            <Button
              size="small"
              appearance="subtle"
              icon={<Edit24Regular />}
              aria-label={`Edit ${p.displayName}`}
              onClick={() => openEdit(p)}
            />
          </Tooltip>
          <Tooltip content="Delete product" relationship="label">
            <Button
              size="small"
              appearance="subtle"
              icon={<Delete24Regular />}
              aria-label={`Delete ${p.displayName}`}
              onClick={() => setDeleting(p)}
            />
          </Tooltip>
        </div>
      ),
    },
  ], [openEdit]);

  if (loading) return <Section><Spinner label="Loading products..." /></Section>;
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
      title="Products"
      actions={<Button appearance="primary" onClick={openCreate}>Create product</Button>}
    >
      <Toolbar
        search={q}
        onSearch={setQ}
        searchPlaceholder="Filter by name, description..."
      />
      <LoomDataTable
        columns={columns}
        rows={visibleProducts}
        getRowId={(p) => p.id}
        empty="No products defined."
        ariaLabel="APIM Products"
      />

      {/* Create / edit product dialog — real ARM PUT /products via the BFF. */}
      <Dialog open={dialogOpen} onOpenChange={(_, d) => setDialogOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{editing ? `Edit product "${editing.displayName || editing.name}"` : 'Create product'}</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                {dialogError && (
                  <MessageBar intent="error"><MessageBarBody>{dialogError}</MessageBarBody></MessageBar>
                )}
                <Field label="Name" hint={editing ? 'Product identifier (immutable).' : 'Optional — derived from display name when blank.'}>
                  <Input
                    value={editing ? editing.name : form.id}
                    disabled={!!editing}
                    placeholder="unlimited"
                    onChange={(_, d) => setForm((f) => ({ ...f, id: d.value }))}
                  />
                </Field>
                <Field label="Display name" required>
                  <Input
                    value={form.displayName}
                    placeholder="Unlimited"
                    onChange={(_, d) => setForm((f) => ({ ...f, displayName: d.value }))}
                  />
                </Field>
                <Field label="Description">
                  <Textarea
                    value={form.description}
                    rows={2}
                    onChange={(_, d) => setForm((f) => ({ ...f, description: d.value }))}
                  />
                </Field>
                <Field label="State">
                  <Dropdown
                    value={form.state === 'published' ? 'Published' : 'Not published'}
                    selectedOptions={[form.state]}
                    onOptionSelect={(_, d) => setForm((f) => ({ ...f, state: (d.optionValue as 'published' | 'notPublished') || 'published' }))}
                  >
                    <Option value="published">Published</Option>
                    <Option value="notPublished">Not published</Option>
                  </Dropdown>
                </Field>
                <Field label="Subscription required" hint="Require consumers to subscribe (with a key) before calling APIs in this product.">
                  <Switch
                    checked={form.subscriptionRequired}
                    onChange={(_, d) => setForm((f) => ({ ...f, subscriptionRequired: d.checked }))}
                  />
                </Field>
                <Field label="Approval required" hint="Require an administrator to approve each subscription request.">
                  <Switch
                    checked={form.approvalRequired}
                    disabled={!form.subscriptionRequired}
                    onChange={(_, d) => setForm((f) => ({ ...f, approvalRequired: d.checked }))}
                  />
                </Field>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
              <Button appearance="primary" onClick={handleSave} disabled={saving || !form.displayName.trim()}>
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
            <DialogTitle>Delete product</DialogTitle>
            <DialogContent>
              Delete product <strong>{deleting?.displayName || deleting?.name}</strong>? All subscriptions
              to this product will be removed and consumers will lose access to its APIs. This cannot be undone.
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
