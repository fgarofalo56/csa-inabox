'use client';

/**
 * AzureBackedField — "I need an ADX cluster URI" → a picker plus the derived
 * value, with no caller ever naming an ARM type, an api-version or a property
 * path.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The mapping from "the value a surface needs" to "the ARM query that produces
 * it" was ALREADY WRITTEN, and nothing outside the admin gate dialog used it:
 * `lib/gates/registry/types.ts` exports `L`, 28 ARM options-loaders, each
 * naming an `armType`, the field to take (`name` | `id` | `properties.<path>`),
 * an api-version and an optional `kind` filter. Every one of them corresponds
 * to a value somebody is hand-typing somewhere in this app today —
 * `databricks → properties.workspaceUrl`, `adxUri → properties.uri`,
 * `keyvault → properties.vaultUri`, `sqlServer →
 * properties.fullyQualifiedDomainName`, `aas → properties.serverFullName`,
 * `cosmos → properties.documentEndpoint`.
 *
 * This is the adoption-gap shape (memory: csa_loom_guard_adoption_gap): the
 * correct helper existed and its siblings never adopted it. So this component
 * is built BY ITERATING `L` — not by re-listing it. A 29th loader added to the
 * registry becomes an AzureBackedField kind automatically, and the test asserts
 * exactly that, so the gap cannot silently reopen.
 *
 * ── HOW IT DIFFERS FROM THE ADMIN GATE DIALOG ───────────────────────────────
 * `GET /api/admin/gates/[id]/options` resolves the same loaders by doing a
 * per-resource ARM GET, so it slices to the FIRST 15 rows and only looks at
 * LOOM_SUBSCRIPTION_ID + LOOM_DLZ_SUBSCRIPTION_ID. This path goes through
 * `GET /api/azure/resources?select=properties.<path>`, which projects the value
 * inside the Resource Graph query: one request, no row cap, every subscription
 * the caller can read.
 *
 * ── CLOUD PARITY (`cloud-parity.md`) ────────────────────────────────────────
 * A kind may name SEVERAL sources, and the picker merges them. That is not a
 * convenience: Databricks Unity Catalog has no Azure Government endpoint, so a
 * "catalog endpoint" field that knows only `Microsoft.Databricks/workspaces` is
 * permanently EMPTY in Gov — the boundary that needs Loom Unity most would get
 * the dead end. `catalog-endpoint` therefore lists the Databricks workspace URL
 * AND the Loom Unity container app's ingress FQDN, and whichever exists in the
 * active boundary populates. No Fabric/Power BI source appears anywhere here
 * (`no-fabric-dependency.md`) — those clients throw by design in Gov.
 */
import { useCallback, useMemo } from 'react';
import { L, type GateOptionsLoader } from '@/lib/gates/registry/types';
import {
  AzureResourcePicker,
  type AzureResourceSelection,
  type AzureResourceSource,
  type MatchBy,
} from './azure-resource-picker';

/** How a discovered resource turns into the string the caller stores. */
export type ValueFrom = 'id' | 'name' | 'subscriptionId' | `properties.${string}`;

export interface AzureBackedFieldDef {
  /** Default field label. */
  label: string;
  /** The ARM queries whose results are merged (>1 = a cloud-parity pair). */
  sources: AzureResourceSource[];
  /** Which field of the picked resource becomes the stored value. */
  valueFrom: ValueFrom;
  /** What a hand-typed fallback would be, for the escape hatch's label. */
  manualLabel: string;
  /**
   * Optional post-processing of the stored value. Used where the ARG projection
   * is not quite the shape the platform itself binds — see `catalog-endpoint`.
   */
  normalize?: (v: string) => string;
}

/** `properties.<path>` values are projected by the route; the rest come from the row. */
function matchByFor(valueFrom: ValueFrom): MatchBy {
  if (valueFrom === 'id' || valueFrom === 'name' || valueFrom === 'subscriptionId') return valueFrom;
  return 'derived';
}

/** The stored value for a selection, per the def's `valueFrom`. */
export function valueOfSelection(valueFrom: ValueFrom, r: AzureResourceSelection): string {
  switch (valueFrom) {
    case 'id': return r.id;
    case 'name': return r.name;
    case 'subscriptionId': return r.subscriptionId;
    default: return r.value ?? '';
  }
}

