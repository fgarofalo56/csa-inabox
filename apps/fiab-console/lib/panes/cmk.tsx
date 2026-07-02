'use client';

/**
 * CmkPane — Customer-Managed Keys (F14) admin surface.
 *
 * Parity with the Azure portal storage account "Encryption" blade (Customer-
 * managed keys): a status panel showing the current key source / key / version,
 * a "vault → key → version" bind wizard, and a rotation panel (pin to latest /
 * pin to a version). Guided dropdowns + wizard, NO JSON textarea (per
 * loom_no_freeform_config). Theme is Fluent v9 + Loom tokens.
 *
 * Backend: GET/POST/DELETE /api/admin/workspaces/{id}/cmk, which read/PATCH the
 * storage account's live encryption.keyVaultProperties via ARM (Azure-native, no
 * Fabric dependency). When the Console UAMI lacks the required role the BFF
 * returns an honest gate and this pane renders a MessageBar naming the role +
 * GUID + bicep module.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Caption1, Field, Dropdown, Option, Checkbox, Spinner, Text, Divider,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ShieldKeyhole20Regular, Key20Regular, ArrowSync20Regular, LockClosed20Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  statusRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', minWidth: 0 },
  kv: { display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', columnGap: tokens.spacingHorizontalL, rowGap: tokens.spacingVerticalXS, alignItems: 'center' },
  label: { color: tokens.colorNeutralForeground3 },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, wordBreak: 'break-all', overflowWrap: 'anywhere', minWidth: 0 },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  dialogBody: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0, maxWidth: '100%' },
  hint: { color: tokens.colorNeutralForeground3 },
});

type RoleCheck = 'present' | 'missing' | 'unknown';

interface CmkStatus {
  keySource: 'Microsoft.Storage' | 'Microsoft.Keyvault';
  cmk: boolean;
  vaultUri?: string;
  keyName?: string;
  keyVersion?: string;
  currentVersionedKeyIdentifier?: string;
  uamiResourceId?: string;
  accountName: string;
}
interface RoleChecks { kvCryptoRole: RoleCheck; storageContributorRole: RoleCheck; principalId?: string }
interface GateInfo { missing?: string; hint?: string; bicepModule?: string }
interface KvKey { name: string; enabled: boolean }
interface KvVersion { version: string; enabled: boolean; created?: number }

interface StatusResponse {
  ok?: boolean;
  gate?: boolean;
  status?: CmkStatus;
  roleChecks?: RoleChecks;
  vaultUri?: string;
  uamiResourceId?: string;
  cosmosConfigured?: boolean;
  missing?: string; hint?: string; bicepModule?: string; error?: string;
}

export function CmkPane({ workspaceId }: { workspaceId: string }) {
  const styles = useStyles();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<GateInfo | null>(null);
  const [status, setStatus] = useState<CmkStatus | null>(null);
  const [roleChecks, setRoleChecks] = useState<RoleChecks | null>(null);
  const [vaultUri, setVaultUri] = useState<string | undefined>();
  const [cosmosConfigured, setCosmosConfigured] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/workspaces/${encodeURIComponent(workspaceId)}/cmk`);
      const j: StatusResponse = await res.json();
      if (j?.gate) {
        setGate({ missing: j.missing, hint: j.hint, bicepModule: j.bicepModule });
        setStatus(null);
      } else if (j?.ok) {
        setGate(null);
        setStatus(j.status || null);
        setRoleChecks(j.roleChecks || null);
        setVaultUri(j.vaultUri);
        setCosmosConfigured(!!j.cosmosConfigured);
      } else {
        setError(j?.error || `HTTP ${res.status}`);
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to load CMK status');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const unbind = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/workspaces/${encodeURIComponent(workspaceId)}/cmk`, { method: 'DELETE' });
      const j = await res.json();
      if (j?.gate) { setGate({ missing: j.missing, hint: j.hint, bicepModule: j.bicepModule }); return; }
      if (!res.ok || !j?.ok) { setError(j?.error || `HTTP ${res.status}`); return; }
      await load();
    } catch (e: any) {
      setError(e?.message || 'Failed to revert to Microsoft-managed keys');
    } finally {
      setBusy(false);
    }
  }, [workspaceId, load]);

  const kvRoleMissing = roleChecks?.kvCryptoRole === 'missing';
  const storageRoleMissing = roleChecks?.storageContributorRole === 'missing';
  const anyRoleMissing = kvRoleMissing || storageRoleMissing;

  if (loading) return <Spinner size="tiny" label="Loading customer-managed keys…" />;

  if (gate) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Customer-managed keys not wired in this deployment</MessageBarTitle>
          <Caption1 block>Missing: <code>{gate.missing}</code></Caption1>
          {gate.bicepModule && <Caption1 block>Bicep module: <code>{gate.bicepModule}</code></Caption1>}
          {gate.hint && <Caption1 block style={{ marginTop: 6 }}>{gate.hint}</Caption1>}
        </MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <ShieldKeyhole20Regular />
        <Text weight="semibold" size={400}>Customer-managed keys</Text>
      </div>

      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}

      {/* Honest role gates — still render the full surface beneath. */}
      {kvRoleMissing && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Key Vault Crypto Service Encryption User missing</MessageBarTitle>
            <Caption1 block>
              The Console identity needs <code>Key Vault Crypto Service Encryption User</code>{' '}
              (<code>e147488a-f6f5-4113-8e2d-b22465e65bf6</code>) on the Key Vault to list keys and bind a customer key.
              Deploy <code>admin-plane/keyvault.bicep</code> with <code>consolePrincipalNeedsCmkRole=true</code>.
            </Caption1>
          </MessageBarBody>
        </MessageBar>
      )}
      {storageRoleMissing && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Storage Account Contributor missing</MessageBarTitle>
            <Caption1 block>
              The Console identity needs <code>Storage Account Contributor</code>{' '}
              (<code>17d1049b-9a84-46fb-8f53-869881c3d3ab</code>) on the storage account to PATCH its encryption settings.
              Deploy <code>landing-zone/storage-lifecycle-rbac.bicep</code> with <code>consolePrincipalNeedsCmkBind=true</code>.
            </Caption1>
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Current encryption status */}
      <div className={styles.card}>
        <div className={styles.statusRow}>
          {status?.cmk ? <Key20Regular /> : <LockClosed20Regular />}
          <Text weight="semibold">Encryption at rest</Text>
          <Badge appearance="filled" color={status?.cmk ? 'success' : 'informative'}>
            {status?.cmk ? 'Customer-managed key' : 'Microsoft-managed key'}
          </Badge>
          {status?.accountName && <Caption1 className={styles.hint}>{status.accountName}</Caption1>}
        </div>

        {status?.cmk && (
          <div className={styles.kv}>
            <Caption1 className={styles.label}>Key Vault</Caption1>
            <Text className={styles.mono}>{status.vaultUri || '—'}</Text>
            <Caption1 className={styles.label}>Key name</Caption1>
            <Text className={styles.mono}>{status.keyName || '—'}</Text>
            <Caption1 className={styles.label}>Version</Caption1>
            <Text className={styles.mono}>
              {status.keyVersion ? status.keyVersion : 'Latest (auto-rotate)'}
            </Text>
            {status.currentVersionedKeyIdentifier && (
              <>
                <Caption1 className={styles.label}>Live key id</Caption1>
                <Text className={styles.mono}>{status.currentVersionedKeyIdentifier}</Text>
              </>
            )}
            {status.uamiResourceId && (
              <>
                <Caption1 className={styles.label}>Encryption identity</Caption1>
                <Text className={styles.mono}>{status.uamiResourceId.split('/').pop()}</Text>
              </>
            )}
          </div>
        )}

        <Divider />
        <div className={styles.toolbar}>
          <Button
            appearance="primary"
            icon={<Key20Regular />}
            disabled={busy || anyRoleMissing}
            onClick={() => setWizardOpen(true)}
          >
            {status?.cmk ? 'Change key / version' : 'Bind customer key'}
          </Button>
          {status?.cmk && (
            <Button appearance="secondary" icon={<ArrowSync20Regular />} disabled={busy} onClick={unbind}>
              Revert to Microsoft-managed
            </Button>
          )}
        </div>
      </div>

      {wizardOpen && (
        <BindWizard
          workspaceId={workspaceId}
          vaultUri={vaultUri}
          cosmosConfigured={cosmosConfigured}
          onClose={() => setWizardOpen(false)}
          onBound={async () => { setWizardOpen(false); await load(); }}
        />
      )}
    </div>
  );
}

