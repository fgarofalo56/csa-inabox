'use client';
/**
 * "Check variables" — the lakehouse ribbon action and its dialog.
 *
 * A READ-ONLY health check: it resolves every variable in each Variable
 * Library in this lakehouse's workspace and reports which ones fail. It writes
 * nothing and refreshes nothing — see `hooks/use-check-variables.ts` for the
 * routes it calls and why that is true.
 *
 * It is deliberately NOT named after Fabric's Lakehouse-ribbon "Update all
 * variables". That command re-evaluates variable-bound SHORTCUTS, which Loom's
 * lakehouse does not have yet (#3538 stays open for it). Borrowing the name for
 * an action with a different effect is the defect an earlier revision of this
 * file shipped.
 *
 * Lives in its own file, with the ribbon action built here rather than inline
 * in the shell, so the shell carries one call per concern rather than the
 * action's whole definition.
 */
import {
  Caption1, Body1, Badge, Button, Spinner, tokens,
  MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
} from '@fluentui/react-components';
import { Add20Regular, ShieldCheckmark20Regular } from '@fluentui/react-icons';
import { useRouter } from 'next/navigation';
import type { RibbonAction } from '@/lib/components/ribbon';
import { useLakehouseCtx } from '../lakehouse-editor-context';

const plural = (n: number) => `librar${n === 1 ? 'y' : 'ies'}`;

/**
 * The ribbon action. DISABLED until the item's workspace is known: without it
 * the list call would drop its workspace filter and check every library the
 * caller owns in every workspace, which is not this lakehouse's check.
 */
export function checkVariablesRibbonAction(opts: {
  workspaceId: string | undefined;
  onOpen: () => void;
}): RibbonAction {
  const ready = !!opts.workspaceId;
  return {
    label: 'Check variables',
    icon: <ShieldCheckmark20Regular />,
    onClick: ready ? opts.onOpen : undefined,
    disabled: !ready,
    title: ready
      ? 'Resolve every variable in this workspace\'s Variable Libraries, including Key Vault secret references, and report which ones fail. Read-only.'
      : 'Loading this lakehouse — its workspace is not known yet',
  };
}

export function CheckVariablesDialog() {
  const {
    cvOpen, setCvOpen, cvLibraries, cvLoadError, cvTruncatedHint,
    cvBusy, cvResults, checkAllVariables,
  } = useLakehouseCtx();
  const router = useRouter();
  const failedCalls = (cvResults || []).filter((r) => !!r.error).length;
  const failedVars = (cvResults || []).reduce((n, r) => n + r.failed, 0);

  return (
    <Dialog open={cvOpen} onOpenChange={(_, d) => setCvOpen(d.open)}>
      <DialogSurface style={{ maxWidth: 560 }}>
        <DialogBody>
          <DialogTitle>Check variables</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              <Body1>
                Resolve every variable in each Variable Library in this lakehouse&apos;s workspace and
                report which ones fail — for example a secret reference whose Key Vault secret is
                missing. Secret values are resolved on the server and never reach this browser.
              </Body1>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                This is a read-only check. It writes no values and refreshes nothing.
              </Caption1>
              {cvLoadError && (
                <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Could not list variable libraries</MessageBarTitle>{cvLoadError}</MessageBarBody></MessageBar>
              )}
              {cvTruncatedHint && (
                <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Partial list</MessageBarTitle>{cvTruncatedHint}</MessageBarBody></MessageBar>
              )}
              {cvLibraries === null && !cvLoadError && <Spinner size="tiny" label="Loading variable libraries…" labelPosition="after" />}
              {cvLibraries !== null && cvLibraries.length === 0 && (
                <MessageBar intent="info"><MessageBarBody>No variable libraries in this workspace yet, so there is nothing to check.</MessageBarBody></MessageBar>
              )}
              {cvLibraries !== null && cvLibraries.length > 0 && !cvResults && (
                <Caption1>{cvLibraries.length} {plural(cvLibraries.length)} will be checked: {cvLibraries.map((l) => l.displayName).join(', ')}</Caption1>
              )}
              {cvResults && (
                <>
                  <MessageBar intent={failedCalls > 0 ? 'error' : failedVars > 0 ? 'warning' : 'success'}>
                    <MessageBarBody>
                      {failedCalls > 0
                        ? `${failedCalls} of ${cvResults.length} ${plural(cvResults.length)} could not be reached.`
                        : failedVars > 0
                          ? `${cvResults.length} ${plural(cvResults.length)} checked; ${failedVars} variable(s) did not resolve.`
                          : `${cvResults.length} ${plural(cvResults.length)} checked; every variable resolves.`}
                    </MessageBarBody>
                  </MessageBar>
                  <Table size="extra-small" aria-label="Variable check results">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>Library</TableHeaderCell>
                        <TableHeaderCell>Value set</TableHeaderCell>
                        <TableHeaderCell>Result</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {cvResults.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell>{r.name}</TableCell>
                          <TableCell>{r.valueSet || '—'}</TableCell>
                          <TableCell>
                            {r.error
                              ? <Badge color="danger" appearance="tint">Not reached: {r.error}</Badge>
                              : r.failed > 0
                                ? <Badge color="warning" appearance="tint">{r.resolved} resolved, {r.failed} failed — {r.firstError}</Badge>
                                : <Badge color="success" appearance="tint">{r.resolved} resolved</Badge>}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" icon={<Add20Regular />} onClick={() => router.push('/items/variable-library/new')}>New variable library</Button>
            <Button appearance="subtle" onClick={() => setCvOpen(false)}>Close</Button>
            <Button
              appearance="primary"
              disabled={cvBusy || !cvLibraries || cvLibraries.length === 0}
              icon={cvBusy ? <Spinner size="tiny" /> : <ShieldCheckmark20Regular />}
              onClick={() => void checkAllVariables()}
            >
              Check all
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
