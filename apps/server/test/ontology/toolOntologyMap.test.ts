import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { getToolsForRole } from '../../src/harness/roleToolRegistry.js';
import {
  toolOntologyMap, toolFieldsViolations,
} from '../../src/ontology/toolOntologyMap.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

describe('toolOntologyMap vocabulary gate', () => {
  it('maps exactly the three L2 demo tools from the roadmap', () => {
    expect(Object.keys(toolOntologyMap).sort()).toEqual(['bind_document', 'create_entity', 'link_entities']);
  });

  it('mapped tools are actually mounted for trader', () => {
    const names = getToolsForRole('trader', { ctx }).map((t) => t.name);
    for (const name of Object.keys(toolOntologyMap)) {
      expect(names, `${name} mapped but not mounted`).toContain(name);
    }
  });

  it('every real inputSchema field of the mapped tools passes the gate', () => {
    const tools = getToolsForRole('trader', { ctx });
    for (const [name] of Object.entries(toolOntologyMap)) {
      const t = tools.find((x) => x.name === name)!;
      const fields = Object.keys((t.inputSchema as { shape: Record<string, unknown> }).shape);
      expect(toolFieldsViolations(name, fields),
        `${name} fields outside vocabulary`).toEqual([]);
    }
  });

  it('acceptance 3 demo: a field missing from the registry turns the gate red', () => {
    // 给 create_entity 假设加一个注册表不存在的字段 => 必须被拦截
    expect(toolFieldsViolations('create_entity', ['kind', 'name', 'props', 'bogus_field']))
      .toEqual(['bogus_field']);
    expect(toolFieldsViolations('bind_document', ['documentId', 'contractNo', 'relation', 'confidence', 'sourceSpan']))
      .toEqual([]);
    expect(toolFieldsViolations('link_entities', ['srcId', 'dstId', 'kind', 'props', 'confidence', 'sourceSpan']))
      .toEqual([]);
  });

  it('unmapped tools are ignored (mapping is opt-in)', () => {
    expect(toolFieldsViolations('graph_query', ['subject', 'depth'])).toEqual([]);
  });
});
