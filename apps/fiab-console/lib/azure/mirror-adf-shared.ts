/**
 * mirror-adf-shared — the small primitives BOTH mirror engines need.
 *
 * `mirror-engine.ts` dispatches to `mirror-adf-copy.ts`, so anything the copy
 * runtime imports back out of the engine would be a require cycle. These values
 * are the entire overlap, so they live here instead. Types stay in
 * `mirror-engine.ts` and are pulled with `import type`, which TypeScript erases,
 * so they create no runtime edge.
 *
 * Extracted when `mirror-engine.ts` crossed its 1700-LOC ceiling. The seam is
 * the one the file already documented with its own banner comment — the ADF
 * Copy runtime — not an arbitrary line-count cut.
 *
 * This module used to import nothing of ours. It now imports `adf-client`,
 * `adls-client` and `cloud-endpoints` so the ADLS sink can AUTO-BIND (below).
 * None of the three imports anything under `mirror-*`, so the no-cycle
 * invariant the extraction exists to protect is intact — what changed is that
 * this leaf is no longer import-free, not that it gained an edge back into an
 * engine.
 */
import { upsertLinkedService } from './adf-client';
import { getAccountName } from './adls-client';
import { dfsSuffix } from './cloud-endpoints';

/** The ADLS container every mirror lands into. */
export const BRONZE = 'bronze';

/** Cap how many tables one Start replicates when none were explicitly chosen. */
export const MAX_TABLES = Number(process.env.LOOM_MIRROR_MAX_TABLES || 50);

/**
 * ADF object name: letters/digits/_ only, first char a letter. Byte-for-byte
 * the same transform the provisioner's `adfName()` applies, so the derived
 * pipeline name matches the one `provisionAdfCdc()` created (`<name>_to_bronze`).
 */
export function adfSafeName(s: string): string {
  let n = s.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+/, '').slice(0, 120);
  if (!/^[A-Za-z]/.test(n)) n = `t_${n}`;
  return n || 'loom_mirror';
}

/**
 * The auto-bound ADLS Gen2 sink linked service — one per factory, authenticated
 * with the FACTORY's own managed identity (no credential field, no account key).
 */
export const LOOM_MIRROR_SINK_LINKED_SERVICE = 'loom_mirror_sink_adls';

/**
 * An operator-PINNED ADLS sink linked service, or null.
 *
 * `LOOM_MIRROR_ADLS_LINKED_SERVICE` is an OVERRIDE, not a prerequisite — the
 * same contract `LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE` already has. A brownfield
 * estate may hold a hand-tuned `AzureBlobFS` linked service (a managed private
 * endpoint, a different account, a SHIR) that Loom must not clobber; setting the
 * variable keeps it. Everyone else gets the auto-bound one and never learns the
 * variable exists.
 */
export function mirrorAdlsLinkedService(): string | null {
  const v = process.env.LOOM_MIRROR_ADLS_LINKED_SERVICE;
  return v && v.trim() ? v.trim() : null;
}

/**
 * The DFS endpoint of the deployment's Bronze account, or null when the lake is
 * not wired.
 *
 * Sovereign-cloud correct by construction: the suffix comes from `dfsSuffix()`,
 * which resolves the Commercial/GCC host in one boundary and the US-Government
 * host in GCC-High / IL5 / DoD. No literal appears here — a hard-coded
 * Commercial host is the exact defect this repo ratchets against, and it is what
 * made every SQL mirror in a sovereign boundary bind to a hostname that does not
 * resolve there. `getAccountName()` throws when no `LOOM_{BRONZE,SILVER,GOLD,
 * LANDING}_URL` is configured, so it is guarded the same way
 * `mirror-engine.bronzeConfigured()` guards it.
 */
export function mirrorAdlsSinkUrl(): string | null {
  if (!process.env.LOOM_BRONZE_URL) return null;
  try {
    return `https://${getAccountName()}.${dfsSuffix()}`;
  } catch {
    return null;
  }
}

/** Why an ADLS sink linked service could not be bound. Never carries a secret. */
export interface MirrorSinkGate {
  missing: string;
  message: string;
}

/**
 * Resolve the ADLS Gen2 sink linked service a mirror should write through,
 * CREATING it when it is absent.
 *
 * ## Why this exists (auto-bind-by-default.md §5)
 *
 * The install-time SQL mirror path has always auto-created its own sink —
 * `lib/install/provisioners/mirrored-database.ts` upserts
 * `<MirrorName>_sink_adls` as `AzureBlobFS` with factory-MI auth and gets on
 * with it. The Start-time ADF Copy and ADF CDC paths did not: they DEMANDED a
 * pre-existing shared linked service named by `LOOM_MIRROR_ADLS_LINKED_SERVICE`,
 * and gated when it was unset — which it is on every shipped deployment, because
 * the bicep param that feeds it has no value to compose.
 *
 * That asymmetry was the defect. Loom holds every value the linked service needs
 * (the Bronze account is `LOOM_BRONZE_URL`, the auth is the factory's own MI), so
 * asking the operator for it is precisely the shape §5 forbids. The fix is not to
 * deploy the linked service from bicep — ADF linked services are data-plane
 * objects an ARM template does not own here — it is to make the runtime create
 * the thing it needs, exactly like its sibling already did.
 *
 * ## Self-healing (§3)
 *
 * The upsert is unconditional, so a linked service deleted or edited out-of-band
 * is simply rebuilt on the next Start rather than surfacing an error.
 *
 * ## Idempotency
 *
 * `upsertLinkedService` is a name-addressed ARM PUT. Re-running it with the same
 * name and body is a no-op on the service, so a re-Start (or a redeploy that
 * re-runs a mirror) can never create a second sink.
 */
export async function ensureMirrorAdlsLinkedService(): Promise<
  { linkedServiceName: string; pinned: boolean } | { gate: MirrorSinkGate }
> {
  const pinned = mirrorAdlsLinkedService();
  if (pinned) return { linkedServiceName: pinned, pinned: true };

  const url = mirrorAdlsSinkUrl();
  if (!url) {
    return {
      gate: {
        missing: 'LOOM_BRONZE_URL',
        message:
          'The ADLS Bronze landing zone is not configured for this deployment, so the mirror has nowhere to write. ' +
          'LOOM_BRONZE_URL is produced by the landing-zone deploy (platform/fiab/bicep) — no linked service or ' +
          'portal step is required once the lake is bound.',
      },
    };
  }

  await upsertLinkedService(LOOM_MIRROR_SINK_LINKED_SERVICE, {
    name: LOOM_MIRROR_SINK_LINKED_SERVICE,
    properties: {
      type: 'AzureBlobFS',
      description:
        'Loom mirroring Bronze sink (factory managed-identity auth). Auto-bound by CSA Loom — do not hand-edit.',
      typeProperties: { url },
    },
  } as never);
  return { linkedServiceName: LOOM_MIRROR_SINK_LINKED_SERVICE, pinned: false };
}
