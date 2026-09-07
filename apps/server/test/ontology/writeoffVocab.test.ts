import { describe, it, expect } from 'vitest';
import { SHARED_TOOL_FIELD_NAMES } from '../../src/ontology/index.js';
import { toolFieldsViolations } from '../../src/ontology/toolOntologyMap.js';

// writeoff 工具输入词汇落点（roadmap Item 5）：items 结构容器 + 关系 params 词汇。
// 门禁真实断言在 toolInventory.test.ts（对已挂载工具跑 toolFieldsViolations），
// 这里提前锁定词汇表内容，防止后续误删。
describe('writeoff tool vocabulary', () => {
  it('SHARED_TOOL_FIELD_NAMES contains items/amount/partial/batch', () => {
    const shared = new Set<string>(SHARED_TOOL_FIELD_NAMES);
    for (const name of ['items', 'amount', 'partial', 'batch']) {
      expect(shared.has(name), `shared vocabulary must contain "${name}"`).toBe(true);
    }
  });

  it('simulated create_writeoff top-level fields pass the vocabulary gate', () => {
    const fields = ['items', 'amount', 'partial', 'batch', 'srcId', 'dstId'];
    expect(toolFieldsViolations('__probe_writeoff__', fields)).toEqual([]);
  });
});