// 项目归属 -> Neo4j 同步(spec 2026-08-20 §4.3)。project_memberships 是 SSOT, 图是
// 投影视图。与 bindingGraphSync 同一模式: NEO4J_PASSWORD 门禁 -> 'skipped';
// 驱动错误 -> 'failed'; 永不抛出, 绝不阻塞业务主流程。io 可注入, 单测无需 Neo4j。
//
// 边语义:
//   Contract -[part_of {role}]-> Project        归属(确认时写, 拒绝时删)
//   Party -[counterparty {role}]-> Contract     派生(台账甲乙方锚点)
//   Party -[participates {role}]-> Project      派生(采购->供应商 / 销售->客户 /
//                                               主体方->主体), role 为采购/销售时才有
// 派生边不追删(spec §8 已知简化): 下一次任一归属确认时按最新 SSOT 重 MERGE 收敛。
import { createEntity, mergeEdge, removeEdge, findEntities } from '../graph/repo.js';
import { normalizeName } from '../graph/normalize.js';
import { resolveSelfSide } from '../domain/flowDirection.js';
import { TRADE_VOCAB } from '../domain/tradeSemantics.js';
import { getEffectiveSelfPartyNames } from './executionFlow.js';
import { findContractLedgerByNo, type BindingGraphStatus } from './db/repositories.js';
import type { ContractLedgerEntry } from './contractLedger.js';
import type { DbContext } from './db/client.js';

export const PART_OF_EDGE = 'part_of';
export const COUNTERPARTY_EDGE = 'counterparty';
export const PARTICIPATES_EDGE = 'participates';

export interface ProjectGraphSyncIo {
  createEntity(i: { kind: string; name: string; props?: Record<string, unknown> }): Promise<{ elementId: string }>;
  mergeEdge(i: { srcId: string; dstId: string; kind: string; props?: Record<string, unknown>; confidence?: number }): Promise<unknown>;
  removeEdge(i: { srcId: string; kind: string; dstId: string }): Promise<number>;
  findEntityByName(kind: string, name: string): Promise<{ elementId: string } | null>;
}

export const defaultProjectGraphSyncIo: ProjectGraphSyncIo = {
  createEntity: (i) => createEntity(i),
  mergeEdge: (i) => mergeEdge(i),
  removeEdge: (i) => removeEdge(i),
  findEntityByName: async (kind, name) => {
    const hits = await findEntities({ kind, name, exact: true });
    return hits[0] ?? null;
  },
};

async function ensureNode(
  io: ProjectGraphSyncIo, kind: string, name: string,
  createFallback: () => Promise<{ elementId: string }>,
): Promise<{ elementId: string }> {
  const found = await io.findEntityByName(kind, name);
  if (found) return found;
  return createFallback();
}

function anchorsFromLedger(entry: ContractLedgerEntry): { buyer?: string; seller?: string } {
  const f = entry.fields;
  const buyer = String(f['买方']?.value ?? f['甲方']?.value ?? '').trim() || undefined;
  const seller = String(f['卖方']?.value ?? f['乙方']?.value ?? '').trim() || undefined;
  return { buyer, seller };
}

export interface ProjectMembershipSyncInput {
  contractNo: string;   // 已 normalizeContractNo
  projectCode: string;  // 已 normalizeProjectCode
  projectName: string;
  role: string;         // 合同类型
  confidence: number;
}

