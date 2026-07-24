'use client';

/**
 * DuckLake catalog editor (N8 lab 1, Preview).
 *
 * A Postgres-backed lakehouse-metadata catalog offered ALONGSIDE the N1 Iceberg
 * REST Catalog. The surface renders fully in every state:
 *   • FLAG0 `n8-ducklake-catalog` OFF → a guided "turned off" notice.
 *   • Unconfigured → a guided empty state + the HonestGate Fix-it (no red on
 *     first open — the gate is a warning, not an error).
 *   • Configured → the REAL table listing read live from the DuckLake Postgres
 *     store via the N2 DuckDB tier (/api/ducklake/catalog), audited.
 *
 * Azure-native + OSS; no Microsoft Fabric (.claude/rules/no-fabric-dependency.md).
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Badge, Body1, Caption1, Spinner, Subtitle2, makeStyles, tokens,
} from '@fluentui/react-components';
import { Database20Regular, TableSimple20Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { ItemEditorChrome } from './item-editor-chrome';
import { PreviewTable, type PreviewData } from '@/lib/components/shared/preview-table';
import { HonestGate } from '@/lib/components/shared/honest-gate';
import { EmptyState } from '@/lib/components/empty-state';
import { LearnPopover } from '@/lib/components/ui/learn-popover';
import { useRuntimeFlag } from '@/lib/components/ui/use-runtime-flag';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';

/** FLAG0 runtime kill-switch id (registered in lib/admin/runtime-flags.ts). */
export const DUCKLAKE_FLAG_ID = 'n8-ducklake-catalog';

const useStyles = makeStyles({
  pane: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL, minWidth: 0, minHeight: 0, flex: 1,
  },
  toolbar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap', minWidth: 0,
  },
});

interface DucklakeTableRow { schema: string; name: string }
interface DucklakeResponse {
  ok: boolean;
  configured?: boolean;
  catalog?: string;
  tables?: DucklakeTableRow[];
  note?: string;
  unreachable?: string;
  error?: string;
  gate?: { id: string; title?: string; remediation?: string; fixItHref?: string; missing?: string[] };
}

async function fetchCatalog(): Promise<DucklakeResponse> {
  const res = await clientFetch('/api/ducklake/catalog', { cache: 'no-store' });
  const json = (await res.json().catch(() => ({}))) as DucklakeResponse;
  if (!res.ok || json?.ok !== true) {
    throw new Error(json?.error || `Could not read the DuckLake catalog (HTTP ${res.status})`);
  }
  return json;
}

export function DucklakeCatalogEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const enabled = useRuntimeFlag(DUCKLAKE_FLAG_ID);

  const q = useQuery({
    queryKey: ['ducklake-catalog', id],
    queryFn: fetchCatalog,
    staleTime: 30_000,
    enabled,
  });

  const preview: PreviewData | null = useMemo(() => {
    const tables = q.data?.tables;
    if (!tables || tables.length === 0) return null;
    return { columns: ['schema', 'name'], rows: tables.map((t) => [t.schema, t.name]) };
  }, [q.data]);

  if (!enabled) {
    return (
      <ItemEditorChrome item={item} id={id} ribbon={[]} main={
        <div className={s.pane}>
          <EmptyState
            icon={<Database20Regular />}
            title="DuckLake catalog is turned off for this deployment"
            body="An administrator has disabled the DuckLake catalog surface with the n8-ducklake-catalog runtime flag. The Iceberg REST Catalog, the /api/ducklake/** routes and every other editor keep working; turn the flag back on in Admin → Runtime flags to restore this surface."
          />
        </div>
      } />
    );
  }

  const data = q.data;

  return (
    <ItemEditorChrome item={item} id={id} ribbon={[]} main={
      <div className={s.pane}>
        <div className={s.toolbar}>
          <Database20Regular />
          <Subtitle2>DuckLake catalog</Subtitle2>
          <Badge appearance="tint" color="warning" size="small">Preview</Badge>
          {data?.configured && data.catalog && (
            <Badge appearance="outline">{data.catalog}</Badge>
          )}
          <LearnPopover
            title="A SQL-database catalog for the lake"
            content={
              'DuckLake keeps lakehouse table metadata in a Postgres database instead of a metadata-file tree. '
              + 'The DuckDB serving tier ATTACHes it and reads the Delta/Parquet data in place on your own ADLS Gen2. '
              + 'It is a Preview lab offered ALONGSIDE the Iceberg REST Catalog — pick whichever matches your engine '
              + 'mix. Both are Azure-native and OSS; neither needs Microsoft Fabric.'
            }
          />
        </div>

        {q.isLoading && <Spinner size="small" label="Reading the DuckLake catalog…" labelPosition="after" />}

        {/* Honest gate — unconfigured store OR the DuckDB tier missing. Warning,
            not an error, so a freshly opened item is never red (ux-baseline). */}
        {data?.gate && (
          <HonestGate
            gate={data.gate}
            surface="DuckLake catalog"
            onResolved={() => void q.refetch()}
          />
        )}

        {data?.configured && !data.gate && (
          <>
            {data.note && <Caption1>{data.note}</Caption1>}
            {preview ? (
              <PreviewTable
                sources={[{ id: 'ducklake', label: 'Tables', data: preview }]}
                showRefresh={false}
                ariaLabel="DuckLake catalog tables"
              />
            ) : data.unreachable ? (
              <EmptyState
                icon={<TableSimple20Regular />}
                title="The DuckLake catalog did not answer"
                body={data.unreachable}
              />
            ) : (
              <EmptyState
                icon={<TableSimple20Regular />}
                title="No tables in the DuckLake catalog yet"
                body="The catalog is wired and reachable, but has no tables registered. Register a Delta/Parquet table into the DuckLake Postgres store and it will appear here."
              />
            )}
          </>
        )}

        {!q.isLoading && !data && (
          <Body1>Reading the DuckLake catalog…</Body1>
        )}
      </div>
    } />
  );
}

export default DucklakeCatalogEditor;
