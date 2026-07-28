/**
 * B-N19g — DataHub MCE encoding (export) + MCE parsing (ingest backfill).
 *
 * Emits a MetadataChangeEvent stream in the `MetadataChangeEventClass` shape a
 * DataHub `file` source ingests directly:
 *
 *   { "proposedSnapshot": { "com.linkedin.metadata.snapshot.DatasetSnapshot": {
 *       "urn": "urn:li:dataset:(urn:li:dataPlatform:loom,<loom uri>,PROD)",
 *       "aspects": [ datasetProperties, ownership, globalTags,
 *                    schemaMetadata, upstreamLineage ] } } }
 *
 * The dataset URN embeds the N17 asset URI verbatim (see model.ts), so the
 * SAME identity flows through OpenLineage, DataHub, and OpenMetadata — and an
 * ingest can resolve a URN straight back to the Loom item.
 *
 * PURE — no I/O, so both directions are unit-tested end to end.
 *
 * Format reference: DataHub metadata model (Dataset entity + aspects),
 * https://datahubproject.io/docs/generated/metamodel/entities/dataset
 */
import {
  dataHubCorpUserUrn,
  dataHubDatasetUrn,
  parseDataHubDatasetUrn,
  DEFAULT_DATAHUB_ENV,
  type CatalogAsset,
  type CatalogLineageEdge,
} from './model';
import type { CatalogIngestRecord } from './ingest';

/** One MCE envelope (the shape DataHub's `file` source reads). */
export interface DataHubMce {
  proposedSnapshot: {
    'com.linkedin.metadata.snapshot.DatasetSnapshot': {
      urn: string;
      aspects: Array<Record<string, unknown>>;
    };
  };
}

