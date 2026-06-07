import { describe, it, expect } from 'vitest';
import { extractPackages, buildCondaYaml } from '../aml-environment-conda';

describe('extractPackages', () => {
  it('returns [] for empty / nullish conda files', () => {
    expect(extractPackages(undefined)).toEqual([]);
    expect(extractPackages(null)).toEqual([]);
    expect(extractPackages('')).toEqual([]);
  });

  it('extracts conda and pip packages from a real AML conda YAML', () => {
    const conda = [
      'name: project_environment',
      'channels:',
      '  - conda-forge',
      'dependencies:',
      '  - python=3.10',
      '  - numpy=1.26',
      '  - pip:',
      '    - scikit-learn==1.5.0',
      '    - mlflow',
    ].join('\n');
    const pkgs = extractPackages(conda);
    expect(pkgs).toContainEqual({ name: 'python=3.10', source: 'conda' });
    expect(pkgs).toContainEqual({ name: 'numpy=1.26', source: 'conda' });
    expect(pkgs).toContainEqual({ name: 'scikit-learn==1.5.0', source: 'pip' });
    expect(pkgs).toContainEqual({ name: 'mlflow', source: 'pip' });
    // The "pip:" marker itself must not be captured as a conda package.
    expect(pkgs.find((p) => /^pip:?$/.test(p.name))).toBeUndefined();
  });

  it('ignores name/channels keys and inline comments', () => {
    const conda = [
      'dependencies:',
      '  - pandas   # data',
      '  - pip:',
      '    - requests  # http',
    ].join('\n');
    const pkgs = extractPackages(conda);
    expect(pkgs).toEqual([
      { name: 'pandas', source: 'conda' },
      { name: 'requests', source: 'pip' },
    ]);
  });

  it('stops collecting once the dependencies block ends', () => {
    const conda = [
      'dependencies:',
      '  - numpy',
      'variables:',
      '  - FOO=bar',
    ].join('\n');
    const pkgs = extractPackages(conda);
    expect(pkgs).toEqual([{ name: 'numpy', source: 'conda' }]);
  });
});

describe('buildCondaYaml', () => {
  it('always emits conda-forge channel and a python pin', () => {
    const yaml = buildCondaYaml({ pipPackages: ['mlflow'] });
    expect(yaml).toContain('channels:');
    expect(yaml).toContain('  - conda-forge');
    expect(yaml).toMatch(/- python=3\.10/);
    expect(yaml).toContain('  - pip:');
    expect(yaml).toContain('    - mlflow');
  });

  it('does not double-pin python when the caller supplies one', () => {
    const yaml = buildCondaYaml({ condaPackages: ['python=3.11', 'numpy'] });
    const pins = (yaml.match(/- python=/g) || []).length;
    expect(pins).toBe(1);
    expect(yaml).toContain('  - numpy');
  });

  it('round-trips through extractPackages', () => {
    const yaml = buildCondaYaml({ condaPackages: ['numpy=1.26'], pipPackages: ['scikit-learn==1.5'] });
    const pkgs = extractPackages(yaml);
    expect(pkgs).toContainEqual({ name: 'numpy=1.26', source: 'conda' });
    expect(pkgs).toContainEqual({ name: 'scikit-learn==1.5', source: 'pip' });
  });
});
