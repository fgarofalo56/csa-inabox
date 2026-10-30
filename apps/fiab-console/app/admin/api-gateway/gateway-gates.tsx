'use client';

/**
 * Evaluated api-gateway gates for ONE gateway, with their Fix-its (W1-6 consumed, W1-5 renders),
 * plus the declared per-boundary readiness gaps.
 *
 * Gates are cards, not bare MessageBars: a gate that has an action carries its Fix-it button
 * (ux-baseline G2); a declared gap (fixit === null) names owner + substitute and has NO button,
 * because there is nothing the operator or the platform can do (no-vaporware).
 */
import { useState } from 'react';
import {
  Badge, Body1, Button, Caption1, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface,
  DialogTitle, Subtitle2, makeStyles, tokens,
} from '@fluentui/react-components';
import { CheckmarkCircle20Regular, Copy16Regular, Wrench16Regular } from '@fluentui/react-icons';
import type { GatewayDoc } from '@/lib/api-gateway/registry/types';
import type { ApiGatewayGateInstance } from '@/lib/gates/registry/api-gateway';
import { gapsFor, gatesFor } from './_lib/hub-model';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  title: { minWidth: 0, overflowWrap: 'anywhere' },
  muted: { color: tokens.colorNeutralForeground3, overflowWrap: 'anywhere' },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  command: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    padding: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap',
  },
  ok: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorPaletteGreenForeground1 },
  gapRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
});

function FixitDialog({ inst, open, onClose }: { inst: ApiGatewayGateInstance; open: boolean; onClose: () => void }) {
  const s = useStyles();
  const [copied, setCopied] = useState(false);
  const rg = inst.roleGrant;
  const copy = async () => {
    if (!rg) return;
    try { await navigator.clipboard.writeText(rg.azCommand); setCopied(true); } catch { setCopied(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{inst.gate.title}</DialogTitle>
          <DialogContent>
            <div className={s.stack}>
              <Body1>{inst.fixit?.grantNote ?? inst.gate.remediation}</Body1>
              {rg && (
                <>
                  <Caption1 className={s.muted}>Role: {rg.roleName} ({rg.roleDefinitionId})</Caption1>
                  <Caption1 className={s.muted}>Scope: {rg.scope}</Caption1>
                  <div className={s.command} data-testid="gate-az-command">{rg.azCommand}</div>
                </>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            {rg && (
              <Button appearance="primary" icon={<Copy16Regular />} onClick={copy}>
                {copied ? 'Copied' : 'Copy az command'}
              </Button>
            )}
            <Button appearance="secondary" onClick={onClose}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function GateCard({ inst }: { inst: ApiGatewayGateInstance }) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  return (
    <div className={s.card} data-testid={`gate-${inst.gate.id}`}>
      <div className={s.head}>
        <Subtitle2 className={s.title}>{inst.gate.title}</Subtitle2>
        <Badge appearance="tint" color={inst.gate.severity === 'critical' ? 'danger' : 'informative'}>
          {inst.fixit ? inst.gate.severity : 'declared gap'}
        </Badge>
      </div>
      <Body1 className={s.muted}>{inst.gate.remediation}</Body1>
      {inst.gaps && inst.gaps.length > 0 && (
        <Caption1 className={s.muted}>
          Substitute meanwhile: {inst.gaps.find((g) => g.substitute)?.substitute ?? 'none'}
        </Caption1>
      )}
      {inst.fixit && (
        <div className={s.actions}>
          <Button size="small" appearance="primary" icon={<Wrench16Regular />} onClick={() => setOpen(true)}>
            Fix it
          </Button>
        </div>
      )}
      {inst.fixit && <FixitDialog inst={inst} open={open} onClose={() => setOpen(false)} />}
    </div>
  );
}

export function GatewayGates({ gateway }: { gateway: GatewayDoc }) {
  const s = useStyles();
  const gates = gatesFor(gateway);
  const gaps = gapsFor(gateway);
  return (
    <div className={s.stack}>
      {gates.length === 0 ? (
        <div className={s.ok} data-testid="gates-clear">
          <CheckmarkCircle20Regular />
          <Body1>No gates are open for this gateway.</Body1>
        </div>
      ) : (
        gates.map((g) => <GateCard key={g.gate.id} inst={g} />)
      )}
      {gaps.length > 0 && (
        <div className={s.card} data-testid="readiness-gaps">
          <Subtitle2>Declared gaps in this boundary</Subtitle2>
          {gaps.map((g) => (
            <div key={g.gap} className={s.gapRow}>
              <div className={s.head}>
                <Body1 className={s.title}>{g.gap}</Body1>
                <Badge appearance="outline" color={g.measured ? 'informative' : 'warning'}>
                  {g.measured ? 'measured' : 'not measured'}
                </Badge>
              </div>
              <Caption1 className={s.muted}>Owner: {g.owner}</Caption1>
              <Caption1 className={s.muted}>
                Substitute: {g.substitute ?? 'none'} - review: {g.review}
              </Caption1>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
