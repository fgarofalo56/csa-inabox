/**
 * Shared promotion helpers for the release-environment routes.
 *
 * `deployForPromotion` centralises the Azure Deployment Environments (DevCenter)
 * create that backs a real promotion, so both the immediate (ungated) promote
 * path and the post-approval completion path run identical, real Azure code —
 * no mocks. Files prefixed with `_` are ignored by Next.js routing.
 *
 * Azure-native — no Microsoft Fabric required.
 */
import {
  createDeploymentEnvironment, devCenterConfigured,
  DevCenterError, DevCenterNotConfiguredError,
} from '@/lib/azure/devcenter-client';

export interface DeployedEnv {
  name: string; provisioningState: string; environmentType: string;
  environmentDefinitionName: string; resourceGroupId?: string; operationLocation?: string;
}

export interface DeployOutcome {
  /** Real Azure Deployment Environments result when a definition was named + DevCenter is configured. */
  deployedEnvironment?: DeployedEnv;
  /** Honest infra-gate when a definition was named but DevCenter isn't (fully) configured. */
  gate?: { reason: string; remediation: string; link: string };
  /** Hard error from the DevCenter data-plane. */
  error?: string;
  status?: number;
}

/**
 * When `environmentDefinition` is set, create the real Azure Deployment
 * Environment for the target stage. Returns {} when no definition was named
 * (a pure metadata promotion), a gate when DevCenter is unconfigured, or the
 * deployed-env result on success.
 */
export async function deployForPromotion(opts: {
  displayName?: string; id: string; toStage: string; environmentDefinition?: string;
}): Promise<DeployOutcome> {
  const environmentDefinition = (opts.environmentDefinition || '').trim();
  if (!environmentDefinition) return {};
  if (!devCenterConfigured()) {
    return {
      status: 409,
      error: 'Azure Deployment Environments not configured (LOOM_DEVCENTER_PROJECT).',
      gate: {
        reason: 'An environment definition was named, but Azure Deployment Environments is not configured.',
        remediation: 'Set LOOM_DEVCENTER_PROJECT, LOOM_DEVCENTER_URI, and LOOM_DEVCENTER_CATALOG on the Console, and grant the Console UAMI the "Deployment Environments User" role on the project. No Microsoft Fabric required.',
        link: 'https://learn.microsoft.com/azure/deployment-environments/',
      },
    };
  }
  try {
    const deployedEnvironment = await createDeploymentEnvironment({
      environmentName: `${opts.displayName || opts.id}-${opts.toStage}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63),
      environmentDefinitionName: environmentDefinition,
      environmentType: opts.toStage,
    });
    return { deployedEnvironment };
  } catch (e) {
    if (e instanceof DevCenterNotConfiguredError) {
      return {
        status: 409,
        error: e.message,
        gate: {
          reason: 'Azure Deployment Environments is partially configured.',
          remediation: `Set the missing env var(s): ${e.missing.join(', ')} on the Console. No Microsoft Fabric required.`,
          link: 'https://learn.microsoft.com/azure/deployment-environments/',
        },
      };
    }
    return {
      status: e instanceof DevCenterError ? e.status : 502,
      error: `Azure Deployment Environments create failed: ${(e as Error).message}`,
    };
  }
}
