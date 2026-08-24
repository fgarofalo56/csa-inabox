'use client';

/**
 * LOOM BRAIN VISUALIZER — the node details panel.
 *
 * Click a node, get its EVIDENCE. Not a property sheet — an argument: what was
 * measured, which wires point at it, which wires tried and failed, what that
 * costs, and what the code could NOT establish.
 *
 * ── THE THREE PLACES THIS PANEL REFUSES TO ROUND OFF ───────────────────────
 *   1. `scaleMeasured === false` renders "NOT MEASURED", never "0 replicas".
 *      An unmeasured scale silently exonerates a resource if it is displayed
 *      as zero — that is R7's cheapest failure and the reason `ScaleFacts` is
 *      optional in the substrate at all.
 *   2. `tags === null` renders "could not be read", never "no tags". The
 *      difference is between "this resource is unowned" and "I do not know who
 *      owns this", and a cleanup recommendation must never confuse them.
 *   3. A derived cost is rendered through `costLabel`, which comes from
 *      `formatCostFigure` on the server and always carries "DERIVED estimate —
 *      not a bill". No component here interpolates `amountUsd` bare.
 */

import * as React from 'react';
import {
  Badge,
  Body1,
  Body1Strong,
  Caption1,
  Divider,
  MessageBar,
  MessageBarBody,
  Subtitle2,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { BrainSnapshot, WireEdge, WireFinding, WireNode } from '@/app/api/admin/brain/_lib/wire';
import { nodeVisual } from './model';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    minWidth: 0,
    padding: tokens.spacingVerticalM,
    overflowY: 'auto',
    height: '100%',
  },
  head: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  badges: {
    display: 'flex',
    // web3-ui / ux-baseline: a badge row must wrap and truncate, never overlap.
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
  },
  kv: { display: 'grid', gridTemplateColumns: 'minmax(0, 40%) minmax(0, 1fr)', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  key: { color: tokens.colorNeutralForeground3, minWidth: 0 },
  val: { minWidth: 0, overflowWrap: 'anywhere' },
  mono: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    minWidth: 0,
    overflowWrap: 'anywhere',
  },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
});

function truncateId(id: string): string {
  return id.length > 64 ? `${id.slice(0, 30)}…${id.slice(-30)}` : id;
}

export interface NodeDetailsProps {
  readonly node: WireNode;
  readonly snapshot: BrainSnapshot;
}

export function NodeDetails({ node, snapshot }: NodeDetailsProps) {
  const s = useStyles();
  const v = nodeVisual(node, snapshot.coverage.configured.collected);

  const inbound = React.useMemo(
    () => snapshot.edges.filter((e) => e.resolution === 'resolved' && e.to === node.id),
    [snapshot.edges, node.id],
  );
  const outbound = React.useMemo(
    () => snapshot.edges.filter((e) => e.resolution === 'resolved' && e.from === node.id),
    [snapshot.edges, node.id],
  );
  const danglingFor = React.useMemo(
    () => snapshot.edges.filter((e) => e.resolution === 'dangling' && e.intendedTo === node.id),
    [snapshot.edges, node.id],
  );
  const findings = React.useMemo(
    () => snapshot.findings.filter((f) => f.subjects.includes(node.id)),
    [snapshot.findings, node.id],
  );

  return (
    <div className={s.root} data-testid="node-details" data-brain-detail-state={v.state}>
      <div className={s.head}>
        <Subtitle2>{node.displayName}</Subtitle2>
        <Caption1>{node.resourceType ?? node.kind}</Caption1>
        <div className={s.badges}>
          <Badge appearance="tint" color={v.error ? 'danger' : v.status === 'warning' ? 'warning' : 'informative'}>
            {v.state}
          </Badge>
          {node.ownershipConfirmed ? (
            <Badge appearance="tint" color="success">owned</Badge>
          ) : (
            <Badge appearance="tint" color="subtle">ownership not established</Badge>
          )}
          {node.provisioningState && (
            <Badge appearance="outline">{node.provisioningState}</Badge>
          )}
        </div>
        <Caption1>{v.reason}</Caption1>
      </div>

      <Divider />

      <div className={s.section}>
        <Body1Strong>Measured facts</Body1Strong>
        <div className={s.kv}>
          <Caption1 className={s.key}>Scale</Caption1>
          <Body1 className={s.val}>
            {node.scaleMeasured && node.scale ? (
              <>
                minReplicas {node.scale.minReplicas}
                {node.scale.maxReplicas !== undefined && ` · max ${node.scale.maxReplicas}`}
                {node.scale.cpu !== undefined && ` · ${node.scale.cpu} vCPU`}
                {node.scale.memory !== undefined && ` · ${node.scale.memory}`}
                <Caption1> (source: {node.scale.source})</Caption1>
              </>
            ) : (
              // NOT "0 replicas". See the doc-block, point 1.
              <em>NOT MEASURED — Resource Graph returned no scale block. This is indeterminate, not zero.</em>
            )}
          </Body1>

          <Caption1 className={s.key}>Ingress</Caption1>
          <Body1 className={s.val}>
            {node.ingress ? (
              <>
                {node.ingress.external ? 'external' : 'internal'}
                {node.ingress.fqdn ? ` · ${node.ingress.fqdn}` : ' · no FQDN'}
                {node.ingress.targetPort !== undefined && ` · port ${node.ingress.targetPort}`}
                {!node.ingress.external && node.ingress.fqdn && (
                  <Caption1> — addressable only from inside the environment</Caption1>
                )}
              </>
            ) : (
              <em>NOT MEASURED</em>
            )}
          </Body1>

          <Caption1 className={s.key}>Resource group</Caption1>
          <Body1 className={s.val}>{node.resourceGroup ?? '—'}</Body1>

          <Caption1 className={s.key}>Location</Caption1>
          <Body1 className={s.val}>{node.location ?? '—'}</Body1>

          <Caption1 className={s.key}>Tags</Caption1>
          <Body1 className={s.val}>
            {node.tags === null ? (
              // NOT "no tags". See the doc-block, point 2.
              <em>
                could NOT be read{node.tagsError ? ` (${node.tagsError})` : ''} — indeterminate,
                which is not the same as untagged
              </em>
            ) : Object.keys(node.tags).length === 0 ? (
              <em>read, and empty</em>
            ) : (
              <span className={s.mono}>
                {Object.entries(node.tags)
                  .map(([k, val]) => `${k}=${val}`)
                  .join('  ')}
              </span>
            )}
          </Body1>
        </div>
      </div>

      <Divider />

      <div className={s.section}>
        <Body1Strong>Inbound edges (resolved only)</Body1Strong>
        <Caption1>
          Dangling wires are excluded here by construction — their target is null, which is exactly
          what stops a broken wire counting as reachability.
        </Caption1>
        <div className={s.badges}>
          {(Object.entries(node.inboundByProvenance) as [string, number][]).map(([p, n]) => (
            <Badge
              key={p}
              appearance={n > 0 ? 'filled' : 'outline'}
              color={n > 0 ? 'informative' : 'subtle'}
              data-inbound-provenance={p}
              data-inbound-count={String(n)}
            >
              {p}: {n}
            </Badge>
          ))}
        </div>
        {inbound.length > 0 && <EdgeTable edges={inbound} caption="from" />}
      </div>

      {danglingFor.length > 0 && (
        <>
          <Divider />
          <div className={s.section}>
            <Body1Strong>Wires that were MEANT to reach this node and resolve to nothing</Body1Strong>
            <MessageBar intent="error" data-testid="dangling-evidence">
              <MessageBarBody>
                {danglingFor.length} wire(s) name this service and carry a value that points
                nowhere. This is the evidence chain: something tried to connect it and shipped
                a broken value.
              </MessageBarBody>
            </MessageBar>
            <EdgeTable edges={danglingFor} caption="from" showEvidence />
          </div>
        </>
      )}

      {outbound.length > 0 && (
        <>
          <Divider />
          <div className={s.section}>
            <Body1Strong>Outbound edges ({outbound.length})</Body1Strong>
            <EdgeTable edges={outbound} caption="to" />
          </div>
        </>
      )}

      <Divider />

      <div className={s.section}>
        <Body1Strong>Findings ({findings.length})</Body1Strong>
        {findings.length === 0 ? (
          <Caption1>
            No detector flagged this node. Note what that does and does not mean: the detectors
            that ran are listed under Coverage, and the ones that declined are named there too.
          </Caption1>
        ) : (
          findings.map((f) => <FindingSummary key={f.id} finding={f} />)
        )}
      </div>
    </div>
  );
}

