'use client';

/**
 * N3 — the shared **Connect** tab: "how do I read this from my own tools?"
 *
 * Rendered by the lakehouse (alongside N1's Interop tab), the warehouse, and
 * SQL Lab. It hands an analyst everything needed to point ADBC / Flight SQL /
 * JDBC at Loom's serving tier and get Arrow RecordBatches instead of row-by-row
 * ODBC serialization:
 *
 *   • the real endpoint and its honest EXPOSURE (published, in-VNet only, or
 *     not deployed — the internal container FQDN is never printed, because it
 *     would not resolve for the reader);
 *   • a **Generate ticket** button that mints a short-lived, Entra-scoped ticket
 *     through the audited BFF route, shows its expiry, and copies it — the
 *     ticket is the only credential in the flow and it lives for minutes;
 *   • copy-paste snippets per client that read the ticket from the reader's OWN
 *     environment variable, so nothing secret is ever rendered or screenshotted.
 *
 * Read-only surface: it issues a credential and prints code. It cannot change
 * the endpoint, the engine, or anyone's access.
 */

import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Badge, Body1, Button, Caption1, Spinner, Subtitle2, Tab, TabList, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, Copy20Regular, Key20Regular, PlugConnected20Regular,
  ShieldCheckmark20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
import { LearnPopover } from '@/lib/components/ui/learn-popover';

const useStyles = makeStyles({
  root: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL,
    flex: 1, minHeight: 0, minWidth: 0,
  },
  head: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap', minWidth: 0,
  },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    paddingTop: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    minWidth: 0,
  },
  kv: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap', minWidth: 0,
  },
  mono: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0,
  },
  code: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM,
    overflowX: 'auto',
    whiteSpace: 'pre',
    minWidth: 0,
    margin: 0,
  },
});

interface ConnectSnippet {
  id: string;
  label: string;
  language: string;
  note: string;
  code: string;
}

interface ConnectPayload {
  ok: true;
  endpoint: { uri: string; exposure: 'published' | 'in-vnet' | 'not-deployed'; note: string };
  ticketMintUrl: string;
  snippets: ConnectSnippet[];
  arrowThreshold: number;
  loomTransportNote: string;
}

interface MintedTicket {
  ticket: string;
  ticketId: string;
  expiresAt: string;
  ttlSeconds: number;
  signed: boolean;
  signingNote?: string;
}

async function fetchConnect(sampleSql?: string): Promise<ConnectPayload> {
  const qs = sampleSql ? `?sql=${encodeURIComponent(sampleSql.slice(0, 500))}` : '';
  const res = await clientFetch(`/api/flightsql/connect${qs}`, { cache: 'no-store' });
  const json = (await res.json().catch(() => ({}))) as ConnectPayload & { error?: string };
  if (!res.ok || json?.ok !== true) {
    throw new Error(json?.error || `Could not load connection details (HTTP ${res.status})`);
  }
  return json;
}

const EXPOSURE_BADGE: Record<ConnectPayload['endpoint']['exposure'], { label: string; color: 'success' | 'informative' | 'warning' }> = {
  published: { label: 'Published', color: 'success' },
  'in-vnet': { label: 'In-VNet only', color: 'informative' },
  'not-deployed': { label: 'Not deployed', color: 'warning' },
};

export interface ConnectTabProps {
  /** Human name of the surface hosting the tab (used in the ticket scope + copy). */
  surface: string;
  /** An example statement so the snippets are runnable as pasted. */
  sampleSql?: string;
  /** Scope hints recorded on the minted ticket (abfss:// prefixes, item ids). */
  scope?: string[];
  /** Item id the mint is attributed to in the audit row. */
  itemId?: string;
}

