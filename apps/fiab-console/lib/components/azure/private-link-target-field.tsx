'use client';

/**
 * PrivateLinkTargetField — pick the resource a private endpoint points at.
 *
 * ── WHY THIS IS NOT JUST AN `AzureBackedField` ──────────────────────────────
 * Every other hand-typed ARM id in this tree names ONE resource type, so the
 * shared field kind resolves it. A private-endpoint target does not: it can be
 * a storage account, a vault, a SQL server, a Synapse workspace, an ADX
 * cluster, a Cosmos account, an Event Hubs / Service Bus namespace, a registry,
 * a search service, a web app… The three surfaces that ask for one
 * (`lib/panes/networking.tsx` inbound + outbound, and the ADF managed private
 * endpoint dialog) all asked for a raw `/subscriptions/…` string instead.
 *
 * Querying every candidate type at once would be a dozen requests for a list
 * the user narrows immediately, so this mirrors what the Azure portal's
 * "Create private endpoint" blade actually does:
 *
 *     Resource type  →  Resource  →  Target sub-resource
 *
 * ONE discovery request, re-issued when the type changes. The sub-resource
 * (`groupId`) is not a fourth thing to look up either — Azure publishes a fixed
 * groupId set per resource type, so choosing the type FILLS IT IN
 * (`auto-bind-by-default.md`: if the platform can derive it, the user does not
 * type it).
 *
 * ── STORED VALUE ────────────────────────────────────────────────────────────
 * The stored value is the target's ARM id, unchanged — no surface's payload
 * shape moves. An id that belongs to a subscription the caller cannot read is
 * PRESERVED by the picker underneath (Wave 0 defect 1), and the type dropdown
 * seeds itself from the id's own `/providers/<ns>/<type>` segment so reopening
 * a saved endpoint lands on the right list rather than on an empty one.
 */
import { useCallback, useMemo, useState } from 'react';
import { Dropdown, Option, Field, makeStyles, tokens } from '@fluentui/react-components';
import { AzureResourcePicker, type AzureResourceSelection } from './azure-resource-picker';

/**
 * Private-link-capable ARM types Loom binds, with the `groupIds` Azure accepts
 * for each. Sourced from the per-service "What is a private endpoint" pages on
 * Microsoft Learn (privatelink sub-resource tables); every entry here is a type
 * some Loom surface already provisions or attaches.
 */
export interface PrivateLinkTargetType {
  /** ARM resource type. */
  type: string;
  /** What the type dropdown shows. */
  label: string;
  /** Valid `groupId` sub-resources, most common first. */
  groupIds: string[];
}

export const PRIVATE_LINK_TARGET_TYPES: PrivateLinkTargetType[] = [
  { type: 'Microsoft.Storage/storageAccounts', label: 'Storage account (ADLS Gen2 / Blob)', groupIds: ['dfs', 'blob', 'file', 'queue', 'table', 'web'] },
  { type: 'Microsoft.KeyVault/vaults', label: 'Key Vault', groupIds: ['vault'] },
  { type: 'Microsoft.Sql/servers', label: 'Azure SQL server', groupIds: ['sqlServer'] },
  { type: 'Microsoft.Synapse/workspaces', label: 'Synapse workspace', groupIds: ['Sql', 'SqlOnDemand', 'Dev'] },
  { type: 'Microsoft.Kusto/clusters', label: 'Azure Data Explorer cluster', groupIds: ['cluster'] },
  { type: 'Microsoft.DocumentDB/databaseAccounts', label: 'Cosmos DB account', groupIds: ['Sql', 'MongoDB', 'Cassandra', 'Gremlin', 'Table'] },
  { type: 'Microsoft.EventHub/namespaces', label: 'Event Hubs namespace', groupIds: ['namespace'] },
  { type: 'Microsoft.ServiceBus/namespaces', label: 'Service Bus namespace', groupIds: ['namespace'] },
  { type: 'Microsoft.EventGrid/topics', label: 'Event Grid topic', groupIds: ['topic'] },
  { type: 'Microsoft.ContainerRegistry/registries', label: 'Container registry', groupIds: ['registry'] },
  { type: 'Microsoft.Search/searchServices', label: 'AI Search service', groupIds: ['searchService'] },
  { type: 'Microsoft.CognitiveServices/accounts', label: 'Azure OpenAI / AI Services account', groupIds: ['account'] },
  { type: 'Microsoft.MachineLearningServices/workspaces', label: 'Azure ML workspace', groupIds: ['amlworkspace'] },
  { type: 'Microsoft.Purview/accounts', label: 'Purview account', groupIds: ['account', 'portal'] },
  { type: 'Microsoft.DataFactory/factories', label: 'Data Factory', groupIds: ['dataFactory'] },
  { type: 'Microsoft.OperationalInsights/workspaces', label: 'Log Analytics workspace', groupIds: ['azuremonitor'] },
  { type: 'Microsoft.DBforPostgreSQL/flexibleServers', label: 'PostgreSQL flexible server', groupIds: ['postgresqlServer'] },
  { type: 'Microsoft.AppConfiguration/configurationStores', label: 'App Configuration store', groupIds: ['configurationStores'] },
  { type: 'Microsoft.Web/sites', label: 'App Service / Function App', groupIds: ['sites'] },
  { type: 'Microsoft.App/managedEnvironments', label: 'Container Apps environment', groupIds: ['managedEnvironments'] },
];

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  dropdown: { minWidth: '320px' },
});

