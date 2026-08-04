import * as vscode from 'vscode';
import type { CommandContext } from './context';
import { parseDeployments, type Cloud } from '../config/deployments';

const CLOUDS: Array<{ label: string; value: Cloud }> = [
  { label: 'Commercial (Azure public)', value: 'commercial' },
  { label: 'Government', value: 'gov' },
  { label: 'GCC', value: 'gcc' },
  { label: 'GCC High', value: 'gcc-high' },
  { label: 'IL5', value: 'il5' },
];

/**
 * `Loom: Add deployment…` — a small wizard that appends a deployment to the
 * `loom.deployments` setting (application scope). Only `apiUrl` differs per
 * cloud (PRP A4); the same extension talks to Commercial and Government.
 */
export async function addDeployment(cx: CommandContext): Promise<void> {
  const apiUrl = await vscode.window.showInputBox({
    title: 'Add a CSA Loom deployment (1/3)',
    prompt: 'Loom Console base URL',
    placeHolder: 'https://csa-loom.limitlessdata.ai',
    ignoreFocusOut: true,
    validateInput: (v) => {
      const t = (v || '').trim();
      if (!t) return 'A URL is required.';
      try {
        const u = new URL(t);
        return u.protocol === 'http:' || u.protocol === 'https:' ? undefined : 'Must be an http(s) URL.';
      } catch {
        return 'Not a valid URL.';
      }
    },
  });
  if (!apiUrl) return;

  const name = await vscode.window.showInputBox({
    title: 'Add a CSA Loom deployment (2/3)',
    prompt: 'Display name (optional — defaults to the host)',
    ignoreFocusOut: true,
  });
  if (name === undefined) return;

  const cloudPick = await vscode.window.showQuickPick(
    CLOUDS.map((c) => ({ label: c.label, value: c.value })),
    { title: 'Add a CSA Loom deployment (3/3)', placeHolder: 'Cloud' },
  );
  if (!cloudPick) return;

  const config = vscode.workspace.getConfiguration('loom');
  const entry: Record<string, string> = { apiUrl: apiUrl.trim(), cloud: cloudPick.value };
  if (name.trim()) entry.name = name.trim();

  // Preserve the raw existing entries and append (parse only validates).
  const rawExisting = (config.get<unknown[]>('deployments') ?? []).filter((x) => x && typeof x === 'object');
  await config.update('deployments', [...rawExisting, entry], vscode.ConfigurationTarget.Global);

  await cx.syncAuthState();
  cx.tree.refresh();

  const added = parseDeployments(config.get('deployments')).find((d) => d.apiUrl === apiUrl.trim());
  if (added) {
    const choice = await vscode.window.showInformationMessage(`Added deployment "${added.name}".`, 'Sign in now');
    if (choice) await vscode.commands.executeCommand('loom.signIn', { kind: 'deployment', dep: added });
  }
}
