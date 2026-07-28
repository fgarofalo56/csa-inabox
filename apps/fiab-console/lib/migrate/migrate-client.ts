/**
 * M1 — server-only client for the `apps/loom-migrate` estate-enumeration reader.
 *
 * The reader is an internal-ingress ACA app (`LOOM_MIGRATE_URL`) that connects
 * to a source estate (Snowflake / Databricks Unity Catalog / Microsoft Fabric /
 * Power BI) and returns an ENUMERATED INVENTORY the assessment engine
 * (`./assessment`) turns into a readiness report. This module is the ONLY door
 * from the console to that reader — the BFF route wraps it with session, gate,
 * and audit.
 *
 * HONEST GATES (no-vaporware / no-fabric-dependency):
 *   - `LOOM_MIGRATE_URL` unset → {@link isMigrateConfigured} is false and the
 *     BFF returns the `svc-loom-migrate` gate envelope (Fix-it names the exact
 *     prerequisite). This module NEVER fabricates an inventory.
 *   - A source connector whose CONNECTION prerequisite is absent (account URL /
 *     token / workspace id) → the reader replies with a structured connector
 *     gate; {@link enumerateEstate} surfaces it as {@link MigrateConnectorGate}
 *     so the BFF renders a precise MessageBar instead of fake counts. In an IL5
 *     boundary the reader runs in-boundary; SaaS-source connectors stay gated
 *     until their connection prerequisite is provided.
 *
 * Server-only: reaches the internal reader FQDN with the ACA-first UAMI bearer.
 * Never import into a client component.
 */
import type { EnumeratedInventory, MigrationSourceType } from './assessment';

/** True when the estate reader is wired for this deployment. */
export function isMigrateConfigured(): boolean {
  return (process.env.LOOM_MIGRATE_URL || '').trim().length > 0;
}

/** The connection descriptor the surface collects for a source (secrets are
 * KV-refs the BFF resolves; here they arrive as already-resolved opaque
 * strings). Shape is source-specific — passed through to the reader verbatim. */
export interface MigrateConnection {
  /** Account / workspace / host URL of the source estate. */
  host?: string;
  /** Workspace / group / catalog id (Fabric, Power BI, UC). */
  workspaceId?: string;
  /** Catalog to enumerate (Databricks UC / Snowflake database). */
  catalog?: string;
  /** Resolved bearer token / PAT for the source (from a Key Vault secret ref). */
  token?: string;
  /** Snowflake account identifier when host is not a full URL. */
  account?: string;
}

/** Structured "connection prerequisite missing" reply from the reader — the
 * honest connector gate the BFF renders as a Fix-it MessageBar. */
export interface MigrateConnectorGate {
  gated: true;
  sourceType: MigrationSourceType;
  /** The exact prerequisite fields the operator must supply. */
  prerequisite: string[];
  /** Human, single-sentence remediation naming the prerequisite. */
  message: string;
}

export type EnumerateResult =
  | { ok: true; inventory: EnumeratedInventory }
  | { ok: false; gate: MigrateConnectorGate };

/** Thrown when the reader is unreachable / errors (distinct from an honest
 * connector gate, which is a normal `{ ok:false, gate }` result). */
export class MigrateReaderError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = 'MigrateReaderError';
  }
}

async function readerBearer(): Promise<string | undefined> {
  // The reader authenticates the caller via the shared ACA-first UAMI chain,
  // same as every other internal-ingress Loom sidecar. Audience is the reader's
  // own app id when set; otherwise in-VNet trust (the reader is internal-only).
  const audience = (process.env.LOOM_MIGRATE_AUDIENCE || '').trim();
  if (!audience) return undefined;
  try {
    const { uamiArmCredential } = await import('@/lib/azure/arm-credential');
    const tok = await uamiArmCredential().getToken(`${audience}/.default`);
    return tok?.token;
  } catch {
    return undefined;
  }
}

/**
 * Enumerate a source estate through the reader. Returns the inventory on
 * success, or an honest connector gate when the source's connection
 * prerequisite is missing. Throws {@link MigrateReaderError} only for a real
 * transport / reader failure.
 */
export async function enumerateEstate(
  sourceType: MigrationSourceType,
  connection: MigrateConnection,
): Promise<EnumerateResult> {
  const base = (process.env.LOOM_MIGRATE_URL || '').trim().replace(/\/+$/, '');
  if (!base) {
    // Callers must gate on isMigrateConfigured() first; this is a hard guard.
    throw new MigrateReaderError('LOOM_MIGRATE_URL is not configured', 503);
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const bearer = await readerBearer();
  if (bearer) headers.authorization = `Bearer ${bearer}`;

  let res: Response;
  try {
    res = await fetch(`${base}/enumerate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sourceType, connection }),
      cache: 'no-store',
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new MigrateReaderError(`Estate reader unreachable: ${(e as Error)?.message || e}`);
  }

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new MigrateReaderError(
      `Estate reader error (${res.status}): ${String((json as { error?: string }).error || res.statusText).slice(0, 300)}`,
      502,
    );
  }

  // Honest connector gate: reader reachable but the source needs credentials.
  if (json && json.ok === false && (json as { gated?: boolean }).gated) {
    const gate = (json as { gate?: Partial<MigrateConnectorGate> }).gate || {};
    return {
      ok: false,
      gate: {
        gated: true,
        sourceType,
        prerequisite: Array.isArray(gate.prerequisite) ? gate.prerequisite.map(String) : [],
        message: typeof gate.message === 'string' ? gate.message : 'This source needs a connection to be provided.',
      },
    };
  }

  const inventory = (json as { inventory?: EnumeratedInventory }).inventory;
  if (!inventory || !Array.isArray(inventory.objects)) {
    throw new MigrateReaderError('Estate reader returned no inventory', 502);
  }
  // Trust the reader's canonical kinds; the assessment engine falls back to the
  // `unknown` rule for anything it does not recognize (never a fake 1:1).
  return { ok: true, inventory: { ...inventory, sourceType } };
}
