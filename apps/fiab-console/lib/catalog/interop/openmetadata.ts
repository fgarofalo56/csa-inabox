/**
 * B-N19g — OpenMetadata JSON encoding (export) + parsing (ingest backfill).
 *
 * Emits the OpenMetadata `CreateTable`-family request shape plus an
 * `AddLineage` edge list, which is what the OM ingestion framework's
 * `metadata ingest` custom/file source and the `/v1/lineage` API consume:
 *
 *   { service, entities: [ { name, displayName, description, fullyQualifiedName,
 *       tags, owners, columns, extension:{loomItemId,…} } ],
 *     lineage: [ { edge: { fromEntity:{id,type}, toEntity:{id,type} } } ] }
 *
 * The `fullyQualifiedName` is `loom.<loom asset uri>` — the N17 identity again
 * (see model.ts) — so OM, DataHub, and the OpenLineage export name the same
 * dataset the same way and an ingest resolves straight back to the Loom item.
 *
 * PURE — no I/O.
 *
 * Format reference: OpenMetadata entity + lineage APIs,
 * https://docs.open-metadata.org/swagger.html
 */
import type { CatalogAsset, CatalogLineageEdge } from './model';
import type { CatalogIngestRecord } from './ingest';

/** The OM database-service name Loom assets are published under. */
export const OM_SERVICE_NAME = 'loom';

export interface OpenMetadataColumn {
  name: string;
  dataType: string;
  dataTypeDisplay?: string;
}

export interface OpenMetadataEntity {
  name: string;
  displayName: string;
  description?: string;
  fullyQualifiedName: string;
  entityType: string;
  serviceType: string;
  tags: Array<{ tagFQN: string; source: string; labelType: string; state: string }>;
  owners: Array<{ name: string; type: string }>;
  columns: OpenMetadataColumn[];
  extension: Record<string, unknown>;
  updatedAt?: string;
}

export interface OpenMetadataLineageEdge {
  edge: {
    fromEntity: { id: string; type: string };
    toEntity: { id: string; type: string };
    description?: string;
  };
}

export interface OpenMetadataExport {
  service: string;
  serviceType: string;
  entities: OpenMetadataEntity[];
  lineage: OpenMetadataLineageEdge[];
}

/** `loom.<uri>` — the OM fully-qualified name for a Loom asset. */
export function omFqn(uri: string): string {
  return `${OM_SERVICE_NAME}.${uri}`;
}

/** Parse an OM FQN back to the Loom asset URI (null when not a Loom FQN). */
export function parseOmFqn(fqn: string): string | null {
  const v = String(fqn || '').trim();
  const prefix = `${OM_SERVICE_NAME}.`;
  if (!v.startsWith(prefix)) return null;
  const rest = v.slice(prefix.length);
  return rest || null;
}

function omTag(tag: string) {
  return { tagFQN: tag, source: 'Classification', labelType: 'Manual', state: 'Confirmed' };
}

/** Encode assets (+ lineage) as an OpenMetadata import payload. */
export function assetsToOpenMetadata(
  assets: CatalogAsset[],
  lineage: CatalogLineageEdge[] = [],
): OpenMetadataExport {
  const entities: OpenMetadataEntity[] = (assets || []).map((a) => ({
    name: a.displayName,
    displayName: a.displayName,
    description: a.description,
    fullyQualifiedName: omFqn(a.uri),
    entityType: 'table',
    serviceType: 'CustomDatabase',
    tags: [
      ...a.tags.map(omTag),
      ...(a.sensitivityLabel ? [omTag(`Sensitivity.${a.sensitivityLabel}`)] : []),
      ...(a.endorsement ? [omTag(`Endorsement.${a.endorsement}`)] : []),
    ],
    owners: a.owners.map((o) => ({ name: o, type: 'user' })),
    columns: a.columns.map((c) => ({ name: c, dataType: 'UNKNOWN', dataTypeDisplay: 'unknown' })),
    extension: {
      loomItemId: a.itemId,
      loomItemType: a.itemType,
      loomUri: a.uri,
      ...(a.workspaceId ? { loomWorkspaceId: a.workspaceId } : {}),
      ...(a.workspaceName ? { loomWorkspaceName: a.workspaceName } : {}),
    },
    updatedAt: a.updatedAt,
  }));

  const edges: OpenMetadataLineageEdge[] = (lineage || []).map((e) => ({
    edge: {
      fromEntity: { id: omFqn(e.fromUri), type: 'table' },
      toEntity: { id: omFqn(e.toUri), type: 'table' },
      ...(e.action ? { description: e.action } : {}),
    },
  }));

  return { service: OM_SERVICE_NAME, serviceType: 'CustomDatabase', entities, lineage: edges };
}

/**
 * Parse an OpenMetadata payload back into Loom ingest records. Entities whose
 * FQN is not in the Loom service (or whose `extension.loomUri` is absent) are
 * reported as skipped, never silently dropped.
 */
export function parseOpenMetadata(payload: unknown): { records: CatalogIngestRecord[]; skipped: string[] } {
  const root = (payload || {}) as Partial<OpenMetadataExport> & { data?: Partial<OpenMetadataExport> };
  const src = Array.isArray(root.entities) ? root : (root.data as Partial<OpenMetadataExport>) || {};
  const entities: unknown[] = Array.isArray(src.entities) ? src.entities : [];
  const lineage: unknown[] = Array.isArray(src.lineage) ? src.lineage : [];

  const upstreamByTo = new Map<string, string[]>();
  for (const l of lineage) {
    const edge = (l as OpenMetadataLineageEdge)?.edge;
    const from = parseOmFqn(String(edge?.fromEntity?.id || ''));
    const to = parseOmFqn(String(edge?.toEntity?.id || ''));
    if (!from || !to) continue;
    const list = upstreamByTo.get(to) || [];
    list.push(from);
    upstreamByTo.set(to, list);
  }

  const records: CatalogIngestRecord[] = [];
  const skipped: string[] = [];

  for (const raw of entities) {
    const e = raw as Partial<OpenMetadataEntity>;
    const ext = (e.extension || {}) as Record<string, unknown>;
    const uri =
      (typeof ext.loomUri === 'string' && ext.loomUri.trim() ? ext.loomUri.trim() : null) ||
      parseOmFqn(String(e.fullyQualifiedName || ''));
    if (!uri) {
      skipped.push(String(e.fullyQualifiedName || e.name || 'unnamed entity'));
      continue;
    }
    const tags = Array.isArray(e.tags)
      ? e.tags.map((t) => String((t as { tagFQN?: string })?.tagFQN || '').trim()).filter(Boolean)
      : [];
    const sensitivity = tags.find((t) => t.startsWith('Sensitivity.'));
    records.push({
      uri,
      displayName: typeof e.displayName === 'string' ? e.displayName : typeof e.name === 'string' ? e.name : undefined,
      description: typeof e.description === 'string' && e.description.trim() ? e.description.trim() : undefined,
      owners: Array.isArray(e.owners)
        ? e.owners.map((o) => String((o as { name?: string })?.name || '').trim()).filter(Boolean)
        : [],
      tags: tags.filter((t) => !t.startsWith('Sensitivity.') && !t.startsWith('Endorsement.')),
      sensitivityLabel: sensitivity ? sensitivity.slice('Sensitivity.'.length) : undefined,
      upstreamUris: upstreamByTo.get(uri) || [],
    });
  }

  return { records, skipped };
}