export function ConnectTab({ surface, sampleSql, scope, itemId }: ConnectTabProps) {
  const s = useStyles();
  const [client, setClient] = useState<string>('curl-ticket');
  const [ticket, setTicket] = useState<MintedTicket | null>(null);
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const connectQ = useQuery({
    queryKey: ['flightsql-connect', sampleSql || ''],
    queryFn: () => fetchConnect(sampleSql),
    staleTime: 60_000,
  });

  const copy = useCallback((text: string, what: string) => {
    try {
      void navigator.clipboard?.writeText(text);
      setCopied(what);
    } catch {
      /* clipboard unavailable in this context */
    }
  }, []);

  const mint = useCallback(async () => {
    setMinting(true);
    setMintError(null);
    try {
      const res = await clientFetch('/api/flightsql/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ttlSeconds: 300, scope: scope || [], itemId }),
      });
      const json = (await res.json().catch(() => ({}))) as MintedTicket & { ok?: boolean; error?: string };
      if (!res.ok || json?.ok !== true) {
        throw new Error(json?.error || `Could not mint a Flight ticket (HTTP ${res.status})`);
      }
      setTicket(json);
      copy(json.ticket, 'ticket');
    } catch (e) {
      setMintError(e instanceof Error ? e.message : String(e));
    } finally {
      setMinting(false);
    }
  }, [copy, itemId, scope]);

  if (connectQ.isLoading) {
    return <Spinner size="small" label="Loading connection details…" labelPosition="after" />;
  }

  if (connectQ.error) {
    return (
      <MessageBar intent="error" layout="multiline">
        <MessageBarBody>
          <MessageBarTitle>Connection details unavailable</MessageBarTitle>
          {(connectQ.error as Error).message}
        </MessageBarBody>
      </MessageBar>
    );
  }

  const data = connectQ.data;
  if (!data) {
    return (
      <EmptyState
        icon={<PlugConnected20Regular />}
        title="Nothing to connect to yet"
        body="Connection details load from the Flight SQL wire. Refresh to try again."
      />
    );
  }

  const exposure = EXPOSURE_BADGE[data.endpoint.exposure];
  const active = data.snippets.find((sn) => sn.id === client) || data.snippets[0];

  return (
    <div className={s.root}>
      <div className={s.head}>
        <PlugConnected20Regular />
        <Subtitle2>Connect — read {surface} from your own tools</Subtitle2>
        <LearnPopover
          title="Arrow Flight SQL + ADBC"
          content={
            'ODBC and JDBC spend most of a large transfer serializing rows one at a time. Flight SQL '
            + 'streams the same Arrow RecordBatches the engine already produced, over gRPC/HTTP2 — no '
            + 're-encode, no row conversion. Loom serves that wire off the same embedded DuckDB process '
            + 'that answers the console, so an ADBC client and a Loom grid read identical batches. '
            + 'Access is a short-lived ticket you mint here from your own sign-in; every ticket and '
            + 'every redemption is written to the audit trail. No Microsoft Fabric or Power BI is involved.'
          }
        />
        <Button
          appearance="subtle"
          icon={<ArrowSync20Regular />}
          onClick={() => void connectQ.refetch()}
          disabled={connectQ.isFetching}
        >
          Refresh
        </Button>
      </div>

      {/* Endpoint card — honest about what the reader can actually reach. */}
      <div className={s.card}>
        <div className={s.kv}>
          <Subtitle2>Flight SQL endpoint</Subtitle2>
          <Badge appearance="filled" color={exposure.color}>{exposure.label}</Badge>
        </div>
        {data.endpoint.uri ? (
          <div className={s.kv}>
            <span className={s.mono}>{data.endpoint.uri}</span>
            <Tooltip content="Copy endpoint" relationship="label">
              <Button
                appearance="subtle"
                size="small"
                icon={<Copy20Regular />}
                aria-label="Copy Flight SQL endpoint"
                onClick={() => copy(data.endpoint.uri, 'endpoint')}
              />
            </Tooltip>
          </div>
        ) : null}
        <Caption1>{data.endpoint.note}</Caption1>
        <Caption1>{data.loomTransportNote}</Caption1>
      </div>

      {/* Ticket card — the ONE credential, minted on demand, minutes long. */}
      <div className={s.card}>
        <div className={s.kv}>
          <ShieldCheckmark20Regular />
          <Subtitle2>Your access ticket</Subtitle2>
          {ticket && <Badge appearance="tint" color={ticket.signed ? 'success' : 'informative'}>
            {ticket.signed ? 'Signed' : 'In-VNet trust'}
          </Badge>}
        </div>
        <Body1>
          Tickets are minted from your Loom sign-in, scoped to you, and expire in minutes. Nothing
          long-lived is ever issued — mint a fresh one whenever a client says the ticket expired.
        </Body1>
        <div className={s.kv}>
          <Button
            appearance="primary"
            icon={minting ? <Spinner size="tiny" /> : <Key20Regular />}
            disabled={minting}
            onClick={() => void mint()}
          >
            Generate ticket
          </Button>
          {ticket && (
            <>
              <Badge appearance="outline">expires {new Date(ticket.expiresAt).toLocaleTimeString()}</Badge>
              <Badge appearance="outline">ticket {ticket.ticketId.slice(0, 8)}</Badge>
              <Caption1>
                {copied === 'ticket'
                  ? 'Copied to your clipboard — paste it into LOOM_FLIGHT_TICKET.'
                  : 'Copied on generate; re-generate to copy again.'}
              </Caption1>
            </>
          )}
        </div>
        {ticket?.signingNote && (
          <MessageBar intent="info" layout="multiline">
            <MessageBarBody>{ticket.signingNote}</MessageBarBody>
          </MessageBar>
        )}
        {mintError && (
          <MessageBar intent="error" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>Could not mint a ticket</MessageBarTitle>
              {mintError}
            </MessageBarBody>
          </MessageBar>
        )}
      </div>

      {/* Snippets — never a secret, never an internal host. */}
      <div className={s.card}>
        <div className={s.kv}>
          <Subtitle2>Client snippets</Subtitle2>
          <Badge appearance="outline">Arrow past {data.arrowThreshold.toLocaleString()} rows</Badge>
        </div>
        <TabList selectedValue={active?.id} onTabSelect={(_, d) => setClient(d.value as string)}>
          {data.snippets.map((sn) => <Tab key={sn.id} value={sn.id}>{sn.label}</Tab>)}
        </TabList>
        {active && (
          <>
            <div className={s.kv}>
              <Caption1>{active.note}</Caption1>
              <Tooltip content="Copy snippet" relationship="label">
                <Button
                  appearance="subtle"
                  size="small"
                  icon={<Copy20Regular />}
                  aria-label={`Copy ${active.label} snippet`}
                  onClick={() => copy(active.code, active.id)}
                >
                  Copy
                </Button>
              </Tooltip>
            </div>
            <pre className={s.code}>{active.code}</pre>
          </>
        )}
      </div>
    </div>
  );
}

export default ConnectTab;