// ----------------------------- Bind wizard -----------------------------

function BindWizard({
  workspaceId, vaultUri, cosmosConfigured, onClose, onBound,
}: {
  workspaceId: string;
  vaultUri?: string;
  cosmosConfigured: boolean;
  onClose: () => void;
  onBound: () => void;
}) {
  const styles = useStyles();
  const [keys, setKeys] = useState<KvKey[]>([]);
  const [versions, setVersions] = useState<KvVersion[]>([]);
  const [keyName, setKeyName] = useState<string>('');
  const [keyVersion, setKeyVersion] = useState<string>(''); // '' = auto-rotate
  const [bindCosmos, setBindCosmos] = useState(false);
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1: load keys for the vault.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingKeys(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ list: 'keys' });
        if (vaultUri) qs.set('vaultUri', vaultUri);
        const res = await fetch(`/api/admin/workspaces/${encodeURIComponent(workspaceId)}/cmk?${qs}`);
        const j = await res.json();
        if (cancelled) return;
        if (j?.gate) { setError(j.hint || 'Key Vault role missing'); setKeys([]); }
        else if (j?.ok) setKeys(j.keys || []);
        else setError(j?.error || `HTTP ${res.status}`);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to list keys');
      } finally {
        if (!cancelled) setLoadingKeys(false);
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, vaultUri]);

  // Step 2: load versions when a key is picked.
  useEffect(() => {
    if (!keyName) { setVersions([]); return; }
    let cancelled = false;
    (async () => {
      setLoadingVersions(true);
      try {
        const qs = new URLSearchParams({ keyName });
        if (vaultUri) qs.set('vaultUri', vaultUri);
        const res = await fetch(`/api/admin/workspaces/${encodeURIComponent(workspaceId)}/cmk?${qs}`);
        const j = await res.json();
        if (cancelled) return;
        if (j?.ok) setVersions(j.versions || []);
        else setVersions([]);
      } catch {
        if (!cancelled) setVersions([]);
      } finally {
        if (!cancelled) setLoadingVersions(false);
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, vaultUri, keyName]);

  const submit = useCallback(async () => {
    if (!keyName) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/workspaces/${encodeURIComponent(workspaceId)}/cmk`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ vaultUri, keyName, keyVersion, bindCosmos }),
      });
      const j = await res.json();
      if (j?.gate) { setError(j.hint || 'Required role missing'); return; }
      if (!res.ok || !j?.ok) { setError(j?.error || `HTTP ${res.status}`); return; }
      onBound();
    } catch (e: any) {
      setError(e?.message || 'Failed to bind customer key');
    } finally {
      setSaving(false);
    }
  }, [workspaceId, vaultUri, keyName, keyVersion, bindCosmos, onBound]);

  const versionLabel = keyVersion
    ? `${keyVersion.slice(0, 12)}…`
    : 'Latest (auto-rotate)';

  return (
    <Dialog open modalType="modal" onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Bind a customer-managed key</DialogTitle>
          <DialogContent>
            <div className={styles.dialogBody}>
              <Field label="Key Vault">
                <Text className={styles.mono}>{vaultUri || '—'}</Text>
              </Field>

              <Field label="Key" required hint={loadingKeys ? 'Loading keys…' : undefined}>
                <Dropdown
                  placeholder={loadingKeys ? 'Loading…' : 'Select a key'}
                  disabled={loadingKeys || keys.length === 0}
                  value={keyName}
                  selectedOptions={keyName ? [keyName] : []}
                  onOptionSelect={(_, d) => { setKeyName(d.optionValue || ''); setKeyVersion(''); }}
                >
                  {keys.map((k) => (
                    <Option key={k.name} value={k.name} disabled={!k.enabled}>
                      {k.name}{k.enabled ? '' : ' (disabled)'}
                    </Option>
                  ))}
                </Dropdown>
              </Field>

              <Field label="Version" hint="Choose Latest to let Azure auto-rotate, or pin to a specific version.">
                <Dropdown
                  placeholder="Latest (auto-rotate)"
                  disabled={!keyName || loadingVersions}
                  value={versionLabel}
                  selectedOptions={[keyVersion || '__latest__']}
                  onOptionSelect={(_, d) => setKeyVersion(d.optionValue === '__latest__' ? '' : (d.optionValue || ''))}
                >
                  <Option value="__latest__">Latest (auto-rotate)</Option>
                  {versions.map((v) => (
                    <Option key={v.version} value={v.version} disabled={!v.enabled}>
                      {v.version.slice(0, 16)}…{v.enabled ? '' : ' (disabled)'}
                    </Option>
                  ))}
                </Dropdown>
              </Field>

              <Divider />
              <Checkbox
                label="Also bind the Cosmos DB account to this key"
                checked={bindCosmos}
                disabled={!cosmosConfigured}
                onChange={(_, d) => setBindCosmos(!!d.checked)}
              />
              {bindCosmos && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    Enabling CMK on an existing Cosmos DB account limits document ids to 990 bytes (from 1024) and
                    adds a small read/write overhead. Confirm no document id exceeds 990 bytes before binding.
                  </MessageBarBody>
                </MessageBar>
              )}
              {!cosmosConfigured && (
                <Caption1 className={styles.hint}>
                  Cosmos CMK is unavailable — set <code>LOOM_COSMOS_ACCOUNT_ID</code> on the console app to enable it.
                </Caption1>
              )}

              {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button appearance="primary" onClick={submit} disabled={!keyName || saving}>
              {saving ? 'Binding…' : 'Bind key'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default CmkPane;
