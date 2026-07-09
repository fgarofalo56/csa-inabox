'use client';

/**
 * AuthoringErrorsPanel — Fabric's pre-run "Authoring errors" surface.
 *
 * Fabric validates the pipeline BEFORE any run and lists every unmet required
 * field in a dedicated panel, each row linked to the offending node (see
 * fabric-ux-observations.md §4). This component ports that: it renders the
 * per-activity issues computed by pipeline-validation.ts for the CURRENT canvas
 * level, and clicking a row selects that activity so its properties panel (with
 * red tab dots) opens on the missing field. Collapsible; shows a clean "no
 * authoring errors" state when the level validates.
 *
 * Pure presentation — the caller passes already-computed validations + the
 * total deep count. Every colour / space / radius is a Fluent `tokens.*` value.
 */

import {
  Caption1, Subtitle2, Badge, Button, Tooltip, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ErrorCircle16Regular, CheckmarkCircle16Regular, Warning16Regular,
  ChevronDown16Regular, ChevronRight16Regular,
} from '@fluentui/react-icons';
import type { ActivityValidation } from './pipeline-validation';

const useStyles = makeStyles({
  root: {
    display: 'flex', flexDirection: 'column',
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
    overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalS,
    cursor: 'pointer', userSelect: 'none',
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  headerClean: { borderBottom: 'none' },
  headerTitle: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flex: 1, minWidth: 0 },
  okIcon: { color: tokens.colorPaletteGreenForeground1, display: 'inline-flex' },
  errIcon: { color: tokens.colorPaletteRedForeground1, display: 'inline-flex' },
  body: {
    display: 'flex', flexDirection: 'column',
    maxHeight: '188px', overflowY: 'auto',
  },
  row: {
    display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    cursor: 'pointer',
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    transitionProperty: 'background-color',
    transitionDuration: tokens.durationFaster,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
    ':focus-visible': { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '-2px' },
  },
  rowIcon: { color: tokens.colorPaletteRedForeground1, marginTop: '2px', flexShrink: 0, display: 'inline-flex' },
  rowText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  activityName: { fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1 },
  issueMsg: { color: tokens.colorNeutralForeground2 },
  tabTag: { color: tokens.colorNeutralForeground3, textTransform: 'capitalize' },
  cleanBody: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalS, paddingBottom: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    color: tokens.colorNeutralForeground3,
  },
});

/** Friendlier tab labels for the "(on the X tab)" hint. */
const TAB_LABEL: Record<string, string> = {
  general: 'General', source: 'Source', sink: 'Destination', mapping: 'Mapping',
  'copy-settings': 'Settings', 'source-sink': 'Source / Sink', settings: 'Settings',
  parameters: 'Parameters', 'user-props': 'User properties',
};

export interface AuthoringErrorsPanelProps {
  /** Per-activity issues for the CURRENT canvas level (only activities with issues). */
  validations: ActivityValidation[];
  /** Total issue count across the WHOLE tree (top level + nested containers). */
  deepCount: number;
  /** Whether the panel is expanded. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Select an activity at the current level (opens its properties panel). */
  onSelectActivity: (name: string) => void;
}

export function AuthoringErrorsPanel({
  validations, deepCount, open, onOpenChange, onSelectActivity,
}: AuthoringErrorsPanelProps) {
  const s = useStyles();
  const levelCount = validations.reduce((n, v) => n + v.issues.length, 0);
  const clean = deepCount === 0;
  // Issues nested inside containers at OTHER levels that aren't in this list.
  const elsewhere = Math.max(0, deepCount - levelCount);

  return (
    <div className={s.root} data-authoring-errors>
      <div
        className={`${s.header}${clean && !open ? ` ${s.headerClean}` : ''}`}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenChange(!open); } }}
      >
        <span className={s.headerTitle}>
          {clean
            ? <span className={s.okIcon} aria-hidden="true"><CheckmarkCircle16Regular /></span>
            : <span className={s.errIcon} aria-hidden="true"><ErrorCircle16Regular /></span>}
          <Subtitle2>Authoring errors</Subtitle2>
          {!clean && <Badge appearance="filled" color="danger" size="small">{deepCount}</Badge>}
          {clean && <Badge appearance="tint" color="success" size="small">None</Badge>}
        </span>
        <span aria-hidden="true" style={{ color: tokens.colorNeutralForeground3, display: 'inline-flex' }}>
          {open ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
        </span>
      </div>

      {open && (
        clean ? (
          <div className={s.cleanBody}>
            <span className={s.okIcon} aria-hidden="true"><CheckmarkCircle16Regular /></span>
            <Caption1>No authoring errors — every activity has its required fields set. Save and run when ready.</Caption1>
          </div>
        ) : (
          <div className={s.body}>
            {validations.length === 0 && (
              <div className={s.cleanBody}>
                <span className={s.rowIcon} aria-hidden="true"><Warning16Regular /></span>
                <Caption1>{elsewhere} error{elsewhere === 1 ? '' : 's'} inside nested containers. Drill into a container node to fix them.</Caption1>
              </div>
            )}
            {validations.map((v) =>
              v.issues.map((issue, i) => (
                <Tooltip
                  key={`${v.name}:${issue.key}:${i}`}
                  content={`Select ${v.name} and open its ${TAB_LABEL[issue.tab] || issue.tab} tab`}
                  relationship="description"
                >
                  <div
                    className={s.row}
                    role="button"
                    tabIndex={0}
                    data-error-activity={v.name}
                    onClick={() => onSelectActivity(v.name)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectActivity(v.name); } }}
                  >
                    <span className={s.rowIcon} aria-hidden="true"><ErrorCircle16Regular /></span>
                    <span className={s.rowText}>
                      <Caption1 className={s.activityName}>{v.name}</Caption1>
                      <Caption1 className={s.issueMsg}>
                        {issue.message} <span className={s.tabTag}>· {TAB_LABEL[issue.tab] || issue.tab} tab</span>
                      </Caption1>
                    </span>
                  </div>
                </Tooltip>
              )),
            )}
            {validations.length > 0 && elsewhere > 0 && (
              <div className={s.cleanBody}>
                <span className={s.rowIcon} aria-hidden="true"><Warning16Regular /></span>
                <Caption1>+ {elsewhere} more inside nested containers. Drill in to fix.</Caption1>
              </div>
            )}
          </div>
        )
      )}
    </div>
  );
}

/** Standalone Validate button — recomputes + expands the authoring-errors panel. */
export function ValidateButton({ count, onValidate }: { count: number; onValidate: () => void }) {
  return (
    <Button
      size="small"
      appearance="subtle"
      icon={count > 0 ? <ErrorCircle16Regular /> : <CheckmarkCircle16Regular />}
      onClick={onValidate}
    >
      Validate{count > 0 ? ` (${count})` : ''}
    </Button>
  );
}