export async function syncProjectMembershipGraph(
  ctx: DbContext,
  input: ProjectMembershipSyncInput,
  io: ProjectGraphSyncIo = defaultProjectGraphSyncIo,
): Promise<BindingGraphStatus> {
  const now = () => new Date().toISOString();
  if (!process.env.NEO4J_PASSWORD) return { status: 'skipped', reason: 'NEO4J_PASSWORD not set' };
  try {
    // 节点名与 graphWriter 同键: Contract.name = normalizeName(合同号)。
    const contractName = normalizeName(input.contractNo);
    if (!contractName) return { status: 'failed', reason: 'contractNo normalized to empty', syncedAt: now() };

    const projectNode = await ensureNode(io, 'Project', input.projectCode,
      () => io.createEntity({ kind: 'Project', name: input.projectCode, props: { code: input.projectCode, name: input.projectName } }));
    const contractNode = await ensureNode(io, 'Contract', contractName,
      () => io.createEntity({ kind: 'Contract', name: contractName, props: { rawName: input.contractNo, ...(input.role ? { contractType: input.role } : {}) } }));

    await io.mergeEdge({
      srcId: contractNode.elementId, dstId: projectNode.elementId, kind: PART_OF_EDGE,
      confidence: input.confidence, props: { role: input.role, source: 'project_membership' },
    });

    // 派生边: 台账甲乙方锚点 + 主体名单 -> counterparty / participates(纯投影, 不落库)。
    const ledger = await findContractLedgerByNo(ctx, input.contractNo);
    const anchors = ledger ? anchorsFromLedger(ledger) : {};
    if (anchors.buyer && anchors.seller) {
      const side = resolveSelfSide(await getEffectiveSelfPartyNames(ctx), anchors);
      if (side) {
        const selfName = side === 'buyer' ? anchors.buyer : anchors.seller;
        const otherName = side === 'buyer' ? anchors.seller : anchors.buyer;
        const pairs: Array<[string, string]> = side === 'buyer'
          ? [[selfName, '买方'], [otherName, '卖方']]
          : [[selfName, '卖方'], [otherName, '买方']];
        for (const [raw, role] of pairs) {
          const partyNode = await ensureNode(io, 'Party', normalizeName(raw),
            () => io.createEntity({ kind: 'Party', name: normalizeName(raw), props: { rawName: raw } }));
          await io.mergeEdge({ srcId: partyNode.elementId, dstId: contractNode.elementId, kind: COUNTERPARTY_EDGE, props: { role } });
        }
        if (input.role === '采购' || input.role === '销售') {
          const otherNode = await io.findEntityByName('Party', normalizeName(otherName));
          const selfNode = await io.findEntityByName('Party', normalizeName(selfName));
          if (otherNode) {
            await io.mergeEdge({ srcId: otherNode.elementId, dstId: projectNode.elementId, kind: PARTICIPATES_EDGE,
              props: { role: TRADE_VOCAB.participatesRoleByContractType[input.role] } });
          }
          if (selfNode) {
            await io.mergeEdge({ srcId: selfNode.elementId, dstId: projectNode.elementId, kind: PARTICIPATES_EDGE, props: { role: '主体' } });
          }
        }
      }
    }
    return { status: 'ok', syncedAt: now() };
  } catch (e) {
    return { status: 'failed', reason: e instanceof Error ? e.message : String(e), syncedAt: now() };
  }
}

/** 拒绝/移除归属: 只删 part_of(派生边靠后续重 MERGE 收敛, spec §8)。 */
export async function removeProjectMembershipGraph(
  input: { contractNo: string; projectCode: string },
  io: ProjectGraphSyncIo = defaultProjectGraphSyncIo,
): Promise<BindingGraphStatus> {
  const now = () => new Date().toISOString();
  if (!process.env.NEO4J_PASSWORD) return { status: 'skipped', reason: 'NEO4J_PASSWORD not set' };
  try {
    const contractName = normalizeName(input.contractNo);
    const contractNode = await io.findEntityByName('Contract', contractName);
    const projectNode = await io.findEntityByName('Project', input.projectCode);
    if (contractNode && projectNode) {
      await io.removeEdge({ srcId: contractNode.elementId, kind: PART_OF_EDGE, dstId: projectNode.elementId });
    }
    return { status: 'ok', syncedAt: now() };
  } catch (e) {
    return { status: 'failed', reason: e instanceof Error ? e.message : String(e), syncedAt: now() };
  }
}
