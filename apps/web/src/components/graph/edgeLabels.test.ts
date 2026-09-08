// EDGE_LABELS 完整性断言(spec: 边类型内联标注取代图例条)：
// 本体注册表(apps/server/src/ontology/index.ts, 纯 zod 单文件)是关系 SSOT——
// 新增关系若漏配中文标签, 此处即红; 既有标签也不允许空串/纯空白。
import { describe, it, expect } from 'vitest';
import { EDGE_LABELS } from './businessTypes';
import { ONTOLOGY_RELATIONS } from '../../../../server/src/ontology/index.ts';

describe('EDGE_LABELS 完整性', () => {
  it('本体注册表全量关系均有非空中文标签（新增关系漏配即红）', () => {
    const missing = ONTOLOGY_RELATIONS.filter((r) => !(r.name in EDGE_LABELS)).map((r) => r.name);
    expect(missing, `漏配标签的关系: ${missing.join(', ')}`).toEqual([]);
  });

  it('既有标签全部非空（不允许空串/纯空白）', () => {
    for (const [type, label] of Object.entries(EDGE_LABELS)) {
      expect(label.trim().length, `EDGE_LABELS["${type}"] 为空`).toBeGreaterThan(0);
    }
  });

  it('血缘边 CONTAINS 亦有标签（穿透模式跨空间边）', () => {
    expect(EDGE_LABELS['CONTAINS']?.trim()).toBeTruthy();
  });
});
