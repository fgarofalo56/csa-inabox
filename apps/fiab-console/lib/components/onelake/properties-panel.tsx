'use client';

/**
 * PropertiesPanel — the OneLake item "Properties" surface, one-for-one with
 * the Microsoft Fabric item Properties pane (Paths + Connect), themed in
 * Fluent v9 + Loom tokens.
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ <name> · <type>                          [✕]  │
 *   ├──────────────────────────────────────────────┤
 *   │ [ Paths ] [ Connect ]                          │
 *   │ Paths:    DFS / Blob / ABFS / GUID rows + copy │
 *   │ Connect:  .NET / Python / AzCopy snippets +    │
 *   │           BlobFuse2 / Storage Explorer card    │
 *   └──────────────────────────────────────────────┘
 *
 * REAL data: GET /api/onelake/paths?container=&itemPath=&workspaceGuid=&itemGuid=
 * resolves the storage account server-side and returns the four URI forms for
 * the active sovereign cloud (Commercial → *.core.windows.net; Gov →
 * *.core.usgovcloudapi.net). No mock data; honest 503 gate when the DLZ
 * storage account isn't wired (route names LOOM_BRONZE_URL).
 */

import { useEffect, useState, type ReactElement } from 'react';
import {
  Spinner,
  Text,
  Caption1,
  Title3,
  Button,
  Tooltip,
  TabList,
  Tab,
  Badge,
  Link,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  Dismiss20Regular,
  Copy16Regular,
  Checkmark16Regular,
  Info16Regular,
  Open16Regular,
} from '@fluentui/react-icons';

export interface PropertiesPanelProps {
  /** Container — the OneLake "workspace" equivalent (e.g. "bronze" / workspace name). */
  container: string;
  /** Path within the container (e.g. "sales.lakehouse/Tables/orders"). */
  itemPath: string;
  /** Optional workspace GUID (enables the GUID URI row). */
  workspaceGuid?: string;
  /** Optional item GUID (enables the GUID URI row). */
  itemGuid?: string;
  itemName?: string;
  itemType?: string;
  onClose?: () => void;
}

interface OneLakePaths {
  dfs: string;
  blob: string;
  abfs: string;
  guid: string | null;
}
interface PathsResponse {
  ok: boolean;
  account?: string;
  cloud?: string;
  paths?: OneLakePaths;
  error?: string;
  envVar?: string;
}

const useStyles = makeStyles({
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  head: { display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalM },
  titleWrap: { minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: '2px' },
  title: { margin: 0, lineHeight: 1.25 },
  closeBtn: { flexShrink: 0 },

  // ── Paths tab: key / value / copy grid ──
  pathGrid: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    columnGap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalS,
    alignItems: 'center',
  },
  pathKey: {
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightMedium,
    whiteSpace: 'nowrap',
  },
  pathVal: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    paddingTop: '4px',
    paddingBottom: '4px',
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    overflowWrap: 'anywhere',
  },
  pathValMuted: { color: tokens.colorNeutralForeground3 },

  // ── Connect tab: code snippets ──
  snippetWrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  snippet: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  snippetHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
  },
  code: {
    margin: 0,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase300,
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingHorizontalM,
    overflowX: 'auto',
    whiteSpace: 'pre',
  },
  cardCode: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    overflowWrap: 'anywhere',
  },
  cardLinks: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', marginTop: tokens.spacingVerticalXS },
});

/** Copy button that flips to a checkmark for ~1.4s after a successful copy. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  const disabled = !value;
  return (
    <Tooltip content={done ? 'Copied' : label} relationship="label">
      <Button
        size="small"
        appearance="subtle"
        disabled={disabled}
        icon={done ? <Checkmark16Regular /> : <Copy16Regular />}
        aria-label={label}
        onClick={() => {
          if (!value) return;
          navigator.clipboard
            .writeText(value)
            .then(() => {
              setDone(true);
              setTimeout(() => setDone(false), 1400);
            })
            .catch(() => {});
        }}
      />
    </Tooltip>
  );
}

function CodeSnippet({ title, code }: { title: string; code: string }) {
  const styles = useStyles();
  return (
    <div className={styles.snippet}>
      <div className={styles.snippetHead}>
        <Text weight="semibold" size={300}>{title}</Text>
        <CopyButton value={code} label={`Copy ${title} snippet`} />
      </div>
      <pre className={styles.code}>{code}</pre>
    </div>
  );
}

/** Split a DFS URL "https://{account}.{suffix}/…" into account + suffix. */
function splitDfs(dfsUrl: string): { account: string; suffix: string } {
  const m = dfsUrl.match(/^https:\/\/([^.]+)\.([^/]+)/i);
  return m ? { account: m[1], suffix: m[2] } : { account: 'account', suffix: 'dfs.core.windows.net' };
}

