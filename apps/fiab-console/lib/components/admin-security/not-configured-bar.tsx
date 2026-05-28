'use client';

/**
 * NotConfiguredBar — renders the structured "service not provisioned in
 * this deployment" MessageBar that every panel falls back to when the
 * BFF returns a 503 with a `hint` payload.
 *
 * Per .claude/rules/no-vaporware.md, this is the ONLY acceptable
 * fallback when a runtime requires infrastructure that isn't deployed
 * yet. The bar names the env var, the AppRoles required, the bicep
 * module / bootstrap script that grants them, and a deep-link to the
 * upstream portal.
 */

import { MessageBar, MessageBarBody, MessageBarTitle, Caption1 } from '@fluentui/react-components';

export interface RoleRequirement {
  name: string;
  appRoleId?: string;
  scope: string;
  reason: string;
}

export interface NotConfiguredHint {
  missingEnvVar?: string;
  bicepModule?: string;
  bicepStatus?: string;
  rolesRequired?: RoleRequirement[];
  followUp?: string;
}

interface Props {
  surface: string;
  hint?: NotConfiguredHint;
  rawError?: string;
  portalLink?: string;
  portalLabel?: string;
}

export function NotConfiguredBar({ surface, hint, rawError, portalLink, portalLabel }: Props) {
  return (
    <MessageBar intent="warning" politeness="polite">
      <MessageBarBody>
        <MessageBarTitle>{surface} is not wired in this deployment</MessageBarTitle>
        {rawError && (
          <Caption1 block style={{ marginBottom: 6 }}>
            Upstream: {rawError}
          </Caption1>
        )}
        {hint?.missingEnvVar && (
          <Caption1 block>
            Missing env var: <code>{hint.missingEnvVar}</code>
          </Caption1>
        )}
        {hint?.bicepModule && (
          <Caption1 block>
            Bicep module: <code>{hint.bicepModule}</code>
            {hint.bicepStatus && <> — {hint.bicepStatus}</>}
          </Caption1>
        )}
        {Array.isArray(hint?.rolesRequired) && hint.rolesRequired.length > 0 && (
          <>
            <Caption1 block style={{ marginTop: 6 }}><strong>Roles required:</strong></Caption1>
            <ul style={{ marginTop: 4, marginBottom: 6, paddingLeft: 18 }}>
              {hint.rolesRequired.map((r) => (
                <li key={r.name}>
                  <code>{r.name}</code>
                  {r.appRoleId && <> (<code>{r.appRoleId}</code>)</>}
                  {' '}— {r.reason}
                  <br />
                  <em>Scope:</em> {r.scope}
                </li>
              ))}
            </ul>
          </>
        )}
        {hint?.followUp && (
          <Caption1 block style={{ marginTop: 6 }}>
            <strong>Next step:</strong> {hint.followUp}
          </Caption1>
        )}
        {portalLink && (
          <Caption1 block style={{ marginTop: 6 }}>
            Until wired:{' '}
            <a href={portalLink} target="_blank" rel="noreferrer">{portalLabel || portalLink}</a>
          </Caption1>
        )}
      </MessageBarBody>
    </MessageBar>
  );
}
