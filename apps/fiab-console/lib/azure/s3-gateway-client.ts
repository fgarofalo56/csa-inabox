/**
 * N8 lab 3 — S3-compatible ADLS gateway client (Preview). SERVER-ONLY.
 *
 * ## The lab (and why it is thin)
 *
 * The goal: let s3://-native OSS clients (Trino, Spark, DuckDB's s3 extension)
 * address the deployment's ADLS Gen2 through an S3 API. The obvious MinIO
 * gateway path is **dropped** — MinIO's gateway is deprecated AND AGPL (banned
 * by LIC0). The permissive path is an operator-deployed **Apache-2.0 s3proxy**
 * placed in front of ADLS; Loom does not bundle it (nothing new in
 * package.json — no AGPL, no s3proxy dependency in the console image).
 *
 * Crucially, most deployments need NO gateway: N1's Iceberg REST Catalog
 * (`LOOM_ICEBERG_CATALOG_URL`) plus the native abfss:// path already give
 * external engines governed, audited access to the same data. This client is a
 * thin, HONEST config surface: unset → {@link s3GatewayInfo} reports the gate
 * and points at the IRC/ADLS path; set → it returns the real endpoint + connect
 * snippets built from the configured value. It never fabricates a live gateway.
 *
 * IL5 / SOVEREIGN MOAT: s3proxy is Apache-2.0 and runs in-boundary on the
 * deployment's own Container Apps environment over its own ADLS Gen2 — no AGPL
 * MinIO and no SaaS object gateway in the path, so an air-gapped enclave can
 * still expose an S3 face. No Microsoft Fabric (.claude/rules/no-fabric-dependency.md).
 */

import { dfsSuffix } from '@/lib/azure/cloud-endpoints';

/** Registry gate id — mirrors the ENV_CHECKS spec in env-checks/data-plane.ts. */
export const S3_GATEWAY_GATE_ID = 'svc-s3-gateway';

/** Honest config gate — the missing env var, or null when the gateway is set. */
export function s3GatewayConfigGate(): { missing: string } | null {
  return (process.env.LOOM_S3_GATEWAY_URL || '').trim() ? null : { missing: 'LOOM_S3_GATEWAY_URL' };
}

/** True when an S3-compatible gateway endpoint is configured. */
export function isS3GatewayConfigured(): boolean {
  return s3GatewayConfigGate() === null;
}

/** Normalized gateway base URL (scheme-normalized, no trailing slash). */
export function s3GatewayBase(): string {
  const raw = (process.env.LOOM_S3_GATEWAY_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/** The ADLS account the gateway fronts (from the already-emitted lake var). */
function lakeAccount(): string {
  return (process.env.LOOM_ADLS_ACCOUNT || '').trim();
}

/** A copy-paste connect snippet for one S3-speaking OSS engine. */
export interface S3ConnectSnippet {
  engine: string;
  language: 'ini' | 'sql' | 'bash';
  snippet: string;
}

/** The connect-info payload the editor renders. Honest about the gate state. */
export interface S3GatewayInfo {
  configured: boolean;
  endpoint: string | null;
  /** The ADLS account the gateway is expected to front (may be empty). */
  lakeAccount: string;
  /** The native, no-gateway alternative every deployment already has. */
  nativePath: {
    abfssExample: string;
    icebergCatalogNote: string;
  };
  snippets: S3ConnectSnippet[];
  gate?: { missing: string[] };
}

/**
 * Build the connect info for the S3 gateway surface. REAL values only: the
 * endpoint comes from the configured env var; the native abfss:// example is
 * derived from the deployment's own lake account + sovereign DFS suffix. When
 * the gateway is unset the payload carries the gate and STILL renders the
 * native path (no-vaporware: the surface is useful either way).
 */
export function s3GatewayInfo(): S3GatewayInfo {
  const endpoint = isS3GatewayConfigured() ? s3GatewayBase() : null;
  const account = lakeAccount();
  const abfssExample = account
    ? `abfss://<container>@${account}.${dfsSuffix()}/<path>`
    : `abfss://<container>@<adls-account>.${dfsSuffix()}/<path>`;

  const snippets: S3ConnectSnippet[] = endpoint
    ? [
      {
        engine: 'DuckDB (s3 extension)',
        language: 'sql',
        snippet: [
          "INSTALL httpfs; LOAD httpfs;",
          `SET s3_endpoint='${endpoint.replace(/^https?:\/\//, '')}';`,
          "SET s3_use_ssl=true; SET s3_url_style='path';",
          "-- credentials: use the scoped key your s3proxy is configured with",
          "SELECT * FROM read_parquet('s3://<bucket>/<path>/*.parquet') LIMIT 100;",
        ].join('\n'),
      },
      {
        engine: 'Trino (hive/iceberg connector)',
        language: 'ini',
        snippet: [
          `hive.s3.endpoint=${endpoint}`,
          'hive.s3.path-style-access=true',
          '# point the catalog at s3://<bucket> mapped to your ADLS container',
        ].join('\n'),
      },
    ]
    : [];

  return {
    configured: !!endpoint,
    endpoint,
    lakeAccount: account,
    nativePath: {
      abfssExample,
      icebergCatalogNote:
        'Most engines do not need an S3 gateway: point them at the N1 Iceberg REST Catalog '
        + '(LOOM_ICEBERG_CATALOG_URL) and read the lake over the native abfss:// path — governed and audited through '
        + 'the Loom proxy. Deploy an S3 gateway only for clients that speak S3 exclusively.',
    },
    snippets,
    gate: isS3GatewayConfigured() ? undefined : { missing: ['LOOM_S3_GATEWAY_URL'] },
  };
}
