import { describe, it, expect, beforeEach } from 'vitest';
import { proposeProjectMemberships } from '../../src/pipeline/projectProposal.js';
import { createDb, migrate } from '../../src/pipeline/db/client.js';

// 项目归属自动提议(Task 8, spec 2026-08-20 §4.2)纯函数部分: 合同录入时,
// 抽取字段同时给出合同号与项目标识 -> 一条 proposed 提议(不写图不阻塞录入)。
describe('proposeProjectMemberships', () => {
  const F = (name: string, value: string | number, confidence: number) => ({ name, value, confidence });

  it('合同 + 合同号 + 项目编号 -> 一条提议(编号大写, 合同号归一, confidence 取参与字段最小值)', () => {
    const out = proposeProjectMemberships({
      docType: '合同',
      fields: [
        F('合同号', 'ht-2026-001', 0.95),
        F('项目编号', 'prj-2026-001', 0.8),
        F('甲方', '我方贸易', 0.9),
      ],
      contractType: '采购',
    });
    expect(out).toEqual([{
      contractNo: 'HT-2026-001',
      projectCode: 'PRJ-2026-001',
      projectName: 'prj-2026-001', // 无名称字段 -> 取编号字段原始写法(空则兜底 code)
      role: '采购',
      confidence: 0.8, // min(0.95, 0.8)
    }]);
  });

  it('项目编号 + 项目名称同在: projectName 取名称值, 编号优先做 projectCode', () => {
    const out = proposeProjectMemberships({
      docType: '合同',
      fields: [F('合同号', 'HT-1', 0.9), F('项目编号', 'PRJ-1', 0.7), F('项目名称', '曹妃甸项目', 0.85)],
      contractType: '销售',
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.projectCode).toBe('PRJ-1');
    expect(out[0]?.projectName).toBe('曹妃甸项目');
    expect(out[0]?.role).toBe('销售');
    expect(out[0]?.confidence).toBe(0.7); // min(0.9, 0.7, 0.85)
  });

  it('只有项目名称无编号 -> projectCode 取 normalizeName(名称)', () => {
    const out = proposeProjectMemberships({
      docType: '合同',
      fields: [F('合同号', 'HT-1', 0.9), F('项目名称', '曹妃甸项目', 0.8)],
      contractType: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.projectCode).toBe('曹妃甸项目');
    expect(out[0]?.projectName).toBe('曹妃甸项目');
    expect(out[0]?.role).toBeNull();
  });

  it('非合同 docType / 无合同号 / 无项目字段 -> []', () => {
    expect(proposeProjectMemberships({
      docType: '发票',
      fields: [F('合同号', 'HT-1', 0.9), F('项目编号', 'PRJ-1', 0.8)],
      contractType: '采购',
    })).toEqual([]);
    expect(proposeProjectMemberships({
      docType: '合同',
      fields: [F('项目编号', 'PRJ-1', 0.8)],
      contractType: '采购',
    })).toEqual([]);
    expect(proposeProjectMemberships({
      docType: '合同',
      fields: [F('合同号', 'HT-1', 0.9)],
      contractType: '采购',
    })).toEqual([]);
  });
});

// 表结构探针(纯函数无需 DB, 这里只确认表在迁移后存在, 供集成侧参考)。
let _ctx: ReturnType<typeof createDb>;
beforeEach(() => { _ctx = createDb(':memory:'); migrate(_ctx.sqlite); });
it('migrate 后 projects / project_memberships 表存在', () => {
  const tables = (_ctx.sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('projects','project_memberships')",
  ).all() as Array<{ name: string }>).map((r) => r.name).sort();
  expect(tables).toEqual(['project_memberships', 'projects']);
});
