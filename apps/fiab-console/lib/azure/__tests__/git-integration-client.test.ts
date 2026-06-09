import { describe, it, expect, afterEach } from 'vitest';
import {
  serializeLoomItem,
  deserializeLoomItem,
  buildTmslFromContent,
  parseTmslToContent,
  parseAdoPath,
  parseGitHubPath,
  adoApiBase,
  githubApiBase,
  adoAuthHeader,
  githubAuthHeader,
  patSecretName,
  pascalItemType,
  itemFolder,
  gitConfigGate,
  type GitRepoConfig,
} from '../git-integration-client';

/**
 * Pure unit tests for the git-integration client (no network, no Azure SDK).
 * Covers serialization, the TMSL round-trip, path parsing, sovereign endpoint
 * resolution, auth header shape, and the honest gate.
 */

const ORIG = {
  LOOM_ADO_HOST: process.env.LOOM_ADO_HOST,
  LOOM_GITHUB_HOST: process.env.LOOM_GITHUB_HOST,
  LOOM_GIT_PAT_KV_PREFIX: process.env.LOOM_GIT_PAT_KV_PREFIX,
};

afterEach(() => {
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete (process.env as any)[k];
    else (process.env as any)[k] = v;
  }
});

const connected: GitRepoConfig = {
  id: 'ws1',
  workspaceId: 'ws1',
  provider: 'github',
  repoHost: 'github.com',
  repoPath: 'myorg/myrepo',
  branch: 'main',
  status: 'connected',
  connectedBy: 'a@b.com',
  connectedAt: '2026-06-09T00:00:00Z',
};

describe('pascalItemType / itemFolder', () => {
  it('converts kebab item types to PascalCase', () => {
    expect(pascalItemType('semantic-model')).toBe('SemanticModel');
    expect(pascalItemType('kql-database')).toBe('KqlDatabase');
    expect(pascalItemType('report')).toBe('Report');
  });
  it('builds a Fabric-style item folder with directory root', () => {
    expect(itemFolder({ itemType: 'report', displayName: 'Sales' }, 'fabric-items')).toBe('fabric-items/Sales.Report');
    expect(itemFolder({ itemType: 'report', displayName: 'Sales' })).toBe('Sales.Report');
  });
});

describe('serializeLoomItem', () => {
  it('semantic-model → model.bim + definition.pbism', () => {
    const files = serializeLoomItem(
      { itemType: 'semantic-model', displayName: 'Sales', state: { content: { tables: [], measures: [], relationships: [] } } },
      'items',
    );
    const paths = files.map((f) => f.repoPath).sort();
    expect(paths).toEqual(['items/Sales.SemanticModel/definition.pbism', 'items/Sales.SemanticModel/model.bim']);
    const bim = JSON.parse(files.find((f) => f.repoPath.endsWith('model.bim'))!.content);
    expect(bim.name).toBe('Sales');
    expect(bim.compatibilityLevel).toBe(1567);
  });

  it('report → definition.pbir + definition/report.json', () => {
    const files = serializeLoomItem({ itemType: 'report', displayName: 'Rep', state: { content: { pages: [1] } } });
    const paths = files.map((f) => f.repoPath).sort();
    expect(paths).toEqual(['Rep.Report/definition.pbir', 'Rep.Report/definition/report.json']);
  });

  it('scorecard → scorecard.json', () => {
    const files = serializeLoomItem({ itemType: 'scorecard', displayName: 'Goals', state: { content: { goals: [] } } });
    expect(files).toHaveLength(1);
    expect(files[0].repoPath).toBe('Goals.Scorecard/scorecard.json');
  });

  it('lakehouse → lakehouse.json', () => {
    const files = serializeLoomItem({ itemType: 'lakehouse', displayName: 'Lake', state: { content: { x: 1 } } });
    expect(files[0].repoPath).toBe('Lake.Lakehouse/lakehouse.json');
    expect(JSON.parse(files[0].content)).toEqual({ x: 1 });
  });
});

