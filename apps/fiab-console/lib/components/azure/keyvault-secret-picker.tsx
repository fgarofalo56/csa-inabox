'use client';

/**
 * KeyVaultSecretPicker — pick a secret by NAME from a real Key Vault listing.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 * Loom's own convention is already correct: a connection record stores the KV
 * secret NAME (`secretRef`) and the material never leaves Key Vault
 * (lib/azure/kv-secrets-client.ts). What was missing is any way to SEE the
 * names, so the surfaces that consume a `secretRef` ask the user to type one —
 * and several skipped the reference entirely and asked for the secret VALUE in
 * a `type="password"` box, which puts the material in the browser, in a request
 * body, and often in an item document.
 *
 * This picker pairs with GET /api/keyvault/secret-names, which lists names and
 * never values. Selecting one yields the name; the value is read server-side,
 * by the code that needs it, from the vault.
 *
 * The vault itself is chosen with the shared AzureBackedField `keyvault` kind
 * (the registry loader `L.keyvault` → `properties.vaultUri`), so the vault list
 * is real cross-subscription ARM discovery rather than another typed URI.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Combobox, Option, Field, Button, Badge, Caption1, Spinner,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync16Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { AzureBackedField } from '@/lib/components/azure/azure-backed-field';
import { HonestGate } from '@/lib/components/shared/honest-gate';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  meta: { color: tokens.colorNeutralForeground3, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
  grow: { flex: 1, minWidth: '260px' },
});

export interface KeyVaultSecretName {
  name: string;
  id: string;
  enabled: boolean;
  expires?: string;
  contentType?: string;
}

export interface KeyVaultSecretPickerProps {
  /** The stored secret NAME. */
  value?: string;
  /** The vault to list (name or https URI). Omit to use the deployment's own. */
  vault?: string;
  /** Fires with the picked secret name (or null when cleared). */
  onChange: (name: string | null) => void;
  /** Fires when the user changes the vault, so the caller can persist it too. */
  onVaultChange?: (vault: string | null) => void;
  /** Show the vault picker above the secret picker. */
  showVaultPicker?: boolean;
  label?: string;
}

export function KeyVaultSecretPicker({
  value, vault, onChange, onVaultChange, showVaultPicker = true, label = 'Key Vault secret',
}: KeyVaultSecretPickerProps) {
  const s = useStyles();
  const [names, setNames] = useState<KeyVaultSecretName[]>([]);
  const [resolvedVault, setResolvedVault] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const qs = vault ? `?vault=${encodeURIComponent(vault)}` : '';
      const r = await clientFetch(`/api/keyvault/secret-names${qs}`);
      const j = await r.json();
      if (j?.ok && Array.isArray(j.names)) {
        setNames(j.names);
        setResolvedVault(j.vault || null);
      } else {
        setNames([]);
        setResolvedVault(j?.vault || null);
        setError(j?.error || `Could not list secret names (HTTP ${r.status}).`);
      }
    } catch (e: any) {
      setNames([]);
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [vault]);

  useEffect(() => { load(); }, [load]);

  const known = value ? names.find((n) => n.name === value) : undefined;

  return (
    <div className={s.root}>
      {showVaultPicker && (
        <AzureBackedField
          kind="keyvault"
          label="Key Vault"
          surface="Key Vault secret picker"
          value={vault}
          onChange={(v) => onVaultChange?.(v)}
        />
      )}

      <Field label={label} hint="Only the NAME is stored. The secret value is read server-side from the vault and never reaches the browser.">
        <div className={s.row}>
          <Combobox
            className={s.grow}
            value={value || ''}
            selectedOptions={value ? [value] : []}
            placeholder={loading ? 'Listing secret names…' : (names.length ? 'Select a secret' : 'No secret names listed')}
            disabled={loading}
            onOptionSelect={(_, d) => onChange(d.optionValue || null)}
          >
            {/* DEFECT-1 PARITY: a stored name the current listing does not carry
                is preserved as an option rather than silently cleared. */}
            {value && !known && (
              <Option key={`__stored__${value}`} value={value} text={value}>
                {`${value} — saved value, not in this vault's listing`}
              </Option>
            )}
            {names.map((n) => (
              <Option key={n.id || n.name} value={n.name} text={n.name} disabled={!n.enabled}>
                {`${n.name}${n.contentType ? ` · ${n.contentType}` : ''}${n.enabled ? '' : ' · disabled'}`}
              </Option>
            ))}
          </Combobox>
          <Button
            size="small" appearance="subtle" icon={<ArrowSync16Regular />}
            onClick={load} disabled={loading}
            title="Refresh secret names" aria-label="Refresh secret names"
          />
        </div>
      </Field>

      <div className={s.row}>
        {loading && <Spinner size="tiny" label="Reading the vault…" />}
        {!loading && !error && (
          <Caption1 className={s.meta}>
            {names.length} secret{names.length === 1 ? '' : 's'}{resolvedVault ? ` in ${resolvedVault}` : ''}
          </Caption1>
        )}
        {value && !known && !loading && (
          <Badge appearance="tint" color="warning" size="small" title={value}>saved name — not in this vault</Badge>
        )}
      </div>

      {error && (
        /* G2: the shared gate with its Fix-it wizard + /admin/gates link, not a
           bare `intent="warning"` MessageBar. `check-honest-gate-coverage.mjs`
           passed on the bare bar only because the text arrives from the route at
           runtime, so the JSX carried no env-var literal for the guard to see —
           the guard's population EXCLUDED it. Its Recheck re-lists in place, so
           an operator who grants the role never has to reload the surface. */
        <HonestGate
          gateId="svc-keyvault"
          surface={`Key Vault secret picker${resolvedVault ? ` (${resolvedVault})` : ''}`}
          detail={error}
          onResolved={load}
        />
      )}
    </div>
  );
}
