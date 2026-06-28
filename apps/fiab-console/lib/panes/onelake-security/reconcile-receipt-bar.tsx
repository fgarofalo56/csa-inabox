'use client';

/**
 * ReconcileReceiptBar — renders the {@link ReconcileReceipt} the rls/cls routes
 * return after materializing a role's Row/Column-security to the source engine
 * (Synapse SECURITY POLICY + TVF / member column GRANT, or an ADX
 * row_level_security policy). Shared by row-security-dialog + column-security-
 * dialog so both surface the SAME honest receipt:
 *
 *   - status 'applied'  → success MessageBar (engine + applied count).
 *   - status 'partial'  → warning  (some statements failed; steps show which).
 *   - status 'gated'    → warning  naming the exact missing env var / resource
 *                         (no-vaporware honest gate — the persist still stuck).
 *   - warnings[]        → always shown (incl. the ADX table-wide / last-writer
 *                         disclosure the reconciler emits for an ADX-resolved item).
 *
 * Pure presentational; the receipt shape is the route's, not re-derived here.
 */

import {
  Badge, Caption1, MessageBar, MessageBarBody, MessageBarTitle, tokens,
} from '@fluentui/react-components';

/** Mirror of lib/azure/onelake-rls-reconciler.ReconcileReceipt (UI-side shape). */
export interface ReconcileReceipt {
  engine: 'synapse' | 'adx' | 'none';
  applied: number;
  steps: string[];
  warnings: string[];
  status: 'applied' | 'gated' | 'partial';
  gate?: { missing: string };
}

export function ReconcileReceiptBar({ receipt }: { receipt: ReconcileReceipt | null }) {
  if (!receipt) return null;
  const intent = receipt.status === 'applied' ? 'success' : 'warning';
  const title =
    receipt.status === 'applied'
      ? `Enforced on the ${receipt.engine.toUpperCase()} source`
      : receipt.status === 'gated'
        ? 'Saved — enforcement gated on infrastructure'
        : 'Saved — enforcement partially applied';

  return (
    <MessageBar intent={intent} politeness="polite">
      <MessageBarBody>
        <MessageBarTitle>{title}</MessageBarTitle>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, alignItems: 'center', marginTop: tokens.spacingVerticalXXS }}>
          <Badge appearance="tint" color="informative" size="small">engine: {receipt.engine}</Badge>
          <Badge appearance="tint" color={receipt.applied > 0 ? 'success' : 'subtle'} size="small">
            {receipt.applied} object{receipt.applied === 1 ? '' : 's'} materialized
          </Badge>
          {receipt.status === 'gated' && receipt.gate?.missing && (
            <Badge appearance="tint" color="warning" size="small">set {receipt.gate.missing}</Badge>
          )}
        </div>
        {receipt.status === 'gated' && receipt.gate?.missing && (
          <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS }}>
            The rule is persisted as the source of truth and is enforced by the Loom PDP as an obligation. To
            materialize it on the engine, set <code>{receipt.gate.missing}</code> on the Loom Console and re-save.
          </Caption1>
        )}
        {receipt.warnings.length > 0 && (
          <ul style={{ margin: `${tokens.spacingVerticalXS} 0 0`, paddingInlineStart: tokens.spacingHorizontalXL }}>
            {receipt.warnings.map((w, i) => (
              <li key={i}><Caption1>{w}</Caption1></li>
            ))}
          </ul>
        )}
      </MessageBarBody>
    </MessageBar>
  );
}

export default ReconcileReceiptBar;
