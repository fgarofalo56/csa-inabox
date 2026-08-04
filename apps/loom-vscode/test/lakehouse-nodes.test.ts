import { describe, it, expect } from 'vitest';
import {
  joinAbfss,
  relativeToRoot,
  filesPrefix,
  tableRelativePath,
  tableAbfss,
  fileAbfss,
  basename,
  humanSize,
} from '../src/tree/lakehouse-nodes';

const ROOT_ABFSS = 'abfss://bronze@acct.dfs.core.windows.net/lh-root';
const GOV_ABFSS = 'abfss://bronze@acct.dfs.core.usgovcloudapi.net/lh-root';

describe('joinAbfss', () => {
  it('joins with exactly one slash (mutation-proof: no double slash)', () => {
    // If the leading-slash strip on `sub` is removed, this yields a `//` — RED.
    expect(joinAbfss(ROOT_ABFSS, '/Tables/sales')).toBe(`${ROOT_ABFSS}/Tables/sales`);
    expect(joinAbfss(ROOT_ABFSS, 'Tables/sales')).toBe(`${ROOT_ABFSS}/Tables/sales`);
    expect(joinAbfss(`${ROOT_ABFSS}/`, 'Files/a')).toBe(`${ROOT_ABFSS}/Files/a`);
  });
  it('returns the bare root for an empty sub', () => {
    expect(joinAbfss(ROOT_ABFSS, '')).toBe(ROOT_ABFSS);
  });
});

describe('relativeToRoot', () => {
  it('strips the <root>/ prefix from a container-relative path', () => {
    expect(relativeToRoot('lh-root/Files/sub/data.csv', 'lh-root')).toBe('Files/sub/data.csv');
    expect(relativeToRoot('lh-root/Tables/sales', 'lh-root')).toBe('Tables/sales');
  });
  it('handles an empty root (path is already root-relative)', () => {
    expect(relativeToRoot('Files/a.csv', '')).toBe('Files/a.csv');
  });
  it('never guesses when a path is not under root — returns it verbatim', () => {
    expect(relativeToRoot('other/x', 'lh-root')).toBe('other/x');
  });
});

describe('filesPrefix', () => {
  it('is root-aware', () => {
    expect(filesPrefix('lh-root')).toBe('lh-root/Files');
    expect(filesPrefix('')).toBe('Files');
    expect(filesPrefix('/lh-root/')).toBe('lh-root/Files');
  });
});

describe('table + file ABFS (L4) is sovereign-correct (suffix from the server root)', () => {
  it('builds a table ABFS by joining the server-resolved root', () => {
    expect(tableRelativePath('sales')).toBe('Tables/sales');
    expect(tableAbfss(ROOT_ABFSS, 'sales')).toBe(`${ROOT_ABFSS}/Tables/sales`);
    // Gov suffix is carried through unchanged — never string-built in the client.
    expect(tableAbfss(GOV_ABFSS, 'sales')).toBe(`${GOV_ABFSS}/Tables/sales`);
    expect(tableAbfss(GOV_ABFSS, 'sales')).toContain('dfs.core.usgovcloudapi.net');
  });
  it('builds a file ABFS from its container-relative path', () => {
    expect(fileAbfss(ROOT_ABFSS, 'lh-root', 'lh-root/Files/sub/data.csv')).toBe(
      `${ROOT_ABFSS}/Files/sub/data.csv`,
    );
  });
});

describe('basename', () => {
  it('returns the leaf of a path', () => {
    expect(basename('lh-root/Files/sub/data.csv')).toBe('data.csv');
    expect(basename('folder/')).toBe('folder');
    expect(basename('single')).toBe('single');
  });
});

describe('humanSize', () => {
  it('formats byte counts', () => {
    expect(humanSize(0)).toBe('0 B');
    expect(humanSize(1024)).toBe('1.0 KB');
    expect(humanSize(1536)).toBe('1.5 KB');
    expect(humanSize(1048576)).toBe('1.0 MB');
    expect(humanSize(null)).toBe('');
    expect(humanSize(undefined)).toBe('');
  });
});