/** The ARM type embedded in an ARM id, or null when it has none. */
export function typeFromArmId(id: string | undefined): string | null {
  if (!id) return null;
  const m = /\/providers\/([^/]+)\/([^/]+)\//i.exec(id);
  if (!m) return null;
  const candidate = `${m[1]}/${m[2]}`;
  const known = PRIVATE_LINK_TARGET_TYPES.find((t) => t.type.toLowerCase() === candidate.toLowerCase());
  return known ? known.type : candidate;
}

/** The groupIds Azure accepts for an ARM type, or [] when it is not in the table. */
export function groupIdsForType(type: string | null | undefined): string[] {
  if (!type) return [];
  return PRIVATE_LINK_TARGET_TYPES.find((t) => t.type.toLowerCase() === type.toLowerCase())?.groupIds ?? [];
}

/**
 * The sub-resources to offer BEFORE the user has picked anything — i.e. for the
 * type the field itself will open on. Callers use this to seed their groupId
 * dropdown so it is never momentarily empty, WITHOUT naming an ARM type
 * themselves (which is the habit this whole component exists to end).
 */
export function initialGroupIdsFor(storedTargetId?: string): string[] {
  return groupIdsForType(typeFromArmId(storedTargetId) ?? PRIVATE_LINK_TARGET_TYPES[0].type);
}

export interface PrivateLinkTargetFieldProps {
  /** Stored ARM id of the target resource. */
  value?: string;
  /**
   * Fires with the target ARM id and the groupIds Azure accepts for its type,
   * so the caller can pre-select the sub-resource instead of asking again.
   */
  onChange: (armId: string | null, groupIds: string[], resource: AzureResourceSelection | null) => void;
  label?: string;
  /** Human name of the calling surface, for the honest gate. */
  surface?: string;
  required?: boolean;
}

/**
 * NO `disabled` PROP, deliberately. The picker underneath binds `disabled` to
 * its in-flight query ALONE — that is Wave 0's defect-2 fix — so a `disabled`
 * here could only grey the type dropdown and leave the resource list live, i.e.
 * a half-honored contract. A caller that needs the whole control inert should
 * not render it.
 */
export function PrivateLinkTargetField({
  value, onChange, label = 'Target resource', surface, required,
}: PrivateLinkTargetFieldProps) {
  const s = useStyles();
  // Seeded from the stored id so reopening a saved endpoint lands on its own
  // type's list. Falls back to storage, which is what every Loom surface that
  // asks for a private-link target used in its placeholder.
  const [type, setType] = useState<string>(
    () => typeFromArmId(value) ?? PRIVATE_LINK_TARGET_TYPES[0].type,
  );

  const typeLabel = useMemo(
    () => PRIVATE_LINK_TARGET_TYPES.find((t) => t.type.toLowerCase() === type.toLowerCase())?.label ?? type,
    [type],
  );

  const handleType = useCallback((next: string) => {
    setType(next);
    // Changing the type invalidates the selection: the old id is not a member
    // of the new list, and silently keeping it would submit a mismatched pair.
    onChange(null, groupIdsForType(next), null);
  }, [onChange]);

  const handleResource = useCallback((r: AzureResourceSelection | null) => {
    if (!r) { onChange(null, groupIdsForType(type), null); return; }
    onChange(r.id || null, groupIdsForType(r.type || type), r);
  }, [onChange, type]);

  return (
    <div className={s.root}>
      <Field label="Resource type" required={required}>
        <Dropdown
          className={s.dropdown}
          value={typeLabel}
          selectedOptions={[type]}
          onOptionSelect={(_, d) => handleType(d.optionValue || type)}
        >
          {PRIVATE_LINK_TARGET_TYPES.map((t) => (
            <Option key={t.type} value={t.type} text={t.label}>{t.label}</Option>
          ))}
        </Dropdown>
      </Field>
      <AzureResourcePicker
        type={type}
        value={value}
        matchBy="id"
        onChange={handleResource}
        label={label}
        surface={surface || label}
        manualLabel="Target resource ID"
      />
    </div>
  );
}