export function PropertiesPanel({
  container,
  itemPath,
  workspaceGuid,
  itemGuid,
  itemName,
  itemType,
  onClose,
}: PropertiesPanelProps): ReactElement {
  const styles = useStyles();
  const [tab, setTab] = useState<'paths' | 'connect'>('paths');
  const [data, setData] = useState<PathsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
    const qs = new URLSearchParams({ container, itemPath });
    if (workspaceGuid) qs.set('workspaceGuid', workspaceGuid);
    if (itemGuid) qs.set('itemGuid', itemGuid);
    fetch(`/api/onelake/paths?${qs.toString()}`)
      .then((r) => r.json().then((j) => ({ status: r.status, j })))
      .then(({ j }) => { if (!cancelled) { setData(j as PathsResponse); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setData({ ok: false, error: e?.message || 'request failed' }); setLoading(false); } });
    return () => { cancelled = true; };
  }, [container, itemPath, workspaceGuid, itemGuid]);

  const paths = data?.ok ? data.paths : undefined;
  const { account, suffix } = paths ? splitDfs(paths.dfs) : { account: 'account', suffix: 'dfs.core.windows.net' };

  const dotnet = `// dotnet add package Azure.Storage.Files.DataLake Azure.Identity
using Azure.Identity;
using Azure.Storage.Files.DataLake;

var service = new DataLakeServiceClient(
    new Uri("https://${account}.${suffix}"),
    new DefaultAzureCredential());
var fs = service.GetFileSystemClient("${container}");
var file = fs.GetFileClient("${itemPath}");
// file.ReadAsync() / file.Upload(...) — Storage Blob Data Reader/Contributor required`;

  const python = `# pip install azure-storage-file-datalake azure-identity
from azure.storage.filedatalake import DataLakeServiceClient
from azure.identity import DefaultAzureCredential

service = DataLakeServiceClient(
    account_url="https://${account}.${suffix}",
    credential=DefaultAzureCredential())
fs = service.get_file_system_client("${container}")
file = fs.get_file_client("${itemPath}")
# file.download_file().readall()`;

  const azcopy = `# Sign in once (AAD), then copy down the path:
azcopy login
azcopy copy \\
  "${paths?.dfs ?? `https://${account}.${suffix}/${container}/${itemPath}`}" \\
  "./local-destination/" \\
  --recursive`;

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <span className={styles.titleWrap}>
          <Title3 className={styles.title} title={itemName}>{itemName ?? 'Properties'}</Title3>
          {itemType && <Caption1>{itemType}</Caption1>}
        </span>
        {onClose && (
          <Tooltip content="Close" relationship="label">
            <Button
              className={styles.closeBtn}
              appearance="subtle"
              icon={<Dismiss20Regular />}
              aria-label="Close properties"
              onClick={onClose}
            />
          </Tooltip>
        )}
      </div>

      <TabList selectedValue={tab} onTabSelect={(_e, d) => setTab(d.value as 'paths' | 'connect')} size="small">
        <Tab value="paths">Paths</Tab>
        <Tab value="connect">Connect</Tab>
      </TabList>

      {loading && <Spinner size="tiny" label="Resolving OneLake paths…" />}

      {!loading && data && !data.ok && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>OneLake addressing not available</MessageBarTitle>
            {data.error}
          </MessageBarBody>
        </MessageBar>
      )}

      {!loading && paths && tab === 'paths' && (
        <>
          {data?.cloud && (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              Cloud: <Badge appearance="tint" size="small">{data.cloud}</Badge>
            </Caption1>
          )}
          <div className={styles.pathGrid}>
            <span className={styles.pathKey}>DFS URL</span>
            <span className={styles.pathVal}>{paths.dfs}</span>
            <CopyButton value={paths.dfs} label="Copy DFS URL" />

            <span className={styles.pathKey}>Blob URL</span>
            <span className={styles.pathVal}>{paths.blob}</span>
            <CopyButton value={paths.blob} label="Copy Blob URL" />

            <span className={styles.pathKey}>ABFS path</span>
            <span className={styles.pathVal}>{paths.abfs}</span>
            <CopyButton value={paths.abfs} label="Copy ABFS path" />

            <span className={styles.pathKey}>GUID URL</span>
            <span className={paths.guid ? styles.pathVal : `${styles.pathVal} ${styles.pathValMuted}`}>
              {paths.guid ?? '— (no workspace/item GUID on this record)'}
            </span>
            <CopyButton value={paths.guid ?? ''} label="Copy GUID URL" />
          </div>
        </>
      )}

      {!loading && paths && tab === 'connect' && (
        <div className={styles.snippetWrap}>
          <CodeSnippet title=".NET (Azure.Storage.Files.DataLake)" code={dotnet} />
          <CodeSnippet title="Python (azure-storage-file-datalake)" code={python} />
          <CodeSnippet title="AzCopy" code={azcopy} />

          {/* F19 desktop gate — honest doc card (no in-browser mount). */}
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>Mount with BlobFuse2 or Azure Storage Explorer (F19)</MessageBarTitle>
              BlobFuse2 (Linux) and Azure Storage Explorer (desktop) mount the ABFS path directly —
              these are desktop tools and cannot run in the browser. Use the ABFS path:
              <div className={styles.cardCode}>{paths.abfs}</div>
              <div className={styles.cardLinks}>
                <Link href="https://learn.microsoft.com/azure/storage/blobs/blobfuse2-what-is" target="_blank" rel="noreferrer">
                  <Open16Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS }} />BlobFuse2 docs
                </Link>
                <Link href="https://learn.microsoft.com/azure/storage/storage-explorer/vs-azure-tools-storage-manage-with-storage-explorer" target="_blank" rel="noreferrer">
                  <Open16Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS }} />Azure Storage Explorer
                </Link>
                <Link href="https://learn.microsoft.com/azure/storage/common/storage-use-azcopy-v10" target="_blank" rel="noreferrer">
                  <Open16Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS }} />Get AzCopy
                </Link>
              </div>
            </MessageBarBody>
          </MessageBar>
        </div>
      )}
    </div>
  );
}

export default PropertiesPanel;
