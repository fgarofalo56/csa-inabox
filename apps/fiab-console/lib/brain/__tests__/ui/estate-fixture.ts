/**
 * LOOM BRAIN VISUALIZER — the estate fixture.
 *
 * ── THESE ROWS MODEL AZURE, NOT THIS CODE ──────────────────────────────────
 * A fixture built from the shape the code EXPECTS proves only that the code
 * agrees with itself. This one is built from the shape Azure Resource Graph
 * actually returns for `Microsoft.App/containerApps` — `properties.template.
 * scale`, `properties.template.containers[].env`, `properties.configuration.
 * ingress`, `properties.provisioningState`, top-level `tags` — so a change that
 * breaks the real projection breaks these tests too.
 *
 * Every measured value below was verified against the repository on
 * 2026-08-23 rather than recalled:
 *
 *   compute/loom-capacity-broker-app.bicep
 *     :54   param name string = 'loom-capacity-broker'
 *     :124  external: false            (INTERNAL ingress)
 *     :154  cpu: json('0.5')
 *     :155  memory: '1Gi'
 *     :186  minReplicas: 2   maxReplicas: 5
 *   admin-plane/main.bicep
 *     :4730 { name: 'LOOM_BROKER_URL', value: '' }
 *     :4729 { name: 'LOOM_DIRECTLAKE_URL', value: 'https://${loomDirectLake!.outputs.fqdn}' }
 *
 * ── THE CONTROL IS NOT DECORATION ──────────────────────────────────────────
 * `loom-directlake` is WIRED, by the line immediately above the broken one in
 * the same bicep block. Without it, "every app is unreachable" would satisfy
 * every assertion in this suite identically — the detector would be indistinguishable
 * from `() => allNodes`. Several tests below assert the control is ABSENT from
 * the unreachable set, which is the assertion that actually has teeth.
 *
 * ── NO REAL IDENTIFIERS ────────────────────────────────────────────────────
 * This is a PUBLIC repository. The subscription GUIDs are obviously-synthetic
 * placeholders (`00000000-0000-4000-8000-0000000000NN`) and no tenant, object
 * or real resource id appears anywhere.
 */

import type { CollectionResult } from '@/app/api/admin/brain/_lib/arg-collect';
import { azureResourceNodeId, type ResourceGraphRow } from '@/lib/brain/graph';

/** Synthetic placeholders. Not real subscriptions. */
export const SUB_A = '00000000-0000-4000-8000-000000000001';
export const SUB_B = '00000000-0000-4000-8000-000000000002';

const RG = 'rg-loom';

export function appId(sub: string, name: string, rg = RG): string {
  return `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.App/containerApps/${name}`;
}

interface AppSpec {
  readonly name: string;
  readonly sub?: string;
  readonly rg?: string;
  readonly minReplicas?: number;
  readonly maxReplicas?: number;
  readonly cpu?: number;
  readonly memory?: string;
  readonly external?: boolean;
  readonly fqdn?: string | null;
  readonly env?: ReadonlyArray<{ name: string; value?: string; secretRef?: string }>;
  readonly tags?: Record<string, string> | null;
  readonly provisioningState?: string;
  /** Omit the whole scale block — models "Resource Graph returned no scale". */
  readonly noScale?: boolean;
}

/** One ARG row, shaped exactly as the service returns it. */
export function containerAppRow(spec: AppSpec): ResourceGraphRow {
  const sub = spec.sub ?? SUB_A;
  const rg = spec.rg ?? RG;
  return {
    id: appId(sub, spec.name, rg),
    name: spec.name,
    type: 'Microsoft.App/containerApps',
    resourceGroup: rg,
    subscriptionId: sub,
    location: 'eastus',
    tags: spec.tags === undefined ? {} : spec.tags,
    properties: {
      provisioningState: spec.provisioningState ?? 'Succeeded',
      configuration: {
        ingress: {
          external: spec.external ?? false,
          fqdn: spec.fqdn === undefined ? `${spec.name}.internal.example.azurecontainerapps.io` : spec.fqdn,
          targetPort: 8080,
        },
      },
      template: {
        ...(spec.noScale
          ? {}
          : {
              scale: {
                minReplicas: spec.minReplicas ?? 0,
                maxReplicas: spec.maxReplicas ?? 3,
              },
            }),
        containers: [
          {
            name: spec.name,
            resources: { cpu: spec.cpu ?? 0.25, memory: spec.memory ?? '0.5Gi' },
            env: spec.env ?? [],
          },
        ],
      },
    },
  };
}

export function managedEnvRow(sub: string, name: string): ResourceGraphRow {
  return {
    id: `/subscriptions/${sub}/resourceGroups/${RG}/providers/Microsoft.App/managedEnvironments/${name}`,
    name,
    type: 'Microsoft.App/managedEnvironments',
    resourceGroup: RG,
    subscriptionId: sub,
    location: 'eastus',
    tags: {},
    properties: { provisioningState: 'Succeeded' },
  };
}

