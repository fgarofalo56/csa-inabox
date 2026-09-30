'use client';

/**
 * AdminOnlyNotice — the one rendering of "this control is for tenant admins".
 *
 * Two uses, same anatomy as the DSPM-for-AI panel's `admin_only` bar:
 *   - PRE-EMPTIVE: a surface whose verb is tenant-admin gated renders this in
 *     place of (or beside) the disabled control when `useIsTenantAdmin()` is
 *     false, so a non-admin learns why before they click;
 *   - REACTIVE: a surface that received the 403 `admin_only` envelope passes
 *     the envelope's `reason` + `remediation` through.
 *
 * Presentation only: the BFF route is the enforcement point.
 */
import { MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';
import { useShellSession } from '@/lib/components/session-context';

/**
 * The shell's admin flag read for a gated control.
 *   - `allowed`: enable the control. False while the /api/me probe is in
 *     flight and for non-admins (fail-closed, like `useIsTenantAdmin`).
 *   - `refused`: show the pre-emptive notice. True only once the probe has
 *     RESOLVED to a non-admin, so an admin never sees the notice flash while
 *     the probe is in flight.
 */
export function useTenantAdminGate(): { allowed: boolean; refused: boolean } {
  const { isTenantAdmin, loading } = useShellSession();
  return { allowed: isTenantAdmin, refused: !loading && !isTenantAdmin };
}

export interface AdminOnlyNoticeProps {
  /** Why the action is tenant-admin only (the envelope's `reason`). */
  reason?: string;
  /** What the user can do instead (the envelope's `remediation`). */
  remediation?: string;
  title?: string;
  className?: string;
}

export function AdminOnlyNotice({ reason, remediation, title = 'Tenant admins only', className }: AdminOnlyNoticeProps) {
  const text = [reason, remediation].filter((s) => typeof s === 'string' && s.trim()).join(' ')
    || 'Only a tenant admin can make this change.';
  return (
    <MessageBar intent="warning" className={className} data-testid="admin-only-notice">
      <MessageBarBody>
        <MessageBarTitle>{title}</MessageBarTitle>
        {text}
      </MessageBarBody>
    </MessageBar>
  );
}
