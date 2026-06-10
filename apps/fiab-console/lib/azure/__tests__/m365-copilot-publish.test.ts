/**
 * Backend contract tests for the data-agent → Microsoft 365 Copilot publish
 * client (Build 2026 #4, Azure-native — Bot Service + Teams/M365 channel).
 *
 *  - botResourceName         → valid, deterministic Bot Service resource name
 *  - buildM365Manifest       → real Teams/M365 manifest shape (bot + copilotAgents)
 *  - buildM365AppPackage     → a valid ZIP (PK\x03\x04 + EOCD) containing the 3 files
 *  - requireBotConfig gate   → ensureBotRegistration / enableTeamsChannel throw
 *                              M365PublishNotConfiguredError when env is unset
 *
 * Stubs @azure/identity so no live tenant is needed. Asserts the REAL surface.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import {
  botResourceName,
  buildM365Manifest,
  buildM365AppPackage,
  ensureBotRegistration,
  enableTeamsChannel,
  M365PublishNotConfiguredError,
} from '../m365-copilot-publish';

describe('botResourceName', () => {
  it('produces a valid, deterministic Bot Service resource name', () => {
    const a = botResourceName('My Agent #1!!');
    expect(a).toBe(botResourceName('My Agent #1!!'));
    expect(a).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(a.startsWith('loom-da-')).toBe(true);
  });

  it('falls back to a slice when the id sanitizes to empty', () => {
    const n = botResourceName('!!!@@@###1234abcd');
    expect(n.length).toBeGreaterThan(0);
    expect(n).toMatch(/^[a-zA-Z0-9]/);
  });
});

describe('buildM365Manifest', () => {
  const args = {
    manifestId: '00000000-0000-0000-0000-000000000001',
    botAppId: '11111111-2222-3333-4444-555555555555',
    displayName: 'Finance data agent',
    shortDescription: 'Answers finance questions',
    fullDescription: 'Grounded over the FY warehouse + revenue semantic model.',
    developerName: 'CSA Loom',
    version: '1.0.0',
  };

  it('emits a Teams/M365 manifest binding the bot + custom-engine copilot agent', () => {
    const m = buildM365Manifest(args) as any;
    expect(m.manifestVersion).toBe('1.17');
    expect(m.id).toBe(args.manifestId);
    expect(m.version).toBe('1.0.0');
    expect(m.bots[0].botId).toBe(args.botAppId);
    expect(m.bots[0].scopes).toContain('personal');
    // The M365 Copilot surface — custom engine agent host bound to the bot.
    expect(m.copilotAgents.customEngineAgents[0].id).toBe(args.botAppId);
    expect(m.icons).toEqual({ color: 'color.png', outline: 'outline.png' });
  });

  it('clamps overlong names + descriptions to the manifest limits', () => {
    const m = buildM365Manifest({
      ...args,
      displayName: 'x'.repeat(200),
      shortDescription: 'y'.repeat(200),
    }) as any;
    expect(m.name.short.length).toBeLessThanOrEqual(30);
    expect(m.description.short.length).toBeLessThanOrEqual(80);
  });
});

describe('buildM365AppPackage', () => {
  it('builds a valid ZIP with manifest.json + both icons', () => {
    const pkg = buildM365AppPackage({
      manifestId: '00000000-0000-0000-0000-000000000002',
      botAppId: 'aaaa1111-2222-3333-4444-555555555555',
      displayName: 'Ops agent',
      shortDescription: 'Ops Q&A',
      fullDescription: 'Ops telemetry agent.',
      developerName: 'CSA Loom',
      version: '2.1.3',
    });
    // ZIP local-file-header magic + end-of-central-directory magic.
    expect(pkg.zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(pkg.zip.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBeGreaterThan(0);
    // The three entry names appear in the central directory.
    const asStr = pkg.zip.toString('latin1');
    expect(asStr).toContain('manifest.json');
    expect(asStr).toContain('color.png');
    expect(asStr).toContain('outline.png');
    expect(pkg.fileName).toMatch(/\.zip$/);
  });
});

describe('config gate (no env → typed not-configured error)', () => {
  const SAVE = { ...process.env };
  beforeEach(() => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    delete process.env.LOOM_M365_BOT_RG;
    delete process.env.LOOM_ADMIN_RG;
    delete process.env.LOOM_M365_BOT_APP_ID;
  });
  afterEach(() => { process.env = { ...SAVE }; });

  it('ensureBotRegistration throws M365PublishNotConfiguredError when subscription is unset', async () => {
    await expect(
      ensureBotRegistration({ botName: 'loom-da-x', displayName: 'x', messagingEndpoint: 'https://e/messages' }),
    ).rejects.toBeInstanceOf(M365PublishNotConfiguredError);
  });

  it('enableTeamsChannel throws M365PublishNotConfiguredError when app id is unset', async () => {
    process.env.LOOM_SUBSCRIPTION_ID = 'sub';
    process.env.LOOM_ADMIN_RG = 'rg';
    // app id still missing → gate.
    await expect(enableTeamsChannel('loom-da-x')).rejects.toBeInstanceOf(M365PublishNotConfiguredError);
  });
});
