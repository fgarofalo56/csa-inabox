/**
 * Pure conda-spec helpers for AML environment management — no Azure imports, so
 * they're unit-testable in isolation (the parent aml-environments-client.ts
 * pulls in @azure/identity at module load). Re-exported from that client.
 */

export type PackageSource = 'conda' | 'pip';
export interface AmlPackage { name: string; source: PackageSource; }

/**
 * Extract the package list from a conda environment YAML string. Conda YAML is a
 * regular, line-oriented format, so a scan avoids pulling in a YAML parser dep:
 *
 *   name: project_environment
 *   channels:
 *     - conda-forge
 *   dependencies:
 *     - python=3.10
 *     - numpy=1.26          # conda package
 *     - pip:
 *       - scikit-learn==1.5 # pip package
 *       - mlflow
 *
 * Top-level `dependencies:` entries are conda packages; entries nested under the
 * `- pip:` mapping are pip packages. Everything else (name/channels/etc.) is
 * ignored.
 */
export function extractPackages(condaFile: string | undefined | null): AmlPackage[] {
  if (!condaFile) return [];
  const out: AmlPackage[] = [];
  let inDeps = false;
  let inPip = false;
  let pipIndent = -1;
  for (const raw of condaFile.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.replace(/^\s+/, '').length;
    // Leaving the dependencies block: a non-indented key other than a list item.
    if (inDeps && indent === 0 && !/^\s*-/.test(line)) { inDeps = false; inPip = false; }
    if (/^dependencies\s*:/.test(line.trim())) { inDeps = true; inPip = false; continue; }
    if (!inDeps) continue;
    // Enter pip sub-list: "- pip:"
    if (/^\s*-\s+pip\s*:?\s*$/.test(line)) { inPip = true; pipIndent = indent; continue; }
    // A pip item is a list item indented deeper than the "- pip:" marker.
    if (inPip && /^\s*-\s+/.test(line) && indent > pipIndent) {
      const name = line.replace(/^\s*-\s+/, '').replace(/\s+#.*$/, '').trim();
      if (name) out.push({ name, source: 'pip' });
      continue;
    }
    // Back out of pip when indentation returns to/under the conda dep level.
    if (inPip && indent <= pipIndent) inPip = false;
    // A conda dependency is a list item at the dependencies level.
    if (!inPip && /^\s*-\s+/.test(line)) {
      const name = line.replace(/^\s*-\s+/, '').replace(/\s+#.*$/, '').trim();
      if (name && !/^pip\s*:?$/.test(name)) out.push({ name, source: 'conda' });
    }
  }
  return out;
}

/**
 * Render a conda environment YAML from structured package lists. Always emits a
 * python pin + the conda-forge channel so the resulting environment is valid.
 */
export function buildCondaYaml(opts: { condaPackages?: string[]; pipPackages?: string[] }): string {
  const conda = (opts.condaPackages || []).map((p) => p.trim()).filter(Boolean);
  const pip = (opts.pipPackages || []).map((p) => p.trim()).filter(Boolean);
  const lines: string[] = [
    'name: loom_environment',
    'channels:',
    '  - conda-forge',
    'dependencies:',
  ];
  // Ensure a python pin is present so the env builds.
  if (!conda.some((p) => /^python([=<>! ]|$)/.test(p))) lines.push('  - python=3.10');
  for (const c of conda) lines.push(`  - ${c}`);
  if (pip.length) {
    lines.push('  - pip:');
    for (const p of pip) lines.push(`    - ${p}`);
  }
  return lines.join('\n') + '\n';
}
