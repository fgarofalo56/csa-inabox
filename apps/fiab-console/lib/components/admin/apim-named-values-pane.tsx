'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  tokens, Spinner, MessageBar, MessageBarBody, Button, Badge,
  Caption1, Tooltip, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent,
  DialogActions, Field, Input, Switch, RadioGroup, Radio,
} from '@fluentui/react-components';
import { Delete24Regular, Edit24Regular, KeyMultiple24Regular } from '@fluentui/react-icons';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { ApimNamedValueSummary } from '@/lib/azure/apim-client';
import { apimFetchJson } from './apim-pane-fetch';

type NamedValueMode = 'inline' | 'keyvault';

interface NamedValueForm {
  displayName: string;
  mode: NamedValueMode;
  value: string;
  /** Key Vault secret identifier (keyvault mode). */
  secretIdentifier: string;
  secret: boolean;
  tags: string;
}

const EMPTY_FORM: NamedValueForm = {
  displayName: '', mode: 'inline', value: '', secretIdentifier: '', secret: false, tags: '',
};

// A KV secret identifier, e.g. https://my-vault.vault.azure.net/secrets/my-secret[/version].
const KV_SECRET_ID_RE = /^https:\/\/[a-z0-9-]+\.vault\.[a-z0-9.-]+\/secrets\/[^/\s]+(\/[^/\s]+)?\/?$/i;

