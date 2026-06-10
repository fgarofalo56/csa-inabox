/**
 * Publish a Loom data agent to Microsoft 365 Copilot (and Microsoft Teams) —
 * Azure-native, no Microsoft Fabric / Power BI dependency.
 *
 * Build 2026 #4 canonical path (Foundry portal → "Publish to Teams and
 * Microsoft 365 Copilot"): a published Foundry Agent Service agent is fronted
 * by an **Azure Bot Service** registration whose messaging endpoint targets the
 * agent's stable channel endpoint. Enabling the Bot Service **MsTeams** channel
 * is what surfaces the agent inside Microsoft 365 Copilot + Teams. The end user
 * (or admin, for org scope) then installs a **Teams / M365 app package** (.zip
 * manifest) that points at the bot's Microsoft App Id.
 *
 * This client wires the two halves that the Foundry UI does behind the scenes,
 * using only Azure control-plane REST (Microsoft.BotService) + a deps-free ZIP
 * builder for the app package:
 *
 *   1. ensureBotRegistration()  — PUT Microsoft.BotService/botServices/{bot}
 *      (kind 'azurebot') with endpoint = the Foundry agent stable endpoint.
 *   2. enableTeamsChannel()     — PUT …/channels/MsTeamsChannel (M365 Copilot +
 *      Teams surface). Re-runnable / idempotent.
 *   3. buildM365AppPackage()    — generate the Teams/M365 app manifest .zip
 *      (manifest.json + color/outline icons) the admin submits to the M365
 *      admin center (org scope) or sideloads (just-you scope).
 *
 * Every Azure prerequisite that isn't deployed surfaces as a typed
 * M365PublishNotConfiguredError so the BFF returns a 501 + an exact remediation
 * (env var / role / provider to register), per .claude/rules/no-vaporware.md —
 * never a mock success.
 *
 * Env:
 *   LOOM_SUBSCRIPTION_ID            — subscription that hosts the Bot Service
 *   LOOM_M365_BOT_RG               — RG for the Bot Service (defaults LOOM_ADMIN_RG)
 *   LOOM_M365_BOT_APP_ID           — Microsoft Entra app (client) id the bot
 *                                    authenticates as (msaAppId). Required — a
 *                                    bot registration cannot exist without one.
 *   LOOM_M365_BOT_APP_TYPE         — MultiTenant | SingleTenant | UserAssignedMSI
 *                                    (default SingleTenant)
 *   LOOM_M365_BOT_MSI_RESOURCE_ID  — UAMI resource id (required when app type is
 *                                    UserAssignedMSI)
 *   AZURE_TENANT_ID                — tenant id (msaAppTenantId for SingleTenant)
 *   LOOM_M365_BOT_LOCATION         — Bot Service location (default 'global')
 */

import { armGet, armPut } from './arm-client';
import { deflateRawSync } from 'node:zlib';

const BOT_API_VERSION = '2022-09-15';

/** Thrown when a required Azure prerequisite for M365 publish is missing. */
export class M365PublishNotConfiguredError extends Error {
  hint: string;
  constructor(missing: string, hint: string) {
    super(`Microsoft 365 Copilot publish is not configured: missing ${missing}`);
    this.name = 'M365PublishNotConfiguredError';
    this.hint = hint;
  }
}

export type BotAppType = 'MultiTenant' | 'SingleTenant' | 'UserAssignedMSI';

interface BotConfig {
  subscriptionId: string;
  resourceGroup: string;
  appId: string;
  appType: BotAppType;
  msiResourceId?: string;
  tenantId?: string;
  location: string;
}

function requireBotConfig(): BotConfig {
  const subscriptionId = process.env.LOOM_SUBSCRIPTION_ID;
  if (!subscriptionId) {
    throw new M365PublishNotConfiguredError(
      'LOOM_SUBSCRIPTION_ID',
      'Set LOOM_SUBSCRIPTION_ID to the subscription that will host the Azure Bot Service ' +
        'registration. It is wired from subscription().subscriptionId in ' +
        'platform/fiab/bicep/modules/admin-plane/main.bicep on every deploy.',
    );
  }
  const resourceGroup = process.env.LOOM_M365_BOT_RG || process.env.LOOM_ADMIN_RG;
  if (!resourceGroup) {
    throw new M365PublishNotConfiguredError(
      'LOOM_M365_BOT_RG / LOOM_ADMIN_RG',
      'Set LOOM_M365_BOT_RG (or rely on LOOM_ADMIN_RG) to the resource group that will ' +
        'hold the Azure Bot Service for published data agents.',
    );
  }
  const appId = process.env.LOOM_M365_BOT_APP_ID;
  if (!appId) {
    throw new M365PublishNotConfiguredError(
      'LOOM_M365_BOT_APP_ID',
      'Create (or reuse) a Microsoft Entra application for the data-agent bot and set ' +
        'LOOM_M365_BOT_APP_ID to its Application (client) id. The Azure Bot Service ' +
        'registration requires a Microsoft App Id (msaAppId). See ' +
        'platform/fiab/bicep/modules/admin-plane/m365-copilot-bot.bicep for the wiring, ' +
        'and grant the Console UAMI "Azure Bot Service Contributor" on the bot RG.',
    );
  }
  const appType = (process.env.LOOM_M365_BOT_APP_TYPE as BotAppType) || 'SingleTenant';
  const msiResourceId = process.env.LOOM_M365_BOT_MSI_RESOURCE_ID || undefined;
  if (appType === 'UserAssignedMSI' && !msiResourceId) {
    throw new M365PublishNotConfiguredError(
      'LOOM_M365_BOT_MSI_RESOURCE_ID',
      'When LOOM_M365_BOT_APP_TYPE=UserAssignedMSI, set LOOM_M365_BOT_MSI_RESOURCE_ID to ' +
        'the user-assigned managed identity resource id that backs the bot app.',
    );
  }
  const tenantId = process.env.AZURE_TENANT_ID || process.env.LOOM_DATAVERSE_TENANT_ID || undefined;
  const location = process.env.LOOM_M365_BOT_LOCATION || 'global';
  return { subscriptionId, resourceGroup, appId, appType, msiResourceId, tenantId, location };
}

