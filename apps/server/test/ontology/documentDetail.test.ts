// apps/server/test/ontology/documentDetail.test.ts
// Document 节点详情 + 合同血缘反查(2026-09-23): 只读装配层的单测。
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  getDocumentDetail, listContractDocuments, buildBreadcrumb, documentFilename,
} from '../../src/ontology/documentDetail.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

/** 36 位 uuid 前缀(parseFileKey 剥离口径: randomUUID() 36 字符 + '-')。 */
const UUID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';

const insertDoc = (
  id: string, docType: string, opts: {
    minioKey?: string | null; sourceUri?: string; user?: string;
    parseStatus?: string; batchRole?: string | null;
  } = {},
) => {
  ctx.sqlite.prepare(
    `INSERT INTO documents (id, doc_type, modality, source_uri, block_model, minio_key, user_id,
        parse_status${opts.batchRole != null ? ', batch_role' : ''})
     VALUES (?, ?, 'digital', ?, '{}', ?, ?, ?${opts.batchRole != null ? ', ?' : ''})`,
  ).run(
    id, docType,
    opts.sourceUri ?? `/tmp/ingest/${id}.pdf`,
    opts.minioKey ?? null,
    opts.user ?? 'u1',
    opts.parseStatus ?? 'parsed',
    ...(opts.batchRole != null ? [opts.batchRole] : []),
  );
};

const insertBinding = (
  docId: string, contractNo: string, opts: { relation?: string; status?: string; user?: string } = {},
) => {
  ctx.sqlite.prepare(
    `INSERT INTO bindings (id, document_id, contract_no, relation, source_refs, confidence,
        created_by, user_id, status, target_kind)
     VALUES (?, ?, ?, ?, '[]', 1, 'test', ?, ?, 'Contract')`,
  ).run(`B-${docId}-${contractNo}`, docId, contractNo,
    opts.relation ?? '凭证', opts.user ?? 'u1', opts.status ?? 'confirmed');
};

const insertLedger = (id: string, contractNo: string, documentId: string | null, title = '') => {
  ctx.sqlite.prepare(
    `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
        title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
     VALUES (?, ?, ?, '合同', ?, ?, '{}', '{}', 1, 0, 'u1', NULL)`,
  ).run(id, contractNo, contractNo, documentId, title);
};

const insertProject = (code: string, name: string) => {
  ctx.sqlite.prepare(
    `INSERT INTO projects (id, code, name, status, user_id)
     VALUES (?, ?, ?, 'active', 'u1')`,
  ).run(`P-${code}`, code, name);
};

const insertMembership = (contractNo: string, projectCode: string, status = 'confirmed') => {
  ctx.sqlite.prepare(
    `INSERT INTO project_memberships (id, contract_no, project_code, status, user_id)
     VALUES (?, ?, ?, ?, 'u1')`,
  ).run(`M-${contractNo}-${projectCode}`, contractNo, projectCode, status);
};

describe('documentDetail: getDocumentDetail(面包屑 + 预览锚点)', () => {
  it('完整链路: 文件名/绑定合同/项目归属/面包屑/预览 URL', async () => {
    insertDoc('D1', '轨道衡称重单', { minioKey: `users/u1/合同/${UUID}-轨道衡计量单03.pdf` });
    insertBinding('D1', 'HNJM-2026-NM-010', { relation: '凭证' });
    insertLedger('L1', 'HNJM-2026-NM-010', 'D9');
    insertProject('PRJ-2026-01', '2026年动力煤批次');
    insertMembership('HNJM-2026-NM-010', 'PRJ-2026-01');

    const d = await getDocumentDetail(ctx, 'D1', 'u1');
    expect(d).not.toBeNull();
    // 文件名: MinIO key 剥 uuid 前缀与目录段
    expect(d!.filename).toBe('轨道衡计量单03.pdf');
    expect(d!.docType).toBe('轨道衡称重单');
    // 预览锚点(同源 /api/files/stream, key 已 urlencode)
    expect(d!.previewUrl).toBe(
      `/api/files/stream?key=${encodeURIComponent('users/u1/合同/a1b2c3d4-e5f6-7890-abcd-ef0123456789-轨道衡计量单03.pdf')}`,
    );
    // 绑定合同解析出台账行
    expect(d!.contracts).toHaveLength(1);
    expect(d!.contracts[0]!.contractNo).toBe('HNJM-2026-NM-010');
    expect(d!.contracts[0]!.ledgerId).toBe('L1');
    // 项目归属
    expect(d!.projects).toHaveLength(1);
    expect(d!.projects[0]!.name).toBe('2026年动力煤批次');
    // 面包屑: 项目 \ 合同 \ 单据类型 \ 单据名称
    expect(d!.breadcrumb).toBe('2026年动力煤批次 \\ HNJM-2026-NM-010 \\ 轨道衡称重单 \\ 轨道衡计量单03.pdf');
  });

  it('单据即合同原件: 台账 document_id 反查也进合同集合, relation=合同原件', async () => {
    insertDoc('D2', '合同', { minioKey: `users/u1/${UUID}-采购合同.pdf` });
    insertLedger('L2', 'HT-2026-002', 'D2', '煤炭买卖合同');
    const d = await getDocumentDetail(ctx, 'D2', 'u1');
    expect(d!.contracts).toHaveLength(1);
    expect(d!.contracts[0]!.relation).toBe('合同原件');
    expect(d!.contracts[0]!.title).toBe('煤炭买卖合同');
    expect(d!.breadcrumb).toBe('HT-2026-002 \\ 合同 \\ 采购合同.pdf');
  });

  it('绑定与合同原件同合同号时合并为一行(合同原件优先)', async () => {
    insertDoc('D3', '合同', { minioKey: `users/u1/${UUID}-c.pdf` });
    insertBinding('D3', 'HT-2026-003');
    insertLedger('L3', 'HT-2026-003', 'D3');
    const d = await getDocumentDetail(ctx, 'D3', 'u1');
    expect(d!.contracts).toHaveLength(1);
    expect(d!.contracts[0]!.relation).toBe('合同原件');
    expect(d!.contracts[0]!.status).toBe('confirmed');
  });

  it('旧数据无 minio_key: 文件名回退 source_uri basename, 无预览', async () => {
    insertDoc('D4', '货转单', { sourceUri: '/ingest/users_u1_abc-货转单55.pdf' });
    const d = await getDocumentDetail(ctx, 'D4', 'u1');
    expect(d!.filename).toBe('users_u1_abc-货转单55.pdf');
    expect(d!.previewUrl).toBeNull();
  });

  it('用户隔离: 他人单据 404(null); 无归属合同/项目时面包屑缺省对应段', async () => {
    insertDoc('D5', '发票', { user: 'u2', minioKey: `users/u2/${UUID}-i.pdf` });
    expect(await getDocumentDetail(ctx, 'D5', 'u1')).toBeNull();

    insertDoc('D6', '发票', { minioKey: `users/u1/${UUID}-i2.pdf` });
    const d = await getDocumentDetail(ctx, 'D6', 'u1');
    expect(d!.contracts).toHaveLength(0);
    expect(d!.projects).toHaveLength(0);
    expect(d!.breadcrumb).toBe('发票 \\ i2.pdf');
  });
});

