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

import { MessageBar, MessageBarBody, MessageBarTitle, Caption1, tokens } from '@fluentui/react-components';

export interface RoleRequirement {
  name: string;
  appRoleId?: string;
  scope: string;
  reason: string;
}

export interface NotConfiguredHint {
  missingEnvVar?: string;
  /**
   * #3749 — what is actually KNOWN about `missingEnvVar`.
   *
   * `missingEnvVar` was always rendered as "Missing env var: X", i.e. as a
   * statement of CAUSE. Three DLP hint builders reuse the same base hint for
   * conditions that are NOT an unset flag — `graphDlpUnavailableHint`,
   * `graphDlpGovUnavailableHint` and `graphSecurityRoleHint` all start from
   * `notConfiguredHint('LOOM_DLP_ENABLED')` and then overwrite `bicepStatus`
   * with text beginning "LOOM_DLP_ENABLED=true …". The bar therefore printed
   * "Missing env var: LOOM_DLP_ENABLED" two lines above "LOOM_DLP_ENABLED=true
   * and the Console UAMI holds Policy.Read.All, but Microsoft Graph does not
   * expose …". Both cannot be true, and the wrong one is the headline.
   *
   * A producer that KNOWS the flag is set passes 'set' and the bar stops
   * blaming configuration it did not establish. Omitted or 'missing' keeps
   * today's wording exactly, so every existing caller is unchanged.
   */
  envVarState?: 'missing' | 'set';
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
  // #3749 — when the producer states the flag is SET, neither the title nor the
  // env-var line may present configuration as the cause. The surface is
  // genuinely unavailable; what is unavailable is a tenant/Graph capability or
  // an unconsented role, both of which the hint already names below.
  const envVarSet = hint?.envVarState === 'set';
  return (
    <MessageBar intent="warning" politeness="polite">
      <MessageBarBody>
        <MessageBarTitle>
          {envVarSet
            ? `${surface} is enabled but unavailable in this tenant`
            : `${surface} is not wired in this deployment`}
        </MessageBarTitle>
        {rawError && (
          <Caption1 block style={{ marginBottom: tokens.spacingVerticalSNudge }}>
            Upstream: {rawError}
          </Caption1>
        )}
        {hint?.missingEnvVar && (
          <Caption1 block>
            {envVarSet ? (
              <>Feature flag <code>{hint.missingEnvVar}</code> is set — this is not a configuration gap.</>
            ) : (
              <>Missing env var: <code>{hint.missingEnvVar}</code></>
            )}
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
            <Caption1 block style={{ marginTop: tokens.spacingVerticalSNudge }}><strong>Roles required:</strong></Caption1>
            <ul style={{ marginTop: tokens.spacingVerticalXS, marginBottom: tokens.spacingVerticalSNudge, paddingLeft: tokens.spacingHorizontalXL }}>
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
          <Caption1 block style={{ marginTop: tokens.spacingVerticalSNudge }}>
            <strong>Next step:</strong> {hint.followUp}
          </Caption1>
        )}
        {portalLink && (
          <Caption1 block style={{ marginTop: tokens.spacingVerticalSNudge }}>
            Until wired:{' '}
            <a href={portalLink} target="_blank" rel="noreferrer">{portalLabel || portalLink}</a>
          </Caption1>
        )}
      </MessageBarBody>
    </MessageBar>
  );
}