function EdgeTable({
  edges,
  caption,
  showEvidence,
}: {
  edges: readonly WireEdge[];
  caption: 'from' | 'to';
  showEvidence?: boolean;
}) {
  const s = useStyles();
  return (
    <Table size="extra-small" aria-label={`Edges ${caption}`}>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Provenance</TableHeaderCell>
          <TableHeaderCell>Symbol</TableHeaderCell>
          {showEvidence && <TableHeaderCell>Value</TableHeaderCell>}
          <TableHeaderCell>Artifact</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {edges.map((e) => (
          <TableRow key={e.id} data-edge-resolution={e.resolution}>
            <TableCell>
              <Badge
                appearance="tint"
                color={e.resolution === 'dangling' ? 'danger' : 'informative'}
              >
                {e.provenance}
                {e.resolution === 'dangling' && ` · ${e.danglingReason}`}
              </Badge>
            </TableCell>
            <TableCell className={s.mono}>{e.evidence.symbol ?? '—'}</TableCell>
            {showEvidence && (
              <TableCell className={s.mono}>
                {/* The empty string is shown AS an empty string — the receipt is
                    `''`, not a blank cell that reads as "nothing here". */}
                {JSON.stringify(e.evidence.rawValue ?? '')}
              </TableCell>
            )}
            <TableCell className={s.mono}>
              {truncateId(e.evidence.artifact)}
              {e.evidence.line ? `:${e.evidence.line}` : ''}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function FindingSummary({ finding }: { finding: WireFinding }) {
  const s = useStyles();
  return (
    <div className={s.section} data-finding-id={finding.id}>
      <div className={s.badges}>
        <Badge
          appearance="filled"
          color={
            finding.severity === 'critical' || finding.severity === 'high'
              ? 'danger'
              : finding.severity === 'medium'
                ? 'warning'
                : 'informative'
          }
        >
          {finding.severity}
        </Badge>
        <Badge appearance="outline">confidence: {finding.confidence}</Badge>
        {finding.costLabel && (
          // Always the labelled form. Never a bare dollar amount.
          <Badge appearance="tint" color="warning" data-cost-source={finding.cost?.source}>
            {finding.costLabel}
          </Badge>
        )}
      </div>
      <Body1Strong>{finding.title}</Body1Strong>
      <Body1>{finding.summary}</Body1>
      <Caption1 className={s.mono}>{finding.evidence.query}</Caption1>
    </div>
  );
}