/** Loom item types whose sensitivity label maps onto a DataHub glossary term. */
function sensitivityTerm(label: string): string {
  return `urn:li:glossaryTerm:Sensitivity.${label.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
}

/**
 * Encode assets (+ lineage) as a DataHub MCE stream. Upstream lineage rides the
 * downstream dataset's snapshot, which is how DataHub models it.
 */
export function assetsToDataHubMces(
  assets: CatalogAsset[],
  lineage: CatalogLineageEdge[] = [],
  env = DEFAULT_DATAHUB_ENV,
): DataHubMce[] {
  const upstreamsByTo = new Map<string, string[]>();
  for (const e of lineage || []) {
    const list = upstreamsByTo.get(e.toItemId) || [];
    list.push(e.fromUri);
    upstreamsByTo.set(e.toItemId, list);
  }

  return (assets || []).map((a) => {
    const aspects: Array<Record<string, unknown>> = [];

    aspects.push({
      'com.linkedin.dataset.DatasetProperties': {
        name: a.displayName,
        description: a.description || '',
        customProperties: {
          loomItemId: a.itemId,
          loomItemType: a.itemType,
          ...(a.workspaceId ? { loomWorkspaceId: a.workspaceId } : {}),
          ...(a.workspaceName ? { loomWorkspaceName: a.workspaceName } : {}),
          ...(a.endorsement ? { loomEndorsement: a.endorsement } : {}),
          ...(a.sensitivityLabel ? { loomSensitivityLabel: a.sensitivityLabel } : {}),
        },
        ...(a.updatedAt ? { lastModified: { time: Date.parse(a.updatedAt) || 0 } } : {}),
      },
    });

    if (a.owners.length) {
      aspects.push({
        'com.linkedin.common.Ownership': {
          owners: a.owners.map((o) => ({ owner: dataHubCorpUserUrn(o), type: 'DATAOWNER' })),
        },
      });
    }

    if (a.tags.length) {
      aspects.push({
        'com.linkedin.common.GlobalTags': {
          tags: a.tags.map((t) => ({ tag: `urn:li:tag:${t}` })),
        },
      });
    }

    if (a.sensitivityLabel) {
      aspects.push({
        'com.linkedin.common.GlossaryTerms': {
          terms: [{ urn: sensitivityTerm(a.sensitivityLabel) }],
        },
      });
    }

    if (a.columns.length) {
      aspects.push({
        'com.linkedin.schema.SchemaMetadata': {
          schemaName: a.displayName,
          platform: 'urn:li:dataPlatform:loom',
          version: 0,
          fields: a.columns.map((c) => ({
            fieldPath: c,
            type: { type: { 'com.linkedin.schema.StringType': {} } },
            nativeDataType: 'string',
          })),
        },
      });
    }

    const upstreams = upstreamsByTo.get(a.itemId) || [];
    if (upstreams.length) {
      aspects.push({
        'com.linkedin.dataset.UpstreamLineage': {
          upstreams: upstreams.map((u) => ({
            dataset: dataHubDatasetUrn(u, env),
            type: 'TRANSFORMED',
          })),
        },
      });
    }

    return {
      proposedSnapshot: {
        'com.linkedin.metadata.snapshot.DatasetSnapshot': {
          urn: dataHubDatasetUrn(a.uri, env),
          aspects,
        },
      },
    };
  });
}

function aspectOf(aspects: Array<Record<string, unknown>>, key: string): Record<string, unknown> | undefined {
  for (const a of aspects || []) {
    const v = a?.[key];
    if (v && typeof v === 'object') return v as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Parse a DataHub MCE stream back into Loom ingest records. Only Loom-platform
 * dataset URNs are accepted (a foreign platform's URN cannot be resolved to a
 * Loom item, so it is reported as skipped rather than silently dropped).
 */
export function parseDataHubMces(payload: unknown): { records: CatalogIngestRecord[]; skipped: string[] } {
  const rows: unknown[] = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { mces?: unknown[] }).mces)
      ? ((payload as { mces: unknown[] }).mces)
      : [];

  const records: CatalogIngestRecord[] = [];
  const skipped: string[] = [];

  for (const row of rows) {
    const snap = (row as DataHubMce)?.proposedSnapshot?.['com.linkedin.metadata.snapshot.DatasetSnapshot'];
    if (!snap || typeof snap.urn !== 'string') continue;
    const uri = parseDataHubDatasetUrn(snap.urn);
    if (!uri) {
      skipped.push(snap.urn);
      continue;
    }
    const aspects = Array.isArray(snap.aspects) ? snap.aspects : [];

    const props = aspectOf(aspects, 'com.linkedin.dataset.DatasetProperties');
    const ownership = aspectOf(aspects, 'com.linkedin.common.Ownership');
    const globalTags = aspectOf(aspects, 'com.linkedin.common.GlobalTags');
    const upstream = aspectOf(aspects, 'com.linkedin.dataset.UpstreamLineage');

    const owners = Array.isArray(ownership?.owners)
      ? (ownership!.owners as Array<{ owner?: string }>)
          .map((o) => String(o?.owner || '').replace(/^urn:li:corpuser:/, '').trim())
          .filter(Boolean)
      : [];
    const tags = Array.isArray(globalTags?.tags)
      ? (globalTags!.tags as Array<{ tag?: string }>)
          .map((t) => String(t?.tag || '').replace(/^urn:li:tag:/, '').trim())
          .filter(Boolean)
      : [];
    const upstreamUris = Array.isArray(upstream?.upstreams)
      ? (upstream!.upstreams as Array<{ dataset?: string }>)
          .map((u) => parseDataHubDatasetUrn(String(u?.dataset || '')))
          .filter((v): v is string => Boolean(v))
      : [];

    const custom = (props?.customProperties as Record<string, unknown> | undefined) || {};

    records.push({
      uri,
      displayName: typeof props?.name === 'string' ? props.name : undefined,
      description: typeof props?.description === 'string' && props.description.trim() ? props.description.trim() : undefined,
      owners,
      tags,
      sensitivityLabel: typeof custom.loomSensitivityLabel === 'string' ? custom.loomSensitivityLabel : undefined,
      upstreamUris,
    });
  }

  return { records, skipped };
}