/** THE CONSOLE — carries the wires, one wired and one empty. */
export const CONSOLE_ENV: ReadonlyArray<{ name: string; value?: string; secretRef?: string }> = [
  // The founding case: the wire EXISTS on the running app and carries ''.
  { name: 'LOOM_BROKER_URL', value: '' },
  // The CONTROL: wired to a real FQDN in the very next line of the same bicep.
  { name: 'LOOM_DIRECTLAKE_URL', value: 'https://loom-directlake.internal.example.azurecontainerapps.io' },
  // A second empty wire — the founding SHAPE has more than one instance, which
  // is the argument for a query over a hand-written rule.
  { name: 'LOOM_ONELAKE_URL', value: '' },
  // Not readable — INDETERMINATE, and must not be counted as an empty wire.
  { name: 'LOOM_TRINO_URL', secretRef: 'loom-trino-url' },
  // Noise the `onlyNames` filter must exclude: not in the binding table.
  { name: 'LOOM_ENABLE_SOMETHING', value: 'false' },
  { name: 'LOOM_LOG_LEVEL', value: 'info' },
];

/**
 * The estate.
 *
 * Deliberately mixed so every branch of every detector has a subject:
 *   loom-console            wired-ish, always-on, holds the wires
 *   loom-capacity-broker    THE FINDING — always-on 2x0.5vCPU/1Gi, internal, unreachable
 *   loom-directlake         THE CONTROL — reachable, must never appear as unreachable
 *   loom-onelake            unreachable AND always-on (second instance of the class)
 *   loom-migrate            unreachable but minReplicas 0 — real, not urgent
 *   loom-unity              scale block absent — NOT MEASURED, never "zero"
 *   blog-app (SUB_B)        a NON-LOOM app in another subscription
 */
export function estateRows(opts?: { readonly ownershipTag?: string }): ResourceGraphRow[] {
  const tag = opts?.ownershipTag ? { 'loom-estate-id': opts.ownershipTag } : undefined;
  const t = (extra?: Record<string, string>) => ({ ...(tag ?? {}), ...(extra ?? {}) });

  return [
    managedEnvRow(SUB_A, 'loom-cae'),
    managedEnvRow(SUB_B, 'blog-cae'),

    containerAppRow({
      name: 'loom-console',
      minReplicas: 2,
      cpu: 1,
      memory: '2Gi',
      external: true,
      env: CONSOLE_ENV,
      tags: t({ CSA_Loom: 'true' }),
    }),

    // ── THE ACCEPTANCE SUBJECT ──────────────────────────────────────────────
    containerAppRow({
      name: 'loom-capacity-broker',
      minReplicas: 2,
      maxReplicas: 5,
      cpu: 0.5,
      memory: '1Gi',
      external: false,
      tags: t(),
    }),

    // ── THE CONTROL ─────────────────────────────────────────────────────────
    containerAppRow({
      name: 'loom-directlake',
      minReplicas: 1,
      cpu: 0.5,
      memory: '1Gi',
      external: false,
      fqdn: 'loom-directlake.internal.example.azurecontainerapps.io',
      tags: t(),
    }),

    containerAppRow({
      name: 'loom-onelake',
      minReplicas: 1,
      cpu: 0.25,
      memory: '0.5Gi',
      tags: t(),
    }),

    containerAppRow({
      name: 'loom-migrate',
      minReplicas: 0,
      cpu: 0.25,
      memory: '0.5Gi',
      tags: t(),
    }),

    // Scale NOT MEASURED — must never be reported as "scales to zero".
    containerAppRow({ name: 'loom-unity', noScale: true, tags: t() }),

    // A non-Loom app in a different subscription: present in the report (all
    // subscriptions) and never ownership-confirmed.
    containerAppRow({
      name: 'blog-app',
      sub: SUB_B,
      rg: 'rg-blog',
      minReplicas: 1,
      cpu: 0.5,
      memory: '1Gi',
      tags: null,
    }),
  ];
}

/** Wrap rows as a complete collection — `complete: true` so tests exercise the happy path. */
export function collection(rows: ResourceGraphRow[] = estateRows()): CollectionResult {
  return {
    rows,
    stats: {
      rowsFetched: rows.length,
      totalRecords: rows.length,
      pages: 1,
      complete: true,
      subscriptionsSeen: new Set(rows.map((r) => r.subscriptionId)).size,
      durationMs: 12,
      cloud: 'Commercial',
      truncatedByPageCap: false,
    },
  };
}

/**
 * The node ids the graph will actually mint.
 *
 * Built with the REAL `azureResourceNodeId` rather than by restating its
 * algorithm here. Restating it is how a fixture starts modelling the test's
 * idea of identity instead of the system's: the constructor lowercases and
 * prefixes (`azure:`), and a hand-written `id.toLowerCase()` silently diverged
 * from it while still looking correct.
 */
export const BROKER_ID = azureResourceNodeId(appId(SUB_A, 'loom-capacity-broker')) as string;
export const DIRECTLAKE_ID = azureResourceNodeId(appId(SUB_A, 'loom-directlake')) as string;
export const CONSOLE_ID = azureResourceNodeId(appId(SUB_A, 'loom-console')) as string;
export const ONELAKE_ID = azureResourceNodeId(appId(SUB_A, 'loom-onelake')) as string;
export const MIGRATE_ID = azureResourceNodeId(appId(SUB_A, 'loom-migrate')) as string;
export const UNITY_ID = azureResourceNodeId(appId(SUB_A, 'loom-unity')) as string;
export const BLOG_ID = azureResourceNodeId(appId(SUB_B, 'blog-app', 'rg-blog')) as string;
