'use client';

/**
 * LineageHarvestBar (issue #2625) — the ONE renderer for a LU-8 lineage-harvest
 * receipt, shared by the Spark job definition's Runs tab and the data-pipeline
 * Output pane.
 *
 * Before this, both surfaces received `lineage.reason` from their run route and
 * rendered nothing at all — a silent no-op where the backend had written an
 * exact, actionable remediation. Per `ux-baseline.md` G2 an honest gate must be
 * VISIBLE and carry an inline **Fix it**, and `no-vaporware.md` forbids a
 * surface that quietly does nothing.
 *
 * The render decision lives in the pure `classifyHarvestReceipt` next door so
 * it is unit-testable without a DOM; this file is presentation only.
 */
import {
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Button, Caption1, Badge, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Wrench16Regular, Open16Regular, CheckmarkCircle20Regular, ArrowSync16Regular,
} from '@fluentui/react-icons';
import {
  classifyHarvestReceipt,
  SPARK_LINEAGE_GATE_ID,
  type LineageHarvestReceipt,
} from './harvest-receipt';

const useStyles = makeStyles({
  bar: { marginBottom: tokens.spacingVerticalM },
  liveRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    minWidth: 0,
    gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalM,
  },
  liveText: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
});

export function LineageHarvestBar({
  receipt,
  onFixit,
  onRefresh,
}: {
  /** The `lineage` block from the run/output route response. */
  receipt: LineageHarvestReceipt | null | undefined;
  /**
   * Opens the surface's Fix-it wizard. Omitted on surfaces that have none —
   * the bar then still renders honestly, minus the button, and always keeps
   * the gate-registry deep link (G2: never a dead end).
   */
  onFixit?: () => void;
  onRefresh?: () => void;
}) {
  const s = useStyles();
  const notice = classifyHarvestReceipt(receipt);
  if (!notice) return null;

  const gateHref = `/admin/gates?q=${encodeURIComponent(notice.gateId || SPARK_LINEAGE_GATE_ID)}`;

  if (notice.intent === 'success') {
    return (
      <div className={s.liveRow}>
        <CheckmarkCircle20Regular style={{ color: tokens.colorPaletteGreenForeground1 }} />
        <Caption1 className={s.liveText}>{notice.title}</Caption1>
        <Badge appearance="tint" color="success" size="small">lineage</Badge>
        <Button as="a" size="small" appearance="transparent" icon={<Open16Regular />} href="/catalog/lineage">
          Open lineage
        </Button>
      </div>
    );
  }

  return (
    <MessageBar intent={notice.intent} layout="multiline" className={s.bar}>
      <MessageBarBody>
        <MessageBarTitle>{notice.title}</MessageBarTitle>
        {notice.body}
      </MessageBarBody>
      <MessageBarActions>
        {notice.fixit && onFixit && (
          <Button size="small" appearance="primary" icon={<Wrench16Regular />} onClick={onFixit}>
            Fix it
          </Button>
        )}
        <Button as="a" size="small" appearance="transparent" icon={<Open16Regular />} href={gateHref}>
          Gate registry
        </Button>
        {onRefresh && (
          <Button size="small" appearance="transparent" icon={<ArrowSync16Regular />} onClick={onRefresh}>
            Recheck
          </Button>
        )}
      </MessageBarActions>
    </MessageBar>
  );
}
