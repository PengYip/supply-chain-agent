// apps/server/test/ontology/masterData.test.ts
// 主数据四类静态实体（business-loop Wave 1）：MASTER_DATA_TYPES 覆盖 TradeProject，
// 表单投影反射注册表 schema（projectNo 必填）。
import { describe, it, expect } from 'vitest';
import { MASTER_DATA_TYPES, masterDataFormSchemaJson } from '../../src/ontology/masterData.js';

describe('master data 4 static types (wave1)', () => {
  it('covers TradeProject with projectNo required in form projection', () => {
    expect([...MASTER_DATA_TYPES]).toContain('TradeProject');
    const form = masterDataFormSchemaJson().types.find((t) => t.name === 'TradeProject');
    expect(form?.label).toBe('贸易项目');
    expect(form?.fields.find((f) => f.name === 'projectNo')?.required).toBe(true);
  });
});