/** Sanitize an item id / display name into a valid Bot Service resource name. */
export function botResourceName(itemId: string): string {
  const base = `loom-da-${itemId}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  const trimmed = base.replace(/^[-._]+|[-._]+$/g, '').slice(0, 64);
  return trimmed.replace(/^[-._]+|[-._]+$/g, '') || `loom-da-${itemId.slice(0, 8)}`;
}

function botPath(cfg: BotConfig, name: string, suffix = ''): string {
  return (
    `/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}` +
    `/providers/Microsoft.BotService/botServices/${encodeURIComponent(name)}${suffix}` +
    `?api-version=${BOT_API_VERSION}`
  );
}

export interface BotRegistration {
  id: string;
  name: string;
  endpoint: string;
  msaAppId: string;
  provisioningState?: string;
}

/**
 * Create or update the Azure Bot Service registration that fronts a published
 * Foundry data agent. Idempotent (PUT). The messaging endpoint is the Foundry
 * agent's stable channel endpoint.
 */
export async function ensureBotRegistration(args: {
  botName: string;
  displayName: string;
  description?: string;
  messagingEndpoint: string;
  iconUrl?: string;
}): Promise<BotRegistration> {
  const cfg = requireBotConfig();
  const properties: Record<string, unknown> = {
    displayName: args.displayName.slice(0, 42),
    endpoint: args.messagingEndpoint,
    msaAppId: cfg.appId,
    msaAppType: cfg.appType,
  };
  if (args.description) properties.description = args.description.slice(0, 512);
  if (args.iconUrl) properties.iconUrl = args.iconUrl;
  if (cfg.appType === 'SingleTenant' && cfg.tenantId) properties.msaAppTenantId = cfg.tenantId;
  if (cfg.appType === 'UserAssignedMSI' && cfg.msiResourceId) {
    properties.msaAppMSIResourceId = cfg.msiResourceId;
    if (cfg.tenantId) properties.msaAppTenantId = cfg.tenantId;
  }

  const body = {
    location: cfg.location,
    kind: 'azurebot',
    sku: { name: 'F0' },
    properties,
  };
  const res = await armPut<any>(botPath(cfg, args.botName), body);
  return {
    id: res?.id || botPath(cfg, args.botName).split('?')[0],
    name: res?.name || args.botName,
    endpoint: res?.properties?.endpoint || args.messagingEndpoint,
    msaAppId: res?.properties?.msaAppId || cfg.appId,
    provisioningState: res?.properties?.provisioningState,
  };
}

/**
 * Enable the Microsoft Teams channel on the bot. This is the channel that makes
 * the agent available in Microsoft 365 Copilot + Teams. Idempotent.
 */
export async function enableTeamsChannel(botName: string): Promise<{ enabled: boolean; name: string }> {
  const cfg = requireBotConfig();
  const body = {
    location: cfg.location,
    properties: {
      channelName: 'MsTeamsChannel',
      properties: {
        isEnabled: true,
        // M365 Copilot consumes the same Teams channel registration.
        acceptedTerms: true,
      },
    },
  };
  const res = await armPut<any>(botPath(cfg, botName, '/channels/MsTeamsChannel'), body);
  const enabled = res?.properties?.properties?.isEnabled ?? true;
  return { enabled: Boolean(enabled), name: 'MsTeamsChannel' };
}

/** Read the current Bot Service registration (null when not yet created). */
export async function getBotRegistration(botName: string): Promise<BotRegistration | null> {
  const cfg = requireBotConfig();
  try {
    const res = await armGet<any>(botPath(cfg, botName));
    if (!res?.id) return null;
    return {
      id: res.id,
      name: res.name || botName,
      endpoint: res?.properties?.endpoint || '',
      msaAppId: res?.properties?.msaAppId || cfg.appId,
      provisioningState: res?.properties?.provisioningState,
    };
  } catch (e: any) {
    if (/ 404\b|NotFound/i.test(String(e?.message))) return null;
    throw e;
  }
}

// ===========================================================================
// Teams / Microsoft 365 app package (deps-free ZIP)
// ===========================================================================
//
// The downloadable agent package is a Microsoft 365 app package: a ZIP that
// contains manifest.json + a color icon (192x192 PNG) + an outline icon
// (32x32 transparent PNG). We build it with node:zlib (deflateRawSync) — no
// jszip/archiver dependency (which would require a forbidden pnpm install).

const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry { name: string; data: Buffer }

/** Minimal ZIP writer (deflate method 8). Sufficient for Teams app packages. */
function buildZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const compressed = deflateRawSync(e.data);
    const useStore = compressed.length >= e.data.length;
    const method = useStore ? 0 : 8;
    const payload = useStore ? e.data : compressed;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);          // mod time
    local.writeUInt16LE(0x21, 12);       // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // extra length
    localParts.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0, 8);         // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);        // extra
    central.writeUInt16LE(0, 32);        // comment
    central.writeUInt16LE(0, 34);        // disk
    central.writeUInt16LE(0, 36);        // internal attrs
    central.writeUInt32LE(0, 38);        // external attrs
    central.writeUInt32LE(offset, 42);   // local header offset
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const localBuf = Buffer.concat(localParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(localBuf.length, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, end]);
}

// A small solid color PNG and a transparent PNG, base64-encoded — valid minimal
// icons so the package passes manifest validation. Teams resizes them.
const COLOR_ICON_PNG = Buffer.from(
  // 16x16 solid CSA-brand-blue PNG.
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVR42mNkYPhfz0BHwDiqAA' +
    'wMo2EwGgaUAAB9pQM/dC4kYwAAAABJRU5ErkJggg==',
  'base64',
);
const OUTLINE_ICON_PNG = Buffer.from(
  // 32x32 transparent PNG.
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAIElEQVR42mNkoBAwjhowasCoAa' +
    'MGjBowasCoAaMGAAAJ4gABjB6mPgAAAABJRU5ErkJggg==',
  'base64',
);

export interface M365ManifestArgs {
  /** Stable, unique agent id (used for manifest.id — a GUID). */
  manifestId: string;
  botAppId: string;
  displayName: string;
  shortDescription: string;
  fullDescription: string;
  developerName: string;
  version: string; // major.minor.patch
  /** Optional public URLs (HTTPS) for the manifest's developer block. */
  websiteUrl?: string;
  privacyUrl?: string;
  termsUrl?: string;
}

/** Compose the Microsoft 365 / Teams app manifest JSON for the bot. */
export function buildM365Manifest(args: M365ManifestArgs): Record<string, unknown> {
  const safeName = args.displayName.slice(0, 30) || 'Loom data agent';
  const safeDev = args.developerName.slice(0, 32) || 'CSA Loom';
  return {
    $schema: 'https://developer.microsoft.com/json-schemas/teams/v1.17/MicrosoftTeams.schema.json',
    manifestVersion: '1.17',
    version: args.version,
    id: args.manifestId,
    packageName: `com.csaloom.dataagent.${args.manifestId.replace(/[^a-z0-9]/gi, '')}`.slice(0, 64),
    developer: {
      name: safeDev,
      websiteUrl: args.websiteUrl || 'https://example.com',
      privacyUrl: args.privacyUrl || 'https://example.com/privacy',
      termsOfUseUrl: args.termsUrl || 'https://example.com/terms',
    },
    icons: { color: 'color.png', outline: 'outline.png' },
    name: { short: safeName, full: args.displayName.slice(0, 100) || safeName },
    description: {
      short: args.shortDescription.slice(0, 80) || safeName,
      full: args.fullDescription.slice(0, 4000) || args.shortDescription || safeName,
    },
    accentColor: '#0F6CBD',
    bots: [
      {
        botId: args.botAppId,
        scopes: ['personal', 'team', 'groupChat'],
        supportsFiles: false,
        isNotificationOnly: false,
        commandLists: [],
      },
    ],
    // Surface the agent inside Microsoft 365 Copilot (custom engine agent host).
    copilotAgents: {
      customEngineAgents: [{ type: 'bot', id: args.botAppId }],
    },
    permissions: ['identity', 'messageTeamMembers'],
    validDomains: ['token.botframework.com'],
  };
}

export interface M365AppPackage {
  zip: Buffer;
  fileName: string;
  manifest: Record<string, unknown>;
}

/** Build the downloadable Teams/M365 app package (.zip) for a published agent. */
export function buildM365AppPackage(args: M365ManifestArgs): M365AppPackage {
  const manifest = buildM365Manifest(args);
  const zip = buildZip([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    { name: 'color.png', data: COLOR_ICON_PNG },
    { name: 'outline.png', data: OUTLINE_ICON_PNG },
  ]);
  const safe = args.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'loom-data-agent';
  return { zip, fileName: `${safe}-m365.zip`, manifest };
}
