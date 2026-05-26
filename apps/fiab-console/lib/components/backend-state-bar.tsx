'use client';

/**
 * BackendStateBar — silent-on-expected-error pattern.
 *
 * Editors call backend BFF routes that may return:
 *   - 200 → no bar (success)
 *   - 503 → quiet warning: "Service not configured: ..." (env var missing,
 *           resource not deployed, tenant flag not set)
 *   - 401/403 → quiet warning: "Permission missing: ..." (UAMI lacks role)
 *   - 4xx/5xx other → loud error (real failure that needs attention)
 *
 * Until this component, editors dumped every error into a red MessageBar
 * which made "AI Search not provisioned in this env" look like a bug.
 * Now: the same response code drives the same intent, system-wide.
 *
 * Usage:
 *   <BackendStateBar error={error} status={errorStatus} title="ADF pipeline" />
 *
 * When `error` is falsy, renders null. When set, decides intent from
 * `status` (preferred) or scans the message for known phrases.
 */

import { MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';

type Props = {
  error: string | null | undefined;
  status?: number;
  title?: string;
};

export function BackendStateBar({ error, status, title }: Props) {
  if (!error) return null;

  const lower = error.toLowerCase();
  const isNotConfigured =
    status === 503 ||
    lower.includes('not configured') ||
    lower.includes('not provisioned') ||
    lower.includes('not set') ||
    lower.includes('env var') ||
    lower.includes('not deployed');
  const isPermission =
    status === 401 ||
    status === 403 ||
    lower.includes('forbidden') ||
    lower.includes('unauthorized') ||
    lower.includes('insufficient privileges') ||
    lower.includes('authorizationfailed');

  const intent: 'warning' | 'error' = (isNotConfigured || isPermission) ? 'warning' : 'error';
  const heading = isNotConfigured
    ? `${title || 'Service'} — not configured in this environment`
    : isPermission
    ? `${title || 'Service'} — permission missing`
    : `${title || 'Service'} — error`;

  return (
    <MessageBar intent={intent}>
      <MessageBarBody>
        <MessageBarTitle>{heading}</MessageBarTitle>
        {error}
      </MessageBarBody>
    </MessageBar>
  );
}