export function ApimNamedValuesPane() {
  const [values, setValues] = useState<ApimNamedValueSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  // Create / edit dialog state. `editing` holds the original named value when
  // editing (displayName immutable — APIM keys the entity by it), or null.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ApimNamedValueSummary | null>(null);
  const [form, setForm] = useState<NamedValueForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  // Delete confirmation state.
  const [deleting, setDeleting] = useState<ApimNamedValueSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    apimFetchJson('/api/apim/named-values')
      .then((d) => {
        if (d.ok && Array.isArray(d.namedValues)) {
          setValues(d.namedValues as ApimNamedValueSummary[]);
        } else {
          setError((d.error as string) || 'Failed to load named values');
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

  const openEdit = useCallback((v: ApimNamedValueSummary) => {
    setEditing(v);
    const kv = v.keyVault?.secretIdentifier;
    setForm({
      // Secret values are never returned on GET; the user must re-enter the
      // value to change a secret (matches the portal's behavior). Key Vault
      // references, however, round-trip the secret identifier.
      displayName: v.displayName,
      mode: kv ? 'keyvault' : 'inline',
      value: v.secret ? '' : (v.value || ''),
      secretIdentifier: kv || '',
      secret: !!v.secret,
      tags: (v.tags || []).join(', '),
    });
    setDialogError(null);
    setDialogOpen(true);
  }, []);

  async function handleSave() {
    if (!form.displayName.trim()) { setDialogError('Name is required.'); return; }
    if (form.mode === 'keyvault') {
      if (!form.secretIdentifier.trim()) {
        setDialogError('Key Vault secret identifier is required.'); return;
      }
      if (!KV_SECRET_ID_RE.test(form.secretIdentifier.trim())) {
        setDialogError('Enter a valid Key Vault secret URI, e.g. https://my-vault.vault.azure.net/secrets/my-secret.');
        return;
      }
    } else if (!form.value.trim()) {
      setDialogError(editing?.secret
        ? 'Re-enter the secret value to save (secret values are never read back).'
        : 'Value is required.');
      return;
    }
    setSaving(true);
    setDialogError(null);
    try {
      // POST upserts by id/displayName (edit reuses the existing displayName).
      // The route does a real ARM PUT /namedValues.
      const tags = form.tags.split(',').map((t) => t.trim()).filter(Boolean);
      const d = await apimFetchJson('/api/apim/named-values', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: editing ? editing.name : undefined,
          displayName: form.displayName.trim(),
          // Mutually-exclusive value modes: Key Vault reference vs inline value.
          ...(form.mode === 'keyvault'
            ? { keyVault: { secretIdentifier: form.secretIdentifier.trim() } }
            : { value: form.value, secret: form.secret }),
          tags: tags.length ? tags : undefined,
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
      const d = await apimFetchJson(`/api/apim/named-values?id=${encodeURIComponent(deleting.name)}`, {
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

  const visibleValues = useMemo(() => {
    if (!q.trim()) return values;
    const f = q.toLowerCase();
    return values.filter((v) => v.displayName.toLowerCase().includes(f));
  }, [values, q]);

  const columns: LoomColumn<ApimNamedValueSummary>[] = useMemo(() => [
    {
      key: 'displayName',
      label: 'Name',
      width: 200,
      render: (v) => (
        <div>
          <strong>{v.displayName}</strong>
          <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS, color: tokens.colorNeutralForeground3 }}>{v.name}</Caption1>
        </div>
      ),
    },
    {
      key: 'secret',
      label: 'Type',
      width: 120,
      render: (v) => (
        v.keyVault?.secretIdentifier ? (
          <Badge appearance="outline" color="brand" icon={<KeyMultiple24Regular />}>Key Vault</Badge>
        ) : (
          <Badge appearance="outline" color={v.secret ? 'warning' : 'success'}>
            {v.secret ? 'Secret' : 'Value'}
          </Badge>
        )
      ),
    },
    {
      key: 'value',
      label: 'Value',
      width: 300,
      render: (v) => (
        <Caption1 style={{ wordBreak: 'break-all', maxWidth: '300px' }}>
          {v.keyVault?.secretIdentifier
            ? v.keyVault.secretIdentifier
            : v.secret ? '(encrypted)' : v.value || '—'}
        </Caption1>
      ),
    },
    {
      key: 'tags',
      label: 'Tags',
      width: 150,
      render: (v) => (
        <div>
          {(v.tags || []).map((t) => (
            <Badge key={t} appearance="outline" size="small" style={{ marginRight: tokens.spacingHorizontalXS }}>
              {t}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      key: 'actions',
      label: 'Actions',
      width: 100,
      sortable: false,
      render: (v) => (
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
          <Tooltip content="Edit named value" relationship="label">
            <Button size="small" icon={<Edit24Regular />} aria-label={`Edit named value ${v.displayName}`} onClick={() => openEdit(v)} />
          </Tooltip>
          <Tooltip content="Delete named value" relationship="label">
            <Button size="small" icon={<Delete24Regular />} aria-label={`Delete named value ${v.displayName}`} onClick={() => setDeleting(v)} />
          </Tooltip>
        </div>
      ),
    },
  ], [openEdit]);

  if (loading) return <Section><Spinner label="Loading named values..." /></Section>;
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
      title="Named values"
      actions={<Button appearance="primary" onClick={openCreate}>Create named value</Button>}
    >
      <Toolbar
        search={q}
        onSearch={setQ}
        searchPlaceholder="Filter by name..."
      />
      <LoomDataTable
        columns={columns}
        rows={visibleValues}
        getRowId={(v) => v.id}
        empty="No named values defined."
        ariaLabel="APIM named values"
      />

      {/* Create / edit named value dialog — real ARM PUT /namedValues via the BFF. */}
      <Dialog open={dialogOpen} onOpenChange={(_, d) => setDialogOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{editing ? `Edit named value "${editing.displayName}"` : 'Create named value'}</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                {dialogError && (
                  <MessageBar intent="error"><MessageBarBody>{dialogError}</MessageBarBody></MessageBar>
                )}
                <Field label="Name" required hint={editing ? 'Named value identifier (immutable).' : 'Allowed characters: letters, digits, - . _'}>
                  <Input
                    value={form.displayName}
                    disabled={!!editing}
                    placeholder="contoso-api-key"
                    onChange={(_, d) => setForm((f) => ({ ...f, displayName: d.value }))}
                  />
                </Field>
                <Field label="Value source" hint="Store the value inline in APIM, or reference a secret held in Azure Key Vault.">
                  <RadioGroup
                    layout="horizontal"
                    value={form.mode}
                    onChange={(_, d) => setForm((f) => ({ ...f, mode: d.value as NamedValueMode }))}
                  >
                    <Radio value="inline" label="Inline value" />
                    <Radio value="keyvault" label="Key Vault secret" />
                  </RadioGroup>
                </Field>

                {form.mode === 'inline' ? (
                  <>
                    <Field
                      label="Value"
                      required
                      hint={editing?.secret ? 'Secret values are never read back — re-enter to change.' : undefined}
                    >
                      <Input
                        type={form.secret ? 'password' : 'text'}
                        value={form.value}
                        placeholder={editing?.secret ? '(re-enter secret value)' : 'value'}
                        onChange={(_, d) => setForm((f) => ({ ...f, value: d.value }))}
                      />
                    </Field>
                    <Field label="Secret" hint="Encrypt the value at rest; it will not be displayed in the list.">
                      <Switch
                        checked={form.secret}
                        onChange={(_, d) => setForm((f) => ({ ...f, secret: d.checked }))}
                      />
                    </Field>
                  </>
                ) : (
                  <>
                    <Field
                      label="Key Vault secret identifier"
                      required
                      hint="Versionless URI auto-refreshes when the secret rotates; a versioned URI pins one version."
                    >
                      <Input
                        value={form.secretIdentifier}
                        placeholder="https://my-vault.vault.azure.net/secrets/my-secret"
                        onChange={(_, d) => setForm((f) => ({ ...f, secretIdentifier: d.value }))}
                      />
                    </Field>
                    <MessageBar intent="warning">
                      <MessageBarBody>
                        The APIM service&apos;s managed identity must have <strong>GET</strong> on this
                        Key Vault secret (Key Vault Secrets User role, or a &quot;Get&quot; secret access
                        policy). Without it APIM cannot resolve the value at runtime and the named value
                        will report a fetch error. See aka.ms/apimmsi.
                      </MessageBarBody>
                    </MessageBar>
                  </>
                )}
                <Field label="Tags" hint="Comma-separated tags for grouping (optional).">
                  <Input
                    value={form.tags}
                    placeholder="auth, contoso"
                    onChange={(_, d) => setForm((f) => ({ ...f, tags: d.value }))}
                  />
                </Field>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
              <Button
                appearance="primary"
                onClick={handleSave}
                disabled={
                  saving ||
                  !form.displayName.trim() ||
                  (form.mode === 'keyvault' ? !form.secretIdentifier.trim() : !form.value.trim())
                }
              >
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
            <DialogTitle>Delete named value</DialogTitle>
            <DialogContent>
              Delete named value <strong>{deleting?.displayName}</strong>? Policies that reference it
              ({'{{'}{deleting?.displayName}{'}}'}) will fail until updated. This cannot be undone.
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