describe('documentDetail: listContractDocuments(台账血缘反查)', () => {
  it('bindings 并集 + 合同原件, 按 docId 去重合同原件优先, 录入时间倒序', async () => {
    insertDoc('DA', '轨道衡称重单', { minioKey: `users/u1/${UUID}-a.pdf` });
    insertDoc('DB', '货转单', { minioKey: `users/u1/${UUID}-b.pdf` });
    insertDoc('DC', '合同', { minioKey: `users/u1/${UUID}-c.pdf` });
    insertBinding('DA', 'HT-1', { relation: '凭证' });
    insertBinding('DB', 'HT-1', { relation: '货权转移', status: 'proposed' });
    insertBinding('DC', 'HT-1');
    insertLedger('L1', 'HT-1', 'DC');

    const docs = await listContractDocuments(ctx, { contractNo: 'HT-1', ledgerRowId: 'L1' }, 'u1');
    expect(docs).toHaveLength(3);
    const byDoc = new Map(docs.map((x) => [x.docId, x]));
    expect(byDoc.get('DC')!.relation).toBe('合同原件');
    expect(byDoc.get('DA')!.relation).toBe('凭证');
    expect(byDoc.get('DB')!.relation).toBe('货权转移');
    expect(byDoc.get('DB')!.status).toBe('proposed');
    // 文件名剥 uuid 前缀
    expect(byDoc.get('DA')!.filename).toBe('a.pdf');
  });

  it('无 ledgerRowId 时跳过合同原件分支(bindings 仍返回)', async () => {
    insertDoc('DD', '发票', { minioKey: `users/u1/${UUID}-d.pdf` });
    insertBinding('DD', 'HT-2');
    const docs = await listContractDocuments(ctx, { contractNo: 'HT-2' }, 'u1');
    expect(docs).toHaveLength(1);
    expect(docs[0]!.relation).toBe('凭证');
  });

  it('用户隔离: 他人绑定不可见', async () => {
    insertDoc('DE', '发票', { minioKey: `users/u2/${UUID}-e.pdf`, user: 'u2' });
    insertBinding('DE', 'HT-3', { user: 'u2' });
    const docs = await listContractDocuments(ctx, { contractNo: 'HT-3' }, 'u1');
    expect(docs).toHaveLength(0);
  });
});

describe('documentDetail: 纯函数', () => {
  it('buildBreadcrumb 过滤空段', () => {
    expect(buildBreadcrumb({
      projects: [], contracts: [{ contractNo: 'HT-9' }], docType: '发票', filename: 'f.pdf',
    } as never)).toBe('HT-9 \\ 发票 \\ f.pdf');
  });

  it('documentFilename: minioKey 剥 uuid 与目录; 回退 sourceUri basename', () => {
    const key = `users/u1/合同/a1b2c3d4-e5f6-7890-abcd-ef0123456789-名.pdf`;
    expect(documentFilename(key, '', 'u1', 'D')).toBe('名.pdf');
    expect(documentFilename(null, '/a/b/legacy.pdf', 'u1', 'D')).toBe('legacy.pdf');
  });
});