describe('TMSL round-trip', () => {
  const content = {
    tables: [
      { name: 'Sales', columns: [{ name: 'Amount', dataType: 'decimal' }, { name: 'Date', dataType: 'dateTime' }] },
      { name: 'Product', columns: [{ name: 'Id', dataType: 'int64' }] },
    ],
    measures: [
      { name: 'Total', table: 'Sales', expression: 'SUM(Sales[Amount])', formatString: '#,0' },
    ],
    relationships: [{ from: 'Sales.Date', to: 'Product.Id', isActive: false }],
  };

  it('buildTmslFromContent then parseTmslToContent returns the original content', () => {
    const tmsl = buildTmslFromContent(content, 'M');
    const parsed = parseTmslToContent(tmsl);
    expect(parsed).toEqual(content);
  });

  it('serialize then deserialize semantic-model returns original content', () => {
    const files = serializeLoomItem({ itemType: 'semantic-model', displayName: 'M', state: { content } });
    const back = deserializeLoomItem('semantic-model', files);
    expect(back).toEqual(content);
  });

  it('deserialize scorecard/report/other parse their JSON file', () => {
    const sc = serializeLoomItem({ itemType: 'scorecard', displayName: 'S', state: { content: { goals: [1] } } });
    expect(deserializeLoomItem('scorecard', sc)).toEqual({ goals: [1] });
    const rep = serializeLoomItem({ itemType: 'report', displayName: 'R', state: { content: { pages: [2] } } });
    expect(deserializeLoomItem('report', rep)).toEqual({ pages: [2] });
    const lk = serializeLoomItem({ itemType: 'lakehouse', displayName: 'L', state: { content: { y: 3 } } });
    expect(deserializeLoomItem('lakehouse', lk)).toEqual({ y: 3 });
  });
});

describe('parseAdoPath', () => {
  it('org/project/_git/repo', () => {
    expect(parseAdoPath('myorg/myproject/_git/myrepo')).toEqual({ org: 'myorg', project: 'myproject', repo: 'myrepo' });
  });
  it('dashed repo name', () => {
    expect(parseAdoPath('myorg/myproject/_git/my-repo-with-dashes')).toEqual({
      org: 'myorg',
      project: 'myproject',
      repo: 'my-repo-with-dashes',
    });
  });
  it('falls back to last segment as repo when no _git', () => {
    expect(parseAdoPath('org/proj/repo')).toEqual({ org: 'org', project: 'proj', repo: 'repo' });
  });
});

describe('parseGitHubPath', () => {
  it('owner/repo', () => {
    expect(parseGitHubPath('owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
  });
  it('strips .git suffix', () => {
    expect(parseGitHubPath('owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
  });
});

describe('adoApiBase', () => {
  it('returns https://dev.azure.com when LOOM_ADO_HOST unset', () => {
    delete process.env.LOOM_ADO_HOST;
    expect(adoApiBase('dev.azure.com')).toBe('https://dev.azure.com');
  });
  it('returns LOOM_ADO_HOST when set', () => {
    process.env.LOOM_ADO_HOST = 'https://tfs.agency.gov';
    expect(adoApiBase('dev.azure.com')).toBe('https://tfs.agency.gov');
  });
});

describe('githubApiBase', () => {
  it('returns api.github.com when LOOM_GITHUB_HOST unset', () => {
    delete process.env.LOOM_GITHUB_HOST;
    expect(githubApiBase()).toBe('https://api.github.com');
  });
  it('returns LOOM_GITHUB_HOST when set', () => {
    process.env.LOOM_GITHUB_HOST = 'https://github.agency.gov/api/v3';
    expect(githubApiBase()).toBe('https://github.agency.gov/api/v3');
  });
});

describe('auth headers', () => {
  it('ADO uses Basic with empty username', () => {
    expect(adoAuthHeader('PAT')).toBe(`Basic ${Buffer.from(':PAT').toString('base64')}`);
  });
  it('GitHub uses token', () => {
    expect(githubAuthHeader('PAT')).toBe('token PAT');
  });
});

describe('patSecretName', () => {
  it('default prefix', () => {
    delete process.env.LOOM_GIT_PAT_KV_PREFIX;
    expect(patSecretName('ws-123')).toBe('loom-git-pat-ws-123');
  });
  it('custom prefix', () => {
    process.env.LOOM_GIT_PAT_KV_PREFIX = 'team-pat';
    expect(patSecretName('ws1')).toBe('team-pat-ws1');
  });
});

describe('gitConfigGate', () => {
  it('null config → gate object with missing + detail', () => {
    const g = gitConfigGate(null);
    expect(g?.missing).toBe('no_repo_bound');
    expect(g?.detail).toContain('Connect one');
  });
  it('connected config → null', () => {
    expect(gitConfigGate(connected)).toBeNull();
  });
});
