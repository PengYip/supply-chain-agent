import { describe, it, expect } from 'vitest';
import {
  buildSelfPartyCandidates,
  findSelfPartyConflicts,
  type CandidateSnapshot,
  type ConflictSnapshot,
} from '../../src/pipeline/selfPartyCandidates.js';

// buildSelfPartyCandidates 纯函数候选汇总: 从凭证抽取字段(买方/卖方别名)确定性
// 汇总候选公司名, 剔除有效名单(归一化比较), 排序 docCount 降序再 name 升序, 上限 20。
// F1: 候选附带 buyerCount/sellerCount(买方类/卖方类字段值出现文档数, 双侧命中计两侧)。
// F2: findSelfPartyConflicts 检测名单同时命中凭证双侧的冲突(方向判不出的根因)。
function snap(
  docId: string,
  docType: string,
  createdAt: string,
  fields: Record<string, string>,
): CandidateSnapshot {
  return {
    docId,
    docType,
    createdAt,
    fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { value: v }])),
  };
}

describe('buildSelfPartyCandidates(纯函数候选汇总)', () => {
  it('B2 真实字段: 发票(购买方/销售方名称) + 货转单(受让方/转让方) 汇总候选', () => {
    const snapshots = [
      snap('D1', '发票', '2026-01-01T00:00:00Z', {
        购买方名称: '浙江浙能富兴燃料有限公司',
        销售方名称: '上海某贸易有限公司',
      }),
      snap('D2', '货转单', '2026-02-01T00:00:00Z', {
        受让方: '浙江浙能富兴燃料有限公司',
        转让方: '某电厂',
      }),
    ];
    const out = buildSelfPartyCandidates(snapshots, []);
    expect(out).toHaveLength(3);
    // docCount 降序: 浙江浙能富兴燃料有限公司 出现在 2 份文档居首。
    expect(out[0]!.name).toBe('浙江浙能富兴燃料有限公司');
    expect(out[0]!.docCount).toBe(2);
    // 其余按 name 升序(上 < 某)。
    expect(out[1]!.name).toBe('上海某贸易有限公司');
    expect(out[2]!.name).toBe('某电厂');
  });

  it('排序: docCount 降序, 再 name 升序', () => {
    const snapshots = [
      snap('D1', '发票', '2026-01-01', { 购买方名称: '乙公司', 销售方名称: '丙公司' }),
      snap('D2', '发票', '2026-01-02', { 购买方名称: '甲公司', 销售方名称: '丙公司' }),
    ];
    const out = buildSelfPartyCandidates(snapshots, []);
    // 丙公司 docCount=2 居首; 乙/甲 docCount=1 按 name 升序(乙 U+4E59 < 甲 U+7532)。
    expect(out.map((c) => c.name)).toEqual(['丙公司', '乙公司', '甲公司']);
  });

  it('归一化排除有效名单中的公司(全角括号变体也命中)', () => {
    const snapshots = [
      snap('D1', '发票', '2026-01-01', { 购买方名称: '华能（上海）', 销售方名称: '对手方' }),
    ];
    // effectiveNames 为归一化后的有效名单(路由侧 getEffectiveSelfPartyNames 产出)。
    const out = buildSelfPartyCandidates(snapshots, ['华能上海']);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('对手方');
  });

  it('上限 20: 21 家不同公司只返回 20', () => {
    const snapshots = Array.from({ length: 21 }, (_, i) =>
      snap(`D${i}`, '发票', '2026-01-01', {
        购买方名称: `公司${String(i).padStart(2, '0')}`,
      }),
    );
    const out = buildSelfPartyCandidates(snapshots, []);
    expect(out).toHaveLength(20);
  });

  it('isContractParty: 出现在 docType=合同 文档的买卖双方字段里', () => {
    const snapshots = [
      snap('D1', '合同', '2026-01-01', { 买方: '浙江浙能富兴燃料有限公司', 卖方: '某电厂' }),
      snap('D2', '发票', '2026-01-02', { 购买方名称: '浙江浙能富兴燃料有限公司' }),
    ];
    const out = buildSelfPartyCandidates(snapshots, []);
    const self = out.find((c) => c.name === '浙江浙能富兴燃料有限公司')!;
    expect(self.isContractParty).toBe(true);
    const other = out.find((c) => c.name === '某电厂')!;
    expect(other.isContractParty).toBe(true);
  });

  it('documentIds 只保留前 5 个(扫描序)', () => {
    const snapshots = Array.from({ length: 7 }, (_, i) =>
      snap(`D${i}`, '发票', '2026-01-01', { 购买方名称: '同一公司' }),
    );
    const out = buildSelfPartyCandidates(snapshots, []);
    expect(out).toHaveLength(1);
    expect(out[0]!.documentIds).toEqual(['D0', 'D1', 'D2', 'D3', 'D4']);
  });

  it('lastSeenAt = 出现该公司的文档中最大的 createdAt', () => {
    const snapshots = [
      snap('D1', '发票', '2026-01-01T00:00:00Z', { 购买方名称: '浙江浙能富兴燃料有限公司' }),
      snap('D2', '发票', '2026-03-01T00:00:00Z', { 购买方名称: '浙江浙能富兴燃料有限公司' }),
      snap('D3', '发票', '2026-02-01T00:00:00Z', { 购买方名称: '浙江浙能富兴燃料有限公司' }),
    ];
    const out = buildSelfPartyCandidates(snapshots, []);
    expect(out[0]!.lastSeenAt).toBe('2026-03-01T00:00:00Z');
  });

  it('候选名取出现次数最多的原始形式(平局取先出现者)', () => {
    const snapshots = [
      snap('D1', '发票', '2026-01-01', { 购买方名称: '华能（上海）' }),
      snap('D2', '发票', '2026-01-02', { 购买方名称: '华能上海' }),
      snap('D3', '发票', '2026-01-03', { 购买方名称: '华能（上海）' }),
    ];
    const out = buildSelfPartyCandidates(snapshots, []);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('华能（上海）');
    expect(out[0]!.docCount).toBe(3);
  });

  it('空快照/无买卖双方字段 -> 空候选', () => {
    expect(buildSelfPartyCandidates([], [])).toEqual([]);
    expect(
      buildSelfPartyCandidates([snap('D1', '发票', '2026-01-01', { 备注: '无' })], []),
    ).toEqual([]);
  });

  it('buyerCount/sellerCount: 买方 2 份文档 + 卖方 1 份文档 -> 2/1', () => {
    const snapshots = [
      snap('D1', '发票', '2026-01-01', { 购买方名称: '浙江浙能富兴燃料有限公司' }),
      snap('D2', '发票', '2026-01-02', { 购买方名称: '浙江浙能富兴燃料有限公司' }),
      snap('D3', '货转单', '2026-01-03', { 转让方: '浙江浙能富兴燃料有限公司' }),
    ];
    const out = buildSelfPartyCandidates(snapshots, []);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('浙江浙能富兴燃料有限公司');
    expect(out[0]!.docCount).toBe(3);
    expect(out[0]!.buyerCount).toBe(2);
    expect(out[0]!.sellerCount).toBe(1);
  });

  it('buyerCount/sellerCount: 同一文档双侧命中 -> 两侧各计 1', () => {
    const snapshots = [
      snap('D1', '发票', '2026-01-01', {
        购买方名称: '浙江浙能富兴燃料有限公司',
        销售方名称: '浙江浙能富兴燃料有限公司',
      }),
    ];
    const out = buildSelfPartyCandidates(snapshots, []);
    expect(out).toHaveLength(1);
    expect(out[0]!.docCount).toBe(2); // 买卖两侧各自独立计入 docCount
    expect(out[0]!.buyerCount).toBe(1);
    expect(out[0]!.sellerCount).toBe(1);
  });
});

