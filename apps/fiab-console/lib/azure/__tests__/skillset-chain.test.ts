import { describe, it, expect } from 'vitest';
import {
  SKILL_TYPES, SKILL_CATALOG, skillsByCategory,
  defaultSkill, serializeSkill,
  moveSkill, reorderSkill,
  joinPath, skillOutputPaths, availableSourcePaths, contextOptions,
  DOCUMENT_ROOT_PATHS,
  buildKnowledgeStore, emptyKnowledgeStore, knowledgeStoreIsEmpty,
  assembleSkillsetDef, parseSkillset, parseSkill,
  type BuiltSkill, type SkillType,
} from '../skillset-chain';

function chain(...types: SkillType[]): BuiltSkill[] {
  return types.map((t) => defaultSkill(t));
}

describe('skill catalog', () => {
  it('exposes the full cognitive-skill family incl. the SVC-2 additions', () => {
    for (const t of [
      '#Microsoft.Skills.Text.V3.SentimentSkill',
      '#Microsoft.Skills.Text.PIIDetectionSkill',
      '#Microsoft.Skills.Text.TranslationSkill',
      '#Microsoft.Skills.Vision.ImageAnalysisSkill',
      '#Microsoft.Skills.Custom.WebApiSkill',
    ] as SkillType[]) {
      expect(SKILL_TYPES).toContain(t);
      expect(SKILL_CATALOG[t].label).toBeTruthy();
    }
  });

  it('groups every type into exactly one category section', () => {
    const grouped = skillsByCategory().flatMap((g) => g.types);
    expect(grouped.slice().sort()).toEqual(SKILL_TYPES.slice().sort());
  });

  it('every skill type has a faithful serialization with its @odata.type', () => {
    for (const t of SKILL_TYPES) {
      const wire = serializeSkill(defaultSkill(t));
      expect(wire['@odata.type']).toBe(t);
      expect(Array.isArray(wire.inputs)).toBe(true);
      expect(Array.isArray(wire.outputs)).toBe(true);
    }
  });
});

describe('chain ordering', () => {
  const skills = chain(
    '#Microsoft.Skills.Vision.OcrSkill',
    '#Microsoft.Skills.Text.MergeSkill',
    '#Microsoft.Skills.Text.KeyPhraseExtractionSkill',
  );

  it('moveSkill relocates and returns a new array', () => {
    const moved = moveSkill(skills, 0, 2);
    expect(moved.map((s) => s.type)).toEqual([
      '#Microsoft.Skills.Text.MergeSkill',
      '#Microsoft.Skills.Text.KeyPhraseExtractionSkill',
      '#Microsoft.Skills.Vision.OcrSkill',
    ]);
    // original untouched (immutability)
    expect(skills[0].type).toBe('#Microsoft.Skills.Vision.OcrSkill');
  });

  it('reorderSkill up/down swaps adjacent skills', () => {
    const down = reorderSkill(skills, 0, 'down');
    expect(down.map((s) => s.type.split('.').pop())).toEqual(['MergeSkill', 'OcrSkill', 'KeyPhraseExtractionSkill']);
    const up = reorderSkill(down, 1, 'up');
    expect(up.map((s) => s.type)).toEqual(skills.map((s) => s.type));
  });

  it('is a no-op at the boundaries and on bad indexes', () => {
    expect(reorderSkill(skills, 0, 'up')).toBe(skills);
    expect(reorderSkill(skills, skills.length - 1, 'down')).toBe(skills);
    expect(moveSkill(skills, -1, 1)).toBe(skills);
    expect(moveSkill(skills, 1, 99)).toBe(skills);
    expect(moveSkill(skills, 1, 1)).toBe(skills);
  });
});

describe('enrichment-tree context + source paths', () => {
  it('joinPath composes context + leaf and normalizes slashes', () => {
    expect(joinPath('/document', 'organizations')).toBe('/document/organizations');
    expect(joinPath('/document/', '/keyPhrases')).toBe('/document/keyPhrases');
    expect(joinPath('/document/pages/*', 'entities')).toBe('/document/pages/*/entities');
    expect(joinPath('/document', '')).toBe('/document');
  });

  it('skillOutputPaths projects each output under the skill context', () => {
    const entity = defaultSkill('#Microsoft.Skills.Text.V3.EntityRecognitionSkill');
    entity.context = '/document';
    entity.outputs = [{ name: 'organizations', source: '', targetName: 'orgs' }];
    expect(skillOutputPaths(entity)).toEqual(['/document/orgs']);
  });

  it('availableSourcePaths exposes ONLY upstream outputs (ordered chain)', () => {
    const skills = chain(
      '#Microsoft.Skills.Vision.OcrSkill',            // 0 → /document/normalized_images/*/text ...
      '#Microsoft.Skills.Text.KeyPhraseExtractionSkill', // 1
      '#Microsoft.Skills.Text.V3.SentimentSkill',     // 2
    );
    // Skill 0 sees only document roots (nothing upstream).
    const forFirst = availableSourcePaths(skills, 0);
    expect(forFirst).toEqual(expect.arrayContaining(DOCUMENT_ROOT_PATHS));
    expect(forFirst).not.toContain(joinPath(skills[1].context, 'keyPhrases'));

    // Skill 2 sees skill 0 + skill 1 outputs but NOT its own.
    const forThird = availableSourcePaths(skills, 2);
    const kpOut = skillOutputPaths(skills[1]);
    for (const p of kpOut) expect(forThird).toContain(p);
    const ownOut = skillOutputPaths(skills[2]);
    for (const p of ownOut) expect(forThird).not.toContain(p);
  });

  it('extra roots (index fields) fold into the source picker', () => {
    const skills = chain('#Microsoft.Skills.Text.KeyPhraseExtractionSkill');
    const paths = availableSourcePaths(skills, 0, ['/document/customField']);
    expect(paths).toContain('/document/customField');
  });

  it('contextOptions offers presets + iterable upstream outputs', () => {
    const skills = chain(
      '#Microsoft.Skills.Text.SplitSkill', // output pages
      '#Microsoft.Skills.Text.KeyPhraseExtractionSkill',
    );
    const opts = contextOptions(skills, 1);
    expect(opts).toContain('/document');
    expect(opts).toContain('/document/pages/*');
    // split output "pages" becomes an iterable context for the next skill
    expect(opts.some((o) => o.includes('/pages') && o.endsWith('/*'))).toBe(true);
  });
});

