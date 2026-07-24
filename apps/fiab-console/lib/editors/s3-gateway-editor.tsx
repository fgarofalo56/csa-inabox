'use client';

/**
 * S3-compatible ADLS gateway editor (N8 lab 3, Preview).
 *
 * Expose an S3 face over ADLS so s3://-native OSS clients connect — via an
 * operator-deployed Apache-2.0 s3proxy (NEVER AGPL MinIO). The surface is honest
 * and useful in every state:
 *   • FLAG0 `n8-s3-gateway` OFF → a guided "turned off" notice.
 *   • Always → the native no-gateway path (N1 Iceberg REST Catalog + abfss://),
 *     which most deployments should use instead of a gateway.
 *   • Unconfigured → the HonestGate Fix-it for LOOM_S3_GATEWAY_URL (warning, not
 *     red on first open).
 *   • Configured → the REAL endpoint + per-engine connect snippets.
 *
 * Azure-native; no Microsoft Fabric (.claude/rules/no-fabric-dependency.md).
 */

import { useQuery } from '@tanstack/react-query';
import {
  Badge, Body1, Caption1, Subtitle2, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { CloudLink20Regular, Link20Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { ItemEditorChrome } from './item-editor-chrome';
import { HonestGate } from '@/lib/components/shared/honest-gate';
import { EmptyState } from '@/lib/components/empty-state';
import { LearnPopover } from '@/lib/components/ui/learn-popover';
import { useRuntimeFlag } from '@/lib/components/ui/use-runtime-flag';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';

/** FLAG0 runtime kill-switch id (registered in lib/admin/runtime-flags.ts). */
export const S3_GATEWAY_FLAG_ID = 'n8-s3-gateway';
/** Gate id — mirrors the ENV_CHECKS spec (client-safe string, no server import). */
const S3_GATEWAY_GATE_ID = 'svc-s3-gateway';

const useStyles = makeStyles({
  pane: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL, minWidth: 0, minHeight: 0, flex: 1,
  },
  toolbar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap', minWidth: 0,
  },
  snippetCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  code: {
    margin: 0,
    padding: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap',
    overflowX: 'auto',
  },
});

interface S3Snippet { engine: string; language: string; snippet: string }
interface S3GatewayResponse {
  ok: boolean;
  configured?: boolean;
  endpoint?: string | null;
  lakeAccount?: string;
  nativePath?: { abfssExample: string; icebergCatalogNote: string };
  snippets?: S3Snippet[];
  gate?: { missing: string[] };
}

async function fetchInfo(): Promise<S3GatewayResponse> {
  const res = await clientFetch('/api/s3-gateway/info', { cache: 'no-store' });
  const json = (await res.json().catch(() => ({}))) as S3GatewayResponse;
  if (!res.ok || json?.ok !== true) {
    throw new Error(`Could not read the S3 gateway config (HTTP ${res.status})`);
  }
  return json;
}

export function S3GatewayEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const enabled = useRuntimeFlag(S3_GATEWAY_FLAG_ID);

  const q = useQuery({
    queryKey: ['s3-gateway-info', id],
    queryFn: fetchInfo,
    staleTime: 30_000,
    enabled,
  });

  if (!enabled) {
    return (
      <ItemEditorChrome item={item} id={id} ribbon={[]} main={
        <div className={s.pane}>
          <EmptyState
            icon={<CloudLink20Regular />}
            title="S3-compatible gateway is turned off for this deployment"
            body="An administrator has disabled the S3 gateway surface with the n8-s3-gateway runtime flag. The Iceberg REST Catalog and native abfss:// path keep working; turn the flag back on in Admin → Runtime flags to restore this surface."
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
          <CloudLink20Regular />
          <Subtitle2>S3-compatible ADLS gateway</Subtitle2>
          <Badge appearance="tint" color="warning" size="small">Preview</Badge>
          {data?.configured && <Badge appearance="tint" color="success" size="small">endpoint set</Badge>}
          <LearnPopover
            title="Most engines need no gateway"
            content={
              'An S3 gateway lets s3://-only OSS clients address your ADLS Gen2 through an S3 API, via an operator-'
              + 'deployed Apache-2.0 s3proxy (the AGPL MinIO gateway path is not used). But most engines — Trino, Spark, '
              + 'DuckDB, Snowflake — should instead use the Iceberg REST Catalog + native abfss:// path, which is '
              + 'governed and audited. Deploy a gateway only for clients that speak S3 exclusively.'
            }
          />
        </div>

        {q.isLoading && <Spinner size="small" label="Reading gateway config…" labelPosition="after" />}

        {/* The native no-gateway path — always shown; it is the recommended default. */}
        {data?.nativePath && (
          <MessageBar intent="info" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>No gateway required for most engines</MessageBarTitle>
              {data.nativePath.icebergCatalogNote}
              <div><Caption1>Native path example: <code>{data.nativePath.abfssExample}</code></Caption1></div>
            </MessageBarBody>
          </MessageBar>
        )}

        {/* Honest gate for the optional gateway endpoint (warning, never red). */}
        {data?.gate && (
          <HonestGate
            gateId={S3_GATEWAY_GATE_ID}
            missing={data.gate.missing}
            surface="S3-compatible ADLS gateway"
            onResolved={() => void q.refetch()}
          />
        )}

        {data?.configured && data.endpoint && (
          <>
            <Body1>Gateway endpoint: <code>{data.endpoint}</code></Body1>
            {(data.snippets || []).map((sn) => (
              <div key={sn.engine} className={s.snippetCard}>
                <div className={s.toolbar}>
                  <Link20Regular />
                  <Subtitle2>{sn.engine}</Subtitle2>
                  <Badge appearance="outline" size="small">{sn.language}</Badge>
                </div>
                <pre className={s.code}>{sn.snippet}</pre>
              </div>
            ))}
          </>
        )}

        {data && !data.configured && !q.isLoading && (
          <EmptyState
            icon={<Link20Regular />}
            title="No S3 gateway wired — and most deployments don't need one"
            body="Prefer the native path above (Iceberg REST Catalog + abfss://). If you have s3://-exclusive clients, deploy an Apache-2.0 s3proxy in front of ADLS and set LOOM_S3_GATEWAY_URL with the Fix-it above to get real connect snippets here."
          />
        )}
      </div>
    } />
  );
}

export default S3GatewayEditor;