/** Human label for a loader key: 'adxUri' → 'Adx uri' unless overridden below. */
function humanize(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Nicer names than `humanize` produces, keyed by loader key. */
const LOADER_LABELS: Record<string, string> = {
  synapse: 'Synapse workspace',
  adxUri: 'Azure Data Explorer cluster URI',
  eventhubs: 'Event Hubs namespace',
  storage: 'Storage account',
  aisearch: 'AI Search service',
  aoaiEndpoint: 'Azure OpenAI endpoint',
  aoaiDeployment: 'Azure OpenAI model deployment',
  aoaiAccount: 'Azure OpenAI / AI Services account',
  databricks: 'Databricks workspace URL',
  adf: 'Data Factory',
  purview: 'Purview account',
  cosmos: 'Cosmos DB endpoint',
  law: 'Log Analytics workspace',
  lawCustomerId: 'Log Analytics workspace ID',
  maps: 'Azure Maps account',
  acaEnv: 'Container Apps environment',
  acaEnvDomain: 'Container Apps environment domain',
  grafana: 'Azure Managed Grafana endpoint',
  sqlServer: 'Azure SQL server FQDN',
  aas: 'Analysis Services server',
  aml: 'Azure ML workspace',
  apim: 'API Management service',
  keyvault: 'Key Vault URI',
  servicebus: 'Service Bus namespace',
  adt: 'Digital Twins host name',
  batch: 'Batch account',
  pgFqdn: 'PostgreSQL server FQDN',
  cosmosAccountName: 'Cosmos DB account',
  appConfig: 'App Configuration endpoint',
};

/** Manual-entry labels where "Endpoint"/"Resource name" would be too vague. */
const LOADER_MANUAL_LABELS: Record<string, string> = {
  adxUri: 'Cluster URI',
  databricks: 'Workspace URL',
  keyvault: 'Vault URI',
  sqlServer: 'Server FQDN',
  pgFqdn: 'Server FQDN',
  aas: 'Server name',
  adt: 'Host name',
  cosmos: 'Account endpoint',
  aoaiEndpoint: 'Account endpoint',
  appConfig: 'Store endpoint',
  grafana: 'Grafana endpoint',
  acaEnvDomain: 'Environment default domain',
  lawCustomerId: 'Workspace ID (GUID)',
};

/**
 * One loader → one field definition. A loader whose `kindFilter` names several
 * kinds becomes several sources, because the route takes ONE `kind` per query
 * and dropping the extras would hide (for example) every AIServices account
 * behind the OpenAI ones.
 */
function fromLoader(key: string, loader: GateOptionsLoader): AzureBackedFieldDef {
  const select = loader.valueFrom.startsWith('properties.') ? loader.valueFrom : undefined;
  const kinds = loader.kindFilter?.length ? loader.kindFilter : [undefined];
  const label = LOADER_LABELS[key] ?? humanize(key);
  return {
    label,
    valueFrom: loader.valueFrom as ValueFrom,
    sources: kinds.map((k) => ({ type: loader.armType, kind: k, select, label: k ? `${label} · ${k}` : label })),
    manualLabel: LOADER_MANUAL_LABELS[key] ?? (select ? 'Endpoint' : 'Resource name'),
  };
}

/**
 * Kinds Resource Graph serves that the loader table does not name — the
 * container tables and the mv-expanded subnet — plus the cloud-parity
 * composites. `catalog-endpoint` is the load-bearing one: see the header.
 */
const EXTRA_FIELDS: Record<string, AzureBackedFieldDef> = {
  'resource-group': {
    label: 'Resource group',
    valueFrom: 'id',
    sources: [{ type: 'Microsoft.Resources/subscriptions/resourceGroups' }],
    manualLabel: 'Resource group ID',
  },
  subscription: {
    label: 'Subscription',
    valueFrom: 'subscriptionId',
    sources: [{ type: 'Microsoft.Resources/subscriptions' }],
    manualLabel: 'Subscription ID',
  },
  subnet: {
    label: 'Subnet',
    valueFrom: 'id',
    sources: [{ type: 'Microsoft.Network/virtualNetworks/subnets' }],
    manualLabel: 'Subnet resource ID',
  },
  'catalog-endpoint': {
    label: 'Catalog endpoint',
    valueFrom: 'properties.workspaceUrl',
    sources: [
      {
        type: 'Microsoft.Databricks/workspaces',
        select: 'properties.workspaceUrl',
        label: 'Databricks Unity Catalog (Commercial)',
      },
      {
        // Loom Unity — the OSS Unity Catalog server Loom deploys as a container
        // app. This is THE catalog in Azure Government, where Databricks Unity
        // Catalog does not exist (`cloud-parity.md`).
        //
        // NAME-FILTERED, because `Microsoft.App/containerApps` unfiltered is
        // every container app in the tenant: the console, the runner, the
        // DuckDB app, the catalog. That produced *a* list in Gov but not a
        // USABLE one. `loom-unity` is the deterministic name pinned by
        // `platform/fiab/bicep/modules/compute/loom-unity-app.bicep`
        // (`param name string = 'loom-unity'`).
        type: 'Microsoft.App/containerApps',
        name: 'loom-unity',
        select: 'properties.configuration.ingress.fqdn',
        label: 'Loom Unity (OSS Unity Catalog — Gov + Commercial)',
      },
    ],
    // `ingress.fqdn` is a BARE host with no scheme; every consumer of a catalog
    // endpoint wants a URL, and the value the deploy itself wires
    // (`LOOM_UNITY_URL`) is `https://loom-unity.internal.<caeDomain>`. Without
    // this the picker would store a value shaped differently from the one the
    // platform binds — the two would silently disagree.
    normalize: (v) => (v && !/^https?:\/\//i.test(v) ? `https://${v}` : v),
    manualLabel: 'Catalog endpoint',
  },
};

/**
 * Every field kind, built from the registry loader table plus the extras.
 * Loader keys keep their registry names (`adxUri`, `sqlServer`, …) so a reader
 * can go straight from a call site to the loader it uses.
 */
export const AZURE_BACKED_FIELDS: Record<string, AzureBackedFieldDef> = {
  ...Object.fromEntries(
    Object.entries(L)
      // `special: 'aoai-deployments'` is a two-step account→deployments walk
      // that Resource Graph cannot express; it stays on the gate-options route.
      .filter(([, loader]) => !(loader as GateOptionsLoader).special)
      .map(([key, loader]) => [key, fromLoader(key, loader as GateOptionsLoader)]),
  ),
  ...EXTRA_FIELDS,
};

export type AzureBackedKind = keyof typeof AZURE_BACKED_FIELDS & string;

/** Loader keys deliberately NOT served here, with the reason. */
export const UNSERVED_LOADERS: Record<string, string> = Object.assign(Object.create(null), {
  aoaiDeployment:
    'A model deployment is a child of a Cognitive Services account (accounts → per-account deployments) and is not a Resource Graph row. Use the gate Fix-it dialog, which walks both steps.',
});

export interface AzureBackedFieldProps {
  /** Which value this field needs — a registry loader key or an extra kind. */
  kind: AzureBackedKind;
  /** The stored value (whatever the kind's `valueFrom` produces). */
  value?: string;
  /** Fires with the stored value plus the full resource behind it. */
  onChange: (value: string | null, resource: AzureResourceSelection | null) => void;
  /** Overrides the kind's default label. */
  label?: string;
  placeholder?: string;
  /** Human name of the calling surface, for the honest gate. */
  surface?: string;
  /** Set false only where a typed value could never be valid. */
  allowManualEntry?: boolean;
}

export function AzureBackedField({
  kind, value, onChange, label, placeholder, surface, allowManualEntry,
}: AzureBackedFieldProps) {
  // `Object.hasOwn`, not a bare index: `AZURE_BACKED_FIELDS` is a plain object,
  // so `AZURE_BACKED_FIELDS['toString']` returns a FUNCTION — truthy, and then
  // `def.sources` is undefined and the picker mounts with no query at all.
  const def = Object.hasOwn(AZURE_BACKED_FIELDS, kind) ? AZURE_BACKED_FIELDS[kind] : undefined;

  const handle = useCallback(
    (r: AzureResourceSelection | null) => {
      if (!r || !def) { onChange(null, null); return; }
      const raw = valueOfSelection(def.valueFrom, r);
      const v = def.normalize ? def.normalize(raw) : raw;
      onChange(v || null, r);
    },
    [def, onChange],
  );

  const sources = useMemo(() => def?.sources ?? [], [def]);

  if (!def) {
    // An unknown kind is a coding error, and it says so rather than rendering an
    // empty box that reads as "you have none of these".
    return (
      <div role="alert">
        {`AzureBackedField: unknown kind '${kind}'. `}
        {UNSERVED_LOADERS[kind] ?? `Known kinds: ${Object.keys(AZURE_BACKED_FIELDS).sort().join(', ')}.`}
      </div>
    );
  }

  return (
    <AzureResourcePicker
      sources={sources}
      value={value}
      matchBy={matchByFor(def.valueFrom)}
      onChange={handle}
      label={label ?? def.label}
      placeholder={placeholder}
      surface={surface ?? label ?? def.label}
      manualLabel={def.manualLabel}
      allowManualEntry={allowManualEntry}
    />
  );
}