describe('knowledge store projections', () => {
  it('returns undefined without a connection string or projections', () => {
    expect(buildKnowledgeStore('', { tables: [{ name: 't', source: '/document/x' }], objects: [], files: [] })).toBeUndefined();
    expect(buildKnowledgeStore('conn', emptyKnowledgeStore())).toBeUndefined();
  });

  it('builds a single projection group with tables/objects/files', () => {
    const ks = buildKnowledgeStore('DefaultEndpointsProtocol=https;AccountName=a;AccountKey=k;', {
      tables: [{ name: 'kpTable', source: '/document/tableprojection' }],
      objects: [{ storageContainer: 'docs', source: '/document/objectprojection', generatedKeyName: 'docKey' }],
      files: [{ storageContainer: 'images', source: '/document/normalized_images/*' }],
    })!;
    expect(ks.storageConnectionString).toContain('AccountName=a');
    expect(ks.projections).toHaveLength(1);
    const g = ks.projections[0];
    expect(g.tables[0]).toMatchObject({ tableName: 'kpTable', source: '/document/tableprojection' });
    expect(g.tables[0].generatedKeyName).toBe('kpTableKey'); // auto-derived
    expect(g.objects[0]).toMatchObject({ storageContainer: 'docs', source: '/document/objectprojection', generatedKeyName: 'docKey' });
    expect(g.files[0]).toMatchObject({ storageContainer: 'images', source: '/document/normalized_images/*' });
  });

  it('drops incomplete projection rows', () => {
    const ks = buildKnowledgeStore('conn', {
      tables: [{ name: '', source: '/document/x' }, { name: 't', source: '' }],
      objects: [{ storageContainer: 'c', source: '/document/o' }],
      files: [],
    })!;
    expect(ks.projections[0].tables).toHaveLength(0);
    expect(ks.projections[0].objects).toHaveLength(1);
  });

  it('knowledgeStoreIsEmpty reflects row counts', () => {
    expect(knowledgeStoreIsEmpty(emptyKnowledgeStore())).toBe(true);
    expect(knowledgeStoreIsEmpty({ tables: [{ name: 't', source: 's' }], objects: [], files: [] })).toBe(false);
  });
});

describe('assemble + parse round-trip', () => {
  it('assembleSkillsetDef carries name, skills and knowledge store', () => {
    const skills = chain('#Microsoft.Skills.Vision.OcrSkill', '#Microsoft.Skills.Text.KeyPhraseExtractionSkill');
    const ks = buildKnowledgeStore('conn', { tables: [{ name: 't', source: '/document/x' }], objects: [], files: [] });
    const def = assembleSkillsetDef('my-skillset', skills, { knowledgeStore: ks, description: 'demo' });
    expect(def.name).toBe('my-skillset');
    expect(def.skills).toHaveLength(2);
    expect(def.description).toBe('demo');
    expect(def.knowledgeStore).toBe(ks);
  });

  it('serialize → parse → serialize is stable for every skill type', () => {
    for (const t of SKILL_TYPES) {
      const wire = serializeSkill(defaultSkill(t));
      const reWire = serializeSkill(parseSkill(wire));
      expect(reWire).toEqual(wire);
    }
  });

  it('parseSkillset reconstructs skills + knowledge-store rows for editing', () => {
    const skills = chain('#Microsoft.Skills.Text.PIIDetectionSkill', '#Microsoft.Skills.Text.TranslationSkill');
    const ks = buildKnowledgeStore('the-conn', {
      tables: [{ name: 'pii', source: '/document/piiproj' }],
      objects: [{ storageContainer: 'docs', source: '/document/obj' }],
      files: [{ storageContainer: 'imgs', source: '/document/normalized_images/*' }],
    });
    const def = assembleSkillsetDef('edit-me', skills, { knowledgeStore: ks });

    const parsed = parseSkillset(def);
    expect(parsed.name).toBe('edit-me');
    expect(parsed.skills.map((s) => s.type)).toEqual(skills.map((s) => s.type));
    expect(parsed.storageConnectionString).toBe('the-conn');
    expect(parsed.knowledgeStore.tables[0]).toMatchObject({ name: 'pii', source: '/document/piiproj' });
    expect(parsed.knowledgeStore.objects[0].storageContainer).toBe('docs');
    expect(parsed.knowledgeStore.files[0].storageContainer).toBe('imgs');

    // re-assembling the parsed model reproduces the same skill wire shapes
    const reDef = assembleSkillsetDef(parsed.name, parsed.skills);
    expect(reDef.skills).toEqual(def.skills);
  });
});
