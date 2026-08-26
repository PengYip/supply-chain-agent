// 模板概览工具(spec 2026-08-26 §4.4): L1 只读, 本体成为 Agent 可用知识。
import { tool } from 'ai';
import { z } from 'zod';
import type { DbContext } from '../db/client.js';
import { listActiveEdgeRules, listTemplateTypes } from '../db/repositories.js';
import { ancestorChain, matchEdgeRule } from '../templateGuard.js';

export interface TemplateOverviewToolDeps {
  ctx: DbContext;
  userId?: string;
}

const CONTRACT_TYPE_NAMES = ['采购', '销售', '物流', '租赁', '服务', '其他'];

export function buildTemplateOverviewTool(deps: TemplateOverviewToolDeps) {
  return tool({
    description:
      '查询模板层: 单据类型层级、某单据类型允许挂接的合同类型与边词表。' +
      '用途: 用户问"收货单能挂什么合同""发票能连什么边"或需要了解类型体系时调用。' +
      'L1 只读, 无需授权。docType 缺省返回全类型层级概览。',
    inputSchema: z.object({
      docType: z.string().optional().describe('单据类型名(如 收货单/发票); 缺省返回全层级'),
    }),
    execute: async ({ docType }) => {
      let types: Awaited<ReturnType<typeof listTemplateTypes>>;
      let rules: Awaited<ReturnType<typeof listActiveEdgeRules>>;
      try {
        [types, rules] = await Promise.all([listTemplateTypes(deps.ctx), listActiveEdgeRules(deps.ctx)]);
      } catch (e) {
        // 模板表读取失败返回可读错误而非抛异常(工具读取失败不阻塞主流程)。
        return { status: 'error' as const, error: `模板数据读取失败: ${e instanceof Error ? e.message : String(e)}` };
      }
      const byId = new Map(types.map((t) => [t.id, t]));
      const nameOf = (id: string) => byId.get(id)?.name ?? null;
      const docTypes = types.filter((t) => t.kind === 'doc_type');
      // 粗类 = 顶层节点 + 其他(种子中 其他 挂履约凭证下, 但语义上是顶层粗类,
      // 与 classifier DEFAULT_COARSE 一致)。
      const coarse = docTypes.filter((t) => !t.parentId || t.name === '其他').map((t) => t.name);
      if (!docType) {
        return {
          typeCount: docTypes.length,
          coarse,
          types: docTypes.map((t) => ({ name: t.name, parent: t.parentId ? nameOf(t.parentId) : null, active: t.isActive })),
        };
      }
      const docTypeId = byId.get(`dt-${docType}`)?.id ?? null;
      const sourceChain = ancestorChain(docTypeId, byId);
      const typeChain = sourceChain.map((id) => nameOf(id)!).filter(Boolean);
      const settlesRule = matchEdgeRule({ rules, sourceChain, targetChain: [''], edgeType: 'settles' });
      const allowedContractTypes = CONTRACT_TYPE_NAMES.filter((ct) => {
        const chain = ancestorChain(byId.get(`ct-${ct}`)?.id ?? null, byId);
        return matchEdgeRule({ rules, sourceChain, targetChain: chain, edgeType: 'binds' }) !== null;
      });
      return {
        docType, typeChain, settlesVocab: settlesRule ? settlesRule.allowedVocab : null,
        allowedContractTypes,
      };
    },
  });
}
