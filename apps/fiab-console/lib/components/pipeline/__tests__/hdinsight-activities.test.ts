import { describe, it, expect } from 'vitest';
import { ACTIVITY_CATALOG, findByKey, findByType } from '../activity-catalog';
import { ACTIVITY_FORMS, hasActivityForm } from '../activity-forms';

const HDI_KEYS = ['HDInsightHive', 'HDInsightSpark', 'HDInsightMapReduce', 'HDInsightStreaming'];

describe('HDInsight activities (F17)', () => {
  it('registers all four HDInsight activity types in the Orchestration group', () => {
    for (const key of HDI_KEYS) {
      const def = findByKey(key);
      expect(def, `catalog entry ${key}`).toBeDefined();
      expect(def!.category).toBe('orchestration');
      expect(def!.type).toBe(key); // ADF type string equals the catalog key
      expect(def!.runnable).toBe(true); // ADF executes these natively
      expect(findByType(def!.type)?.key).toBe(key);
    }
  });

  it('build() stamps a top-level AzureHDInsight linkedServiceName reference', () => {
    for (const key of HDI_KEYS) {
      const def = findByKey(key)!;
      const a = def.build(`${def.namePrefix}1`);
      // top-level linkedServiceName (the cluster), not in typeProperties
      expect(a.linkedServiceName).toBeDefined();
      expect(a.linkedServiceName!.type).toBe('LinkedServiceReference');
      // empty by default (no NEXT_PUBLIC_LOOM_HDINSIGHT_LINKED_SERVICE in test env)
      expect(typeof a.linkedServiceName!.referenceName).toBe('string');
      expect((a.typeProperties as any).getDebugInfo).toBe('Failure');
    }
  });

  it('emits the required typeProperties keys per ADF activity contract', () => {
    const hive = findByKey('HDInsightHive')!.build('h').typeProperties as any;
    expect('scriptPath' in hive).toBe(true);

    const spark = findByKey('HDInsightSpark')!.build('s').typeProperties as any;
    expect('rootPath' in spark && 'entryFilePath' in spark).toBe(true);

    const mr = findByKey('HDInsightMapReduce')!.build('m').typeProperties as any;
    expect('className' in mr && 'jarFilePath' in mr).toBe(true);

    const stream = findByKey('HDInsightStreaming')!.build('st').typeProperties as any;
    for (const k of ['mapper', 'reducer', 'filePaths', 'input', 'output']) {
      expect(k in stream, `streaming.${k}`).toBe(true);
    }
  });

  it('has a typed form for each HDInsight activity with a root-path cluster field', () => {
    for (const key of HDI_KEYS) {
      expect(hasActivityForm(key)).toBe(true);
      const schema = ACTIVITY_FORMS[key];
      const cluster = schema.find((f) => f.path === 'linkedServiceName.referenceName');
      expect(cluster, `${key} cluster field`).toBeDefined();
      expect(cluster!.rootPath).toBe(true);
      expect(cluster!.required).toBe(true);
    }
  });

  it('does not introduce any non-runnable HDInsight entry (no placeholder catalog rows)', () => {
    const hdi = ACTIVITY_CATALOG.filter((d) => d.key.startsWith('HDInsight'));
    // At least the four core HDInsight activity types (Pig is an additional
    // native ADF type). The invariant is that EVERY HDInsight entry is a real,
    // runnable activity with no remediation stub — not a fixed catalog count.
    expect(hdi.length).toBeGreaterThanOrEqual(HDI_KEYS.length);
    for (const key of HDI_KEYS) expect(hdi.some((d) => d.key === key)).toBe(true);
    for (const d of hdi) {
      expect(d.runnable).toBe(true);
      expect(d.remediation).toBeUndefined();
    }
  });
});
