import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import { saveBinding, findBindingById, listTemplateTypes, createDocumentStub } from '../../src/pipeline/db/repositories.js';
import { syncBindingEdge, type BindingGraphSyncIo } from '../../src/pipeline/bindingGraphSync.js';

function makeIo() {
  const nodes = new Map<string, string>();
  const edges = new Set<string>();
  let seq = 0;
  const id = (kind: string, name: string) => {
    const key = `${kind}:${name}`;
    if (!nodes.has(key)) nodes.set(key, `e${seq++}`);
    return { elementId: nodes.get(key)! };
  };
  const io: BindingGraphSyncIo = {
    createEntity: async (i) => id(i.kind, i.name),
    mergeEdge: async (i) => { edges.add(`${i.srcId}|${i.kind}|${i.dstId}`); return {}; },
    removeEdge: async (i) => { const k = `${i.srcId}|${i.kind}|${i.dstId}`; if (!edges.has(k)) return 0; edges.delete(k); return 1; },
    findEntityByName: async (kind, name) => nodes.get(`${kind}:${name}`) ? { elementId: nodes.get(`${kind}:${name}`)! } : null,
  };
  return { io, nodes, edges };
}

const prevPwd = process.env.NEO4J_PASSWORD;
beforeEach(() => { process.env.NEO4J_PASSWORD = 'test'; });
afterEach(() => {
  if (prevPwd === undefined) delete process.env.NEO4J_PASSWORD;
  else process.env.NEO4J_PASSWORD = prevPwd;
});

describe('project binding (立项书 binds->Project)', () => {
  it('saveBinding 落 target_kind=Project 且读回', async () => {
    const ctx = createDb();
    migrate(ctx.sqlite);
    await ensureTemplateSeed(ctx);
    // bindings.document_id 有 FK, 需先建文档行(brief 原文用假 'DOC-1' 会 FK 失败)。
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///l.pdf', docType: '立项书' });
    const id = await saveBinding(ctx, {
      documentId: docId, contractNo: 'PRJ-1', relation: '立项',
      sourceRefs: [], confidence: 1, createdBy: 'agent',
      status: 'confirmed', confirmationSource: 'human', targetKind: 'Project',
    }, 'u1');
    const row = await findBindingById(ctx, id, 'u1');
    expect(row?.targetKind).toBe('Project');
  });

  it('syncBindingEdge dstKind=Project 落 Project 节点', async () => {
    const { io, nodes, edges } = makeIo();
    const r = await syncBindingEdge({
      docId: 'DOC-1', docType: '立项书', contractNo: 'PRJ-1',
      relation: '立项', bindingId: 'B1', confidence: 1, dstKind: 'Project',
    }, io);
    expect(r.outcome).toBe('ok');
    expect(nodes.has('Project:PRJ-1')).toBe(true);
    expect([...edges][0]).toContain('binds');
  });

  it('种子 er-bind-lixiang 已激活 + 立项书 props.bindsTargetKind=Project', async () => {
    const ctx = createDb();
    migrate(ctx.sqlite);
    await ensureTemplateSeed(ctx);
    const types = await listTemplateTypes(ctx);
    const lixiang = types.find((t) => t.name === '立项书')!;
    expect(lixiang.props.bindsTargetKind).toBe('Project');
  });
});