describe('findSelfPartyConflicts(纯函数冲突检测)', () => {
  function conf(docId: string, docType: string, anchors: { buyer?: string; seller?: string }): ConflictSnapshot {
    return { docId, docType, anchors };
  }

  it('名单同时命中 buyer 与 seller -> 产出冲突行(原始值展示)', () => {
    const out = findSelfPartyConflicts(
      [conf('D1', '发票', { buyer: '浙江浙能富兴燃料有限公司', seller: '厦门海投供应链有限公司' })],
      ['浙江浙能富兴燃料有限公司', '厦门海投供应链有限公司'],
    );
    expect(out).toEqual([
      {
        documentId: 'D1',
        docType: '发票',
        buyer: '浙江浙能富兴燃料有限公司',
        seller: '厦门海投供应链有限公司',
      },
    ]);
  });

  it('仅单侧命中 -> 无冲突行', () => {
    const out = findSelfPartyConflicts(
      [conf('D1', '发票', { buyer: '浙江浙能富兴燃料有限公司', seller: '厦门海投供应链有限公司' })],
      ['浙江浙能富兴燃料有限公司'],
    );
    expect(out).toEqual([]);
  });

  it('归一化比较: 全角括号变体同样命中', () => {
    const out = findSelfPartyConflicts(
      [conf('D1', '发票', { buyer: '华能（上海）', seller: '厦门海投供应链有限公司' })],
      ['华能上海', '厦门海投供应链有限公司'],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.buyer).toBe('华能（上海）');
  });

  it('白名单外 docType(合同/其他) -> 不扫描', () => {
    const out = findSelfPartyConflicts(
      [
        conf('D1', '合同', { buyer: '浙江浙能富兴燃料有限公司', seller: '厦门海投供应链有限公司' }),
        conf('D2', '其他', { buyer: '浙江浙能富兴燃料有限公司', seller: '厦门海投供应链有限公司' }),
      ],
      ['浙江浙能富兴燃料有限公司', '厦门海投供应链有限公司'],
    );
    expect(out).toEqual([]);
  });

  it('缺 buyer 或 seller 锚点 -> 无冲突行', () => {
    const out = findSelfPartyConflicts(
      [conf('D1', '发票', { buyer: '浙江浙能富兴燃料有限公司' })],
      ['浙江浙能富兴燃料有限公司', '厦门海投供应链有限公司'],
    );
    expect(out).toEqual([]);
  });
});
